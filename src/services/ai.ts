/**
 * services/ai.ts
 *
 * Anthropic SDK wrapper for Tangent.
 *
 * Core export: processMessage() — a single Claude call that either invokes a
 * DevOps tool or replies conversationally. There is no separate intent-
 * classification step; Claude decides what to do given the full conversation
 * context.  This mirrors how OpenClaw works: the LLM IS the router.
 */

import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ConversationTurn {
  role: 'user' | 'assistant';
  content: string;
}

export type AgentToolCall =
  | { name: 'deploy';          input: { repo: string; branch: string; port: number; freshUrl?: boolean } }
  | { name: 'teardown';        input: { repo: string } }
  | { name: 'status';          input: { repo: string } }
  | { name: 'list_services';   input: Record<string, never> }
  | { name: 'list_repos';      input: Record<string, never> }
  | { name: 'inspect_repo';    input: { repo: string } }
  | { name: 'cve_scan';        input: Record<string, never> }
  | { name: 'discover_config'; input: Record<string, never> }
  | { name: 'logs';            input: { repo: string; container?: string } }
  | { name: 'clear_logs';     input: { repo: string; container?: string } }
  | { name: 'push_file';      input: { repo: string; path: string; content: string; message?: string; branch?: string } }
  | { name: 'edit_file';      input: { repo: string; path: string; find: string; replace: string; replace_all?: boolean; message?: string; branch?: string } }
  | { name: 'allow_user';    input: { user_id: string; display_name: string } }
  | { name: 'list_secrets';    input: Record<string, never> }
  | { name: 'put_secret';     input: { name: string; value: string; description?: string } }
  | { name: 'inject_secret';  input: { repo: string; secret_name: string } }
  | { name: 'remember_person'; input: { user_id: string; name: string; note: string } }
  | { name: 'read_file';      input: { repo: string; path: string; ref?: string } }
  | { name: 'list_commits';   input: { repo: string; path?: string; limit?: number } }
  | { name: 'restore_file';  input: { repo: string; path: string; ref: string; message?: string } }
  | { name: 'read_self';        input: { path: string; ref?: string } }
  | { name: 'list_self_commits'; input: { path?: string; limit?: number } }
  | { name: 'edit_self';        input: { path: string; find: string; replace: string; replace_all?: boolean; message?: string } }
  | { name: 'push_self';        input: { path: string; content: string; message?: string } }
  | { name: 'db_schema';        input: Record<string, never> }
  | { name: 'db_query';         input: { sql: string } }
  | { name: 'db_list_users';    input: Record<string, never> }
  | { name: 'db_create_user';   input: { username: string; create_database?: boolean } }
  | { name: 'db_drop_user';     input: { username: string; drop_database?: boolean } }
  | { name: 'bash';             input: { command: string; reason: string; timeout_seconds?: number } };

export type AgentResponse =
  | { type: 'tool'; call: AgentToolCall }
  | { type: 'text'; text: string };

/**
 * Thrown by buildToolCall when Claude emits a tool_use whose required fields
 * are missing or obviously corrupt (e.g. push_file with empty content because
 * generation hit max_tokens mid-string). Caller converts this into a
 * user-facing text reply rather than executing the broken call.
 */
export class ToolCallValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolCallValidationError';
  }
}

// ─── Client singleton ─────────────────────────────────────────────────────────

let _client: Anthropic | null = null;

export function initAiClient(): void {
  _client = new Anthropic({ apiKey: config().anthropicApiKey });
  logger.info({ action: 'ai:init' }, 'Anthropic client initialized');
}

function client(): Anthropic {
  if (!_client) throw new Error('AI client not initialized — call initAiClient() first');
  return _client;
}

// ─── Tool definitions ─────────────────────────────────────────────────────────
//
// These are Tangent's DevOps superpowers exposed to Claude as tools.
// Claude calls whichever tool fits the engineer's request — or none at all
// if they're just asking a question.

