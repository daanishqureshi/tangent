/**
 * routes/list.ts — GET /list
 *
 * Returns all running vibecode-* services with their status and URLs.
 */

import type { FastifyInstance } from 'fastify';
import {
  ListServicesCommand,
  DescribeServicesCommand,
  type Service,
} from '@aws-sdk/client-ecs';
import { ecsClient } from '../services/aws.js';
import { config } from '../config.js';
import { SERVICE_PREFIX } from '../utils/constants.js';
import { logger } from '../utils/logger.js';

export async function listRoutes(app: FastifyInstance): Promise<void> {
  app.get('/list', async (_req, reply) => {
    const { ecsClusterName } = config();

    logger.info({ action: 'route:list' }, 'List services request');

    // 1. List all service ARNs in the cluster
    const allArns: string[] = [];
    try {
      let nextToken: string | undefined;
      do {
        const result = await ecsClient().send(
          new ListServicesCommand({ cluster: ecsClusterName, nextToken, maxResults: 100 }),
        );
        allArns.push(...(result.serviceArns ?? []).filter((a) => a.includes(SERVICE_PREFIX)));
        nextToken = result.nextToken;
      } while (nextToken);
    } catch (err) {
      logger.warn({ action: 'route:list:ecs_error', err }, 'ECS list failed — returning empty list');
      return reply.send({ services: [] });
    }

    if (allArns.length === 0) {
      return reply.send({ services: [] });
    }

    // 2. Describe in batches of 10
    const services: Service[] = [];
    for (let i = 0; i < allArns.length; i += 10) {
      const batch = allArns.slice(i, i + 10);
      const result = await ecsClient().send(
        new DescribeServicesCommand({ cluster: ecsClusterName, services: batch }),
      );
      services.push(...(result.services ?? []));
    }

    // 3. Shape the response
    const items = services
      .filter((s) => s.status !== 'INACTIVE')
      .map((s) => {
        const name = s.serviceName ?? '';
        const repo = name.replace(SERVICE_PREFIX, '');
        return {
          repo,
          service: name,
          status: s.status ?? 'UNKNOWN',
          desiredCount: s.desiredCount ?? 0,
          runningCount: s.runningCount ?? 0,
          createdAt: s.createdAt?.toISOString() ?? null,
        };
      });

    return reply.send({ services: items });
  });
}
