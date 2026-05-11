/**
 * DB-backed application state helpers with file/runtime fallback at callers.
 */

import { config } from '../config.js';
import { adminPool, pgConfigured, queryPool } from './postgres.js';
import { appTable } from './db-migrations.js';
import { logger } from '../utils/logger.js';

export interface PersonNote {
  id: string;
  name: string;
  notes: string[];
}

export async function loadAllowedUsersFromDb(): Promise<string[]> {
  if (!pgConfigured()) return [];
  try {
    const r = await queryPool().query<{ slack_user_id: string }>(
      `SELECT slack_user_id FROM ${appTable('allowed_users')} ORDER BY slack_user_id`,
    );
    return r.rows.map((row) => row.slack_user_id);
  } catch (err) {
    logger.warn({ action: 'state:allowed_users_load_failed', err }, 'Failed to load allowed users from DB');
    return [];
  }
}

export async function isAllowedUserInDb(userId: string): Promise<boolean | null> {
  if (!pgConfigured()) return null;
  try {
    const r = await queryPool().query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM ${appTable('allowed_users')}
         WHERE slack_user_id = $1
       ) AS exists`,
      [userId],
    );
    return r.rows[0]?.exists ?? false;
  } catch (err) {
    logger.warn({ action: 'state:allowed_user_check_failed', userId, err }, 'Failed to check allowed user in DB');
    return null;
  }
}

export async function addAllowedUserToDb(userId: string, displayName?: string, source = 'runtime'): Promise<void> {
  if (!pgConfigured()) return;
  await adminPool().query(
    `INSERT INTO ${appTable('allowed_users')} (slack_user_id, display_name, source)
     VALUES ($1, $2, $3)
     ON CONFLICT (slack_user_id) DO UPDATE SET
       display_name = COALESCE(EXCLUDED.display_name, ${appTable('allowed_users')}.display_name),
       source = EXCLUDED.source,
       updated_at = now()`,
    [userId, displayName ?? null, source],
  );
}

export async function seedAllowedUsersToDb(userIds: Iterable<string>, source = 'bootstrap'): Promise<number> {
  if (!pgConfigured()) return 0;
  let count = 0;
  for (const userId of userIds) {
    await addAllowedUserToDb(userId, undefined, source);
    count++;
  }
  return count;
}

export function addAllowedUserToDbLater(userId: string, displayName?: string, source = 'runtime'): void {
  void addAllowedUserToDb(userId, displayName, source).catch((err) => {
    logger.warn({ action: 'state:allowed_user_write_failed', userId, err }, 'Failed to persist allowed user to DB');
  });
}

export async function loadPeopleNotesFromDb(): Promise<PersonNote[]> {
  if (!pgConfigured()) return [];
  try {
    const r = await queryPool().query<{
      subject_id: string;
      display_name: string | null;
      content: string;
    }>(
      `SELECT subject_id,
              metadata->>'name' AS display_name,
              content
       FROM ${appTable('memories')}
       WHERE subject_type = 'user'
         AND kind = 'person_fact'
         AND status = 'active'
       ORDER BY subject_id, created_at`,
    );

    const byUser = new Map<string, PersonNote>();
    for (const row of r.rows) {
      const existing = byUser.get(row.subject_id) ?? {
        id: row.subject_id,
        name: row.display_name ?? row.subject_id,
        notes: [],
      };
      if (!existing.notes.includes(row.content)) existing.notes.push(row.content);
      byUser.set(row.subject_id, existing);
    }
    return [...byUser.values()];
  } catch (err) {
    logger.warn({ action: 'state:people_load_failed', err }, 'Failed to load people memories from DB');
    return [];
  }
}

export async function rememberPersonInDb(input: { userId: string; name: string; note: string; source?: string }): Promise<void> {
  if (!pgConfigured()) return;
  await adminPool().query(
    `INSERT INTO ${appTable('memories')}
       (kind, subject_type, subject_id, content, confidence, importance, source, metadata)
     VALUES ('person_fact', 'user', $1, $2, 0.95, 5, $3, $4::jsonb)
     ON CONFLICT (kind, subject_type, subject_id, content) DO UPDATE SET
       status = 'active',
       importance = GREATEST(${appTable('memories')}.importance, EXCLUDED.importance),
       metadata = ${appTable('memories')}.metadata || EXCLUDED.metadata,
       updated_at = now()`,
    [
      input.userId,
      input.note,
      input.source ?? 'manual',
      JSON.stringify({ name: input.name }),
    ],
  );
}

export async function hydrateRuntimeStateFromDb(): Promise<void> {
  if (!pgConfigured()) return;
  const cfg = config();
  const bootstrapAllowedUsers = [...cfg.allowedSlackUserIds];
  const seededAllowedUsers = await seedAllowedUsersToDb(bootstrapAllowedUsers, 'bootstrap');

  const [allowedUsers, peopleNotes] = await Promise.all([
    loadAllowedUsersFromDb(),
    loadPeopleNotesFromDb(),
  ]);

  cfg.allowedSlackUserIds = new Set(allowedUsers);
  if (peopleNotes.length > 0) cfg.peopleNotes = mergePeopleNotes(cfg.peopleNotes, peopleNotes);

  logger.info(
    { action: 'state:hydrate_from_db', allowedUsers: allowedUsers.length, seededAllowedUsers, peopleNotes: peopleNotes.length },
    'Hydrated runtime state from DB',
  );
}

function mergePeopleNotes(existing: PersonNote[], loaded: PersonNote[]): PersonNote[] {
  const byUser = new Map<string, PersonNote>();
  for (const person of [...existing, ...loaded]) {
    const current = byUser.get(person.id) ?? { id: person.id, name: person.name, notes: [] };
    current.name = person.name || current.name;
    for (const note of person.notes) {
      if (!current.notes.includes(note)) current.notes.push(note);
    }
    byUser.set(person.id, current);
  }
  return [...byUser.values()];
}

export async function getServiceUrl(repo: string): Promise<string | null> {
  if (!pgConfigured()) return null;
  try {
    const r = await queryPool().query<{ url: string }>(
      `SELECT url FROM ${appTable('service_urls')} WHERE repo = $1`,
      [repo],
    );
    return r.rows[0]?.url ?? null;
  } catch (err) {
    logger.warn({ action: 'state:service_url_load_failed', repo, err }, 'Failed to read service URL from DB');
    return null;
  }
}

export async function setServiceUrl(repo: string, url: string, metadata: Record<string, unknown> = {}): Promise<void> {
  if (!pgConfigured()) return;
  await adminPool().query(
    `INSERT INTO ${appTable('service_urls')} (repo, url, metadata)
     VALUES ($1, $2, $3::jsonb)
     ON CONFLICT (repo) DO UPDATE SET
       url = EXCLUDED.url,
       metadata = ${appTable('service_urls')}.metadata || EXCLUDED.metadata,
       updated_at = now()`,
    [repo, url, JSON.stringify(metadata)],
  );
}

export function setServiceUrlLater(repo: string, url: string, metadata: Record<string, unknown> = {}): void {
  void setServiceUrl(repo, url, metadata).catch((err) => {
    logger.warn({ action: 'state:service_url_write_failed', repo, err }, 'Failed to persist service URL to DB');
  });
}