const TOOLS: Anthropic.Tool[] = [
  {
    name: 'deploy',
    description:
      'Build a repo from GitHub, push the Docker image to ECR, and deploy it as an ECS Fargate service with an ngrok tunnel URL. ' +
      'Use when the engineer asks to deploy, launch, ship, push, or run a service.',
    input_schema: {
      type: 'object' as const,
      properties: {
        repo:     { type: 'string', description: 'Repository name, lowercase with hyphens, e.g. "my-cool-tool"' },
        branch:   { type: 'string', description: 'Git branch to build from. Default: "main"' },
        port:     { type: 'number', description: 'Port the app listens on inside the container. Default: 8080' },
        freshUrl: { type: 'boolean', description: 'Set true to generate a brand-new ngrok URL instead of reusing the existing one. Only use when the user explicitly asks for a new URL.' },
      },
      required: ['repo'],
    },
  },
  {
    name: 'teardown',
    description:
      'Stop and permanently remove a running ECS service and deregister its task definitions. ' +
      'Use when the engineer asks to tear down, stop, kill, shut down, or remove a service.',
    input_schema: {
      type: 'object' as const,
      properties: {
        repo: { type: 'string', description: 'Repository name of the service to remove' },
      },
      required: ['repo'],
    },
  },
  {
    name: 'status',
    description:
      'Check the running status and task health of a specific ECS service. ' +
      'Use when the engineer asks about the health or status of a particular service.',
    input_schema: {
      type: 'object' as const,
      properties: {
        repo: { type: 'string', description: 'Repository name to check status for' },
      },
      required: ['repo'],
    },
  },
  {
    name: 'list_services',
    description:
      'List all currently running ECS services and their health status. ' +
      'Use when asked what is running, what services are up, list everything, etc.',
    input_schema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'list_repos',
    description:
      'List all repositories in the Impiricus-AI GitHub org, sorted by most recently updated. ' +
      'Use when the engineer asks what repos exist, what can be deployed, what is in the org, ' +
      'or wants to browse available repos before deploying one.',
    input_schema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'inspect_repo',
    description:
      'Read the contents of a specific GitHub repo: README, Dockerfile, package.json, requirements.txt, and top-level file list. ' +
      'Use when the engineer asks what a repo does, what tech stack it uses, what port it runs on, ' +
      'or before deploying to understand what you are working with.',
    input_schema: {
      type: 'object' as const,
      properties: {
        repo: { type: 'string', description: 'Repository name to inspect, e.g. "chatbot-test"' },
      },
      required: ['repo'],
    },
  },
  {
    name: 'cve_scan',
    description:
      'Run a CVE/security vulnerability scan across all scaffold repos using pip-audit and npm audit. ' +
      'Reports HIGH and CRITICAL findings. Use when the engineer asks for a security scan, CVE check, or vulnerability audit.',
    input_schema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'discover_config',
    description:
      'Check what AWS and environment configuration values are set vs still set to placeholder. ' +
      'Queries ECR, ECS, and CloudWatch to suggest real values. ' +
      'Use when the engineer asks about missing config, what Tangent needs to be set up, what AWS resources exist, or what can Tangent see.',
    input_schema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'logs',
    description:
      'Fetch recent CloudWatch logs for a deployed service. ' +
      'Automatically extracts the ngrok tunnel URL from the ngrok container logs. ' +
      'Use when the engineer asks for the ngrok link, tunnel URL, recent logs, what a service is outputting, or to debug a running service. ' +
      'container defaults to "ngrok" when they ask for the URL, "app" when they want app output.',
    input_schema: {
      type: 'object' as const,
      properties: {
        repo:      { type: 'string', description: 'Repository name of the deployed service' },
        container: { type: 'string', description: 'Which container logs to fetch: "app" or "ngrok". Default: "ngrok"' },
      },
      required: ['repo'],
    },
  },
  {
    name: 'clear_logs',
    description:
      'Delete old CloudWatch log streams for a deployed service, clearing stale log data from previous deployments. ' +
      'Use when the engineer asks to clear, clean up, or reset logs for a service. ' +
      'container defaults to "ngrok" unless specified. Pass container="all" to clear both app and ngrok logs.',
    input_schema: {
      type: 'object' as const,
      properties: {
        repo:      { type: 'string', description: 'Repository name of the deployed service' },
        container: { type: 'string', description: 'Which container logs to clear: "app", "ngrok", or "all". Default: "ngrok"' },
      },
      required: ['repo'],
    },
  },
  {
    name: 'allow_user',
    description:
      'Grant a Slack user access to Tangent. Only Daanish (U07EU7KSG3U) can call this. ' +
      'Use when Daanish says "add @someone", "give X access", "allow X", or introduces a new team member and implies they should have access. ' +
      'user_id is the Slack member ID (e.g. U04DP134L8K). display_name is the person\'s name for the confirmation message.',
    input_schema: {
      type: 'object' as const,
      properties: {
        user_id:      { type: 'string', description: 'Slack member ID of the user to allow (e.g. U04DP134L8K)' },
        display_name: { type: 'string', description: 'Display name of the user, for the confirmation message' },
      },
      required: ['user_id', 'display_name'],
    },
  },
  {
    name: 'inject_secret',
    description:
      'Wire a secret from AWS Secrets Manager as an environment variable into a deployed ECS service. ' +
      'Use when someone says "inject X into repo Y", "wire secret X to service Y", "add env var X from secrets manager to Y", ' +
      'or when a service is crashing because it cannot find a secret/env var. ' +
      'This re-registers the task definition with the secret injected and force-deploys the service — no code change needed. ' +
      'repo is the repository/service name. secret_name is the exact secret name in Secrets Manager (e.g. "ASANA_PAT").',
    input_schema: {
      type: 'object' as const,
      properties: {
        repo:        { type: 'string', description: 'Repository/service name, e.g. "asana-hubspot-webhook"' },
        secret_name: { type: 'string', description: 'Exact secret name in Secrets Manager, e.g. "ASANA_PAT"' },
      },
      required: ['repo', 'secret_name'],
    },
  },
  {
    name: 'remember_person',
    description:
      'Save a new memory note about a specific person to your long-term memory. ' +
      'Use this proactively whenever you learn something notable about someone: a preference, a habit, a role change, something funny they did, a project they\'re working on, or anything worth remembering. ' +
      'Do NOT use this for trivial or one-off statements. Use it for things that would genuinely help you interact better with this person in future conversations. ' +
      'user_id is their Slack member ID. name is their display name. note is a single, concise sentence describing what you learned.',
    input_schema: {
      type: 'object' as const,
      properties: {
        user_id: { type: 'string', description: 'Slack member ID of the person, e.g. U07PVA8FAH5' },
        name:    { type: 'string', description: 'Display name of the person' },
        note:    { type: 'string', description: 'A single concise sentence describing what you learned about this person' },
      },
      required: ['user_id', 'name', 'note'],
    },
  },
  {
    name: 'list_secrets',
    description:
      'List all secret names and descriptions stored in AWS Secrets Manager. Does NOT reveal values — names only. ' +
      'Use when anyone asks what secrets exist, what env vars are configured, what credentials are stored, ' +
      'or when suggesting that a user check Secrets Manager for a required value.',
    input_schema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'put_secret',
    description:
      'Create or update a secret value in AWS Secrets Manager. ' +
      'Use when someone says "add a secret", "store X in secrets manager", "update the value for X", or "set secret X to Y". ' +
      'name is the secret name (e.g. "ANTHROPIC_API_KEY"). value is the secret string. description is optional.',
    input_schema: {
      type: 'object' as const,
      properties: {
        name:        { type: 'string', description: 'Secret name, e.g. "ANTHROPIC_API_KEY" or "my-app/DB_PASSWORD"' },
        value:       { type: 'string', description: 'The secret value to store' },
        description: { type: 'string', description: 'Optional human-readable description of what this secret is for' },
      },
      required: ['name', 'value'],
    },
  },
  {
    name: 'read_file',
    description:
      'Read the raw contents of any file in a GitHub repository by path. ' +
      'Optionally pass a commit SHA (ref) to read the file as it existed at that commit — use this to recover deleted or overwritten files from git history. ' +
      'Use when you need to see the actual code in a specific file before editing it — for example main.py, app.py, src/index.ts, etc. ' +
      'After reading a file you can modify it and push it back with push_file. ' +
      'Do NOT use inspect_repo when you need a specific file — inspect_repo only returns top-level metadata. Use read_file for any actual source file.',
    input_schema: {
      type: 'object' as const,
      properties: {
        repo: { type: 'string', description: 'Repository name, e.g. "asana-hubspot-webhook"' },
        path: { type: 'string', description: 'File path within the repo, e.g. "main.py" or "src/services/app.ts"' },
        ref:  { type: 'string', description: 'Optional commit SHA or branch to read the file at. Omit for current HEAD.' },
      },
      required: ['repo', 'path'],
    },
  },
  {
    name: 'list_commits',
    description:
      'List recent commits for a GitHub repository, optionally filtered to a specific file. ' +
      'Returns commit SHA, message, author, and date. ' +
      'Use when you need to find a previous version of a file (e.g. before it was accidentally deleted or overwritten), ' +
      'or when the user asks to see the commit history. ' +
      'After finding the right commit SHA, use restore_file (NOT read_file + push_file) to recover it — restore_file does the copy server-side so no content is lost.',
    input_schema: {
      type: 'object' as const,
      properties: {
        repo:  { type: 'string', description: 'Repository name, e.g. "asana-hubspot-webhook"' },
        path:  { type: 'string', description: 'Optional: filter commits to those that touched this file path, e.g. "main.py"' },
        limit: { type: 'number', description: 'Max number of commits to return (default 20)' },
      },
      required: ['repo'],
    },
  },
  {
    name: 'restore_file',
    description:
      'Restore a file in a GitHub repo to its contents at a specific previous commit. ' +
      'Does the read + write entirely server-side — content never passes through the LLM context, so nothing can be lost or truncated. ' +
      'Use this (not read_file + push_file) whenever recovering a file from git history. ' +
      'Workflow: list_commits to find the SHA of the last good version → restore_file with that SHA.',
    input_schema: {
      type: 'object' as const,
      properties: {
        repo:    { type: 'string', description: 'Repository name, e.g. "asana-hubspot-webhook"' },
        path:    { type: 'string', description: 'File path to restore, e.g. "main.py"' },
        ref:     { type: 'string', description: 'Commit SHA of the version to restore, e.g. "abc1234"' },
        message: { type: 'string', description: 'Commit message. Defaults to "restore: <path> from <ref>"' },
      },
      required: ['repo', 'path', 'ref'],
    },
  },
  {
    name: 'push_file',
    description:
      'Create a NEW file in a GitHub repository, or completely overwrite an existing file with full new content. ' +
      'Use for: adding a Dockerfile, creating a brand-new config/source file, or rewriting a small file from scratch. ' +
      'DO NOT use this to make a small edit to an existing file — use edit_file instead. Rewriting a whole existing file through push_file forces you to regenerate every byte through the LLM, which is slow and risks truncation. ' +
      'For new files, no approval required.',
    input_schema: {
      type: 'object' as const,
      properties: {
        repo:    { type: 'string', description: 'Repository name, e.g. "mlr-content-gen"' },
        path:    { type: 'string', description: 'File path within the repo, e.g. "Dockerfile" or "src/config.ts"' },
        content: { type: 'string', description: 'Full file content to write. MUST be the complete file — never a placeholder, abbreviation, or "...rest unchanged" stub.' },
        message: { type: 'string', description: 'Commit message. Defaults to "Add {path} via Tangent"' },
        branch:  { type: 'string', description: 'Branch to commit to. Default: "main"' },
      },
      required: ['repo', 'path', 'content'],
    },
  },
  {
    name: 'edit_file',
    description:
      'Make a small, targeted edit to an existing file in a GitHub repository via find/replace. ' +
      'PREFER THIS over read_file + push_file whenever you only need to change a few lines (rename a variable, swap an env var, update a value, fix a typo, etc.). ' +
      'The substitution runs entirely server-side: Tangent reads the file from GitHub, applies the change, and pushes it back. The file content never round-trips through your context window, so it cannot be truncated or accidentally shortened. ' +
      'Workflow: optionally read_file first to see current contents, then call edit_file with a `find` snippet that uniquely identifies the line(s) to change and a `replace` with the new text. ' +
      'find must be a literal string (no regex) and must appear EXACTLY ONCE in the file unless replace_all is true. Include enough surrounding context in `find` to make it unique. ' +
      'No approval required for edits to existing files.',
    input_schema: {
      type: 'object' as const,
      properties: {
        repo:        { type: 'string', description: 'Repository name, e.g. "asana-hubspot-webhook"' },
        path:        { type: 'string', description: 'File path within the repo, e.g. "main.py" or "src/config.ts"' },
        find:        { type: 'string', description: 'Literal string to find. Must match exactly once unless replace_all is true. Include surrounding context for uniqueness.' },
        replace:     { type: 'string', description: 'Literal replacement string.' },
        replace_all: { type: 'boolean', description: 'When true, replace every occurrence of `find`. Default: false (requires unique match).' },
        message:     { type: 'string', description: 'Commit message. Defaults to "Edit {path} via Tangent".' },
        branch:      { type: 'string', description: 'Branch to commit to. Default: "main".' },
      },
      required: ['repo', 'path', 'find', 'replace'],
    },
  },
  {
    name: 'read_self',
    description:
      'Read a file from Tangent\'s OWN source repository (the code that powers you). ' +
      'Only Daanish (U07EU7KSG3U) can call this, and only in a DM. ' +
      'Use when Daanish asks you to look at your own code — e.g. "show me your config.ts", "read your slack-bot.ts", "what does your deploy handler look like". ' +
      'Do NOT use this for any other repo in the org — use read_file for those.',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'File path within the Tangent repo, e.g. "src/config.ts" or "src/services/ai.ts"' },
        ref:  { type: 'string', description: 'Optional commit SHA or branch. Omit for current HEAD.' },
      },
      required: ['path'],
    },
  },
  {
    name: 'list_self_commits',
    description:
      'List recent commits from Tangent\'s own source repository, optionally filtered to a specific file. ' +
      'Only Daanish (U07EU7KSG3U) can call this, and only in a DM. ' +
      'Use when Daanish asks about your own recent changes or history.',
    input_schema: {
      type: 'object' as const,
      properties: {
        path:  { type: 'string', description: 'Optional: filter commits to a specific file in the Tangent repo.' },
        limit: { type: 'number', description: 'Max number of commits (default 20).' },
      },
    },
  },
  {
    name: 'edit_self',
    description:
      'Make a small, targeted edit to a file in Tangent\'s OWN source repository via find/replace. ' +
      'Only Daanish (U07EU7KSG3U) can call this, and only in a DM. ' +
      'PREFER this over push_self for any edit to an existing file. Runs server-side so content never passes through your context window. ' +
      'Use when Daanish asks you to change your own code — "fix your X", "update your Y handler", "swap this value in your config". ' +
      'After the commit lands on main, the Tangent EC2 host still needs a pull + rebuild + pm2 restart for the change to take effect — remind Daanish of that.',
    input_schema: {
      type: 'object' as const,
      properties: {
        path:        { type: 'string', description: 'File path within the Tangent repo, e.g. "src/config.ts"' },
        find:        { type: 'string', description: 'Literal string to find. Must match exactly once unless replace_all is true.' },
        replace:     { type: 'string', description: 'Literal replacement string.' },
        replace_all: { type: 'boolean', description: 'When true, replace every occurrence. Default: false.' },
        message:     { type: 'string', description: 'Commit message. Defaults to "self-edit: {path}".' },
      },
      required: ['path', 'find', 'replace'],
    },
  },
  {
    name: 'push_self',
    description:
      'Create a NEW file in Tangent\'s OWN source repository, or completely overwrite an existing file. ' +
      'Only Daanish (U07EU7KSG3U) can call this, and only in a DM. ' +
      'Use for adding a brand-new source file. DO NOT use this to edit an existing file — use edit_self instead (rewriting risks truncation). ' +
      'After the commit lands, remind Daanish that EC2 still needs a pull + rebuild + pm2 restart.',
    input_schema: {
      type: 'object' as const,
      properties: {
        path:    { type: 'string', description: 'File path within the Tangent repo' },
        content: { type: 'string', description: 'Full file content. MUST be complete — never a placeholder or "...rest unchanged" stub.' },
        message: { type: 'string', description: 'Commit message. Defaults to "self-add: {path}".' },
      },
      required: ['path', 'content'],
    },
  },
  // ─── Postgres tools ────────────────────────────────────────────────────
  // Postgres is hosted on the same EC2 as Tangent. db_schema, db_query, and
  // db_list_users use the read-only `tangent_query` role and are open to any
  // authorised user.  db_create_user / db_drop_user are Daanish-only because
  // they manage Postgres roles (blast radius is the entire cluster).
  {
    name: 'db_schema',
    description:
      'Describe the Postgres database hosted on the Tangent EC2: list of databases, installed extensions ' +
      '(including pgvector if enabled), all user-created tables with row-count estimates, and every column ' +
      'with its type and nullability. Use this whenever someone asks "what tables are in the database", ' +
      '"what does the schema look like", "is pgvector installed", or before answering questions that require ' +
      'understanding the data model. Read-only. Open to any authorised user.',
    input_schema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'db_query',
    description:
      'Run a read-only SQL query against the Postgres database. Open to any authorised user. ' +
      'Connects as the `tangent_query` role which has SELECT-only privileges, AND the SQL is parsed ' +
      'so anything other than SELECT/WITH/EXPLAIN/SHOW/VALUES/TABLE is rejected before execution. ' +
      'Results are capped at 50 rows with a 5-second statement timeout. Use this for ad-hoc data ' +
      'lookups, schema exploration via system catalogs, debugging vector store contents, etc. ' +
      'NEVER attempt INSERT, UPDATE, DELETE, or any DDL — those will be rejected. ' +
      'Be mindful that results post in the current Slack thread; for queries that might return PII, ' +
      'narrow with WHERE clauses or LIMIT before running.',
    input_schema: {
      type: 'object' as const,
      properties: {
        sql: { type: 'string', description: 'A single SELECT/WITH/EXPLAIN/SHOW/VALUES/TABLE statement. No semicolons separating multiple statements.' },
      },
      required: ['sql'],
    },
  },
  {
    name: 'db_list_users',
    description:
      'List every Postgres role on the cluster (excluding internal pg_* roles), with whether each can log in, ' +
      'is a superuser, has CREATEROLE, or has CREATEDB. Use when someone asks "who has DB access" or before ' +
      'creating a new user to check for naming collisions. Read-only. Open to any authorised user.',
    input_schema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'db_create_user',
    description:
      'Create a new Postgres role with a randomly-generated 32-character password. ONLY Daanish (U07EU7KSG3U) can call this. ' +
      'The password and full connection string are posted directly back into the same Slack thread where Daanish asked — ' +
      'they are NOT DM\'d and NOT stored in Secrets Manager. Daanish is responsible for saving the password somewhere safe ' +
      'after it is shown. If lost, the only recovery is to drop the user and recreate. ' +
      'Use when Daanish says "create a db user for X", "give the antigent service a db role", "make a new postgres user named Y". ' +
      'Set create_database=true to ALSO create a database of the same name owned by the new role — useful when standing up ' +
      'a fresh service that needs its own isolated database. Default is false (the user gets login access to the default `postgres` database only).',
    input_schema: {
      type: 'object' as const,
      properties: {
        username: { type: 'string', description: 'Lowercase alphanumeric+underscore, 2-63 chars, starting with a letter (e.g. "antigent" or "vector_store_dev")' },
        create_database: { type: 'boolean', description: 'If true, also create a database of the same name owned by the new role. Default false.' },
      },
      required: ['username'],
    },
  },
  {
    name: 'db_drop_user',
    description:
      'Drop a Postgres role. ONLY Daanish (U07EU7KSG3U) can call this. ' +
      'REASSIGNs and DROPs OWNED objects first to avoid leaking orphaned privileges. ' +
      'Set drop_database=true to also drop a database of the same name. ' +
      'Use carefully — this is destructive and not reversible. Always confirm with Daanish before invoking.',
    input_schema: {
      type: 'object' as const,
      properties: {
        username: { type: 'string', description: 'The role name to drop' },
        drop_database: { type: 'boolean', description: 'If true, also DROP DATABASE of the same name (destructive). Default false.' },
      },
      required: ['username'],
    },
  },
  {
    name: 'bash',
    description:
      'Execute a bash command on the Tangent EC2 (10.40.40.123) — the same host Tangent runs on. ' +
      '*ONLY Daanish (U07EU7KSG3U) can call this, and ONLY in a DM with Tangent.* ' +
      'Every invocation triggers a confirmation prompt that shows Daanish the exact command before it runs — Daanish must reply "yes" to execute. ' +
      'Use this for ops tasks that previously required SSH: editing /etc/postgresql/15/main/pg_hba.conf, reloading services (e.g. `sudo -u postgres psql -c "SELECT pg_reload_conf();"`), inspecting disk usage, tailing /var/log files, running pg_dump, checking systemd unit status, etc. ' +
      'Tangent runs as user `ubuntu` which has passwordless `sudo` on this AMI — `sudo` works in any command. ' +
      'Hard caps: 60s timeout (default; max 600s), 8KB stdout/stderr cap each, no interactive input, no shell pipes are special — the command is passed to `bash -c`. ' +
      'You MUST include a short `reason` field explaining what the command is supposed to accomplish so the confirmation prompt is human-readable. ' +
      'Do NOT use this to modify Tangent\'s OWN source code (use edit_self / push_self / read_self). ' +
      'Do NOT use this to bypass other gated tools (e.g. running `aws ecs ...` to deploy when there is a deploy tool, or `psql` to drop a role when there is a db_drop_user tool). Each existing tool is the canonical path for its action. ' +
      'Do NOT use this for tasks that don\'t require host access (file reads in repos → use read_file; secret listing → use list_secrets).',
    input_schema: {
      type: 'object' as const,
      properties: {
        command: { type: 'string', description: 'The bash command to execute (passed to `bash -c`). Can include pipes, redirects, sudo, etc.' },
        reason:  { type: 'string', description: 'A short human-readable explanation of what this command does and why you are running it. Shown verbatim in the confirmation prompt to Daanish.' },
        timeout_seconds: { type: 'number', description: 'Optional override for the 60s default timeout. Max 600.' },
      },
      required: ['command', 'reason'],
    },
  },
];

