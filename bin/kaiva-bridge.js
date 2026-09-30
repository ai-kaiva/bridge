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
  kaiva-bridge push <name> --openapi <spec-url>      create + introspect + expose all + publish (same name again: reused, not duplicated)
      add --read-only to expose only operations that read (writes stay off until you choose them)
  kaiva-bridge push <name> --mcp <server-url>        wrap an existing remote MCP server
  kaiva-bridge push <name> --postgres <conn-string>  read-only tools from a Postgres DB
  kaiva-bridge push <name> --mysql <conn-string>     read-only tools from a MySQL or MariaDB DB
      add --secret-stdin to read the connection string (or, for --openapi/--mcp, the
      --token) from stdin: printf %s "$DATABASE_URL" | kaiva-bridge push db --postgres --secret-stdin
      a database whose certificate is self-signed: add --ca-file <provider-ca.pem>, or --no-verify-tls
  kaiva-bridge skill install [--project]            add the setup skill for coding agents (Claude Code)
  kaiva-bridge servers                               list servers
  kaiva-bridge tools <server-id>                     list a server's tools (id, name, required args)
  kaiva-bridge publish <server-id>                   publish a draft server
  kaiva-bridge key <server-id> [--label L] [--replace]  gateway key for agents; --replace revokes the earlier one with that label
  kaiva-bridge invoke <server-id> <tool> [--args '{"k":"v"}']      test-call a tool (name or id)
  kaiva-bridge introspect <server-id>                re-read the source; reports anything held
  kaiva-bridge revisions <server-id>                 contract history for a server
  kaiva-bridge promote <server-id>                   publish the held change
  kaiva-bridge reject <server-id>                    discard it and restore what is served
  kaiva-bridge auto-publish <server-id> [--off]      publish contract changes without review
  kaiva-bridge credential set <server-id> --type bearer --secret-stdin    replace the credential it sends upstream
  kaiva-bridge credential set <server-id> --type basic --username U --secret-stdin
  kaiva-bridge credential set <server-id> --type header --name X-API-Key --secret-stdin
      --secret-stdin reads the token, password or value from stdin: printf %s "$KEY" | kaiva-bridge …
      (--token, --password and --value also work, but leave the secret in shell history)
  kaiva-bridge credential test <server-id>           call the API once with the stored credential
  kaiva-bridge logs [--limit 50]                     tail the audit log
  kaiva-bridge metrics [--range 24h]                 workspace metrics (1h|24h|7d|30d)

OUTPUT
  --json    progress to stderr, one JSON result on stdout (push, key)

