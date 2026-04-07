/**
 * index.ts — Tangent entry point
 *
 * Startup sequence:
 *  1. Load .env
 *  2. Fetch secrets from Secrets Manager → populate config
 *  3. Validate all required config present
 *  4. Initialize AWS, GitHub, Slack, Anthropic clients
 *  5. Ensure WORKSPACE_DIR exists
 *  6. Start Fastify on HOST:PORT
 *  7. Register cron jobs (health check every 5 min, CVE scan at 2 AM UTC)
 *  8. Log "Tangent is online"
 */

import 'dotenv/config';
import { mkdir } from 'node:fs/promises';
import { loadConfig, config } from './config.js';
import { initAwsClients } from './services/aws.js';
import { initGithubClient } from './services/github.js';
import { initSlackClient } from './services/slack.js';
import { initSlackBot, startSlackBot } from './services/slack-bot.js';
import { initAiClient } from './services/ai.js';
import { buildServer } from './server.js';
import { startHealthCheckCron } from './cron/health-check.js';
import { startCveScanCron } from './cron/cve-scan.js';
import { logger } from './utils/logger.js';

async function main(): Promise<void> {
  // 1 + 2 + 3 — Load env + fetch secrets + validate
  await loadConfig();
  const cfg = config();

  // 4 — Initialize clients
  initAwsClients();
  initGithubClient();
  initSlackClient();
  initSlackBot();
  initAiClient();

  // 5 — Ensure workspace directory exists
  await mkdir(cfg.workspaceDir, { recursive: true });
  logger.info({ action: 'startup:workspace', dir: cfg.workspaceDir }, 'Workspace directory ready');

  // 6 — Start HTTP server
  const app = await buildServer();
  await app.listen({ port: cfg.port, host: cfg.host });
  logger.info(
    { action: 'startup:listening', port: cfg.port, host: cfg.host },
    `Tangent is online — listening on ${cfg.host}:${cfg.port}`,
  );

  // 7 — Start Slack bot (Socket Mode — no public URL needed)
  await startSlackBot();

  // 8 — Start cron jobs
  startHealthCheckCron();
  startCveScanCron();

  // 9 — Banner
  logger.info(
    {
      action: 'startup:ready',
      cluster: cfg.ecsClusterName,
      ecr: cfg.ecrRepoUri,
      port: cfg.port,
    },
    `Tangent is online — listening on ${cfg.port}, monitoring ${cfg.ecsClusterName}`,
  );
}

// ─── Graceful shutdown ────────────────────────────────────────────────────────

process.on('SIGTERM', () => {
  logger.info({ action: 'shutdown:sigterm' }, 'Received SIGTERM, shutting down');
  process.exit(0);
});

process.on('SIGINT', () => {
  logger.info({ action: 'shutdown:sigint' }, 'Received SIGINT, shutting down');
  process.exit(0);
});

process.on('unhandledRejection', (reason) => {
  logger.error({ action: 'unhandled_rejection', reason }, 'Unhandled promise rejection');
  process.exit(1);
});

main().catch((err) => {
  logger.error({ action: 'startup:fatal', err }, 'Fatal startup error');
  process.exit(1);
});
