/**
 * postgres.ts
 *
 * Connection pools + helpers for Tangent's Postgres tools.
 *
 * Two pools are maintained:
 *   - adminPool  — connects as `tangent_admin` (CREATEROLE, CREATEDB).
 *                  Used by the Daanish-only db_create_user / db_drop_user
 *                  tools and by schema introspection (which needs to read
 *                  pg_catalog views that the readonly role can already see,
 *                  but the admin pool is a single-purpose connection so we
 *                  keep it isolated).
 *   - queryPool  — connects as `tangent_query` (read-only).
 *                  Used by db_query.  Defense in depth: even if the SQL
 *                  parser fails to block a destructive statement, the role
 *                  itself has no write privileges anywhere.
 *
 * Both pools are lazy-initialized on first use, so Tangent boots fine even
 * when the Postgres env vars are unset (the tools just refuse to run).
 */

import pg from 'pg';
import { randomBytes } from 'crypto';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

let _adminPool: pg.Pool | null = null;
let _queryPool: pg.Pool | null = null;

/**
 * True iff TANGENT_DB_ADMIN_URL and TANGENT_DB_QUERY_URL are both set.
 * Used by tool handlers to detect "Postgres not provisioned yet" cleanly.
 */
export function pgConfigured(): boolean {
  const cfg = config();
  return Boolean(cfg.pgAdminUrl) && Boolean(cfg.pgQueryUrl);
}

export function adminPool(): pg.Pool {
  if (!_adminPool) {
    const url = config().pgAdminUrl;
    if (!url) throw new Error('TANGENT_DB_ADMIN_URL is not set — run scripts/setup-postgres.sh');
    _adminPool = new pg.Pool({
      connectionString: url,
      max: 4,
      idleTimeoutMillis: 30_000,
      // 10s connection timeout so a misconfigured host fails fast instead of
      // hanging the bot for the default 30s.
      connectionTimeoutMillis: 10_000,
    });
    _adminPool.on('error', (err) => {
      logger.error({ action: 'pg:admin_pool_error', err: err.message }, 'Admin pool error');
    });
  }
  return _adminPool;
}

export function queryPool(): pg.Pool {
  if (!_queryPool) {
    const url = config().pgQueryUrl;
    if (!url) throw new Error('TANGENT_DB_QUERY_URL is not set — run scripts/setup-postgres.sh');
    _queryPool = new pg.Pool({
      connectionString: url,
      max: 4,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });
    _queryPool.on('error', (err) => {
      logger.error({ action: 'pg:query_pool_error', err: err.message }, 'Query pool error');
    });
  }
  return _queryPool;
}

// ─── SELECT-only validator ───────────────────────────────────────────────────
//
// Defense in depth alongside the read-only role.  The role already blocks
// writes at the database level, but parsing here lets us reject queries with
// a clear error message *before* burning a round trip — and it catches
// mistakes like a typo'd CTE that opens with WITH ... INSERT.
//
// Approach: strip comments and strings, lower-case, then look for any keyword
// that isn't a read-only operation.  Not bulletproof against deeply
// pathological input, but the readonly role is the real backstop.
const FORBIDDEN_TOKENS = [
  'insert', 'update', 'delete', 'drop', 'truncate', 'alter', 'create',
  'grant', 'revoke', 'reindex', 'vacuum', 'analyze', 'cluster', 'lock',
  'copy',  'comment', 'security', 'reset',  'set ', 'do ', 'call ',
  'refresh', 'listen', 'notify', 'unlisten', 'discard',
  'pg_terminate_backend', 'pg_cancel_backend',
];

export interface QueryValidation {
  ok: boolean;
  reason?: string;
}

export function validateReadOnlySql(sql: string): QueryValidation {
  // Strip /* ... */ block comments
  let stripped = sql.replace(/\/\*[\s\S]*?\*\//g, ' ');
  // Strip -- line comments
  stripped = stripped.replace(/--[^\n]*/g, ' ');
  // Strip 'string literals' and "identifiers" — replace with placeholders so
  // forbidden keywords inside strings don't trip the check.
  stripped = stripped.replace(/'(?:[^']|'')*'/g, "''");
  stripped = stripped.replace(/"(?:[^"]|"")*"/g, '""');

  const lower = stripped.trim().toLowerCase();
  if (!lower) return { ok: false, reason: 'Query is empty' };

  // Must start with SELECT, WITH, EXPLAIN, SHOW, or VALUES.
  if (!/^(select|with|explain|show|values|table)\b/.test(lower)) {
    return { ok: false, reason: 'Only SELECT / WITH / EXPLAIN / SHOW / VALUES / TABLE queries are allowed' };
  }

  // Reject any forbidden keyword as a whole word.
  for (const tok of FORBIDDEN_TOKENS) {
    const re = new RegExp(`\\b${tok.trim()}\\b`);
    if (re.test(lower)) {
      return { ok: false, reason: `Query contains forbidden keyword \`${tok.trim()}\`` };
    }
  }

  // Reject multiple statements (semi-colon followed by more SQL).
  // A trailing semicolon is fine.
  const trimmedNoTrail = lower.replace(/;\s*$/, '');
  if (trimmedNoTrail.includes(';')) {
    return { ok: false, reason: 'Multiple statements are not allowed (only one query per call)' };
  }

  return { ok: true };
}

