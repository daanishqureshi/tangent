/**
 * Durable conversation logging.
 *
 * This is intentionally append/upsert-oriented rather than a "memory" system.
 * It stores Slack messages and Tangent replies in Postgres so a later retrieval
 * layer can decide what to summarize, embed, or pass back into Claude.
 */

import { adminPool, pgConfigured } from './postgres.js';
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

let schemaReady: Promise<void> | null = null;

export async function recordConversationMessage(input: ConversationMessageInput): Promise<void> {
  if (!pgConfigured()) return;

  try {
    await ensureConversationSchema();
    await adminPool().query(
      `INSERT INTO tangent_conversation_messages
        (conv_key, source, slack_channel, slack_thread_ts, slack_message_ts, slack_user_id, role, text, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
       ON CONFLICT (slack_channel, slack_message_ts)
       WHERE slack_channel IS NOT NULL AND slack_message_ts IS NOT NULL
       DO UPDATE SET
         conv_key = tangent_conversation_messages.conv_key,
         source = tangent_conversation_messages.source,
         slack_thread_ts = COALESCE(EXCLUDED.slack_thread_ts, tangent_conversation_messages.slack_thread_ts),
         slack_user_id = COALESCE(EXCLUDED.slack_user_id, tangent_conversation_messages.slack_user_id),
         role = EXCLUDED.role,
         text = EXCLUDED.text,
         metadata = tangent_conversation_messages.metadata || EXCLUDED.metadata,
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

async function ensureConversationSchema(): Promise<void> {
  schemaReady ??= createConversationSchema();
  return schemaReady;
}

async function createConversationSchema(): Promise<void> {
  await adminPool().query(`
    CREATE TABLE IF NOT EXISTS tangent_conversation_messages (
      id BIGSERIAL PRIMARY KEY,
      conv_key TEXT NOT NULL,
      source TEXT NOT NULL,
      slack_channel TEXT,
      slack_thread_ts TEXT,
      slack_message_ts TEXT,
      slack_user_id TEXT,
      role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system', 'tool')),
      text TEXT NOT NULL,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await adminPool().query(`
    CREATE UNIQUE INDEX IF NOT EXISTS tangent_conversation_messages_slack_msg_idx
      ON tangent_conversation_messages (slack_channel, slack_message_ts)
      WHERE slack_channel IS NOT NULL AND slack_message_ts IS NOT NULL;
  `);
  await adminPool().query(`
    CREATE INDEX IF NOT EXISTS tangent_conversation_messages_conv_idx
      ON tangent_conversation_messages (conv_key, created_at);
  `);
  await adminPool().query(`
    CREATE INDEX IF NOT EXISTS tangent_conversation_messages_user_idx
      ON tangent_conversation_messages (slack_user_id, created_at);
  `);
  await adminPool().query(`
    GRANT SELECT ON tangent_conversation_messages TO tangent_query;
  `);
}
