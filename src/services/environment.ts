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

export async function injectSecretIntoService(
  input: { repo: string; secretName: string; envVarName?: string },
  actor: ActorContext,
): Promise<{ secretName: string; envVarName: string; taskDefinitionArn: string }> {
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

  await ecsClient().send(new UpdateServiceCommand({
    cluster: ecsClusterName,
    service: `${SERVICE_PREFIX}${input.repo}`,
    taskDefinition: taskDefinitionArn,
    forceNewDeployment: true,
  }));

  await recordAuditEvent({
    action: 'secret:inject',
    actor: actor.actor,
    surface: actor.surface,
    target: input.repo,
    metadata: { secretName, envVarName, taskDefinitionArn },
  });

  return { secretName, envVarName, taskDefinitionArn };
}
