/**
 * skills/analyze.ts
 *
 * Pre-deploy repo analysis — fetches repo contents and runs an AI eligibility
 * check before committing to a Docker build + ECS deploy.
 *
 * Called by handleDeploy in slack-bot.ts before any build is started.
 * Fast-fails with actionable blockers + a copy-paste Claude Code prompt
 * so the developer can fix the repo without needing SSH or DevOps knowledge.
 */

import { inspectRepo, listRepoFiles, readRepoFile } from '../services/github.js';
import { analyzeDeployEligibility, type DeployAnalysis } from '../services/ai.js';
import { logger } from '../utils/logger.js';

export type { DeployAnalysis };

export interface StaticEvidence {
  file: string;
  matchedText: string;
  reason: string;
  severity: 'blocker' | 'warning';
}

/**
 * Full pre-deploy eligibility check for a repo.
 *
 * Fetches: Dockerfile, package.json / requirements.txt, .env.example,
 * docker-compose.yml, CLAUDE.md, and the detected main entry-point file.
 * Passes everything to Claude for structured analysis.
 *
 * Returns a DeployAnalysis with:
 *   eligible       — whether the repo can be deployed right now
 *   detectedPort   — port from Dockerfile EXPOSE (overrides Claude's guess)
 *   blockers       — things that WILL cause deploy failure
 *   warnings       — things worth noting but not blocking
 *   claudeCodePrompt — ready-to-paste Claude Code prompt if not eligible
 */
export async function runDeployAnalysis(
  repo: string,
  branch = 'main',
): Promise<DeployAnalysis> {
  logger.info({ action: 'analyze:start', repo, branch }, 'Running pre-deploy analysis');

  // ── 1. Core inspection (README, Dockerfile, package.json, requirements.txt) ─
  const inspection = await inspectRepo(repo);

  // ── 2. Supplemental files — best-effort, never fatal if missing ─────────────
  const [envExampleResult, dockerComposeResult, claudeMdResult] =
    await Promise.allSettled([
      readRepoFile(repo, '.env.example', branch),
      readRepoFile(repo, 'docker-compose.yml', branch),
      readRepoFile(repo, 'CLAUDE.md', branch),
    ]);

  const envExample      = envExampleResult.status      === 'fulfilled' ? envExampleResult.value      : null;
  const dockerCompose   = dockerComposeResult.status   === 'fulfilled' ? dockerComposeResult.value   : null;
  const claudeMd        = claudeMdResult.status        === 'fulfilled' ? claudeMdResult.value        : null;
  const sourceEvidence  = [
    ...buildDockerfileEvidence(inspection.dockerfile),
    ...await scanStaticDeployEvidence(repo, branch, inspection.packageJson !== null),
  ];

  // ── 3. Try to read the main entry-point file ─────────────────────────────────
  // For Node: parse package.json for "main" or derive from "scripts.start".
  // For Python: try app.py, main.py, server.py in order.
  let entryPoint: string | null = null;
  try {
    if (inspection.packageJson) {
      const pkg = JSON.parse(inspection.packageJson) as {
        main?: string;
        scripts?: { start?: string };
      };
      const startCmd = pkg.scripts?.start ?? '';
      // "node src/app.js" → "src/app.js"
      const derived = pkg.main ?? startCmd.replace(/^node\s+/i, '').trim().split(/\s/)[0];
      if (derived) {
        entryPoint = await readRepoFile(repo, derived, branch).catch(() => null);
      }
    } else if (inspection.requirementsTxt) {
      // Python — try common entry-point names
      for (const candidate of ['app.py', 'main.py', 'server.py', 'run.py']) {
        const content = await readRepoFile(repo, candidate, branch).catch(() => null);
        if (content) { entryPoint = content; break; }
      }
    }
  } catch {
    // Non-fatal — analysis proceeds without entry-point source
  }

  // ── 4. Run AI eligibility analysis ──────────────────────────────────────────
  const result = await analyzeDeployEligibility(repo, {
    files:           inspection.files,
    dockerfile:      inspection.dockerfile,
    exposedPort:     inspection.exposedPort,
    packageJson:     inspection.packageJson,
    requirementsTxt: inspection.requirementsTxt,
    readme:          inspection.readme,
    envExample,
    dockerCompose,
    claudeMd,
    entryPoint,
    sourceEvidence,
  });

  logger.info(
    {
      action:    'analyze:done',
      repo,
      eligible:  result.eligible,
      blockers:  result.blockers.length,
      warnings:  result.warnings.length,
      port:      result.detectedPort,
    },
    'Pre-deploy analysis complete',
  );

  return result;
}