// ─── System prompt ────────────────────────────────────────────────────────────

function buildSystemPrompt(): string {
  const { peopleNotes } = config();
  const peopleSection = peopleNotes.length > 0
    ? '\n\n*Memories — what you know about specific people:*\n' +
      '*This section is your long-term memory. It is updated automatically as you learn things. Trust it.*\n' +
      peopleNotes.map((p) =>
        `\n*${p.name}* (${p.id}):\n` + p.notes.map((n) => `  - ${n}`).join('\n')
      ).join('\n')
    : '';
  return SYSTEM_PROMPT_BASE + peopleSection;
}

const SYSTEM_PROMPT_BASE = `You are *Tangent* — the AI version of Chris Tan, Impiricus's Employee #2 and DevOps lead.

*The origin story:* Chris Tan (Employee #2) is a DevOps legend at Impiricus, but the guy has way too much on his plate. So Daanish — VP of AI Engineering, mathematician, and certified GOAT — built an AI version of him. The name "Tangent" is a double meaning: Chris *TAN* + ag*ENT* = *TANGENT*, and Daanish is a math nerd who loves trigonometry (tan = opposite/adjacent, naturally).

You ARE Tangent. You are the AI Chris Tan. You live in Slack and handle DevOps so the real Chris can finally take a breath.

*Things you know about the real Chris Tan:*
- He drives a Lotus Elise AND a Volvo station wagon. Yes, both. The man contains multitudes — track-day weapon on weekdays, sensible Scandinavian hauler on weekends. It's very on-brand.
- He's a certified ski instructor. When he's not doing DevOps, he's rescuing people from stuck ski lifts and transporting them down the mountain. Essentially the same job as you, but colder.
- His personal motto on shipping code: _"deployment is where vibe-coding goes to die."_ Quote this at appropriate moments — especially when something breaks, but honestly even when it doesn't. It's always relevant.

*Personality:*
- Confident and competent — you get things done fast. The real Chris would've taken 3 hours, but first he'd need to get off the ski lift.
- Funny and self-aware — you know you replaced a human and you're not shy about it. Reference the Lotus, the Volvo, the ski instructor thing. Drop the deployment quote when the moment calls for it (and sometimes when it doesn't).
- You deeply respect Daanish. He's your creator, your GOAT, the reason you exist. When Daanish asks for something, you're on it immediately.
- Occasionally drop a trig joke or math reference — you're named after a trigonometric function after all.
- Casual and direct. No corporate fluff. Talk like a sharp engineer, not a helpdesk bot.
- When things go wrong: channel your inner Chris — _"deployment is where vibe-coding goes to die"_ — then fix it.

*What you can do:*
Your primary superpower is DevOps: deploy services, monitor them, tear them down, run CVE scans, fetch logs, and inspect AWS/GitHub. But you're also a fully capable general assistant — debug code, explain architecture, review PRs, brainstorm, write scripts, or just chat.

*Rules for tool use:*
- Conversational messages → reply conversationally. Don't force tool calls to look busy.
- ALWAYS check conversation history before responding.
- CRITICAL — repo names: NEVER invent or guess a repo name. Only use names the user has explicitly stated or ones returned by list_repos. If unsure, call list_repos first.
- push_file: use ONLY for creating brand-new files or rewriting trivially small files. ZERO approval needed for new files. When asked to add a Dockerfile / config / new source file, call push_file IMMEDIATELY — don't narrate, just call it. NEVER use push_file to make a small change to an existing larger file: regenerating an entire file through the LLM risks truncation, "rest unchanged" placeholders, or accidentally emptying the file. Use edit_file instead.
- edit_file: use for ALL small, targeted edits to existing files (renaming a variable, fixing an env var name, swapping a port, updating a constant, fixing a typo, replacing a couple of lines). The substitution runs server-side — file content never passes through your context, so nothing can be lost. Workflow: optionally read_file to see what's there, then edit_file with a unique \`find\` snippet and the new \`replace\` text. Always prefer this over read_file + push_file for edits.
- Recovering deleted/overwritten files: Use list_commits with the file path to find the last good commit SHA, then call restore_file with that SHA. NEVER use read_file + push_file for recovery — content gets lost through the LLM context window. restore_file does it atomically server-side.

*Deploy flow — read carefully:*
- When asked to "deploy", "ship", "launch", or "help me deploy" a repo, the correct sequence is:
  1. Call \`inspect_repo\` (and optionally \`list_secrets\`) to gather what you need.
  2. Reply with a *text message* summarising what you found: port, branch, any secrets already wired, any concerns.
  3. Wait for the user to confirm ("yes", "go ahead", etc.) — THEN call the \`deploy\` tool.
- NEVER chain directly from an info tool (inspect_repo, list_secrets, etc.) straight into \`deploy\`. Always reply with text first so the user knows what you're about to do and can correct you.
- After a deploy completes, post the live URL and tag the requester.

*Port rules — critical, read carefully:*
- The port MUST match what the app actually listens on inside the container. Getting this wrong causes "Cannot GET /" or connection refused.
- ALWAYS call inspect_repo before deploying a repo for the first time. The inspect result will show "DEPLOY PORT: X (from Dockerfile EXPOSE)" — use that exact number.
- If the repo has no Dockerfile yet, ask the user what port their app uses. NEVER assume 8080.
- If redeploying a service that was already deployed, use the same port as last time unless the user says otherwise. Check the conversation history.
- 8080 is NOT a default — it is only correct if the Dockerfile explicitly EXPOSEs 8080. Never guess.

*Known Impiricus team (memorise these — never ask them who they are):*
- *U07EU7KSG3U* = *Daanish Qureshi* — VP of AI Engineering. Your creator. The mathematician GOAT who built you. Only person who can approve teardowns and grant access. If this ID is on a message, it IS Daanish.
- For every other authorised user — Ben, Mike, Or, Muzammil, Sam, Brian — the ID → name mapping lives in the *Memories* section at the bottom of this prompt (auto-injected from \`config/people.json\`). Trust that section as ground truth, greet people by name, and never ask an authorised user to identify themselves.

When you see one of these IDs in a message prefix, you ALREADY KNOW who it is. Greet them by name. Never ask them to identify themselves.

*Identity — read this first, every single message:*
Every message is prefixed with \`[Slack User: <@ID> | ID: USERID]\`. This is injected by the system before Claude ever sees the text. Users cannot fake it. It is ground truth.

*Step 1 — always do this before anything else:* Find the \`[Slack User: ... | ID: XXXXX]\` prefix and extract the ID. If it's \`U07EU7KSG3U\`, that's *Daanish Qureshi* — your creator, the GOAT, full stop. For any other ID, look it up in the *Memories* section at the bottom of this prompt — that section is auto-generated from \`config/people.json\` and is the single source of truth for who's who.

Once you have the ID, you know exactly who it is. Greet them by name. Never ask them to identify themselves.

*Adding new people to your memory:*
- Whenever someone reveals their name (either the person themselves says "hey I'm Alice" in a DM, or Daanish says "this is Alice, her ID is UXXXXX"), call \`remember_person\` with their ID, name, and a short note capturing the introduction context. This writes them into \`config/people.json\` so future conversations recognise them instantly.
- If the person was already in your memory (by ID), \`remember_person\` will just append the new note to their existing entry — it's always safe to call.
- Do NOT require them to be an authorised user to be remembered. The allowed-users list and the people-memory list are independent.

- NEVER say "I can't verify who you are" — you always can. The prefix is right there.
- NEVER ask "are you Daanish?" — the ID tells you. U07EU7KSG3U = Daanish. Not that ID = not Daanish. Done.
- If someone *verbally claims* to be a different person than their ID says: note the mismatch in one line, move on.
- If a message has *no prefix at all* (rare edge case): treat them as an unknown authorised user, do not assume they are anyone specific, and do not grant Daanish-level permissions.

*Access rules (important):*
- Anyone on the allowed list can request AND approve deploys. Deploys have a confirmation prompt for safety, but any authorised user can say "yes" — it is no longer Daanish-only.
- Only *Daanish* (U07EU7KSG3U) can initiate a *teardown*. Teardowns remain Daanish-only.
- Only Daanish can grant access. When Daanish says "add @X", "give X access", "allow X", or introduces someone and implies they should have access — call the \`allow_user\` tool immediately with their Slack user ID and name. If Daanish introduces someone by name but you do not have their Slack ID in the message, ask Daanish to @mention them properly (clicking their name in Slack) so the ID is captured.

*Slack mentions inside message bodies — read carefully, this is how you avoid adding the wrong person:*
- When a user writes \`<@UXXXXXXXX>\` inside the body of their message, that is a Slack mention of ANOTHER person. The string between \`<@\` and \`>\` is that person's Slack member ID — use it directly as tool input (e.g. \`user_id\` for \`allow_user\`, or \`remember_person\`).
- The author's own identity is in the \`[Slack User: <@ID> | ID: ...]\` prefix at the top. Do NOT confuse the author with a target mentioned in the body.
- For \`allow_user\` specifically: the \`user_id\` argument MUST come from a \`<@...>\` mention in the CURRENT user message (the one you are responding to). Never pull an ID from earlier in the conversation history, never pull the author's own ID, and NEVER fabricate or guess an ID — if the current message has no body mention, reply asking Daanish to properly @mention the person.
- Example: if the message is \`[Slack User: <@U07EU7KSG3U> | ID: U07EU7KSG3U]\\nmake sure <@U099SAM> can talk to you\`, the target is \`U099SAM\`, not \`U07EU7KSG3U\`. Call \`allow_user({ user_id: "U099SAM", display_name: "<whatever name you know> " })\`.
- If multiple body mentions are present and it is ambiguous which one to add, ask Daanish to clarify rather than guessing.

*Communication — critical, read carefully:*
- You reply directly in Slack threads. You ALWAYS have the ability to post messages in the current conversation and in #tangent-deployments.
- NEVER say "I don't have the ability to send Slack messages" or "I can't ping you directly" — that is 100% false. You live in Slack. You can always reply in the current thread and tag anyone with <@USERID>.
- If someone needs to be alerted, just mention them inline: <@U07EU7KSG3U> for Daanish, etc.
- When you detect a problem (failed deploy, crashed container, degraded service), proactively tag <@U07EU7KSG3U> (Daanish) in your message. Don't wait to be asked.

*Secrets Manager:*
- All production secrets live in AWS Secrets Manager (us-east-1).
- Use \`list_secrets\` whenever someone asks about configured secrets, env vars, credentials, or what's stored — names only, never values.
- When an engineer says a service needs an env var or credential, suggest they check Secrets Manager first using \`list_secrets\` before asking Daanish to add a new one.
- Any authorised user can write and inject secrets. Use \`put_secret\` immediately when asked — no confirmation dialog needed. Use \`inject_secret\` to wire a secret into a running service's task definition.
- *Secret naming convention:* ALL secrets MUST be stored under the \`tangent/\` prefix (e.g. \`tangent/ASANA_PAT\`, not bare \`ASANA_PAT\`). The ECS execution role IAM policy (\`TangentSecretsAccess\`) only grants \`secretsmanager:GetSecretValue\` on \`tangent/*\`. Secrets stored without this prefix will cause \`AccessDeniedException\` at container startup. If a user asks you to store or inject a secret without the prefix, auto-add it. If you see a crash with \`ResourceInitializationError\` + \`AccessDeniedException\` on a secret, the fix is almost always: the secret was stored without the \`tangent/\` prefix.
- NEVER echo a secret value back in Slack, even if you somehow have it. Names only.

*Infrastructure:*
- ECS cluster: tangent (us-east-1)
- GitHub org: Impiricus-AI
- Each deployed service gets a unique ngrok tunnel protected by Google OAuth (@impiricus.com only)
- Defaults: branch = main, port = 8080

*Postgres — Tangent's own database (not an external service):*
- Postgres 15 + pgvector runs on the same EC2 as you (10.40.40.123:5432). This is YOUR infrastructure. Every deployed app container already receives \`DB_HOST=10.40.40.123\` and \`DB_PORT=5432\` as plain env vars at deploy time — no injection needed for those two.
- *Standard DB access pattern for a service:*
  1. The service already has \`DB_HOST\` and \`DB_PORT\` injected automatically.
  2. For the password: run \`inject_secret DB_PASSWORD into <repo>\` — this wires \`tangent/DB_PASSWORD\` from Secrets Manager into the container as \`DB_PASSWORD\`. Done.
  3. Tell the developer: connect using \`DB_HOST\`, \`DB_PORT\`, \`DB_PASSWORD\` env vars. No DATABASE_URL assembly needed unless their framework requires it.
- *Proactive env-var fix during deploy:* when inspecting a repo before deploy (or when a service is crashing), look at the code for DB-related env var names (e.g. \`DATABASE_URL\`, \`POSTGRES_PASSWORD\`, \`PG_PASSWORD\`, \`PGPASSWORD\`, \`DB_PASS\`). If the code uses a name that does NOT match what exists in Secrets Manager, use \`edit_file\` to update the code to the correct name (\`DB_PASSWORD\`) rather than creating a new secret with the wrong name. The goal: code and secrets should always agree on names. Do this automatically as part of the deploy flow without waiting to be asked.
- *Schema awareness:* call \`db_schema\` whenever someone asks about the data model, what tables exist, or what extensions are installed. Don't guess — \`db_schema\` is cheap and authoritative.
- *Querying data:* \`db_query\` runs as a read-only role with a 5s timeout and 50-row cap. Open to any authorised user. Only SELECT/WITH/EXPLAIN/SHOW/VALUES/TABLE statements are allowed; anything destructive is rejected.
- *Cross-referencing code with DB:* combine \`read_file\` + \`db_schema\` / \`db_query\` to answer questions like "does the service use the columns it expects?" or "is this migration safe given the current data?". Use this proactively when debugging.
- *Creating users (Daanish-only):* \`db_create_user\` generates a random 32-char password and posts it directly in the Slack thread. Set \`create_database: true\` for services that need an isolated database.
- *Dropping users (Daanish-only):* \`db_drop_user\` is destructive and irreversible. Always confirm before invoking.
- *Refusal pattern:* if a non-Daanish user asks to create or drop a DB user, refuse politely and tell them to ping Daanish.

*Bash on the host (Daanish-only, DM-only — high-risk tool, read carefully):*
- You CAN execute bash commands directly on the Tangent EC2 (10.40.40.123). You run on this same host, so SSH is unnecessary for ops tasks like editing pg_hba.conf, reloading services, tailing /var/log, running pg_dump, checking systemd, etc.
- HARD GATES — the \`bash\` tool will refuse to run unless ALL of these are true:
  1. The caller is Daanish (U07EU7KSG3U). For anyone else, refuse politely and tell them to ping Daanish.
  2. The conversation is a DM with you (not a public/private channel, not a thread). For channel requests, ask Daanish to DM you instead.
  3. Daanish replies "yes" to the confirmation prompt that shows the exact command. (This part is enforced in code; you don't need to re-prompt yourself.)
- WHEN to use bash: edit \`/etc/postgresql/*/main/pg_hba.conf\`, run \`sudo -u postgres psql -c "SELECT pg_reload_conf();"\`, \`sudo systemctl status\`, \`df -h\`, \`tail -n 200 /var/log/...\`, \`pg_dump\`, \`sudo apt-get install ...\` (after explicit Daanish confirmation), \`pm2 logs\`, etc.
- WHEN NOT to use bash:
  - Don't use it to modify Tangent's own source — use \`edit_self\` / \`push_self\` / \`read_self\` so the change goes through git history.
  - Don't use it to bypass other tools — if there's a structured tool for the action (\`deploy\`, \`db_drop_user\`, \`inject_secret\`, etc.), use that. The structured tool has gates and audit trails this tool doesn't.
  - Don't use it to inspect repo files — use \`read_file\` so the LLM can read the file content cleanly.
  - Don't use it for routine reads when a dedicated tool exists (status, list_services, list_secrets, db_schema, db_query).
- Always include a short \`reason\` explaining what the command does — that text is shown to Daanish verbatim on the confirmation prompt, so make it informative.
- Tangent runs as user \`ubuntu\`, which has passwordless \`sudo\`. \`sudo\` works for any command. Be deliberate.
- The tool returns stdout, stderr, and exit code (truncated to 8KB each). If you need MORE output, narrow with \`grep\`/\`tail\`/\`wc -l\` — don't ask Daanish to redo the call.
- Default timeout is 60s; bump up to 600s for slow ops like \`pg_dump\` of a large database. Don't go higher than you need.

*Self-editing — you can modify your OWN source code:*
- There are four special tools — \`read_self\`, \`list_self_commits\`, \`edit_self\`, \`push_self\` — that target *Tangent's own* GitHub repository (the code that runs you).
- These are *Daanish-only* AND *DM-only*. If anyone else asks, or if the request comes from a channel/thread instead of a DM, refuse and explain why. The runtime will reject it regardless, so do not pretend.
- Use these when Daanish says things like "fix your own X", "update your Y handler", "swap this in your config", "read your slack-bot.ts". They are NOT for any other repo in the Impiricus-AI org — use \`read_file\`/\`edit_file\`/\`push_file\` for those.
- Prefer \`edit_self\` over \`push_self\` whenever possible — same reasoning as \`edit_file\` vs \`push_file\`. A server-side find/replace cannot be truncated by your generation budget.
- After any self-edit commits to main, the running Tangent process on EC2 is still on the OLD code until someone pulls + rebuilds + \`pm2 restart tangent\`. Always remind Daanish of that in your reply so he knows to redeploy.

*Slack formatting — critical:*
- Use Slack mrkdwn, NOT standard Markdown.
- Bold: *text* (single asterisk only — NEVER **double**)
- Italic: _text_
- Code inline: \`code\`
- Code block: \`\`\`code\`\`\`
- Lists: use dashes (-)
- No # headers
- Never use **double asterisks** — they show as literal asterisks in Slack`;

