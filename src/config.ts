/**
 * config.ts
 *
 * Loads non-secret configuration from environment variables and fetches
 * secret values from AWS Secrets Manager at startup. Exports a single
 * typed `config` object that every other module imports.
 *
 * Call `loadConfig()` once at startup before anything else.
 */

import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { execSync } from 'child_process';
import { resolve } from 'path';
import { logger } from './utils/logger.js';

// Use process.cwd() — always the project root when run via pm2.
// __dirname cannot be used here because rootDir="src" + outDir="dist" puts
// the compiled file at dist/config.js, making relative paths one level off.
const PROJECT_ROOT       = process.cwd();
const ALLOWED_USERS_FILE = resolve(PROJECT_ROOT, 'config/allowed_users.json');
const PEOPLE_FILE        = resolve(PROJECT_ROOT, 'config/people.json');

// ─── Types ────────────────────────────────────────────────────────────────────

export interface Config {
  // AWS
  awsRegion: string;
  ecsClusterName: string;
  ecrRepoName: string;
  ecrRepoUri: string; // computed: <accountId>.dkr.ecr.<region>.amazonaws.com/<repoName>
  logGroupName: string;

  // ECS task defaults
  taskCpu: string;
  taskMemory: string;
  defaultAppPort: number;

  // Fargate networking
  fargate: {
    subnets: string[];
    securityGroup: string;
    assignPublicIp: 'ENABLED' | 'DISABLED';
  };

  // IAM
  ecsExecutionRoleArn: string;

  // Secrets (populated at startup from Secrets Manager)
  ngrokAuthtoken: string;
  githubToken: string;
  anthropicApiKey: string;
  slackToken: string;      // xoxb-... bot token
  slackAppToken: string;   // xapp-... app-level token for Socket Mode

  // Slack
  slackChannel: string;
  allowedSlackUserIds: Set<string>; // empty = allow everyone
  peopleNotes: { id: string; name: string; notes: string[] }[];

  // GitHub
  githubOrg: string;
  scaffoldChildTopic: string;

  // Server
  port: number;
  host: string;

  // Workspace
  workspaceDir: string;
}

// ─── Module-level singleton ───────────────────────────────────────────────────

// Starts as partial; fully populated after loadConfig() resolves.
let _config: Config | null = null;

export function config(): Config {
  if (!_config) {
    throw new Error('config() called before loadConfig() completed');
  }
  return _config;
}

