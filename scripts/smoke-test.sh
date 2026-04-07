#!/usr/bin/env bash
# scripts/smoke-test.sh
#
# Smoke test against a locally-running Tangent server.
# Start the server first:  npm run dev
#
# Usage:
#   bash scripts/smoke-test.sh [BASE_URL]

set -euo pipefail

BASE="${1:-http://127.0.0.1:3000}"
PASS=0
FAIL=0

green() { printf '\033[32m✔ %s\033[0m\n' "$*"; }
red()   { printf '\033[31m✘ %s\033[0m\n' "$*"; }

echo ""
echo "Tangent smoke tests → ${BASE}"
echo "─────────────────────────────────────────────"

# ── GET /health ───────────────────────────────────────────────────────────────
echo ""
echo "[ /health ]"
HEALTH=$(curl -sf "${BASE}/health" 2>/dev/null || echo "CONNECTION_REFUSED")
if echo "$HEALTH" | grep -q '"status":"ok"'; then
  INFO=$(node -e "const d=JSON.parse(process.argv[1]); console.log('ok, uptime='+d.uptime+'s, services='+d.services)" "$HEALTH" 2>/dev/null || echo "$HEALTH")
  green "GET /health → ${INFO}"
  ((PASS++))
else
  red "GET /health → ${HEALTH}"
  ((FAIL++))
  echo ""
  echo "Is the server running?  Run:  npm run dev"
  exit 1
fi

# ── GET /list ─────────────────────────────────────────────────────────────────
echo ""
echo "[ /list ]"
LIST=$(curl -sf "${BASE}/list" 2>/dev/null || echo "{}")
if echo "$LIST" | grep -q '"services"'; then
  COUNT=$(node -e "const d=JSON.parse(process.argv[1]); console.log(d.services.length)" "$LIST" 2>/dev/null || echo "?")
  green "GET /list → ${COUNT} services"
  ((PASS++))
else
  red "GET /list → unexpected response: ${LIST}"
  ((FAIL++))
fi

# ── GET /status/:repo ─────────────────────────────────────────────────────────
echo ""
echo "[ /status/:repo ]"
STATUS=$(curl -sf "${BASE}/status/nonexistent-repo" 2>/dev/null || echo "{}")
if echo "$STATUS" | grep -q '"repo"'; then
  INFO=$(node -e "const d=JSON.parse(process.argv[1]); console.log('status='+d.status)" "$STATUS" 2>/dev/null || echo "$STATUS")
  green "GET /status/nonexistent-repo → ${INFO}"
  ((PASS++))
else
  red "GET /status/nonexistent-repo → unexpected: ${STATUS}"
  ((FAIL++))
fi

# ── POST /deploy — missing body ───────────────────────────────────────────────
echo ""
echo "[ /deploy validation ]"
DEPLOY_EMPTY=$(curl -s -o /dev/null -w "%{http_code}" \
  -X POST "${BASE}/deploy" \
  -H "Content-Type: application/json" \
  -d '{}')
if [[ "$DEPLOY_EMPTY" == "400" ]]; then
  green "POST /deploy with empty body → 400 (schema validation works)"
  ((PASS++))
else
  red "POST /deploy with empty body → expected 400, got ${DEPLOY_EMPTY}"
  ((FAIL++))
fi

# ── POST /deploy — invalid repo name ─────────────────────────────────────────
DEPLOY_BAD=$(curl -s -o /dev/null -w "%{http_code}" \
  -X POST "${BASE}/deploy" \
  -H "Content-Type: application/json" \
  -d '{"repo":"../etc/passwd"}')
if [[ "$DEPLOY_BAD" == "400" ]]; then
  green "POST /deploy with invalid repo name → 400 (pattern validation works)"
  ((PASS++))
else
  red "POST /deploy with invalid repo name → expected 400, got ${DEPLOY_BAD}"
  ((FAIL++))
fi

# ── POST /teardown — missing body ────────────────────────────────────────────
echo ""
echo "[ /teardown validation ]"
TEARDOWN_EMPTY=$(curl -s -o /dev/null -w "%{http_code}" \
  -X POST "${BASE}/teardown" \
  -H "Content-Type: application/json" \
  -d '{}')
if [[ "$TEARDOWN_EMPTY" == "400" ]]; then
  green "POST /teardown with empty body → 400 (schema validation works)"
  ((PASS++))
else
  red "POST /teardown with empty body → expected 400, got ${TEARDOWN_EMPTY}"
  ((FAIL++))
fi

# ── 404 handler ───────────────────────────────────────────────────────────────
echo ""
echo "[ 404 handler ]"
NOT_FOUND=$(curl -s -o /dev/null -w "%{http_code}" "${BASE}/does-not-exist")
if [[ "$NOT_FOUND" == "404" ]]; then
  green "GET /does-not-exist → 404"
  ((PASS++))
else
  red "GET /does-not-exist → expected 404, got ${NOT_FOUND}"
  ((FAIL++))
fi

# ── Anthropic AI — direct API ping ───────────────────────────────────────────
echo ""
echo "[ Anthropic AI — direct test ]"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="${SCRIPT_DIR}/../.env"
if [[ -f "$ENV_FILE" ]]; then
  set -a; source "$ENV_FILE"; set +a
fi

if [[ -n "${ANTHROPIC_API_KEY:-}" ]] && [[ "$ANTHROPIC_API_KEY" != "sk-ant-REPLACE_ME" ]]; then
  AI_RESPONSE=$(curl -s \
    "https://api.anthropic.com/v1/messages" \
    -H "x-api-key: ${ANTHROPIC_API_KEY}" \
    -H "anthropic-version: 2023-06-01" \
    -H "content-type: application/json" \
    -d '{"model":"claude-sonnet-4-6","max_tokens":64,"messages":[{"role":"user","content":"Reply with exactly: TANGENT_AI_OK"}]}' 2>/dev/null)

  if echo "$AI_RESPONSE" | grep -q "TANGENT_AI_OK"; then
    green "Anthropic API → reachable, claude-sonnet-4-6 responding"
    ((PASS++))
  else
    red "Anthropic API → unexpected response: ${AI_RESPONSE:0:200}"
    ((FAIL++))
  fi
else
  echo "  ⚠  ANTHROPIC_API_KEY not set — skipping AI test"
  echo "     Set it in .env to test AI summarization"
fi

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
echo "─────────────────────────────────────────────"
echo "Results: ${PASS} passed, ${FAIL} failed"
[[ $FAIL -eq 0 ]]