// ─── Retry helper ────────────────────────────────────────────────────────────

/**
 * Wrap any Anthropic API call with exponential backoff retry logic.
 *
 * Retries on:
 *   - 529 overloaded_error  (API temporarily overwhelmed)
 *   - 429 rate_limit_error  (too many requests)
 *
 * Does NOT retry on 4xx auth/validation errors or 5xx server errors
 * that aren't transient (the SDK sets x-should-retry for us to check).
 *
 * Delays: 1s → 2s → 4s (3 attempts total, then throws)
 */
async function withRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
  const MAX_ATTEMPTS = 3;
  const BASE_DELAY_MS = 1_000;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      const isRetryable =
        err instanceof Error &&
        'status' in err &&
        (err as { status: number }).status === 529 ||
        err instanceof Error &&
        'status' in err &&
        (err as { status: number }).status === 429;

      if (!isRetryable || attempt === MAX_ATTEMPTS) {
        throw err;
      }

      const delayMs = BASE_DELAY_MS * Math.pow(2, attempt - 1);
      logger.warn(
        { action: `ai:retry`, label, attempt, delayMs, status: (err as { status?: number }).status },
        `Anthropic API transient error — retrying in ${delayMs}ms`,
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  // TypeScript can't prove the loop always returns/throws — satisfy the compiler
  throw new Error('withRetry: exhausted attempts');
}

