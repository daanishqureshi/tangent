/**
 * services/docker.ts
 *
 * Shell wrappers around the local Docker CLI.
 * Docker is pre-installed on the EC2; we shell out rather than use the API.
 */

import { ECRClient, GetAuthorizationTokenCommand } from '@aws-sdk/client-ecr';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execCommand } from '../utils/exec.js';
import { DOCKER_TIMEOUT_MS } from '../utils/constants.js';
import { logger } from '../utils/logger.js';
import { config } from '../config.js';

/**
 * Authenticate Docker to ECR using the AWS SDK — no AWS CLI required.
 *
 * Instead of calling `docker login` (which on macOS tries to save credentials
 * to the Keychain and often fails), we write the auth token directly into
 * ~/.docker/config.json under the `auths` section.  This bypasses the
 * osxkeychain credential helper entirely and works on any platform.
 */
export async function ecrLogin(): Promise<void> {
  const { awsRegion, ecrRepoUri } = config();
  const registry = ecrRepoUri.split('/')[0]; // e.g. 307048237966.dkr.ecr.us-east-1.amazonaws.com

  logger.info({ action: 'docker:ecr_login', registry }, 'Logging in to ECR');

  // Get a short-lived auth token from ECR via SDK (no aws CLI needed)
  const ecr = new ECRClient({ region: awsRegion });
  const tokenRes = await ecr.send(new GetAuthorizationTokenCommand({}));
  // authorizationToken is already base64("AWS:<password>") — exactly what Docker needs in auths
  const authToken = tokenRes.authorizationData?.[0]?.authorizationToken;
  if (!authToken) throw new Error('ECR returned no authorization token');

  // Read existing Docker config (or start fresh)
  const dockerDir = join(homedir(), '.docker');
  const configPath = join(dockerDir, 'config.json');
  let dockerConfig: Record<string, unknown> = {};
  try {
    dockerConfig = JSON.parse(await readFile(configPath, 'utf-8'));
  } catch {
    // No config yet — we'll create it
  }

  // Write auth directly into the auths section.
  // If credsStore (e.g. osxkeychain) is set, Docker would normally use it instead
  // of auths — but adding an explicit credHelpers entry for this registry takes
  // precedence and routes it to the auths section.
  const auths = (dockerConfig['auths'] as Record<string, unknown>) ?? {};
  auths[registry] = { auth: authToken };
  dockerConfig['auths'] = auths;

  // Remove credsStore for this registry by adding a credHelpers override.
  // An empty string tells Docker to skip the helper and use auths directly.
  const credHelpers = (dockerConfig['credHelpers'] as Record<string, string>) ?? {};
  credHelpers[registry] = '';
  dockerConfig['credHelpers'] = credHelpers;

  await mkdir(dockerDir, { recursive: true });
  await writeFile(configPath, JSON.stringify(dockerConfig, null, 2));

  logger.info({ action: 'docker:ecr_login:done', registry }, 'ECR credentials written to Docker config');
}

/**
 * Build a Docker image from a context directory.
 * Returns the tagged image URI.
 */
export async function dockerBuild(contextDir: string, imageUri: string): Promise<void> {
  logger.info({ action: 'docker:build', imageUri, contextDir }, 'Building Docker image');

  await execCommand(
    'docker',
    ['build', '--platform', 'linux/amd64', '-t', imageUri, '.'],
    { cwd: contextDir, timeoutMs: DOCKER_TIMEOUT_MS },
  );

  logger.info({ action: 'docker:build:done', imageUri }, 'Docker build complete');
}

/**
 * Push a previously-built image to ECR.
 * Retries once on failure (ECR auth tokens expire after 12 h).
 */
export async function dockerPush(imageUri: string): Promise<void> {
  logger.info({ action: 'docker:push', imageUri }, 'Pushing image to ECR');

  try {
    await execCommand('docker', ['push', imageUri], { timeoutMs: DOCKER_TIMEOUT_MS });
  } catch (err) {
    logger.warn({ action: 'docker:push:retry', imageUri }, 'Push failed, re-authenticating and retrying');
    await ecrLogin();
    await execCommand('docker', ['push', imageUri], { timeoutMs: DOCKER_TIMEOUT_MS });
  }

  logger.info({ action: 'docker:push:done', imageUri }, 'Image pushed to ECR');
}
