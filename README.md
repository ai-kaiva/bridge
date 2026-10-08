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

## Try it with no account

For a public API spec, one command gives you a working MCP server. No account,
no login:

```bash
npx @kaiva/bridge try --openapi https://petstore3.swagger.io/api/v3/openapi.json
```

You get the server's address, a key for that one server, and a claim link. The server
offers only the spec's GET operations, and lasts 72 hours or 500 calls. Open the claim
link to keep it in your workspace: it keeps its address and your plan's limits apply.
The key stops working at claim, so connect your AI client again from the console. Then
you can add an API key and switch on other operations. Coding agents can do this
themselves (`--json` prints one JSON object).

## Claude Code plugin

```bash
claude plugin marketplace add ai-kaiva/bridge
claude plugin install kaiva-bridge@kaiva
```

Or copy just the skill: `npx @kaiva/bridge skill install`.

## Auth

```bash
npx @kaiva/bridge login
```

The terminal shows a code and opens the console. Enter the code there and approve
it (owner or admin of the workspace). The key is saved for this machine in
`~/.config/kaiva-bridge/credentials.json`, readable only by you. `whoami` shows
the workspace and key in use; `logout` revokes the key and removes it.

For CI and scripts, use a **Management key** from the console (Keys & access,
key type Management) instead. When set, it is used in place of a saved login:

```bash
export KAIVA_BRIDGE_TOKEN=kv_mgmt_...
```

`logout` revokes only a saved login. A key you supply in `KAIVA_BRIDGE_TOKEN` is
yours to manage: unset it, and revoke it in the console when it is no longer
needed. Signing in again revokes the login it replaces.

Management keys are refused by the MCP gateway, and gateway keys are refused
by the Management API: the two credential types are never interchangeable.

## Quickstart: source to live server

```bash
# An API spec (only operations that read are exposed with --read-only)
npx @kaiva/bridge push my-api --openapi https://api.example.com/openapi.json --read-only

# A database: the connection string comes from stdin, not the command line
printf %s "$DATABASE_URL" | npx @kaiva/bridge push shop-db --mysql --secret-stdin --read-only
# → LIVE  https://api.kaiv.ai/api/bridge/mcp/shop-db-a1b2c3d4

# Documents: PDF, Word, PNG, JPEG, text or Markdown files, or a folder of them
npx @kaiva/bridge push handbook --docs ./policies
# waits until each file is read, then → LIVE  https://api.kaiv.ai/api/bridge/mcp/handbook-a1b2c3d4

npx @kaiva/bridge install my-api --client claude-code   # or --client cursor
```

`install` adds the server to Claude Code (this folder's `.mcp.json`, or `--global`)
or Cursor (`~/.cursor/mcp.json`, or `--project`), keeping every other entry. The
client signs in with your Kaiva account the first time; `--key` writes a key for
this one server instead. `--dry-run` shows the change; `uninstall` removes it.
For any other MCP client, `key <server-id> --label <client> --replace` makes a
gateway key to paste with the endpoint. Run the same commands again and nothing
is duplicated: `push` reuses the server with that name, `install` leaves an
existing entry as it is, and `key --replace` swaps the key with that label.

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
| `push <name> --docs <files or folders>` | Documents your AI can search and read, page by page; the same file name again replaces that document. `--no-wait` returns once the files are sent |
| `push … --read-only` | Expose only operations that read; writes stay off until you choose them |
| `push … --ca-file <pem>` / `--no-verify-tls` | A database with a self-signed certificate: check it against your provider's CA, or connect without checking |
| `login [--no-browser]` | Approve this machine in the console and save a key for it |
| `whoami` | The workspace, account and key in use |
| `logout` | Revoke this machine's key and remove it |
| `skill install [--project]` | Add the setup skill for coding agents |
| `install <server> --client claude-code\|cursor` | Add a live server to the client's config; `--key`, `--dry-run`, `--global` (Claude Code), `--project` (Cursor) |
| `uninstall <server> --client claude-code\|cursor` | Remove it, and revoke a key `install` added |
| `doctor <server> [--call <tool>]` | Check reachability, sign-in, publication, the MCP handshake and tool list; each step passes, fails with a code and a fix, or says it did not run. `--call` makes one call with a tool that reads. Ends with a receipt for support (no secrets) |
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

`--json` on `push`, `key`, `install`, `whoami` and `doctor` prints one JSON result on stdout (progress goes to
stderr), for scripts and agents. `KAIVA_BRIDGE_URL` overrides the API base
(defaults to `https://api.kaiv.ai/api/bridge/v1`).

## Try before you sign up

Call a live example server from your browser, no account needed:
**https://app.kaiv.ai/try**

---

MIT © SLATEAI LIMITED · [kaiv.ai/bridge](https://kaiv.ai/bridge)
