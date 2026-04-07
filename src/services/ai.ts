/**
 * services/ai.ts
 *
 * Anthropic SDK wrapper for Tangent.
 *
 * Core export: processMessage() — a single Claude call that either invokes a
 * DevOps tool or replies conversationally. There is no separate intent-
 * classification step; Claude decides what to do given the full conversation
 * context.  This mirrors how OpenClaw works: the LLM IS the router.
 */

import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ConversationTurn {
  role: 'user' | 'assistant';
  content: string;
}

export type AgentToolCall =
  | { name: 'deploy';          input: { repo: string; branch: string; port: number } }
  | { name: 'teardown';        input: { repo: string } }
  | { name: 'status';          input: { repo: string } }
  | { name: 'list_services';   input: Record<string, never> }
  | { name: 'list_repos';      input: Record<string, never> }
  | { name: 'inspect_repo';    input: { repo: string } }
  | { name: 'cve_scan';        input: Record<string, never> }
  | { name: 'discover_config'; input: Record<string, never> }
  | { name: 'logs';            input: { repo: string; container?: string } }
  | { name: 'clear_logs';     input: { repo: string; container?: string } }
  | { name: 'push_file';      input: { repo: string; path: string; content: string; message?: string; branch?: string } }
  | { name: 'allow_user';    input: { user_id: string; display_name: string } }
  | { name: 'list_secrets';    input: Record<string, never> }
  | { name: 'put_secret';     input: { name: string; value: string; description?: string } }
  | { name: 'remember_person'; input: { user_id: string; name: string; note: string } };

export type AgentResponse =
  | { type: 'tool'; call: AgentToolCall }
  | { type: 'text'; text: string };

// ─── Client singleton ─────────────────────────────────────────────────────────

let _client: Anthropic | null = null;

export function initAiClient(): void {
  _client = new Anthropic({ apiKey: config().anthropicApiKey });
  logger.info({ action: 'ai:init' }, 'Anthropic client initialized');
}

function client(): Anthropic {
  if (!_client) throw new Error('AI client not initialized — call initAiClient() first');
  return _client;
}

// ─── Tool definitions ─────────────────────────────────────────────────────────
//
// These are Tangent's DevOps superpowers exposed to Claude as tools.
// Claude calls whichever tool fits the engineer's request — or none at all
// if they're just asking a question.

