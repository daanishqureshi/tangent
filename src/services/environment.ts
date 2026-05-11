/**
 * Shared environment/secrets service.
 *
 * Slack tools, HTTP routes, and the dashboard all use this instead of each
 * re-implementing Secrets Manager and ECS task-definition mutation.
 */

import {
  CreateSecretCommand,
  DescribeSecretCommand,
  ListSecretsCommand,
  PutSecretValueCommand,
  ResourceExistsException,
} from '@aws-sdk/client-secrets-manager';
import {
  DescribeTaskDefinitionCommand,
  ListTaskDefinitionsCommand,
  RegisterTaskDefinitionCommand,
  UpdateServiceCommand,
} from '@aws-sdk/client-ecs';
import { config } from '../config.js';
import { ecsClient, smClient } from './aws.js';
import { recordAuditEvent } from './audit.js';
import { SERVICE_PREFIX, TASK_FAMILY_PREFIX } from '../utils/constants.js';
import { assertAllowedCluster } from '../utils/safety.js';
import { logger } from '../utils/logger.js';

export interface SecretSummary {
  name: string;
  description?: string;
}

export interface ActorContext {
  actor: string;
  surface: 'slack' | 'dashboard' | 'http' | 'cron' | 'system';
}

export function validateEnvVarName(name: string): boolean {
  return /^[A-Z_][A-Z0-9_]{0,127}$/.test(name);
}

export function normalizeSecretName(name: string): string {
  const trimmed = name.trim().replace(/^\/+/, '');
  const prefix = config().secretsManagerPrefix;
  return trimmed.startsWith(prefix) ? trimmed : `${prefix}${trimmed}`;
}

export function envVarNameFromSecretName(secretName: string): string {
  const prefix = config().secretsManagerPrefix;
  return secretName.startsWith(prefix) ? secretName.slice(prefix.length) : secretName;
}

export async function listSecrets(): Promise<SecretSummary[]> {
  const secrets: SecretSummary[] = [];
  let nextToken: string | undefined;
  do {
    const r = await smClient().send(new ListSecretsCommand({ NextToken: nextToken, MaxResults: 100 }));
    for (const s of r.SecretList ?? []) {
      if (s.Name?.startsWith(config().secretsManagerPrefix)) {
        secrets.push({ name: s.Name, description: s.Description });
      }
    }
    nextToken = r.NextToken;
  } while (nextToken);
  return secrets.sort((a, b) => a.name.localeCompare(b.name));
}

export async function putSecret(
  input: { name: string; value: string; description?: string },
  actor: ActorContext,
): Promise<{ name: string; created: boolean }> {
  const name = normalizeSecretName(input.name);
  let created = false;

  try {
    await smClient().send(new CreateSecretCommand({
      Name: name,
      SecretString: input.value,
      Description: input.description,
    }));
    created = true;
  } catch (err) {
    if (err instanceof ResourceExistsException || (err as { name?: string }).name === 'ResourceExistsException') {
      await smClient().send(new PutSecretValueCommand({
        SecretId: name,
        SecretString: input.value,
      }));
    } else {
      throw err;
    }
  }

  await recordAuditEvent({
    action: created ? 'secret:create' : 'secret:update',
    actor: actor.actor,
    surface: actor.surface,
    target: name,
    metadata: { description: input.description ? 'provided' : 'none' },
  });

  return { name, created };
}

export interface InjectedSecret {
  name: string;
  valueFrom: string;
}

export interface ConfigureServiceEnvironmentResult {
  taskDefinitionArn: string;
  changed: boolean;
  envVars: string[];
  secretEnvVars: string[];
}

export async function getInjectedSecrets(repo: string): Promise<InjectedSecret[]> {
  const taskFamily = `${TASK_FAMILY_PREFIX}${repo}`;
  const listResult = await ecsClient().send(new ListTaskDefinitionsCommand({
    familyPrefix: taskFamily,
    sort: 'DESC',
    maxResults: 1,
    status: 'ACTIVE',
  }));
  const latestArn = listResult.taskDefinitionArns?.[0];
  if (!latestArn) return [];

  const descResult = await ecsClient().send(new DescribeTaskDefinitionCommand({ taskDefinition: latestArn }));
  const appContainer = descResult.taskDefinition?.containerDefinitions?.find((c) => c.name === 'app');
  return (appContainer?.secrets ?? [])
    .filter((s): s is InjectedSecret => Boolean(s.name && s.valueFrom));
}

