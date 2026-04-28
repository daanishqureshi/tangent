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

import { inspectRepo, readRepoFile } from '../services/github.js';
import { analyzeDeployEligibility, type DeployAnalysis } from '../services/ai.js';
import { logger } from '../utils/logger.js';

export type { DeployAnalysis };

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
