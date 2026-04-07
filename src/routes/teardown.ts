/**
 * routes/teardown.ts — POST /teardown
 */

import type { FastifyInstance } from 'fastify';
import { teardownSkill } from '../skills/teardown.js';
import { notifyTeardown } from '../services/slack.js';
import { logger } from '../utils/logger.js';

interface TeardownBody {
  repo: string;
}

export async function teardownRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: TeardownBody }>('/teardown', {
    schema: {
      body: {
        type: 'object',
        required: ['repo'],
        properties: {
          repo: { type: 'string', minLength: 1, maxLength: 100, pattern: '^[a-z0-9-]+$' },
        },
      },
    },
  }, async (req, reply) => {
    const { repo } = req.body;

    logger.info({ action: 'route:teardown:start', repo }, 'Teardown request received');

    try {
      await teardownSkill({ repo });
      await notifyTeardown(repo);

      logger.info({ action: 'route:teardown:done', repo }, 'Teardown complete');
      return reply.send({ status: 'torn down', repo });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ action: 'route:teardown:failed', repo, err }, 'Teardown failed');
      return reply.status(500).send({ error: 'Teardown failed', detail: message });
    }
  });
}