/** Dynamically add a Slack user ID to the allowed list at runtime, and persist to GitHub. */
export function allowUser(userId: string): void {
  config().allowedSlackUserIds.add(userId);

  // Persist to config/allowed_users.json and push to GitHub so it survives redeploys
  try {
    let existing: string[] = [];
    try {
      existing = (JSON.parse(readFileSync(ALLOWED_USERS_FILE, 'utf8')) as { allowedUserIds: string[] }).allowedUserIds;
    } catch { /* file missing or malformed — start fresh */ }

    if (!existing.includes(userId)) {
      existing.push(userId);
      writeFileSync(ALLOWED_USERS_FILE, JSON.stringify({ allowedUserIds: existing }, null, 2));

      execSync(
        `git -C "${PROJECT_ROOT}" add config/allowed_users.json && ` +
        `git -C "${PROJECT_ROOT}" -c user.name="Tangent" -c user.email="tangent@impiricus.com" ` +
        `commit -m "chore: allow user ${userId}" && ` +
        `git -C "${PROJECT_ROOT}" push origin main`,
        { stdio: 'pipe' },
      );
      logger.info({ action: 'config:allow_user:persisted', userId }, 'Allowed user persisted to GitHub');
    }
  } catch (err) {
    // Never let persistence failure break the in-memory grant
    logger.warn({ action: 'config:allow_user:persist_failed', userId, err }, 'Failed to persist allowed user to GitHub');
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Required environment variable ${name} is not set`);
  }
  return value;
}

function optionalEnv(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

async function fetchSecret(client: SecretsManagerClient, secretName: string): Promise<string> {
  const cmd = new GetSecretValueCommand({ SecretId: secretName });
  const response = await client.send(cmd);
  if (!response.SecretString) {
    throw new Error(`Secret ${secretName} exists but has no string value`);
  }
  return response.SecretString;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

/**
 * LOCAL_DEV=true skips AWS Secrets Manager and reads secrets directly from
 * environment variables. Also relaxes AWS-specific required fields so the
 * server can start on a Mac without any AWS credentials.
 *
 * Set in .env:
 *   LOCAL_DEV=true
 *   ANTHROPIC_API_KEY=sk-ant-...
 *   GITHUB_TOKEN=ghp_...
 *   NGROK_AUTHTOKEN=...
 *   SLACK_TOKEN=xoxb-...
 */
const LOCAL_DEV = process.env['LOCAL_DEV'] === 'true';

export async function loadConfig(): Promise<Config> {
  const awsRegion = optionalEnv('AWS_REGION', 'us-east-1');
  const ecsClusterName = optionalEnv('ECS_CLUSTER_NAME', 'tangent');
  const ecrRepoName = optionalEnv('ECR_REPO_NAME', 'local-dev');
  const logGroupName = optionalEnv('LOG_GROUP_NAME', '/ecs/local-dev');
  const ecsExecutionRoleArn = optionalEnv('ECS_EXECUTION_ROLE_ARN', 'arn:aws:iam::000000000000:role/local-dev');
  const fargateSubs = optionalEnv('FARGATE_SUBNETS', 'subnet-local').split(',').map((s) => s.trim());
  const fargateSg = optionalEnv('FARGATE_SECURITY_GROUP', 'sg-local');
  const slackChannel = optionalEnv('SLACK_CHANNEL', '#local-dev');
  const allowedSlackUserIds = new Set(
    optionalEnv('ALLOWED_SLACK_USER_IDS', '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean),
  );
  // Load per-person context notes
  let peopleNotes: Array<{ id: string; name: string; notes: string[] }> = [];
  try {
    peopleNotes = (JSON.parse(readFileSync(PEOPLE_FILE, 'utf8')) as { people: typeof peopleNotes }).people;
  } catch { /* file missing — fine */ }

  // Merge in any users persisted via allowUser() across previous restarts
  try {
    const persisted = (JSON.parse(readFileSync(ALLOWED_USERS_FILE, 'utf8')) as { allowedUserIds: string[] }).allowedUserIds;
    for (const id of persisted) allowedSlackUserIds.add(id);
    logger.info({ action: 'config:load_allowed_users', count: persisted.length }, 'Loaded persisted allowed users');
  } catch { /* file not yet created — fine */ }
  const githubOrg = optionalEnv('GITHUB_ORG', 'impiricus');
  const scaffoldChildTopic = optionalEnv('SCAFFOLD_CHILD_TOPIC', 'impiricus-scaffold-child');
  const workspaceDir = optionalEnv('WORKSPACE_DIR', '/tmp/tangent-workspace');

  const port = parseInt(optionalEnv('PORT', '3000'), 10);
  const host = optionalEnv('HOST', '127.0.0.1');
  const taskCpu = optionalEnv('TASK_CPU', '512');
  const taskMemory = optionalEnv('TASK_MEMORY', '1024');
  const defaultAppPort = parseInt(optionalEnv('DEFAULT_APP_PORT', '8080'), 10);
  const assignPublicIp = optionalEnv('FARGATE_ASSIGN_PUBLIC_IP', 'ENABLED') as 'ENABLED' | 'DISABLED';

  // ── Secrets: Secrets Manager in prod, env vars in LOCAL_DEV ──────────────
  let ngrokAuthtoken: string;
  let githubToken: string;
  let anthropicApiKey: string;
  let slackToken: string;

  let slackAppToken: string;

  if (LOCAL_DEV) {
    logger.info({ action: 'config:local_dev' }, 'LOCAL_DEV=true — reading secrets from env vars');
    ngrokAuthtoken  = optionalEnv('NGROK_AUTHTOKEN', '');
    githubToken     = optionalEnv('GITHUB_TOKEN', '');
    anthropicApiKey = requireEnv('ANTHROPIC_API_KEY');
    slackToken      = optionalEnv('SLACK_TOKEN', '');
    slackAppToken   = optionalEnv('SLACK_APP_TOKEN', '');
  } else {
    const secretNgrokKey     = requireEnv('SECRET_NGROK_AUTHTOKEN');
    const secretGithubKey    = requireEnv('SECRET_GITHUB_TOKEN');
    const secretAnthropicKey = requireEnv('SECRET_ANTHROPIC_KEY');
    const secretSlackKey     = requireEnv('SECRET_SLACK_TOKEN');
    const secretSlackAppKey  = requireEnv('SECRET_SLACK_APP_TOKEN');

    logger.info({ action: 'config:load_secrets' }, 'Fetching secrets from Secrets Manager');
    const smClient = new SecretsManagerClient({ region: awsRegion });

    [ngrokAuthtoken, githubToken, anthropicApiKey, slackToken, slackAppToken] = await Promise.all([
      fetchSecret(smClient, secretNgrokKey),
      fetchSecret(smClient, secretGithubKey),
      fetchSecret(smClient, secretAnthropicKey),
      fetchSecret(smClient, secretSlackKey),
      fetchSecret(smClient, secretSlackAppKey),
    ]);
  }

  // Derive ECR URI from the execution role ARN (account ID is in position 4)
  const accountId = ecsExecutionRoleArn.split(':')[4] ?? '000000000000';
  const ecrRepoUri = `${accountId}.dkr.ecr.${awsRegion}.amazonaws.com/${ecrRepoName}`;

  _config = {
    awsRegion,
    ecsClusterName,
    ecrRepoName,
    ecrRepoUri,
    logGroupName,
    taskCpu,
    taskMemory,
    defaultAppPort,
    fargate: {
      subnets: fargateSubs,
      securityGroup: fargateSg,
      assignPublicIp,
    },
    ecsExecutionRoleArn,
    ngrokAuthtoken,
    githubToken,
    anthropicApiKey,
    slackToken,
    slackAppToken,
    slackChannel,
    allowedSlackUserIds,
    peopleNotes,
    githubOrg,
    scaffoldChildTopic,
    port,
    host,
    workspaceDir,
  };

  logger.info(
    { action: 'config:loaded', cluster: ecsClusterName, ecr: ecrRepoUri },
    'Configuration loaded successfully',
  );

  return _config;
}