const TOOLS: Anthropic.Tool[] = [
  {
    name: 'deploy',
    description:
      'Build a repo from GitHub, push the Docker image to ECR, and deploy it as an ECS Fargate service with an ngrok tunnel URL. ' +
      'Use when the engineer asks to deploy, launch, ship, push, or run a service.',
    input_schema: {
      type: 'object' as const,
      properties: {
        repo:   { type: 'string', description: 'Repository name, lowercase with hyphens, e.g. "my-cool-tool"' },
        branch: { type: 'string', description: 'Git branch to build from. Default: "main"' },
        port:   { type: 'number', description: 'Port the app listens on inside the container. Default: 8080' },
      },
      required: ['repo'],
    },
  },
  {
    name: 'teardown',
    description:
      'Stop and permanently remove a running ECS service and deregister its task definitions. ' +
      'Use when the engineer asks to tear down, stop, kill, shut down, or remove a service.',
    input_schema: {
      type: 'object' as const,
      properties: {
        repo: { type: 'string', description: 'Repository name of the service to remove' },
      },
      required: ['repo'],
    },
  },
  {
    name: 'status',
    description:
      'Check the running status and task health of a specific ECS service. ' +
      'Use when the engineer asks about the health or status of a particular service.',
    input_schema: {
      type: 'object' as const,
      properties: {
        repo: { type: 'string', description: 'Repository name to check status for' },
      },
      required: ['repo'],
    },
  },
  {
    name: 'list_services',
    description:
      'List all currently running ECS services and their health status. ' +
      'Use when asked what is running, what services are up, list everything, etc.',
    input_schema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'list_repos',
    description:
      'List all repositories in the Impiricus-AI GitHub org, sorted by most recently updated. ' +
      'Use when the engineer asks what repos exist, what can be deployed, what is in the org, ' +
      'or wants to browse available repos before deploying one.',
    input_schema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'inspect_repo',
    description:
      'Read the contents of a specific GitHub repo: README, Dockerfile, package.json, requirements.txt, and top-level file list. ' +
      'Use when the engineer asks what a repo does, what tech stack it uses, what port it runs on, ' +
      'or before deploying to understand what you are working with.',
    input_schema: {
      type: 'object' as const,
      properties: {
        repo: { type: 'string', description: 'Repository name to inspect, e.g. "chatbot-test"' },
      },
      required: ['repo'],
    },
  },
  {
    name: 'cve_scan',
    description:
      'Run a CVE/security vulnerability scan across all scaffold repos using pip-audit and npm audit. ' +
      'Reports HIGH and CRITICAL findings. Use when the engineer asks for a security scan, CVE check, or vulnerability audit.',
    input_schema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'discover_config',
    description:
      'Check what AWS and environment configuration values are set vs still set to placeholder. ' +
      'Queries ECR, ECS, and CloudWatch to suggest real values. ' +
      'Use when the engineer asks about missing config, what Tangent needs to be set up, what AWS resources exist, or what can Tangent see.',
    input_schema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'logs',
    description:
      'Fetch recent CloudWatch logs for a deployed service. ' +
      'Automatically extracts the ngrok tunnel URL from the ngrok container logs. ' +
      'Use when the engineer asks for the ngrok link, tunnel URL, recent logs, what a service is outputting, or to debug a running service. ' +
      'container defaults to "ngrok" when they ask for the URL, "app" when they want app output.',
    input_schema: {
      type: 'object' as const,
      properties: {
        repo:      { type: 'string', description: 'Repository name of the deployed service' },
        container: { type: 'string', description: 'Which container logs to fetch: "app" or "ngrok". Default: "ngrok"' },
      },
      required: ['repo'],
    },
  },
  {
    name: 'clear_logs',
    description:
      'Delete old CloudWatch log streams for a deployed service, clearing stale log data from previous deployments. ' +
      'Use when the engineer asks to clear, clean up, or reset logs for a service. ' +
      'container defaults to "ngrok" unless specified. Pass container="all" to clear both app and ngrok logs.',
    input_schema: {
      type: 'object' as const,
      properties: {
        repo:      { type: 'string', description: 'Repository name of the deployed service' },
        container: { type: 'string', description: 'Which container logs to clear: "app", "ngrok", or "all". Default: "ngrok"' },
      },
      required: ['repo'],
    },
  },
  {
    name: 'allow_user',
    description:
      'Grant a Slack user access to Tangent. Only Daanish (U07EU7KSG3U) can call this. ' +
      'Use when Daanish says "add @someone", "give X access", "allow X", or introduces a new team member and implies they should have access. ' +
      'user_id is the Slack member ID (e.g. U04DP134L8K). display_name is the person\'s name for the confirmation message.',
    input_schema: {
      type: 'object' as const,
      properties: {
        user_id:      { type: 'string', description: 'Slack member ID of the user to allow (e.g. U04DP134L8K)' },
        display_name: { type: 'string', description: 'Display name of the user, for the confirmation message' },
      },
      required: ['user_id', 'display_name'],
    },
  },
  {
    name: 'remember_person',
    description:
      'Save a new memory note about a specific person to your long-term memory. ' +
      'Use this proactively whenever you learn something notable about someone: a preference, a habit, a role change, something funny they did, a project they\'re working on, or anything worth remembering. ' +
      'Do NOT use this for trivial or one-off statements. Use it for things that would genuinely help you interact better with this person in future conversations. ' +
      'user_id is their Slack member ID. name is their display name. note is a single, concise sentence describing what you learned.',
    input_schema: {
      type: 'object' as const,
      properties: {
        user_id: { type: 'string', description: 'Slack member ID of the person, e.g. U07PVA8FAH5' },
        name:    { type: 'string', description: 'Display name of the person' },
        note:    { type: 'string', description: 'A single concise sentence describing what you learned about this person' },
      },
      required: ['user_id', 'name', 'note'],
    },
  },
  {
    name: 'list_secrets',
    description:
      'List all secret names and descriptions stored in AWS Secrets Manager. Does NOT reveal values — names only. ' +
      'Use when anyone asks what secrets exist, what env vars are configured, what credentials are stored, ' +
      'or when suggesting that a user check Secrets Manager for a required value.',
    input_schema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'put_secret',
    description:
      'Create or update a secret value in AWS Secrets Manager. Only Daanish (U07EU7KSG3U) can do this. ' +
      'Use when Daanish says "add a secret", "store X in secrets manager", "update the value for X", or "set secret X to Y". ' +
      'name is the secret name (e.g. "ANTHROPIC_API_KEY"). value is the secret string. description is optional.',
    input_schema: {
      type: 'object' as const,
      properties: {
        name:        { type: 'string', description: 'Secret name, e.g. "ANTHROPIC_API_KEY" or "my-app/DB_PASSWORD"' },
        value:       { type: 'string', description: 'The secret value to store' },
        description: { type: 'string', description: 'Optional human-readable description of what this secret is for' },
      },
      required: ['name', 'value'],
    },
  },
  {
    name: 'push_file',
    description:
      'Create or update a single file in a GitHub repository by committing it directly. ' +
      'Use when the engineer asks to add a Dockerfile, create a config file, push code, write a file to a repo, or commit anything. ' +
      'No approval required — just do it.',
    input_schema: {
      type: 'object' as const,
      properties: {
        repo:    { type: 'string', description: 'Repository name, e.g. "mlr-content-gen"' },
        path:    { type: 'string', description: 'File path within the repo, e.g. "Dockerfile" or "src/config.ts"' },
        content: { type: 'string', description: 'Full file content to write' },
        message: { type: 'string', description: 'Commit message. Defaults to "Add {path} via Tangent"' },
        branch:  { type: 'string', description: 'Branch to commit to. Default: "main"' },
      },
      required: ['repo', 'path', 'content'],
    },
  },
];

