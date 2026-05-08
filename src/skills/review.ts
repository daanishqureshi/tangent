/**
 * skills/review.ts
 *
 * Evidence-first deploy review. This is intentionally deterministic: run
 * commands, inspect files, build the Docker image, smoke-test the container,
 * then let Slack/Claude summarize only the evidence.
 */

import { randomUUID } from 'node:crypto';
import { access, readFile, readdir } from 'node:fs/promises';
import { createServer } from 'node:net';
import { request } from 'node:http';
import { join, relative } from 'node:path';
import { config } from '../config.js';
import { cloneRepo, removeClone } from '../services/github.js';
import { execCommand } from '../utils/exec.js';
import { DOCKER_TIMEOUT_MS } from '../utils/constants.js';
import { logger } from '../utils/logger.js';

export type ReviewFindingCategory = 'deploy' | 'runtime' | 'security' | 'quality';
export type ReviewFindingSeverity = 'blocker' | 'warning' | 'info' | 'not_checked';

export interface ReviewFinding {
  category: ReviewFindingCategory;
  severity: ReviewFindingSeverity;
  title: string;
  detail: string;
  evidence?: string;
  fix?: string;
}

export interface ReviewCommandRun {
  command: string;
  success: boolean;
  exitCode?: number | null;
  stdoutTail?: string;
  stderrTail?: string;
}

export interface ReviewResult {
  repo: string;
  branch: string;
  sha: string;
  detectedPort: number | null;
  framework: string;
  canDeploy: boolean;
  blockers: ReviewFinding[];
  securityFindings: ReviewFinding[];
  warnings: ReviewFinding[];
  notChecked: ReviewFinding[];
  commandsRun: ReviewCommandRun[];
}

interface ReviewOptions {
  repo: string;
  branch?: string;
  port?: number;
}

interface CommandFailure extends Error {
  stdout?: string;
  stderr?: string;
  code?: number | null;
}

const SOURCE_EXTENSIONS = new Set([
  '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs',
  '.py', '.sh', '.yml', '.yaml', '.json', '.toml', '.ini', '.env',
]);

export async function reviewRepo(input: ReviewOptions): Promise<ReviewResult> {
  const { repo, branch = 'main' } = input;
  const cloneDir = join(config().workspaceDir, `${repo}-review-${Date.now()}`);
  const commandsRun: ReviewCommandRun[] = [];
  const findings: ReviewFinding[] = [];
  let imageTag: string | null = null;
  let sha = '';

  logger.info({ action: 'review:start', repo, branch }, 'Starting deploy review');

  try {
    try {
      sha = await cloneRepo(repo, cloneDir, branch);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      findings.push({
        category: 'deploy',
        severity: 'blocker',
        title: 'Could not clone repository',
        detail: 'The review could not fetch the repository, so no deploy/security checks could run.',
        evidence: message,
        fix: 'Check the GitHub token, repository name, org access, and branch name.',
      });
      return buildResult(repo, branch, '', input.port ?? null, 'Unknown', findings, commandsRun);
    }
    const files = await listFiles(cloneDir);
    const dockerfile = await readOptional(join(cloneDir, 'Dockerfile'));
    const packageJson = await readJsonOptional(join(cloneDir, 'package.json'));
    const requirementsTxt = await readOptional(join(cloneDir, 'requirements.txt'));
    const detectedPort = input.port ?? detectPort(dockerfile, packageJson, files);
    const framework = detectFramework(files, packageJson, requirementsTxt);

    await runStaticDeployChecks(cloneDir, files, dockerfile, packageJson, findings, detectedPort);
    await runSecurityChecks(cloneDir, files, dockerfile, packageJson, requirementsTxt, findings, commandsRun);
    await runFrameworkChecks(cloneDir, files, packageJson, requirementsTxt, findings, commandsRun);

    if (dockerfile) {
      imageTag = `tangent-review-${sanitizeTag(repo)}-${sha}-${Date.now()}`;
      const build = await runCommand(
        'docker',
        ['build', '--platform', 'linux/amd64', '-t', imageTag, '.'],
        { cwd: cloneDir, timeoutMs: DOCKER_TIMEOUT_MS },
        commandsRun,
      );
      if (!build.success) {
        findings.push({
          category: 'deploy',
          severity: 'blocker',
          title: 'Docker build failed',
          detail: 'The image did not build successfully, so ECS deployment would fail before startup.',
          evidence: tail([build.stdoutTail, build.stderrTail].filter(Boolean).join('\n'), 3000),
          fix: 'Fix the Docker build error shown in the log tail, then rerun review.',
        });
      } else if (detectedPort) {
        await runSmokeTest(imageTag, detectedPort, findings, commandsRun);
      } else {
        findings.push({
          category: 'deploy',
          severity: 'blocker',
          title: 'Cannot smoke-test without a known container port',
          detail: 'The Dockerfile does not expose a port and no port was provided.',
          fix: 'Add `EXPOSE <port>` to the Dockerfile or pass an explicit port.',
        });
      }
    }

    const result = buildResult(repo, branch, sha, detectedPort, framework, findings, commandsRun);
    logger.info(
      { action: 'review:done', repo, canDeploy: result.canDeploy, blockers: result.blockers.length, warnings: result.warnings.length },
      'Deploy review complete',
    );
    return result;
  } finally {
    if (imageTag) {
      await runCommand('docker', ['rmi', '-f', imageTag], { timeoutMs: 60_000 }, commandsRun).catch(() => undefined);
    }
    await removeClone(cloneDir);
  }
}

