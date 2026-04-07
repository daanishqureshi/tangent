/**
 * skills/monitor.ts
 *
 * Check the health of all vibecode-* ECS services and alert Slack when
 * a service has been degraded for longer than the threshold.
 *
 * Called by cron/health-check.ts every 5 minutes.
 */

import {
  ListServicesCommand,
  DescribeServicesCommand,
  ListTasksCommand,
  DescribeTasksCommand,
  type Service,
} from '@aws-sdk/client-ecs';
import { ecsClient } from '../services/aws.js';
import { config } from '../config.js';
import { notifyHealthAlert } from '../services/slack.js';
import { logger } from '../utils/logger.js';
import { SERVICE_PREFIX, DEGRADED_ALERT_THRESHOLD_MS } from '../utils/constants.js';

// In-memory map tracking when each service first became degraded.
// Resets to undefined when the service recovers.
const degradedSince: Map<string, number> = new Map();

export interface MonitorSummary {
  total: number;
  healthy: number;
  degraded: number;
}

export async function monitorSkill(): Promise<MonitorSummary> {
  const { ecsClusterName } = config();

  logger.info({ action: 'monitor:start', cluster: ecsClusterName }, 'Running health check');

  // List all services in the cluster with our prefix
  const serviceArns = await listVibecodeServices(ecsClusterName);

  if (serviceArns.length === 0) {
    logger.info({ action: 'monitor:no_services' }, 'No services to monitor');
    return { total: 0, healthy: 0, degraded: 0 };
  }

  // Describe in batches of 10 (ECS API limit)
  const services = await describeServicesInBatches(ecsClusterName, serviceArns);

  let healthy = 0;
  let degraded = 0;

  for (const svc of services) {
    const svcName = svc.serviceName ?? 'unknown';
    const desired = svc.desiredCount ?? 0;
    const running = svc.runningCount ?? 0;

    if (desired === 0) {
      // Intentionally scaled down — not degraded
      degradedSince.delete(svcName);
      continue;
    }

    if (running >= desired) {
      healthy++;
      degradedSince.delete(svcName);
      continue;
    }

    // Service is degraded
    degraded++;
    const now = Date.now();
    if (!degradedSince.has(svcName)) {
      degradedSince.set(svcName, now);
    }

    const degradedMs = now - degradedSince.get(svcName)!;
    if (degradedMs >= DEGRADED_ALERT_THRESHOLD_MS) {
      const repo = svcName.replace(SERVICE_PREFIX, '');
      const stopReason = await getLatestStopReason(ecsClusterName, svcName);
      logger.warn({ action: 'monitor:alert', svcName, running, desired, stopReason }, 'Alerting Slack for degraded service');
      await notifyHealthAlert({ repo, running, desired, reason: stopReason });
    }
  }

  logger.info(
    { action: 'monitor:done', total: services.length, healthy, degraded },
    `Health check complete: ${healthy} healthy, ${degraded} degraded`,
  );

  return { total: services.length, healthy, degraded };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function listVibecodeServices(cluster: string): Promise<string[]> {
  const arns: string[] = [];
  let nextToken: string | undefined;

  do {
    const result = await ecsClient().send(
      new ListServicesCommand({ cluster, nextToken, maxResults: 100 }),
    );
    for (const arn of result.serviceArns ?? []) {
      // Filter by naming convention (cheap, no extra API call)
      if (arn.includes(SERVICE_PREFIX)) arns.push(arn);
    }
    nextToken = result.nextToken;
  } while (nextToken);

  return arns;
}

async function describeServicesInBatches(cluster: string, arns: string[]): Promise<Service[]> {
  const results: Service[] = [];
  for (let i = 0; i < arns.length; i += 10) {
    const batch = arns.slice(i, i + 10);
    const result = await ecsClient().send(
      new DescribeServicesCommand({ cluster, services: batch }),
    );
    results.push(...(result.services ?? []));
  }
  return results;
}

async function getLatestStopReason(cluster: string, serviceName: string): Promise<string | undefined> {
  try {
    const listResult = await ecsClient().send(
      new ListTasksCommand({ cluster, serviceName, desiredStatus: 'STOPPED', maxResults: 1 }),
    );
    const taskArns = listResult.taskArns ?? [];
    if (taskArns.length === 0) return undefined;

    const descResult = await ecsClient().send(
      new DescribeTasksCommand({ cluster, tasks: taskArns }),
    );
    const task = descResult.tasks?.[0];
    if (!task) return undefined;

    // Prefer the container-level stopped reason (more specific)
    for (const container of task.containers ?? []) {
      if (container.reason) return container.reason;
    }
    return task.stoppedReason;
  } catch {
    return undefined;
  }
}