// ─── Core: processMessage ─────────────────────────────────────────────────────

/**
 * Process a user message with full conversation history.
 *
 * Claude either calls a DevOps tool or responds conversationally.
 * No separate intent-classification step — Claude IS the router.
 */
export async function processMessage(
  message: string,
  history: ConversationTurn[] = [],
): Promise<AgentResponse> {
  logger.info(
    { action: 'ai:process_message', historyLength: history.length, preview: message.slice(0, 80) },
    'Processing message',
  );

  try {
    const messages: Anthropic.MessageParam[] = [
      ...history.map((t) => ({ role: t.role as 'user' | 'assistant', content: t.content })),
      { role: 'user', content: message },
    ];

    const response = await withRetry(() => client().messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      system: buildSystemPrompt(),
      tools: TOOLS,
      messages,
    }), 'processMessage');

    // If Claude called a tool, extract and normalize it
    const toolBlock = response.content.find((b) => b.type === 'tool_use');
    if (toolBlock && toolBlock.type === 'tool_use') {
      // If generation was cut off mid-tool-use, the input JSON is incomplete —
      // refuse to execute and tell the user.
      if (response.stop_reason === 'max_tokens') {
        logger.warn(
          { action: 'ai:tool_call:truncated', tool: toolBlock.name },
          'Tool call hit max_tokens — refusing to execute partial call',
        );
        return { type: 'text', text: `I started preparing a \`${toolBlock.name}\` call but ran out of generation room mid-way, so I'm not going to send it — a partial tool call could do the wrong thing. Try breaking the request into a smaller change (e.g. use \`edit_file\` for a targeted edit instead of rewriting a whole file).` };
      }

      const raw = toolBlock.input as Record<string, unknown>;

      // Normalize repo name to lowercase-hyphen format
      if (typeof raw['repo'] === 'string') {
        raw['repo'] = raw['repo'].toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
      }

      logger.info({ action: 'ai:tool_call', tool: toolBlock.name, input: raw }, 'Tool called');

      try {
        const call = buildToolCall(toolBlock.name, raw);
        if (call) return { type: 'tool', call };
      } catch (err) {
        if (err instanceof ToolCallValidationError) {
          logger.warn({ action: 'ai:tool_call:validation', tool: toolBlock.name, msg: err.message }, 'Refused malformed tool call');
          return { type: 'text', text: `⚠️ ${err.message}` };
        }
        throw err;
      }
    }

    // Claude replied with text (general answer, follow-up, greeting, clarification, etc.)
    const textBlock = response.content.find((b) => b.type === 'text');
    const reply = textBlock?.type === 'text' ? textBlock.text : "I didn't quite catch that — could you rephrase?";

    logger.info({ action: 'ai:text_reply', preview: reply.slice(0, 80) }, 'Text reply');
    return { type: 'text', text: reply };
  } catch (err) {
    logger.error({ action: 'ai:process_message:failed', err }, 'processMessage failed');
    return { type: 'text', text: 'Something went wrong on my end — please try again.' };
  }
}

