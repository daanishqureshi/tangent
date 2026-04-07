/**
 * skills/build.ts
 *
 * Clone a repo, build its Docker image, push it to ECR.
 *
 * Input:  { repo, branch? }
 * Output: { imageUri, sha, buildTimeMs }
 */

import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '../config.js';
import { cloneRepo, removeClone } from '../services/github.js';
import { ecrLogin, dockerBuild, dockerPush } from '../services/docker.js';
import { summarizeBuildError } from '../services/ai.js';
import { logger } from '../utils/logger.js';

export interface BuildInput {
  repo: string;
  branch?: string;
}

export interface BuildOutput {
  imageUri: string;
  sha: string;
  buildTimeMs: number;
}

export interface BuildError {
  error: string;
  summary: string;
  raw?: string;
}

export async function buildSkill(input: BuildInput): Promise<BuildOutput> {
  const { repo, branch = 'main' } = input;
  const { workspaceDir, ecrRepoUri } = config();

  const timestamp = Date.now();
  const cloneDir = join(workspaceDir, `${repo}-${timestamp}`);
  const start = Date.now();

  logger.info({ action: 'build:start', repo, branch }, 'Starting build');

  try {
    // 1. Clone
    const sha = await cloneRepo(repo, cloneDir, branch);

    // 2. Verify Dockerfile exists
    const dockerfilePath = join(cloneDir, 'Dockerfile');
    try {
      await access(dockerfilePath);
    } catch {
      throw new DockerfileNotFoundError(
        `No Dockerfile found at the root of ${repo}. Add a Dockerfile to your repo root.`,
      );
    }

    // 3. ECR login
    await ecrLogin();

    // 4. Build
    const imageUri = `${ecrRepoUri}:${repo}-${sha}`;
    try {
      await dockerBuild(cloneDir, imageUri);
    } catch (err) {
      const raw = extractStderr(err);
      const summary = await summarizeBuildError(raw, repo);
      throw new DockerBuildError(`Docker build failed for ${repo}`, summary, raw);
    }

    // 5. Push (with one auto-retry in dockerPush)
    await dockerPush(imageUri);

    const buildTimeMs = Date.now() - start;
    logger.info({ action: 'build:done', repo, sha, imageUri, buildTimeMs }, 'Build complete');

    return { imageUri, sha, buildTimeMs };
  } finally {
    // Always clean up the workspace, even on error
    await removeClone(cloneDir);
    logger.info({ action: 'build:cleanup', repo, cloneDir }, 'Workspace cleaned up');
  }
}

// ─── Error types ─────────────────────────────────────────────────────────────

export class DockerfileNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DockerfileNotFoundError';
  }
}

export class DockerBuildError extends Error {
  summary: string;
  raw: string;

  constructor(message: string, summary: string, raw: string) {
    super(message);
    this.name = 'DockerBuildError';
    this.summary = summary;
    this.raw = raw;
  }
}

function extractStderr(err: unknown): string {
  if (err instanceof Error && 'stderr' in err) {
    return String((err as { stderr: string }).stderr);
  }
  return String(err);
}