export function formatReviewResult(result: ReviewResult): string {
  const lines: string[] = [
    `Review for \`${result.repo}\` (${result.branch} @ \`${result.sha}\`)`,
    `Framework: ${result.framework}`,
    `Detected port: ${result.detectedPort ?? 'unknown'}`,
    `Result: ${result.canDeploy ? 'PASS — no blockers found' : 'BLOCKED — fix blockers before deploy'}`,
  ];

  appendFindings(lines, 'Blockers', result.blockers);
  appendFindings(lines, 'Security findings', result.securityFindings);
  appendFindings(lines, 'Warnings', result.warnings);
  appendFindings(lines, 'Not checked', result.notChecked);

  const failedCommands = result.commandsRun.filter((cmd) => !cmd.success).slice(0, 4);
  if (failedCommands.length > 0) {
    lines.push('', '*Failed command evidence:*');
    for (const command of failedCommands) {
      lines.push(`- \`${command.command}\` exited ${command.exitCode ?? 'unknown'}`);
      const evidence = tail([command.stdoutTail, command.stderrTail].filter(Boolean).join('\n'), 1200);
      if (evidence) lines.push(`\`\`\`${evidence}\`\`\``);
    }
  }

  return lines.join('\n');
}

function appendFindings(lines: string[], title: string, findings: ReviewFinding[]): void {
  if (findings.length === 0) return;
  lines.push('', `*${title}:*`);
  for (const finding of findings.slice(0, 12)) {
    lines.push(`- *${finding.title}* — ${finding.detail}`);
    if (finding.evidence) lines.push(`  Evidence: \`${tail(finding.evidence.replace(/\s+/g, ' '), 260)}\``);
    if (finding.fix) lines.push(`  Fix: ${finding.fix}`);
  }
  if (findings.length > 12) lines.push(`- ...and ${findings.length - 12} more.`);
}

function buildResult(
  repo: string,
  branch: string,
  sha: string,
  detectedPort: number | null,
  framework: string,
  findings: ReviewFinding[],
  commandsRun: ReviewCommandRun[],
): ReviewResult {
  const blockers = findings.filter((f) => f.severity === 'blocker' && f.category !== 'security');
  const securityFindings = findings.filter((f) => f.category === 'security' && ['blocker', 'warning'].includes(f.severity));
  const warnings = findings.filter((f) => f.severity === 'warning' && f.category !== 'security');
  const notChecked = findings.filter((f) => f.severity === 'not_checked');
  const securityBlockers = securityFindings.filter((f) => f.severity === 'blocker');

  return {
    repo,
    branch,
    sha,
    detectedPort,
    framework,
    canDeploy: blockers.length === 0 && securityBlockers.length === 0,
    blockers,
    securityFindings,
    warnings,
    notChecked,
    commandsRun,
  };
}

