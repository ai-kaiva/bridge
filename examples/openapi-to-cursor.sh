#!/usr/bin/env bash
# Turn an OpenAPI spec into an MCP server and add it to Cursor for this project.
# Safe to run again: the same server is reused, the key replaced, and the Cursor entry updated.
#
#   export KAIVA_BRIDGE_TOKEN=kv_mgmt_...
#   ./openapi-to-cursor.sh petstore https://petstore3.swagger.io/api/v3/openapi.json
set -euo pipefail
NAME="${1:?usage: openapi-to-cursor.sh <server-name> <spec-url>}"; SPEC="${2:?usage: openapi-to-cursor.sh <server-name> <spec-url>}"
: "${KAIVA_BRIDGE_TOKEN:?set KAIVA_BRIDGE_TOKEN to a Management key}"
KB="${KB:-npx -y @kaiva/bridge}"
# Tool names and results come from the source: shown as plain text, control characters
# and bidi overrides replaced with '?', so nothing a source returns can rewrite the terminal.
plain() { node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>process.stdout.write(d.replace(/[\\u0000-\\u0008\\u000b-\\u001f\\u007f-\\u009f\\u200E\\u200F\\u202A-\\u202E\\u2066-\\u2069]/g,'?')))"; }
field() { node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>process.stdout.write(String(JSON.parse(d)['$1'])))"; }

SERVER=$($KB push "$NAME" --openapi "$SPEC" --read-only --json)
ID=$(printf %s "$SERVER" | field id); ENDPOINT=$(printf %s "$SERVER" | field endpoint); SLUG=$(printf %s "$SERVER" | field slug)
echo "live: $ENDPOINT ($(printf %s "$SERVER" | field exposed) tools)"
KEY=$($KB key "$ID" --label cursor --replace --json | field key)

# Add or update this server in .cursor/mcp.json, keeping any other servers there.
mkdir -p .cursor
SLUG="$SLUG" ENDPOINT="$ENDPOINT" KEY="$KEY" node -e '
  const fs = require("fs"); const f = ".cursor/mcp.json";
  const cfg = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : {};
  cfg.mcpServers = { ...(cfg.mcpServers || {}), [process.env.SLUG]: { url: process.env.ENDPOINT, headers: { Authorization: `Bearer ${process.env.KEY}` } } };
  fs.writeFileSync(f, JSON.stringify(cfg, null, 2) + "\n");'
echo "added $SLUG to .cursor/mcp.json"
if [ -d .git ] && ! git check-ignore -q .cursor/mcp.json; then
  echo "note: .cursor/mcp.json now holds a key and is not ignored by git. Add it to .gitignore."
fi

# A first call: list the tools, as Cursor will.
curl -sf -X POST "$ENDPOINT" -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' \
  | sed -n 's/^data: //p;/^{/p' | head -1 | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const t=JSON.parse(d).result.tools;console.log('tools Cursor will see: '+t.length+' ('+t.slice(0,4).map(x=>x.name).join(', ')+(t.length>4?', …':'')+')')})" | plain
echo "restart Cursor (or reload MCP servers) to use them."
