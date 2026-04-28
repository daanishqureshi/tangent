/**
 * services/slack-bot.ts
 *
 * Slack Bolt app in Socket Mode — no public URL required.
 *
 * Architecture (OpenClaw-style):
 *   1. Message arrives (DM or @mention in channel/thread)
 *   2. Build conversation history from Slack (threads) or in-memory store (DMs)
 *   3. Single Claude call via processMessage() — Claude either calls a tool or
 *      replies conversationally. No separate intent-classification layer.
 *   4. If tool → execute the matching skill and post progress updates
 *   5. If text → post Claude's reply directly
 *   6. Append both turns to the in-memory conversation store
 *
 * Tangent handles anything: DevOps commands AND general questions AND follow-ups,
 * all in one natural conversation.
 */

import { App, LogLevel } from '@slack/bolt';
import type { WebClient } from '@slack/web-api';
import type { KnownBlock } from '@slack/types';
import { config, allowUser } from '../config.js';
import { processMessage, continueAfterTool, classifyConsent, diagnoseServiceFailure, identifyFileToFix, generateCodeFix, type ConversationTurn, type AgentToolCall } from './ai.js';
import { buildSkill, DockerfileNotFoundError, DockerBuildError } from '../skills/build.js';
import { deploySkill } from '../skills/deploy.js';
import { tunnelSkill, TunnelTimeoutError } from '../skills/tunnel.js';
import { teardownSkill } from '../skills/teardown.js';
import { scanSkill } from '../skills/scan.js';
import { discoverSkill } from '../skills/discover.js';
import { listAllRepos, inspectRepo, pushFile, readRepoFile, listCommits, editFile } from './github.js';
import { logger } from '../utils/logger.js';

// ─── App singleton ────────────────────────────────────────────────────────────

let _app: App | null = null;

/**
 * Tangent's own Slack member ID, captured at startup via auth.test().
 * Used to distinguish its own `<@BOT_ID>` mentions (which should be stripped
 * from user text) from mentions of OTHER users (which must be preserved so
 * Claude can use them as tool input — e.g. `allow_user`).
 */
let _botUserId: string | null = null;

/**
 * Strip Tangent's own @mention from a user message, but preserve every other
 * `<@USERID>` mention verbatim. This is critical: the old implementation
 * regex-stripped *every* `<@USERID>` token, which meant when Daanish said
 * "add @Sam Thomas", Sam's Slack ID was deleted before Claude ever saw it,
 * and Claude had to invent a user_id for `allow_user` — picking the most
 * recent ID from earlier thread context (e.g. Brian Ongioni).
 *
 * We keep foreign mentions as raw `<@USERID>` tokens so:
 *   - Claude can read them as identifiers
 *   - the system prompt can teach it "body-mention ID = tool user_id"
 *   - replies that include the same token render as proper Slack mentions
 */
function sanitizeSlackText(text: string): string {
  if (!text) return text;
  // Strip Tangent's own mention (and any leftover whitespace from the strip).
  // Fallback: if bot ID isn't loaded yet, strip NO mentions — it's safer to
  // leave an extra "@Tangent" in the text than to lose a target user's ID.
  if (_botUserId) {
    const botMention = new RegExp(`<@${_botUserId}>`, 'g');
    text = text.replace(botMention, '');
  }
  return text.replace(/\s+/g, ' ').trim();
}

// ─── Access control ───────────────────────────────────────────────────────────

/** The channel where all deploy/teardown notifications and approvals live. */
const DEPLOY_CHANNEL = 'C0AQZ16BKAN'; // #tangent-deployments

/** Only this user can approve deploys and initiate/approve teardowns. */
const APPROVER_ID = 'U07EU7KSG3U'; // Daanish — the GOAT

// ─── Pending confirmation store ───────────────────────────────────────────────
//
// Before executing any action that touches AWS (deploy, teardown), Tangent
// posts a confirmation prompt and stores the pending action here.
// The NEXT message in that conversation either confirms or cancels it.
//
// Confirmations expire after 3 minutes of no response.

const CONFIRM_TTL_MS = 3 * 60 * 1000;

interface PendingConfirmation {
  call: AgentToolCall;
  prompt: string;
  expiresAt: number;
  requiredApproverId?: string; // if set, only this user ID can confirm
  requestedBy?: string;        // user who originally requested the action
}

const _pendingConfirmations = new Map<string, PendingConfirmation>();

function _setPending(convKey: string, call: AgentToolCall, prompt: string, requiredApproverId?: string, requestedBy?: string): void {
  _pendingConfirmations.set(convKey, { call, prompt, expiresAt: Date.now() + CONFIRM_TTL_MS, requiredApproverId, requestedBy });
}

function _getPending(convKey: string): PendingConfirmation | null {
  const p = _pendingConfirmations.get(convKey);
  if (!p) return null;
  if (Date.now() > p.expiresAt) { _pendingConfirmations.delete(convKey); return null; }
  return p;
}

function _clearPending(convKey: string): void {
  _pendingConfirmations.delete(convKey);
}

// ─── Per-conversation processing lock ───────────────────────────────────────
//
// Prevents concurrent processMessage calls for the same conversation.
// Without this, impatient follow-up messages ("did you add the others too?")
// spawn parallel route() calls that re-trigger the same tool chain, causing
// repeated/duplicated actions (e.g. saving the same secret three times).
//
const _processingLock = new Set<string>();

// Consent classification is handled by classifyConsent() in ai.ts (Claude haiku).
// These stubs remain for call-site compatibility but are no longer used directly —
// the async classifier is called in route() instead.

// ─── In-memory conversation store ─────────────────────────────────────────────
//
// Tangent keeps its own record of every conversation so Claude always has
// context for follow-up questions.
//
// Key strategy:
//   • Channel threads  → read from Slack conversations.replies on every message
//                        (bounded to that thread, survives process restarts)
//   • DMs              → in-memory store keyed by channel ID
//                        (Slack DM history is unbounded and risks pulling in stale data)
//
// Thread participation tracking:
//   • _activeThreads   → Set of "channel:threadTs" keys where Tangent has posted.
//                        Thread replies without @mention are routed if the key is here.
//                        Each entry has an expiry time matching CONV_TTL_MS.
//
// Conversations expire after 30 min of inactivity.

const CONV_TTL_MS    = 30 * 60 * 1000;
const CONV_MAX_TURNS = 12;

interface ConvEntry {
  turns: ConversationTurn[];
  lastActivity: number;
}

const _conversations = new Map<string, ConvEntry>();

/** Threads where Tangent has posted at least once. Value = expiry epoch ms. */
const _activeThreads = new Map<string, number>();

function _markActiveThread(channel: string, threadTs: string): void {
  _activeThreads.set(`${channel}:${threadTs}`, Date.now() + CONV_TTL_MS);
}

function _isActiveThread(channel: string, threadTs: string): boolean {
  const key = `${channel}:${threadTs}`;
  const expiry = _activeThreads.get(key);
  if (!expiry) return false;
  if (Date.now() > expiry) { _activeThreads.delete(key); return false; }
  return true;
}

function _convKey(channel: string, threadTs: string, source: 'mention' | 'dm'): string {
  return source === 'dm' ? channel : `${channel}:${threadTs}`;
}

function _getHistory(key: string): ConversationTurn[] {
  const entry = _conversations.get(key);
  if (!entry) return [];
  if (Date.now() - entry.lastActivity > CONV_TTL_MS) {
    _conversations.delete(key);
    return [];
  }
  return [...entry.turns];
}

function _appendTurn(key: string, turn: ConversationTurn): void {
  let entry = _conversations.get(key);
  if (!entry || Date.now() - entry.lastActivity > CONV_TTL_MS) {
    entry = { turns: [], lastActivity: Date.now() };
    _conversations.set(key, entry);
  }
  entry.turns.push(turn);
  entry.lastActivity = Date.now();
  if (entry.turns.length > CONV_MAX_TURNS) {
    entry.turns = entry.turns.slice(-CONV_MAX_TURNS);
  }
}

// ─── History builder ──────────────────────────────────────────────────────────

async function buildHistory(
  client: WebClient,
  convKey: string,
  channel: string,
  threadTs: string,
  currentMessageTs: string,
  source: 'mention' | 'dm',
): Promise<ConversationTurn[]> {
  // DMs: use in-memory store only (avoids pulling stale old messages from Slack)
  if (source === 'dm') {
    return _getHistory(convKey);
  }

  // Channel threads: read the canonical Slack thread — naturally bounded,
  // always accurate, and survives process restarts
  try {
    const result = await client.conversations.replies({
      channel,
      ts: threadTs,
      limit: CONV_MAX_TURNS + 4,
    });

    const raw = (result.messages ?? []) as Array<{
      ts?: string; text?: string; bot_id?: string; subtype?: string; user?: string;
    }>;

    const turns: ConversationTurn[] = [];
    for (const msg of raw) {
      if (msg.ts === currentMessageTs) continue; // skip current message
      if (msg.subtype) continue;                 // skip join/leave etc.
      const isBot = !!msg.bot_id;
      // Preserve foreign mentions (target users), strip only Tangent's own.
      const text = sanitizeSlackText(msg.text ?? '');
      if (!text) continue;
      if (isBot) {
        turns.push({ role: 'assistant', content: text });
      } else {
        // Inject identity prefix into historical human messages so Claude can
        // verify WHO said what throughout the entire thread, not just the
        // current message. Without this, Claude loses identity context for
        // every message except the most recent one.
        const prefix = msg.user ? `[Slack User: <@${msg.user}> | ID: ${msg.user}]\n` : '';
        turns.push({ role: 'user', content: prefix + text });
      }
    }

    // Claude requires the first message to be 'user'
    while (turns.length > 0 && turns[0].role === 'assistant') turns.shift();

    return turns.slice(-CONV_MAX_TURNS);
  } catch {
    return _getHistory(convKey); // fallback to in-memory on API failure
  }
}

// ─── Init ─────────────────────────────────────────────────────────────────────

export function initSlackBot(): void {
  const { slackToken, slackAppToken } = config();

  if (!slackToken || !slackAppToken) {
    logger.warn({ action: 'slack_bot:skip' }, 'SLACK_TOKEN or SLACK_APP_TOKEN not set — bot disabled');
    return;
  }

  _app = new App({
    token: slackToken,
    appToken: slackAppToken,
    socketMode: true,
    logger: {
      debug: (...args) => logger.debug({ src: 'bolt' }, args.join(' ')),
      info:  (...args) => logger.info({ src: 'bolt' }, args.join(' ')),
      warn:  (...args) => logger.warn({ src: 'bolt' }, args.join(' ')),
      error: (...args) => logger.error({ src: 'bolt' }, args.join(' ')),
      setLevel: () => {},
      getLevel: () => LogLevel.INFO,
      setName:  () => {},
    },
  });

  // Channel mentions: @Tangent <message>
  _app.event('app_mention', async ({ event, client }) => {
    const channel   = event.channel;
    const messageTs = event.ts;
    const threadTs  = ('thread_ts' in event && event.thread_ts) ? String(event.thread_ts) : messageTs;
    const rawText   = typeof event.text === 'string' ? event.text : '';

    // MCP bot-token messages carry [MCP-USER: USERID] so Tangent knows the real caller.
    // Extract it and use it as userId — this lets the normal identity/access system
    // work unchanged even when the message was posted by the bot on someone's behalf.
    const mcpMatch = rawText.match(/^\[MCP-USER:\s*([A-Z0-9]+)\]/);
    const userId = mcpMatch
      ? mcpMatch[1]
      : (typeof event.user === 'string' ? event.user : undefined);

    // Strip the MCP prefix and Tangent's own @mention, but preserve any
    // *other* user mentions in the body — they're targets Claude may need
    // (e.g. "add @Sam" must keep Sam's <@USERID> intact).
    const text = sanitizeSlackText(rawText.replace(/^\[MCP-USER:\s*[A-Z0-9]+\]\s*/, ''));
    if (!text) return;
    await route({ channel, threadTs, userId, client, text, source: 'mention', messageTs });
  });

  // Direct messages: talk to Tangent without @mention.
  // Also handles thread replies in channels where Tangent has already participated —
  // once Tangent is in a thread, users don't need to @mention it again.
  _app.event('message', async ({ event, client }) => {
    if ('subtype' in event && event.subtype) return;
    if ('bot_id' in event && event.bot_id) return;

    const channel   = 'channel' in event ? String(event.channel) : '';
    const messageTs = 'ts' in event ? String(event.ts) : '';
    const userId    = 'user' in event && typeof event.user === 'string' ? event.user : undefined;
    const rawMsgText = ('text' in event && typeof event.text === 'string') ? event.text : '';
    // Strip Tangent's own mention if present (thread replies may @mention it
    // again), preserve every other user mention as a potential target ID.
    const text = sanitizeSlackText(rawMsgText);
    const threadTs  = ('thread_ts' in event && event.thread_ts) ? String(event.thread_ts) : '';

    if (!text || !channel || !messageTs) return;

    const isDm = 'channel_type' in event && event.channel_type === 'im';

    if (isDm) {
      // DM — no thread concept; use messageTs as the threadTs key
      await route({ channel, threadTs: messageTs, userId, client, text, source: 'dm', messageTs });
      return;
    }

    // Channel thread reply (not top-level, not an @mention) — only handle if
    // Tangent has already posted in this thread. This avoids listening to every
    // channel message while still giving full thread context after first mention.
    if (threadTs && threadTs !== messageTs && _isActiveThread(channel, threadTs)) {
      await route({ channel, threadTs, userId, client, text, source: 'mention', messageTs });
    }
  });

  logger.info({ action: 'slack_bot:init' }, 'Slack bot initialized');
}

