#!/usr/bin/env bash
# Connect a database (Postgres, MySQL or MariaDB) to Claude Code through Kaiva Bridge.
# Safe to run again: the same server is reused and the key is replaced, not added.
#
#   export KAIVA_BRIDGE_TOKEN=kv_mgmt_...   # console: Keys & access, Management key
#   export DATABASE_URL=mysql://bridge_ro:...@db.example.com:3306/shop
#   ./database-to-claude-code.sh shop-db [--no-verify-tls | --ca-file provider-ca.pem]
set -euo pipefail
NAME="${1:?usage: database-to-claude-code.sh <server-name> [--no-verify-tls | --ca-file <pem>]}"; shift
: "${KAIVA_BRIDGE_TOKEN:?set KAIVA_BRIDGE_TOKEN to a Management key}"
: "${DATABASE_URL:?set DATABASE_URL to the database connection string}"
KB="${KB:-npx -y @kaiva/bridge}"
case "$DATABASE_URL" in
  postgres://*|postgresql://*) ENGINE=--postgres ;;
  mysql://*|mariadb://*) ENGINE=--mysql ;;
  *) echo "DATABASE_URL must start with postgres://, postgresql://, mysql:// or mariadb://" >&2; exit 1 ;;
esac
# Tool names and results come from the source: shown as plain text, control characters
# and bidi overrides replaced with '?', so nothing a source returns can rewrite the terminal.
plain() { node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>process.stdout.write(d.replace(/[\\u0000-\\u0008\\u000b-\\u001f\\u007f-\\u009f\\u200E\\u200F\\u202A-\\u202E\\u2066-\\u2069]/g,'?')))"; }
field() { node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>process.stdout.write(String(JSON.parse(d)['$1'])))"; }

# 1. Create (or update) the server. The connection string goes through stdin, not argv.
SERVER=$(printf %s "$DATABASE_URL" | $KB push "$NAME" "$ENGINE" --secret-stdin --read-only --json "$@")
ID=$(printf %s "$SERVER" | field id); ENDPOINT=$(printf %s "$SERVER" | field endpoint); SLUG=$(printf %s "$SERVER" | field slug)
echo "live: $ENDPOINT ($(printf %s "$SERVER" | field exposed) tools)"

# 2. One key for Claude Code; an earlier one with this label is revoked.
KEY=$($KB key "$ID" --label claude-code --replace --json | field key)

# 3. Add it to Claude Code, or print the command if Claude Code is not installed here.
if command -v claude >/dev/null 2>&1; then
  claude mcp remove "$SLUG" >/dev/null 2>&1 || true
  claude mcp add --transport http "$SLUG" "$ENDPOINT" --header "Authorization: Bearer $KEY" >/dev/null
  echo "added to Claude Code as $SLUG"
else
  echo "Claude Code not found. Run this where it is installed:"
  echo "  claude mcp add --transport http $SLUG $ENDPOINT --header \"Authorization: Bearer <the key>\""
fi

# 4. A first tool call, straight to the endpoint, as an agent would make it.
TOOL=$($KB tools "$ID" | awk '$2=="exposed" && $3 ~ /^get_/ {print $3; exit}')
curl -sf -X POST "$ENDPOINT" -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"$TOOL\",\"arguments\":{\"limit\":1}}}" \
  | sed -n 's/^data: //p;/^{/p' | head -1 | cut -c1-200 | plain
echo
echo "first call: $(printf %s "$TOOL" | plain) answered. Ask Claude Code about your data."
