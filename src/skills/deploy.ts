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

  // ─── Generate a random ngrok URL for this deploy ─────────────────────────
  // On paid ngrok plans, any subdomain of ngrok.app works without pre-registering.
  // We generate it here so we know the URL before the container starts.

  const suffix = randomBytes(4).toString('hex'); // 8 random hex chars
  const slug = `tangent-${repo.toLowerCase().replace(/[^a-z0-9]/g, '-').slice(0, 20)}-${suffix}`;
  const ngrokUrl = `https://${slug}.ngrok.app`;

  logger.info({ action: 'deploy:ngrok_url', ngrokUrl }, 'Generated ngrok URL');

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
  const extraSecrets = inheritedSecrets.filter((s) => !sharedNames.has(s.name ?? ''));
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
