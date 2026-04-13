/**
 * skills/deploy.ts
 *
 * Register an ECS task definition and create/update the ECS service.
 * Each task has two containers: the app and an ngrok sidecar.
 *
 * Input:  { repo, imageUri, port?, env? }
 * Output: { serviceName, taskDefinition }
 */

import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  RegisterTaskDefinitionCommand,
  CreateServiceCommand,
  UpdateServiceCommand,
  DescribeServicesCommand,
  DescribeTaskDefinitionCommand,
  ListTaskDefinitionsCommand,
  type ContainerDefinition,
  type LogConfiguration,
  type Secret,
} from '@aws-sdk/client-ecs';
import {
  CreateLogGroupCommand,
  PutRetentionPolicyCommand,
} from '@aws-sdk/client-cloudwatch-logs';
import { ecsClient, cwlClient } from '../services/aws.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { assertAllowedCluster } from '../utils/safety.js';
import { SERVICE_PREFIX, TASK_FAMILY_PREFIX, NGROK_IMAGE } from '../utils/constants.js';

export interface DeployInput {
  repo: string;
  imageUri: string;
  port?: number;
  env?: Record<string, string>;
  freshUrl?: boolean; // force a new ngrok URL even if one already exists
}

export interface DeployOutput {
  serviceName: string;
  taskDefinition: string;
  deployedAt: number; // ms epoch — used to filter stale log streams
  ngrokUrl: string;  // pre-generated random URL — known before the task starts
}