export async function startSlackBot(): Promise<void> {
  if (!_app) return;
  await _app.start();

  // Resolve Tangent's own Slack member ID so sanitizeSlackText() can strip
  // `<@BOT_ID>` self-mentions without touching other users' mentions. If this
  // fails, sanitizeSlackText() falls back to preserving all mentions — that's
  // safe (Claude will just see an extra "@Tangent" token) and far better
  // than the old behaviour of stripping every mention including targets.
  try {
    const auth = await _app.client.auth.test();
    if (typeof auth.user_id === 'string' && auth.user_id) {
      _botUserId = auth.user_id;
      logger.info({ action: 'slack_bot:bot_id', botUserId: _botUserId }, 'Resolved Tangent bot user ID');
    } else {
      logger.warn({ action: 'slack_bot:bot_id_missing' }, 'auth.test() returned no user_id — foreign mention preservation still works, self-mention strip disabled');
    }
  } catch (err) {
    logger.warn({ action: 'slack_bot:bot_id_failed', err }, 'Failed to resolve bot user ID');
  }

  logger.info({ action: 'slack_bot:started' }, 'Slack bot connected via Socket Mode');
}

// ─── Context type ─────────────────────────────────────────────────────────────

interface Ctx {
  channel: string;
  threadTs: string;
  userId: string | undefined;
  client: WebClient;
}

// ─── Shared router ────────────────────────────────────────────────────────────

async function route(opts: Ctx & { text: string; source: 'mention' | 'dm'; messageTs: string }): Promise<void> {
  const { text, source, messageTs, ...ctx } = opts;

  logger.info({ action: 'slack_bot:message', source, preview: text.slice(0, 80) }, 'Message received');

  // Mark this thread as active so future non-@mention replies are routed here too
  if (source === 'mention') {
    _markActiveThread(ctx.channel, ctx.threadTs);
  }

  // ── Resolve userId early — used for access control, identity prefix, and all tool gates ──
  // Mutate ctx.userId so every downstream function (handleDeploy, executeToolCall, etc.)
  // automatically gets the resolved identity without needing to pass it separately.
  let resolvedUserId = ctx.userId;
  if (!resolvedUserId) {
    try {
      const info = await ctx.client.conversations.info({ channel: ctx.channel });
      const channelUser = (info.channel as Record<string, unknown>)?.['user'];
      if (typeof channelUser === 'string') resolvedUserId = channelUser;
    } catch { /* best-effort */ }
    if (resolvedUserId) {
      logger.info({ action: 'slack_bot:resolved_user', userId: resolvedUserId }, 'Resolved missing userId via conversations.info');
    } else {
      logger.warn({ action: 'slack_bot:unknown_user', channel: ctx.channel }, 'Could not resolve userId');
    }
  }
  // Propagate to ctx so all downstream functions use the resolved identity
  ctx.userId = resolvedUserId;

  // Access control
  const { allowedSlackUserIds } = config();
  if (allowedSlackUserIds.size > 0 && (!resolvedUserId || !allowedSlackUserIds.has(resolvedUserId))) {
    logger.warn({ action: 'slack_bot:unauthorized', userId: resolvedUserId }, 'Unauthorized user');
    await post(ctx.client, ctx.channel, ctx.threadTs, "Sorry, you're not authorized to use Tangent.");
    return;
  }

  // ── Daanish-only: dynamically add a user to the allowed list ──────────────
  // Usage (DM or mention): "add @username" / "allow @username".
  // This is a fast path that bypasses Claude routing entirely — valuable
  // because it cannot pick the wrong ID. It now works again post-sanitize
  // since foreign `<@USERID>` mentions are preserved in the text.
  const addUserMatch = /^(?:add|allow)\s+<@([A-Z0-9]+)>/i.exec(text.trim());
  if (addUserMatch) {
    if (resolvedUserId !== 'U07EU7KSG3U') {
      await post(ctx.client, ctx.channel, ctx.threadTs, '🔒 Only Daanish can add users to the allowed list.');
      return;
    }
    const newUserId = addUserMatch[1]!;
    const result = allowUser(newUserId);
    let msg: string;
    if (result.alreadyAllowed && !result.persisted && !result.error) {
      msg = `ℹ️ <@${newUserId}> is already on the allowed list.`;
    } else if (result.persisted) {
      const shaNote = result.commitSha ? ` (commit \`${result.commitSha}\`)` : '';
      msg = `✅ <@${newUserId}> has been added — pushed to \`main\`${shaNote}.`;
    } else if (result.error) {
      msg = `⚠️ <@${newUserId}> granted in memory, but GitHub push failed: _${result.error}_`;
    } else {
      msg = `✅ <@${newUserId}> has been added to the allowed list.`;
    }
    await post(ctx.client, ctx.channel, ctx.threadTs, msg);
    return;
  }

  const convKey = _convKey(ctx.channel, ctx.threadTs, source);

  // ── Concurrency guard ─────────────────────────────────────────────────────
  // If we're already processing a message for this conversation (e.g. chaining
  // tool calls), don't start another pass — the follow-up will just duplicate
  // work.  Post a brief "still working" note so the user knows we heard them.
  if (_processingLock.has(convKey)) {
    logger.info({ action: 'route:busy', convKey }, 'Skipping — already processing');
    await post(ctx.client, ctx.channel, ctx.threadTs, '_Still working on the last request — hang tight._');
    return;
  }

  _processingLock.add(convKey);
  try {
    await _routeInner(ctx, text, source, messageTs, resolvedUserId, convKey);
  } finally {
    _processingLock.delete(convKey);
  }
}

// The actual routing logic, extracted so route() can wrap it in a processing lock.
async function _routeInner(
  ctx: Ctx,
  text: string,
  source: 'mention' | 'dm',
  messageTs: string,
  resolvedUserId: string | undefined,
  convKey: string,
): Promise<void> {
  // ── Check for pending confirmation first ───────────────────────────────────
  // If a deploy/teardown is waiting for approval, handle yes/no before
  // doing anything else.
  const pending = _getPending(convKey);
  if (pending) {
    const intent = await classifyConsent(text);
    if (intent === 'confirm') {
      // Check if this action requires a specific approver
      if (pending.requiredApproverId && ctx.userId !== pending.requiredApproverId) {
        const msg = `🔒 Only <@${pending.requiredApproverId}> can approve this. I appreciate the enthusiasm though! 📐`;
        await post(ctx.client, ctx.channel, ctx.threadTs, msg);
        return;
      }
      _clearPending(convKey);
      _appendTurn(convKey, { role: 'user', content: text });
      const ack = `👍 *Confirmed by <@${ctx.userId ?? 'you'}>* — on it.`;
      await post(ctx.client, ctx.channel, ctx.threadTs, ack);
      _appendTurn(convKey, { role: 'assistant', content: ack });
      await executeToolCall(pending.call, ctx, convKey, text, []);
      return;
    }
    if (intent === 'cancel') {
      _clearPending(convKey);
      _appendTurn(convKey, { role: 'user', content: text });
      const ack = '❌ Cancelled — nothing was changed.';
      await post(ctx.client, ctx.channel, ctx.threadTs, ack);
      _appendTurn(convKey, { role: 'assistant', content: ack });
      return;
    }
    // 'other' — not a response to the pending action, treat as a new message
    _clearPending(convKey);
  }

  // ── Normal message flow ────────────────────────────────────────────────────
  const history = await buildHistory(ctx.client, convKey, ctx.channel, ctx.threadTs, messageTs, source);

  // Prefix message with real Slack identity so Claude can never be fooled by verbal claims
  const identityPrefix = resolvedUserId
    ? `[Slack User: <@${resolvedUserId}> | ID: ${resolvedUserId}]\n`
    : '[Slack User: UNKNOWN — identity could not be resolved]\n';
  const textWithIdentity = identityPrefix + text;

  // Store the identity-prefixed version so DM history carries the same
  // verified identity context as channel thread history.
  _appendTurn(convKey, { role: 'user', content: textWithIdentity });

  // Single Claude call — it either calls a tool or replies conversationally
  const response = await processMessage(textWithIdentity, history);

  if (response.type === 'text') {
    await post(ctx.client, ctx.channel, ctx.threadTs, response.text);
    _appendTurn(convKey, { role: 'assistant', content: response.text });
    return;
  }

  // Claude called a tool
  const { call } = response;

  // Deploy and teardown require explicit confirmation before executing
  if (call.name === 'deploy') {
    let { repo, branch, port, freshUrl } = call.input as { repo: string; branch: string; port: number; freshUrl?: boolean };

    // ── Validate repo exists in GitHub before showing confirmation ─────────
    let allRepos: { name: string }[];
    try {
      allRepos = await listAllRepos();
    } catch {
      allRepos = [];
    }
    const repoExists = allRepos.some((r) => r.name.toLowerCase() === repo.toLowerCase());

    if (!repoExists) {
      const available = allRepos.length > 0
        ? `Available repos: ${allRepos.map((r) => `\`${r.name}\``).join(', ')}`
        : 'Could not fetch repo list — check GitHub token.';
      const errMsg = `❌ Repo \`${repo}\` not found in the Impiricus-AI org.\n${available}`;
      await post(ctx.client, ctx.channel, ctx.threadTs, errMsg);
      _appendTurn(convKey, { role: 'assistant', content: errMsg });
      return;
    }

    // ── Auto-detect port from Dockerfile EXPOSE if Claude defaulted to 8080 ─
    // The LLM frequently forgets to pass the right port even when inspect_repo
    // showed it. This catches the mismatch before it causes a broken deploy.
    if (port === 8080) {
      try {
        const info = await inspectRepo(repo);
        if (info.exposedPort && info.exposedPort !== 8080) {
          logger.info(
            { action: 'deploy:port_override', repo, requested: port, dockerfile: info.exposedPort },
            `Overriding default port 8080 → ${info.exposedPort} (from Dockerfile EXPOSE)`,
          );
          port = info.exposedPort;
          // Update the call input so the downstream deploy skill uses the right port
          (call.input as Record<string, unknown>)['port'] = port;
        }
      } catch {
        // If inspect fails, proceed with the requested port — it'll fail at deploy anyway
      }
    }

    // Show the URL that will be used — reused or fresh — so user knows upfront
    const { getStoredNgrokUrl } = await import('../skills/deploy.js');
    const existingUrl = getStoredNgrokUrl(repo);
    const urlNote = freshUrl
      ? `• URL: _new URL will be generated_`
      : existingUrl
        ? `• URL: ${existingUrl} _(same as last deploy)_`
        : `• URL: _new URL will be generated_`;

    const requester = ctx.userId ? `<@${ctx.userId}>` : 'Someone';
    const prompt = [
      `🚀 *Deploy requested for \`${repo}\`*`,
      `• Requested by: ${requester}`,
      `• Branch: \`${branch}\``,
      `• Port: ${port}`,
      urlNote,
      `• Cluster: \`tangent\` (us-east-1)`,
      '',
      `${requester} — reply *yes* to approve or *no* to cancel.`,
    ].join('\n');

    // Post confirmation in the current thread.
    // No requiredApproverId — any authorised user (including the requester)
    // can approve a deploy. Teardowns remain Daanish-only.
    _setPending(convKey, call, prompt, undefined, ctx.userId);
    await post(ctx.client, ctx.channel, ctx.threadTs, prompt);
    _appendTurn(convKey, { role: 'assistant', content: prompt });

    // Also notify #tangent-deployments if the request didn't come from there
    if (ctx.channel !== DEPLOY_CHANNEL) {
      const notif = `📣 Deploy request for \`${repo}\` (from ${requester}) — awaiting approval.`;
      await post(ctx.client, DEPLOY_CHANNEL, DEPLOY_CHANNEL, notif);
    }
    return;
  }

  if (call.name === 'push_file') {
    const result = await gatePushFile(call, ctx, convKey);
    if (result !== 'pass') return;
  }

  if (call.name === 'teardown') {
    const { repo } = call.input as { repo: string };

    // Only Daanish can initiate a teardown
    if (ctx.userId !== APPROVER_ID) {
      const msg = `🔒 Only <@${APPROVER_ID}> can stop services. Nice try though — even the real Chris needed Daanish's sign-off. 📐`;
      await post(ctx.client, ctx.channel, ctx.threadTs, msg);
      _appendTurn(convKey, { role: 'assistant', content: msg });
      return;
    }

    const prompt = [
      `🛑 *Ready to stop \`${repo}\`*`,
      '',
      'This will scale the service to 0 running tasks.',
      '_Nothing will be deleted — the service definition is preserved._',
      '',
      'Reply *yes* to confirm or *no* to cancel.',
    ].join('\n');
    _setPending(convKey, call, prompt, APPROVER_ID, ctx.userId);
    await post(ctx.client, ctx.channel, ctx.threadTs, prompt);
    _appendTurn(convKey, { role: 'assistant', content: prompt });
    return;
  }

  // Await tool execution so the per-conversation processing lock (held by
  // route()) stays active until the full tool chain completes.  Without this,
  // impatient follow-up messages spawn concurrent processMessage calls that
  // re-trigger the same tool (e.g. saving the same secret 3×).
  // Other conversations are NOT blocked — the lock is per-convKey.
  try {
    await executeToolCall(call, ctx, convKey, text, history);
  } catch (err) {
    logger.error({ action: 'slack_bot:tool_error', err }, 'Tool call failed');
  }
}

