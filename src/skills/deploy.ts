/**
 * skills/deploy.ts
 *
 * Register an ECS task definition and create/update the ECS service.
 * Each task has two containers: the app and an ngrok sidecar.
 *
 * Input:  { repo, imageUri, port?, env?, cpu?, memory? }
 * Output: { serviceName, taskDefinition }
 */

import { randomBytes } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  RegisterTaskDefinitionCommand,
  CreateServiceCommand,
  UpdateServiceCommand,
  DescribeServicesCommand,
  ListServicesCommand,
  DescribeTaskDefinitionCommand,
  ListTaskDefinitionsCommand,
  type ContainerDefinition,
  type LogConfiguration,
  type Secret,
} from '@aws-sdk/client-ecs';
import {
  DescribeInstancesCommand,
  DescribeSecurityGroupsCommand,
  DescribeSubnetsCommand,
} from '@aws-sdk/client-ec2';
import {
  CreateLogGroupCommand,
  PutRetentionPolicyCommand,
} from '@aws-sdk/client-cloudwatch-logs';
import { ecsClient, cwlClient, ec2Client } from '../services/aws.js';
import { config } from '../config.js';
import { getServiceUrl, setServiceUrlLater } from '../services/state.js';
import { logger } from '../utils/logger.js';
import { assertAllowedCluster } from '../utils/safety.js';
import { SERVICE_PREFIX, TASK_FAMILY_PREFIX, NGROK_IMAGE } from '../utils/constants.js';

export interface DeployInput {
  repo: string;
  imageUri: string;
  port?: number;
  env?: Record<string, string>;
  freshUrl?: boolean; // force a new ngrok URL even if one already exists
  cpu?: number;       // optional per-deploy Fargate task CPU units
  memory?: number;    // optional per-deploy Fargate task memory in MiB
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
    pgHostInternalIp,
    sharedAppSecrets,
    ngrokAuthtokenSecretValueFrom,
    ngrokOAuthDomains,
  } = config();

  // Safety: only touch the allowed cluster
  assertAllowedCluster(ecsClusterName);

  const port = input.port ?? defaultAppPort;
  const serviceName = `${SERVICE_PREFIX}${repo}`;
  const taskFamily = `${TASK_FAMILY_PREFIX}${repo}`;
  const taskSize = resolveTaskSize(input.cpu, input.memory, taskCpu, taskMemory);

  // ─── Resolve ngrok URL for this deploy ───────────────────────────────────
  // Reuse the URL from a previous deploy if one exists, so the endpoint stays
  // stable across redeployments. Pass freshUrl=true to generate a new one.
  const ngrokUrl = await resolveNgrokUrl(repo, input.freshUrl ?? false);

  logger.info({ action: 'deploy:ngrok_url', ngrokUrl, fresh: input.freshUrl ?? false }, 'Resolved ngrok URL');

  // ─── Ensure CloudWatch log group exists ──────────────────────────────────

  await ensureLogGroup(logGroupName);

  // ─── Build container definitions ─────────────────────────────────────────

  // Inject DB connection constants into every app container so services can reach
  // the shared Postgres on the Tangent EC2 without any extra inject_secret steps.
  // DB_PASSWORD is NOT injected here — services request it via inject_secret when
  // they need write access.  Service-supplied env vars override these defaults.
  const dbDefaults: Record<string, string> = {
    DB_HOST: pgHostInternalIp,
    DB_PORT: '5432',
  };
  const mergedEnv: Record<string, string> = { ...dbDefaults, ...env };
  const appEnv = Object.entries(mergedEnv).map(([name, value]) => ({ name, value }));

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
  // All configured secrets should be covered by the ECS execution role policy.
  const configuredSharedAppSecrets: Secret[] = sharedAppSecrets;

  // ngrok authtoken is stored in Secrets Manager and injected by ECS at runtime.
  const ngrokSecrets: Secret[] = [
    {
      name: 'NGROK_AUTHTOKEN',
      valueFrom: ngrokAuthtokenSecretValueFrom,
    },
  ];

  // Merge shared secrets with any extra secrets from the previous task def revision.
  // sharedAppSecrets always wins (deduped by name), so the cluster-wide keys are
  // always present on every app container regardless of what was there before.
  const inheritedSecrets = await fetchExistingAppSecrets(taskFamily);
  const sharedNames = new Set(configuredSharedAppSecrets.map((s) => s.name));
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
  const appSecrets = [...configuredSharedAppSecrets, ...extraSecrets];
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
      ...ngrokOAuthDomains.flatMap((domain) => ['--oauth-allow-domain', domain]),
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
    cpu: taskSize.cpu,
    memory: taskSize.memory,
    executionRoleArn: ecsExecutionRoleArn,
    taskRoleArn: ecsTaskRoleArn,
  });

  const registerResult = await ecsClient().send(registerCmd);
  const taskDefArn = registerResult.taskDefinition?.taskDefinitionArn;
  if (!taskDefArn) throw new Error('ECS task definition registration returned no ARN');

  logger.info({ action: 'deploy:task_def_registered', taskDefArn }, 'Task definition registered');

  // ─── Create or update service ─────────────────────────────────────────────

  const networkConfig = await resolveServiceNetworkConfig();
  logger.info(
    {
      action: 'deploy:network_config',
      subnets: networkConfig.awsvpcConfiguration.subnets,
      securityGroups: networkConfig.awsvpcConfiguration.securityGroups,
      assignPublicIp: networkConfig.awsvpcConfiguration.assignPublicIp,
    },
    'Resolved ECS network configuration',
  );

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
      networkConfiguration: networkConfig,
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
  logger.info({ action: 'deploy:done', serviceName, taskDefArn, deployedAt, ngrokUrl, taskSize }, 'Deploy complete');

  return { serviceName, taskDefinition: taskDefArn, deployedAt, ngrokUrl };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function resolveTaskSize(
  cpuOverride: number | undefined,
  memoryOverride: number | undefined,
  defaultCpu: string,
  defaultMemory: string,
): { cpu: string; memory: string } {
  const cpu = cpuOverride ?? Number(defaultCpu);
  const memory = memoryOverride ?? Number(defaultMemory);

  if (!Number.isInteger(cpu) || !Number.isInteger(memory)) {
    throw new Error(`Invalid ECS task size: cpu and memory must be integers. Got cpu=${cpu}, memory=${memory}.`);
  }

  if (!isValidFargateTaskSize(cpu, memory)) {
    throw new Error(
      `Invalid ECS Fargate task size: cpu=${cpu}, memory=${memory}. ` +
      'Use a valid Fargate pair, for example cpu=1024 memory=2048-8192, or cpu=2048 memory=4096-16384.',
    );
  }

  return { cpu: String(cpu), memory: String(memory) };
}