export async function deploySkill(input: DeployInput): Promise<DeployOutput> {
  const { repo, imageUri, env = {} } = input;
  const {
    ecsClusterName,
    logGroupName,
    taskCpu,
    taskMemory,
    ecsExecutionRoleArn,
    ecsTaskRoleArn,
    fargate,
    defaultAppPort,
  } = config();

  // Safety: only touch the allowed cluster
  assertAllowedCluster(ecsClusterName);

  const port = input.port ?? defaultAppPort;
  const serviceName = `${SERVICE_PREFIX}${repo}`;
  const taskFamily = `${TASK_FAMILY_PREFIX}${repo}`;

  // ─── Resolve ngrok URL for this deploy ───────────────────────────────────
  // Reuse the URL from a previous deploy if one exists, so the endpoint stays
  // stable across redeployments. Pass freshUrl=true to generate a new one.
  const ngrokUrl = resolveNgrokUrl(repo, input.freshUrl ?? false);

  logger.info({ action: 'deploy:ngrok_url', ngrokUrl, fresh: input.freshUrl ?? false }, 'Resolved ngrok URL');

  // ─── Ensure CloudWatch log group exists ──────────────────────────────────

  await ensureLogGroup(logGroupName);

  // ─── Build container definitions ─────────────────────────────────────────

  const appEnv = Object.entries(env).map(([name, value]) => ({ name, value }));

  const appLogConfig: LogConfiguration = {
    logDriver: 'awslogs',
    options: {
      'awslogs-group': logGroupName,
      'awslogs-region': config().awsRegion,
      'awslogs-stream-prefix': `${repo}-app`,
    },
  };

  const ngrokLogConfig: LogConfiguration = {
    logDriver: 'awslogs',
    options: {
      'awslogs-group': logGroupName,
      'awslogs-region': config().awsRegion,
      'awslogs-stream-prefix': `${repo}-ngrok`,
    },
  };

  // Shared cluster-wide secrets injected into every app container.
  // All tangent/* secrets are covered by the TangentSecretsAccess IAM policy.
  const sharedAppSecrets: Secret[] = [
    {
      name: 'ANTHROPIC_API_KEY',
      valueFrom: 'arn:aws:secretsmanager:us-east-1:307048237966:secret:tangent/ANTHROPIC_API_KEY-RkgZsG',
    },
  ];

  // ngrok authtoken is stored in Secrets Manager and injected by ECS at runtime.
  const ngrokSecrets: Secret[] = [
    {
      name: 'NGROK_AUTHTOKEN',
      valueFrom: 'arn:aws:secretsmanager:us-east-1:307048237966:secret:tangent/ngrok-authtoken-n5feXK',
    },
  ];

  // Merge shared secrets with any extra secrets from the previous task def revision.
  // sharedAppSecrets always wins (deduped by name), so the cluster-wide keys are
  // always present on every app container regardless of what was there before.
  const inheritedSecrets = await fetchExistingAppSecrets(taskFamily);
  const sharedNames = new Set(sharedAppSecrets.map((s) => s.name));
  const extraSecrets = inheritedSecrets
    .filter((s) => !sharedNames.has(s.name ?? ''))
    // Drop secrets whose ARN doesn't reference a tangent/ path — the ECS execution
    // role (TangentSecretsAccess) only grants GetSecretValue on tangent/*.
    // Inherited secrets from before the prefix convention cause
    // AccessDeniedException → ResourceInitializationError on every deploy.
    .filter((s) => {
      const arn = s.valueFrom ?? '';
      if (arn.includes(':secret:tangent/')) return true;
      logger.warn(
        { action: 'deploy:drop_unprefixed_secret', name: s.name, arn },
        `Dropping inherited secret "${s.name}" — ARN is outside tangent/ prefix and would cause AccessDeniedException`,
      );
      return false;
    });
  const appSecrets = [...sharedAppSecrets, ...extraSecrets];
  logger.info({ action: 'deploy:app_secrets', total: appSecrets.length }, 'App container secrets resolved');

  const appContainer: ContainerDefinition = {
    name: 'app',
    image: imageUri,
    essential: true,
    portMappings: [{ containerPort: port, protocol: 'tcp' }],
    environment: appEnv,
    logConfiguration: appLogConfig,
    secrets: appSecrets,
  };

  const ngrokContainer: ContainerDefinition = {
    name: 'ngrok',
    image: NGROK_IMAGE,
    essential: true,
    command: [
      'http',
      `localhost:${port}`,
      '--url', ngrokUrl,                    // split into two args — matches local CLI behavior
      '--log=stdout',
      '--log-format=json',
      '--oauth=google',
      '--oauth-allow-domain=impiricus.com',
    ],
    secrets: ngrokSecrets,
    logConfiguration: ngrokLogConfig,
  };

  // ─── Register task definition ─────────────────────────────────────────────

  logger.info({ action: 'deploy:register_task_def', repo, taskFamily }, 'Registering task definition');

  const registerCmd = new RegisterTaskDefinitionCommand({
    family: taskFamily,
    containerDefinitions: [appContainer, ngrokContainer],
    networkMode: 'awsvpc',
    requiresCompatibilities: ['FARGATE'],
    cpu: taskCpu,
    memory: taskMemory,
    executionRoleArn: ecsExecutionRoleArn,
    taskRoleArn: ecsTaskRoleArn,
  });

  const registerResult = await ecsClient().send(registerCmd);
  const taskDefArn = registerResult.taskDefinition?.taskDefinitionArn;
  if (!taskDefArn) throw new Error('ECS task definition registration returned no ARN');

  logger.info({ action: 'deploy:task_def_registered', taskDefArn }, 'Task definition registered');

  // ─── Create or update service ─────────────────────────────────────────────

  const networkConfig = {
    awsvpcConfiguration: {
      subnets: fargate.subnets,
      securityGroups: [fargate.securityGroup],
      assignPublicIp: fargate.assignPublicIp,
    },
  };

  const serviceExists = await checkServiceExists(ecsClusterName, serviceName);

  // Stop old task before starting new one so ngrok's random URL isn't blocked
  // by an existing session. AZ rebalancing must be disabled or it rejects
  // minimumHealthyPercent: 0.
  const deploymentConfig = {
    minimumHealthyPercent: 0,
    maximumPercent: 100,
  };

  if (serviceExists) {
    logger.info({ action: 'deploy:update_service', serviceName }, 'Updating existing service');
    const updateCmd = new UpdateServiceCommand({
      cluster: ecsClusterName,
      service: serviceName,
      taskDefinition: taskDefArn,
      forceNewDeployment: true,
      desiredCount: 1,
      deploymentConfiguration: deploymentConfig,
      availabilityZoneRebalancing: 'DISABLED',
    });
    await ecsClient().send(updateCmd);
  } else {
    logger.info({ action: 'deploy:create_service', serviceName }, 'Creating new service');
    const createCmd = new CreateServiceCommand({
      cluster: ecsClusterName,
      serviceName,
      taskDefinition: taskDefArn,
      desiredCount: 1,
      launchType: 'FARGATE',
      networkConfiguration: networkConfig,
      deploymentConfiguration: deploymentConfig,
      availabilityZoneRebalancing: 'DISABLED',
    });
    await ecsClient().send(createCmd);
  }

  const deployedAt = Date.now();
  logger.info({ action: 'deploy:done', serviceName, taskDefArn, deployedAt, ngrokUrl }, 'Deploy complete');

  return { serviceName, taskDefinition: taskDefArn, deployedAt, ngrokUrl };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Create the CloudWatch log group if it doesn't already exist.
 * ECS will fail to start tasks if the log group is missing.
 */
async function ensureLogGroup(logGroupName: string): Promise<void> {
  try {
    await cwlClient().send(new CreateLogGroupCommand({ logGroupName }));
    await cwlClient().send(new PutRetentionPolicyCommand({ logGroupName, retentionInDays: 30 }));
    logger.info({ action: 'deploy:log_group_created', logGroupName }, 'CloudWatch log group created');
  } catch (err: unknown) {
    // ResourceAlreadyExistsException is fine — group already there
    if (err instanceof Error && err.name === 'ResourceAlreadyExistsException') return;
    throw err;
  }
}

/**
 * Look up the most recent task definition for a family and return any secrets
 * already configured on the app container. This lets redeployments carry forward
 * manually-added secrets (e.g. ANTHROPIC_API_KEY) without stripping them.
 */
async function fetchExistingAppSecrets(taskFamily: string): Promise<Secret[]> {
  try {
    const listResult = await ecsClient().send(new ListTaskDefinitionsCommand({
      familyPrefix: taskFamily,
      sort: 'DESC',
      maxResults: 1,
      status: 'ACTIVE',
    }));
    const latestArn = listResult.taskDefinitionArns?.[0];
    if (!latestArn) return [];

    const descResult = await ecsClient().send(new DescribeTaskDefinitionCommand({
      taskDefinition: latestArn,
    }));
    const appContainer = descResult.taskDefinition?.containerDefinitions?.find((c) => c.name === 'app');
    return appContainer?.secrets ?? [];
  } catch {
    return []; // no previous revision or API error — start fresh
  }
}

// ─── Ngrok URL registry ───────────────────────────────────────────────────────

const NGROK_URLS_FILE = resolve(process.cwd(), 'config/ngrok-urls.json');

function loadNgrokUrls(): Record<string, string> {
  try {
    return JSON.parse(readFileSync(NGROK_URLS_FILE, 'utf8')) as Record<string, string>;
  } catch {
    return {};
  }
}

function saveNgrokUrl(repo: string, url: string): void {
  try {
    const urls = loadNgrokUrls();
    urls[repo] = url;
    writeFileSync(NGROK_URLS_FILE, JSON.stringify(urls, null, 2));
  } catch (err) {
    logger.warn({ action: 'deploy:ngrok_url_save_failed', err }, 'Could not persist ngrok URL');
  }
}

function resolveNgrokUrl(repo: string, fresh: boolean): string {
  const urls = loadNgrokUrls();
  if (!fresh && urls[repo]) {
    return urls[repo]!;
  }
  const suffix = randomBytes(4).toString('hex');
  const slug = `tangent-${repo.toLowerCase().replace(/[^a-z0-9]/g, '-').slice(0, 20)}-${suffix}`;
  const url = `https://${slug}.ngrok.app`;
  saveNgrokUrl(repo, url);
  return url;
}

/** Return the stored ngrok URL for a repo, or null if never deployed. */
export function getStoredNgrokUrl(repo: string): string | null {
  return loadNgrokUrls()[repo] ?? null;
}

async function checkServiceExists(cluster: string, serviceName: string): Promise<boolean> {
  try {
    const result = await ecsClient().send(
      new DescribeServicesCommand({ cluster, services: [serviceName] }),
    );
    const svc = result.services?.[0];
    return !!svc && svc.status !== 'INACTIVE';
  } catch {
    return false;
  }
}