// ─── Query execution helpers ─────────────────────────────────────────────────

export interface QueryResult {
  rowCount: number;
  rows: Record<string, unknown>[];
  truncated: boolean;
  fields: { name: string; dataTypeID: number }[];
}

const MAX_ROWS = 50;
const STATEMENT_TIMEOUT_MS = 5_000;

export async function runReadOnlyQuery(sql: string): Promise<QueryResult> {
  const validation = validateReadOnlySql(sql);
  if (!validation.ok) throw new Error(`Query rejected: ${validation.reason}`);

  const client = await queryPool().connect();
  try {
    // Per-session statement_timeout — caps run-time at the query level.
    await client.query(`SET statement_timeout = ${STATEMENT_TIMEOUT_MS}`);
    const result = await client.query(sql);
    const rows = result.rows.slice(0, MAX_ROWS) as Record<string, unknown>[];
    return {
      rowCount: result.rowCount ?? rows.length,
      rows,
      truncated: (result.rowCount ?? rows.length) > MAX_ROWS,
      fields: result.fields.map((f) => ({ name: f.name, dataTypeID: f.dataTypeID })),
    };
  } finally {
    client.release();
  }
}

// ─── Schema introspection (uses query pool — read-only is enough) ────────────

export interface SchemaSummary {
  databases: string[];
  extensions: { name: string; version: string }[];
  tables: { schema: string; name: string; rowEstimate: number }[];
  // Limited subset of columns to keep payload small for Claude
  columns: { schema: string; table: string; column: string; type: string; nullable: boolean }[];
}

export async function describeSchema(): Promise<SchemaSummary> {
  const pool = queryPool();

  const [dbs, exts, tables, cols] = await Promise.all([
    pool.query<{ datname: string }>(
      `SELECT datname FROM pg_database WHERE datistemplate = false ORDER BY datname`,
    ),
    pool.query<{ extname: string; extversion: string }>(
      `SELECT extname, extversion FROM pg_extension ORDER BY extname`,
    ),
    pool.query<{ schemaname: string; relname: string; n_live_tup: string }>(
      `SELECT schemaname, relname, n_live_tup
       FROM pg_stat_user_tables
       ORDER BY schemaname, relname`,
    ),
    pool.query<{ table_schema: string; table_name: string; column_name: string; data_type: string; is_nullable: string }>(
      `SELECT table_schema, table_name, column_name, data_type, is_nullable
       FROM information_schema.columns
       WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
       ORDER BY table_schema, table_name, ordinal_position`,
    ),
  ]);

  return {
    databases: dbs.rows.map((r) => r.datname),
    extensions: exts.rows.map((r) => ({ name: r.extname, version: r.extversion })),
    tables: tables.rows.map((r) => ({
      schema: r.schemaname,
      name: r.relname,
      rowEstimate: parseInt(r.n_live_tup, 10),
    })),
    columns: cols.rows.map((r) => ({
      schema: r.table_schema,
      table: r.table_name,
      column: r.column_name,
      type: r.data_type,
      nullable: r.is_nullable === 'YES',
    })),
  };
}

// ─── User management (admin pool) ────────────────────────────────────────────

export interface DbUser {
  rolname: string;
  rolcanlogin: boolean;
  rolsuper: boolean;
  rolcreaterole: boolean;
  rolcreatedb: boolean;
  // Comma-separated list of granted database privileges
  databases: string[];
}

export async function listDbUsers(): Promise<DbUser[]> {
  const pool = queryPool();
  const r = await pool.query<{
    rolname: string;
    rolcanlogin: boolean;
    rolsuper: boolean;
    rolcreaterole: boolean;
    rolcreatedb: boolean;
  }>(
    `SELECT rolname, rolcanlogin, rolsuper, rolcreaterole, rolcreatedb
     FROM pg_roles
     WHERE rolname NOT LIKE 'pg_%'
     ORDER BY rolname`,
  );
  return r.rows.map((row) => ({ ...row, databases: [] }));
}

/**
 * Validates a Postgres role name. Postgres allows quoted identifiers with
 * arbitrary characters, but we restrict to a safe alphanumeric+underscore
 * subset so we never have to worry about escaping when interpolating into
 * DDL — the admin pool runs as a privileged role and a role-name injection
 * would be game-over.
 */
export function validateRoleName(name: string): boolean {
  return /^[a-z][a-z0-9_]{1,62}$/.test(name);
}