async function scanStaticDeployEvidence(repo: string, branch: string, isNodeRepo: boolean): Promise<StaticEvidence[]> {
  const evidence: StaticEvidence[] = [];
  let files: string[] = [];
  try {
    files = await listRepoFiles(repo, branch);
  } catch (err) {
    logger.warn({ action: 'analyze:tree_failed', repo, err }, 'Could not list repo tree for static evidence scan');
    return evidence;
  }

  const sourceFiles = files
    .filter((path) => isCandidateSourceFile(path, isNodeRepo))
    .slice(0, 60);

  const contents = await Promise.all(sourceFiles.map(async (file) => ({
    file,
    content: await readRepoFile(repo, file, branch).catch(() => null),
  })));

  for (const { file, content } of contents) {
    if (!content) continue;
    const truncated = content.slice(0, 40_000);
    collectEvidence(evidence, file, truncated);
  }

  return evidence;
}

function isCandidateSourceFile(path: string, isNodeRepo: boolean): boolean {
  if (path.includes('node_modules/') || path.includes('dist/') || path.includes('build/')) return false;
  if (/\.(js|mjs|cjs|ts|tsx|py)$/.test(path)) return true;
  if (['Dockerfile', 'package.json', 'requirements.txt'].includes(path)) return true;
  if (isNodeRepo && path.startsWith('src/')) return true;
  return false;
}

function collectEvidence(out: StaticEvidence[], file: string, content: string): void {
  const checks: Array<{ re: RegExp; reason: string; severity: StaticEvidence['severity'] }> = [
    {
      re: /process\.env\.GOOGLE_APPLICATION_CREDENTIALS\s*=\s*[^;\n]+/g,
      reason: 'Source sets GOOGLE_APPLICATION_CREDENTIALS to a file path instead of passing credentials in-process.',
      severity: 'blocker',
    },
    {
      re: /fs\.(?:writeFileSync|promises\.writeFile|writeFile)\s*\([^)]*\/tmp[^)]*(?:GOOGLE_SERVICE_ACCOUNT_JSON|service_account|credentials|json)[^)]*\)/gims,
      reason: 'Source writes service-account credentials to /tmp.',
      severity: 'blocker',
    },
    {
      re: /\.listen\s*\([^)]*(?:['"`](?:127\.0\.0\.1|localhost)['"`]|host\s*:\s*['"`](?:127\.0\.0\.1|localhost)['"`])/gim,
      reason: 'Source appears to bind the HTTP server to localhost instead of 0.0.0.0.',
      severity: 'blocker',
    },
    {
      re: /(?:postgres(?:ql)?:\/\/[^'"\s]*@(?:localhost|127\.0\.0\.1)|redis:\/\/(?:localhost|127\.0\.0\.1)|mongodb[^'"\s]*(?:localhost|127\.0\.0\.1)|DB_HOST\s*[:=]\s*['"`](?:localhost|127\.0\.0\.1)['"`])/gim,
      reason: 'Source appears to hardcode a localhost service URL instead of reading runtime env vars.',
      severity: 'blocker',
    },
  ];

  for (const check of checks) {
    for (const match of content.matchAll(check.re)) {
      out.push({
        file,
        matchedText: (match[0] ?? '').slice(0, 240),
        reason: check.reason,
        severity: check.severity,
      });
    }
  }
}

function buildDockerfileEvidence(dockerfile: string | null): StaticEvidence[] {
  if (!dockerfile) {
    return [{
      file: 'Dockerfile',
      matchedText: '(not found)',
      reason: 'Repo has no Dockerfile, so Tangent cannot build an ECS container image.',
      severity: 'blocker',
    }];
  }
  if (!/\b(?:CMD|ENTRYPOINT)\b/i.test(dockerfile)) {
    return [{
      file: 'Dockerfile',
      matchedText: dockerfile.slice(0, 240),
      reason: 'Dockerfile has no CMD or ENTRYPOINT, so the ECS task has no app process to run.',
      severity: 'blocker',
    }];
  }
  return [];
}
