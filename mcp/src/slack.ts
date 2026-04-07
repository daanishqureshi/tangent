/**
 * mcp/src/slack.ts
 *
 * Slack transport for the Tangent MCP server.
 *
 * Each MCP tool call:
 *   1. Posts a natural-language command to #tangent-mcp, @mentioning Tangent,
 *      using the developer's own Slack user token — so Tangent sees their real
 *      user ID and all existing identity/access-control rules apply unchanged.
 *   2. Polls the resulting thread until Tangent posts a terminal response
 *      (✅ success, ❌ failure, ⚠️ warning, 🛑 stopped).
 *   3. Returns the final message text to the MCP caller.
 *
 * Deploy calls time out after 3 minutes (Daanish must approve in Slack).
 * Read-only calls time out after 60 seconds.
 */

import { WebClient } from '@slack/web-api';

// ─── Config (from env) ────────────────────────────────────────────────────────

const SLACK_TOKEN           = process.env['SLACK_USER_TOKEN']      ?? '';
const TANGENT_BOT_USER_ID   = process.env['TANGENT_BOT_USER_ID']   ?? 'U0AQCAG3H4P';
const TANGENT_MCP_CHANNEL   = process.env['TANGENT_MCP_CHANNEL']   ?? 'C0AR9F0UPJQ';
// Required when using a bot token (xoxb-) so Tangent knows who is calling.
// Not needed with a user token (xoxp-) — identity is inferred from the token.
const SLACK_CALLER_ID       = process.env['SLACK_CALLER_ID']       ?? '';

if (!SLACK_TOKEN)         throw new Error('TANGENT_MCP: SLACK_USER_TOKEN is required');

const isBotToken = SLACK_TOKEN.startsWith('xoxb-');
if (isBotToken && !SLACK_CALLER_ID) {
  throw new Error('TANGENT_MCP: SLACK_CALLER_ID is required when using a bot token (xoxb-) — set it to your Slack user ID, e.g. U07EU7KSG3U');
}

const slack = new WebClient(SLACK_TOKEN);

// ─── Polling constants ────────────────────────────────────────────────────────

const POLL_INTERVAL_MS = 3_000;

// These prefixes signal Tangent is done — stop polling immediately.
const TERMINAL_PREFIXES = ['✅', '❌', '⚠️', '🛑'];

// These patterns mean Tangent is still working — keep polling.
const LOADING_PATTERNS  = [
  '_On it..._',
  '🔨 Building',
  '🚀 Build done',
  '⏳ ECS service',
  '⏳ Waiting',
  'Waiting for ngrok',
];

function isTerminal(text: string): boolean {
  if (TERMINAL_PREFIXES.some((p) => text.startsWith(p))) return true;
  // Teardown success message doesn't start with ✅ but contains "stopped" / "nothing was changed"
  if (text.includes('nothing was changed')) return true;
  return false;
}

function isLoading(text: string): boolean {
  return LOADING_PATTERNS.some((p) => text.includes(p));
}

// ─── Core: post command → poll thread → return result ─────────────────────────

/**
 * Post a natural-language command to #tangent-mcp as the developer,
 * wait for Tangent's final response, and return it.
 *
 * @param command   Plain text command (without the @mention — added here)
 * @param timeoutMs How long to wait before giving up
 */
export async function postAndWait(command: string, timeoutMs: number): Promise<string> {
  // When using a bot token, prefix with [MCP-USER: ID] so Tangent knows
  // the real caller's identity. User tokens don't need this — identity
  // is read directly from the Slack event's `user` field.
  const prefix = isBotToken ? `[MCP-USER: ${SLACK_CALLER_ID}] ` : '';

  const post = await slack.chat.postMessage({
    channel: TANGENT_MCP_CHANNEL,
    text: `${prefix}<@${TANGENT_BOT_USER_ID}> ${command}`,
  });

  const threadTs = post.ts as string;
  const deadline  = Date.now() + timeoutMs;

  let lastBotText = '';

  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);

    const replies = await slack.conversations.replies({
      channel: TANGENT_MCP_CHANNEL,
      ts: threadTs,
      limit: 30,
    });

    const messages = replies.messages ?? [];

    // All bot messages in the thread, excluding the original post
    // (Tangent's updates land on a single message via chat.update, so the
    //  latest bot message IS the current state of that message)
    const botMessages = messages.filter(
      (m) => (m.bot_id || m.app_id) && m.ts !== threadTs,
    );

    if (botMessages.length === 0) continue;

    const latest    = botMessages[botMessages.length - 1];
    const latestText = latest.text ?? '';

    // Terminal state — Tangent is done
    if (isTerminal(latestText)) return latestText;

    // Not loading anymore, and has real content — info tool response is ready
    if (!isLoading(latestText) && latestText.length > 30) {
      // Wait one more poll to make sure it isn't still being updated
      if (latestText === lastBotText) return latestText;
    }

    lastBotText = latestText;
  }

  // Timed out
  if (lastBotText) {
    return `[Timed out — last known status]\n${lastBotText}\n\nCheck #tangent-mcp in Slack for the latest update.`;
  }
  return `Timed out waiting for Tangent (${timeoutMs / 1000}s). Check #tangent-mcp in Slack.`;
}

// ─── Helper ───────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
