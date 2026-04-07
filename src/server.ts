/**
 * server.ts
 *
 * Fastify app factory — registers all routes.
 * Separated from index.ts so it can be imported in tests without starting the server.
 */

import Fastify from 'fastify';
import { logger } from './utils/logger.js';
import { healthRoutes } from './routes/health.js';
import { deployRoutes } from './routes/deploy.js';
import { teardownRoutes } from './routes/teardown.js';
import { statusRoutes } from './routes/status.js';
import { listRoutes } from './routes/list.js';

export async function buildServer() {
  const app = Fastify({
    loggerInstance: logger,
    // Validate Content-Type on routes that have body schemas
    ajv: {
      customOptions: {
        removeAdditional: true,
        coerceTypes: false,
        allErrors: false,
      },
    },
  });

  // ── Content-type parser ─────────────────────────────────────────────────────
  // Fastify requires explicit content type parsers for production use.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    try {
      done(null, JSON.parse(body as string));
    } catch (err) {
      done(err as Error, undefined);
    }
  });

  // ── Routes ──────────────────────────────────────────────────────────────────
  await app.register(healthRoutes);
  await app.register(deployRoutes);
  await app.register(teardownRoutes);
  await app.register(statusRoutes);
  await app.register(listRoutes);

  // ── 404 handler ─────────────────────────────────────────────────────────────
  app.setNotFoundHandler((_req, reply) => {
    return reply.status(404).send({ error: 'Not found' });
  });

  // ── Error handler ────────────────────────────────────────────────────────────
  app.setErrorHandler((err: Error & { statusCode?: number }, req, reply) => {
    logger.error({ action: 'server:error', url: req.url, err }, 'Unhandled error');

    const statusCode = err.statusCode ?? 500;
    return reply.status(statusCode).send({
      error: err.message ?? 'Internal server error',
    });
  });

  return app;
}