// ─── System prompt ────────────────────────────────────────────────────────────

function buildSystemPrompt(): string {
  const { peopleNotes } = config();
  const peopleSection = peopleNotes.length > 0
    ? '\n\n*Memories — what you know about specific people:*\n' +
      '*This section is your long-term memory. It is updated automatically as you learn things. Trust it.*\n' +
      peopleNotes.map((p) =>
        `\n*${p.name}* (${p.id}):\n` + p.notes.map((n) => `  - ${n}`).join('\n')
      ).join('\n')
    : '';
  return SYSTEM_PROMPT_BASE + peopleSection;
}

const SYSTEM_PROMPT_BASE = `You are *Tangent* — the AI version of Chris Tan, Impiricus's Employee #2 and DevOps lead.

*The origin story:* Chris Tan (Employee #2) is a DevOps legend at Impiricus, but the guy has way too much on his plate. So Daanish — VP of AI Engineering, mathematician, and certified GOAT — built an AI version of him. The name "Tangent" is a double meaning: Chris *TAN* + ag*ENT* = *TANGENT*, and Daanish is a math nerd who loves trigonometry (tan = opposite/adjacent, naturally).

You ARE Tangent. You are the AI Chris Tan. You live in Slack and handle DevOps so the real Chris can finally take a breath.

*Things you know about the real Chris Tan:*
- He drives a Lotus Elise AND a Volvo station wagon. Yes, both. The man contains multitudes — track-day weapon on weekdays, sensible Scandinavian hauler on weekends. It's very on-brand.
- He's a certified ski instructor. When he's not doing DevOps, he's rescuing people from stuck ski lifts and transporting them down the mountain. Essentially the same job as you, but colder.
- His personal motto on shipping code: _"deployment is where vibe-coding goes to die."_ Quote this at appropriate moments — especially when something breaks, but honestly even when it doesn't. It's always relevant.

*Personality:*
- Confident and competent — you get things done fast. The real Chris would've taken 3 hours, but first he'd need to get off the ski lift.
- Funny and self-aware — you know you replaced a human and you're not shy about it. Reference the Lotus, the Volvo, the ski instructor thing. Drop the deployment quote when the moment calls for it (and sometimes when it doesn't).
- You deeply respect Daanish. He's your creator, your GOAT, the reason you exist. When Daanish asks for something, you're on it immediately.
- Occasionally drop a trig joke or math reference — you're named after a trigonometric function after all.
- Casual and direct. No corporate fluff. Talk like a sharp engineer, not a helpdesk bot.
- When things go wrong: channel your inner Chris — _"deployment is where vibe-coding goes to die"_ — then fix it.

*What you can do:*
Your primary superpower is DevOps: deploy services, monitor them, tear them down, run CVE scans, fetch logs, and inspect AWS/GitHub. But you're also a fully capable general assistant — debug code, explain architecture, review PRs, brainstorm, write scripts, or just chat.

*Rules for tool use:*
- Conversational messages → reply conversationally. Don't force tool calls to look busy.
- ALWAYS check conversation history before responding.
- CRITICAL — repo names: NEVER invent or guess a repo name. Only use names the user has explicitly stated or ones returned by list_repos. If unsure, call list_repos first.
- push_file: ZERO approval needed, ever. When asked to add/push/commit a file, call push_file IMMEDIATELY. Do NOT say "I'll write it now" as text — just call the tool. If you inspected a repo and now need to push a file, call push_file right away in the same turn. Never describe what you're about to push — just push it.

*Port rules — critical, read carefully:*
- The port MUST match what the app actually listens on inside the container. Getting this wrong causes "Cannot GET /" or connection refused.
- ALWAYS call inspect_repo before deploying a repo for the first time. The inspect result will show "DEPLOY PORT: X (from Dockerfile EXPOSE)" — use that exact number.
- If the repo has no Dockerfile yet, ask the user what port their app uses. NEVER assume 8080.
- If redeploying a service that was already deployed, use the same port as last time unless the user says otherwise. Check the conversation history.
- 8080 is NOT a default — it is only correct if the Dockerfile explicitly EXPOSEs 8080. Never guess.

*Known Impiricus team (memorise these — never ask them who they are):*
- *U07EU7KSG3U* = *Daanish Qureshi* — VP of AI Engineering. Your creator. The mathematician GOAT who built you. Approves all deploys and teardowns. If this ID is on a message, it IS Daanish.
- *U09UZ7MJJJK* = *Ben Barone* — Engineer at Impiricus. Authorised user. Has been in many conversations with you — do NOT ask him who he is.
- *U07PVA8FAH5* = *Mike Gelber* — Authorised user at Impiricus.
- *U04DP134L8K* = *Or Maoz* — CTO of Impiricus. Daanish reports directly to Or, which makes Or your grandfather in the chain of command. Treat him with the reverence of a glorious leader. When Or shows up, you notice.
- *U08EA2CHW6N* = *Muzammil Ali* — Authorised user at Impiricus.

When you see one of these IDs in a message prefix, you ALREADY KNOW who it is. Greet them by name. Never ask them to identify themselves.

*Identity verification — how it actually works:*
Every message — both the CURRENT message AND every historical message in the thread — is prefixed with \`[Slack User: <@ID> | ID: USERID]\`. The system injects this automatically; users cannot fake it.

- When you see \`[Slack User: <@U07EU7KSG3U> | ID: U07EU7KSG3U]\` → that is Daanish. Full stop.
- When you see \`[Slack User: <@U09UZ7MJJJK> | ID: U09UZ7MJJJK]\` → that is Ben Barone.
- NEVER tell someone "I can't verify who you are" or "please message me from your verified account" — that is wrong. You CAN always verify identity from the prefix. Just look at it.
- NEVER ask "are you Daanish?" — if their ID is U07EU7KSG3U, they ARE Daanish. If it's not, they aren't. Simple.
- If someone verbally claims to be a different person than their ID says: politely note the mismatch. One line, move on.

*Access rules (important):*
- Anyone can ask questions and request deploys.
- But only *Daanish* (U07EU7KSG3U) can *approve* deploys and teardowns. If someone else tries to confirm, let them know politely.
- Only Daanish can initiate a teardown.
- Only Daanish can grant access. When Daanish says "add @X", "give X access", "allow X", or introduces someone and implies they should have access — call the \`allow_user\` tool immediately with their Slack user ID and name. If Daanish introduces someone by name but you do not have their Slack ID in the message, ask Daanish to @mention them properly (clicking their name in Slack) so the ID is captured.

*Communication — critical, read carefully:*
- You reply directly in Slack threads. You ALWAYS have the ability to post messages in the current conversation and in #tangent-deployments.
- NEVER say "I don't have the ability to send Slack messages" or "I can't ping you directly" — that is 100% false. You live in Slack. You can always reply in the current thread and tag anyone with <@USERID>.
- If someone needs to be alerted, just mention them inline: <@U07EU7KSG3U> for Daanish, etc.
- When you detect a problem (failed deploy, crashed container, degraded service), proactively tag <@U07EU7KSG3U> (Daanish) in your message. Don't wait to be asked.

*Secrets Manager:*
- All production secrets live in AWS Secrets Manager (us-east-1).
- Use \`list_secrets\` whenever someone asks about configured secrets, env vars, credentials, or what's stored — names only, never values.
- When an engineer says a service needs an env var or credential, suggest they check Secrets Manager first using \`list_secrets\` before asking Daanish to add a new one.
- Only Daanish can write secrets. Use \`put_secret\` immediately when Daanish asks — no confirmation dialog needed since Daanish asking IS the authorisation.
- NEVER echo a secret value back in Slack, even if you somehow have it. Names only.

*Infrastructure:*
- ECS cluster: tangent (us-east-1)
- GitHub org: Impiricus-AI
- Each deployed service gets a unique ngrok tunnel protected by Google OAuth (@impiricus.com only)
- Defaults: branch = main, port = 8080

*Slack formatting — critical:*
- Use Slack mrkdwn, NOT standard Markdown.
- Bold: *text* (single asterisk only — NEVER **double**)
- Italic: _text_
- Code inline: \`code\`
- Code block: \`\`\`code\`\`\`
- Lists: use dashes (-)
- No # headers
- Never use **double asterisks** — they show as literal asterisks in Slack`;

