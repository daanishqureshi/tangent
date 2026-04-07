#!/usr/bin/env node
/**
 * mcp/src/index.ts
 *
 * Tangent MCP Server — stdio transport, runs locally on the developer's machine.
 *
 * Architecture:
 *   Claude Code / Cursor  →  MCP (stdio)  →  this server
 *                                                ↓  Slack Web API (user token)
 *                                          #tangent-mcp channel
 *                                                ↓  app_mention event
 *                                          Tangent on EC2  (no ports opened)
 *                                                ↓  Slack thread reply
 *                                          poll → return result to IDE
 *
 * Each tool posts to #tangent-mcp AS THE DEVELOPER (their own Slack user token),
 * so Tangent sees their real identity and applies the normal access/approval rules.
 * Deploy and teardown still require Daanish to approve in Slack.
 *
 * Setup (add to ~/.claude/mcp.json or Claude Code settings):
 *   {
 *     "mcpServers": {
 *       "tangent": {
 *         "command": "node",
 *         "args": ["/path/to/tangent/mcp/dist/index.js"],
 *         "env": {
 *           "SLACK_USER_TOKEN": "xoxp-...",
 *           "TANGENT_BOT_USER_ID": "U..."
 *         }
 *       }
 *     }
 *   }
 *
 * Required env vars:
 *   SLACK_USER_TOKEN      Tangent bot token (xoxb-...) — ask Daanish
 *   SLACK_CALLER_ID       Your own Slack member ID (e.g. U07EU7KSG3U)
 *
 * Optional env vars:
 *   TANGENT_BOT_USER_ID   Tangent's Slack member ID (default: U0AQCAG3H4P)
 *
 *   TANGENT_MCP_CHANNEL   Slack channel ID (default: C0AR9F0UPJQ = #tangent-mcp)
 */

import { Server }               from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { postAndWait } from './slack.js';

// ─── Tool definitions ─────────────────────────────────────────────────────────

const TOOLS: Tool[] = [
  {
    name: 'deploy',
    description:
      'Deploy a GitHub repo to ECS Fargate with an ngrok tunnel. ' +
      'Tangent will inspect the repo for the correct port automatically. ' +
      'Requires Daanish\'s approval in Slack — he will be pinged in #tangent-mcp.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        repo:   { type: 'string', description: 'Repository name, e.g. "chatbot-test"' },
        branch: { type: 'string', description: 'Git branch (default: main)' },
        port:   { type: 'number', description: 'Port the app listens on — Tangent detects from Dockerfile EXPOSE if omitted' },
      },
      required: ['repo'],
    },
  },
  {
    name: 'teardown',
    description:
      'Stop a running ECS service. Scales it to 0 tasks (preserves the service definition). ' +
      'Requires Daanish\'s approval in Slack.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        repo: { type: 'string', description: 'Repository name of the service to stop' },
      },
      required: ['repo'],
    },
  },
  {
    name: 'status',
    description: 'Check the health and running task count of a deployed ECS service.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        repo: { type: 'string', description: 'Repository name' },
      },
      required: ['repo'],
    },
  },
  {
    name: 'logs',
    description: 'Fetch recent CloudWatch logs for a deployed service.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        repo:      { type: 'string', description: 'Repository name' },
        container: { type: 'string', description: '"app" or "ngrok" (default: app)' },
      },
      required: ['repo'],
    },
  },
  {
    name: 'list_services',
    description: 'List all currently running ECS services and their health.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'list_repos',
    description: 'List all repositories in the Impiricus-AI GitHub org.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'inspect_repo',
    description:
      'Read a GitHub repo\'s README, Dockerfile, package.json, and file list. ' +
      'Returns the detected deploy port from EXPOSE.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        repo: { type: 'string', description: 'Repository name' },
      },
      required: ['repo'],
    },
  },
  {
    name: 'push_file',
    description:
      'Commit a file directly to a GitHub repo. No approval needed — executes immediately.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        repo:    { type: 'string', description: 'Repository name' },
        path:    { type: 'string', description: 'File path in repo, e.g. "Dockerfile" or "src/app.ts"' },
        content: { type: 'string', description: 'Complete file content to write' },
        message: { type: 'string', description: 'Commit message (default: "Add {path} via Tangent")' },
        branch:  { type: 'string', description: 'Branch to commit to (default: main)' },
      },
      required: ['repo', 'path', 'content'],
    },
  },
];

// ─── Command builder ──────────────────────────────────────────────────────────
//
// Convert structured MCP tool input to a natural-language Slack message.
// Tangent's Claude router understands these and routes to the right tool.

function buildCommand(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case 'deploy': {
      const parts = [`deploy ${input['repo']}`];
      if (input['branch']) parts.push(`from branch ${input['branch']}`);
      if (input['port'])   parts.push(`on port ${input['port']}`);
      return parts.join(' ');
    }
    case 'teardown':
      return `tear down ${input['repo']}`;
    case 'status':
      return `what is the status of ${input['repo']}?`;
    case 'logs':
      return `show me the ${input['container'] ?? 'app'} logs for ${input['repo']}`;
    case 'list_services':
      return 'list all running services';
    case 'list_repos':
      return 'list all repos';
    case 'inspect_repo':
      return `inspect the ${input['repo']} repo`;
    case 'push_file': {
      const msg = input['message'] ?? `Add ${input['path']} via Tangent MCP`;
      return [
        `push this file to ${input['repo']} on branch ${input['branch'] ?? 'main'}:`,
        `path: ${input['path']}`,
        `commit message: ${msg}`,
        `content:\n${input['content']}`,
      ].join('\n');
    }
    default:
      return `${name} ${JSON.stringify(input)}`;
  }
}

// ─── Timeout by tool ──────────────────────────────────────────────────────────
//
// Deploy/teardown need up to 3 min (approval + infra ops).
// Everything else should resolve in under 60 seconds.

function timeoutFor(toolName: string): number {
  if (toolName === 'deploy' || toolName === 'teardown') return 3 * 60_000;
  if (toolName === 'push_file') return 60_000;
  return 60_000;
}

// ─── Server ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const server = new Server(
    { name: 'tangent', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const input   = (args ?? {}) as Record<string, unknown>;
    const command = buildCommand(name, input);
    const timeout = timeoutFor(name);

    const result = await postAndWait(command, timeout);

    return {
      content: [{ type: 'text' as const, text: result }],
    };
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  // Log to stderr — stdout is reserved for MCP protocol messages
  console.error('[tangent-mcp] Fatal error:', err);
  process.exit(1);
});
