/**
 * skills/discover.ts
 *
 * Checks what config values are missing or still placeholder, then
 * queries AWS to find the real values automatically.
 *
 * Step 1 (no AWS needed): scan config for REPLACE_ME / empty values.
 * Step 2 (AWS): try to auto-discover values from ECR, ECS services, task defs.
 * Step 3: report findings + surface any AWS errors explicitly.
 */

import { DescribeRepositoriesCommand } from '@aws-sdk/client-ecr';
import {
  ListServicesCommand,
  DescribeServicesCommand,
  ListTaskDefinitionsCommand,
  DescribeTaskDefinitionCommand,
} from '@aws-sdk/client-ecs';
import { DescribeLogGroupsCommand } from '@aws-sdk/client-cloudwatch-logs';
import { ecrClient, ecsClient, cwlClient } from '../services/aws.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

export interface DiscoveryResult {
  missing: string[];                                            // keys that are REPLACE_ME / empty
  suggestions: Array<{ key: string; value: string; source: string }>; // auto-found values
  ecrRepos: string[];                                           // all ECR repos in account
  subnets: string[];
  securityGroups: string[];
  executionRoleArn: string | null;
  logGroupExists: boolean | null;                              // null = couldn't check
  awsErrors: string[];                                          // surfaced, not swallowed
}

function isMissing(val: string | undefined): boolean {
  return !val || val.startsWith('REPLACE') || val === 'local-dev' || val === 'subnet-local' || val === 'sg-local';
}

// Keys to check and their current config values
function configSnapshot() {
  const cfg = config();
  return [
    { key: 'ECR_REPO_NAME',         value: cfg.ecrRepoName },
    { key: 'FARGATE_SUBNETS',       value: cfg.fargate.subnets.join(',') },
    { key: 'FARGATE_SECURITY_GROUP', value: cfg.fargate.securityGroup },
    { key: 'ECS_EXECUTION_ROLE_ARN', value: cfg.ecsExecutionRoleArn },
    { key: 'NGROK_AUTHTOKEN',       value: cfg.ngrokAuthtoken },
    { key: 'GITHUB_TOKEN',          value: cfg.githubToken },
    { key: 'SLACK_TOKEN',           value: cfg.slackToken },
  ];
}

export async function discoverSkill(): Promise<DiscoveryResult> {
  const cfg = config();
  logger.info({ action: 'discover:start' }, 'Starting discovery');

  const result: DiscoveryResult = {
    missing: [],
    suggestions: [],
    ecrRepos: [],
    subnets: [],
    securityGroups: [],
    executionRoleArn: null,
    logGroupExists: null,
    awsErrors: [],
  };

  // ── Step 1: config scan (no AWS needed) ───────────────────────────────────
  for (const { key, value } of configSnapshot()) {
    if (isMissing(value)) result.missing.push(key);
  }

  logger.info({ action: 'discover:config_scan', missing: result.missing }, 'Config scan done');

  // ── Step 2: ECR repositories ──────────────────────────────────────────────
  try {
    const ecr = await ecrClient().send(new DescribeRepositoriesCommand({ maxResults: 50 }));
    result.ecrRepos = (ecr.repositories ?? []).map((r) => r.repositoryName ?? '').filter(Boolean);

    if (result.missing.includes('ECR_REPO_NAME') && result.ecrRepos.length > 0) {
      const clusterNorm = cfg.ecsClusterName.toLowerCase().replace(/[^a-z0-9]/g, '');
      const best =
        result.ecrRepos.find((r) => r.toLowerCase().replace(/[^a-z0-9]/g, '').includes(clusterNorm)) ??
        result.ecrRepos.find((r) => r.toLowerCase().includes('vibe') || r.toLowerCase().includes('impiricus')) ??
        result.ecrRepos[0];
      result.suggestions.push({ key: 'ECR_REPO_NAME', value: best, source: 'ECR (best match)' });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    result.awsErrors.push(`ECR: ${msg}`);
    logger.warn({ action: 'discover:ecr_failed', err }, 'ECR call failed');
  }

  // ── Step 3: Network config from existing ECS services ────────────────────
  try {
    const listResult = await ecsClient().send(
      new ListServicesCommand({ cluster: cfg.ecsClusterName, maxResults: 10 }),
    );
    const arns = listResult.serviceArns ?? [];

    if (arns.length > 0) {
      const described = await ecsClient().send(
        new DescribeServicesCommand({ cluster: cfg.ecsClusterName, services: arns.slice(0, 1) }),
      );
      const svc = described.services?.[0];
      const net = svc?.networkConfiguration?.awsvpcConfiguration;

      if (net?.subnets?.length) {
        result.subnets = net.subnets;
        if (result.missing.includes('FARGATE_SUBNETS')) {
          result.suggestions.push({ key: 'FARGATE_SUBNETS', value: net.subnets.join(','), source: `ECS service "${svc?.serviceName}"` });
        }
      }
      if (net?.securityGroups?.length) {
        result.securityGroups = net.securityGroups;
        if (result.missing.includes('FARGATE_SECURITY_GROUP')) {
          result.suggestions.push({ key: 'FARGATE_SECURITY_GROUP', value: net.securityGroups[0], source: `ECS service "${svc?.serviceName}"` });
        }
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    result.awsErrors.push(`ECS services: ${msg}`);
    logger.warn({ action: 'discover:ecs_failed', err }, 'ECS call failed');
  }

  // ── Step 4: Execution role from task definitions ──────────────────────────
  try {
    const tdList = await ecsClient().send(new ListTaskDefinitionsCommand({ status: 'ACTIVE', maxResults: 20 }));
    for (const arn of tdList.taskDefinitionArns ?? []) {
      const td = await ecsClient().send(new DescribeTaskDefinitionCommand({ taskDefinition: arn }));
      const roleArn = td.taskDefinition?.executionRoleArn;
      if (roleArn) {
        result.executionRoleArn = roleArn;
        if (result.missing.includes('ECS_EXECUTION_ROLE_ARN')) {
          result.suggestions.push({ key: 'ECS_EXECUTION_ROLE_ARN', value: roleArn, source: `task def "${arn.split('/').pop()}"` });
        }
        break;
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    result.awsErrors.push(`ECS task defs: ${msg}`);
    logger.warn({ action: 'discover:taskdefs_failed', err }, 'Task def call failed');
  }

  // ── Step 5: CloudWatch log group ──────────────────────────────────────────
  try {
    const logs = await cwlClient().send(
      new DescribeLogGroupsCommand({ logGroupNamePrefix: cfg.logGroupName, limit: 5 }),
    );
    result.logGroupExists = (logs.logGroups ?? []).some((g) => g.logGroupName === cfg.logGroupName);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    result.awsErrors.push(`CloudWatch: ${msg}`);
    logger.warn({ action: 'discover:logs_failed', err }, 'CloudWatch call failed');
  }

  logger.info({ action: 'discover:done', missing: result.missing, awsErrors: result.awsErrors.length }, 'Discovery complete');
  return result;
}