export async function injectSecretIntoService(
  input: { repo: string; secretName: string; envVarName?: string },
  actor: ActorContext,
): Promise<{ secretName: string; envVarName: string; taskDefinitionArn: string; alreadyInjected: boolean }> {
  const { ecsClusterName, ecsTaskRoleArn, secretsManagerPrefix } = config();
  assertAllowedCluster(ecsClusterName);

  const secretName = normalizeSecretName(input.secretName);
  const envVarName = input.envVarName?.trim() || envVarNameFromSecretName(secretName);
  if (!validateEnvVarName(envVarName)) {
    throw new Error(`Invalid environment variable name "${envVarName}"`);
  }

  const secretMeta = await smClient().send(new DescribeSecretCommand({ SecretId: secretName }));
  const secretArn = secretMeta.ARN;
  if (!secretArn) throw new Error(`Secret "${secretName}" not found in Secrets Manager`);

  const taskFamily = `${TASK_FAMILY_PREFIX}${input.repo}`;
  const listResult = await ecsClient().send(new ListTaskDefinitionsCommand({
    familyPrefix: taskFamily,
    sort: 'DESC',
    maxResults: 1,
    status: 'ACTIVE',
  }));
  const latestArn = listResult.taskDefinitionArns?.[0];
  if (!latestArn) throw new Error(`No active task definition found for "${input.repo}"`);

  const descResult = await ecsClient().send(new DescribeTaskDefinitionCommand({ taskDefinition: latestArn }));
  const taskDef = descResult.taskDefinition;
  if (!taskDef) throw new Error('Could not describe task definition');

  const containers = taskDef.containerDefinitions ?? [];
  const appContainer = containers.find((c) => c.name === 'app');
  if (!appContainer) throw new Error('No "app" container found in task definition');

  const existingSecrets = appContainer.secrets ?? [];
  const existing = existingSecrets.find((s) => s.name === envVarName);
  if (existing?.valueFrom === secretArn) {
    await recordAuditEvent({
      action: 'secret:inject:skip_existing',
      actor: actor.actor,
      surface: actor.surface,
      target: input.repo,
      metadata: { secretName, envVarName, taskDefinitionArn: latestArn },
    });
    return { secretName, envVarName, taskDefinitionArn: latestArn, alreadyInjected: true };
  }

  appContainer.secrets = [
    ...existingSecrets
      .filter((s) => s.name !== envVarName)
      .filter((s) => {
        const arn = s.valueFrom ?? '';
        if (arn.includes(`:secret:${secretsManagerPrefix}`) || arn.includes(`:secret:${secretsManagerPrefix.replace(/\/$/, '')}`)) {
          return true;
        }
        logger.warn(
          { action: 'environment:drop_unprefixed_secret', name: s.name, arn },
          `Dropping inherited secret "${s.name}" outside configured prefix`,
        );
        return false;
      }),
    { name: envVarName, valueFrom: secretArn },
  ];

  const registerResult = await ecsClient().send(new RegisterTaskDefinitionCommand({
    family: taskDef.family,
    containerDefinitions: containers,
    networkMode: taskDef.networkMode,
    requiresCompatibilities: taskDef.requiresCompatibilities,
    cpu: taskDef.cpu,
    memory: taskDef.memory,
    executionRoleArn: taskDef.executionRoleArn,
    taskRoleArn: taskDef.taskRoleArn ?? ecsTaskRoleArn,
    volumes: taskDef.volumes,
  }));
  const taskDefinitionArn = registerResult.taskDefinition?.taskDefinitionArn;
  if (!taskDefinitionArn) throw new Error('Task definition re-registration returned no ARN');

  try {
    await ecsClient().send(new UpdateServiceCommand({
      cluster: ecsClusterName,
      service: `${SERVICE_PREFIX}${input.repo}`,
      taskDefinition: taskDefinitionArn,
      forceNewDeployment: true,
    }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/active deployments|unable to create new deployment/i.test(msg)) {
      throw new Error(`ECS already has too many active deployments for "${input.repo}". Wait ~30-60 seconds for the current rollout to settle, then retry this same injection.`);
    }
    throw err;
  }

  await recordAuditEvent({
    action: 'secret:inject',
    actor: actor.actor,
    surface: actor.surface,
    target: input.repo,
    metadata: { secretName, envVarName, taskDefinitionArn },
  });

  return { secretName, envVarName, taskDefinitionArn, alreadyInjected: false };
}

export async function configureServiceEnvironment(
  input: {
    repo: string;
    env?: Record<string, string>;
    secrets?: Array<{ secretName: string; envVarName: string }>;
  },
  actor: ActorContext,
): Promise<ConfigureServiceEnvironmentResult> {
  const { ecsClusterName, ecsTaskRoleArn, secretsManagerPrefix } = config();
  assertAllowedCluster(ecsClusterName);

  const env = input.env ?? {};
  const secrets = input.secrets ?? [];
  const envVars = Object.keys(env);
  const secretEnvVars = secrets.map((s) => s.envVarName);
  for (const name of [...envVars, ...secretEnvVars]) {
    if (!validateEnvVarName(name)) {
      throw new Error(`Invalid environment variable name "${name}"`);
    }
  }

  const secretArns = new Map<string, { secretName: string; arn: string }>();
  for (const secret of secrets) {
    const secretName = normalizeSecretName(secret.secretName);
    const secretMeta = await smClient().send(new DescribeSecretCommand({ SecretId: secretName }));
    const arn = secretMeta.ARN;
    if (!arn) throw new Error(`Secret "${secretName}" not found in Secrets Manager`);
    secretArns.set(secret.envVarName, { secretName, arn });
  }

  const taskFamily = `${TASK_FAMILY_PREFIX}${input.repo}`;
  const listResult = await ecsClient().send(new ListTaskDefinitionsCommand({
    familyPrefix: taskFamily,
    sort: 'DESC',
    maxResults: 1,
    status: 'ACTIVE',
  }));
  const latestArn = listResult.taskDefinitionArns?.[0];
  if (!latestArn) throw new Error(`No active task definition found for "${input.repo}". Deploy the service once, then provision its database.`);

  const descResult = await ecsClient().send(new DescribeTaskDefinitionCommand({ taskDefinition: latestArn }));
  const taskDef = descResult.taskDefinition;
  if (!taskDef) throw new Error('Could not describe task definition');

  const containers = taskDef.containerDefinitions ?? [];
  const appContainer = containers.find((c) => c.name === 'app');
  if (!appContainer) throw new Error('No "app" container found in task definition');

  const existingEnv = appContainer.environment ?? [];
  const existingSecrets = appContainer.secrets ?? [];
  const newEnvironment = [
    ...existingEnv.filter((entry) => entry.name && !(entry.name in env)),
    ...Object.entries(env).map(([name, value]) => ({ name, value })),
  ];
  const newSecrets = [
    ...existingSecrets
      .filter((entry) => entry.name && !secretArns.has(entry.name))
      .filter((entry) => {
        const arn = entry.valueFrom ?? '';
        if (arn.includes(`:secret:${secretsManagerPrefix}`) || arn.includes(`:secret:${secretsManagerPrefix.replace(/\/$/, '')}`)) {
          return true;
        }
        logger.warn(
          { action: 'environment:drop_unprefixed_secret', name: entry.name, arn },
          `Dropping inherited secret "${entry.name}" outside configured prefix`,
        );
        return false;
      }),
    ...Array.from(secretArns.entries()).map(([name, secret]) => ({ name, valueFrom: secret.arn })),
  ];

  const envChanged = JSON.stringify(existingEnv) !== JSON.stringify(newEnvironment);
  const secretsChanged = JSON.stringify(existingSecrets) !== JSON.stringify(newSecrets);
  if (!envChanged && !secretsChanged) {
    await recordAuditEvent({
      action: 'environment:configure:skip_existing',
      actor: actor.actor,
      surface: actor.surface,
      target: input.repo,
      metadata: { envVars, secretEnvVars, taskDefinitionArn: latestArn },
    });
    return { taskDefinitionArn: latestArn, changed: false, envVars, secretEnvVars };
  }

  appContainer.environment = newEnvironment;
  appContainer.secrets = newSecrets;

  const registerResult = await ecsClient().send(new RegisterTaskDefinitionCommand({
    family: taskDef.family,
    containerDefinitions: containers,
    networkMode: taskDef.networkMode,
    requiresCompatibilities: taskDef.requiresCompatibilities,
    cpu: taskDef.cpu,
    memory: taskDef.memory,
    executionRoleArn: taskDef.executionRoleArn,
    taskRoleArn: taskDef.taskRoleArn ?? ecsTaskRoleArn,
    volumes: taskDef.volumes,
  }));
  const taskDefinitionArn = registerResult.taskDefinition?.taskDefinitionArn;
  if (!taskDefinitionArn) throw new Error('Task definition re-registration returned no ARN');

  try {
    await ecsClient().send(new UpdateServiceCommand({
      cluster: ecsClusterName,
      service: `${SERVICE_PREFIX}${input.repo}`,
      taskDefinition: taskDefinitionArn,
      forceNewDeployment: true,
    }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/active deployments|unable to create new deployment/i.test(msg)) {
      throw new Error(`ECS already has too many active deployments for "${input.repo}". Wait ~30-60 seconds for the current rollout to settle, then retry database provisioning.`);
    }
    throw err;
  }

  await recordAuditEvent({
    action: 'environment:configure',
    actor: actor.actor,
    surface: actor.surface,
    target: input.repo,
    metadata: { envVars, secretEnvVars, taskDefinitionArn },
  });

  return { taskDefinitionArn, changed: true, envVars, secretEnvVars };
}
