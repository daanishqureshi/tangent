/**
 * services/github.ts
 *
 * Octokit client + helpers for cloning repos and listing scaffold-child repos.
 */

import { Octokit } from '@octokit/rest';
import { config } from '../config.js';
import { execCommand } from '../utils/exec.js';
import { GIT_TIMEOUT_MS } from '../utils/constants.js';
import { logger } from '../utils/logger.js';
import { rm } from 'node:fs/promises';

let _octokit: Octokit | null = null;

export function initGithubClient(): void {
  _octokit = new Octokit({ auth: config().githubToken });
}

function octokit(): Octokit {
  if (!_octokit) throw new Error('GitHub client not initialized — call initGithubClient() first');
  return _octokit;
}

/**
 * Shallow-clone a repo to destDir.
 * Returns the short SHA of HEAD.
 */
export async function cloneRepo(
  repo: string,
  destDir: string,
  branch = 'main',
): Promise<string> {
  const { githubToken, githubOrg } = config();
  const url = `https://x-access-token:${githubToken}@github.com/${githubOrg}/${repo}.git`;

  logger.info({ action: 'github:clone', repo, branch, destDir }, 'Cloning repo');

  await execCommand(
    'git',
    ['clone', '--depth', '1', '--branch', branch, url, destDir],
    { timeoutMs: GIT_TIMEOUT_MS },
  );

  const { stdout: sha } = await execCommand(
    'git',
    ['rev-parse', '--short', 'HEAD'],
    { cwd: destDir, timeoutMs: 10_000 },
  );

  logger.info({ action: 'github:clone:done', repo, sha }, 'Clone complete');
  return sha;
}

/**
 * Remove a cloned directory, ignoring errors if it doesn't exist.
 */