// ─── Tool executor ────────────────────────────────────────────────────────────
//
// For action tools (deploy, teardown): keep rich progress blocks — they have
// async status updates and the UX is already good.
//
// For all informational tools: fetch raw data → feed to Claude → Claude gives
// a natural conversational answer. This means "what is the ngrok link?" gets
// a real answer, not just a status dump.

async function executeToolCall(
  call: AgentToolCall,
  ctx: Ctx,
  convKey: string,
  userMessage: string,
  history: ConversationTurn[],
): Promise<void> {
  switch (call.name) {
    case 'deploy':
      _appendTurn(convKey, { role: 'assistant', content: `Deploying \`${(call.input as { repo: string }).repo}\`` });
      await handleDeploy(ctx, call.input as { repo: string; branch: string; port: number; freshUrl?: boolean }, convKey);
      break;
    case 'teardown':
      _appendTurn(convKey, { role: 'assistant', content: `Stopping \`${(call.input as { repo: string }).repo}\`` });
      await handleTeardown(ctx, call.input as { repo: string }, convKey);
      break;
    case 'push_file':
      await handlePushFile(ctx, call.input as { repo: string; path: string; content: string; message?: string; branch?: string }, convKey);
      break;
    case 'edit_file':
      await handleEditFile(ctx, call.input as { repo: string; path: string; find: string; replace: string; replace_all?: boolean; message?: string; branch?: string }, convKey);
      break;
    case 'restore_file':
      await handleRestoreFile(ctx, call.input as { repo: string; path: string; ref: string; message?: string }, convKey);
      break;
    case 'allow_user': {
      const { user_id, display_name } = call.input as { user_id: string; display_name: string };
      if (ctx.userId !== 'U07EU7KSG3U') {
        const msg = '🔒 Only Daanish can grant access to Tangent.';
        await post(ctx.client, ctx.channel, ctx.threadTs, msg);
        _appendTurn(convKey, { role: 'assistant', content: msg });
        break;
      }
      const result = allowUser(user_id);
      let msg: string;
      if (result.alreadyAllowed && !result.persisted && !result.error) {
        msg = `ℹ️ <@${user_id}> (${display_name}) is already on the allowed list — no change needed.`;
      } else if (result.persisted) {
        const shaNote = result.commitSha ? ` (commit \`${result.commitSha}\`)` : '';
        msg = `✅ Done — <@${user_id}> (${display_name}) now has access to Tangent. Persisted to \`config/allowed_users.json\` and pushed to \`main\`${shaNote}.`;
      } else if (result.error) {
        msg = `⚠️ <@${user_id}> (${display_name}) granted access in memory, but I could NOT push the change to GitHub: _${result.error}_\nIt will be lost on next restart unless the push is redone manually.`;
      } else {
        msg = `✅ Done — <@${user_id}> (${display_name}) now has access to Tangent (already on disk).`;
      }
      await post(ctx.client, ctx.channel, ctx.threadTs, msg);
      _appendTurn(convKey, { role: 'assistant', content: msg });
      break;
    }
    case 'put_secret': {
      const result = await handlePutSecret(ctx, call.input as { name: string; value: string; description?: string }, convKey);
      await _chainIfNeeded(call, result, ctx, convKey, userMessage, history);
      break;
    }
    case 'inject_secret': {
      const result = await handleInjectSecret(ctx, call.input as { repo: string; secret_name: string }, convKey);
      await _chainIfNeeded(call, result, ctx, convKey, userMessage, history);
      break;
    }
    case 'remember_person':
      await handleRememberPerson(ctx, call.input as { user_id: string; name: string; note: string }, convKey);
      break;
    case 'read_self':
    case 'list_self_commits':
      if (!ensureSelfEditAllowed(ctx, convKey)) break;
      await handleInfoTool(call, ctx, convKey, userMessage, history);
      break;
    case 'edit_self':
      if (!ensureSelfEditAllowed(ctx, convKey)) break;
      await handleSelfEdit(ctx, call.input as { path: string; find: string; replace: string; replace_all?: boolean; message?: string }, convKey);
      break;
    case 'push_self':
      if (!ensureSelfEditAllowed(ctx, convKey)) break;
      await handleSelfPush(ctx, call.input as { path: string; content: string; message?: string }, convKey);
      break;
    // ─── Postgres tools ────────────────────────────────────────────────
    case 'db_schema':
    case 'db_query':
    case 'db_list_users':
      // All read-only — handleInfoTool synthesises a conversational reply
      await handleInfoTool(call, ctx, convKey, userMessage, history);
      break;
    case 'db_create_user': {
      const result = await handleDbCreateUser(ctx, call.input as { username: string; create_database?: boolean }, convKey);
      await _chainIfNeeded(call, result, ctx, convKey, userMessage, history);
      break;
    }
    case 'db_drop_user': {
      const result = await handleDbDropUser(ctx, call.input as { username: string; drop_database?: boolean }, convKey);
      await _chainIfNeeded(call, result, ctx, convKey, userMessage, history);
      break;
    }
    default:
      // Informational tools: fetch data, synthesize a conversational response via Claude
      await handleInfoTool(call, ctx, convKey, userMessage, history);
      break;
  }
}

/**
 * After an action tool completes, check if Claude wants to chain to another
 * tool (e.g. inject 3 secrets in sequence). If Claude responds with text,
 * post it as a conversational reply. If it calls another tool, execute it.
 *
 * This is the key fix for "Tangent only injects one secret when asked to
 * inject all" — without this, action tools were fire-and-forget with no
 * follow-up call to Claude.
 */
async function _chainIfNeeded(
  completedCall: AgentToolCall,
  toolResult: string,
  ctx: Ctx,
  convKey: string,
  userMessage: string,
  history: ConversationTurn[],
): Promise<void> {
  // Record what just happened so Claude has context for the next decision
  _appendTurn(convKey, { role: 'assistant', content: `${completedCall.name} result: ${toolResult}` });

  const updatedHistory: ConversationTurn[] = [
    ...history,
    { role: 'user', content: userMessage },
    { role: 'assistant', content: `${completedCall.name} result: ${toolResult}` },
  ];

  try {
    const next = await continueAfterTool(completedCall, toolResult, userMessage, updatedHistory);

    if (next.type === 'text') {
      // Claude is done — post the conversational wrap-up
      await post(ctx.client, ctx.channel, ctx.threadTs, next.text);
      _appendTurn(convKey, { role: 'assistant', content: next.text });
      return;
    }

    // Claude wants another tool — execute it (this recurses naturally for
    // chains like inject_secret × 3, because the next inject_secret will
    // also call _chainIfNeeded when it finishes)
    await executeToolCall(next.call, ctx, convKey, userMessage, updatedHistory);
  } catch {
    // If continueAfterTool fails, just post the raw result as a fallback
    await post(ctx.client, ctx.channel, ctx.threadTs, toolResult);
    _appendTurn(convKey, { role: 'assistant', content: toolResult });
  }
}

/**
 * For read-only / informational tools:
 * 1. Post a placeholder ("working on it...")
 * 2. Fetch the raw tool data
 * 3. Feed result back to Claude via continueAfterTool — Claude either:
 *    a) Responds conversationally (done), OR
 *    b) Calls another tool (e.g. inspect_repo → push_file chain)
 * 4. If Claude chains to another tool, execute it in the background with a loading animation
 */
async function handleInfoTool(
  call: AgentToolCall,
  ctx: Ctx,
  convKey: string,
  userMessage: string,
  history: ConversationTurn[],
): Promise<void> {
  const ts = await post(ctx.client, ctx.channel, ctx.threadTs, '_On it..._');

  let rawData: string;
  try {
    rawData = await fetchToolData(call);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await update(ctx.client, ctx.channel, ts, `❌ ${msg}`);
    _appendTurn(convKey, { role: 'assistant', content: `Error: ${msg}` });
    return;
  }

  // Ask Claude what to do next — it can respond with text OR call another tool
  const next = await continueAfterTool(call, rawData, userMessage, history);

  if (next.type === 'text') {
    // Claude is done — show the conversational reply
    await update(ctx.client, ctx.channel, ts, next.text);
    _appendTurn(convKey, { role: 'assistant', content: next.text });
    return;
  }

  // Claude wants to chain to another tool (e.g. push_file after inspect_repo)
  // Close the info placeholder and kick off the next action
  await update(ctx.client, ctx.channel, ts, `✓ ${call.name} done`);
  _appendTurn(convKey, { role: 'assistant', content: `Ran ${call.name}, continuing...` });

  // Run any sanity gates that route() would have run for the chained call.
  // Critical: without this, a chained read_file → push_file bypassed the
  // existing-file confirmation prompt and could land an empty file on main.
  if (next.call.name === 'push_file') {
    const gateResult = await gatePushFile(next.call, ctx, convKey);
    if (gateResult !== 'pass') return;
  }

  const updatedHistory: ConversationTurn[] = [
    ...history,
    { role: 'user',      content: userMessage },
    { role: 'assistant', content: `${call.name} result: ${rawData.slice(0, 1000)}` },
  ];

  // Fire the next tool — for push_file this runs in background with loading animation
  void executeToolCall(next.call, ctx, convKey, userMessage, updatedHistory);
}

/**
 * Sanity-check + (if needed) confirmation gate for push_file calls.
 *
 * Called by BOTH the route() entry path AND the chain path in handleInfoTool,
 * so a chained read_file → push_file is subject to the same guards as a
 * direct push_file. The bug that landed an empty main.py on
 * asana-hubspot-webhook escaped because the chain path used to call
 * executeToolCall directly, bypassing the inline gate that route() had.
 *
 * Returns:
 *   'pass'     — caller should proceed to executeToolCall(call)
 *   'gated'    — a confirmation prompt was posted; caller should bail
 *   'rejected' — content failed a hard sanity check; caller should bail
 */
async function gatePushFile(
  call: AgentToolCall & { name: 'push_file' },
  ctx: Ctx,
  convKey: string,
): Promise<'pass' | 'gated' | 'rejected'> {
  const { repo, path: filePath, content, branch = 'main', message } = call.input;

  // Hard sanity: refuse empty / whitespace-only / suspiciously tiny pushes.
  // 20 bytes is below any plausible real source file or Dockerfile and is
  // the size we'd see if generation truncated the content string.
  if (!content || content.trim().length === 0) {
    const msg = `🛑 Refusing to push an empty \`${filePath}\` to \`${repo}\`. If you really meant to truncate the file, say so explicitly. Otherwise use \`edit_file\` for targeted changes.`;
    await post(ctx.client, ctx.channel, ctx.threadTs, msg);
    _appendTurn(convKey, { role: 'assistant', content: msg });
    return 'rejected';
  }
  if (content.length < 20) {
    const msg = `🛑 Refusing to push \`${filePath}\` — only ${content.length} bytes, which looks truncated. Use \`edit_file\` for small changes, or re-issue the request if you really meant to write that.`;
    await post(ctx.client, ctx.channel, ctx.threadTs, msg);
    _appendTurn(convKey, { role: 'assistant', content: msg });
    return 'rejected';
  }

  // Check if the file already exists.
  const existingContent = await readRepoFile(repo, filePath, branch).catch(() => null);

  if (existingContent === null) {
    // New file — no confirmation needed, just push.
    return 'pass';
  }

  // Updating an existing file. If the new content is dramatically smaller than
  // the old content, refuse outright — that's the empty-main.py shape and is
  // almost never what was intended for an edit. The model should use edit_file.
  const SHRINK_FLOOR = 0.25;
  if (existingContent.length >= 200 && content.length < existingContent.length * SHRINK_FLOOR) {
    const msg = [
      `🛑 Refusing to overwrite \`${filePath}\` in \`${repo}\`.`,
      `• Existing file: ${existingContent.length} bytes`,
      `• New content: ${content.length} bytes (${Math.round((content.length / existingContent.length) * 100)}% of original)`,
      ``,
      `That's a major shrink — usually means the file got truncated mid-generation, not that you really meant to gut it. For a small change, use \`edit_file\` instead. If you genuinely want to rewrite this file from scratch, say so explicitly and I'll ask for confirmation.`,
    ].join('\n');
    await post(ctx.client, ctx.channel, ctx.threadTs, msg);
    _appendTurn(convKey, { role: 'assistant', content: msg });
    return 'rejected';
  }

  // Existing file, sane size — show a preview and require Daanish to confirm.
  const preview = content.length > 400 ? content.slice(0, 400) + '\n...(truncated)' : content;
  const commitMsg = message ?? `Update ${filePath} via Tangent`;
  const prompt = [
    `✏️ *Push to existing file \`${filePath}\` in \`${repo}\`*`,
    `• Branch: \`${branch}\``,
    `• Existing: ${existingContent.length} bytes → New: ${content.length} bytes`,
    `• Commit message: _${commitMsg}_`,
    '',
    '*New content preview:*',
    '```',
    preview,
    '```',
    '',
    `Reply *yes* to push or *no* to cancel.`,
  ].join('\n');
  _setPending(convKey, call, prompt, undefined, ctx.userId);
  await post(ctx.client, ctx.channel, ctx.threadTs, prompt);
  _appendTurn(convKey, { role: 'assistant', content: prompt });
  return 'gated';
}