function isValidFargateTaskSize(cpu: number, memory: number): boolean {
  const memoryOptionsByCpu = new Map<number, number[]>([
    [256, [512, 1024, 2048]],
    [512, range(1024, 4096, 1024)],
    [1024, range(2048, 8192, 1024)],
    [2048, range(4096, 16384, 1024)],
    [4096, range(8192, 30720, 1024)],
    [8192, range(16384, 61440, 4096)],
    [16384, range(32768, 122880, 8192)],
  ]);

  return memoryOptionsByCpu.get(cpu)?.includes(memory) ?? false;
}

function range(min: number, max: number, step: number): number[] {
  const values: number[] = [];
  for (let value = min; value <= max; value += step) values.push(value);
  return values;
}

export interface ServiceNetworkConfig {
  awsvpcConfiguration: {
    subnets: string[];
    securityGroups: string[];
    assignPublicIp: 'ENABLED' | 'DISABLED';
  };
}

export async function resolveServiceNetworkConfig(): Promise<ServiceNetworkConfig> {
  const cfg = config();
  const configured: ServiceNetworkConfig = {
    awsvpcConfiguration: {
      subnets: cfg.fargate.subnets,
      securityGroups: [cfg.fargate.securityGroup],
      assignPublicIp: cfg.fargate.assignPublicIp,
    },
  };

  const targetVpcId = await findVpcForPostgresHost(cfg.pgHostInternalIp);
  if (!targetVpcId) {
    logger.warn(
      { action: 'deploy:network:no_target_vpc', pgHost: cfg.pgHostInternalIp },
      'Could not find Postgres host VPC; using configured Fargate networking',
    );
    return configured;
  }

  if (await networkBelongsToVpc(
    configured.awsvpcConfiguration.subnets,
    configured.awsvpcConfiguration.securityGroups,
    targetVpcId,
  )) {
    return configured;
  }

  const existingServiceNetwork = await findExistingServiceNetworkInVpc(targetVpcId);
  if (existingServiceNetwork) {
    logger.info({ action: 'deploy:network:existing_service', targetVpcId }, 'Using existing ECS service network in Postgres VPC');
    return existingServiceNetwork;
  }

  const subnets = await findPublicSubnetsInVpc(targetVpcId);
  if (subnets.length === 0) {
    throw new Error(`Could not find usable Fargate subnets in Postgres VPC ${targetVpcId}`);
  }

  return {
    awsvpcConfiguration: {
      subnets,
      securityGroups: await findConfiguredOrDefaultSecurityGroup(targetVpcId, configured.awsvpcConfiguration.securityGroups),
      assignPublicIp: 'ENABLED',
    },
  };
}

async function findVpcForPostgresHost(privateIp: string): Promise<string | null> {
  try {
    const result = await ec2Client().send(new DescribeInstancesCommand({
      Filters: [
        { Name: 'private-ip-address', Values: [privateIp] },
        { Name: 'instance-state-name', Values: ['pending', 'running', 'stopping', 'stopped'] },
      ],
    }));
    return result.Reservations?.flatMap((r) => r.Instances ?? [])[0]?.VpcId ?? null;
  } catch (err) {
    logger.warn({ action: 'deploy:network:vpc_lookup_failed', err, privateIp }, 'Failed to look up Postgres host VPC');
    return null;
  }
}

