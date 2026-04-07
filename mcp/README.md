# tangent-mcp

MCP server for [Tangent](https://github.com/Impiricus-AI/tangent) — deploy and manage Impiricus services directly from Claude Code or Cursor.

## What it does

Exposes 8 tools to your AI IDE:

| Tool | Description |
|------|-------------|
| `deploy` | Deploy a GitHub repo to ECS Fargate with an ngrok tunnel |
| `teardown` | Stop a running ECS service |
| `status` | Check the health of a deployed service |
| `logs` | Fetch recent CloudWatch logs |
| `list_services` | List all running ECS services |
| `list_repos` | List all repos in the Impiricus-AI org |
| `inspect_repo` | Read a repo's README, Dockerfile, and file list |
| `push_file` | Commit a file directly to a GitHub repo |

`deploy` and `teardown` require Daanish's approval in Slack. Everything else runs immediately.

## How it works

The MCP server runs locally on your machine. When you call a tool, it posts a natural-language command to the `#tangent-mcp` Slack channel, @mentioning Tangent. Tangent (running on EC2 via Socket Mode) processes the command and replies in-thread. The MCP server polls the thread and returns the result to your IDE.

No ports are opened on EC2.

## Setup

### 1. Clone the repo

```bash
git clone https://github.com/Impiricus-AI/tangent-mcp.git ~/Documents/tangent-mcp
cd ~/Documents/tangent-mcp
```

### 2. Install and build

```bash
npm install
npm run build
```

### 3. Get your credentials

You need two values — ask Daanish for the bot token, the rest you find yourself.

**`SLACK_USER_TOKEN`** — The shared Tangent bot token (`xoxb-...`)
- Ask Daanish for this. It's one token for the whole workspace.

**`SLACK_CALLER_ID`** — Your personal Slack member ID
1. Open Slack, click your name/avatar in the top-left
2. Click **Profile** → **More** (three dots) → **Copy member ID**
3. It looks like `U07EU7KSG3U`

`TANGENT_BOT_USER_ID` is already hardcoded — you don't need to set it.

### 4. Add to Claude Code

Open `~/.claude/mcp.json` (create it if it doesn't exist) and add:

```json
{
  "mcpServers": {
    "tangent": {
      "command": "node",
      "args": ["/Users/YOUR_USERNAME/Documents/tangent-mcp/dist/index.js"],
      "env": {
        "SLACK_USER_TOKEN": "xoxb-the-token-daanish-gave-you",
        "SLACK_CALLER_ID": "U-your-own-member-id"
      }
    }
  }
}
```

Replace `YOUR_USERNAME` with your macOS username (`echo $USER` in terminal).

Restart Claude Code. You should see the Tangent tools available.

### Add to Cursor

Open Cursor settings → **MCP** → add a new server with the same `command`, `args`, and `env` as above.

## Usage examples

Once configured, just ask Claude Code or Cursor naturally:

- *"Deploy the chatbot-test repo"*
- *"What's the status of my-api?"*
- *"Show me the logs for chatbot-test"*
- *"Tear down my-api"*
- *"Push this Dockerfile to chatbot-test"*

Claude will call the appropriate Tangent tool automatically.

## Troubleshooting

**"TANGENT_BOT_USER_ID is required"** — Make sure you set the env var in your MCP config. It's Tangent's Slack member ID, not the app ID.

**Timed out** — Check `#tangent-mcp` in Slack. Deploy and teardown require Daanish's approval, so they can take up to 3 minutes.

**"SLACK_CALLER_ID is required"** — Make sure you set `SLACK_CALLER_ID` to your own Slack member ID in the MCP config.
