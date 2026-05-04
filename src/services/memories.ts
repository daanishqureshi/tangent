/**
 * Memory generation and retrieval on top of the durable conversation log.
 */

import { summarizeMemories, type MemoryCandidate } from './ai.js';
import { adminPool, pgConfigured, queryPool } from './postgres.js';
import { appTable } from './db-migrations.js';
import { logger } from '../utils/logger.js';

export interface MemoryRow {
  id: number;
  kind: string;
  subject_type: string;
  subject_id: string;
  content: string;
  confidence: number;
  importance: number;
  status: string;
  metadata: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

export async function runDailyMemorySummarization(now = new Date()): Promise<{ created: number; skipped: boolean }> {
  if (!pgConfigured()) return { created: 0, skipped: true };

  const windowEnd = now;
  const windowStart = new Date(windowEnd.getTime() - 24 * 60 * 60 * 1000);
  const runId = await startMemoryRun(windowStart, windowEnd);

  try {
    const messages = await loadMessagesForMemory(windowStart, windowEnd);
    if (messages.length === 0) {
      await finishMemoryRun(runId, 'skipped', 0);
      return { created: 0, skipped: true };
    }

    const existingMemories = await listActiveMemories(300);
    const candidates = await summarizeMemories({
      windowStart: windowStart.toISOString(),
      windowEnd: windowEnd.toISOString(),
      messages: messages.map((m) => ({
        id: m.id,
        role: m.role,
        slackUserId: m.slack_user_id,
        text: m.text,
        createdAt: m.created_at.toISOString(),
      })),
      existingMemories,
    });

    let created = 0;
    for (const candidate of candidates) {
      const inserted = await insertMemoryCandidate(candidate);
      if (inserted) created++;
    }

    await finishMemoryRun(runId, 'completed', created, { candidates: candidates.length });
    logger.info({ action: 'memory:daily_complete', created, candidates: candidates.length }, 'Daily memory summarization complete');
    return { created, skipped: false };
  } catch (err) {
    await finishMemoryRun(runId, 'failed', 0, undefined, err instanceof Error ? err.message : String(err));
    logger.warn({ action: 'memory:daily_failed', err }, 'Daily memory summarization failed');
    return { created: 0, skipped: false };
  }
}

export async function listRelevantMemories(opts: {
  userId?: string;
  text?: string;
  limit?: number;
}): Promise<MemoryRow[]> {
  if (!pgConfigured()) return [];

  const terms = extractSearchTerms(opts.text ?? '');
  const subjectIds = [
    ...(opts.userId ? [opts.userId] : []),
    ...terms,
    'global',
  ];

  const r = await queryPool().query<MemoryRow>(
    `SELECT *
     FROM ${appTable('memories')}
     WHERE status = 'active'
       AND (subject_id = ANY($1::text[])
            OR subject_type = 'global'
            OR ($2 <> '' AND to_tsvector('english', content) @@ plainto_tsquery('english', $2)))
       AND (expires_at IS NULL OR expires_at > now())
     ORDER BY importance DESC, updated_at DESC
     LIMIT $3`,
    [subjectIds, terms.join(' '), opts.limit ?? 20],
  );
  return r.rows;
}

export async function listActiveMemories(limit = 100): Promise<MemoryRow[]> {
  if (!pgConfigured()) return [];
  const r = await queryPool().query<MemoryRow>(
    `SELECT *
     FROM ${appTable('memories')}
     WHERE status = 'active'
     ORDER BY importance DESC, updated_at DESC
     LIMIT $1`,
    [limit],
  );
  return r.rows;
}

export async function getRecentMemoryRuns(limit = 25): Promise<Array<Record<string, unknown>>> {
  if (!pgConfigured()) return [];
  const r = await queryPool().query(
    `SELECT id, status, started_at, completed_at, window_start, window_end, memories_created, error
     FROM ${appTable('memory_runs')}
     ORDER BY started_at DESC
     LIMIT $1`,
    [limit],
  );
  return r.rows;
}

async function startMemoryRun(windowStart: Date, windowEnd: Date): Promise<number> {
  const r = await adminPool().query<{ id: number }>(
    `INSERT INTO ${appTable('memory_runs')} (status, window_start, window_end)
     VALUES ('running', $1, $2)
     RETURNING id`,
    [windowStart, windowEnd],
  );
  return r.rows[0]!.id;
}

async function finishMemoryRun(
  id: number,
  status: 'completed' | 'failed' | 'skipped',
  created: number,
  metadata: Record<string, unknown> = {},
  error?: string,
): Promise<void> {
  await adminPool().query(
    `UPDATE ${appTable('memory_runs')}
     SET status = $2, completed_at = now(), memories_created = $3, metadata = metadata || $4::jsonb, error = $5
     WHERE id = $1`,
    [id, status, created, JSON.stringify(metadata), error ?? null],
  );
}

async function loadMessagesForMemory(windowStart: Date, windowEnd: Date): Promise<Array<{
  id: number;
  role: string;
  slack_user_id: string | null;
  text: string;
  created_at: Date;
}>> {
  const r = await queryPool().query<{
    id: number;
    role: string;
    slack_user_id: string | null;
    text: string;
    created_at: Date;
  }>(
    `SELECT id, role, slack_user_id, text, created_at
     FROM ${appTable('conversation_messages')}
     WHERE created_at >= $1 AND created_at < $2
     ORDER BY created_at ASC
     LIMIT 1000`,
    [windowStart, windowEnd],
  );
  return r.rows;
}

async function insertMemoryCandidate(candidate: MemoryCandidate): Promise<boolean> {
  const r = await adminPool().query<{ id: number; inserted: boolean }>(
    `INSERT INTO ${appTable('memories')}
       (kind, subject_type, subject_id, content, confidence, importance, source, expires_at, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, 'daily_cron', $7, $8::jsonb)
     ON CONFLICT (kind, subject_type, subject_id, content) DO UPDATE SET
       confidence = GREATEST(${appTable('memories')}.confidence, EXCLUDED.confidence),
       importance = GREATEST(${appTable('memories')}.importance, EXCLUDED.importance),
       updated_at = now()
     RETURNING id, xmax = 0 AS inserted`,
    [
      candidate.kind,
      candidate.subject_type,
      candidate.subject_id,
      candidate.content,
      candidate.confidence,
      candidate.importance,
      candidate.expires_at ?? null,
      JSON.stringify({ generatedAt: new Date().toISOString() }),
    ],
  );
  const memoryId = r.rows[0]!.id;
  for (const sourceId of candidate.source_message_ids) {
    await adminPool().query(
      `INSERT INTO ${appTable('memory_sources')} (memory_id, conversation_message_id)
       VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [memoryId, sourceId],
    );
  }
  return r.rows[0]!.inserted;
}

function extractSearchTerms(text: string): string[] {
  return Array.from(new Set(
    text
      .toLowerCase()
      .match(/[a-z0-9][a-z0-9-]{2,}/g) ?? [],
  )).slice(0, 20);
}