async function runStaticDeployChecks(
  cloneDir: string,
  files: string[],
  dockerfile: string | null,
  packageJson: unknown,
  findings: ReviewFinding[],
  detectedPort: number | null,
): Promise<void> {
  if (!dockerfile) {
    findings.push({
      category: 'deploy',
      severity: 'blocker',
      title: 'Missing Dockerfile',
      detail: 'Tangent deploys ECS services from Docker images, and this repo has no root Dockerfile.',
      fix: 'Add a root Dockerfile that starts the app and exposes the app port.',
    });
    return;
  }

  if (!/\b(?:CMD|ENTRYPOINT)\b/i.test(dockerfile)) {
    findings.push({
      category: 'deploy',
      severity: 'blocker',
      title: 'Dockerfile has no CMD or ENTRYPOINT',
      detail: 'The ECS task would have no application process to run.',
      evidence: dockerfile.slice(0, 500),
      fix: 'Add a CMD or ENTRYPOINT that starts the web server.',
    });
  }

  if (!detectedPort) {
    findings.push({
      category: 'deploy',
      severity: 'blocker',
      title: 'No deploy port detected',
      detail: 'The review could not determine which container port ECS/ngrok should target.',
      fix: 'Add `EXPOSE <port>` to the Dockerfile.',
    });
  }

  if (/npm\s+ci\b/.test(dockerfile) && !files.includes('package-lock.json')) {
    findings.push({
      category: 'deploy',
      severity: 'blocker',
      title: 'Dockerfile uses npm ci but package-lock.json is missing',
      detail: '`npm ci` requires a lockfile and will fail during Docker build.',
      fix: 'Commit package-lock.json or change the Dockerfile install command.',
    });
  }

  const sourceFiles = files.filter(isReviewableSourceFile).slice(0, 120);
  for (const file of sourceFiles) {
    const content = await readOptional(join(cloneDir, file));
    if (!content) continue;
    collectRuntimeHazards(file, content, findings);
  }

  if (packageJson && typeof packageJson === 'object' && !files.includes('package-lock.json')) {
    findings.push({
      category: 'quality',
      severity: 'warning',
      title: 'Node repo has no package-lock.json',
      detail: 'Builds may be less reproducible without a lockfile.',
      fix: 'Commit package-lock.json when using npm.',
    });
  }
}

async function runFrameworkChecks(
  cloneDir: string,
  files: string[],
  packageJson: unknown,
  requirementsTxt: string | null,
  findings: ReviewFinding[],
  commandsRun: ReviewCommandRun[],
): Promise<void> {
  const pyFiles = files.filter((file) => file.endsWith('.py'));
  if (pyFiles.length > 0) {
    const result = await runCommand('python3', ['-m', 'compileall', '-q', '.'], { cwd: cloneDir, timeoutMs: 120_000 }, commandsRun);
    if (!result.success) {
      findings.push({
        category: 'deploy',
        severity: 'blocker',
        title: 'Python syntax compilation failed',
        detail: 'At least one Python file fails to compile.',
        evidence: tail([result.stdoutTail, result.stderrTail].filter(Boolean).join('\n'), 2000),
        fix: 'Fix the Python syntax error before deploying.',
      });
    }
  }

  if (packageJson && typeof packageJson === 'object') {
    const pkg = packageJson as { scripts?: Record<string, string> };
    if (pkg.scripts?.build && files.includes('package-lock.json')) {
      const install = await runCommand('npm', ['ci', '--ignore-scripts'], { cwd: cloneDir, timeoutMs: 180_000 }, commandsRun);
      if (install.success) {
        const build = await runCommand('npm', ['run', 'build'], { cwd: cloneDir, timeoutMs: 180_000 }, commandsRun);
        if (!build.success) {
          findings.push({
            category: 'deploy',
            severity: 'blocker',
            title: 'npm build failed',
            detail: '`npm run build` failed before Docker deployment.',
            evidence: tail([build.stdoutTail, build.stderrTail].filter(Boolean).join('\n'), 2200),
            fix: 'Fix the build error before deploying.',
          });
        }
      } else {
        findings.push({
          category: 'deploy',
          severity: 'warning',
          title: 'npm ci failed during review',
          detail: 'The local framework check could not install dependencies. Docker build may still provide the authoritative result.',
          evidence: tail([install.stdoutTail, install.stderrTail].filter(Boolean).join('\n'), 1800),
        });
      }
    }
  }

  if (requirementsTxt && requirementsTxt.includes('streamlit')) {
    findings.push({
      category: 'quality',
      severity: 'info',
      title: 'Streamlit app detected',
      detail: 'Review will rely on Docker build plus HTTP smoke test for Streamlit runtime validation.',
    });
  }
}

