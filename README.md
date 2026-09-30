# @kaiva/bridge

Publish any API or database as a live MCP server, from your terminal.

[Kaiva Bridge](https://kaiv.ai/bridge) turns an OpenAPI spec, a database
(PostgreSQL, MySQL or MariaDB) or a remote MCP server into a hosted MCP server
your agents can call. This CLI drives it over the
[Management API](https://kaiv.ai/bridge/docs). Every setup command is safe to
run again.

## Install

Nothing to install. Node 18+ has everything:

```bash
npx @kaiva/bridge help
```

## Auth

Mint a **Management key** in the console (admin role required), then:

```bash
export KAIVA_BRIDGE_TOKEN=kv_mgmt_...
```

Management keys are refused by the MCP gateway, and gateway keys are refused
by the Management API: the two credential types are never interchangeable.

## Quickstart: source to live server

```bash
# An API spec (only operations that read are exposed with --read-only)
npx @kaiva/bridge push my-api --openapi https://api.example.com/openapi.json --read-only

# A database: the connection string comes from stdin, not the command line
printf %s "$DATABASE_URL" | npx @kaiva/bridge push shop-db --mysql --secret-stdin --read-only
# → LIVE  https://api.kaiv.ai/api/bridge/mcp/shop-db-a1b2c3d4

npx @kaiva/bridge key <server-id> --label claude-code --replace   # a gateway key for your agent
```

Paste the endpoint and key into Claude, Cursor or any MCP client. Run the same
commands again and nothing is duplicated: `push` reuses the server with that
name, and `key --replace` swaps the key with that label.

## Let your coding agent do it

```bash
npx @kaiva/bridge skill install        # adds the setup skill to Claude Code (~/.claude/skills)
```

Then ask: "connect my database to Claude Code with Kaiva Bridge". The skill runs
the commands below, asks you before connecting without certificate checks or
exposing operations that write, and confirms with a first tool call.

## Examples

Runnable scripts in [`examples/`](examples):

- [`database-to-claude-code.sh`](examples/database-to-claude-code.sh): a Postgres, MySQL or MariaDB database into Claude Code
- [`openapi-to-cursor.sh`](examples/openapi-to-cursor.sh): an OpenAPI spec into Cursor for this project
- [`call-from-your-app.mjs`](examples/call-from-your-app.mjs): call your MCP server from your own Node app, no dependencies

## Commands

| Command | What it does |
|---|---|
| `push <name> --openapi <url>` | Create + introspect + expose + publish from an OpenAPI spec |
| `push <name> --mcp <url>` | Wrap an existing remote MCP server with governance |
| `push <name> --postgres <conn>` | Read-only tools from a Postgres database |
| `push <name> --mysql <conn>` | Read-only tools from a MySQL or MariaDB database |
| `push … --read-only` | Expose only operations that read; writes stay off until you choose them |
| `push … --ca-file <pem>` / `--no-verify-tls` | A database with a self-signed certificate: check it against your provider's CA, or connect without checking |
| `skill install [--project]` | Add the setup skill for coding agents |
| `servers` | List servers with state and source |
| `publish <server-id>` | Publish a draft server |
| `key <server-id> [--label L] [--replace]` | Mint a server-scoped gateway key (shown once); `--replace` revokes the earlier key with that label |
| `introspect <server-id>` | Re-read the source. Exits 3 if a contract change was held |
| `revisions <server-id>` | Contract history: when it changed and which tool |
| `promote <server-id>` | Publish the held change |
| `reject <server-id>` | Discard it and restore what is being served |
| `auto-publish <server-id> [--off]` | Publish contract changes without review |
| `invoke <server-id> <tool-id> [--args '{"k":"v"}']` | Test-call a tool through the real governed path (audited) |
| `logs [--limit 50]` | Tail the audit log |
| `metrics [--range 24h]` | Workspace KPIs (1h · 24h · 7d · 30d) |

`--json` on `push` and `key` prints one JSON result on stdout (progress goes to
stderr), for scripts and agents. `KAIVA_BRIDGE_URL` overrides the API base
(defaults to `https://api.kaiv.ai/api/bridge/v1`).

## Try before you sign up

Call a live example server from your browser, no account needed:
**https://app.kaiv.ai/try**

---

MIT © SLATEAI LIMITED · [kaiv.ai/bridge](https://kaiv.ai/bridge)
