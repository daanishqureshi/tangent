/**
 * Daily memory summarization cron.
 */

import cron from 'node-cron';
import { runDailyMemorySummarization } from '../services/memories.js';
import { logger } from '../utils/logger.js';

export function startMemorySummarizeCron(): void {
  // 07:00 UTC daily, after the CVE scan window.
  cron.schedule('0 7 * * *', async () => {
    logger.info({ action: 'cron:memory:start' }, 'Starting daily memory summarization');
    const result = await runDailyMemorySummarization();
    logger.info({ action: 'cron:memory:done', ...result }, 'Daily memory summarization finished');
  });
  logger.info({ action: 'cron:memory:registered' }, 'Daily memory summarization cron registered');
}