export async function removeClone(dir: string): Promise<void> {
  try {
    await rm(dir, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
}

export interface RepoInfo {
  name: string;
  description: string | null;
  defaultBranch: string;
  private: boolean;
  updatedAt: string | null;
  topics: string[];
}

/**
 * List all repos in the GitHub org, sorted by most recently updated.
 */
export async function listAllRepos(): Promise<RepoInfo[]> {
  const { githubOrg } = config();
  const repos: RepoInfo[] = [];
  let page = 1;
  const perPage = 100;

  while (true) {
    const { data } = await octokit().repos.listForOrg({
      org: githubOrg,
      type: 'all',
      sort: 'updated',
      direction: 'desc',
      per_page: perPage,
      page,
    });

    if (data.length === 0) break;

    for (const repo of data) {
      repos.push({
        name: repo.name,
        description: repo.description ?? null,
        defaultBranch: repo.default_branch ?? 'main',
        private: repo.private ?? false,
        updatedAt: repo.updated_at ?? null,
        topics: repo.topics ?? [],
      });
    }

    if (data.length < perPage) break;
    page++;
  }

  logger.info({ action: 'github:list_all_repos', count: repos.length }, 'Listed all org repos');
  return repos;
}

export interface RepoInspection {
  name: string;
  description: string | null;
  defaultBranch: string;
  private: boolean;
  topics: string[];
  files: string[];           // top-level file/folder names
  readme: string | null;     // raw README content (truncated)
  dockerfile: string | null; // Dockerfile content if present
  exposedPort: number | null; // port extracted from Dockerfile EXPOSE instruction
  packageJson: string | null;
  requirementsTxt: string | null;
}

/**
 * Inspect a repo's contents: README, Dockerfile, key config files, top-level file list.
 * Gives Tangent enough context to understand what a repo is and how to deploy it.
 */
export async function inspectRepo(repo: string): Promise<RepoInspection> {
  const { githubOrg } = config();

  // Fetch repo metadata and top-level file listing in parallel
  const [repoData, contentsData] = await Promise.all([
    octokit().repos.get({ owner: githubOrg, repo }),
    octokit().repos.getContent({ owner: githubOrg, repo, path: '' }).catch(() => ({ data: [] })),
  ]);

  const meta = repoData.data;
  const contents = Array.isArray(contentsData.data) ? contentsData.data : [];
  const fileNames = contents.map((f: { name: string }) => f.name);

  // Helper: fetch a single file's decoded text content
  async function fetchFile(path: string): Promise<string | null> {
    try {
      const res = await octokit().repos.getContent({ owner: githubOrg, repo, path });
      const file = res.data as { type: string; content?: string; encoding?: string };
      if (file.type !== 'file' || !file.content) return null;
      return Buffer.from(file.content, (file.encoding as BufferEncoding) ?? 'base64')
        .toString('utf-8')
        .slice(0, 3000); // truncate so we don't blow up the Claude context
    } catch {
      return null;
    }
  }

  // Detect readme filename (case-insensitive)
  const readmeFile = fileNames.find((f) => /^readme(\.(md|txt|rst))?$/i.test(f));
  const hasDockerfile = fileNames.includes('Dockerfile');
  const hasPackageJson = fileNames.includes('package.json');
  const hasRequirements = fileNames.includes('requirements.txt');

  const [readme, dockerfile, packageJson, requirementsTxt] = await Promise.all([
    readmeFile ? fetchFile(readmeFile) : Promise.resolve(null),
    hasDockerfile ? fetchFile('Dockerfile') : Promise.resolve(null),
    hasPackageJson ? fetchFile('package.json') : Promise.resolve(null),
    hasRequirements ? fetchFile('requirements.txt') : Promise.resolve(null),
  ]);

  // Extract EXPOSE port from Dockerfile — this is the authoritative port for deployment
  let exposedPort: number | null = null;
  if (dockerfile) {
    const match = dockerfile.match(/^EXPOSE\s+(\d+)/m);
    if (match) exposedPort = parseInt(match[1], 10);
  }

  logger.info({ action: 'github:inspect_repo', repo, exposedPort }, 'Repo inspected');

  return {
    name: meta.name,
    description: meta.description ?? null,
    defaultBranch: meta.default_branch ?? 'main',
    private: meta.private ?? false,
    topics: meta.topics ?? [],
    files: fileNames,
    readme,
    dockerfile,
    exposedPort,
    packageJson,
    requirementsTxt,
  };
}

/**
 * Create or update a single file in a GitHub repo.
 * Uses the GitHub Contents API — no git clone required.
 */
export async function pushFile(
  repo: string,
  filePath: string,
  content: string,
  commitMessage: string,
  branch = 'main',
): Promise<{ sha: string; url: string }> {
  const { githubOrg } = config();

  // Check if the file already exists — if so we need its blob SHA to update it
  let existingSha: string | undefined;
  try {
    const { data } = await octokit().repos.getContent({
      owner: githubOrg,
      repo,
      path: filePath,
      ref: branch,
    });
    if (!Array.isArray(data) && data.type === 'file') {
      existingSha = data.sha;
    }
  } catch {
    // File doesn't exist yet — create it fresh
  }

  const { data } = await octokit().repos.createOrUpdateFileContents({
    owner: githubOrg,
    repo,
    path: filePath,
    message: commitMessage,
    content: Buffer.from(content).toString('base64'),
    branch,
    ...(existingSha ? { sha: existingSha } : {}),
  });

  const commitSha = data.commit.sha ?? '';
  const fileUrl   = data.content?.html_url ?? '';

  logger.info({ action: 'github:push_file', repo, filePath, commitSha }, 'File pushed');
  return { sha: commitSha, url: fileUrl };
}

/**
 * Read a single file from a repo by path.
 * Returns the decoded UTF-8 content, or null if the file doesn't exist or isn't readable.
 */
export async function readRepoFile(repo: string, filePath: string): Promise<string | null> {
  const { githubOrg } = config();
  try {
    const res = await octokit().repos.getContent({ owner: githubOrg, repo, path: filePath });
    const file = res.data as { type: string; content?: string; encoding?: string };
    if (file.type !== 'file' || !file.content) return null;
    return Buffer.from(file.content, (file.encoding as BufferEncoding) ?? 'base64').toString('utf-8');
  } catch {
    return null;
  }
}

/**
 * List all repos in the org that have the scaffold-child topic.
 */
export async function listScaffoldChildRepos(): Promise<string[]> {
  const { githubOrg, scaffoldChildTopic } = config();

  const repos: string[] = [];
  let page = 1;
  const perPage = 100;

  while (true) {
    const { data } = await octokit().repos.listForOrg({
      org: githubOrg,
      type: 'all',
      per_page: perPage,
      page,
    });

    if (data.length === 0) break;

    for (const repo of data) {
      if (repo.topics?.includes(scaffoldChildTopic)) {
        repos.push(repo.name);
      }
    }

    if (data.length < perPage) break;
    page++;
  }

  logger.info(
    { action: 'github:list_scaffold_repos', count: repos.length },
    'Listed scaffold-child repos',
  );
  return repos;
}
