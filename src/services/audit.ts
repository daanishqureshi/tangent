/**
 * Durable audit log for high-risk Tangent actions.
 *
 * Writes JSONL under ./logs so EC2 operators can inspect what happened even
 * after a process restart. Keeps a small in-memory tail for the dashboard.
 */

import { appendFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { logger } from '../utils/logger.js';
import { adminPool, pgConfigured, queryPool } from './postgres.js';
import { appTable } from './db-migrations.js';

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

  if (pgConfigured()) {
    try {
      await adminPool().query(
        `INSERT INTO ${appTable('audit_events')} (ts, action, actor, surface, target, metadata)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
        [full.ts, full.action, full.actor, full.surface, full.target ?? null, JSON.stringify(full.metadata ?? {})],
      );
    } catch (err) {
      logger.warn({ action: 'audit:db_write_failed', err }, 'Failed to write audit event to DB');
    }
  }

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

export async function getRecentAuditEventsFromDb(limit = 50): Promise<AuditEvent[]> {
  if (!pgConfigured()) return getRecentAuditEvents(limit);
  try {
    const r = await queryPool().query<{
      ts: Date;
      action: string;
      actor: string;
      surface: AuditEvent['surface'];
      target: string | null;
      metadata: Record<string, unknown>;
    }>(
      `SELECT ts, action, actor, surface, target, metadata
       FROM ${appTable('audit_events')}
       ORDER BY ts DESC
       LIMIT $1`,
      [limit],
    );
    return r.rows.map((row) => ({
      ts: row.ts.toISOString(),
      action: row.action,
      actor: row.actor,
      surface: row.surface,
      target: row.target ?? undefined,
      metadata: row.metadata,
    }));
  } catch (err) {
    logger.warn({ action: 'audit:db_read_failed', err }, 'Failed to read audit events from DB');
    return getRecentAuditEvents(limit);
  }
}
