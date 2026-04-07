/**
 * routes/deploy.ts — POST /deploy
 *
 * Triggers the full deploy pipeline:
 *   build → deploy → (async) tunnel → slack notify
 *
 * Returns immediately with { status: "deploying", url: "pending" }.
 * Posts the final URL to Slack when the tunnel comes up.
 */

import type { FastifyInstance } from 'fastify';
import { buildSkill, DockerfileNotFoundError, DockerBuildError } from '../skills/build.js';
import { deploySkill } from '../skills/deploy.js';
import { tunnelSkill, TunnelTimeoutError } from '../skills/tunnel.js';
import { notifyDeployed, notifyDeployUrl, notifyDeployError } from '../services/slack.js';
import { logger } from '../utils/logger.js';

interface DeployBody {
  repo: string;
  branch?: string;
  port?: number;
}

export async function deployRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: DeployBody }>('/deploy', {
    schema: {
      body: {
        type: 'object',
        required: ['repo'],
        properties: {
          repo: { type: 'string', minLength: 1, maxLength: 100, pattern: '^[a-z0-9-]+$' },
          branch: { type: 'string', default: 'main' },
          port: { type: 'integer', minimum: 1, maximum: 65535, default: 8080 },
        },
      },
    },
  }, async (req, reply) => {
    const { repo, branch = 'main', port = 8080 } = req.body;

    logger.info({ action: 'route:deploy:start', repo, branch, port }, 'Deploy request received');

    // ── Step 1: Build ─────────────────────────────────────────────────────────
    let imageUri: string;
    let sha: string;

    try {
      const buildResult = await buildSkill({ repo, branch });
      imageUri = buildResult.imageUri;
      sha = buildResult.sha;
    } catch (err) {
      if (err instanceof DockerfileNotFoundError) {
        logger.warn({ action: 'route:deploy:no_dockerfile', repo }, err.message);
        await notifyDeployError(repo, err.message);
        return reply.status(422).send({ error: err.message });
      }

      if (err instanceof DockerBuildError) {
        logger.error({ action: 'route:deploy:build_failed', repo, summary: err.summary }, 'Docker build failed');
        await notifyDeployError(repo, err.summary, err.raw);
        return reply.status(500).send({ error: 'Build failed', summary: err.summary });
      }

      const message = err instanceof Error ? err.message : String(err);
      logger.error({ action: 'route:deploy:unknown_error', repo, err }, 'Unexpected build error');
      await notifyDeployError(repo, message);
      return reply.status(500).send({ error: 'Build failed', detail: message });
    }

    // ── Step 2: Deploy ────────────────────────────────────────────────────────
    let serviceName: string;
    let taskDefinition: string;

    try {
      const deployResult = await deploySkill({ repo, imageUri, port });
      serviceName = deployResult.serviceName;
      taskDefinition = deployResult.taskDefinition;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ action: 'route:deploy:ecs_failed', repo, err }, 'ECS deploy failed');
      await notifyDeployError(repo, `ECS deploy failed: ${message}`);
      return reply.status(500).send({ error: 'ECS deploy failed', detail: message });
    }

    // ── Step 3: Return immediately, fetch tunnel URL asynchronously ───────────
    const imageTag = imageUri.split(':').pop() ?? sha;

    // Fire-and-forget tunnel polling + Slack notification
    void backgroundTunnelAndNotify({ repo, imageTag, imageUri, serviceName });

    logger.info({ action: 'route:deploy:accepted', repo, serviceName }, 'Deploy accepted, tunnel URL pending');

    return reply.status(202).send({
      status: 'deploying',
      repo,
      url: 'pending',
      imageUri,
      service: serviceName,
    });
  });
}

// ─── Background work ──────────────────────────────────────────────────────────

async function backgroundTunnelAndNotify(params: {
  repo: string;
  imageTag: string;
  imageUri: string;
  serviceName: string;
}): Promise<void> {
  const { repo, imageTag, imageUri, serviceName } = params;

  try {
    const { url } = await tunnelSkill({ repo });

    await notifyDeployed({ repo, url, imageTag });
    logger.info({ action: 'route:deploy:tunnel_ready', repo, url }, 'Tunnel URL notified to Slack');
  } catch (err) {
    if (err instanceof TunnelTimeoutError) {
      logger.warn({ action: 'route:deploy:tunnel_timeout', repo }, err.message);
      await notifyDeployError(
        repo,
        `Service deployed but ngrok tunnel URL was not available within the timeout. ` +
          `Check CloudWatch Logs for the ${repo}-ngrok stream.`,
      );
    } else {
      logger.error({ action: 'route:deploy:tunnel_error', repo, err }, 'Tunnel fetch failed');
      await notifyDeployError(repo, `Tunnel URL fetch failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