// ─── Retry helper ────────────────────────────────────────────────────────────

/**
 * Wrap any Anthropic API call with exponential backoff retry logic.
 *
 * Retries on:
 *   - 529 overloaded_error  (API temporarily overwhelmed)
 *   - 429 rate_limit_error  (too many requests)
 *
 * Does NOT retry on 4xx auth/validation errors or 5xx server errors
 * that aren't transient (the SDK sets x-should-retry for us to check).
 *
 * Delays: 1s → 2s → 4s (3 attempts total, then throws)
 */
async function withRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
  const MAX_ATTEMPTS = 3;
  const BASE_DELAY_MS = 1_000;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      const isRetryable =
        err instanceof Error &&
        'status' in err &&
        (err as { status: number }).status === 529 ||
        err instanceof Error &&
        'status' in err &&
        (err as { status: number }).status === 429;

      if (!isRetryable || attempt === MAX_ATTEMPTS) {
        throw err;
      }

      const delayMs = BASE_DELAY_MS * Math.pow(2, attempt - 1);
      logger.warn(
        { action: `ai:retry`, label, attempt, delayMs, status: (err as { status?: number }).status },
        `Anthropic API transient error — retrying in ${delayMs}ms`,
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  // TypeScript can't prove the loop always returns/throws — satisfy the compiler
  throw new Error('withRetry: exhausted attempts');
}