AUTH
  export KAIVA_BRIDGE_TOKEN=kv_mgmt_...   (console -> Access -> New key -> Management)
  export KAIVA_BRIDGE_URL=...             (optional; defaults to https://api.kaiv.ai/api/bridge/v1)
`;

// Progress goes to stdout, errors to stderr — but stdout is buffered when piped,
// so flush it before exiting or the error prints ahead of the progress lines.
// Tool names, server names and error text come from the server and from the APIs
// it wraps, so they reach the terminal only as plain text: control characters
// (escape sequences that move the cursor, rewrite lines or retitle the window)
// and bidi overrides become '?'. Newlines and tabs are kept for layout.
const plain = (s) => String(s).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, '?');
/* --json: for coding agents and scripts. Progress goes to stderr and the command
   ends with exactly one JSON object on stdout, so the result can be parsed. */
const JSON_MODE = process.argv.includes('--json');
function say(msg) { (JSON_MODE ? process.stderr : process.stdout).write(`${plain(msg)}\n`); }
function out(obj) { if (JSON_MODE) process.stdout.write(`${JSON.stringify(obj)}\n`); }
function fail(msg) {
  process.stderr.write(`error: ${plain(msg)}\n`);
  process.exitCode = 1;
  process.exit(1);
}
function flag(args, name) { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; }
/* A secret passed as an argument is readable by every other process on the
   machine (ps) and is written to shell history. --secret-stdin is the same
   pattern as `docker login --password-stdin`: the value never touches argv. */
async function readSecretStdin() {
  if (process.stdin.isTTY) fail('--secret-stdin reads from a pipe: printf %s "$SECRET" | kaiva-bridge …');
  process.stdin.setEncoding('utf8');
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  return raw.replace(/\r?\n$/, '');
}

async function api(method, path, body) {
  if (!TOKEN) fail('KAIVA_BRIDGE_TOKEN is not set (mint a Management key in the console: Access → New key → Management).');
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty */ }
  /* A database whose certificate could not be checked: say how to go on from the
     command line, as the console's certificate panel does. */
  const tlsHint = data?.tls ? '\nadd --ca-file <provider-ca.pem> to check it against your provider\'s CA, or --no-verify-tls to connect without checking the certificate' : '';
  if (!res.ok) fail(`${res.status} ${data?.error || ''}${data?.message ? ` — ${data.message}` : ''}${tlsHint}`);
  return data;
}

const gatewayUrl = (slug) => `${BASE.replace(/\/api\/bridge\/v1$/, '')}/api/bridge/mcp/${slug}`;

// postgres://user:secret@host:5432/db → postgres://user:***@host:5432/db
const redactConn = (conn) => String(conn).replace(/\/\/([^:/@]+):[^@]*@/, '//$1:***@');

async function push(args) {
  const name = args[0];
  if (!name || name.startsWith('--')) fail('usage: kaiva-bridge push <name> --openapi <url> | --mcp <url> | --postgres <conn>');
  // A flag's value, unless the next word is another flag (--postgres --secret-stdin).
  const val = (n) => { const v = flag(args, n); return v && !v.startsWith('--') ? v : undefined; };
  const sourceType = ['openapi', 'mcp', 'postgres', 'mysql'].find((t) => args.includes(`--${t}`));
  if (!sourceType) fail('one of --openapi <url>, --mcp <url>, --postgres <conn-string>, --mysql <conn-string> is required');
  // A database source's connection string is its credential (Postgres or MySQL).
  const isDb = sourceType === 'postgres' || sourceType === 'mysql';
  let rawUrl = val(sourceType);
  let token = val('token');
  /* The connection string carries the database password and --token is an API
     credential, so both can come from stdin instead of argv (the same
     --secret-stdin as credential set): the connection string for a database,
     the bearer token otherwise. */
  if (args.includes('--secret-stdin')) {
    if (isDb ? rawUrl : token) fail(`pass the ${isDb ? 'connection string' : 'token'} on stdin or as an argument, not both`);
    const secret = await readSecretStdin();
    if (isDb) rawUrl = secret; else token = secret;
  } else if (isDb ? rawUrl : token) {
    process.stderr.write(`warning: ${isDb ? `--${sourceType}` : '--token'} leaves the secret in shell history and visible to other processes. Use --secret-stdin instead.\n`);
  }
  if (!rawUrl) fail(`--${sourceType} needs a ${isDb ? 'connection string (or --secret-stdin)' : 'URL'}`);
  const auth = isDb ? { connectionString: rawUrl }
    : token ? { type: 'bearer', token } : undefined;
  // A connection string carries the password. It travels ONLY inside `auth`
  // (sealed at rest server-side); source_url gets a redacted form, since that
  // column is echoed back by list/detail endpoints and shown in the console.
  const sourceUrl = isDb ? redactConn(rawUrl) : rawUrl;

  /* Repeat-safe: a server with this name is reused, never duplicated, so a coding
     agent (or a person) can run the same push again. It is read again from its
     source; which tools are exposed is left as it is, since someone may have
     chosen them. A name already used for a different kind of source stops here. */
  const existing = ((await api('GET', '/servers')).servers || []).find((s) => s.name === name);
  if (existing && existing.source_type !== sourceType) {
    const kind = { openapi: 'an OpenAPI spec', postgres: 'a Postgres database', mysql: 'a MySQL or MariaDB database', mcp: 'a remote MCP server' }[existing.source_type] || 'another kind of source';
    fail(`a server named "${name}" already exists for ${kind}. Use another name, or delete that server first.`);
  }
  let server = existing;
  if (existing) {
    say(`${name} already exists (${existing.id}), reading its source again…`);
  } else {
    say(`creating ${name} (${sourceType})…`);
    const created = await api('POST', '/servers', { name, sourceType, sourceUrl, auth });
    server = created.server || created;
    say(`introspecting…`);
  }
  /* Certificate choice for a database source, the same two the console offers:
     verify against the provider's CA, or connect without checking (explicit). */
  const caFile = val('ca-file');
  if (caFile) {
    const { readFileSync } = await import('node:fs');
    let caPem;
    try { caPem = readFileSync(caFile, 'utf8'); } catch { fail(`cannot read --ca-file ${caFile}`); }
    await api('PATCH', `/servers/${server.id}/tls`, { mode: 'verify', caPem });
    say('certificate will be checked against the CA you gave');
  } else if (args.includes('--no-verify-tls')) {
    await api('PATCH', `/servers/${server.id}/tls`, { mode: 'skip', acknowledge: true });
    say('warning: connecting without checking the database certificate (the connection is still encrypted)');
  }
  const intro = await api('POST', `/servers/${server.id}/introspect`);
  const held = (intro?.pending || intro?.server?.pending)?.changes?.exposedAndChanged || [];
  const detail = await api('GET', `/servers/${server.id}`);
  const tools = detail.server?.tools || detail.tools || [];
  /* Exposure is chosen here only for a server that has never gone live (new, or an
     earlier push that stopped at the certificate step); a live server keeps the
     tools someone chose. */
  const neverLive = !existing || existing.state !== 'live';
  /* --read-only exposes only operations that read (GET and HEAD from an API spec;
     every database tool is a read). Writes stay off until someone chooses them, which
     is what a coding agent should do by default. Without the flag, all are exposed as
     before. */
  const READS = new Set(['GET', 'HEAD', 'SELECT']);
  const toExpose = args.includes('--read-only') ? tools.filter((t) => READS.has(String(t.method || '').toUpperCase())) : tools;
  const leftOff = tools.length - toExpose.length;
  if (neverLive) {
    say(`exposing ${toExpose.length} tool${toExpose.length === 1 ? '' : 's'}${leftOff ? ` (${leftOff} that write left off)` : ''}…`);
    for (const t of toExpose) await api('PATCH', `/servers/${server.id}/tools/${t.id}`, { exposed: true });
  }
  const state = detail.server?.state || detail.state;
  if (state !== 'live') await api('POST', `/servers/${server.id}/publish`);
  const endpoint = gatewayUrl(server.slug);
  const exposed = neverLive ? toExpose.length : tools.filter((t) => t.exposed).length;
  say(`\nLIVE  ${endpoint}`);
  if (held.length) {
    say(`held: ${held.join(', ')} changed meaning and is NOT being served yet. release with: kaiva-bridge promote ${server.id}`);
    process.exitCode = 3;
  }
  say(`\nnext: kaiva-bridge key ${server.id} --label <client> --replace   (a gateway key for your agent)`);
  out({ id: server.id, name, slug: server.slug, endpoint, sourceType, reused: !!existing, tools: tools.length, exposed, writesLeftOff: neverLive ? leftOff : 0, held });
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

  /* The setup skill for coding agents ships inside this package. Installing it
     copies SKILL.md into Claude Code's skills folder (the user's, or this project's
     with --project); running it again overwrites, so it is safe to repeat. */
  if (cmd === 'skill') {
    if (args[0] !== 'install') fail('usage: kaiva-bridge skill install [--project]');
    const { readFileSync, mkdirSync, writeFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { homedir } = await import('node:os');
    const body = readFileSync(new URL('../skills/kaiva-bridge/SKILL.md', import.meta.url), 'utf8');
    const dir = join(args.includes('--project') ? process.cwd() : homedir(), '.claude', 'skills', 'kaiva-bridge');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), body);
    say(`installed the Kaiva Bridge skill: ${join(dir, 'SKILL.md')}`);
    say('ask your coding agent: "connect my database to Claude Code with Kaiva Bridge"');
    return;
  }

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
    if (!args[0]) fail('usage: kaiva-bridge key <server-id> [--label L] [--replace]');
    const label = flag(args, 'label') || 'cli-key';
    /* --replace keeps one key per label per server: an earlier key with this label
       for this server is revoked before the new one is made, so running setup
       again does not leave old keys behind. Only keys scoped to exactly this one
       server are touched. */
    let replaced = 0;
    if (args.includes('--replace')) {
      const all = (await api('GET', '/keys')).keys || [];
      for (const k of all) {
        const ids = k.server_ids || [];
        if (k.label === label && !k.revoked_at && ids.length === 1 && ids[0] === args[0]) {
          await api('DELETE', `/keys/${k.id}`);
          replaced += 1;
        }
      }
      if (replaced) say(`revoked ${replaced} earlier key${replaced === 1 ? '' : 's'} labelled "${label}"`);
    }
    const r = await api('POST', '/keys', { label, serverIds: [args[0]] });
    const raw = r.key.key || r.key.raw;
    // With --json the key is only in the JSON result, never also printed to the terminal.
    if (!JSON_MODE) say(`key (shown once): ${raw || JSON.stringify(r.key)}`);
    out({ key: raw, id: r.key.id, label, serverId: args[0], replaced });
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

  /* credential — set the credential a server sends upstream, and test it.

     Here because the console was the only place to do either. A team creating
     servers from CI could set a credential at creation and never again, so when an
     API started refusing it their only route back was a browser. In production that
     meant days of 401s with nothing saying which of the two was wrong: the value,
     or the KIND. */
  if (cmd === 'credential') {
    const sub = args[0];
    const server = args[1];
    if (sub === 'test') {
      if (!server) fail('usage: kaiva-bridge credential test <server-id>');
      const r = await api('POST', `/servers/${server}/upstream-auth/test`);
      say(`${r.ok ? 'OK' : 'FAILED'}  ${r.title}`);
      if (r.message) say(`        ${r.message}`);
      if (!r.ok && !r.inconclusive && !r.untestable) process.exitCode = 1;
      return;
    }
    if (sub === 'set') {
      if (!server) fail("usage: kaiva-bridge credential set <server-id> --type bearer --token …");
      const type = (flag(args, 'type') || 'bearer').toLowerCase();
      const secretFlag = { bearer: 'token', basic: 'password', header: 'value', query: 'value' }[type];
      if (type !== 'none' && !secretFlag) fail(`unknown --type ${type}: use bearer, basic, header, query or none`);
      let secret;
      if (secretFlag && args.includes('--secret-stdin')) {
        secret = await readSecretStdin();
      } else if (secretFlag) {
        secret = flag(args, secretFlag);
        if (secret) process.stderr.write(`warning: --${secretFlag} leaves the secret in shell history and visible to other processes. Use --secret-stdin instead.\n`);
      }
      if (secretFlag && !secret) fail(`no ${secretFlag} given. Pipe it in with --secret-stdin, or pass --${secretFlag}`);
      let auth = null;
      if (type === 'bearer') auth = { type, token: secret };
      else if (type === 'basic') auth = { type, username: flag(args, 'username'), password: secret };
      else if (type === 'header' || type === 'query') auth = { type, name: flag(args, 'name'), value: secret };
      const r = await api('PUT', `/servers/${server}/upstream-auth`, { auth });
      say(auth ? `credential saved (${r.credential ? r.credential.label : type})` : 'credential removed');
      // Saving proves nothing on its own, so the API is asked straight away. The
      // same call the console makes when you press Save and test.
      const t = await api('POST', `/servers/${server}/upstream-auth/test`);
      say(`${t.ok ? 'OK' : 'FAILED'}  ${t.title}`);
      if (t.message) say(`        ${t.message}`);
      if (!t.ok && !t.inconclusive && !t.untestable) process.exitCode = 1;
      return;
    }
    fail("usage: kaiva-bridge credential set|test <server-id> [--type bearer|basic|header|query|none] …");
  }

  fail(`unknown command '${cmd}' — run: kaiva-bridge help`);
}

main().catch((e) => fail(e.message));