async function handlePushFile(
  ctx: Ctx,
  input: { repo: string; path: string; content: string; message?: string; branch?: string },
  convKey: string,
): Promise<void> {
  const { repo, path: filePath, content, branch = 'main' } = input;
  const commitMessage = input.message ?? `Add ${filePath} via Tangent`;

  // Final defense-in-depth check: if for any reason an empty content slipped
  // through gatePushFile (e.g. a future caller forgets to gate), still refuse.
  if (!content || content.trim().length === 0) {
    const msg = `🛑 Refusing to push an empty \`${filePath}\` to \`${repo}\` (final guard).`;
    await post(ctx.client, ctx.channel, ctx.threadTs, msg);
    _appendTurn(convKey, { role: 'assistant', content: msg });
    return;
  }

  const ts = await post(ctx.client, ctx.channel, ctx.threadTs, `⏳ Pushing \`${filePath}\` to \`${repo}\`...`);
  const loadingInterval = setInterval(() => {
    update(ctx.client, ctx.channel, ts, `⏳ Pushing \`${filePath}\` to \`${repo}\`...`).catch(() => {});
  }, 5_000);

  try {
    const { sha, url } = await pushFile(repo, filePath, content, commitMessage, branch);
    clearInterval(loadingInterval);
    const short = sha.slice(0, 7);
    const msg = url
      ? `✅ Pushed \`${filePath}\` to \`${repo}\` (${branch}) — commit \`${short}\`\n${url}`
      : `✅ Pushed \`${filePath}\` to \`${repo}\` (${branch}) — commit \`${short}\``;
    await update(ctx.client, ctx.channel, ts, msg);
    _appendTurn(convKey, { role: 'assistant', content: msg });
  } catch (err) {
    clearInterval(loadingInterval);
    const msg = `❌ Failed to push \`${filePath}\`: ${err instanceof Error ? err.message : String(err)}`;
    await update(ctx.client, ctx.channel, ts, msg);
    _appendTurn(convKey, { role: 'assistant', content: msg });
  }
}

/**
 * Server-side find/replace edit. Content never round-trips through the LLM
 * context window — we read the file via Octokit, run the substitution locally,
 * and push the result back. This is the safe path for any small edit and
 * should be preferred over read_file + push_file.
 */
async function handleEditFile(
  ctx: Ctx,
  input: { repo: string; path: string; find: string; replace: string; replace_all?: boolean; message?: string; branch?: string },
  convKey: string,
): Promise<void> {
  const { repo, path: filePath, find, replace, replace_all, message, branch = 'main' } = input;

  const ts = await post(ctx.client, ctx.channel, ctx.threadTs, `⏳ Editing \`${filePath}\` in \`${repo}\`...`);

  try {
    const { sha, url, matches, oldSize, newSize } = await editFile(repo, filePath, find, replace, {
      replaceAll: replace_all === true,
      commitMessage: message,
      branch,
    });
    const short = sha.slice(0, 7);
    const matchesNote = matches > 1 ? ` (${matches} matches replaced)` : '';
    const sizeNote = ` ${oldSize}B → ${newSize}B`;
    const msg = url
      ? `✅ Edited \`${filePath}\` in \`${repo}\` (${branch}) — commit \`${short}\`${matchesNote}${sizeNote}\n${url}`
      : `✅ Edited \`${filePath}\` in \`${repo}\` (${branch}) — commit \`${short}\`${matchesNote}${sizeNote}`;
    await update(ctx.client, ctx.channel, ts, msg);
    _appendTurn(convKey, { role: 'assistant', content: msg });
  } catch (err) {
    const msg = `❌ Edit failed: ${err instanceof Error ? err.message : String(err)}`;
    await update(ctx.client, ctx.channel, ts, msg);
    _appendTurn(convKey, { role: 'assistant', content: msg });
  }
}

/**
 * Restore a file to a previous commit's contents — server-side, no LLM round-trip.
 * Content is read from GitHub at the given ref and pushed directly back to HEAD.
 */
async function handleRestoreFile(
  ctx: Ctx,
  input: { repo: string; path: string; ref: string; message?: string },
  convKey: string,
): Promise<void> {
  const { repo, path: filePath, ref, message } = input;
  const commitMessage = message ?? `restore: ${filePath} from ${ref.slice(0, 7)}`;

  const ts = await post(ctx.client, ctx.channel, ctx.threadTs, `⏳ Restoring \`${filePath}\` in \`${repo}\` from commit \`${ref.slice(0, 7)}\`...`);

  try {
    // Read content at the historical commit server-side
    const content = await readRepoFile(repo, filePath, ref);
    if (content === null) {
      const msg = `❌ Could not find \`${filePath}\` at commit \`${ref.slice(0, 7)}\` in \`${repo}\`.`;
      await update(ctx.client, ctx.channel, ts, msg);
      _appendTurn(convKey, { role: 'assistant', content: msg });
      return;
    }

    // Push it directly — no LLM involved, content is intact
    const { sha, url } = await pushFile(repo, filePath, content, commitMessage);
    const short = sha.slice(0, 7);
    const msg = url
      ? `✅ Restored \`${filePath}\` in \`${repo}\` from \`${ref.slice(0, 7)}\` → commit \`${short}\`\n${url}`
      : `✅ Restored \`${filePath}\` in \`${repo}\` from \`${ref.slice(0, 7)}\` → commit \`${short}\``;
    await update(ctx.client, ctx.channel, ts, msg);
    _appendTurn(convKey, { role: 'assistant', content: msg });
  } catch (err) {
    const msg = `❌ Restore failed: ${err instanceof Error ? err.message : String(err)}`;
    await update(ctx.client, ctx.channel, ts, msg);
    _appendTurn(convKey, { role: 'assistant', content: msg });
  }
}

/**
 * Gate for the self-edit tools (read_self / list_self_commits / edit_self / push_self).
 *
 * Two hard requirements:
 *   1. Caller must be Daanish (APPROVER_ID). Nobody else can touch Tangent's source.
 *   2. The conversation must be a DM with Tangent. Slack DM channel IDs start
 *      with 'D' — channels are 'C', group DMs are 'G'. Restricting to DMs keeps
 *      self-edits private and prevents anyone in a shared channel from watching
 *      (or replying to a confirmation prompt for) a Tangent source-code change.
 *
 * Posts the refusal reason + records it in convKey history, so Claude sees
 * the rejection on follow-up turns instead of silently re-trying.
 * Returns true iff the caller passed both checks.
 */
function ensureSelfEditAllowed(ctx: Ctx, convKey: string): boolean {
  if (ctx.userId !== APPROVER_ID) {
    const msg = '🔒 Only Daanish can edit my source code. This is a hard gate.';
    void post(ctx.client, ctx.channel, ctx.threadTs, msg);
    _appendTurn(convKey, { role: 'assistant', content: msg });
    return false;
  }
  if (!ctx.channel.startsWith('D')) {
    const msg = '🔒 Self-edits only work in DMs with me — not in shared channels. DM me directly and we can do it there.';
    void post(ctx.client, ctx.channel, ctx.threadTs, msg);
    _appendTurn(convKey, { role: 'assistant', content: msg });
    return false;
  }
  return true;
}

async function handleSelfEdit(
  ctx: Ctx,
  input: { path: string; find: string; replace: string; replace_all?: boolean; message?: string },
  convKey: string,
): Promise<void> {
  const { path: filePath, find, replace, replace_all, message } = input;
  const { selfOwner, selfRepo } = config();

  const ts = await post(ctx.client, ctx.channel, ctx.threadTs, `⏳ Editing my own \`${filePath}\`...`);

  try {
    const { sha, url, matches, oldSize, newSize } = await editFile(selfRepo, filePath, find, replace, {
      replaceAll: replace_all === true,
      commitMessage: message ?? `self-edit: ${filePath}`,
      owner: selfOwner,
    });
    const short = sha.slice(0, 7);
    const matchesNote = matches > 1 ? ` (${matches} matches replaced)` : '';
    const sizeNote = ` ${oldSize}B → ${newSize}B`;
    const msg = [
      url
        ? `✅ Edited my own \`${filePath}\` — commit \`${short}\`${matchesNote}${sizeNote}\n${url}`
        : `✅ Edited my own \`${filePath}\` — commit \`${short}\`${matchesNote}${sizeNote}`,
      '',
      `_Reminder: the change is on \`main\` but this running process is still on the old code. Pull + rebuild + \`pm2 restart tangent\` on EC2 to pick it up._`,
    ].join('\n');
    await update(ctx.client, ctx.channel, ts, msg);
    _appendTurn(convKey, { role: 'assistant', content: msg });
  } catch (err) {
    const msg = `❌ Self-edit failed: ${err instanceof Error ? err.message : String(err)}`;
    await update(ctx.client, ctx.channel, ts, msg);
    _appendTurn(convKey, { role: 'assistant', content: msg });
  }
}

async function handleSelfPush(
  ctx: Ctx,
  input: { path: string; content: string; message?: string },
  convKey: string,
): Promise<void> {
  const { path: filePath, content } = input;
  const { selfOwner, selfRepo } = config();

  // Defense-in-depth: the ai.ts buildToolCall already rejects empty content,
  // but duplicate the check here so the guarantee holds even if a future
  // caller forgets to route through buildToolCall.
  if (!content || content.trim().length === 0) {
    const msg = `🛑 Refusing to push an empty \`${filePath}\` to Tangent source.`;
    await post(ctx.client, ctx.channel, ctx.threadTs, msg);
    _appendTurn(convKey, { role: 'assistant', content: msg });
    return;
  }

  // Check if the file already exists in Tangent source — if so, this should
  // have been an edit_self, not a push_self. Refuse and tell Daanish.
  const existing = await readRepoFile(selfRepo, filePath, 'main', selfOwner).catch(() => null);
  if (existing !== null) {
    const msg = `🛑 \`${filePath}\` already exists in my source. Use \`edit_self\` for edits — rewriting a whole file risks truncation.`;
    await post(ctx.client, ctx.channel, ctx.threadTs, msg);
    _appendTurn(convKey, { role: 'assistant', content: msg });
    return;
  }

  const commitMessage = input.message ?? `self-add: ${filePath}`;
  const ts = await post(ctx.client, ctx.channel, ctx.threadTs, `⏳ Adding \`${filePath}\` to my source...`);

  try {
    const { sha, url } = await pushFile(selfRepo, filePath, content, commitMessage, 'main', selfOwner);
    const short = sha.slice(0, 7);
    const msg = [
      url
        ? `✅ Added \`${filePath}\` to my source — commit \`${short}\`\n${url}`
        : `✅ Added \`${filePath}\` to my source — commit \`${short}\``,
      '',
      `_Reminder: pull + rebuild + \`pm2 restart tangent\` on EC2 to pick this up._`,
    ].join('\n');
    await update(ctx.client, ctx.channel, ts, msg);
    _appendTurn(convKey, { role: 'assistant', content: msg });
  } catch (err) {
    const msg = `❌ Self-push failed: ${err instanceof Error ? err.message : String(err)}`;
    await update(ctx.client, ctx.channel, ts, msg);
    _appendTurn(convKey, { role: 'assistant', content: msg });
  }
}

/**
 * Pure data-fetching — returns a raw string result for Claude to interpret.
 * No Slack posting here; that's the synthesizer's job.
 */