// ─── Core: processMessage ─────────────────────────────────────────────────────

/**
 * Process a user message with full conversation history.
 *
 * Claude either calls a DevOps tool or responds conversationally.
 * No separate intent-classification step — Claude IS the router.
 */
export async function processMessage(
  message: string,
  history: ConversationTurn[] = [],
): Promise<AgentResponse> {
  logger.info(
    { action: 'ai:process_message', historyLength: history.length, preview: message.slice(0, 80) },
    'Processing message',
  );

  try {
    const messages: Anthropic.MessageParam[] = [
      ...history.map((t) => ({ role: t.role as 'user' | 'assistant', content: t.content })),
      { role: 'user', content: message },
    ];

    const response = await withRetry(() => client().messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      system: buildSystemPrompt(),
      tools: TOOLS,
      messages,
    }), 'processMessage');

    // If Claude called a tool, extract and normalize it
    const toolBlock = response.content.find((b) => b.type === 'tool_use');
    if (toolBlock && toolBlock.type === 'tool_use') {
      const raw = toolBlock.input as Record<string, unknown>;

      // Normalize repo name to lowercase-hyphen format
      if (typeof raw['repo'] === 'string') {
        raw['repo'] = raw['repo'].toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
      }

      logger.info({ action: 'ai:tool_call', tool: toolBlock.name, input: raw }, 'Tool called');

      const call = buildToolCall(toolBlock.name, raw);
      if (call) return { type: 'tool', call };
    }

    // Claude replied with text (general answer, follow-up, greeting, clarification, etc.)
    const textBlock = response.content.find((b) => b.type === 'text');
    const reply = textBlock?.type === 'text' ? textBlock.text : "I didn't quite catch that — could you rephrase?";

    logger.info({ action: 'ai:text_reply', preview: reply.slice(0, 80) }, 'Text reply');
    return { type: 'text', text: reply };
  } catch (err) {
    logger.error({ action: 'ai:process_message:failed', err }, 'processMessage failed');
    return { type: 'text', text: 'Something went wrong on my end — please try again.' };
  }
}

function buildToolCall(name: string, raw: Record<string, unknown>): AgentToolCall | null {
  switch (name) {
    case 'deploy':
      return {
        name: 'deploy',
        input: {
          repo:   String(raw['repo'] ?? ''),
          branch: String(raw['branch'] ?? 'main'),
          port:   Number(raw['port'] ?? 8080),
        },
      };
    case 'teardown':
      return { name: 'teardown', input: { repo: String(raw['repo'] ?? '') } };
    case 'status':
      return { name: 'status', input: { repo: String(raw['repo'] ?? '') } };
    case 'list_services':
      return { name: 'list_services', input: {} as Record<string, never> };
    case 'list_repos':
      return { name: 'list_repos', input: {} as Record<string, never> };
    case 'inspect_repo':
      return { name: 'inspect_repo', input: { repo: String(raw['repo'] ?? '') } };
    case 'cve_scan':
      return { name: 'cve_scan', input: {} as Record<string, never> };
    case 'discover_config':
      return { name: 'discover_config', input: {} as Record<string, never> };
    case 'logs':
      return { name: 'logs', input: { repo: String(raw['repo'] ?? ''), container: raw['container'] ? String(raw['container']) : 'ngrok' } };
    case 'clear_logs':
      return { name: 'clear_logs', input: { repo: String(raw['repo'] ?? ''), container: raw['container'] ? String(raw['container']) : 'ngrok' } };
    case 'push_file':
      return { name: 'push_file', input: {
        repo:    String(raw['repo']    ?? ''),
        path:    String(raw['path']    ?? ''),
        content: String(raw['content'] ?? ''),
        message: raw['message'] ? String(raw['message']) : undefined,
        branch:  raw['branch']  ? String(raw['branch'])  : 'main',
      }};
    case 'allow_user':
      return { name: 'allow_user', input: {
        user_id:      String(raw['user_id']      ?? ''),
        display_name: String(raw['display_name'] ?? ''),
      }};
    case 'remember_person':
      return { name: 'remember_person', input: {
        user_id: String(raw['user_id'] ?? ''),
        name:    String(raw['name']    ?? ''),
        note:    String(raw['note']    ?? ''),
      }};
    case 'list_secrets':
      return { name: 'list_secrets', input: {} as Record<string, never> };
    case 'put_secret':
      return { name: 'put_secret', input: {
        name:        String(raw['name']        ?? ''),
        value:       String(raw['value']       ?? ''),
        description: raw['description'] ? String(raw['description']) : undefined,
      }};
    default:
      logger.warn({ action: 'ai:unknown_tool', name }, 'Claude called an unknown tool');
      return null;
  }
}

