/**
 * services/slack.ts
 *
 * Slack Web API client + Block Kit helpers for Tangent notifications.
 */

import { WebClient, type KnownBlock } from '@slack/web-api';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

let _slack: WebClient | null = null;

export function initSlackClient(): void {
  _slack = new WebClient(config().slackToken);
}

function slack(): WebClient {
  if (!_slack) throw new Error('Slack client not initialized — call initSlackClient() first');
  return _slack;
}

async function postBlocks(blocks: KnownBlock[], fallbackText: string): Promise<void> {
  try {
    await slack().chat.postMessage({
      channel: config().slackChannel,
      text: fallbackText,
      blocks,
    });
  } catch (err) {
    logger.error({ action: 'slack:post:error', err }, 'Failed to post Slack message');
  }
}

// ─── Notification Helpers ─────────────────────────────────────────────────────

export async function notifyDeployed(params: {
  repo: string;
  url: string;
  imageTag: string;
  actor?: string;
}): Promise<void> {
  const { repo, url, imageTag, actor } = params;
  const actorLine = actor ? `*Deployed by:* ${actor}` : '';

  await postBlocks(
    [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: [
            `🚀 *${repo}* deployed`,
            actorLine,
            `*URL:* ${url}`,
            `*Image:* \`${imageTag}\``,
            `*Cluster:* \`${config().ecsClusterName}\``,
          ]
            .filter(Boolean)
            .join('\n'),
        },
      },
    ],
    `🚀 ${repo} deployed — ${url}`,
  );
}

export async function notifyDeployUrl(repo: string, url: string): Promise<void> {
  await postBlocks(
    [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `🔗 *${repo}* tunnel ready: ${url}`,
        },
      },
    ],
    `🔗 ${repo} tunnel ready: ${url}`,
  );
}

export async function notifyDeployError(repo: string, summary: string, raw?: string): Promise<void> {
  const blocks: KnownBlock[] = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `❌ *${repo}* deploy failed\n${summary}`,
      },
    },
  ];

  if (raw) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `\`\`\`\n${raw.slice(0, 2800)}\n\`\`\``,
      },
    });
  }

  await postBlocks(blocks, `❌ ${repo} deploy failed: ${summary}`);
}

export async function notifyTeardown(repo: string, actor?: string): Promise<void> {
  const actorLine = actor ? ` by ${actor}` : '';
  await postBlocks(
    [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `🛑 *${repo}* torn down${actorLine}` },
      },
    ],
    `🛑 ${repo} torn down${actorLine}`,
  );
}

export async function notifyHealthAlert(params: {
  repo: string;
  running: number;
  desired: number;
  reason?: string;
}): Promise<void> {
  const { repo, running, desired, reason } = params;
  const reasonLine = reason ? `\n*Reason:* ${reason}` : '';

  await postBlocks(
    [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `⚠️ *${repo}* — service degraded\nRunning: ${running}/${desired} tasks${reasonLine}`,
        },
      },
    ],
    `⚠️ ${repo} degraded — ${running}/${desired} tasks running`,
  );
}

export async function notifyCveScan(params: {
  repo: string;
  findings: Array<{ pkg: string; cve: string; severity: string }>;
  fixCommand?: string;
}): Promise<void> {
  const { repo, findings, fixCommand } = params;
  const lines = findings.map((f) => `• \`${f.pkg}\` — ${f.cve} (${f.severity})`).join('\n');
  const fix = fixCommand ? `\nRun \`${fixCommand}\` to fix.` : '';

  await postBlocks(
    [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `🔒 CVE scan found *${findings.length}* HIGH/CRITICAL vulnerabilities in *${repo}*\n${lines}${fix}`,
        },
      },
    ],
    `🔒 ${findings.length} CVEs in ${repo}`,
  );
}

export async function notifyCveScanSummary(total: number, clean: number, vulnerable: number): Promise<void> {
  await postBlocks(
    [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `🔒 CVE scan complete — scanned *${total}* repos. ✅ ${clean} clean, ⚠️ ${vulnerable} with vulnerabilities.`,
        },
      },
    ],
    `🔒 CVE scan: ${total} repos, ${clean} clean, ${vulnerable} vulnerable`,
  );
}
