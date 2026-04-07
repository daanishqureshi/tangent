/**
 * routes/status.ts — GET /status/:repo
 *
 * Returns current ECS service state + latest ngrok URL from CloudWatch.
 */

import type { FastifyInstance } from 'fastify';
import {
  DescribeServicesCommand,
  ListTaskDefinitionsCommand,
} from '@aws-sdk/client-ecs';
import { ecsClient } from '../services/aws.js';
import { config } from '../config.js';
import { tunnelSkill } from '../skills/tunnel.js';
import { logger } from '../utils/logger.js';
import { SERVICE_PREFIX, TASK_FAMILY_PREFIX } from '../utils/constants.js';

interface StatusParams {
  repo: string;
}

export async function statusRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: StatusParams }>('/status/:repo', {
    schema: {
      params: {
        type: 'object',
        required: ['repo'],
        properties: {
          repo: { type: 'string', minLength: 1, maxLength: 100, pattern: '^[a-z0-9-]+$' },
        },
      },
    },
  }, async (req, reply) => {
    const { repo } = req.params;
    const { ecsClusterName } = config();
    const serviceName = `${SERVICE_PREFIX}${repo}`;
    const taskFamily = `${TASK_FAMILY_PREFIX}${repo}`;

    logger.info({ action: 'route:status', repo }, 'Status request');

    // ── ECS service info ──────────────────────────────────────────────────────
    let serviceStatus = 'NOT_FOUND';
    let desiredCount = 0;
    let runningCount = 0;
    let createdAt: string | undefined;

    try {
      const result = await ecsClient().send(
        new DescribeServicesCommand({ cluster: ecsClusterName, services: [serviceName] }),
      );
      const svc = result.services?.[0];
      if (svc && svc.status !== 'INACTIVE') {
        serviceStatus = svc.status ?? 'UNKNOWN';
        desiredCount = svc.desiredCount ?? 0;
        runningCount = svc.runningCount ?? 0;
        createdAt = svc.createdAt?.toISOString();
      }
    } catch (err) {
      logger.warn({ action: 'route:status:ecs_error', repo, err }, 'ECS describe failed');
    }

    // ── Latest task definition ────────────────────────────────────────────────
    let latestTaskDef: string | undefined;
    try {
      const tdResult = await ecsClient().send(
        new ListTaskDefinitionsCommand({
          familyPrefix: taskFamily,
          status: 'ACTIVE',
          sort: 'DESC',
          maxResults: 1,
        }),
      );
      latestTaskDef = tdResult.taskDefinitionArns?.[0];
    } catch {
      // Non-fatal
    }

    // ── ngrok URL (fast attempt, 10s timeout) ─────────────────────────────────
    let url: string | undefined;
    if (runningCount > 0) {
      try {
        const tunnelResult = await tunnelSkill({ repo, timeoutMs: 10_000 });
        url = tunnelResult.url;
      } catch {
        // Tunnel not up or timed out — that's okay
      }
    }

    return reply.send({
      repo,
      service: serviceName,
      status: serviceStatus,
      desiredCount,
      runningCount,
      taskDefinition: latestTaskDef,
      url: url ?? null,
      createdAt: createdAt ?? null,
    });
  });
}
