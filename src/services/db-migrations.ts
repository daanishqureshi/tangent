/**
 * Explicit Postgres schema setup for Tangent application state.
 *
 * Migrations are intentionally idempotent and run at startup when Postgres is
 * configured. Runtime services should assume these tables exist instead of
 * hiding CREATE TABLE statements in individual write paths.
 */

import { adminPool, pgConfigured } from './postgres.js';
import { logger } from '../utils/logger.js';

export const APP_SCHEMA = 'tangent_app';

let migrationsReady: Promise<void> | null = null;

export function appTable(table: string): string {
  return `${APP_SCHEMA}.${table}`;
}

export async function runAppMigrations(): Promise<void> {
  if (!pgConfigured()) {
    logger.info({ action: 'db:migrations:skip' }, 'Postgres not configured; skipping app migrations');
    return;
  }
  migrationsReady ??= runMigrationsOnce();
  return migrationsReady;
}

async function runMigrationsOnce(): Promise<void> {
  const pool = adminPool();
  logger.info({ action: 'db:migrations:start' }, 'Running Tangent app migrations');

  await pool.query(`CREATE SCHEMA IF NOT EXISTS ${APP_SCHEMA}`);
  await pool.query(`CREATE EXTENSION IF NOT EXISTS vector`).catch((err) => {
    logger.warn({ action: 'db:migrations:vector_extension_skipped', err }, 'Could not enable pgvector extension; continuing without embeddings');
  });

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${appTable('conversation_messages')} (
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

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS conversation_messages_slack_msg_idx
      ON ${appTable('conversation_messages')} (slack_channel, slack_message_ts)
      WHERE slack_channel IS NOT NULL AND slack_message_ts IS NOT NULL;
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS conversation_messages_conv_idx ON ${appTable('conversation_messages')} (conv_key, created_at)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS conversation_messages_user_idx ON ${appTable('conversation_messages')} (slack_user_id, created_at)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS conversation_messages_text_idx ON ${appTable('conversation_messages')} USING GIN (to_tsvector('english', text))`);

  // Best-effort migration from the initial prototype table.
  await pool.query(`
    DO $$
    BEGIN
      IF to_regclass('${APP_SCHEMA}.tangent_conversation_messages') IS NOT NULL THEN
        EXECUTE 'INSERT INTO ${appTable('conversation_messages')}
          (id, conv_key, source, slack_channel, slack_thread_ts, slack_message_ts, slack_user_id, role, text, metadata, created_at, updated_at)
          SELECT id, conv_key, source, slack_channel, slack_thread_ts, slack_message_ts, slack_user_id, role, text, metadata, created_at, updated_at
          FROM ${APP_SCHEMA}.tangent_conversation_messages
          ON CONFLICT DO NOTHING';
        PERFORM setval(pg_get_serial_sequence('${appTable('conversation_messages')}', 'id'), COALESCE((SELECT MAX(id) FROM ${appTable('conversation_messages')}), 1), true);
      END IF;
    END $$;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${appTable('tool_events')} (
      id BIGSERIAL PRIMARY KEY,
      conv_key TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      phase TEXT NOT NULL CHECK (phase IN ('requested', 'started', 'completed', 'failed')),
      input JSONB NOT NULL DEFAULT '{}'::jsonb,
      result TEXT,
      error TEXT,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS tool_events_conv_idx ON ${appTable('tool_events')} (conv_key, created_at)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS tool_events_tool_idx ON ${appTable('tool_events')} (tool_name, created_at)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${appTable('audit_events')} (
      id BIGSERIAL PRIMARY KEY,
      ts TIMESTAMPTZ NOT NULL DEFAULT now(),
      action TEXT NOT NULL,
      actor TEXT NOT NULL,
      surface TEXT NOT NULL,
      target TEXT,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS audit_events_ts_idx ON ${appTable('audit_events')} (ts DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS audit_events_actor_idx ON ${appTable('audit_events')} (actor, ts DESC)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${appTable('app_state')} (
      key TEXT PRIMARY KEY,
      value JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${appTable('allowed_users')} (
      slack_user_id TEXT PRIMARY KEY,
      display_name TEXT,
      source TEXT NOT NULL DEFAULT 'runtime',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${appTable('service_urls')} (
      repo TEXT PRIMARY KEY,
      url TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'ngrok',
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${appTable('memory_runs')} (
      id BIGSERIAL PRIMARY KEY,
      status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'skipped')),
      started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      completed_at TIMESTAMPTZ,
      window_start TIMESTAMPTZ NOT NULL,
      window_end TIMESTAMPTZ NOT NULL,
      memories_created INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${appTable('memories')} (
      id BIGSERIAL PRIMARY KEY,
      kind TEXT NOT NULL,
      subject_type TEXT NOT NULL,
      subject_id TEXT NOT NULL,
      content TEXT NOT NULL,
      confidence REAL NOT NULL DEFAULT 0.7,
      importance INTEGER NOT NULL DEFAULT 3,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
      source TEXT NOT NULL DEFAULT 'generated',
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      expires_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (kind, subject_type, subject_id, content)
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS memories_subject_idx ON ${appTable('memories')} (subject_type, subject_id, status, importance DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS memories_kind_idx ON ${appTable('memories')} (kind, status, importance DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS memories_text_idx ON ${appTable('memories')} USING GIN (to_tsvector('english', content))`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${appTable('memory_sources')} (
      memory_id BIGINT NOT NULL REFERENCES ${appTable('memories')}(id) ON DELETE CASCADE,
      conversation_message_id BIGINT NOT NULL REFERENCES ${appTable('conversation_messages')}(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (memory_id, conversation_message_id)
    );
  `);

  await pool.query(`GRANT USAGE ON SCHEMA ${APP_SCHEMA} TO tangent_query`);
  await pool.query(`GRANT SELECT ON ALL TABLES IN SCHEMA ${APP_SCHEMA} TO tangent_query`);
  await pool.query(`GRANT SELECT ON ALL SEQUENCES IN SCHEMA ${APP_SCHEMA} TO tangent_query`);
  await pool.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA ${APP_SCHEMA} GRANT SELECT ON TABLES TO tangent_query`);
  await pool.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA ${APP_SCHEMA} GRANT SELECT ON SEQUENCES TO tangent_query`);

  logger.info({ action: 'db:migrations:done' }, 'Tangent app migrations complete');
}