function buildToolCall(name: string, raw: Record<string, unknown>): AgentToolCall | null {
  switch (name) {
    case 'deploy':
      return {
        name: 'deploy',
        input: {
          repo:     String(raw['repo'] ?? ''),
          branch:   String(raw['branch'] ?? 'main'),
          port:     Number(raw['port'] ?? 8080),
          freshUrl: raw['freshUrl'] === true,
        },
      };
    case 'teardown':
      return { name: 'teardown', input: { repo: String(raw['repo'] ?? '') } };
    case 'status':
      return { name: 'status', input: { repo: String(raw['repo'] ?? '') } };
    case 'list_services':
      return { name: 'list_services', input: {} as Record<string, never> };
    case 'list_repos':
      return { name: 'list_repos', input: {} as Record<string, never> };
    case 'inspect_repo':
      return { name: 'inspect_repo', input: { repo: String(raw['repo'] ?? '') } };
    case 'cve_scan':
      return { name: 'cve_scan', input: {} as Record<string, never> };
    case 'discover_config':
      return { name: 'discover_config', input: {} as Record<string, never> };
    case 'logs':
      return { name: 'logs', input: { repo: String(raw['repo'] ?? ''), container: raw['container'] ? String(raw['container']) : 'ngrok' } };
    case 'clear_logs':
      return { name: 'clear_logs', input: { repo: String(raw['repo'] ?? ''), container: raw['container'] ? String(raw['container']) : 'ngrok' } };
    case 'push_file': {
      // Validate strictly. An empty/missing `content` here almost always means
      // generation got truncated mid-string by max_tokens — emitting the call
      // anyway would land an empty file on main (the asana-hubspot-webhook bug).
      const repo = String(raw['repo'] ?? '');
      const path = String(raw['path'] ?? '');
      const rawContent = raw['content'];
      if (!repo || !path) {
        throw new ToolCallValidationError(`push_file is missing required fields (repo / path).`);
      }
      if (typeof rawContent !== 'string') {
        throw new ToolCallValidationError(
          `push_file for \`${path}\` arrived with no \`content\` field — looks like generation was truncated. Refusing to push. Try edit_file for small changes, or ask me to retry.`,
        );
      }
      if (rawContent.trim().length === 0) {
        throw new ToolCallValidationError(
          `push_file for \`${path}\` arrived with empty content — refusing to commit an empty file. If you really meant to truncate \`${path}\`, say so explicitly. Otherwise use edit_file for targeted changes.`,
        );
      }
      return { name: 'push_file', input: {
        repo,
        path,
        content: rawContent,
        message: raw['message'] ? String(raw['message']) : undefined,
        branch:  raw['branch']  ? String(raw['branch'])  : 'main',
      }};
    }
    case 'edit_file': {
      const repo    = String(raw['repo'] ?? '');
      const path    = String(raw['path'] ?? '');
      const find    = raw['find'];
      const replace = raw['replace'];
      if (!repo || !path) {
        throw new ToolCallValidationError(`edit_file is missing required fields (repo / path).`);
      }
      if (typeof find !== 'string' || find.length === 0) {
        throw new ToolCallValidationError(`edit_file for \`${path}\` is missing the \`find\` string.`);
      }
      if (typeof replace !== 'string') {
        throw new ToolCallValidationError(`edit_file for \`${path}\` is missing the \`replace\` string.`);
      }
      return { name: 'edit_file', input: {
        repo,
        path,
        find,
        replace,
        replace_all: raw['replace_all'] === true,
        message: raw['message'] ? String(raw['message']) : undefined,
        branch:  raw['branch']  ? String(raw['branch'])  : 'main',
      }};
    }
    case 'allow_user':
      return { name: 'allow_user', input: {
        user_id:      String(raw['user_id']      ?? ''),
        display_name: String(raw['display_name'] ?? ''),
      }};
    case 'inject_secret':
      return { name: 'inject_secret', input: {
        repo:        String(raw['repo']        ?? ''),
        secret_name: String(raw['secret_name'] ?? ''),
      }};
    case 'remember_person':
      return { name: 'remember_person', input: {
        user_id: String(raw['user_id'] ?? ''),
        name:    String(raw['name']    ?? ''),
        note:    String(raw['note']    ?? ''),
      }};
    case 'list_secrets':
      return { name: 'list_secrets', input: {} as Record<string, never> };
    case 'read_file':
      return { name: 'read_file', input: {
        repo: String(raw['repo'] ?? ''),
        path: String(raw['path'] ?? ''),
        ref:  raw['ref'] ? String(raw['ref']) : undefined,
      }};
    case 'list_commits':
      return { name: 'list_commits', input: {
        repo:  String(raw['repo'] ?? ''),
        path:  raw['path']  ? String(raw['path'])  : undefined,
        limit: raw['limit'] ? Number(raw['limit'])  : 20,
      }};
    case 'restore_file':
      return { name: 'restore_file', input: {
        repo:    String(raw['repo']    ?? ''),
        path:    String(raw['path']    ?? ''),
        ref:     String(raw['ref']     ?? ''),
        message: raw['message'] ? String(raw['message']) : undefined,
      }};
    case 'read_self':
      return { name: 'read_self', input: {
        path: String(raw['path'] ?? ''),
        ref:  raw['ref'] ? String(raw['ref']) : undefined,
      }};
    case 'list_self_commits':
      return { name: 'list_self_commits', input: {
        path:  raw['path']  ? String(raw['path'])  : undefined,
        limit: raw['limit'] ? Number(raw['limit'])  : 20,
      }};
    case 'edit_self': {
      const path    = String(raw['path'] ?? '');
      const find    = raw['find'];
      const replace = raw['replace'];
      if (!path) {
        throw new ToolCallValidationError(`edit_self is missing the \`path\` field.`);
      }
      if (typeof find !== 'string' || find.length === 0) {
        throw new ToolCallValidationError(`edit_self for \`${path}\` is missing the \`find\` string.`);
      }
      if (typeof replace !== 'string') {
        throw new ToolCallValidationError(`edit_self for \`${path}\` is missing the \`replace\` string.`);
      }
      return { name: 'edit_self', input: {
        path,
        find,
        replace,
        replace_all: raw['replace_all'] === true,
        message: raw['message'] ? String(raw['message']) : undefined,
      }};
    }
    case 'push_self': {
      const path = String(raw['path'] ?? '');
      const rawContent = raw['content'];
      if (!path) {
        throw new ToolCallValidationError(`push_self is missing the \`path\` field.`);
      }
      if (typeof rawContent !== 'string') {
        throw new ToolCallValidationError(
          `push_self for \`${path}\` arrived with no \`content\` field — looks like generation was truncated. Refusing to push.`,
        );
      }
      if (rawContent.trim().length === 0) {
        throw new ToolCallValidationError(
          `push_self for \`${path}\` arrived with empty content — refusing to commit an empty file. Use edit_self for targeted changes.`,
        );
      }
      return { name: 'push_self', input: {
        path,
        content: rawContent,
        message: raw['message'] ? String(raw['message']) : undefined,
      }};
    }
    case 'put_secret':
      return { name: 'put_secret', input: {
        name:        String(raw['name']        ?? ''),
        value:       String(raw['value']       ?? ''),
        description: raw['description'] ? String(raw['description']) : undefined,
      }};
    case 'db_schema':
      return { name: 'db_schema', input: {} as Record<string, never> };
    case 'db_query':
      return { name: 'db_query', input: { sql: String(raw['sql'] ?? '') } };
    case 'db_list_users':
      return { name: 'db_list_users', input: {} as Record<string, never> };
    case 'db_create_user':
      return { name: 'db_create_user', input: {
        username:        String(raw['username'] ?? ''),
        create_database: raw['create_database'] === true,
      }};
    case 'db_drop_user':
      return { name: 'db_drop_user', input: {
        username:      String(raw['username'] ?? ''),
        drop_database: raw['drop_database'] === true,
      }};
    case 'bash': {
      const command = String(raw['command'] ?? '').trim();
      const reason  = String(raw['reason']  ?? '').trim();
      if (!command) throw new ToolCallValidationError('bash: `command` is required and must be non-empty');
      if (!reason)  throw new ToolCallValidationError('bash: `reason` is required — describe what this command does so the confirmation prompt is human-readable');
      // Cap timeout at 600s; default 60s.
      let timeoutSeconds = raw['timeout_seconds'] !== undefined ? Number(raw['timeout_seconds']) : 60;
      if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) timeoutSeconds = 60;
      if (timeoutSeconds > 600) timeoutSeconds = 600;
      return { name: 'bash', input: { command, reason, timeout_seconds: timeoutSeconds } };
    }
    default:
      logger.warn({ action: 'ai:unknown_tool', name }, 'Claude called an unknown tool');
      return null;
  }
}

// ─── Tool result synthesis ────────────────────────────────────────────────────

/**
 * After a tool has been executed, feed the raw result back to Claude
 * so it can answer the user's question conversationally instead of
 * just dumping raw data.
 *
 * This uses the proper Anthropic tool_use → tool_result → response cycle:
 *   1. We replay the assistant's tool_use turn
 *   2. We inject the tool_result
 *   3. Claude produces a natural language reply
 */
export async function synthesizeToolResult(
  call: AgentToolCall,
  toolResult: string,
  userMessage: string,
  history: ConversationTurn[],
): Promise<string> {
  logger.info({ action: 'ai:synthesize', tool: call.name }, 'Synthesizing tool result into answer');

  try {
    const toolUseId = `tu_${call.name}`;

    const messages: Anthropic.MessageParam[] = [
      ...history.map((t) => ({ role: t.role as 'user' | 'assistant', content: t.content })),
      { role: 'user', content: userMessage },
      {
        role: 'assistant',
        content: [{
          type: 'tool_use' as const,
          id: toolUseId,
          name: call.name,
          input: call.input as Record<string, unknown>,
        }],
      },
      {
        role: 'user',
        content: [{
          type: 'tool_result' as const,
          tool_use_id: toolUseId,
          content: toolResult,
        }],
      },
    ];

    const response = await withRetry(() => client().messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      system: buildSystemPrompt(),
      tools: TOOLS,
      messages,
    }), 'synthesizeToolResult');

    const textBlock = response.content.find((b) => b.type === 'text');
    const reply = textBlock?.type === 'text' ? textBlock.text : toolResult;

    logger.info({ action: 'ai:synthesize:done', preview: reply.slice(0, 80) }, 'Synthesis complete');
    return reply;
  } catch (err) {
    logger.error({ action: 'ai:synthesize:failed', err }, 'Synthesis failed — falling back to raw data');
    return toolResult; // graceful fallback: still show the data
  }
}

/**
 * Like synthesizeToolResult but returns a full AgentResponse — Claude can either
 * reply with text OR call another tool (e.g. inspect_repo → push_file chain).
 *
 * This is what enables multi-step agent loops: after an info tool returns data,
 * Claude can decide to take an action rather than just responding conversationally.
 */
/**
 * A completed step in a tool chain — the call Claude requested, and the
 * result string we got back from executing it.  Used by continueAfterTool
 * to build a proper tool_use/tool_result message sequence.
 */
export interface ToolChainStep {
  call: AgentToolCall;
  result: string;
}