export interface CreateDbUserResult {
  username: string;
  password: string;
  databaseName: string | null;
  /** Connection string the new user can use, with the password embedded. */
  connectionString: string;
}

/**
 * Create a new Postgres role with a random password.  Optionally also
 * creates a database owned by the new role and grants it ALL on that DB.
 *
 * The caller (the slack-bot handler) is responsible for:
 *   - Restricting this to Daanish only (Postgres role name = blast radius)
 *   - DM'ing the password to Daanish
 *   - Mirroring the connection string into Secrets Manager as
 *     `tangent/db/<username>` so deployed services can inject it.
 */
export async function createDbUser(opts: {
  username: string;
  createDatabase: boolean;
}): Promise<CreateDbUserResult> {
  if (!validateRoleName(opts.username)) {
    throw new Error(
      `Invalid role name "${opts.username}" — must be lowercase alphanumeric + underscore, 2-63 chars, starting with a letter.`,
    );
  }

  // 32-char URL-safe random password
  const password = generatePassword(32);

  const pool = adminPool();
  const client = await pool.connect();
  try {
    // Quote the role name with double quotes; validateRoleName guarantees
    // the string contains no double quotes that need escaping.
    //
    // CREATE ROLE does NOT support parameter binding for the password —
    // it's DDL, $1 substitution only works in DML. We have to inline the
    // password as a SQL string literal. generatePassword() returns only
    // [A-Za-z0-9] (no quotes, no backslashes), so the escaped form is
    // simply wrapping in single quotes; no further escaping is needed.
    // Defense in depth: assert the alphabet here so a future change to
    // generatePassword() can't silently introduce an injection vector.
    if (!/^[A-Za-z0-9]+$/.test(password)) {
      throw new Error('Generated password contains characters outside [A-Za-z0-9] — refusing to inline into DDL');
    }
    await client.query(`CREATE ROLE "${opts.username}" WITH LOGIN PASSWORD '${password}'`);

    // Grant the new role TO tangent_admin so tangent_admin is a member of it.
    // This is required for later REASSIGN OWNED / DROP OWNED operations:
    // those commands need the executing role to be a member of BOTH the
    // source and target roles.  Without this grant, dropDbUser() fails with
    // "permission denied to reassign objects".
    await client.query(`GRANT "${opts.username}" TO tangent_admin`);

    let databaseName: string | null = null;
    if (opts.createDatabase) {
      databaseName = opts.username;
      await client.query(`CREATE DATABASE "${databaseName}" OWNER "${opts.username}"`);
      // Make sure tangent_query can read everything in the new DB too — but
      // ALTER DEFAULT PRIVILEGES has to run inside the target DB, so we just
      // GRANT CONNECT here and leave per-table SELECT to the user.
      await client.query(`GRANT CONNECT ON DATABASE "${databaseName}" TO tangent_query`);
    }

    // Build a connection string for the new user.  We point at the EC2's
    // internal VPC IP so deployed ECS services can reach it.
    const cfg = config();
    const dbForUrl = databaseName ?? 'postgres';
    const connectionString = `postgresql://${opts.username}:${password}@${cfg.pgHostInternalIp}:5432/${dbForUrl}`;

    return {
      username: opts.username,
      password,
      databaseName,
      connectionString,
    };
  } finally {
    client.release();
  }
}

export async function dropDbUser(username: string, dropDatabase: boolean): Promise<void> {
  if (!validateRoleName(username)) {
    throw new Error(`Invalid role name "${username}"`);
  }
  const pool = adminPool();
  const client = await pool.connect();
  try {
    if (dropDatabase) {
      await client.query(`DROP DATABASE IF EXISTS "${username}"`);
    }

    // REASSIGN OWNED / DROP OWNED require the executing role (tangent_admin)
    // to be a member of the target role.  Defensive grant — idempotent, and
    // covers roles that were created before createDbUser started doing this
    // automatically.  tangent_admin's CREATEROLE privilege lets it grant any
    // role to itself.
    try {
      await client.query(`GRANT "${username}" TO tangent_admin`);
    } catch {
      // If the grant fails (e.g. role doesn't exist), let the subsequent
      // commands surface the real error.
    }

    // REASSIGN OWNED so we don't leak orphaned privileges on objects the
    // role created in shared databases.
    await client.query(`REASSIGN OWNED BY "${username}" TO tangent_admin`);
    await client.query(`DROP OWNED BY "${username}" CASCADE`);
    await client.query(`DROP ROLE IF EXISTS "${username}"`);
  } finally {
    client.release();
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function generatePassword(length: number): string {
  const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  // crypto.randomBytes for a cryptographically-strong password.  The pg
  // client has no opinion on password content as long as it's a string.
  const buf = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) {
    out += ALPHABET[buf[i]! % ALPHABET.length];
  }
  return out;
}
