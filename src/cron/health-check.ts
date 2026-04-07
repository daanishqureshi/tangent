/**
 * cron/health-check.ts
 *
 * Runs every 5 minutes. Checks ECS service health for all vibecode-* services
 * and alerts Slack if any have been degraded for more than 10 minutes.
 */

import cron from 'node-cron';
import { monitorSkill } from '../skills/monitor.js';
import { logger } from '../utils/logger.js';

export function startHealthCheckCron(): void {
  // Every 5 minutes
  cron.schedule('*/5 * * * *', async () => {
    logger.info({ action: 'cron:health_check:run' }, 'Running scheduled health check');
    try {
      const summary = await monitorSkill();
      logger.info({ action: 'cron:health_check:done', ...summary }, 'Health check complete');
    } catch (err) {
      logger.error({ action: 'cron:health_check:error', err }, 'Health check cron failed');
    }
  });

  logger.info({ action: 'cron:health_check:registered', schedule: '*/5 * * * *' }, 'Health check cron registered');
}