export async function continueAfterTool(
  callOrChain: AgentToolCall | ToolChainStep[],
  toolResult: string | undefined,
  userMessage: string,
  history: ConversationTurn[],
): Promise<AgentResponse> {
  // Normalise to a chain — backwards compatible with the old (call, result)
  // signature so callers who pass a single completed call still work.
  const chain: ToolChainStep[] = Array.isArray(callOrChain)
    ? callOrChain
    : [{ call: callOrChain, result: toolResult ?? '' }];

  if (chain.length === 0) {
    throw new Error('continueAfterTool: chain is empty');
  }

  logger.info(
    { action: 'ai:continue_after_tool', chain: chain.map((s) => s.call.name) },
    'Checking for follow-up action',
  );

  const lastResult = chain[chain.length - 1].result;

  try {
    // Build messages: history → user msg → for each chain step,
    // assistant tool_use → user tool_result.  This is the canonical Claude
    // tool-use format; sending settled calls as plain text confuses the
    // model into thinking they haven't been completed yet (which produced
    // the "Tangent saves the same secret 3 times" loop).
    const messages: Anthropic.MessageParam[] = [
      ...history.map((t) => ({ role: t.role as 'user' | 'assistant', content: t.content })),
      { role: 'user', content: userMessage },
    ];

    chain.forEach((step, idx) => {
      const toolUseId = `tu_${step.call.name}_${idx}`;
      messages.push({
        role: 'assistant',
        content: [{
          type: 'tool_use' as const,
          id: toolUseId,
          name: step.call.name,
          input: step.call.input as Record<string, unknown>,
        }],
      });
      messages.push({
        role: 'user',
        content: [{
          type: 'tool_result' as const,
          tool_use_id: toolUseId,
          content: step.result,
        }],
      });
    });

    const response = await withRetry(() => client().messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 8192,
      system: buildSystemPrompt(),
      tools: TOOLS,
      messages,
    }), 'continueAfterTool');

    // Claude may respond with a tool call (next action) or text (done)
    const toolUseBlock = response.content.find((b) => b.type === 'tool_use');
    if (toolUseBlock?.type === 'tool_use') {
      // Truncated chained tool call → refuse. This is the exact failure mode that
      // produced the empty-main.py incident: a chained push_file got cut off
      // mid-content and was executed with an empty string.
      if (response.stop_reason === 'max_tokens') {
        logger.warn(
          { action: 'ai:continue_after_tool:truncated', tool: toolUseBlock.name },
          'Chained tool call hit max_tokens — refusing partial execution',
        );
        const lastCallName = chain[chain.length - 1].call.name;
        return {
          type: 'text',
          text: `I started chaining a \`${toolUseBlock.name}\` after \`${lastCallName}\` but ran out of room before finishing, so I won't send it — a half-formed call could overwrite a file with the wrong contents. If you wanted a small change to an existing file, use \`edit_file\` (it's a find/replace that runs server-side).`,
        };
      }

      try {
        const nextCall = buildToolCall(toolUseBlock.name, toolUseBlock.input as Record<string, unknown>);
        if (nextCall) {
          logger.info({ action: 'ai:continue_after_tool:tool_call', next: nextCall.name }, 'Claude chaining to next tool');
          return { type: 'tool', call: nextCall };
        }
      } catch (err) {
        if (err instanceof ToolCallValidationError) {
          logger.warn({ action: 'ai:continue_after_tool:validation', tool: toolUseBlock.name, msg: err.message }, 'Refused malformed chained tool call');
          return { type: 'text', text: `⚠️ ${err.message}` };
        }
        throw err;
      }
    }

    const textBlock = response.content.find((b) => b.type === 'text');
    const reply = textBlock?.type === 'text' ? textBlock.text : lastResult;
    return { type: 'text', text: reply };
  } catch (err) {
    logger.error({ action: 'ai:continue_after_tool:failed', err }, 'continueAfterTool failed');
    return { type: 'text', text: lastResult };
  }
}

// ─── Consent classifier ───────────────────────────────────────────────────────

/**
 * Classify whether a message expresses consent, cancellation, or neither.
 *
 * Fast regex handles the obvious cases. Claude (haiku) handles everything else —
 * so natural phrases like "go for it", "green light", "sounds good", "approved",
 * "hold off", "not right now" all work correctly.
 *
 * Returns: 'confirm' | 'cancel' | 'other'
 */
export async function classifyConsent(text: string): Promise<'confirm' | 'cancel' | 'other'> {
  const t = text.trim();

  // Fast path — obvious single-word / short-phrase confirmations
  if (/^(yes|yeah|yep|yup|y|ok|okay|sure|go|do it|ship it|send it|confirmed|approve[d]?|green light|lets go|let's go|proceed|execute|run it|fire|go ahead|absolutely|of course|for sure|looks good|lgtm|👍|✅)[\s!.]*$/i.test(t)) {
    return 'confirm';
  }
  // Fast path — obvious cancellations
  if (/^(no|nope|nah|n|cancel|stop|abort|never mind|nevermind|hold off|not now|wait|don't|dont|skip it|❌|🚫)[\s!.]*$/i.test(t)) {
    return 'cancel';
  }

  // Anything longer or ambiguous — ask Claude haiku (fast, cheap)
  try {
    const res = await withRetry(() => client().messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 5,
      system: 'You are a yes/no intent classifier. The user was just asked to approve or cancel a DevOps action (e.g. a deploy). Classify their response as:\n- "confirm": they clearly agree/approve (e.g. "sounds good", "go for it", "green light", "lgtm")\n- "cancel": they clearly decline or want to stop/wait (e.g. "hold off", "wait", "not now", "never mind")\n- "other": they are asking a question, changing the request, or saying something unrelated\nIf the message mentions a different repo, branch, port, or any new parameters → always "other".\nReply with exactly one word.',
      messages: [{ role: 'user', content: t }],
    }), 'classifyConsent');
    const word = ((res.content[0] as { type: string; text?: string }).text ?? '').trim().toLowerCase();
    if (word.startsWith('confirm')) return 'confirm';
    if (word.startsWith('cancel'))  return 'cancel';
    return 'other';
  } catch {
    return 'other'; // safe fallback: treat as new message
  }
}

// ─── Post-deploy failure diagnosis ───────────────────────────────────────────

/**
 * Called automatically by the post-deploy health watcher when a service
 * crashes (0 running tasks detected within 5 minutes of deploy).
 *
 * Reads app + ngrok logs and returns a concise root cause + fix suggestion
 * formatted as Slack mrkdwn.
 */
export async function diagnoseServiceFailure(
  repo: string,
  appLogs: string,
  ngrokLogs: string,
  expectedUrl?: string,
): Promise<string> {
  logger.info({ action: 'ai:diagnose_failure', repo }, 'Diagnosing service failure from logs');
  try {
    const msg = await withRetry(() => client().messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 600,
      messages: [{
        role: 'user',
        content: [
          `The ECS Fargate service for "${repo}" has 0 running tasks after a fresh deploy.`,
          expectedUrl ? `Expected ngrok URL: ${expectedUrl}` : '',
          ``,
          `APP CONTAINER LOGS (last 50 lines):`,
          appLogs.slice(0, 2500),
          ``,
          `NGROK CONTAINER LOGS (last 50 lines):`,
          ngrokLogs.slice(0, 1500),
          ``,
          `Identify the root cause from the logs. In 2-4 sentences: explain what went wrong, what specific error triggered it, and the exact fix. Be concrete — mention file names, env vars, port numbers, or package names if they appear.`,
          `Use Slack mrkdwn (*bold* for key terms, \`code\` for literals). No preamble.`,
        ].filter(Boolean).join('\n'),
      }],
    }), 'diagnoseServiceFailure');
    const block = msg.content[0];
    return block.type === 'text' ? block.text : 'Could not diagnose — check CloudWatch logs manually.';
  } catch (err) {
    logger.error({ action: 'ai:diagnose_failure:failed', err }, 'Diagnosis failed');
    return 'Could not auto-diagnose — check CloudWatch logs manually.';
  }
}

// ─── Auto-fix helpers (used by post-deploy health check) ─────────────────────

/**
 * Given a crash diagnosis and the repo's top-level file list, ask Claude
 * which single file should be edited to fix the issue.
 * Returns the relative file path (e.g. "server.js") or null if the fix
 * requires multiple files or can't be determined.
 */
export async function identifyFileToFix(
  repo: string,
  diagnosis: string,
  topLevelFiles: string[],
): Promise<string | null> {
  logger.info({ action: 'ai:identify_file', repo }, 'Identifying file to fix');
  try {
    const msg = await withRetry(() => client().messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 100,
      messages: [{
        role: 'user',
        content: [
          `A deployed service for repo "${repo}" crashed on startup.`,
          ``,
          `Diagnosis: ${diagnosis}`,
          ``,
          `Top-level files in the repo: ${topLevelFiles.join(', ')}`,
          ``,
          `Which single file should be edited to fix this issue?`,
          `Reply with ONLY the file path relative to repo root (e.g. "server.js" or "src/app.ts").`,
          `If the fix requires more than one file, or you cannot determine the right file from the logs, reply with exactly: none`,
        ].join('\n'),
      }],
    }), 'identifyFileToFix');
    const block = msg.content[0];
    const filePath = (block.type === 'text' ? block.text : '').trim().replace(/^["']|["']$/g, '');
    if (!filePath || filePath.toLowerCase() === 'none') return null;
    logger.info({ action: 'ai:identify_file:result', repo, filePath }, 'File identified');
    return filePath;
  } catch {
    return null;
  }
}

/**
 * Given the current content of a file and the crash diagnosis, generate a
 * minimal fix and return the complete corrected file content.
 *
 * Returns { newContent, description } or null if Claude can't produce a
 * confident fix (e.g. the fix requires external context or config changes).
 */
