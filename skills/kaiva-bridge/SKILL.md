---
name: kaiva-bridge
description: Give this coding agent or an AI app real access to an API (from its OpenAPI or Swagger spec), a database (Postgres, MySQL or MariaDB), documents or a remote MCP server, as a hosted MCP server from Kaiva Bridge. Works with no account for public API specs (GET only, 72 hours, claimable). Use when the user wants an AI client or app to use an API or database, asks to "connect my database/API to Claude/Cursor/Codex", needs an MCP server for their product's API, wants to check code against a real API's actual responses, or mentions Kaiva Bridge.
---

# Kaiva Bridge setup

Kaiva Bridge turns an API spec, a database or a remote MCP server into a hosted MCP
endpoint with read-only database tools. You drive it with the `kaiva-bridge` CLI
(`npx @kaiva/bridge`). Every step below is safe to run again: the same server name is
reused, never duplicated, and `--replace` keeps one key per client.

## No Kaiva account? Start without one

For a **public** API spec, you can create a working server yourself, with no account and
no login. It offers only the spec's GET operations, lasts 72 hours or 500 calls, and comes
with a claim link the user opens to keep it.

```bash
npx -y @kaiva/bridge try --openapi https://example.com/openapi.json --json
```

(or `--spec-file ./openapi.yaml`; add `--name short-name`). The JSON has `mcpUrl`, `apiKey`
(shown once, for this one server), `claimUrl`, `expiresAt` and `tools`.

If the command cannot reach the network (a cloud sandbox such as Codex cloud or Claude Code
on the web), ask the user to allow the domains `api.kaiv.ai` and `registry.npmjs.org`.

1. Add it to the client. Claude Code:
   `claude mcp add --transport http <name> <mcpUrl> --header "Authorization: Bearer <apiKey>"`.
   For other clients use the same address and header in their config (see step 2 below).
2. **Always give the user the `claimUrl`** and say what it does: claiming keeps the server
   in their workspace at the same address, under their plan's limits. Your key stops working
   at claim, so tell the user to connect you again from the server's Connect tab. They can
   then add an API key and switch on other operations. Without a claim it is deleted after 72 hours.
3. Do not send credentials to `try`: it refuses them. If the API needs a key, create the
   server, ask the user to claim it, then they add the key on the server's Source tab.

Use `try` to let yourself check work against the real API: call a read tool and compare
its actual response with what the code expects, instead of guessing from documentation.

Private APIs, databases, documents and write tools need an account: continue below.

## Before you start

1. Check the CLI is signed in: `npx @kaiva/bridge whoami`. If it says not signed in, ask
   the user to run `npx @kaiva/bridge login` in their own terminal and approve the code in
   the browser (they must be an owner or admin). In CI, `KAIVA_BRIDGE_TOKEN` holds a
   management key instead. Never ask them to paste a key into the chat, and never print it.
2. Work out the source with the user:
   - an OpenAPI spec URL (`--openapi <url>`),
   - a database connection string, already in an environment variable such as
     `DATABASE_URL` (`--postgres` for postgres:// and postgresql://, `--mysql` for mysql://
     and mariadb://),
   - or a remote MCP server URL (`--mcp <url>`).
3. Pick a short server name (lowercase, hyphens), e.g. `shop-db`.

## 1. Create or update the server

Database (the connection string never appears in the command line or your output):

```bash
printf %s "$DATABASE_URL" | npx -y @kaiva/bridge push shop-db --mysql --secret-stdin --read-only --json
```

API spec:

```bash
npx -y @kaiva/bridge push petstore --openapi https://example.com/openapi.json --read-only --json
```

Documents (PDF, Word, PNG, JPEG, text or Markdown files, or a folder of them):

```bash
npx -y @kaiva/bridge push handbook --docs ./policies --json
```

It waits until every file is read; the server goes live with its first ready document.
Documents give an AI search and page-reading tools only, so `--read-only` does not apply.

Always pass `--read-only`: only operations that read are exposed (every database tool
is a read; for an API, GET). Operations that change data stay off. If the user wants
some of them, list them (`npx @kaiva/bridge tools <id>`) and let the user choose them in
the console (Servers → the server → Tools); never expose writes on your own.

The last line of output is one JSON object: `id`, `endpoint`, `slug`, `tools`, `exposed`,
`writesLeftOff`, `reused`, `held`. Keep `id`, `endpoint` and `slug`.

Handle the outcome:

- **Exit 0:** the server is live.
- **Exit 3:** a tool changed meaning and is held for review (`held` lists it). Tell the
  user; they release it with `npx @kaiva/bridge promote <id>`. Agents keep the previous
  definitions until then.
- **Certificate stop** (the error says Bridge couldn't verify the database's certificate):
  ask the user which they want. Do not choose for them.
  - `--ca-file <provider-ca.pem>`: checked against their provider's CA (preferred; most
    hosted providers publish one).
  - `--no-verify-tls`: connect without checking the certificate (still encrypted).
  Then run the same push again with that flag; it reuses the server.
- **Any other error:** show the message to the user as it is. It names what to fix (login,
  database name, host, port, the wrong kind of database). Do not retry with changed
  details unless the user gives them.

## 2. Add it to the client

Claude Code or Cursor: one command writes the client's own config, keeps every other entry,
and changes nothing when run again.

```bash
npx -y @kaiva/bridge install <id> --client claude-code   # this folder's .mcp.json (--global: all projects)
npx -y @kaiva/bridge install <id> --client cursor        # ~/.cursor/mcp.json (--project: .cursor/mcp.json)
```

With no key, the client asks the user to sign in with their Kaiva Bridge account the first
time (Claude Code: `/mcp`, choose the server, sign in). Add `--key` to write a gateway key for
this one server instead (not with `--global`); an earlier key from `install` for that client
is revoked. `--dry-run` shows the change first. Undo: `npx -y @kaiva/bridge uninstall <id>
--client <client>`.

Other clients: make a key for the client, then add it by hand.

```bash
npx -y @kaiva/bridge key <id> --label codex --replace --json
```

Use one label per client (`codex`, `vscode`, `my-app`). `--replace` revokes the earlier key
with that label for this server, so running setup again leaves one key. The key is shown
once: put it straight into the client configuration below. Do not echo it in your reply or
write it anywhere else.

Codex (`~/.codex/config.toml`):

```toml
[mcp_servers.<slug>]
url = "<endpoint>"
http_headers = { "Authorization" = "Bearer <key>" }
```

VS Code (`.vscode/mcp.json`):

```json
{ "servers": { "<slug>": { "type": "http", "url": "<endpoint>", "headers": { "Authorization": "Bearer <key>" } } } }
```

A key in a project file must not be committed: check the file is in `.gitignore`, and add
it if the user agrees.

## 3. Confirm it works

```bash
npx -y @kaiva/bridge tools <id>
npx -y @kaiva/bridge invoke <id> <tool-name> --args '{}'
```

Pick a read tool with no required inputs (for a database, `get_<table>` with no filters).
Report to the user: the endpoint, how many tools are exposed, and the result of that first
call. A new client may need restarting before it lists the tools.

## Running it again

Safe. `push` with the same name updates that server from its source and keeps the tools
someone chose; `install` leaves an existing entry as it is; `key --replace` swaps the key. To expose more tools on a live server, ask
the user first, then use the console (Servers → the server → Tools).