async function fetchToolData(call: AgentToolCall): Promise<string> {
  switch (call.name) {
    case 'status':
      return fetchStatus((call.input as { repo: string }).repo);
    case 'list_services':
      return fetchListServices();
    case 'list_repos':
      return fetchListRepos();
    case 'inspect_repo':
      return fetchInspectRepo((call.input as { repo: string }).repo);
    case 'read_file': {
      const { repo, path, ref } = call.input as { repo: string; path: string; ref?: string };
      const content = await readRepoFile(repo, path, ref);
      if (content === null) return `File not found: ${path} in ${repo}${ref ? ` at ref ${ref}` : ''}`;
      const refNote = ref ? ` (at commit ${ref.slice(0, 7)})` : '';
      return `File: ${path}${refNote}\n\`\`\`\n${content}\n\`\`\``;
    }
    case 'list_commits': {
      const { repo, path, limit } = call.input as { repo: string; path?: string; limit?: number };
      const commits = await listCommits(repo, path, limit ?? 20);
      if (commits.length === 0) return `No commits found for ${repo}${path ? ` (${path})` : ''}`;
      const lines = commits.map((c) => `\`${c.shortSha}\` ${c.date.slice(0, 10)} *${c.author}*: ${c.message}`);
      const header = path ? `Commits touching \`${path}\` in \`${repo}\`:` : `Recent commits in \`${repo}\`:`;
      return `${header}\n${lines.join('\n')}`;
    }
    case 'cve_scan':
      return fetchScan();
    case 'discover_config':
      return fetchDiscover();
    case 'logs':
      return fetchLogs((call.input as { repo: string; container?: string }).repo, (call.input as { repo: string; container?: string }).container ?? 'ngrok');
    case 'clear_logs':
      return fetchClearLogs((call.input as { repo: string; container?: string }).repo, (call.input as { repo: string; container?: string }).container ?? 'ngrok');
    case 'list_secrets':
      return fetchListSecrets();
    case 'read_self': {
      const { path, ref } = call.input as { path: string; ref?: string };
      const { selfOwner, selfRepo } = config();
      const content = await readRepoFile(selfRepo, path, ref, selfOwner);
      if (content === null) return `File not found in Tangent source: ${path}${ref ? ` at ref ${ref}` : ''}`;
      const refNote = ref ? ` (at commit ${ref.slice(0, 7)})` : '';
      return `Tangent source — ${path}${refNote}\n\`\`\`\n${content}\n\`\`\``;
    }
    case 'list_self_commits': {
      const { path, limit } = call.input as { path?: string; limit?: number };
      const { selfOwner, selfRepo } = config();
      const commits = await listCommits(selfRepo, path, limit ?? 20, selfOwner);
      if (commits.length === 0) return `No commits found in Tangent source${path ? ` for ${path}` : ''}`;
      const lines = commits.map((c) => `\`${c.shortSha}\` ${c.date.slice(0, 10)} *${c.author}*: ${c.message}`);
      const header = path ? `Tangent commits touching \`${path}\`:` : `Recent Tangent commits:`;
      return `${header}\n${lines.join('\n')}`;
    }
    case 'db_schema':
      return fetchDbSchema();
    case 'db_query':
      return fetchDbQuery((call.input as { sql: string }).sql);
    case 'db_list_users':
      return fetchDbListUsers();
    default:
      return `Unknown tool: ${call.name}`;
  }
}

// ─── Slack helpers ────────────────────────────────────────────────────────────

async function post(
  client: WebClient,
  channel: string,
  threadTs: string,
  text: string,
  blocks?: KnownBlock[],
): Promise<string> {
  const result = await client.chat.postMessage({ channel, thread_ts: threadTs, text, blocks });
  return result.ts as string;
}

async function update(
  client: WebClient,
  channel: string,
  ts: string,
  text: string,
  blocks?: KnownBlock[],
): Promise<void> {
  await client.chat.update({ channel, ts, text, blocks });
}

// ─── One-shot post-deploy health check ───────────────────────────────────────
//
// Called once per deploy, ~15 seconds after the tunnel URL is confirmed live.
// Checks if the ECS service still has running tasks. If it crashed (0 tasks),
// automatically fetches app + ngrok logs, calls Claude to diagnose the root
// cause, and posts the finding directly in the deploy thread.
//
// This catches the most common class of silent failures: apps that start,
// briefly appear live (tunnel is up), then crash on first request or startup
// error — without anyone having to ask "why is it broken?"

async function quickHealthCheck(
  client: WebClient,
  channel: string,
  threadTs: string,
  convKey: string,
  repo: string,
  ngrokUrl: string,
): Promise<void> {
  // Give the app 15 seconds after tunnel detection to either stay up or crash.
  // Startup crashes (missing env var, bad route, port mismatch) typically
  // surface within the first few seconds — 15s is enough to catch them.
  await new Promise((resolve) => setTimeout(resolve, 15_000));

  logger.info({ action: 'health_check:start', repo }, 'Running post-deploy health check');

  // Check if the service still has running tasks
  let running: number;
  try {
    const { SERVICE_PREFIX } = await import('../utils/constants.js');
    const { DescribeServicesCommand } = await import('@aws-sdk/client-ecs');
    const { ecsClient } = await import('./aws.js');
    const serviceName = `${SERVICE_PREFIX}${repo}`;
    const result = await ecsClient().send(
      new DescribeServicesCommand({ cluster: config().ecsClusterName, services: [serviceName] }),
    );
    running = result.services?.[0]?.runningCount ?? 1;
  } catch {
    // ECS API blip — skip silently, don't false-alarm
    logger.warn({ action: 'health_check:api_error', repo }, 'ECS check failed, skipping health check');
    return;
  }

  if (running > 0) {
    logger.info({ action: 'health_check:healthy', repo }, 'Post-deploy check passed — service is running');
    return;
  }

  // ── Service crashed ────────────────────────────────────────────────────────
  logger.info({ action: 'health_check:crashed', repo }, 'Service has 0 running tasks — fetching logs for diagnosis');

  let appLogs = '';
  let ngrokLogs = '';
  try { appLogs   = await fetchLogs(repo, 'app');   } catch { appLogs   = '(app logs unavailable)'; }
  try { ngrokLogs = await fetchLogs(repo, 'ngrok'); } catch { ngrokLogs = '(ngrok logs unavailable)'; }

  const diagnosis = await diagnoseServiceFailure(repo, appLogs, ngrokLogs, ngrokUrl);

  // ── Attempt auto-fix ───────────────────────────────────────────────────────
  // Try to identify the broken file, read it from GitHub, generate a minimal
  // fix, and push it back. Only fires when Claude is confident in a single-
  // file change — infra/env/multi-file fixes are skipped.
  let autoFixed = false;
  let fixedFile = '';
  let fixDescription = '';

  try {
    const repoInfo = await inspectRepo(repo);
    const fileToFix = await identifyFileToFix(repo, diagnosis, repoInfo.files);

    if (fileToFix) {
      logger.info({ action: 'health_check:fix_candidate', repo, fileToFix }, 'Attempting auto-fix');
      const fileContent = await readRepoFile(repo, fileToFix);

      if (fileContent) {
        const fix = await generateCodeFix(repo, fileToFix, fileContent, diagnosis);

        if (fix) {
          await pushFile(
            repo,
            fileToFix,
            fix.newContent,
            `fix: ${fix.description} [auto-fix by Tangent]`,
          );
          autoFixed = true;
          fixedFile = fileToFix;
          fixDescription = fix.description;
          logger.info({ action: 'health_check:auto_fixed', repo, fileToFix }, 'Auto-fix pushed to GitHub');
        }
      }
    }
  } catch (err) {
    // Auto-fix is best-effort — never let it suppress the diagnosis
    logger.warn({ action: 'health_check:auto_fix_error', err }, 'Auto-fix attempt failed');
  }

  // ── Post result ────────────────────────────────────────────────────────────
  const msg = autoFixed
    ? [
        `⚠️ *<@${APPROVER_ID}> — \`${repo}\` crashed ~15 seconds after deploy*`,
        '',
        '*Root cause:*',
        diagnosis,
        '',
        `*Auto-fix applied ✅* — updated \`${fixedFile}\`: ${fixDescription}`,
        `_Fix is already pushed to GitHub. Reply *redeploy ${repo}* to apply it._`,
      ].join('\n')
    : [
        `⚠️ *<@${APPROVER_ID}> — \`${repo}\` crashed ~15 seconds after deploy* (0 tasks running)`,
        '',
        '*Auto-diagnosis:*',
        diagnosis,
        '',
        `_I fetched the logs automatically. Reply to dig deeper or fix and redeploy._`,
      ].join('\n');

  await post(client, channel, threadTs, msg);
  _appendTurn(convKey, { role: 'assistant', content: msg });

  if (channel !== DEPLOY_CHANNEL) {
    const notif = autoFixed
      ? `⚠️ *\`${repo}\` crashed post-deploy — auto-fix pushed.* <@${APPROVER_ID}> check the thread.`
      : `⚠️ *\`${repo}\` crashed post-deploy* — diagnosis in the original thread. <@${APPROVER_ID}>`;
    await post(client, DEPLOY_CHANNEL, DEPLOY_CHANNEL, notif);
  }

  logger.info({ action: 'health_check:alerted', repo, autoFixed }, 'Health check alert posted');
}

// ─── Deploy ───────────────────────────────────────────────────────────────────