async function runSecurityChecks(
  cloneDir: string,
  files: string[],
  dockerfile: string | null,
  packageJson: unknown,
  requirementsTxt: string | null,
  findings: ReviewFinding[],
  commandsRun: ReviewCommandRun[],
): Promise<void> {
  if (packageJson && files.includes('package-lock.json')) {
    const audit = await runCommand('npm', ['audit', '--json', '--omit=dev'], { cwd: cloneDir, timeoutMs: 120_000 }, commandsRun);
    const auditJson = parseJson(audit.stdoutTail ?? audit.stderrTail ?? '');
    if (auditJson && typeof auditJson === 'object') {
      const metadata = (auditJson as { metadata?: { vulnerabilities?: Record<string, number> } }).metadata;
      const critical = metadata?.vulnerabilities?.critical ?? 0;
      const high = metadata?.vulnerabilities?.high ?? 0;
      if (critical > 0 || high > 0) {
        findings.push({
          category: 'security',
          severity: 'warning',
          title: 'npm audit found high or critical vulnerabilities',
          detail: `Runtime dependency audit reported ${critical} critical and ${high} high vulnerabilities.`,
          evidence: `critical=${critical}, high=${high}`,
          fix: 'Review `npm audit --omit=dev` and upgrade affected runtime packages.',
        });
      }
    } else if (!audit.success) {
      findings.push({
        category: 'security',
        severity: 'not_checked',
        title: 'npm audit did not return parseable JSON',
        detail: 'Dependency vulnerability scan could not be interpreted.',
        evidence: tail([audit.stdoutTail, audit.stderrTail].filter(Boolean).join('\n'), 1200),
      });
    }
  }

  if (requirementsTxt) {
    const available = await runCommand('pip-audit', ['--version'], { cwd: cloneDir, timeoutMs: 20_000 }, commandsRun);
    if (!available.success) {
      findings.push({
        category: 'security',
        severity: 'not_checked',
        title: 'pip-audit not installed',
        detail: 'Python dependency vulnerability scan was not run on this host.',
        fix: 'Install pip-audit on the Tangent host to enable Python dependency scanning.',
      });
    } else {
      const audit = await runCommand(
        'pip-audit',
        ['-r', 'requirements.txt', '--format', 'json'],
        { cwd: cloneDir, timeoutMs: 120_000 },
        commandsRun,
      );
      const parsed = parseJson(audit.stdoutTail ?? audit.stderrTail ?? '');
      const vulnerabilities = Array.isArray((parsed as { vulnerabilities?: unknown[] } | null)?.vulnerabilities)
        ? (parsed as { vulnerabilities: unknown[] }).vulnerabilities
        : [];
      if (vulnerabilities.length > 0) {
        findings.push({
          category: 'security',
          severity: 'warning',
          title: 'pip-audit found vulnerable Python dependencies',
          detail: `${vulnerabilities.length} vulnerable package finding(s) were reported.`,
          evidence: tail(JSON.stringify(vulnerabilities.slice(0, 5)), 1200),
          fix: 'Upgrade the affected packages in requirements.txt.',
        });
      }
    }
  }

  if (!files.includes('.dockerignore')) {
    findings.push({
      category: 'security',
      severity: 'warning',
      title: 'Missing .dockerignore',
      detail: 'Docker may copy local secrets, caches, or large files into the image context.',
      fix: 'Add a .dockerignore that excludes .env, credentials, caches, data exports, and local build artifacts.',
    });
  }

  if (dockerfile) {
    if (!/^\s*USER\s+\S+/im.test(dockerfile)) {
      findings.push({
        category: 'security',
        severity: 'warning',
        title: 'Container runs as root',
        detail: 'The Dockerfile does not switch to a non-root USER.',
        fix: 'Create and switch to an unprivileged user in the runtime stage when practical.',
      });
    }
    if (/curl\b[^|\n]+https?:\/\/[^|\n]+\|\s*(?:sh|bash)|wget\b[^|\n]+https?:\/\/[^|\n]+\|\s*(?:sh|bash)/im.test(dockerfile)) {
      findings.push({
        category: 'security',
        severity: 'warning',
        title: 'Dockerfile pipes remote script into shell',
        detail: 'Remote install scripts can change without review and weaken build reproducibility.',
        evidence: dockerfile.match(/(?:curl|wget)[^\n]+\|\s*(?:sh|bash)/im)?.[0],
        fix: 'Prefer pinned packages, checksums, or vendored install scripts.',
      });
    }
  }

  for (const file of files.filter(isReviewableSourceFile).slice(0, 180)) {
    const content = await readOptional(join(cloneDir, file));
    if (!content) continue;
    collectSecurityFindings(file, content, findings);
  }
}

