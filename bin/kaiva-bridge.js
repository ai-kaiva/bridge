#!/usr/bin/env node
// Copyright (c) 2026 SLATEAI LIMITED t/a Kaiva. MIT licensed — see LICENSE.
// Kaiva Bridge CLI — thin client for the Management REST API (/api/bridge/v1).
// Auth: KAIVA_BRIDGE_TOKEN (a kv_mgmt_ management key, minted by a console
// admin). Base URL override: KAIVA_BRIDGE_URL. Zero dependencies (Node 18+).
/* global process, fetch */

const BASE = (process.env.KAIVA_BRIDGE_URL || 'https://api.kaiv.ai/api/bridge/v1').replace(/\/+$/, '');
const TOKEN = process.env.KAIVA_BRIDGE_TOKEN || '';

// The token is a real credential — never send it anywhere but Kaiva over TLS.
// A tampered/mistyped KAIVA_BRIDGE_URL (http://, or someone else's host) would
// otherwise exfiltrate it on the first command. localhost stays allowed for
// local development against a dev backend.
(function assertSafeBase() {
  let u;
  try { u = new URL(BASE); } catch { console.error('error: KAIVA_BRIDGE_URL is not a valid URL'); process.exit(1); }
  const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '::1';
  if (u.protocol !== 'https:' && !local) {
    console.error(`error: refusing to send your token over ${u.protocol}// — KAIVA_BRIDGE_URL must use https (localhost excepted for development).`);
    process.exit(1);
  }
})();

const HELP = `kaiva-bridge — publish any API as a live, governed MCP server

USAGE
  kaiva-bridge push <name> --openapi <spec-url>      create + introspect + expose all + publish
  kaiva-bridge push <name> --mcp <server-url>        wrap an existing remote MCP server
  kaiva-bridge push <name> --postgres <conn-string>  read-only tools from a Postgres DB
  kaiva-bridge servers                               list servers
  kaiva-bridge tools <server-id>                     list a server's tools (id, name, required args)
  kaiva-bridge publish <server-id>                   publish a draft server
  kaiva-bridge key <server-id> [--label L]           mint a gateway key for one server
  kaiva-bridge invoke <server-id> <tool> [--args '{"k":"v"}']      test-call a tool (name or id)
  kaiva-bridge introspect <server-id>                re-read the source; reports anything held
  kaiva-bridge revisions <server-id>                 contract history for a server
  kaiva-bridge promote <server-id>                   publish the held change
  kaiva-bridge reject <server-id>                    discard it and restore what is served
  kaiva-bridge auto-publish <server-id> [--off]      publish contract changes without review
  kaiva-bridge logs [--limit 50]                     tail the audit log
  kaiva-bridge metrics [--range 24h]                 workspace metrics (1h|24h|7d|30d)

AUTH
  export KAIVA_BRIDGE_TOKEN=kv_mgmt_...   (console -> Access -> New key -> Management)
  export KAIVA_BRIDGE_URL=...             (optional; defaults to https://api.kaiv.ai/api/bridge/v1)
`;

// Progress goes to stdout, errors to stderr — but stdout is buffered when piped,
// so flush it before exiting or the error prints ahead of the progress lines.
function say(msg) { process.stdout.write(`${msg}\n`); }
function fail(msg) {
  process.stderr.write(`error: ${msg}\n`);
  process.exitCode = 1;
  process.exit(1);
}
function flag(args, name) { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; }

async function api(method, path, body) {
  if (!TOKEN) fail('KAIVA_BRIDGE_TOKEN is not set (mint a Management key in the console: Access → New key → Management).');
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty */ }
  if (!res.ok) fail(`${res.status} ${data?.error || ''}${data?.message ? ` — ${data.message}` : ''}`);
  return data;
}

const gatewayUrl = (slug) => `${BASE.replace(/\/api\/bridge\/v1$/, '')}/api/bridge/mcp/${slug}`;

// postgres://user:secret@host:5432/db → postgres://user:***@host:5432/db
const redactConn = (conn) => String(conn).replace(/\/\/([^:/@]+):[^@]*@/, '//$1:***@');

