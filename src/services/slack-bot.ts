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
import { processMessage, synthesizeToolResult, continueAfterTool, classifyConsent, diagnoseServiceFailure, identifyFileToFix, generateCodeFix, type ConversationTurn, type AgentToolCall } from './ai.js';
import { buildSkill, DockerfileNotFoundError, DockerBuildError } from '../skills/build.js';
import { deploySkill } from '../skills/deploy.js';
import { tunnelSkill, TunnelTimeoutError } from '../skills/tunnel.js';
import { teardownSkill } from '../skills/teardown.js';
import { scanSkill } from '../skills/scan.js';
import { discoverSkill } from '../skills/discover.js';
import { listAllRepos, inspectRepo, pushFile, readRepoFile } from './github.js';
import { logger } from '../utils/logger.js';

// ─── App singleton ────────────────────────────────────────────────────────────

let _app: App | null = null;

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
      const text = (msg.text ?? '').replace(/<@[A-Z0-9]+>/g, '').trim();
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

    // Strip both the MCP prefix and the @mention from the text Claude sees
    const text = rawText.replace(/^\[MCP-USER:\s*[A-Z0-9]+\]\s*/, '').replace(/<@[A-Z0-9]+>/g, '').trim();
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
    const text      = ('text' in event && typeof event.text === 'string') ? event.text.trim() : '';
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

  // Access control
  const { allowedSlackUserIds } = config();
  if (allowedSlackUserIds.size > 0 && (!ctx.userId || !allowedSlackUserIds.has(ctx.userId))) {
    logger.warn({ action: 'slack_bot:unauthorized', userId: ctx.userId }, 'Unauthorized user');
    await post(ctx.client, ctx.channel, ctx.threadTs, "Sorry, you're not authorized to use Tangent.");
    return;
  }

  // ── Daanish-only: dynamically add a user to the allowed list ──────────────
  // Usage (DM or mention): "add @username" / "allow @username"
  const addUserMatch = /^(?:add|allow)\s+<@([A-Z0-9]+)>/i.exec(text.trim());
  if (addUserMatch) {
    if (ctx.userId !== 'U07EU7KSG3U') {
      await post(ctx.client, ctx.channel, ctx.threadTs, '🔒 Only Daanish can add users to the allowed list.');
      return;
    }
    const newUserId = addUserMatch[1]!;
    allowUser(newUserId);
    await post(ctx.client, ctx.channel, ctx.threadTs, `✅ <@${newUserId}> has been added to the allowed list.`);
    return;
  }

  const convKey = _convKey(ctx.channel, ctx.threadTs, source);

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
  const identityPrefix = ctx.userId ? `[Slack User: <@${ctx.userId}> | ID: ${ctx.userId}]\n` : '';
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
    const { repo, branch, port } = call.input as { repo: string; branch: string; port: number };

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

    const requester = ctx.userId ? `<@${ctx.userId}>` : 'Someone';
    const prompt = [
      `🚀 *Deploy requested for \`${repo}\`*`,
      `• Requested by: ${requester}`,
      `• Branch: \`${branch}\``,
      `• Port: ${port}`,
      `• Cluster: \`tangent\` (us-east-1)`,
      '',
      `<@${APPROVER_ID}> — reply *yes* to approve or *no* to cancel.`,
    ].join('\n');

    // Post confirmation in the current thread
    _setPending(convKey, call, prompt, APPROVER_ID, ctx.userId);
    await post(ctx.client, ctx.channel, ctx.threadTs, prompt);
    _appendTurn(convKey, { role: 'assistant', content: prompt });

    // Also notify #tangent-deployments if the request didn't come from there
    if (ctx.channel !== DEPLOY_CHANNEL) {
      const notif = `📣 Deploy request for \`${repo}\` (from ${requester}) — awaiting <@${APPROVER_ID}>'s approval.`;
      await post(ctx.client, DEPLOY_CHANNEL, DEPLOY_CHANNEL, notif);
    }
    return;
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

  // All other tools run in the background — route() returns immediately so
  // Tangent can handle the next message while the task is still in flight.
  // The tool updates the Slack message directly when it completes.
  void executeToolCall(call, ctx, convKey, text, history).catch((err) => {
    logger.error({ action: 'slack_bot:background_tool_error', err }, 'Background tool call failed');
  });
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
      await handleDeploy(ctx, call.input as { repo: string; branch: string; port: number }, convKey);
      break;
    case 'teardown':
      _appendTurn(convKey, { role: 'assistant', content: `Stopping \`${(call.input as { repo: string }).repo}\`` });
      await handleTeardown(ctx, call.input as { repo: string });
      break;
    case 'push_file':
      await handlePushFile(ctx, call.input as { repo: string; path: string; content: string; message?: string; branch?: string }, convKey);
      break;
    case 'allow_user': {
      const { user_id, display_name } = call.input as { user_id: string; display_name: string };
      if (ctx.userId !== 'U07EU7KSG3U') {
        await post(ctx.client, ctx.channel, ctx.threadTs, '🔒 Only Daanish can grant access to Tangent.');
        break;
      }
      allowUser(user_id);
      await post(ctx.client, ctx.channel, ctx.threadTs, `✅ Done — <@${user_id}> (${display_name}) now has access to Tangent.`);
      break;
    }
    case 'put_secret':
      await handlePutSecret(ctx, call.input as { name: string; value: string; description?: string }, convKey);
      break;
    default:
      // Informational tools: fetch data, synthesize a conversational response via Claude
      await handleInfoTool(call, ctx, convKey, userMessage, history);
      break;
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

  const updatedHistory: ConversationTurn[] = [
    ...history,
    { role: 'user',      content: userMessage },
    { role: 'assistant', content: `${call.name} result: ${rawData.slice(0, 1000)}` },
  ];

  // Fire the next tool — for push_file this runs in background with loading animation
  void executeToolCall(next.call, ctx, convKey, userMessage, updatedHistory);
}