async function networkBelongsToVpc(subnets: string[], securityGroups: string[], vpcId: string): Promise<boolean> {
  try {
    const [subnetResult, sgResult] = await Promise.all([
      ec2Client().send(new DescribeSubnetsCommand({ SubnetIds: subnets })),
      ec2Client().send(new DescribeSecurityGroupsCommand({ GroupIds: securityGroups })),
    ]);
    return (subnetResult.Subnets ?? []).length === subnets.length
      && (sgResult.SecurityGroups ?? []).length === securityGroups.length
      && (subnetResult.Subnets ?? []).every((s) => s.VpcId === vpcId)
      && (sgResult.SecurityGroups ?? []).every((sg) => sg.VpcId === vpcId);
  } catch {
    return false;
  }
}

async function findExistingServiceNetworkInVpc(vpcId: string): Promise<ServiceNetworkConfig | null> {
  try {
    const cfg = config();
    const serviceArns: string[] = [];
    let nextToken: string | undefined;

    do {
      const page = await ecsClient().send(new ListServicesCommand({
        cluster: cfg.ecsClusterName,
        maxResults: 10,
        nextToken,
      }));
      serviceArns.push(...(page.serviceArns ?? []));
      nextToken = page.nextToken;
    } while (nextToken && serviceArns.length < 50);

    for (let i = 0; i < serviceArns.length; i += 10) {
      const described = await ecsClient().send(new DescribeServicesCommand({
        cluster: cfg.ecsClusterName,
        services: serviceArns.slice(i, i + 10),
      }));

      for (const svc of described.services ?? []) {
        const net = svc.networkConfiguration?.awsvpcConfiguration;
        const subnets = net?.subnets?.filter(Boolean) ?? [];
        const securityGroups = net?.securityGroups?.filter(Boolean) ?? [];
        if (subnets.length === 0 || securityGroups.length === 0) continue;
        if (await networkBelongsToVpc(subnets, securityGroups, vpcId)) {
          return {
            awsvpcConfiguration: {
              subnets,
              securityGroups,
              assignPublicIp: net?.assignPublicIp ?? 'ENABLED',
            },
          };
        }
      }
    }
  } catch (err) {
    logger.warn({ action: 'deploy:network:existing_service_failed', err, vpcId }, 'Failed to find existing ECS service network');
  }
  return null;
}

async function findPublicSubnetsInVpc(vpcId: string): Promise<string[]> {
  const result = await ec2Client().send(new DescribeSubnetsCommand({
    Filters: [
      { Name: 'vpc-id', Values: [vpcId] },
      { Name: 'state', Values: ['available'] },
    ],
  }));

  return (result.Subnets ?? [])
    .filter((s) => s.MapPublicIpOnLaunch)
    .sort((a, b) => (b.AvailableIpAddressCount ?? 0) - (a.AvailableIpAddressCount ?? 0))
    .map((s) => s.SubnetId)
    .filter((id): id is string => Boolean(id))
    .slice(0, 3);
}

async function findConfiguredOrDefaultSecurityGroup(vpcId: string, configuredSecurityGroups: string[]): Promise<string[]> {
  if (configuredSecurityGroups.length > 0) {
    try {
      const result = await ec2Client().send(new DescribeSecurityGroupsCommand({ GroupIds: configuredSecurityGroups }));
      const matching = (result.SecurityGroups ?? [])
        .filter((sg) => sg.VpcId === vpcId)
        .map((sg) => sg.GroupId)
        .filter((id): id is string => Boolean(id));
      if (matching.length > 0) return matching;
    } catch {
      // Fall through to default SG lookup.
    }
  }

  const defaults = await ec2Client().send(new DescribeSecurityGroupsCommand({
    Filters: [
      { Name: 'vpc-id', Values: [vpcId] },
      { Name: 'group-name', Values: ['default'] },
    ],
  }));
  const defaultGroup = defaults.SecurityGroups?.[0]?.GroupId;
  if (!defaultGroup) throw new Error(`Could not find a security group in Postgres VPC ${vpcId}`);
  return [defaultGroup];
}

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
    const tmp = `${NGROK_URLS_FILE}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, JSON.stringify(urls, null, 2));
    renameSync(tmp, NGROK_URLS_FILE);
  } catch (err) {
    logger.warn({ action: 'deploy:ngrok_url_save_failed', err }, 'Could not persist ngrok URL');
  }
}

async function resolveNgrokUrl(repo: string, fresh: boolean): Promise<string> {
  const dbUrl = fresh ? null : await getServiceUrl(repo);
  if (dbUrl) return dbUrl;

  const urls = loadNgrokUrls();
  if (!fresh && urls[repo]) {
    setServiceUrlLater(repo, urls[repo]!, { migratedFrom: 'config/ngrok-urls.json' });
    return urls[repo]!;
  }
  const suffix = randomBytes(4).toString('hex');
  const slug = `tangent-${repo.toLowerCase().replace(/[^a-z0-9]/g, '-').slice(0, 20)}-${suffix}`;
  const url = `https://${slug}.ngrok.app`;
  saveNgrokUrl(repo, url);
  setServiceUrlLater(repo, url, { fresh });
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
