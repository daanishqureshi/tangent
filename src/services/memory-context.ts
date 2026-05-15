import { config } from '../config.js';
import { appTable } from './db-migrations.js';
import { pgConfigured, queryPool } from './postgres.js';
import { logger } from '../utils/logger.js';

export async function buildMemoryContextForPrompt(message?: string): Promise<string> {
  const runtimePeopleNotes = buildRuntimePeopleNotesContext();

  try {
    if (!pgConfigured()) return runtimePeopleNotes;
    const userId = extractSlackUserId(message ?? '');
    const memories = await queryRelevantMemories(userId, message ?? '');
    if (memories.length === 0) return runtimePeopleNotes;

    const lines = memories.map((m) =>
      `- [memory:${m.id}] (${m.kind}/${m.subject_type}:${m.subject_id}, importance ${m.importance}) ${m.content}`,
    );
    return [
      '\n\n*Relevant memories from Tangent DB:*',
      '*Use these as long-term context. They are curated from prior conversations and linked to source messages in Postgres.*',
      ...lines,
    ].join('\n');
  } catch (err) {
    logger.warn({ action: 'memory_context:failed', err }, 'Failed to build memory context; using runtime DB-hydrated notes');
    return runtimePeopleNotes;
  }
}

function buildRuntimePeopleNotesContext(): string {
  const { peopleNotes } = config();
  if (peopleNotes.length === 0) return '';

  return '\n\n*Memories — what you know about specific people:*\n' +
    '*This section is runtime long-term memory hydrated from Tangent DB.*\n' +
    peopleNotes.map((p) =>
      `\n*${p.name}* (${p.id}):\n` + p.notes.map((n) => `  - ${n}`).join('\n')
    ).join('\n');
}

function extractSlackUserId(text: string): string | undefined {
  const match = /\[Slack User: <@([A-Z0-9]+)> \| ID: ([A-Z0-9]+)\]/.exec(text);
  return match?.[2] ?? match?.[1];
}

async function queryRelevantMemories(userId: string | undefined, text: string): Promise<Array<{
  id: number;
  kind: string;
  subject_type: string;
  subject_id: string;
  content: string;
  importance: number;
}>> {
  const terms = Array.from(new Set(text.toLowerCase().match(/[a-z0-9][a-z0-9-]{2,}/g) ?? [])).slice(0, 20);
  const subjectIds = [...(userId ? [userId] : []), ...terms, 'global'];
  const r = await queryPool().query<{
    id: number;
    kind: string;
    subject_type: string;
    subject_id: string;
    content: string;
    importance: number;
  }>(
    `SELECT id, kind, subject_type, subject_id, content, importance
     FROM ${appTable('memories')}
     WHERE status = 'active'
       AND (subject_id = ANY($1::text[])
            OR subject_type = 'global'
            OR ($2 <> '' AND to_tsvector('english', content) @@ plainto_tsquery('english', $2)))
       AND (expires_at IS NULL OR expires_at > now())
     ORDER BY importance DESC, updated_at DESC
     LIMIT 20`,
    [subjectIds, terms.join(' ')],
  );
  return r.rows;
}