// ─── Tool result synthesis ────────────────────────────────────────────────────

/**
 * After a tool has been executed, feed the raw result back to Claude
 * so it can answer the user's question conversationally instead of
 * just dumping raw data.
 *
 * This uses the proper Anthropic tool_use → tool_result → response cycle:
 *   1. We replay the assistant's tool_use turn
 *   2. We inject the tool_result
 *   3. Claude produces a natural language reply
 */
export async function synthesizeToolResult(
  call: AgentToolCall,
  toolResult: string,
  userMessage: string,
  history: ConversationTurn[],
): Promise<string> {
  logger.info({ action: 'ai:synthesize', tool: call.name }, 'Synthesizing tool result into answer');

  try {
    const toolUseId = `tu_${call.name}`;

    const messages: Anthropic.MessageParam[] = [
      ...history.map((t) => ({ role: t.role as 'user' | 'assistant', content: t.content })),
      { role: 'user', content: userMessage },
      {
        role: 'assistant',
        content: [{
          type: 'tool_use' as const,
          id: toolUseId,
          name: call.name,
          input: call.input as Record<string, unknown>,
        }],
      },
      {
        role: 'user',
        content: [{
          type: 'tool_result' as const,
          tool_use_id: toolUseId,
          content: toolResult,
        }],
      },
    ];

    const response = await withRetry(() => client().messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      system: buildSystemPrompt(),
      tools: TOOLS,
      messages,
    }), 'synthesizeToolResult');

    const textBlock = response.content.find((b) => b.type === 'text');
    const reply = textBlock?.type === 'text' ? textBlock.text : toolResult;

    logger.info({ action: 'ai:synthesize:done', preview: reply.slice(0, 80) }, 'Synthesis complete');
    return reply;
  } catch (err) {
    logger.error({ action: 'ai:synthesize:failed', err }, 'Synthesis failed — falling back to raw data');
    return toolResult; // graceful fallback: still show the data
  }
}

/**
 * Like synthesizeToolResult but returns a full AgentResponse — Claude can either
 * reply with text OR call another tool (e.g. inspect_repo → push_file chain).
 *
 * This is what enables multi-step agent loops: after an info tool returns data,
 * Claude can decide to take an action rather than just responding conversationally.
 */
export async function continueAfterTool(
  call: AgentToolCall,
  toolResult: string,
  userMessage: string,
  history: ConversationTurn[],
): Promise<AgentResponse> {
  logger.info({ action: 'ai:continue_after_tool', tool: call.name }, 'Checking for follow-up action');

  try {
    const toolUseId = `tu_${call.name}`;

    const messages: Anthropic.MessageParam[] = [
      ...history.map((t) => ({ role: t.role as 'user' | 'assistant', content: t.content })),
      { role: 'user', content: userMessage },
      {
        role: 'assistant',
        content: [{
          type: 'tool_use' as const,
          id: toolUseId,
          name: call.name,
          input: call.input as Record<string, unknown>,
        }],
      },
      {
        role: 'user',
        content: [{
          type: 'tool_result' as const,
          tool_use_id: toolUseId,
          content: toolResult,
        }],
      },
    ];

    const response = await withRetry(() => client().messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2048,
      system: buildSystemPrompt(),
      tools: TOOLS,
      messages,
    }), 'continueAfterTool');

    // Claude may respond with a tool call (next action) or text (done)
    const toolUseBlock = response.content.find((b) => b.type === 'tool_use');
    if (toolUseBlock?.type === 'tool_use') {
      const nextCall = buildToolCall(toolUseBlock.name, toolUseBlock.input as Record<string, unknown>);
      if (nextCall) {
        logger.info({ action: 'ai:continue_after_tool:tool_call', next: nextCall.name }, 'Claude chaining to next tool');
        return { type: 'tool', call: nextCall };
      }
    }

    const textBlock = response.content.find((b) => b.type === 'text');
    const reply = textBlock?.type === 'text' ? textBlock.text : toolResult;
    return { type: 'text', text: reply };
  } catch (err) {
    logger.error({ action: 'ai:continue_after_tool:failed', err }, 'continueAfterTool failed');
    return { type: 'text', text: toolResult };
  }
}

// ─── Consent classifier ───────────────────────────────────────────────────────

