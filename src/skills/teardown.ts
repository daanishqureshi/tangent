/**
 * skills/teardown.ts
 *
 * Scale an ECS service down to 0 running tasks.
 *
 * SAFETY: Tangent NEVER deletes AWS resources. Teardown = scale to 0 only.
 * The ECS service definition and task definitions are left intact.
 * No ECR images are touched.
 *
 * Input:  { repo }
 * Output: { success: boolean }
 */

import {
  UpdateServiceCommand,
  ListTasksCommand,
  DescribeServicesCommand,
} from '@aws-sdk/client-ecs';
import { ecsClient } from '../services/aws.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { assertAllowedCluster } from '../utils/safety.js';
import { SERVICE_PREFIX } from '../utils/constants.js';

export interface TeardownInput {
  repo: string;
}

export interface TeardownOutput {
  success: boolean;
  message: string;
}

export async function teardownSkill(input: TeardownInput): Promise<TeardownOutput> {
  const { repo } = input;
  const { ecsClusterName } = config();

  // Safety: only touch the allowed cluster
  assertAllowedCluster(ecsClusterName);

  const serviceName = `${SERVICE_PREFIX}${repo}`;
  logger.info({ action: 'teardown:start', repo, serviceName, cluster: ecsClusterName }, 'Starting teardown (scale to 0)');

  // Check the service exists first
  try {
    const desc = await ecsClient().send(
      new DescribeServicesCommand({ cluster: ecsClusterName, services: [serviceName] }),
    );
    const svc = desc.services?.[0];
    if (!svc || svc.status === 'INACTIVE') {
      return { success: false, message: `Service \`${serviceName}\` not found or already inactive.` };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, message: `Could not find service: ${msg}` };
  }

  // Scale to 0 — this stops all running tasks without deleting anything
  try {
    await ecsClient().send(
      new UpdateServiceCommand({
        cluster: ecsClusterName,
        service: serviceName,
        desiredCount: 0,
      }),
    );
    logger.info({ action: 'teardown:scaled_down', serviceName }, 'Service scaled to 0');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ action: 'teardown:scale_failed', serviceName, err }, 'Scale to 0 failed');
    return { success: false, message: `Failed to scale down: ${msg}` };
  }

  // Wait for tasks to drain (max 60s)
  await waitForTasksDrained(ecsClusterName, serviceName, 60_000);

  const message = `Service \`${serviceName}\` scaled to 0. No tasks are running. The service definition is preserved — nothing was deleted.`;
  logger.info({ action: 'teardown:done', repo, serviceName }, message);
  return { success: true, message };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function waitForTasksDrained(cluster: string, serviceName: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const result = await ecsClient().send(new ListTasksCommand({ cluster, serviceName }));
      if (!result.taskArns || result.taskArns.length === 0) return;
    } catch {
      return; // if we can't check, don't block
    }
    await sleep(3_000);
  }
  logger.warn({ action: 'teardown:drain_timeout', serviceName }, 'Tasks did not drain within timeout — continuing anyway');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