async function handleDeploy(
  { channel, threadTs, userId, client }: Ctx,
  { repo, branch, port, freshUrl }: { repo: string; branch: string; port: number; freshUrl?: boolean },
  convKey: string,
): Promise<void> {
  const actor = userId ? `<@${userId}>` : 'someone';

  const ts = await post(client, channel, threadTs,
    `🔨 Building \`${repo}\` from \`${branch}\`...`,
    statusBlocks({ repo, branch, port, actor, stage: 'building' }),
  );

  // ── Build ──────────────────────────────────────────────────────────────────
  let imageUri: string;
  let sha: string;
  try {
    ({ imageUri, sha } = await buildSkill({ repo, branch }));
  } catch (err) {
    let msg: string;
    if (err instanceof DockerfileNotFoundError) msg = err.message;
    else if (err instanceof DockerBuildError)   msg = `${err.summary}\n\`\`\`${err.raw.slice(0, 600)}\`\`\``;
    else                                        msg = err instanceof Error ? err.message : String(err);
    await update(client, channel, ts, `❌ Build failed for \`${repo}\``, errorBlocks('❌ Build failed', repo, msg));
    _appendTurn(convKey, { role: 'assistant', content: `❌ Build failed for \`${repo}\`: ${msg}` });
    return;
  }

  await update(client, channel, ts,
    `🚀 Build done. Deploying to ECS...`,
    statusBlocks({ repo, branch, port, actor, stage: 'deploying', sha }),
  );

  // ── Deploy ─────────────────────────────────────────────────────────────────
  let deployedAt: number;
  let ngrokUrl: string;
  try {
    ({ deployedAt, ngrokUrl } = await deploySkill({ repo, imageUri, port, freshUrl }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await update(client, channel, ts, `❌ ECS deploy failed`, errorBlocks('❌ ECS deploy failed', repo, msg));
    _appendTurn(convKey, { role: 'assistant', content: `❌ ECS deploy failed for \`${repo}\`: ${msg}` });
    return;
  }

  await update(client, channel, ts,
    `⏳ ECS service updated. Waiting for ngrok tunnel...`,
    statusBlocks({ repo, branch, port, actor, stage: 'tunneling', sha }),
  );

  // ── Tunnel ─────────────────────────────────────────────────────────────────
  let url: string;
  try {
    ({ url } = await tunnelSkill({ repo, deployedAt, expectedUrl: ngrokUrl }));
  } catch (err) {
    const msg = err instanceof TunnelTimeoutError
      ? `Tunnel URL didn't appear in time. Check CloudWatch → \`${repo}-ngrok\`.`
      : (err instanceof Error ? err.message : String(err));
    await update(client, channel, ts, `⚠️ Deployed, tunnel timeout`, errorBlocks('⚠️ Deployed but tunnel not found', repo, msg));
    _appendTurn(convKey, { role: 'assistant', content: `⚠️ \`${repo}\` deployed but tunnel didn't come up: ${msg}` });
    return;
  }

  logger.info({ action: 'slack_bot:deploy:done', repo, url }, 'Deploy complete');
  await update(client, channel, ts,
    `✅ \`${repo}\` is live at ${url}`,
    statusBlocks({ repo, branch, port, actor, stage: 'done', sha, url }),
  );
  _appendTurn(convKey, { role: 'assistant', content: `✅ \`${repo}\` is live at ${url}` });

  // Notify #tangent-deployments with the live URL
  if (channel !== DEPLOY_CHANNEL) {
    const notif = `✅ *\`${repo}\` is live!*\n🔗 ${url}\n_Deployed by ${actor}_`;
    await post(client, DEPLOY_CHANNEL, DEPLOY_CHANNEL, notif);
  }

  // ── One-shot post-deploy health check ─────────────────────────────────────
  // Waits 15s then checks if the service is still running. If it crashed on
  // startup (port mismatch, missing env var, code error), auto-fetches logs,
  // diagnoses with Claude, and posts the root cause here — no manual log
  // fetching required.
  void quickHealthCheck(client, channel, threadTs, convKey, repo, url).catch((err) => {
    logger.error({ action: 'health_check:crash', err }, 'Post-deploy health check failed');
  });
}

// ─── Teardown ─────────────────────────────────────────────────────────────────

async function handleTeardown(
  { channel, threadTs, userId, client }: Ctx,
  { repo }: { repo: string },
  convKey: string,
): Promise<void> {
  const actor = userId ? `<@${userId}>` : 'someone';
  const ts = await post(client, channel, threadTs, `🛑 Stopping \`${repo}\`...`);

  try {
    const result = await teardownSkill({ repo });
    const text = result.success
      ? `🛑 ${result.message}\n_Stopped by ${actor}._`
      : `⚠️ ${result.message}`;
    await update(client, channel, ts, text, [
      { type: 'section', text: { type: 'mrkdwn', text } },
    ]);
    _appendTurn(convKey, { role: 'assistant', content: text });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await update(client, channel, ts, `❌ Stop failed`, errorBlocks('❌ Stop failed', repo, msg));
    _appendTurn(convKey, { role: 'assistant', content: `❌ Stop failed for \`${repo}\`: ${msg}` });
  }
}

// ─── Data fetchers (return raw strings for Claude to interpret) ───────────────
//
// These functions fetch data and return it as a plain string.
// No Slack posting — Claude reads the string and answers conversationally.

async function fetchStatus(repo: string): Promise<string> {
  const { SERVICE_PREFIX } = await import('../utils/constants.js');
  const { DescribeServicesCommand } = await import('@aws-sdk/client-ecs');
  const { ecsClient } = await import('./aws.js');

  const serviceName = `${SERVICE_PREFIX}${repo}`;
  try {
    const result = await ecsClient().send(
      new DescribeServicesCommand({ cluster: config().ecsClusterName, services: [serviceName] }),
    );
    const svc = result.services?.[0];
    if (!svc || svc.status === 'INACTIVE') {
      return `Service "${repo}" (${serviceName}) was not found or is INACTIVE.`;
    }
    const status = svc.status ?? 'UNKNOWN';
    const running = svc.runningCount ?? 0;
    const desired = svc.desiredCount ?? 0;
    const healthy = running >= desired && desired > 0;

    const baseSummary = [
      `Service: ${serviceName}`,
      `ECS status: ${status}`,
      `Tasks: ${running}/${desired} running`,
      `Health: ${healthy ? 'healthy' : 'DEGRADED — service is not running its desired task count'}`,
      `Cluster: ${config().ecsClusterName}`,
    ].join('\n');

    // When degraded, auto-attach recent app logs so Claude can diagnose immediately
    // without needing a follow-up "show me logs" message.
    if (!healthy && running === 0 && desired > 0) {
      let appLogs = '';
      try { appLogs = await fetchLogs(repo, 'app'); } catch { appLogs = '(app logs unavailable)'; }
      return [
        baseSummary,
        '',
        '--- Auto-fetched app logs (service has 0 running tasks) ---',
        appLogs,
      ].join('\n');
    }

    return baseSummary;
  } catch (err) {
    throw new Error(`ECS unavailable: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function fetchListServices(): Promise<string> {
  const { ListServicesCommand, DescribeServicesCommand } = await import('@aws-sdk/client-ecs');
  const { ecsClient } = await import('./aws.js');
  const { SERVICE_PREFIX } = await import('../utils/constants.js');
  const { ecsClusterName } = config();

  const arns: string[] = [];
  let nextToken: string | undefined;
  do {
    const r = await ecsClient().send(new ListServicesCommand({ cluster: ecsClusterName, nextToken, maxResults: 100 }));
    arns.push(...(r.serviceArns ?? []).filter((a) => a.includes(SERVICE_PREFIX)));
    nextToken = r.nextToken;
  } while (nextToken);

  if (arns.length === 0) return 'No Tangent-managed services are currently running.';

  const svcs = [];
  for (let i = 0; i < arns.length; i += 10) {
    const r = await ecsClient().send(new DescribeServicesCommand({ cluster: ecsClusterName, services: arns.slice(i, i + 10) }));
    svcs.push(...(r.services ?? []).filter((s) => s.status !== 'INACTIVE'));
  }

  const lines = svcs.map((s) => {
    const repo = (s.serviceName ?? '').replace(SERVICE_PREFIX, '');
    const running = s.runningCount ?? 0;
    const desired = s.desiredCount ?? 0;
    const healthy = running >= desired && desired > 0;
    return `- ${repo}: ${running}/${desired} tasks (${healthy ? 'healthy' : 'degraded'})`;
  });

  return `${svcs.length} running service(s) on cluster "${ecsClusterName}":\n${lines.join('\n')}`;
}

async function fetchListRepos(): Promise<string> {
  const repos = await listAllRepos();
  if (repos.length === 0) return 'No repos found in the Impiricus-AI GitHub org.';

  const lines = repos.map((r) => {
    const parts = [`- ${r.name} (${r.private ? 'private' : 'public'}, branch: ${r.defaultBranch})`];
    if (r.description) parts.push(`  ${r.description}`);
    if (r.topics.length > 0) parts.push(`  topics: ${r.topics.join(', ')}`);
    return parts.join('\n');
  });

  return `${repos.length} repos in Impiricus-AI (sorted by recent activity):\n${lines.join('\n')}`;
}

async function fetchInspectRepo(repo: string): Promise<string> {
  const info = await inspectRepo(repo);

  const parts: string[] = [
    `Repo: ${info.name} (${info.private ? 'private' : 'public'})`,
    info.description ? `Description: ${info.description}` : '',
    `Default branch: ${info.defaultBranch}`,
    info.topics.length > 0 ? `Topics: ${info.topics.join(', ')}` : '',
    // Surface port prominently — this is critical for correct deploys
    info.exposedPort
      ? `\n⚠️  DEPLOY PORT: ${info.exposedPort} (from Dockerfile EXPOSE — use this exact port when deploying)`
      : '\n⚠️  DEPLOY PORT: unknown — no Dockerfile EXPOSE found. Ask the user what port the app listens on.',
    `\nTop-level files: ${info.files.join(', ')}`,
    info.dockerfile ? `\nDockerfile:\n${info.dockerfile.slice(0, 1000)}` : '\nNo Dockerfile found.',
    info.packageJson ? `\npackage.json: ${info.packageJson.slice(0, 500)}` : '',
    info.requirementsTxt ? `\nrequirements.txt:\n${info.requirementsTxt.slice(0, 500)}` : '',
    info.readme ? `\nREADME (first 30 lines):\n${info.readme.split('\n').slice(0, 30).join('\n')}` : '',
  ].filter(Boolean);

  return parts.join('\n');
}

async function fetchScan(): Promise<string> {
  const summary = await scanSkill();
  const lines = [
    `CVE scan complete. Scanned ${summary.total} repos.`,
    `Clean: ${summary.clean}`,
    `With findings: ${summary.vulnerable}`,
  ];
  if (summary.vulnerable > 0) {
    lines.push('\nCheck CloudWatch logs or run a fresh scan for full finding details.');
  }
  return lines.join('\n');
}

async function fetchLogs(repo: string, container: string): Promise<string> {
  const { DescribeLogStreamsCommand, GetLogEventsCommand } = await import('@aws-sdk/client-cloudwatch-logs');
  const { ListTasksCommand, DescribeTasksCommand } = await import('@aws-sdk/client-ecs');
  const { cwlClient, ecsClient } = await import('./aws.js');
  const { SERVICE_PREFIX } = await import('../utils/constants.js');
  const { logGroupName, ecsClusterName } = config();

  const logStreamPrefix = `${repo}-${container}`;

  // ── Step 1: Try to find the currently running task IDs for this service ──
  // Reading logs from the LIVE task's stream is far more reliable than
  // grabbing whichever stream had the most recent event (which can be the
  // OLD task emitting "shutting down" during a deploy overlap).
  let liveTaskIds: string[] = [];
  try {
    const tasksResult = await ecsClient().send(new ListTasksCommand({
      cluster: ecsClusterName,
      serviceName: `${SERVICE_PREFIX}${repo}`,
      desiredStatus: 'RUNNING',
    }));
    const taskArns = tasksResult.taskArns ?? [];
    if (taskArns.length > 0) {
      // Task ARN is `arn:aws:ecs:region:acct:task/cluster/taskid` — grab the last segment
      liveTaskIds = taskArns.map((arn) => arn.split('/').pop() ?? '').filter(Boolean);
    }
  } catch {
    // ECS query failed — fall through to the prefix-based lookup
  }

  // Only fetch logs from the last 30 minutes by default — stale logs from
  // previous deployments are noise and confuse both Claude and the user.
  const RECENT_WINDOW_MS = 30 * 60 * 1000;
  const startTime = Date.now() - RECENT_WINDOW_MS;

  let streamName: string | null = null;
  let lastEventMs = 0;

  // ── Step 2a: If we have a live task, construct its exact stream name ─────
  // awslogs driver naming: {stream-prefix}/{container-name}/{task-id}
  // stream-prefix in the task def is `{repo}-{container}` and container-name
  // is just `{container}` (literally "app" or "ngrok").
  if (liveTaskIds.length > 0) {
    // Try the most recent task first. If multiple are running (during a
    // rolling deploy), prefer the one with logs emitted in the window.
    for (const taskId of liveTaskIds) {
      const candidate = `${logStreamPrefix}/${container}/${taskId}`;
      try {
        const r = await cwlClient().send(new DescribeLogStreamsCommand({
          logGroupName,
          logStreamNamePrefix: candidate,
          limit: 1,
        }));
        const found = r.logStreams?.[0];
        if (found?.logStreamName) {
          streamName = found.logStreamName;
          lastEventMs = found.lastEventTimestamp ?? 0;
          break;
        }
      } catch {
        // try next task
      }
    }
  }

  // ── Step 2b: Fallback — find the most recent stream by prefix ────────────
  if (!streamName) {
    let streams;
    try {
      const r = await cwlClient().send(new DescribeLogStreamsCommand({
        logGroupName,
        logStreamNamePrefix: logStreamPrefix,
        orderBy: 'LastEventTime',
        descending: true,
        limit: 5,
      }));
      streams = r.logStreams ?? [];
    } catch (err) {
      throw new Error(`CloudWatch unavailable: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (streams.length === 0) {
      return `No CloudWatch log streams found for "${repo}" (${container} container). The service may not have started yet.`;
    }

    const best = streams[0];
    streamName = best.logStreamName!;
    lastEventMs = best.lastEventTimestamp ?? 0;
  }

  // Compute age of this stream's last event so stale data is clearly flagged
  const ageMs = Date.now() - lastEventMs;
  const ageHours = Math.floor(ageMs / (1000 * 60 * 60));
  const ageMinutes = Math.floor((ageMs % (1000 * 60 * 60)) / (1000 * 60));
  const ageStr = ageHours > 0 ? `${ageHours}h ${ageMinutes}m ago` : `${ageMinutes}m ago`;

  // If the entire stream is older than our window, say so explicitly.
  // Skip this check if we have a live task — newly-started containers haven't
  // emitted anything yet but their stream is the right one to wait on.
  const fromLiveTask = liveTaskIds.length > 0;
  if (!fromLiveTask && lastEventMs > 0 && lastEventMs < startTime) {
    return `No recent logs for "${repo}" (${container} container). Last log entry was ${ageStr} — likely from a previous deployment. The current container may still be starting up, or it crashed before emitting any logs. Try again in 30-60 seconds, or run "clear logs for ${repo}" to wipe stale streams.`;
  }

  let events: string[] = [];
  try {
    const r = await cwlClient().send(new GetLogEventsCommand({
      logGroupName,
      logStreamName: streamName,
      startTime,
      limit: 100,
      startFromHead: false,
    }));
    events = (r.events ?? []).map((e) => e.message ?? '').filter(Boolean);
  } catch (err) {
    throw new Error(`Failed to read log stream: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Avoid unused-import warnings if DescribeTasksCommand isn't otherwise used
  void DescribeTasksCommand;

  // If logs are empty AND we know we're tracking the live task, say so —
  // this means the container is up but hasn't written anything yet, OR it
  // already crashed before writing.
  if (events.length === 0 && fromLiveTask) {
    return `Stream \`${streamName}\` is the LIVE task's log stream but has no entries in the last 30 minutes. The container is either still booting or crashed before writing logs. Check ECS task status — task ID: ${liveTaskIds[0]}.`;
  }

  // For ngrok container, extract the tunnel URL if present
  if (container === 'ngrok') {
    let tunnelUrl: string | null = null;
    for (const line of events) {
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        const url = parsed['url'];
        if (typeof url === 'string' && url.startsWith('https://') && url.includes('ngrok')) {
          tunnelUrl = url;
        }
      } catch {
        const match = line.match(/https:\/\/[a-zA-Z0-9-]+\.ngrok[^"'\s]*/);
        if (match) tunnelUrl = match[0];
      }
    }

    const recentLines = events.slice(-20).join('\n');
    if (tunnelUrl) {
      return `Ngrok tunnel URL for ${repo}: ${tunnelUrl}\n\nRecent ngrok logs (stream: ${streamName}, last activity: ${ageStr}):\n${recentLines}`;
    }
    return `No tunnel URL found in recent ngrok logs for ${repo}. The ngrok container may be starting up or may have crashed.\n\nRecent ngrok logs (stream: ${streamName}, last activity: ${ageStr}):\n${recentLines}`;
  }

  // For app container, return recent log lines
  const recentLines = events.slice(-30).join('\n');
  return `Recent app logs for ${repo} (stream: ${streamName}, last activity: ${ageStr}):\n${recentLines}`;
}

async function fetchClearLogs(repo: string, container: string): Promise<string> {
  const { DescribeLogStreamsCommand, DeleteLogStreamCommand } = await import('@aws-sdk/client-cloudwatch-logs');
  const { cwlClient } = await import('./aws.js');
  const { logGroupName } = config();

  const prefixes = container === 'all'
    ? [`${repo}-app`, `${repo}-ngrok`]
    : [`${repo}-${container}`];

  const deleted: string[] = [];
  const errors: string[] = [];

  for (const prefix of prefixes) {
    let streams;
    try {
      const r = await cwlClient().send(new DescribeLogStreamsCommand({
        logGroupName,
        logStreamNamePrefix: prefix,
        limit: 50,
      }));
      streams = r.logStreams ?? [];
    } catch (err) {
      errors.push(`Could not list streams for ${prefix}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    for (const stream of streams) {
      if (!stream.logStreamName) continue;
      try {
        await cwlClient().send(new DeleteLogStreamCommand({
          logGroupName,
          logStreamName: stream.logStreamName,
        }));
        deleted.push(stream.logStreamName);
      } catch (err) {
        errors.push(`Failed to delete ${stream.logStreamName}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  const parts: string[] = [];
  if (deleted.length > 0) {
    parts.push(`Deleted ${deleted.length} log stream(s) for ${repo} (${container}):\n${deleted.map((s) => `- ${s}`).join('\n')}`);
  } else {
    parts.push(`No log streams found to delete for ${repo} (${container}).`);
  }
  if (errors.length > 0) {
    parts.push(`Errors:\n${errors.join('\n')}`);
  }
  return parts.join('\n\n');
}

async function fetchDiscover(): Promise<string> {
  const result = await discoverSkill();
  const cfg = config();
  const parts: string[] = [];

  if (result.awsErrors.length > 0) {
    parts.push('AWS errors:\n' + result.awsErrors.map((e) => `- ${e}`).join('\n'));
  }

  if (result.missing.length === 0) {
    parts.push('All .env config values are set — no placeholders detected.');
  } else {
    parts.push(`Missing config (${result.missing.length} values):`);
    for (const key of result.missing) {
      const suggestion = result.suggestions.find((s) => s.key === key);
      if (suggestion) {
        parts.push(`- ${key}: found "${suggestion.value}" (from ${suggestion.source})`);
      } else {
        parts.push(`- ${key}: needs manual input`);
      }
    }
  }

  if (result.ecrRepos.length > 0) {
    parts.push(`\nECR repositories: ${result.ecrRepos.join(', ')}`);
  }

  parts.push(`\nLog group "${cfg.logGroupName}": ${result.logGroupExists ? 'exists' : 'does not exist'}`);
  parts.push(`\nConfirmed: ECS_CLUSTER_NAME=${cfg.ecsClusterName}, GITHUB_ORG=${cfg.githubOrg}`);

  return parts.join('\n');
}

async function handleInjectSecret(
  ctx: Ctx,
  input: { repo: string; secret_name: string },
  convKey: string,
): Promise<string> {
  let { secret_name } = input;
  const { repo } = input;

  // Enforce tangent/ prefix — the ECS execution role IAM policy only grants
  // GetSecretValue on tangent/*. If the caller passes a bare name, auto-prefix.
  if (!secret_name.startsWith('tangent/')) {
    secret_name = `tangent/${secret_name}`;
  }

  const ts = await post(ctx.client, ctx.channel, ctx.threadTs, `⏳ Wiring \`${secret_name}\` into \`${repo}\`...`);

  try {
    const { DescribeSecretCommand, ListSecretsCommand: _LS } = await import('@aws-sdk/client-secrets-manager');
    const {
      RegisterTaskDefinitionCommand,
      UpdateServiceCommand,
      ListTaskDefinitionsCommand,
      DescribeTaskDefinitionCommand,
    } = await import('@aws-sdk/client-ecs');
    const { smClient } = await import('./aws.js');
    const { ecsClient } = await import('./aws.js');
    const { SERVICE_PREFIX, TASK_FAMILY_PREFIX } = await import('../utils/constants.js');

    // 1. Resolve the secret ARN from Secrets Manager
    const secretMeta = await smClient().send(new DescribeSecretCommand({ SecretId: secret_name }));
    const secretArn = secretMeta.ARN;
    if (!secretArn) throw new Error(`Secret "${secret_name}" not found in Secrets Manager`);

    // 2. Fetch the current task definition
    const taskFamily = `${TASK_FAMILY_PREFIX}${repo}`;
    const listResult = await ecsClient().send(new ListTaskDefinitionsCommand({
      familyPrefix: taskFamily,
      sort: 'DESC',
      maxResults: 1,
      status: 'ACTIVE',
    }));
    const latestArn = listResult.taskDefinitionArns?.[0];
    if (!latestArn) throw new Error(`No active task definition found for "${repo}"`);

    const descResult = await ecsClient().send(new DescribeTaskDefinitionCommand({ taskDefinition: latestArn }));
    const taskDef = descResult.taskDefinition;
    if (!taskDef) throw new Error('Could not describe task definition');

    const containers = taskDef.containerDefinitions ?? [];
    const appContainer = containers.find((c) => c.name === 'app');
    if (!appContainer) throw new Error('No "app" container found in task definition');

    // 3. Add/update the secret in the app container (dedupe by name).
    // The env var name exposed to the app should be the bare key (e.g. ASANA_PAT),
    // NOT the full Secrets Manager path (tangent/ASANA_PAT). Strip the prefix.
    const envVarName = secret_name.replace(/^tangent\//, '');
    const existingSecrets = appContainer.secrets ?? [];
    const filtered = existingSecrets
      // Remove any existing entry with the same env var name (exact match)
      .filter((s) => s.name !== envVarName)
      // Also remove any entry whose env var name matches with tangent/ prefix
      // (from before the prefix-stripping fix)
      .filter((s) => s.name !== secret_name)
      // Drop ALL secrets whose ARN references a non-tangent/ path — these
      // cause AccessDeniedException at container startup because the ECS
      // execution role only has GetSecretValue on tangent/*.
      .filter((s) => {
        const arn = s.valueFrom ?? '';
        if (arn.includes(':secret:tangent/')) return true;
        logger.warn(
          { action: 'inject_secret:drop_unprefixed', name: s.name, arn },
          `Dropping inherited secret "${s.name}" — ARN outside tangent/ prefix`,
        );
        return false;
      });
    appContainer.secrets = [...filtered, { name: envVarName, valueFrom: secretArn }];

    // 4. Re-register the task definition with the new secret
    const registerResult = await ecsClient().send(new RegisterTaskDefinitionCommand({
      family:                   taskDef.family,
      containerDefinitions:     containers,
      networkMode:              taskDef.networkMode,
      requiresCompatibilities:  taskDef.requiresCompatibilities,
      cpu:                      taskDef.cpu,
      memory:                   taskDef.memory,
      executionRoleArn:         taskDef.executionRoleArn,
      taskRoleArn:              taskDef.taskRoleArn ?? config().ecsTaskRoleArn,
      volumes:                  taskDef.volumes,
    }));
    const newTaskDefArn = registerResult.taskDefinition?.taskDefinitionArn;
    if (!newTaskDefArn) throw new Error('Task definition re-registration returned no ARN');

    // 5. Force a new deployment so the running container picks up the secret
    const { ecsClusterName } = config();
    await ecsClient().send(new UpdateServiceCommand({
      cluster:            ecsClusterName,
      service:            `${SERVICE_PREFIX}${repo}`,
      taskDefinition:     newTaskDefArn,
      forceNewDeployment: true,
    }));

    const result = `Successfully wired secret "${secret_name}" into service "${repo}". A new ECS deployment was triggered.`;
    await update(ctx.client, ctx.channel, ts, `✓ injected \`${secret_name}\` into \`${repo}\``);
    return result;
  } catch (err) {
    const result = `Failed to inject secret "${secret_name}" into "${repo}": ${err instanceof Error ? err.message : String(err)}`;
    await update(ctx.client, ctx.channel, ts, `❌ ${result}`);
    return result;
  }
}

async function fetchListSecrets(): Promise<string> {
  const { ListSecretsCommand } = await import('@aws-sdk/client-secrets-manager');
  const { smClient } = await import('./aws.js');

  const secrets: { name: string; description?: string }[] = [];
  let nextToken: string | undefined;
  do {
    const r = await smClient().send(new ListSecretsCommand({ NextToken: nextToken, MaxResults: 100 }));
    for (const s of r.SecretList ?? []) {
      if (s.Name) secrets.push({ name: s.Name, description: s.Description });
    }
    nextToken = r.NextToken;
  } while (nextToken);

  if (secrets.length === 0) return 'No secrets found in Secrets Manager.';

  const lines = secrets.map((s) =>
    s.description ? `- ${s.name}: ${s.description}` : `- ${s.name}`,
  );
  return `${secrets.length} secret(s) in Secrets Manager (names only — values are never shown):\n${lines.join('\n')}`;
}

async function handlePutSecret(
  ctx: Ctx,
  input: { name: string; value: string; description?: string },
  convKey: string,
): Promise<string> {
  // Enforce tangent/ prefix — the ECS execution role IAM policy only grants
  // GetSecretValue on tangent/*. Secrets without this prefix cause
  // AccessDeniedException at container startup.
  if (!input.name.startsWith('tangent/')) {
    input = { ...input, name: `tangent/${input.name}` };
  }

  const { CreateSecretCommand, PutSecretValueCommand, ResourceExistsException } = await import('@aws-sdk/client-secrets-manager');
  const { smClient } = await import('./aws.js');

  const ts = await post(ctx.client, ctx.channel, ctx.threadTs, `⏳ Writing \`${input.name}\` to Secrets Manager...`);

  try {
    // Try create first; if it already exists, update the value instead
    try {
      await smClient().send(new CreateSecretCommand({
        Name: input.name,
        SecretString: input.value,
        Description: input.description,
      }));
    } catch (err) {
      if (err instanceof ResourceExistsException || (err as { name?: string }).name === 'ResourceExistsException') {
        await smClient().send(new PutSecretValueCommand({
          SecretId: input.name,
          SecretString: input.value,
        }));
      } else {
        throw err;
      }
    }

    const result = `Successfully saved secret "${input.name}" to Secrets Manager.${input.description ? ` Description: ${input.description}` : ''}`;
    await update(ctx.client, ctx.channel, ts, `✓ saved \`${input.name}\``);
    return result;
  } catch (err) {
    const result = `Failed to save secret "${input.name}": ${err instanceof Error ? err.message : String(err)}`;
    await update(ctx.client, ctx.channel, ts, `❌ ${result}`);
    return result;
  }
}

// ─── Postgres tool handlers ──────────────────────────────────────────────────

async function fetchDbSchema(): Promise<string> {
  const { pgConfigured, describeSchema } = await import('./postgres.js');
  if (!pgConfigured()) return 'Postgres is not configured on this Tangent instance — run scripts/setup-postgres.sh on the EC2 first, then add TANGENT_DB_ADMIN_URL and TANGENT_DB_QUERY_URL to .env.';

  const s = await describeSchema();
  const parts: string[] = [];
  parts.push(`Databases: ${s.databases.join(', ') || '(none)'}`);
  parts.push(`Extensions: ${s.extensions.map((e) => `${e.name}@${e.version}`).join(', ') || '(none)'}`);
  if (s.tables.length === 0) {
    parts.push('Tables: (none — schema is empty)');
  } else {
    parts.push(`Tables (${s.tables.length}):`);
    for (const t of s.tables) {
      parts.push(`  ${t.schema}.${t.name} (~${t.rowEstimate} rows)`);
    }
  }
  if (s.columns.length > 0) {
    parts.push(`\nColumns:`);
    let lastTable = '';
    for (const c of s.columns) {
      const fq = `${c.schema}.${c.table}`;
      if (fq !== lastTable) {
        parts.push(`  ${fq}:`);
        lastTable = fq;
      }
      parts.push(`    ${c.column}: ${c.type}${c.nullable ? ' (nullable)' : ''}`);
    }
  }
  return parts.join('\n');
}

async function fetchDbQuery(sql: string): Promise<string> {
  const { pgConfigured, runReadOnlyQuery, validateReadOnlySql } = await import('./postgres.js');
  if (!pgConfigured()) return 'Postgres is not configured on this Tangent instance.';

  const validation = validateReadOnlySql(sql);
  if (!validation.ok) return `Query rejected: ${validation.reason}\n\nThe db_query tool only allows read-only statements (SELECT, WITH, EXPLAIN, SHOW, VALUES, TABLE).`;

  try {
    const result = await runReadOnlyQuery(sql);
    if (result.rowCount === 0) return `Query returned 0 rows.\n\nSQL:\n\`\`\`sql\n${sql}\n\`\`\``;

    // Format as a markdown-ish table
    const colNames = result.fields.map((f) => f.name);
    const rows = result.rows.map((r) =>
      colNames.map((c) => {
        const v = r[c];
        if (v === null || v === undefined) return '∅';
        if (typeof v === 'object') return JSON.stringify(v);
        return String(v);
      }),
    );
    const lines: string[] = [];
    lines.push(colNames.join(' | '));
    lines.push(colNames.map(() => '---').join(' | '));
    for (const r of rows) lines.push(r.map((cell) => cell.length > 80 ? cell.slice(0, 77) + '...' : cell).join(' | '));

    const truncNote = result.truncated ? `\n\n_(truncated to first 50 rows of ${result.rowCount} total)_` : '';
    return `Query returned ${result.rowCount} row(s):\n\`\`\`\n${lines.join('\n')}\n\`\`\`${truncNote}`;
  } catch (err) {
    return `Query failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}

async function fetchDbListUsers(): Promise<string> {
  const { pgConfigured, listDbUsers } = await import('./postgres.js');
  if (!pgConfigured()) return 'Postgres is not configured on this Tangent instance.';

  const users = await listDbUsers();
  if (users.length === 0) return 'No Postgres roles found (excluding internal pg_* roles).';

  const lines = users.map((u) => {
    const flags: string[] = [];
    if (u.rolsuper) flags.push('SUPERUSER');
    if (u.rolcreaterole) flags.push('CREATEROLE');
    if (u.rolcreatedb) flags.push('CREATEDB');
    if (!u.rolcanlogin) flags.push('NOLOGIN');
    return `- *${u.rolname}*${flags.length > 0 ? ` _(${flags.join(', ')})_` : ''}`;
  });
  return `${users.length} Postgres role(s):\n${lines.join('\n')}`;
}

async function handleDbCreateUser(
  ctx: Ctx,
  input: { username: string; create_database?: boolean },
  convKey: string,
): Promise<string> {
  // Daanish only — Postgres role creation is high blast radius
  if (ctx.userId !== APPROVER_ID) {
    const msg = '🔒 Only Daanish can create Postgres users — DB role names are sensitive and the password gets DM\'d to him.';
    await post(ctx.client, ctx.channel, ctx.threadTs, msg);
    _appendTurn(convKey, { role: 'assistant', content: msg });
    return msg;
  }

  const { pgConfigured, createDbUser, validateRoleName } = await import('./postgres.js');
  if (!pgConfigured()) {
    const msg = 'Postgres is not configured on this Tangent instance.';
    await post(ctx.client, ctx.channel, ctx.threadTs, msg);
    return msg;
  }

  if (!validateRoleName(input.username)) {
    const msg = `❌ Invalid role name "${input.username}" — must be lowercase alphanumeric+underscore, 2-63 chars, starting with a letter.`;
    await post(ctx.client, ctx.channel, ctx.threadTs, msg);
    _appendTurn(convKey, { role: 'assistant', content: msg });
    return msg;
  }

  const ts = await post(ctx.client, ctx.channel, ctx.threadTs, `⏳ Creating Postgres role \`${input.username}\`...`);

  let result;
  try {
    result = await createDbUser({ username: input.username, createDatabase: input.create_database === true });
  } catch (err) {
    const msg = `❌ Failed to create role: ${err instanceof Error ? err.message : String(err)}`;
    await update(ctx.client, ctx.channel, ts, msg);
    _appendTurn(convKey, { role: 'assistant', content: msg });
    return msg;
  }

  // Mirror the connection string into Secrets Manager so deployed services can inject it.
  const secretName = `tangent/db/${result.username}`;
  let secretSaved = false;
  try {
    const { CreateSecretCommand, PutSecretValueCommand, ResourceExistsException } = await import('@aws-sdk/client-secrets-manager');
    const { smClient } = await import('./aws.js');
    try {
      await smClient().send(new CreateSecretCommand({
        Name: secretName,
        SecretString: result.connectionString,
        Description: `Postgres connection string for role ${result.username}`,
      }));
    } catch (err) {
      if (err instanceof ResourceExistsException || (err as { name?: string }).name === 'ResourceExistsException') {
        await smClient().send(new PutSecretValueCommand({
          SecretId: secretName,
          SecretString: result.connectionString,
        }));
      } else {
        throw err;
      }
    }
    secretSaved = true;
  } catch (err) {
    logger.warn({ action: 'db_create_user:secret_save_failed', err: String(err) }, 'Could not mirror connection string to Secrets Manager');
  }

  // Public ack — never includes the password
  const publicMsg = result.databaseName
    ? `✅ Created role \`${result.username}\` and database \`${result.databaseName}\`. Connection string saved to Secrets Manager as \`${secretName}\`${secretSaved ? '' : ' (⚠️  Secrets Manager save failed — see logs)'}.\nPassword DM'd to <@${APPROVER_ID}>.`
    : `✅ Created role \`${result.username}\`. Connection string saved to Secrets Manager as \`${secretName}\`${secretSaved ? '' : ' (⚠️  Secrets Manager save failed — see logs)'}.\nPassword DM'd to <@${APPROVER_ID}>.`;
  await update(ctx.client, ctx.channel, ts, publicMsg);
  _appendTurn(convKey, { role: 'assistant', content: publicMsg });

  // DM the password to Daanish — ONLY place the password is ever surfaced.
  try {
    const dm = await ctx.client.conversations.open({ users: APPROVER_ID });
    const dmChannel = (dm.channel as { id?: string } | undefined)?.id;
    if (dmChannel) {
      const dmText = [
        `:key: *Postgres role created: \`${result.username}\`*`,
        result.databaseName ? `Database: \`${result.databaseName}\`` : '',
        `Password: \`${result.password}\``,
        `Connection string: \`${result.connectionString}\``,
        secretSaved ? `Also stored in Secrets Manager as \`${secretName}\` — inject it via \`@Tangent inject ${secretName} into <repo>\`.` : '⚠️  *Secrets Manager save failed* — store this string somewhere safe.',
        '',
        '_This password is shown only once. The Secrets Manager copy is the source of truth going forward._',
      ].filter(Boolean).join('\n');
      await ctx.client.chat.postMessage({ channel: dmChannel, text: dmText });
    } else {
      logger.warn({ action: 'db_create_user:dm_open_failed' }, 'Could not open DM with Daanish to deliver password');
    }
  } catch (err) {
    logger.warn({ action: 'db_create_user:dm_send_failed', err: String(err) }, 'Failed to DM password to Daanish');
  }

  return `Created Postgres role ${result.username}${result.databaseName ? ` and database ${result.databaseName}` : ''}. Connection string is in Secrets Manager as ${secretName}.`;
}

async function handleDbDropUser(
  ctx: Ctx,
  input: { username: string; drop_database?: boolean },
  convKey: string,
): Promise<string> {
  if (ctx.userId !== APPROVER_ID) {
    const msg = '🔒 Only Daanish can drop Postgres users.';
    await post(ctx.client, ctx.channel, ctx.threadTs, msg);
    _appendTurn(convKey, { role: 'assistant', content: msg });
    return msg;
  }

  const { pgConfigured, dropDbUser, validateRoleName } = await import('./postgres.js');
  if (!pgConfigured()) {
    const msg = 'Postgres is not configured on this Tangent instance.';
    await post(ctx.client, ctx.channel, ctx.threadTs, msg);
    return msg;
  }
  if (!validateRoleName(input.username)) {
    const msg = `❌ Invalid role name "${input.username}".`;
    await post(ctx.client, ctx.channel, ctx.threadTs, msg);
    _appendTurn(convKey, { role: 'assistant', content: msg });
    return msg;
  }

  const ts = await post(ctx.client, ctx.channel, ctx.threadTs, `⏳ Dropping role \`${input.username}\`${input.drop_database ? ' and its database' : ''}...`);

  try {
    await dropDbUser(input.username, input.drop_database === true);
    const msg = `✅ Dropped role \`${input.username}\`${input.drop_database ? ' and its database' : ''}.`;
    await update(ctx.client, ctx.channel, ts, msg);
    _appendTurn(convKey, { role: 'assistant', content: msg });
    return msg;
  } catch (err) {
    const msg = `❌ Failed to drop role: ${err instanceof Error ? err.message : String(err)}`;
    await update(ctx.client, ctx.channel, ts, msg);
    _appendTurn(convKey, { role: 'assistant', content: msg });
    return msg;
  }
}

async function handleRememberPerson(
  ctx: Ctx,
  input: { user_id: string; name: string; note: string },
  convKey: string,
): Promise<void> {
  const { readFileSync, writeFileSync } = await import('fs');
  const { resolve } = await import('path');
  const { execSync } = await import('child_process');

  const peopleFile = resolve(process.cwd(), 'config/people.json');

  let persisted = false;
  let commitSha: string | undefined;
  let errMsg: string | undefined;

  try {
    type PersonEntry = { id: string; name: string; notes: string[] };
    let people: PersonEntry[] = [];
    try {
      people = (JSON.parse(readFileSync(peopleFile, 'utf8')) as { people: PersonEntry[] }).people;
    } catch { /* file missing — start fresh */ }

    const existing = people.find((p) => p.id === input.user_id);
    if (existing) {
      if (!existing.notes.includes(input.note)) {
        existing.notes.push(input.note);
      }
    } else {
      people.push({ id: input.user_id, name: input.name, notes: [input.note] });
    }

    writeFileSync(peopleFile, JSON.stringify({ people }, null, 2));

    // Also update in-memory config so the current session has the new note
    config().peopleNotes = people;

    // Push to currently checked-out branch, not hardcoded `main` — EC2 was
    // historically on `master` and hardcoding a branch meant these commits
    // landed locally and never reached origin. Same fix as allowUser().
    const currentBranch = execSync(`git -C "${process.cwd()}" rev-parse --abbrev-ref HEAD`, { stdio: ['pipe', 'pipe', 'pipe'] })
      .toString().trim();

    execSync(
      `git -C "${process.cwd()}" add config/people.json && ` +
      `git -C "${process.cwd()}" -c user.name="Tangent" -c user.email="tangent@impiricus.com" ` +
      `commit -m "memory: remember note about ${input.name}" && ` +
      `git -C "${process.cwd()}" push origin ${currentBranch}`,
      { stdio: 'pipe' },
    );
    persisted = true;
    try {
      commitSha = execSync(`git -C "${process.cwd()}" rev-parse --short HEAD`, { stdio: ['pipe', 'pipe', 'pipe'] })
        .toString().trim();
    } catch { /* best-effort */ }
    logger.info({ action: 'remember_person:persisted', userId: input.user_id, commitSha }, 'Memory saved to GitHub');
  } catch (err) {
    errMsg = err instanceof Error ? err.message : String(err);
    logger.warn({ action: 'remember_person:failed', err: errMsg }, 'Failed to persist person memory');
  }

  // Always post a visible confirmation — without it, the DM conversation store
  // has no assistant turn for this action, and Claude re-calls the tool on the
  // next user message because it looks like the request was never handled.
  const notePreview = input.note.length > 140 ? input.note.slice(0, 140) + '…' : input.note;
  let msg: string;
  if (persisted) {
    const shaNote = commitSha ? ` (commit \`${commitSha}\`)` : '';
    msg = `🧠 Noted about *${input.name}*: _${notePreview}_\nSaved to \`config/people.json\` and pushed to \`main\`${shaNote}.`;
  } else if (errMsg) {
    msg = `🧠 Noted about *${input.name}* in memory: _${notePreview}_\n⚠️ Could NOT push to GitHub: _${errMsg}_ — the note will be lost on next restart.`;
  } else {
    msg = `🧠 Noted about *${input.name}*: _${notePreview}_`;
  }
  await post(ctx.client, ctx.channel, ctx.threadTs, msg);
  _appendTurn(convKey, { role: 'assistant', content: msg });
}

// ─── Block Kit helpers ────────────────────────────────────────────────────────

type DeployStage = 'building' | 'deploying' | 'tunneling' | 'done';

function statusBlocks(opts: {
  repo: string; branch: string; port: number; actor: string;
  stage: DeployStage; sha?: string; url?: string;
}): KnownBlock[] {
  const { repo, branch, port, actor, stage, sha, url } = opts;

  const headline: Record<DeployStage, string> = {
    building:  `🔨 Building \`${repo}\` from \`${branch}\`...`,
    deploying: `🚀 Build done (\`${repo}-${sha}\`). Deploying to ECS...`,
    tunneling: `⏳ Waiting for ngrok tunnel...`,
    done:      `✅ *${repo}* is live!`,
  };

  const fields: { type: 'mrkdwn'; text: string }[] = [
    { type: 'mrkdwn', text: `*Repo*\n\`${repo}\`` },
    { type: 'mrkdwn', text: `*Branch*\n\`${branch}\`` },
    { type: 'mrkdwn', text: `*Port*\n${port}` },
    { type: 'mrkdwn', text: `*By*\n${actor}` },
  ];
  if (sha) fields.push({ type: 'mrkdwn', text: `*Image*\n\`${repo}-${sha}\`` });
  if (url) fields.push({ type: 'mrkdwn', text: `*URL*\n<${url}|${url}>` });

  return [
    { type: 'section', text: { type: 'mrkdwn', text: headline[stage] } },
    { type: 'section', fields },
  ] as KnownBlock[];
}

function errorBlocks(title: string, repo: string, detail: string): KnownBlock[] {
  return [
    { type: 'section', text: { type: 'mrkdwn', text: `${title} — *${repo}*\n${detail.slice(0, 2800)}` } },
  ] as KnownBlock[];
}