async function push(args) {
  const name = args[0];
  if (!name || name.startsWith('--')) fail('usage: kaiva-bridge push <name> --openapi <url> | --mcp <url> | --postgres <conn>');
  const src = flag(args, 'openapi') ? ['openapi', flag(args, 'openapi')]
    : flag(args, 'mcp') ? ['mcp', flag(args, 'mcp')]
    : flag(args, 'postgres') ? ['postgres', flag(args, 'postgres')]
    : null;
  if (!src) fail('one of --openapi <url>, --mcp <url>, --postgres <conn-string> is required');
  const [sourceType, rawUrl] = src;
  const auth = sourceType === 'postgres' ? { connectionString: rawUrl }
    : flag(args, 'token') ? { type: 'bearer', token: flag(args, 'token') } : undefined;
  // A Postgres connection string carries the password. It travels ONLY inside
  // `auth` (sealed at rest server-side); source_url gets a redacted form, since
  // that column is echoed back by list/detail endpoints and shown in the console.
  const sourceUrl = sourceType === 'postgres' ? redactConn(rawUrl) : rawUrl;

  say(`creating ${name} (${sourceType})…`);
  const created = await api('POST', '/servers', { name, sourceType, sourceUrl, auth });
  const server = created.server || created;
  say(`introspecting…`);
  await api('POST', `/servers/${server.id}/introspect`);
  const detail = await api('GET', `/servers/${server.id}`);
  const tools = detail.server?.tools || detail.tools || [];
  say(`exposing ${tools.length} tool${tools.length === 1 ? '' : 's'}…`);
  for (const t of tools) await api('PATCH', `/servers/${server.id}/tools/${t.id}`, { exposed: true });
  await api('POST', `/servers/${server.id}/publish`);
  say(`\nLIVE  ${gatewayUrl(server.slug)}`);
  say(`\nnext: kaiva-bridge key ${server.id}   (mint a gateway key for agents)`);
}