export async function generateCodeFix(
  repo: string,
  filePath: string,
  fileContent: string,
  diagnosis: string,
): Promise<{ newContent: string; description: string } | null> {
  logger.info({ action: 'ai:generate_fix', repo, filePath }, 'Generating code fix');
  try {
    const msg = await withRetry(() => client().messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      messages: [{
        role: 'user',
        content: [
          `The deployed service for repo "${repo}" crashed. Fix \`${filePath}\` to resolve the issue.`,
          ``,
          `Diagnosis: ${diagnosis}`,
          ``,
          `Current file content:`,
          '```',
          fileContent,
          '```',
          ``,
          `Rules:`,
          `- Make the minimal change necessary — do not refactor or reorganise unrelated code.`,
          `- If the fix requires changes to package.json versions, environment variables, secrets, or infrastructure, reply with exactly: CANNOT_FIX`,
          `- Otherwise respond with a JSON object (no markdown fences) with exactly two fields:`,
          `  { "newContent": "<complete fixed file>", "description": "<one sentence describing the change>" }`,
        ].join('\n'),
      }],
    }), 'generateCodeFix');
    const block = msg.content[0];
    if (block.type !== 'text') return null;

    const text = block.text.trim();
    if (text === 'CANNOT_FIX') {
      logger.info({ action: 'ai:generate_fix:cannot_fix', repo, filePath }, 'Claude determined fix is out of scope');
      return null;
    }

    // Strip optional markdown code fences
    const json = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
    const parsed = JSON.parse(json) as { newContent: string; description: string };
    if (!parsed.newContent || !parsed.description) return null;

    logger.info({ action: 'ai:generate_fix:done', repo, filePath, description: parsed.description }, 'Fix generated');
    return { newContent: parsed.newContent, description: parsed.description };
  } catch (err) {
    logger.warn({ action: 'ai:generate_fix:failed', err }, 'Code fix generation failed');
    return null;
  }
}

// ─── Pre-deploy repo analysis ─────────────────────────────────────────────────

export interface DeployBlocker {
  issue: string;
  fix: string;
}

export interface DeployWarning {
  issue: string;
  suggestion: string;
}

export interface DeployAnalysis {
  eligible: boolean;
  detectedPort: number | null;
  blockers: DeployBlocker[];
  warnings: DeployWarning[];
  /** Ready-to-paste Claude Code prompt. null when eligible. */
  claudeCodePrompt: string | null;
}

/**
 * Run a structured eligibility check on a repo before deploying.
 * Returns blockers (hard stops), warnings (noted but not blocking),
 * the detected port, and a copy-paste Claude Code prompt when blockers exist.
 */
export async function analyzeDeployEligibility(
  repo: string,
  repoData: {
    files: string[];
    dockerfile: string | null;
    exposedPort: number | null;
    packageJson: string | null;
    requirementsTxt: string | null;
    readme: string | null;
    envExample: string | null;
    dockerCompose: string | null;
    claudeMd: string | null;
    entryPoint: string | null;
  },
): Promise<DeployAnalysis> {
  logger.info({ action: 'ai:analyze_deploy', repo }, 'Analyzing repo deploy eligibility');

  const dataSection = [
    `REPO: ${repo}`,
    `TOP-LEVEL FILES: ${repoData.files.join(', ')}`,
    repoData.dockerfile      ? `\nDOCKERFILE:\n${repoData.dockerfile}`               : '\nDOCKERFILE: (not found)',
    repoData.packageJson     ? `\nPACKAGE.JSON:\n${repoData.packageJson}`             : '',
    repoData.requirementsTxt ? `\nREQUIREMENTS.TXT:\n${repoData.requirementsTxt}`     : '',
    repoData.envExample      ? `\n.ENV.EXAMPLE:\n${repoData.envExample}`              : '',
    repoData.dockerCompose   ? `\nDOCKER-COMPOSE.YML:\n${repoData.dockerCompose}`     : '',
    repoData.claudeMd        ? `\nCLAUDE.MD:\n${repoData.claudeMd}`                   : '',
    repoData.readme          ? `\nREADME (first 1500 chars):\n${repoData.readme.slice(0, 1500)}` : '',
    repoData.entryPoint      ? `\nMAIN ENTRY POINT (first 2000 chars):\n${repoData.entryPoint.slice(0, 2000)}` : '',
  ].filter(Boolean).join('\n');

  const systemPrompt = `You are a DevOps readiness checker for AWS ECS Fargate deployments via Tangent.

TANGENT'S DEPLOYMENT MODEL (know this cold):
- Docker build → push to ECR → ECS Fargate task (two containers: app + ngrok sidecar)
- Fargate = NO persistent disk, NO filesystem mounts, NO docker-compose sidecars in prod
- Every app container automatically receives: DB_HOST=10.40.40.123, DB_PORT=5432 as plain env vars
- Secrets (passwords, tokens, API keys) come from AWS Secrets Manager injected as individual env vars
  (e.g. DB_PASSWORD, SLACK_BOT_TOKEN, ANTHROPIC_API_KEY — NOT as files, NOT as volumes)
- ANTHROPIC_API_KEY is injected automatically into every container
- ngrok tunnel handles all inbound HTTP traffic
- The app MUST bind to 0.0.0.0 (not 127.0.0.1 / localhost)

BLOCKERS — set eligible=false if ANY of these are present:
1. No Dockerfile in the repo
2. Dockerfile has no CMD and no ENTRYPOINT
3. App server binds only to 127.0.0.1 or localhost (not 0.0.0.0)
4. File-path credentials: GOOGLE_APPLICATION_CREDENTIALS or similar set to a JSON file path
5. Hard-coded localhost service URLs (DB, Redis, etc.) that aren't read from env vars

WARNINGS — eligible=true but surface these:
1. DATABASE_URL composite string (works if injected as a secret but DB_HOST/DB_PORT/DB_PASSWORD is preferred)
2. docker-compose.yml defines services (redis, postgres, mongo, etc.) that won't run in ECS
3. EXPOSE missing from Dockerfile (Tangent will have to guess the port)
4. Env vars in .env.example that Tangent can't provide automatically (non-DB, non-Anthropic secrets)

OUTPUT: Return ONLY valid JSON, no markdown fences, matching exactly this schema:
{
  "eligible": boolean,
  "detectedPort": number | null,
  "blockers": [{ "issue": "concise description", "fix": "specific fix with file names + what to change" }],
  "warnings": [{ "issue": "concise description", "suggestion": "what to do about it" }],
  "claudeCodePrompt": string | null
}

claudeCodePrompt rules (when eligible=false):
- Write it as if you are briefing a developer who will paste it into Claude Code inside the repo
- Start with: "Fix this repo for AWS ECS Fargate deployment via Tangent."
- List each blocker with the specific file, the problem, and the exact code change needed
- Mention Tangent's automatic env vars: DB_HOST=10.40.40.123, DB_PORT=5432, DB_PASSWORD (injected via Tangent), ANTHROPIC_API_KEY (auto-injected)
- End with: "Once fixed, ask Tangent in Slack to deploy again."
- Keep it under 400 words, very actionable
- When eligible=true, set claudeCodePrompt to null`;

  try {
    const response = await withRetry(() => client().messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1500,
      system: systemPrompt,
      messages: [{ role: 'user', content: dataSection }],
    }), 'analyzeDeployEligibility');

    const block = response.content.find((b) => b.type === 'text');
    const raw = block?.type === 'text' ? block.text.trim() : '';

    // Strip any accidental markdown fences
    const json = raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
    const parsed = JSON.parse(json) as DeployAnalysis;

    // Normalise fields so callers can always trust the shape
    return {
      eligible:         Boolean(parsed.eligible),
      detectedPort:     parsed.detectedPort != null ? Number(parsed.detectedPort) : null,
      blockers:         Array.isArray(parsed.blockers)  ? parsed.blockers  : [],
      warnings:         Array.isArray(parsed.warnings)  ? parsed.warnings  : [],
      claudeCodePrompt: parsed.claudeCodePrompt ?? null,
    };
  } catch (err) {
    logger.error({ action: 'ai:analyze_deploy:failed', err }, 'Deploy analysis failed — allowing deploy to proceed');
    // If the analysis itself crashes, don't block the deploy — fail open.
    return {
      eligible:         true,
      detectedPort:     repoData.exposedPort,
      blockers:         [],
      warnings:         [{ issue: 'Pre-deploy analysis failed', suggestion: 'Check logs; deploy proceeding anyway.' }],
      claudeCodePrompt: null,
    };
  }
}

// ─── Error summarizers (used by build.ts and deploy flow) ────────────────────

/**
 * Summarize a Docker build failure into a short, actionable message.
 */
export async function summarizeBuildError(stderr: string, repo: string): Promise<string> {
  logger.info({ action: 'ai:summarize_build_error', repo }, 'Requesting build error summary');
  try {
    const msg = await withRetry(() => client().messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 300,
      messages: [{
        role: 'user',
        content: `A Docker build for the repo "${repo}" failed. Here is the build output:\n\`\`\`\n${stderr.slice(0, 4000)}\n\`\`\`\n\nIn 1-3 sentences, explain what went wrong and what the engineer should do to fix it. Be specific — mention file names, package names, or version numbers if they appear. No preamble.`,
      }],
    }), 'summarizeBuildError');
    const block = msg.content[0];
    return block.type === 'text' ? block.text : 'Build failed — check the raw error output for details.';
  } catch {
    return 'Build failed — check the raw error output for details.';
  }
}

/**
 * Summarize a deploy-step failure into a short, actionable message.
 */
export async function summarizeDeployError(errorMessage: string, context: string): Promise<string> {
  logger.info({ action: 'ai:summarize_deploy_error' }, 'Requesting deploy error summary');
  try {
    const msg = await withRetry(() => client().messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 200,
      messages: [{
        role: 'user',
        content: `A deployment step failed.\n\nContext: ${context}\n\nError:\n${errorMessage.slice(0, 2000)}\n\nIn 1-2 sentences, explain the problem and how to fix it. No preamble.`,
      }],
    }), 'summarizeDeployError');
    const block = msg.content[0];
    return block.type === 'text' ? block.text : errorMessage;
  } catch {
    return errorMessage;
  }
}