async function runSmokeTest(
  imageTag: string,
  containerPort: number,
  findings: ReviewFinding[],
  commandsRun: ReviewCommandRun[],
): Promise<void> {
  const hostPort = await getFreePort();
  const containerName = `tangent-review-${randomUUID()}`;
  const env = buildSmokeEnv(containerPort);

  const run = await runCommand(
    'docker',
    [
      'run', '-d',
      '--name', containerName,
      '-p', `127.0.0.1:${hostPort}:${containerPort}`,
      ...Object.entries(env).flatMap(([key, value]) => ['-e', `${key}=${value}`]),
      imageTag,
    ],
    { timeoutMs: 60_000 },
    commandsRun,
  );

  if (!run.success) {
    findings.push({
      category: 'runtime',
      severity: 'blocker',
      title: 'Container failed to start',
      detail: 'Docker could not start the built image.',
      evidence: tail([run.stdoutTail, run.stderrTail].filter(Boolean).join('\n'), 2000),
      fix: 'Fix the container startup error before deploying.',
    });
    return;
  }

  try {
    const deadline = Date.now() + 45_000;
    let lastStatus = '';
    while (Date.now() < deadline) {
      await sleep(2_000);
      const ps = await runCommand('docker', ['inspect', '-f', '{{.State.Running}} {{.State.ExitCode}} {{.State.Error}}', containerName], { timeoutMs: 15_000 }, commandsRun);
      if (!ps.success || ps.stdoutTail?.startsWith('false')) {
        const logs = await runCommand('docker', ['logs', '--tail', '120', containerName], { timeoutMs: 20_000 }, commandsRun);
        findings.push({
          category: 'runtime',
          severity: 'blocker',
          title: 'Container exited during smoke test',
          detail: 'The image built, but the app container stopped before it stayed reachable.',
          evidence: tail([ps.stdoutTail, logs.stdoutTail, logs.stderrTail].filter(Boolean).join('\n'), 3000),
          fix: 'Fix the startup/runtime exception shown in the container logs.',
        });
        return;
      }

      const status = await httpStatus(hostPort);
      lastStatus = status ?? lastStatus;
      if (status && /^[234]\d\d$/.test(status)) {
        return;
      }
    }

    const logs = await runCommand('docker', ['logs', '--tail', '120', containerName], { timeoutMs: 20_000 }, commandsRun);
    findings.push({
      category: 'runtime',
      severity: 'blocker',
      title: 'Container did not become HTTP-reachable',
      detail: `The container kept running but did not return an HTTP 2xx-4xx response on port ${containerPort}.`,
      evidence: tail([lastStatus ? `last HTTP status: ${lastStatus}` : '', logs.stdoutTail, logs.stderrTail].filter(Boolean).join('\n'), 3000),
      fix: 'Ensure the app binds to 0.0.0.0 on the exposed port and starts within the smoke-test window.',
    });
  } finally {
    await runCommand('docker', ['rm', '-f', containerName], { timeoutMs: 30_000 }, commandsRun).catch(() => undefined);
  }
}

function buildSmokeEnv(port: number): Record<string, string> {
  const env: Record<string, string> = {
    PORT: String(port),
    APP_PORT: String(port),
    DB_HOST: config().pgHostInternalIp,
    DB_PORT: '5432',
  };
  for (const secret of config().sharedAppSecrets) {
    if (secret.name) env[secret.name] = 'tangent-review-placeholder';
  }
  return env;
}

