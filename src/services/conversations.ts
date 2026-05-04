/**
 * Durable conversation logging.
 *
 * This is intentionally append/upsert-oriented rather than a "memory" system.
 * It stores Slack messages and Tangent replies in Postgres so a later retrieval
 * layer can decide what to summarize, embed, or pass back into Claude.
 */

import { adminPool, pgConfigured, queryPool } from './postgres.js';
import { appTable } from './db-migrations.js';
import { logger } from '../utils/logger.js';

export type ConversationRole = 'user' | 'assistant' | 'system' | 'tool';
export type ConversationSource = 'slack_dm' | 'slack_thread' | 'slack_channel' | 'dashboard' | 'http';

export interface ConversationMessageInput {
  convKey: string;
  source: ConversationSource;
  channel?: string;
  threadTs?: string;
  messageTs?: string;
  userId?: string;
  role: ConversationRole;
  text: string;
  metadata?: Record<string, unknown>;
}

export interface ConversationMessageRow {
  id: number;
  conv_key: string;
  source: string;
  slack_channel: string | null;
  slack_thread_ts: string | null;
  slack_message_ts: string | null;
  slack_user_id: string | null;
  role: ConversationRole;
  text: string;
  metadata: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

export interface ToolEventInput {
  convKey: string;
  toolName: string;
  phase: 'requested' | 'started' | 'completed' | 'failed';
  input?: Record<string, unknown>;
  result?: string;
  error?: string;
  metadata?: Record<string, unknown>;
}

export async function recordConversationMessage(input: ConversationMessageInput): Promise<void> {
  if (!pgConfigured()) return;

  try {
    await adminPool().query(
      `INSERT INTO ${appTable('conversation_messages')}
        (conv_key, source, slack_channel, slack_thread_ts, slack_message_ts, slack_user_id, role, text, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
       ON CONFLICT (slack_channel, slack_message_ts)
       WHERE slack_channel IS NOT NULL AND slack_message_ts IS NOT NULL
       DO UPDATE SET
         conv_key = ${appTable('conversation_messages')}.conv_key,
         source = ${appTable('conversation_messages')}.source,
         slack_thread_ts = COALESCE(EXCLUDED.slack_thread_ts, ${appTable('conversation_messages')}.slack_thread_ts),
         slack_user_id = COALESCE(EXCLUDED.slack_user_id, ${appTable('conversation_messages')}.slack_user_id),
         role = EXCLUDED.role,
         text = EXCLUDED.text,
         metadata = ${appTable('conversation_messages')}.metadata || EXCLUDED.metadata,
         updated_at = now()`,
      [
        input.convKey,
        input.source,
        input.channel ?? null,
        input.threadTs ?? null,
        input.messageTs ?? null,
        input.userId ?? null,
        input.role,
        input.text,
        JSON.stringify(input.metadata ?? {}),
      ],
    );
  } catch (err) {
    logger.warn(
      { action: 'conversation:record_failed', convKey: input.convKey, role: input.role, err },
      'Failed to persist conversation message',
    );
  }
}

export function recordConversationMessageLater(input: ConversationMessageInput): void {
  void recordConversationMessage(input);
}

export async function recordToolEvent(input: ToolEventInput): Promise<void> {
  if (!pgConfigured()) return;

  try {
    await adminPool().query(
      `INSERT INTO ${appTable('tool_events')}
        (conv_key, tool_name, phase, input, result, error, metadata)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7::jsonb)`,
      [
        input.convKey,
        input.toolName,
        input.phase,
        JSON.stringify(input.input ?? {}),
        input.result ?? null,
        input.error ?? null,
        JSON.stringify(input.metadata ?? {}),
      ],
    );
  } catch (err) {
    logger.warn(
      { action: 'conversation:tool_event_failed', convKey: input.convKey, tool: input.toolName, err },
      'Failed to persist tool event',
    );
  }
}

export function recordToolEventLater(input: ToolEventInput): void {
  void recordToolEvent(input);
}

export async function getRecentMessagesByConversation(convKey: string, limit = 50): Promise<ConversationMessageRow[]> {
  if (!pgConfigured()) return [];
  const r = await queryPool().query<ConversationMessageRow>(
    `SELECT * FROM ${appTable('conversation_messages')}
     WHERE conv_key = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [convKey, limit],
  );
  return r.rows.reverse();
}

export async function getMessagesBySlackUser(userId: string, limit = 100): Promise<ConversationMessageRow[]> {
  if (!pgConfigured()) return [];
  const r = await queryPool().query<ConversationMessageRow>(
    `SELECT * FROM ${appTable('conversation_messages')}
     WHERE slack_user_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [userId, limit],
  );
  return r.rows;
}

export async function getMessagesSince(since: Date, limit = 500): Promise<ConversationMessageRow[]> {
  if (!pgConfigured()) return [];
  const r = await queryPool().query<ConversationMessageRow>(
    `SELECT * FROM ${appTable('conversation_messages')}
     WHERE created_at >= $1
     ORDER BY created_at ASC
     LIMIT $2`,
    [since, limit],
  );
  return r.rows;
}

export async function getOpenLoopMessages(limit = 100): Promise<ConversationMessageRow[]> {
  if (!pgConfigured()) return [];
  const r = await queryPool().query<ConversationMessageRow>(
    `SELECT * FROM ${appTable('conversation_messages')}
     WHERE role = 'user'
       AND (
         text ILIKE '%todo%'
         OR text ILIKE '%follow up%'
         OR text ILIKE '%later%'
         OR text ILIKE '%remind%'
         OR text ILIKE '%need to%'
       )
     ORDER BY created_at DESC
     LIMIT $1`,
    [limit],
  );
  return r.rows;
}
