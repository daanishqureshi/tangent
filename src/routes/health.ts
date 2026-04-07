/**
 * routes/health.ts — GET /health
 */

import type { FastifyInstance } from 'fastify';
import {
  ListServicesCommand,
} from '@aws-sdk/client-ecs';
import { ecsClient } from '../services/aws.js';
import { config } from '../config.js';

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/health', async (_req, reply) => {
    const { ecsClusterName } = config();

    // Count running vibecode services as a lightweight liveness check
    let serviceCount = 0;
    try {
      const result = await ecsClient().send(
        new ListServicesCommand({ cluster: ecsClusterName, maxResults: 100 }),
      );
      serviceCount = (result.serviceArns ?? []).filter((arn) =>
        arn.includes('vibecode-'),
      ).length;
    } catch {
      // Non-fatal — still return healthy
    }

    return reply.send({
      status: 'ok',
      uptime: Math.floor(process.uptime()),
      services: serviceCount,
    });
  });
}
