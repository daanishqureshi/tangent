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
 * Edit a file in a GitHub repo by find/replace — entirely server-side.
 * Reads the file via Octokit, runs the substitution locally, pushes back via pushFile.
 * Content never round-trips through the LLM context window, so it cannot be truncated.
 *
 * - find: literal string to match (NOT a regex). Must be unique unless replaceAll is true.
 * - replace: literal replacement string.
 * - replaceAll: when true, replaces every occurrence; otherwise requires exactly one match.
 *
 * Throws if the file doesn't exist, find has no match, or find matches multiple times
 * without replaceAll.
 */
export async function editFile(
  repo: string,
  filePath: string,
  find: string,
  replace: string,
  options: { replaceAll?: boolean; commitMessage?: string; branch?: string } = {},
): Promise<{ sha: string; url: string; matches: number; oldSize: number; newSize: number }> {
  const { branch = 'main', replaceAll = false } = options;

  if (!find) throw new Error('edit_file: `find` cannot be empty');

  const original = await readRepoFile(repo, filePath, branch);
  if (original === null) {
    throw new Error(`File not found: \`${filePath}\` in \`${repo}\` (${branch}). Use push_file to create it.`);
  }

  const firstIdx = original.indexOf(find);
  if (firstIdx === -1) {
    throw new Error(`No match for the \`find\` string in \`${filePath}\`. The file content may differ from what you expected — re-read it.`);
  }

  let updated: string;
  let matches: number;
  if (replaceAll) {
    const parts = original.split(find);
    matches = parts.length - 1;
    updated = parts.join(replace);
  } else {
    const secondIdx = original.indexOf(find, firstIdx + find.length);
    if (secondIdx !== -1) {
      throw new Error(`The \`find\` string matches more than once in \`${filePath}\` — include more surrounding context to make it unique, or pass replace_all: true.`);
    }
    matches = 1;
    updated = original.slice(0, firstIdx) + replace + original.slice(firstIdx + find.length);
  }

  if (updated === original) {
    throw new Error(`edit_file: replacement produced no change in \`${filePath}\` — find and replace are identical.`);
  }

  const commitMessage = options.commitMessage ?? `Edit ${filePath} via Tangent`;
  const { sha, url } = await pushFile(repo, filePath, updated, commitMessage, branch);

  logger.info(
    { action: 'github:edit_file', repo, filePath, matches, oldSize: original.length, newSize: updated.length, sha },
    'File edited',
  );

  return { sha, url, matches, oldSize: original.length, newSize: updated.length };
}

/**
 * Read a single file from a repo by path, optionally at a specific commit SHA or branch.
 * Returns the decoded UTF-8 content, or null if the file doesn't exist or isn't readable.
 */
export async function readRepoFile(repo: string, filePath: string, ref?: string): Promise<string | null> {
  const { githubOrg } = config();
  try {
    const res = await octokit().repos.getContent({ owner: githubOrg, repo, path: filePath, ...(ref ? { ref } : {}) });
    const file = res.data as { type: string; content?: string; encoding?: string };
    if (file.type !== 'file' || !file.content) return null;
    return Buffer.from(file.content, (file.encoding as BufferEncoding) ?? 'base64').toString('utf-8');
  } catch {
    return null;
  }
}

export interface CommitInfo {
  sha: string;
  shortSha: string;
  message: string;
  author: string;
  date: string;
}

/**
 * List recent commits for a repo, optionally filtered to a specific file path.
 */
export async function listCommits(repo: string, filePath?: string, limit = 20): Promise<CommitInfo[]> {
  const { githubOrg } = config();
  const { data } = await octokit().repos.listCommits({
    owner: githubOrg,
    repo,
    per_page: limit,
    ...(filePath ? { path: filePath } : {}),
  });
  return data.map((c) => ({
    sha: c.sha,
    shortSha: c.sha.slice(0, 7),
    message: c.commit.message.split('\n')[0] ?? '',
    author: c.commit.author?.name ?? c.commit.committer?.name ?? 'unknown',
    date: c.commit.author?.date ?? c.commit.committer?.date ?? '',
  }));
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
