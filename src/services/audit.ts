/**
 * Durable audit log for high-risk Tangent actions.
 *
 * Writes JSONL under ./logs so EC2 operators can inspect what happened even
 * after a process restart. Keeps a small in-memory tail for the dashboard.
 */

import { appendFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { logger } from '../utils/logger.js';

export interface AuditEvent {
  ts: string;
  action: string;
  actor: string;
  surface: 'slack' | 'dashboard' | 'http' | 'cron' | 'system';
  target?: string;
  metadata?: Record<string, unknown>;
}

const AUDIT_FILE = resolve(process.cwd(), 'logs/audit.jsonl');
const recentEvents: AuditEvent[] = [];
const MAX_RECENT_EVENTS = 100;

export async function recordAuditEvent(event: Omit<AuditEvent, 'ts'>): Promise<void> {
  const full: AuditEvent = { ts: new Date().toISOString(), ...event };
  recentEvents.push(full);
  if (recentEvents.length > MAX_RECENT_EVENTS) recentEvents.shift();

  try {
    await mkdir(resolve(process.cwd(), 'logs'), { recursive: true });
    await appendFile(AUDIT_FILE, JSON.stringify(full) + '\n', 'utf8');
  } catch (err) {
    logger.warn({ action: 'audit:write_failed', err }, 'Failed to write audit event');
  }
}

export function getRecentAuditEvents(limit = 50): AuditEvent[] {
  return recentEvents.slice(-limit).reverse();
}
