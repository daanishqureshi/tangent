/**
 * skills/scan.ts
 *
 * Nightly CVE scan across all scaffold-child repos.
 * Runs pip-audit (Python) and npm audit (Node) and reports HIGH/CRITICAL
 * findings to Slack.
 *
 * Called by cron/cve-scan.ts at 2 AM UTC.
 */

import { join } from 'node:path';
import { access } from 'node:fs/promises';
import { listScaffoldChildRepos, cloneRepo, removeClone } from '../services/github.js';
import { notifyCveScan, notifyCveScanSummary } from '../services/slack.js';
import { execCommand } from '../utils/exec.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

interface CveFinding {
  pkg: string;
  cve: string;
  severity: string;
}

interface ScanSummary {
  total: number;
  clean: number;
  vulnerable: number;
}

export async function scanSkill(): Promise<ScanSummary> {
  const { workspaceDir } = config();

  logger.info({ action: 'scan:start' }, 'Starting nightly CVE scan');

  const repos = await listScaffoldChildRepos();
  let clean = 0;
  let vulnerable = 0;

  for (const repo of repos) {
    const timestamp = Date.now();
    const cloneDir = join(workspaceDir, `scan-${repo}-${timestamp}`);

    try {
      await cloneRepo(repo, cloneDir);
    } catch (err) {
      logger.error({ action: 'scan:clone_failed', repo, err }, 'Failed to clone repo for scan');
      continue;
    }

    try {
      const findings: CveFinding[] = [];

      // Python: pip-audit
      const hasPipAudit = await fileExists(join(cloneDir, 'requirements.txt')) ||
        await fileExists(join(cloneDir, 'pyproject.toml'));

      if (hasPipAudit) {
        const pyFindings = await runPipAudit(cloneDir);
        findings.push(...pyFindings);
      }

      // Node: npm audit
      if (await fileExists(join(cloneDir, 'package.json'))) {
        const nodeFindings = await runNpmAudit(cloneDir);
        findings.push(...nodeFindings);
      }

      if (findings.length > 0) {
        vulnerable++;
        logger.warn({ action: 'scan:findings', repo, count: findings.length }, 'CVEs found');
        await notifyCveScan({ repo, findings });
      } else {
        clean++;
        logger.info({ action: 'scan:clean', repo }, 'No CVEs found');
      }
    } finally {
      await removeClone(cloneDir);
    }
  }

  const summary: ScanSummary = { total: repos.length, clean, vulnerable };
  await notifyCveScanSummary(repos.length, clean, vulnerable);
  logger.info({ action: 'scan:done', ...summary }, 'CVE scan complete');

  return summary;
}

// ─── Auditors ─────────────────────────────────────────────────────────────────

async function runPipAudit(cwd: string): Promise<CveFinding[]> {
  try {
    const { stdout } = await execCommand(
      'pip-audit',
      ['--format', 'json', '--no-deps'],
      { cwd, timeoutMs: 3 * 60 * 1000 },
    );

    const parsed = JSON.parse(stdout) as PipAuditOutput;
    return extractPipFindings(parsed);
  } catch (err) {
    // pip-audit exits with code 1 when vulnerabilities are found — execFile throws.
    // Try to parse stdout from the error object.
    const raw = extractStdout(err);
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw) as PipAuditOutput;
      return extractPipFindings(parsed);
    } catch {
      logger.warn({ action: 'scan:pip_audit_parse_failed', err }, 'Could not parse pip-audit output');
      return [];
    }
  }
}

async function runNpmAudit(cwd: string): Promise<CveFinding[]> {
  try {
    const { stdout } = await execCommand(
      'npm',
      ['audit', '--json'],
      { cwd, timeoutMs: 2 * 60 * 1000 },
    );
    const parsed = JSON.parse(stdout) as NpmAuditOutput;
    return extractNpmFindings(parsed);
  } catch (err) {
    const raw = extractStdout(err);
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw) as NpmAuditOutput;
      return extractNpmFindings(parsed);
    } catch {
      logger.warn({ action: 'scan:npm_audit_parse_failed', err }, 'Could not parse npm audit output');
      return [];
    }
  }
}

// ─── Parsers ──────────────────────────────────────────────────────────────────

interface PipAuditOutput {
  dependencies?: Array<{
    name: string;
    version: string;
    vulns: Array<{ id: string; fix_versions: string[]; aliases: string[] }>;
  }>;
}

function extractPipFindings(output: PipAuditOutput): CveFinding[] {
  const findings: CveFinding[] = [];
  const HIGH_SEVERITY_MARKERS = ['HIGH', 'CRITICAL'];

  for (const dep of output.dependencies ?? []) {
    for (const vuln of dep.vulns) {
      // pip-audit doesn't expose severity directly; use CVE ID prefix as a heuristic.
      // Treat all findings as HIGH since they were explicitly reported.
      const cveId = vuln.aliases.find((a) => a.startsWith('CVE-')) ?? vuln.id;
      findings.push({ pkg: `${dep.name} ${dep.version}`, cve: cveId, severity: 'HIGH' });
    }
  }

  return findings;
}

interface NpmAuditOutput {
  vulnerabilities?: Record<string, {
    severity: string;
    via: Array<{ url?: string; cwe?: string[] } | string>;
  }>;
}

const CRITICAL_SEVERITIES = new Set(['high', 'critical']);

function extractNpmFindings(output: NpmAuditOutput): CveFinding[] {
  const findings: CveFinding[] = [];

  for (const [pkgName, vuln] of Object.entries(output.vulnerabilities ?? {})) {
    if (!CRITICAL_SEVERITIES.has(vuln.severity.toLowerCase())) continue;

    // Extract CVE IDs from via chain
    const cveIds = vuln.via
      .flatMap((v) => {
        if (typeof v === 'string') return [];
        return (v.cwe ?? []).filter((c) => c.startsWith('CVE-'));
      });

    const cve = cveIds[0] ?? 'CVE-UNKNOWN';
    findings.push({ pkg: pkgName, cve, severity: vuln.severity.toUpperCase() });
  }

  return findings;
}

// ─── Utils ────────────────────────────────────────────────────────────────────

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function extractStdout(err: unknown): string | null {
  if (err && typeof err === 'object' && 'stdout' in err) {
    return String((err as { stdout: string }).stdout);
  }
  return null;
}
