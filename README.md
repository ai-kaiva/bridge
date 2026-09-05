# @kaiva/bridge

Publish any API or database as a live MCP server, from your terminal.

[Kaiva Bridge](https://kaiv.ai/bridge) turns an OpenAPI spec or a Postgres
database into a hosted MCP server your agents can call. This CLI drives it
over the [Management API](https://kaiv.ai/bridge/docs).

## Install

Nothing to install — Node 18+ has everything:

```bash
npx @kaiva/bridge help
```

## Auth

Mint a **Management key** in the console (admin role required), then:

```bash
export KAIVA_BRIDGE_TOKEN=kv_mgmt_...
```

Management keys are refused by the MCP gateway, and gateway keys are refused
by the Management API — the two credential types are never interchangeable.

## Quickstart — spec to live server in one command

```bash
npx @kaiva/bridge push my-api --openapi https://api.example.com/openapi.json
# → LIVE  https://api.kaiv.ai/api/bridge/mcp/my-api-a1b2c3d4

npx @kaiva/bridge key <server-id>       # mint a gateway key for agents
```

Paste the endpoint + key into Claude, Cursor, or any MCP client. Done.

## Commands

| Command | What it does |
|---|---|
| `push <name> --openapi <url>` | Create + introspect + expose + publish from an OpenAPI spec |
| `push <name> --mcp <url>` | Wrap an existing remote MCP server with governance |
| `push <name> --postgres <conn>` | Read-only tools from a Postgres database |
| `servers` | List servers with state and source |
| `publish <server-id>` | Publish a draft server |
| `key <server-id> [--label L]` | Mint a server-scoped gateway key (shown once) |
| `introspect <server-id>` | Re-read the source. Exits 3 if a contract change was held |
| `revisions <server-id>` | Contract history: when it changed and which tool |
| `promote <server-id>` | Publish the held change |
| `reject <server-id>` | Discard it and restore what is being served |
| `auto-publish <server-id> [--off]` | Publish contract changes without review |
| `invoke <server-id> <tool-id> [--args '{"k":"v"}']` | Test-call a tool through the real governed path (audited) |
| `logs [--limit 50]` | Tail the audit log |
| `metrics [--range 24h]` | Workspace KPIs (1h · 24h · 7d · 30d) |

`KAIVA_BRIDGE_URL` overrides the API base (defaults to
`https://api.kaiv.ai/api/bridge/v1`).

## Try before you sign up

Call a live example server from your browser — no account:
**https://app.kaiv.ai/try**

---

MIT © SLATEAI LIMITED · [kaiv.ai/bridge](https://kaiv.ai/bridge)
