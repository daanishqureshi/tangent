/**
 * skills/tunnel.ts
 *
 * Wait for the ngrok tunnel to come online after an ECS deploy.
 *
 * Strategy (fastest first):
 *
 *   1. HTTP polling — since we pre-generate the URL, just hit it directly.
 *      ngrok's edge returns "Tunnel not found" (404 + body) when offline, and
 *      anything else (200, 502, etc.) means the tunnel is accepting connections.
 *      No CloudWatch delivery delay — detects within ~2s of tunnel coming up.
 *
 *   2. CloudWatch fallback — if no expectedUrl is provided (legacy callers),
 *      fall back to the old log-scraping approach.
 *
 * Input:  { repo, timeoutMs?, deployedAt?, expectedUrl? }
 * Output: { url }
 */

import {
  DescribeLogStreamsCommand,
  GetLogEventsCommand,
} from '@aws-sdk/client-cloudwatch-logs';
import { cwlClient } from '../services/aws.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import {
  DEFAULT_TUNNEL_TIMEOUT_MS,
  TUNNEL_POLL_INTERVAL_MS,
  TUNNEL_HTTP_POLL_INTERVAL_MS,
} from '../utils/constants.js';

export interface TunnelInput {
  repo: string;
  timeoutMs?: number;
  deployedAt?: number;   // only read log streams created after this timestamp
  expectedUrl?: string;  // pre-generated URL — HTTP-poll this directly
}

export interface TunnelOutput {
  url: string;
}

export class TunnelTimeoutError extends Error {
  constructor(repo: string, timeoutMs: number) {
    super(
      `Timed out waiting for ngrok tunnel URL for ${repo} after ${timeoutMs}ms. ` +
        'Check CloudWatch Logs for errors in the ngrok container.',
    );
    this.name = 'TunnelTimeoutError';
  }
}

export async function tunnelSkill(input: TunnelInput): Promise<TunnelOutput> {
  const { repo, expectedUrl } = input;
  const timeoutMs  = input.timeoutMs ?? DEFAULT_TUNNEL_TIMEOUT_MS;
  const deployedAt = input.deployedAt ?? Date.now();

  logger.info({ action: 'tunnel:start', repo, timeoutMs, deployedAt, expectedUrl }, 'Polling for ngrok URL');

  // Fast path: we know the URL upfront — HTTP poll it directly
  if (expectedUrl) {
    const url = await httpPollForTunnel(expectedUrl, timeoutMs, repo);
    return { url };
  }

  // Fallback: parse URL out of CloudWatch logs (legacy / no pre-generated URL)
  const url = await cloudWatchPollForUrl(repo, deployedAt, timeoutMs);
  return { url };
}

// ─── HTTP polling (primary) ───────────────────────────────────────────────────

/**
 * Poll the expected ngrok URL via HTTP until it stops returning "Tunnel not found".
 *
 * ngrok edge behavior:
 *   - Tunnel offline  → HTTP 404, body contains "ERR_NGROK_3200" or "Tunnel not found"
 *   - Tunnel online   → any other response (200, 502 if app not ready yet, etc.)
 *
 * We treat any non-"tunnel-not-found" response as success — the tunnel IS up even
 * if the app behind it returns a 502.
 */
async function httpPollForTunnel(url: string, timeoutMs: number, repo: string): Promise<string> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, {
        method: 'GET',
        // Short timeout per attempt — don't hang for 30s on a slow connection
        signal: AbortSignal.timeout(5_000),
        headers: { 'User-Agent': 'tangent-tunnel-check/1.0' },
      });

      // ngrok returns 404 with a specific body when the tunnel doesn't exist yet
      if (res.status === 404) {
        const body = await res.text().catch(() => '');
        if (body.includes('ERR_NGROK') || body.toLowerCase().includes('tunnel') ) {
          // Still not up — wait and retry
          logger.debug({ action: 'tunnel:http_poll', url, status: 404 }, 'Tunnel not yet online');
          await sleep(TUNNEL_HTTP_POLL_INTERVAL_MS);
          continue;
        }
      }

      // Any other response means the tunnel is live
      logger.info({ action: 'tunnel:http_found', url, status: res.status }, 'ngrok tunnel is online via HTTP poll');
      return url;
    } catch (err: unknown) {
      // Network error (ECONNREFUSED, timeout) — tunnel not up yet
      const msg = err instanceof Error ? err.message : String(err);
      logger.debug({ action: 'tunnel:http_poll_err', url, err: msg }, 'HTTP poll attempt failed');
      await sleep(TUNNEL_HTTP_POLL_INTERVAL_MS);
    }
  }

  throw new TunnelTimeoutError(repo, timeoutMs);
}

// ─── CloudWatch polling (fallback) ───────────────────────────────────────────

async function cloudWatchPollForUrl(repo: string, deployedAt: number, timeoutMs: number): Promise<string> {
  const { logGroupName } = config();
  const logStreamPrefix  = `${repo}-ngrok`;
  const deadline         = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const url = await cwPollForUrl(logGroupName, logStreamPrefix, deployedAt);
    if (url) {
      logger.info({ action: 'tunnel:cw_found', repo, url }, 'ngrok tunnel URL found in CloudWatch');
      return url;
    }
    await sleep(TUNNEL_POLL_INTERVAL_MS);
  }

  throw new TunnelTimeoutError(repo, timeoutMs);
}

async function cwPollForUrl(logGroupName: string, logStreamPrefix: string, deployedAt: number): Promise<string | null> {
  let logStreamName: string | undefined;
  try {
    const streamsResult = await cwlClient().send(
      new DescribeLogStreamsCommand({
        logGroupName,
        logStreamNamePrefix: logStreamPrefix,
        limit: 20,
      }),
    );
    const fresh = (streamsResult.logStreams ?? [])
      .filter((s) => (s.creationTime ?? 0) >= deployedAt - 30_000)
      .sort((a, b) => (b.creationTime ?? 0) - (a.creationTime ?? 0));
    logStreamName = fresh[0]?.logStreamName;
  } catch {
    return null;
  }

  if (!logStreamName) return null;

  try {
    const eventsResult = await cwlClient().send(
      new GetLogEventsCommand({
        logGroupName,
        logStreamName,
        limit: 200,
        startFromHead: false,
      }),
    );

    for (const event of eventsResult.events ?? []) {
      const message = event.message;
      if (!message) continue;
      const url = extractNgrokUrl(message);
      if (url) return url;
    }
  } catch {
    return null;
  }

  return null;
}

function extractNgrokUrl(logLine: string): string | null {
  try {
    const parsed = JSON.parse(logLine) as Record<string, unknown>;
    const url = parsed['url'];
    if (typeof url === 'string' && url.startsWith('https://') && url.includes('ngrok')) {
      return url;
    }
  } catch {
    const match = logLine.match(/https:\/\/[a-zA-Z0-9-]+\.ngrok[^"'\s]*/);
    if (match) return match[0];
  }
  return null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