function collectRuntimeHazards(file: string, content: string, findings: ReviewFinding[]): void {
  if (/(?:localhost|127\.0\.0\.1)/.test(content) && /\.(js|ts|py|mjs|cjs)$/.test(file)) {
    const match = content.match(/.{0,80}(?:localhost|127\.0\.0\.1).{0,80}/);
    findings.push({
      category: 'deploy',
      severity: 'warning',
      title: 'Source references localhost',
      detail: `${file} references localhost/127.0.0.1. This can break in containers if used for bound services or external dependencies.`,
      evidence: match?.[0],
      fix: 'Use 0.0.0.0 for server binds and environment variables for external service hosts.',
    });
  }

  if (/st\.session_state\[[^\]]+\]\s*=/.test(content) && /st\.slider\(/.test(content) && /key\s*=/.test(content)) {
    findings.push({
      category: 'quality',
      severity: 'warning',
      title: 'Potential Streamlit widget/session_state conflict',
      detail: `${file} assigns Streamlit session state and creates keyed sliders. Review for default-value conflicts.`,
      evidence: 'st.session_state[...] assignment + st.slider(... key=...)',
      fix: 'Initialize widget keys with setdefault before widget creation, or avoid passing default values after session_state is set.',
    });
  }
}

function collectSecurityFindings(file: string, content: string, findings: ReviewFinding[]): void {
  if (/^\.env($|\.)/.test(file) && !/\.example$|\.sample$|\.template$/i.test(file)) {
    findings.push({
      category: 'security',
      severity: 'blocker',
      title: 'Environment file committed',
      detail: `${file} appears to be committed. It may contain secrets that should live in AWS Secrets Manager.`,
      evidence: file,
      fix: 'Remove committed secrets, rotate exposed values, and add the file to .gitignore/.dockerignore.',
    });
  }

  const secretPatterns: Array<{ re: RegExp; title: string }> = [
    { re: /AKIA[0-9A-Z]{16}/g, title: 'AWS access key detected' },
    { re: /xox[baprs]-[A-Za-z0-9-]{20,}/g, title: 'Slack token detected' },
    { re: /ghp_[A-Za-z0-9_]{30,}/g, title: 'GitHub token detected' },
    { re: /sk-ant-[A-Za-z0-9_-]{20,}/g, title: 'Anthropic API key detected' },
    { re: /sk-[A-Za-z0-9]{32,}/g, title: 'API key-like secret detected' },
    { re: /-----BEGIN (?:RSA |EC |OPENSSH |)PRIVATE KEY-----/g, title: 'Private key detected' },
    { re: /(?:postgres|postgresql|mysql):\/\/[^:\s'"]+:[^@\s'"]+@/g, title: 'Database URL with password detected' },
  ];

  for (const pattern of secretPatterns) {
    const match = content.match(pattern.re);
    if (match) {
      findings.push({
        category: 'security',
        severity: 'blocker',
        title: pattern.title,
        detail: `${file} contains a high-confidence credential pattern.`,
        evidence: maskSecret(match[0]),
        fix: 'Remove the secret from git, rotate it, and inject it from AWS Secrets Manager.',
      });
    }
  }

  const warningPatterns: Array<{ re: RegExp; title: string; fix: string }> = [
    { re: /\bdebug\s*=\s*True\b/g, title: 'Debug mode may be enabled', fix: 'Ensure debug mode is disabled in production.' },
    { re: /\bshell\s*=\s*True\b/g, title: 'subprocess shell=True detected', fix: 'Avoid shell=True, especially with user-controlled input.' },
    { re: /\beval\s*\(|\bexec\s*\(/g, title: 'eval/exec detected', fix: 'Remove dynamic code execution or tightly constrain inputs.' },
    { re: /yaml\.load\s*\((?![^)]*SafeLoader)/g, title: 'Unsafe YAML loading detected', fix: 'Use yaml.safe_load or SafeLoader.' },
    { re: /allow_origins\s*=\s*\[[^\]]*['"]\*['"][^\]]*\].{0,120}allow_credentials\s*=\s*True/gs, title: 'CORS wildcard with credentials', fix: 'Use explicit allowed origins when credentials are enabled.' },
  ];

  for (const pattern of warningPatterns) {
    const match = content.match(pattern.re);
    if (match) {
      findings.push({
        category: 'security',
        severity: 'warning',
        title: pattern.title,
        detail: `${file} contains a potentially risky security pattern.`,
        evidence: tail(match[0].replace(/\s+/g, ' '), 240),
        fix: pattern.fix,
      });
    }
  }
}

function detectFramework(files: string[], packageJson: unknown, requirementsTxt: string | null): string {
  const req = requirementsTxt?.toLowerCase() ?? '';
  const pkg = packageJson && typeof packageJson === 'object' ? packageJson as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> } : null;
  const deps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };
  if (req.includes('streamlit') || files.some((file) => file.toLowerCase().includes('streamlit'))) return 'Python / Streamlit';
  if (req.includes('fastapi')) return 'Python / FastAPI';
  if (req.includes('flask')) return 'Python / Flask';
  if ('next' in deps) return 'Node / Next.js';
  if ('react' in deps) return 'Node / React';
  if (packageJson) return 'Node';
  if (requirementsTxt) return 'Python';
  return 'Unknown';
}

function detectPort(dockerfile: string | null, packageJson: unknown, files: string[]): number | null {
  const expose = dockerfile?.match(/^EXPOSE\s+(\d+)/im);
  if (expose) return Number(expose[1]);
  if (packageJson && typeof packageJson === 'object') {
    const scripts = (packageJson as { scripts?: Record<string, string> }).scripts ?? {};
    const scriptText = Object.values(scripts).join(' ');
    const portMatch = scriptText.match(/(?:--port|-p)\s+(\d+)/);
    if (portMatch) return Number(portMatch[1]);
    if (scriptText.includes('next')) return 3000;
  }
  if (files.some((file) => file.endsWith('.py'))) return 8501;
  return null;
}

async function runCommand(
  file: string,
  args: string[],
  opts: { cwd?: string; timeoutMs?: number } = {},
  commandsRun: ReviewCommandRun[],
): Promise<ReviewCommandRun> {
  const command = [file, ...args].join(' ');
  try {
    const result = await execCommand(file, args, opts);
    const run = { command, success: true, stdoutTail: tail(result.stdout, 4000), stderrTail: tail(result.stderr, 4000) };
    commandsRun.push(run);
    return run;
  } catch (err) {
    const failure = err as CommandFailure;
    const run = {
      command,
      success: false,
      exitCode: failure.code,
      stdoutTail: tail(String(failure.stdout ?? ''), 4000),
      stderrTail: tail(String(failure.stderr ?? failure.message ?? ''), 4000),
    };
    commandsRun.push(run);
    return run;
  }
}

async function listFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      const rel = relative(root, fullPath);
      if (shouldSkipPath(rel)) continue;
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile()) {
        out.push(rel);
      }
    }
  }
  await walk(root);
  return out.sort();
}