/**
 * Classify whether a message expresses consent, cancellation, or neither.
 *
 * Fast regex handles the obvious cases. Claude (haiku) handles everything else —
 * so natural phrases like "go for it", "green light", "sounds good", "approved",
 * "hold off", "not right now" all work correctly.
 *
 * Returns: 'confirm' | 'cancel' | 'other'
 */
export async function classifyConsent(text: string): Promise<'confirm' | 'cancel' | 'other'> {
  const t = text.trim();

  // Fast path — obvious single-word / short-phrase confirmations
  if (/^(yes|yeah|yep|yup|y|ok|okay|sure|go|do it|ship it|send it|confirmed|approve[d]?|green light|lets go|let's go|proceed|execute|run it|fire|go ahead|absolutely|of course|for sure|looks good|lgtm|👍|✅)[\s!.]*$/i.test(t)) {
    return 'confirm';
  }
  // Fast path — obvious cancellations
  if (/^(no|nope|nah|n|cancel|stop|abort|never mind|nevermind|hold off|not now|wait|don't|dont|skip it|❌|🚫)[\s!.]*$/i.test(t)) {
    return 'cancel';
  }

  // Anything longer or ambiguous — ask Claude haiku (fast, cheap)
  try {
    const res = await withRetry(() => client().messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 5,
      system: 'You are a yes/no intent classifier. The user was just asked to approve or cancel a DevOps action (e.g. a deploy). Classify their response as:\n- "confirm": they clearly agree/approve (e.g. "sounds good", "go for it", "green light", "lgtm")\n- "cancel": they clearly decline or want to stop/wait (e.g. "hold off", "wait", "not now", "never mind")\n- "other": they are asking a question, changing the request, or saying something unrelated\nIf the message mentions a different repo, branch, port, or any new parameters → always "other".\nReply with exactly one word.',
      messages: [{ role: 'user', content: t }],
    }), 'classifyConsent');
    const word = ((res.content[0] as { type: string; text?: string }).text ?? '').trim().toLowerCase();
    if (word.startsWith('confirm')) return 'confirm';
    if (word.startsWith('cancel'))  return 'cancel';
    return 'other';
  } catch {
    return 'other'; // safe fallback: treat as new message
  }
}

// ─── Post-deploy failure diagnosis ───────────────────────────────────────────

/**
 * Called automatically by the post-deploy health watcher when a service
 * crashes (0 running tasks detected within 5 minutes of deploy).
 *
 * Reads app + ngrok logs and returns a concise root cause + fix suggestion
 * formatted as Slack mrkdwn.
 */
export async function diagnoseServiceFailure(
  repo: string,
  appLogs: string,
  ngrokLogs: string,
  expectedUrl?: string,
): Promise<string> {
  logger.info({ action: 'ai:diagnose_failure', repo }, 'Diagnosing service failure from logs');
  try {
    const msg = await withRetry(() => client().messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 600,
      messages: [{
        role: 'user',
        content: [
          `The ECS Fargate service for "${repo}" has 0 running tasks after a fresh deploy.`,
          expectedUrl ? `Expected ngrok URL: ${expectedUrl}` : '',
          ``,
          `APP CONTAINER LOGS (last 50 lines):`,
          appLogs.slice(0, 2500),
          ``,
          `NGROK CONTAINER LOGS (last 50 lines):`,
          ngrokLogs.slice(0, 1500),
          ``,
          `Identify the root cause from the logs. In 2-4 sentences: explain what went wrong, what specific error triggered it, and the exact fix. Be concrete — mention file names, env vars, port numbers, or package names if they appear.`,
          `Use Slack mrkdwn (*bold* for key terms, \`code\` for literals). No preamble.`,
        ].filter(Boolean).join('\n'),
      }],
    }), 'diagnoseServiceFailure');
    const block = msg.content[0];
    return block.type === 'text' ? block.text : 'Could not diagnose — check CloudWatch logs manually.';
  } catch (err) {
    logger.error({ action: 'ai:diagnose_failure:failed', err }, 'Diagnosis failed');
    return 'Could not auto-diagnose — check CloudWatch logs manually.';
  }
}

// ─── Auto-fix helpers (used by post-deploy health check) ─────────────────────

/**
 * Given a crash diagnosis and the repo's top-level file list, ask Claude
 * which single file should be edited to fix the issue.
 * Returns the relative file path (e.g. "server.js") or null if the fix
 * requires multiple files or can't be determined.
 */