async function handlePushFile(
  ctx: Ctx,
  input: { repo: string; path: string; content: string; message?: string; branch?: string },
  convKey: string,
): Promise<void> {
  const { repo, path: filePath, content, branch = 'main' } = input;
  const commitMessage = input.message ?? `Add ${filePath} via Tangent`;

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
  { repo, branch, port }: { repo: string; branch: string; port: number },
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
    ({ deployedAt, ngrokUrl } = await deploySkill({ repo, imageUri, port }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await update(client, channel, ts, `❌ ECS deploy failed`, errorBlocks('❌ ECS deploy failed', repo, msg));
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
    return;
  }

  logger.info({ action: 'slack_bot:deploy:done', repo, url }, 'Deploy complete');
  await update(client, channel, ts,
    `✅ \`${repo}\` is live at ${url}`,
    statusBlocks({ repo, branch, port, actor, stage: 'done', sha, url }),
  );

  // Notify #tangent-deployments with the live URL
  if (channel !== DEPLOY_CHANNEL) {
    const notif = `✅ *\`${repo}\` is live!*\n🔗 ${url}\n_Deployed by ${actor} — approved by <@${APPROVER_ID}>_`;
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
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await update(client, channel, ts, `❌ Stop failed`, errorBlocks('❌ Stop failed', repo, msg));
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
  const { cwlClient } = await import('./aws.js');
  const { logGroupName } = config();

  const logStreamPrefix = `${repo}-${container}`;

  // Find the most recent log stream for this container
  let streams;
  try {
    const r = await cwlClient().send(new DescribeLogStreamsCommand({
      logGroupName,
      logStreamNamePrefix: logStreamPrefix,
      limit: 10,
    }));
    streams = r.logStreams ?? [];
  } catch (err) {
    throw new Error(`CloudWatch unavailable: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (streams.length === 0) {
    return `No CloudWatch log streams found for "${repo}" (${container} container). The service may not have started yet.`;
  }

  // Sort by last event time descending, pick the most recent
  const sorted = [...streams].sort((a, b) => (b.lastEventTimestamp ?? 0) - (a.lastEventTimestamp ?? 0));
  const best = sorted[0];
  const streamName = best.logStreamName!;

  // Compute age of this stream's last event so stale data is clearly flagged
  const lastEventMs = best.lastEventTimestamp ?? 0;
  const ageMs = Date.now() - lastEventMs;
  const ageHours = Math.floor(ageMs / (1000 * 60 * 60));
  const ageMinutes = Math.floor((ageMs % (1000 * 60 * 60)) / (1000 * 60));
  const ageStr = ageHours > 0 ? `${ageHours}h ${ageMinutes}m ago` : `${ageMinutes}m ago`;
  const staleWarning = ageMs > 2 * 60 * 60 * 1000
    ? `⚠️ WARNING: These logs are from ${ageStr} — this is likely a previous deployment. Consider running "clear logs for ${repo}" to wipe old streams.\n\n`
    : '';

  let events: string[] = [];
  try {
    const r = await cwlClient().send(new GetLogEventsCommand({
      logGroupName,
      logStreamName: streamName,
      limit: 100,
      startFromHead: false,
    }));
    events = (r.events ?? []).map((e) => e.message ?? '').filter(Boolean);
  } catch (err) {
    throw new Error(`Failed to read log stream: ${err instanceof Error ? err.message : String(err)}`);
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
      return `${staleWarning}Ngrok tunnel URL for ${repo}: ${tunnelUrl}\n\nRecent ngrok logs (stream: ${streamName}, last activity: ${ageStr}):\n${recentLines}`;
    }
    return `${staleWarning}No tunnel URL found in recent ngrok logs for ${repo}. The ngrok container may be starting up or may have crashed.\n\nRecent ngrok logs (stream: ${streamName}, last activity: ${ageStr}):\n${recentLines}`;
  }

  // For app container, return recent log lines
  const recentLines = events.slice(-30).join('\n');
  return `${staleWarning}Recent app logs for ${repo} (stream: ${streamName}, last activity: ${ageStr}):\n${recentLines}`;
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
): Promise<void> {
  if (ctx.userId !== APPROVER_ID) {
    await post(ctx.client, ctx.channel, ctx.threadTs, '🔒 Only Daanish can write to Secrets Manager.');
    return;
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

    const msg = `✅ Secret \`${input.name}\` saved to Secrets Manager.${input.description ? ` (${input.description})` : ''}`;
    await update(ctx.client, ctx.channel, ts, msg);
    _appendTurn(convKey, { role: 'assistant', content: msg });
  } catch (err) {
    const msg = `❌ Failed to save secret \`${input.name}\`: ${err instanceof Error ? err.message : String(err)}`;
    await update(ctx.client, ctx.channel, ts, msg);
    _appendTurn(convKey, { role: 'assistant', content: msg });
  }
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