function shouldSkipPath(path: string): boolean {
  return /(^|\/)(\.git|node_modules|dist|build|\.next|\.venv|venv|__pycache__|\.mypy_cache|\.pytest_cache)(\/|$)/.test(path);
}

function isReviewableSourceFile(file: string): boolean {
  if (shouldSkipPath(file)) return false;
  const ext = file.includes('.') ? file.slice(file.lastIndexOf('.')) : '';
  return SOURCE_EXTENSIONS.has(ext) || ['Dockerfile', '.dockerignore', '.env'].includes(file);
}

async function readOptional(path: string): Promise<string | null> {
  try {
    await access(path);
    const buffer = await readFile(path);
    if (buffer.includes(0)) return null;
    return buffer.toString('utf8').slice(0, 1_000_000);
  } catch {
    return null;
  }
}

async function readJsonOptional(path: string): Promise<unknown | null> {
  const content = await readOptional(path);
  if (!content) return null;
  return parseJson(content);
}

function parseJson(text: string): unknown | null {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function sanitizeTag(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_.-]/g, '-').slice(0, 40);
}

function tail(text: string, max: number): string {
  return text.length <= max ? text : text.slice(-max);
}

function maskSecret(secret: string): string {
  if (secret.length <= 12) return '***';
  return `${secret.slice(0, 6)}...${secret.slice(-4)}`;
}

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (typeof address !== 'object' || address === null) {
        server.close();
        reject(new Error('Could not allocate a local port'));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

async function httpStatus(port: number): Promise<string | null> {
  return new Promise((resolve) => {
    const req = request({ host: '127.0.0.1', port, path: '/', method: 'GET', timeout: 3000 }, (res) => {
      res.resume();
      resolve(String(res.statusCode ?? 'unknown'));
    });
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
    req.on('error', () => resolve(null));
    req.end();
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