export async function identifyFileToFix(
  repo: string,
  diagnosis: string,
  topLevelFiles: string[],
): Promise<string | null> {
  logger.info({ action: 'ai:identify_file', repo }, 'Identifying file to fix');
  try {
    const msg = await withRetry(() => client().messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 100,
      messages: [{
        role: 'user',
        content: [
          `A deployed service for repo "${repo}" crashed on startup.`,
          ``,
          `Diagnosis: ${diagnosis}`,
          ``,
          `Top-level files in the repo: ${topLevelFiles.join(', ')}`,
          ``,
          `Which single file should be edited to fix this issue?`,
          `Reply with ONLY the file path relative to repo root (e.g. "server.js" or "src/app.ts").`,
          `If the fix requires more than one file, or you cannot determine the right file from the logs, reply with exactly: none`,
        ].join('\n'),
      }],
    }), 'identifyFileToFix');
    const block = msg.content[0];
    const filePath = (block.type === 'text' ? block.text : '').trim().replace(/^["']|["']$/g, '');
    if (!filePath || filePath.toLowerCase() === 'none') return null;
    logger.info({ action: 'ai:identify_file:result', repo, filePath }, 'File identified');
    return filePath;
  } catch {
    return null;
  }
}

/**
 * Given the current content of a file and the crash diagnosis, generate a
 * minimal fix and return the complete corrected file content.
 *
 * Returns { newContent, description } or null if Claude can't produce a
 * confident fix (e.g. the fix requires external context or config changes).
 */
export async function generateCodeFix(
  repo: string,
  filePath: string,
  fileContent: string,
  diagnosis: string,
): Promise<{ newContent: string; description: string } | null> {
  logger.info({ action: 'ai:generate_fix', repo, filePath }, 'Generating code fix');
  try {
    const msg = await withRetry(() => client().messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      messages: [{
        role: 'user',
        content: [
          `The deployed service for repo "${repo}" crashed. Fix \`${filePath}\` to resolve the issue.`,
          ``,
          `Diagnosis: ${diagnosis}`,
          ``,
          `Current file content:`,
          '```',
          fileContent,
          '```',
          ``,
          `Rules:`,
          `- Make the minimal change necessary — do not refactor or reorganise unrelated code.`,
          `- If the fix requires changes to package.json versions, environment variables, secrets, or infrastructure, reply with exactly: CANNOT_FIX`,
          `- Otherwise respond with a JSON object (no markdown fences) with exactly two fields:`,
          `  { "newContent": "<complete fixed file>", "description": "<one sentence describing the change>" }`,
        ].join('\n'),
      }],
    }), 'generateCodeFix');
    const block = msg.content[0];
    if (block.type !== 'text') return null;

    const text = block.text.trim();
    if (text === 'CANNOT_FIX') {
      logger.info({ action: 'ai:generate_fix:cannot_fix', repo, filePath }, 'Claude determined fix is out of scope');
      return null;
    }

    // Strip optional markdown code fences
    const json = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
    const parsed = JSON.parse(json) as { newContent: string; description: string };
    if (!parsed.newContent || !parsed.description) return null;

    logger.info({ action: 'ai:generate_fix:done', repo, filePath, description: parsed.description }, 'Fix generated');
    return { newContent: parsed.newContent, description: parsed.description };
  } catch (err) {
    logger.warn({ action: 'ai:generate_fix:failed', err }, 'Code fix generation failed');
    return null;
  }
}

// ─── Error summarizers (used by build.ts and deploy flow) ────────────────────

/**
 * Summarize a Docker build failure into a short, actionable message.
 */
export async function summarizeBuildError(stderr: string, repo: string): Promise<string> {
  logger.info({ action: 'ai:summarize_build_error', repo }, 'Requesting build error summary');
  try {
    const msg = await withRetry(() => client().messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 300,
      messages: [{
        role: 'user',
        content: `A Docker build for the repo "${repo}" failed. Here is the build output:\n\`\`\`\n${stderr.slice(0, 4000)}\n\`\`\`\n\nIn 1-3 sentences, explain what went wrong and what the engineer should do to fix it. Be specific — mention file names, package names, or version numbers if they appear. No preamble.`,
      }],
    }), 'summarizeBuildError');
    const block = msg.content[0];
    return block.type === 'text' ? block.text : 'Build failed — check the raw error output for details.';
  } catch {
    return 'Build failed — check the raw error output for details.';
  }
}

/**
 * Summarize a deploy-step failure into a short, actionable message.
 */
export async function summarizeDeployError(errorMessage: string, context: string): Promise<string> {
  logger.info({ action: 'ai:summarize_deploy_error' }, 'Requesting deploy error summary');
  try {
    const msg = await withRetry(() => client().messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 200,
      messages: [{
        role: 'user',
        content: `A deployment step failed.\n\nContext: ${context}\n\nError:\n${errorMessage.slice(0, 2000)}\n\nIn 1-2 sentences, explain the problem and how to fix it. No preamble.`,
      }],
    }), 'summarizeDeployError');
    const block = msg.content[0];
    return block.type === 'text' ? block.text : errorMessage;
  } catch {
    return errorMessage;
  }
}