// GET /servers/:id returns the server with its tools. The management route passes
// through whatever the service returned, so accept both shapes.
async function fetchTools(serverId) {
  const r = await api('GET', `/servers/${serverId}`);
  const s = r.server || r;
  return s.tools || [];
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') { say(HELP); return; }

  if (cmd === 'push') return push(args);

  if (cmd === 'servers') {
    const r = await api('GET', '/servers');
    for (const s of r.servers || []) say(`${s.id}  ${String(s.state).padEnd(8)} ${String(s.source_type).padEnd(9)} ${s.name}  (${s.slug})`);
    if (!(r.servers || []).length) say('no servers yet — try: kaiva-bridge push my-api --openapi <spec-url>');
    return;
  }

  if (cmd === 'tools') {
    if (!args[0]) fail('usage: kaiva-bridge tools <server-id>');
    const list = await fetchTools(args[0]);
    for (const t of list) {
      const req = ((t.input_schema && t.input_schema.required) || []).join(', ');
      say(`${t.id}  ${t.exposed ? 'exposed' : 'hidden '}  ${String(t.name).padEnd(24)} ${req ? `(${req})` : ''}`);
    }
    if (!list.length) say('no tools yet — introspect the server first');
    return;
  }

  if (cmd === 'publish') {
    if (!args[0]) fail('usage: kaiva-bridge publish <server-id>');
    await api('POST', `/servers/${args[0]}/publish`);
    say('published');
    return;
  }

  if (cmd === 'key') {
    if (!args[0]) fail('usage: kaiva-bridge key <server-id> [--label L]');
    const r = await api('POST', '/keys', { label: flag(args, 'label') || 'cli-key', serverIds: [args[0]] });
    say(`key (shown once): ${r.key.key || r.key.raw || JSON.stringify(r.key)}`);
    return;
  }

  if (cmd === 'invoke') {
    if (!args[0] || !args[1]) fail("usage: kaiva-bridge invoke <server-id> <tool> [--args '{\"k\":\"v\"}']");
    let parsed = {};
    if (flag(args, 'args')) { try { parsed = JSON.parse(flag(args, 'args')); } catch { fail('--args must be valid JSON'); } }
    // Accept a tool NAME as well as a uuid. The id is only discoverable through
    // `tools`, whereas the name is what the user already knows from the docs or
    // the tool list — requiring the id made invoke unusable on its own.
    let toolId = args[1];
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(toolId)) {
      const list = await fetchTools(args[0]);
      const hit = list.find((t) => t.name === toolId);
      if (!hit) fail(`no tool named "${toolId}" on that server — run: kaiva-bridge tools ${args[0]}`);
      toolId = hit.id;
    }
    const r = await api('POST', `/servers/${args[0]}/tools/${toolId}/invoke`, { arguments: parsed });
    say(`ok (${r.latencyMs}ms)`);
    say(JSON.stringify(r.result, null, 2));
    return;
  }

  if (cmd === 'logs') {
    const r = await api('GET', `/audit?limit=${Number(flag(args, 'limit')) || 50}`);
    for (const e of r.entries || []) say(`${e.created_at}  ${String(e.decision).padEnd(6)} ${String(e.tool || '—').padEnd(28)} ${e.deny_reason || ''}`);
    return;
  }

  if (cmd === 'metrics') {
    const r = await api('GET', `/metrics?range=${flag(args, 'range') || '24h'}`);
    say(JSON.stringify(r.kpis, null, 2));
    return;
  }

  /* ── Contract revisions ──────────────────────────────────────────────────
     A changed description or input schema on a tool that is already exposed does
     not go live on its own: it is held until someone releases it. An MCP client
     reads tool definitions once, when a person approves the connection, so a
     rewrite reaching agents unannounced is the thing being prevented.

     None of these takes a revision id. At most one revision is ever pending per
     server, so the command finds it. */
  if (cmd === 'introspect') {
    if (!args[0]) fail('introspect needs a server id — run: kaiva-bridge servers');
    const r = await api('POST', `/servers/${args[0]}/introspect`);
    const c = r.changes || {};
    /* The two APIs answer introspect with different envelopes: the console router
       wraps it as { server, changes } and the Management router returns the server
       fields flat alongside changes. This CLI only ever talks to the Management
       API, so r.pending is the real path; r.server.pending is read too so the
       command cannot silently report success against the other shape. */
    const held = (r.pending || r.server?.pending)?.changes?.exposedAndChanged || [];
    if (held.length) {
      say(`held: ${held.join(', ')} changed meaning and is NOT being served yet.`);
      say(`agents still receive the previous definitions. release with: kaiva-bridge promote ${args[0]}`);
      /* Non-zero so an unattended pipeline stops instead of reporting success on
         a server whose new tools are not live. Distinct from 1, which the rest of
         this CLI uses for an outright failure: nothing went wrong here, it is
         waiting for a person. */
      process.exitCode = 3;
      return;
    }
    const bits = [];
    if (c.added?.length) bits.push(`${c.added.length} new (left off)`);
    if (c.removed?.length) bits.push(`${c.removed.length} gone`);
    if (c.keptExposed) bits.push(`${c.keptExposed} still exposed`);
    say(bits.length ? bits.join(' · ') : 'no change to the tool set');
    return;
  }

  if (cmd === 'revisions') {
    if (!args[0]) fail('revisions needs a server id');
    const r = await api('GET', `/servers/${args[0]}/revisions`);
    if (!r.revisions?.length) { say('no contract history yet'); return; }
    for (const v of r.revisions) {
      const ch = v.changes?.exposedAndChanged || [];
      say(`${v.created_at}  ${String(v.status).padEnd(11)} ${v.digest.slice(0, 16)}  ${ch.length ? `changed: ${ch.join(', ')}` : ''}`.trimEnd());
    }
    return;
  }

  if (cmd === 'promote' || cmd === 'reject') {
    if (!args[0]) fail(`${cmd} needs a server id`);
    const list = await api('GET', `/servers/${args[0]}/revisions`);
    const pending = (list.revisions || []).find((v) => v.status === 'pending');
    if (!pending) fail('nothing is held on that server');
    const r = await api('POST', `/servers/${args[0]}/revisions/${pending.id}/${cmd}`);
    say(cmd === 'promote'
      ? 'published — connected agents now receive the new definitions'
      : `rejected — ${r.restored || 0} tools restored to what is being served`);
    return;
  }

  if (cmd === 'auto-publish') {
    if (!args[0]) fail('auto-publish needs a server id');
    const enabled = !args.includes('--off');
    const r = await api('POST', `/servers/${args[0]}/auto-promote`, { enabled });
    say(r.autoPromote
      ? 'auto-publish ON — contract changes go live as soon as they are introspected'
      : 'auto-publish OFF — a changed description or schema waits for review');
    return;
  }

  fail(`unknown command '${cmd}' — run: kaiva-bridge help`);
}

main().catch((e) => fail(e.message));
