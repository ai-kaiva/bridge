#!/usr/bin/env node
// Copyright (c) 2026 SLATEAI LIMITED t/a Kaiva. MIT licensed — see LICENSE.
// Kaiva Bridge CLI — thin client for the Management REST API (/api/bridge/v1).
// Auth: `kaiva-bridge login` (approve this machine in the console), or
// KAIVA_BRIDGE_TOKEN (a kv_mgmt_ management key) for CI, which wins when set.
// Base URL override: KAIVA_BRIDGE_URL. Zero dependencies (Node 18+).
/* global process, fetch */
import { readFileSync, writeFileSync, mkdirSync, rmSync, chmodSync, renameSync, statSync, lstatSync, openSync, closeSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir, hostname } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

// Trailing slashes off in one pass: a trailing-run regex is quadratic on a long run of them.
const trimSlashes = (s) => { let i = s.length; while (i > 0 && s[i - 1] === '/') i -= 1; return s.slice(0, i); };
const BASE = trimSlashes(process.env.KAIVA_BRIDGE_URL || 'https://api.kaiv.ai/api/bridge/v1');
const ROOT = BASE.replace(/\/api\/bridge\/v1$/, '');

/* A login is saved per API address, in a file only this user can read
   (directory 0700, file 0600, like ~/.ssh). A key saved for one address is never
   sent to another: point KAIVA_BRIDGE_URL somewhere else and it is simply not
   signed in there. KAIVA_BRIDGE_CONFIG_DIR moves the file (tests, several setups). */
const CONFIG_DIR = process.env.KAIVA_BRIDGE_CONFIG_DIR
  || (process.platform === 'win32' && process.env.APPDATA ? join(process.env.APPDATA, 'kaiva-bridge')
    : join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'kaiva-bridge'));
const CRED_FILE = join(CONFIG_DIR, 'credentials.json');
function readSaved() {
  try {
    const d = JSON.parse(readFileSync(CRED_FILE, 'utf8'));
    if (d && typeof d === 'object' && d.logins && typeof d.logins === 'object' && !Array.isArray(d.logins)) return d;
  } catch { /* none yet, or unreadable: treated as not signed in */ }
  return { logins: {} };
}
function writeSaved(data) {
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  /* Written to a new, unpredictable file (exclusive create: an existing file or link
     there is refused, never followed), created 0600 so the key is never readable by
     others, then renamed over the old one. A crash never leaves half a file. */
  const tmp = `${CRED_FILE}.${process.pid}.${Date.now().toString(36)}${Math.random().toString(36).slice(2)}.tmp`;
  const fd = openSync(tmp, 'wx', 0o600);
  try { writeFileSync(fd, `${JSON.stringify(data, null, 2)}\n`); } finally { closeSync(fd); }
  try { chmodSync(tmp, 0o600); } catch { /* Windows: per-user profile folder */ }
  renameSync(tmp, CRED_FILE);
}
const savedLogin = (() => {
  const all = readSaved().logins;
  const e = Object.prototype.hasOwnProperty.call(all, BASE) ? all[BASE] : null;
  return e && typeof e.token === 'string' && e.token.startsWith('kv_mgmt_') ? e : null;
})();
const ENV_TOKEN = process.env.KAIVA_BRIDGE_TOKEN || '';
const TOKEN = ENV_TOKEN || (savedLogin ? savedLogin.token : '');

// The token is a real credential — never send it anywhere but Kaiva over TLS.
// A tampered/mistyped KAIVA_BRIDGE_URL (http://, or someone else's host) would
// otherwise exfiltrate it on the first command. localhost stays allowed for
// local development against a dev backend.
(function assertSafeBase() {
  let u;
  try { u = new URL(BASE); } catch { console.error('error: KAIVA_BRIDGE_URL is not a valid URL'); process.exit(1); }
  const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '::1';
  if (u.protocol !== 'https:' && !local) {
    console.error(plain(`error: refusing to send your token over ${u.protocol}// — KAIVA_BRIDGE_URL must use https (localhost excepted for development).`));
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
  kaiva-bridge push <name> --docs <file|folder>...   PDF, Word, PNG, JPEG, text or Markdown files, searchable by your AI
      waits until each file is read and the server is live; add --no-wait to return once they are sent
      the same file name again replaces that document with the new version
      add --secret-stdin to read the connection string (or, for --openapi/--mcp, the
      --token) from stdin: printf %s "$DATABASE_URL" | kaiva-bridge push db --postgres --secret-stdin
      a database whose certificate is self-signed: add --ca-file <provider-ca.pem>, or --no-verify-tls
  kaiva-bridge skill install [--project]            add the setup skill for coding agents (Claude Code)
  kaiva-bridge install <server> --client claude-code|cursor   add a live server to an AI client's config
      claude-code: this folder's .mcp.json (--global: all projects); cursor: ~/.cursor/mcp.json (--project: this folder)
      the client signs in with your Kaiva account; --key writes a key for this one server instead
      --dry-run shows the change without making it; running it again changes nothing
  kaiva-bridge uninstall <server> --client claude-code|cursor  remove it again (and revoke a key it added)
  kaiva-bridge doctor <server> [--call <tool> [--args '{}']]  check sign-in, publication, the MCP handshake and tool list
      each step passes, fails with the fix, or says it did not run; --call makes one call with a tool that reads
      uses a temporary key for this server (revoked at the end), or a gateway key piped in with --key-stdin
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
  --json    progress to stderr, one JSON result on stdout (push, key, install, whoami, doctor)

AUTH
  kaiva-bridge login [--no-browser]     approve this machine in the console (owner or admin); saves a key for it
  kaiva-bridge whoami                   the workspace, account and key in use
  kaiva-bridge logout                   revoke this machine's key and remove it
  export KAIVA_BRIDGE_TOKEN=kv_mgmt_... for CI and scripts; used instead of a saved login when set
                                        (console -> Keys & access -> New key -> Management)
  export KAIVA_BRIDGE_URL=...           optional; defaults to https://api.kaiv.ai/api/bridge/v1
`;

// Progress goes to stdout, errors to stderr — but stdout is buffered when piped,
// so flush it before exiting or the error prints ahead of the progress lines.
// Tool names, server names and error text come from the server and from the APIs
// it wraps, so they reach the terminal only as plain text: control characters
// (escape sequences that move the cursor, rewrite lines or retitle the window)
// and bidi overrides become '?'. Newlines and tabs are kept for layout.
// A declaration, not a const: the address check at the top of the file prints through it.
function plain(s) { return String(s).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, '?'); }
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
  if (!TOKEN) fail('not signed in. Run: kaiva-bridge login   (CI: set KAIVA_BRIDGE_TOKEN to a management key)');
  const res = await fetch(`${BASE}${path}`, {
    redirect: 'error', // the key is for this address only: a redirect is refused, never followed
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty */ }
  /* A database whose certificate could not be checked: say how to go on from the
     command line, as the console's certificate panel does. */
  const tlsHint = data?.tls ? '\nadd --ca-file <provider-ca.pem> to check it against your provider\'s CA, or --no-verify-tls to connect without checking the certificate' : '';
  /* A saved login that stopped working (revoked, or its approver is no longer an
     admin) says how to get a new one; the server's own text is about console keys. */
  const relogin = res.status === 401 && !ENV_TOKEN && savedLogin ? '\nyour saved login no longer works: run kaiva-bridge login' : '';
  if (!res.ok) fail(`${res.status} ${data?.error || ''}${data?.message ? ` — ${data.message}` : ''}${tlsHint}${relogin}`);
  return data;
}

const gatewayUrl = (slug) => `${ROOT}/api/bridge/mcp/${slug}`;

// postgres://user:secret@host:5432/db → postgres://user:***@host:5432/db
const redactConn = (conn) => String(conn).replace(/\/\/([^:/@]+):[^@]*@/, '//$1:***@');

async function push(args) {
  const name = args[0];
  if (!name || name.startsWith('--')) fail('usage: kaiva-bridge push <name> --openapi <url> | --mcp <url> | --postgres <conn> | --docs <files>');
  if (args.includes('--docs')) return pushDocs(name, args);
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
    process.stderr.write(plain(`warning: ${isDb ? `--${sourceType}` : '--token'} leaves the secret in shell history and visible to other processes. Use --secret-stdin instead.\n`));
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

/* Documents: a documents server, then each file sent one at a time (as the console
   does), then, unless --no-wait, a wait until every file has been read. The server goes
   live by itself with its first ready document. Repeat-safe like the other sources: the
   same name reuses the server, and a file name already there becomes its new version. */
const DOC_EXT = new Set(['.pdf', '.docx', '.png', '.jpg', '.jpeg', '.txt', '.md', '.markdown']);
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
async function pushDocs(name, args) {
  const { readFileSync, statSync, readdirSync } = await import('node:fs');
  const path = await import('node:path');
  const given = [];
  for (let j = args.indexOf('--docs') + 1; j < args.length && !args[j].startsWith('--'); j += 1) given.push(args[j]);
  if (!given.length) fail('--docs needs one or more files or folders: kaiva-bridge push handbook --docs ./policies');
  const files = [];
  for (const g of given) {
    let st;
    try { st = statSync(g); } catch { fail(`cannot read ${g}`); }
    if (st.isDirectory()) {
      for (const f of readdirSync(g).sort()) {
        const fp = path.join(g, f);
        if (DOC_EXT.has(path.extname(f).toLowerCase()) && statSync(fp).isFile()) files.push(fp);
      }
    } else files.push(g);
  }
  if (!files.length) fail('no PDF, Word, PNG, JPEG, text or Markdown files found there');

  const existing = ((await api('GET', '/servers')).servers || []).find((s) => s.name === name);
  if (existing && existing.source_type !== 'documents') fail(`a server named "${name}" already exists for another kind of source. Use another name, or delete that server first.`);
  let server = existing;
  if (existing) say(`${name} already exists (${existing.id}), adding files…`);
  else {
    say(`creating ${name} (documents)…`);
    server = (await api('POST', '/documents/servers', { name })).server;
  }

  const sent = [];
  const refused = [];
  for (const f of files) {
    const base = path.basename(f);
    for (let attempt = 0; ; attempt += 1) {
      const form = new FormData();
      form.append('file', new Blob([readFileSync(f)]), base);
      const res = await fetch(`${BASE}/documents/servers/${server.id}/documents`, { redirect: 'error', method: 'POST', headers: { Authorization: `Bearer ${TOKEN}` }, body: form });
      let data = null;
      try { data = await res.json(); } catch { /* empty */ }
      // Sent too fast: the console waits and tries again, and so does this.
      if (res.status === 429 && attempt < 6) { say('  pausing a moment (upload rate)…'); await sleep(15000); continue; }
      if (!res.ok) {
        const error = data?.message || data?.error || `HTTP ${res.status}`;
        refused.push({ file: base, error });
        say(`  not accepted: ${base}: ${error}`);
      } else {
        sent.push({ file: base, id: data.document.id });
        say(`  sent ${base}`);
      }
      break;
    }
  }

  let docs = [];
  if (sent.length && !args.includes('--no-wait')) {
    say(`reading ${sent.length} file${sent.length === 1 ? '' : 's'}…`);
    const ids = new Set(sent.map((x) => x.id));
    const until = Date.now() + 30 * 60 * 1000;
    const shown = new Map();
    for (;;) {
      docs = ((await api('GET', `/documents/servers/${server.id}`)).documents || []).filter((d) => ids.has(d.id));
      for (const d of docs) {
        const where = d.pending_version === null ? (d.state === 'failed' ? 'failed' : 'ready') : (/^\d+\/\d+$/.test(d.phase || '') ? `page ${d.phase.replace('/', ' of ')}` : (d.phase || 'queued'));
        if (shown.get(d.id) !== where) { shown.set(d.id, where); say(`  ${d.name}: ${where}`); }
      }
      if (docs.length && docs.every((d) => d.pending_version === null)) break;
      if (Date.now() > until) { say('still reading after 30 minutes; check the console for the rest'); break; }
      await sleep(3000);
    }
  }

  const detail = await api('GET', `/servers/${server.id}`);
  const state = detail.server?.state || detail.state;
  const endpoint = gatewayUrl(server.slug);
  const failed = docs.filter((d) => d.state === 'failed');
  if (state === 'live') say(`\nLIVE  ${endpoint}`);
  else if (docs.some((d) => d.live_version > 0)) say(`\nready, but not live: your plan has no free server slot. Free one up, then: kaiva-bridge publish ${server.id}`);
  else say(`\nthe server goes live at ${endpoint} once its first document is ready`);
  for (const d of failed) say(`failed: ${d.name}: ${d.error || 'could not be read'}`);
  if (state === 'live') say(`\nnext: kaiva-bridge key ${server.id} --label <client> --replace   (a gateway key for your agent)`);
  if (refused.length || failed.length) process.exitCode = 1;
  out({
    id: server.id, name, slug: server.slug, endpoint, sourceType: 'documents', reused: !!existing, live: state === 'live',
    documents: sent.map((x) => { const d = docs.find((y) => y.id === x.id); return { file: x.file, id: x.id, state: d ? (d.pending_version === null ? d.state : 'reading') : 'sent', pages: d ? d.pages : null, error: d?.error || null }; }),
    refused,
  });
}

// GET /servers/:id returns the server with its tools. The management route passes
// through whatever the service returned, so accept both shapes.
async function fetchTools(serverId) {
  const r = await api('GET', `/servers/${serverId}`);
  const s = r.server || r;
  return s.tools || [];
}

/* ── login / logout ────────────────────────────────────────────────────────
   Device sign-in: this machine asks for a code, a person approves the code in the
   console, and the next poll collects a management key, once. The browser page is
   opened at a fixed address and the code is typed there, never put in a link. */
const CONSOLE = trimSlashes(process.env.KAIVA_BRIDGE_CONSOLE_URL
  || (new URL(ROOT).hostname === 'api.kaiv.ai' ? 'https://app.kaiv.ai' : ROOT));

function openBrowser(url) {
  const [bin, argv] = process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]]
      : ['xdg-open', [url]];
  try {
    const child = spawn(bin, argv, { stdio: 'ignore', detached: true });
    child.on('error', () => {}); // no browser here: the address is printed anyway
    child.unref();
  } catch { /* printed anyway */ }
}

async function cliAuth(path, body) {
  const res = await fetch(`${ROOT}/api/bridge/cli-auth/${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty */ }
  return { res, data };
}

async function login(args) {
  if (ENV_TOKEN) process.stderr.write('note: KAIVA_BRIDGE_TOKEN is set, so commands in this shell keep using it until you unset it.\n');
  const { res, data } = await cliAuth('start', { client: hostname() });
  if (!res.ok || !data?.deviceCode) fail(`could not start a login: ${data?.message || res.status}`);
  const page = `${CONSOLE}/bridge/app/cli`;
  say(`Your code: ${data.userCode}`);
  say(`Approve it at ${page} (you must be an owner or admin of the workspace).`);
  if (!args.includes('--no-browser') && process.stdout.isTTY && !process.env.CI) openBrowser(page);
  say('Waiting for approval...');
  let wait = Math.max(1, Number(data.interval) || 3) * 1000;
  const until = Date.now() + (Number(data.expiresIn) || 600) * 1000;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, wait));
    let poll;
    try { poll = await cliAuth('poll', { deviceCode: data.deviceCode }); } catch { continue; } // a network blip: try again
    if (poll.res.status === 429) { wait += 3000; continue; }
    if (!poll.res.ok) continue;
    const st = poll.data?.status;
    if (st === 'pending') continue;
    if (st === 'approved' && typeof poll.data.key === 'string' && poll.data.key.startsWith('kv_mgmt_')) {
      const all = readSaved();
      const previous = Object.prototype.hasOwnProperty.call(all.logins, BASE) ? all.logins[BASE] : null;
      all.logins[BASE] = { token: poll.data.key, workspace: poll.data.workspace || null, label: poll.data.keyLabel || null, savedAt: new Date().toISOString() };
      writeSaved(all);
      /* Signing in again (perhaps as someone else) must not leave the earlier key
         working: it is revoked once the new one is safely saved. Best effort; a
         key the server already refuses needs nothing more. */
      if (previous && typeof previous.token === 'string' && previous.token !== poll.data.key) {
        try {
          const res = await fetch(`${BASE}/session`, { redirect: 'error', method: 'DELETE', headers: { Authorization: `Bearer ${previous.token}` } });
          if (!res.ok && res.status !== 401) process.stderr.write(plain(`warning: the previous key "${previous.label || 'CLI'}" could not be revoked (${res.status}). Revoke it in the console under Keys & access.\n`));
        } catch {
          process.stderr.write(plain(`warning: the previous key "${previous.label || 'CLI'}" could not be revoked. Revoke it in the console under Keys & access.\n`));
        }
      }
      const name = poll.data.workspace?.name || poll.data.workspace?.id || 'your workspace';
      say(`Signed in to ${name}. Key saved to ${CRED_FILE}`);
      out({ workspace: poll.data.workspace || null, keyLabel: poll.data.keyLabel || null, credentials: CRED_FILE });
      return;
    }
    if (st === 'denied') fail('the sign-in was denied in the console.');
    if (st === 'expired') fail('the code expired. Run kaiva-bridge login again.');
    if (st === 'used') fail('this code was already used. Run kaiva-bridge login again.');
    fail('this login is no longer valid. Run kaiva-bridge login again.');
  }
  fail('the code expired before it was approved. Run kaiva-bridge login again.');
}

async function logout() {
  const all = readSaved();
  const entry = Object.prototype.hasOwnProperty.call(all.logins, BASE) ? all.logins[BASE] : null;
  if (!entry) {
    say(`not signed in on this machine for ${BASE}.`);
  } else {
    // Revoke the key first, so it stops working even if it was copied. A key the
    // server already refuses (revoked in the console) is just removed here.
    let revoked = false;
    try {
      const res = await fetch(`${BASE}/session`, { redirect: 'error', method: 'DELETE', headers: { Authorization: `Bearer ${entry.token}` } });
      revoked = res.ok;
      if (!res.ok && res.status !== 401) process.stderr.write(plain(`warning: the key could not be revoked (${res.status}). Revoke "${entry.label || 'CLI'}" in the console under Keys & access.\n`));
    } catch {
      process.stderr.write(plain(`warning: could not reach Kaiva to revoke the key. Revoke "${entry.label || 'CLI'}" in the console under Keys & access.\n`));
    }
    delete all.logins[BASE];
    if (Object.keys(all.logins).length) writeSaved(all); else rmSync(CRED_FILE, { force: true });
    say(revoked ? 'Signed out. The key is revoked and removed from this machine.' : 'Signed out. The key is removed from this machine.');
  }
  if (ENV_TOKEN) say('KAIVA_BRIDGE_TOKEN is still set in this shell; unset it to stop using that key.');
}

/* ── install / uninstall: put a server into an AI client's own config ──────
   Two clients, each in its own documented config format:
     claude-code  ./.mcp.json (project; Claude Code asks once before using it), or
                  --global: user scope through Claude Code's own `claude mcp` command
     cursor       ~/.cursor/mcp.json (all projects), or --project: ./.cursor/mcp.json
   By default the entry holds only the server's address: the client signs in with
   the person's Kaiva account (OAuth) the first time, so no secret is written to
   disk. --key writes a gateway key scoped to this one server instead. A management
   key is never written: this CLI's own login is not the client's.
   Repeat-safe: an entry already pointing at this server is left as it is. Other
   entries in the file are kept exactly; the previous file is saved beside it. */
const CLIENTS = {
  'claude-code': {
    label: 'Claude Code',
    file: (o) => (o.global ? null : join(process.cwd(), '.mcp.json')),
    entry: (url, key) => ({ type: 'http', url, ...(key ? { headers: { Authorization: `Bearer ${key}` } } : {}) }),
    signIn: (name) => `In Claude Code, run /mcp, choose ${name} and sign in with your Kaiva Bridge account.`,
  },
  cursor: {
    label: 'Cursor',
    file: (o) => (o.project ? join(process.cwd(), '.cursor', 'mcp.json') : join(homedir(), '.cursor', 'mcp.json')),
    entry: (url, key) => ({ url, ...(key ? { headers: { Authorization: `Bearer ${key}` } } : {}) }),
    signIn: (name) => `In Cursor, open Settings, then MCP, and click Connect next to ${name} to sign in with your Kaiva Bridge account.`,
  },
};
/* One key per installation: the client, this machine and the config file it was
   written into. A shared label let one machine's uninstall or re-install revoke
   another machine's key for the same server. */
const installKeyLabel = (client, file) => {
  const where = createHash('sha256').update(`${hostname()}\0${file || 'global'}`).digest('hex').slice(0, 10);
  return `${client} · ${String(hostname()).slice(0, 40)} · ${where} (kaiva-bridge install)`;
};

/* Clients this command does not write to (yet). Saying "installed" for them would
   be false, so they get the steps to do it by hand and a non-zero exit (2). */
const MANUAL_CLIENTS = {
  // The same steps and snippets as the console's Connect tab.
  codex: (name, url) => `Add to ~/.codex/config.toml:\n\n[mcp_servers.${name}]\nurl = "${url}"\nhttp_headers = { "Authorization" = "Bearer <key>" }\n\nMake the key with: kaiva-bridge key <server> --label codex --replace`,
  vscode: (name, url) => `Add to .vscode/mcp.json:\n\n{ "servers": { "${name}": { "type": "http", "url": "${url}", "headers": { "Authorization": "Bearer <key>" } } } }\n\nMake the key with: kaiva-bridge key <server> --label vscode --replace`,
  'claude-desktop': (name, url) => `Claude on the web or desktop. No key needed.\n1. Open Settings → Connectors → Add → Add custom connector.\n2. Paste this as the connector URL, then click Add (leave advanced settings empty):\n   ${url}\n3. Click Connect and sign in with your Kaiva Bridge account.`,
  chatgpt: (name, url) => `ChatGPT. No key needed.\n1. Open Settings → Security and login, and turn on Developer mode.\n2. Go to ChatGPT Plugins, click +, and give it a name.\n3. Under Connection, paste this as the MCP server URL:\n   ${url}\n4. If asked how to authenticate, choose OAuth, then sign in with your Kaiva Bridge account.`,
};
async function manualInstall(ref, client, remove) {
  const server = await resolveServer(ref);
  const url = gatewayUrl(server.slug);
  say(`kaiva-bridge does not ${remove ? 'remove servers from' : 'install into'} ${client} yet. Nothing was changed.`);
  if (!remove) { say(''); say(MANUAL_CLIENTS[client](entryName(server.name) || server.slug, url)); }
  out({ client, installed: false, url, manual: true });
  process.exitCode = 2;
}
const entryName = (s) => (String(s || '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48));

async function resolveServer(ref) {
  const list = (await api('GET', '/servers')).servers || [];
  const hits = list.filter((s) => s.id === ref || s.slug === ref || s.name === ref);
  if (!hits.length) fail(`no server "${ref}" in this workspace. Run: kaiva-bridge servers`);
  if (hits.length > 1) fail(`"${ref}" matches ${hits.length} servers. Use its id: kaiva-bridge servers`);
  return hits[0];
}

function readClientConfig(file) {
  /* A config file or folder that is a link could point anywhere: at another
     project, or at this CLI's own saved key, whose JSON would then be copied into
     the project's file. The folder and file must be real, not links. */
  for (const p of [dirname(file), file]) {
    let st = null;
    try { st = lstatSync(p); } catch { /* not there yet: created as a real one */ }
    if (st && st.isSymbolicLink()) fail(`${p} is a link to somewhere else, so it was left unchanged. Edit the real file, or remove the link, and run this again.`);
    if (st && p === file && !st.isFile()) fail(`${file} is not a regular file, so it was left unchanged.`);
  }
  let raw;
  try { raw = readFileSync(file, 'utf8'); } catch (e) {
    if (e.code === 'ENOENT') return { data: { mcpServers: {} }, existed: false };
    fail(`could not read ${file}: ${e.message}`);
  }
  let data;
  try { data = raw.trim() ? JSON.parse(raw) : {}; } catch {
    fail(`${file} is not valid JSON, so it was left unchanged. Fix it, or remove it, and run this again.`);
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) fail(`${file} does not hold a JSON object, so it was left unchanged.`);
  if (data.mcpServers == null) data.mcpServers = {};
  if (typeof data.mcpServers !== 'object' || Array.isArray(data.mcpServers)) fail(`"mcpServers" in ${file} is not an object, so the file was left unchanged.`);
  return { data, existed: true, raw };
}

function writeClientConfig(file, data, { existed, raw, secret }) {
  mkdirSync(dirname(file), { recursive: true });
  let mode = secret ? 0o600 : 0o644;
  if (existed) {
    try { mode = statSync(file).mode & 0o777; } catch { /* keep default */ }
    if (secret) mode &= 0o700; // a key in it: nobody else reads it from now on
  }
  /* BR-067: every file is written fresh under an unpredictable name with exclusive
     create, which refuses an existing file or link rather than following it, then
     renamed into place. A rename replaces a link that sits at the backup or config
     name; it never writes through it. */
  const fresh = (suffix, body, m) => {
    const name = `${file}.${process.pid}.${Date.now().toString(36)}${Math.random().toString(36).slice(2)}.${suffix}`;
    const fd = openSync(name, 'wx', m);
    try { writeFileSync(fd, body); } finally { closeSync(fd); }
    try { chmodSync(name, m); } catch { /* Windows */ }
    return name;
  };
  if (existed) renameSync(fresh('bak', raw, mode & 0o600), `${file}.kaiva-bridge.bak`);
  renameSync(fresh('tmp', `${JSON.stringify(data, null, 2)}\n`, mode), file);
}

const urlOf = (entry) => (entry && typeof entry === 'object' ? entry.url : undefined);

async function install(args, { remove = false } = {}) {
  const ref = args[0];
  const client = flag(args, 'client');
  const verb = remove ? 'uninstall' : 'install';
  if (!ref || ref.startsWith('--') || !client) fail(`usage: kaiva-bridge ${verb} <server> --client ${Object.keys(CLIENTS).join('|')} [--name N]${remove ? '' : ' [--key] [--dry-run]'} [--global|--project]`);
  const c = Object.prototype.hasOwnProperty.call(CLIENTS, client) ? CLIENTS[client] : null;
  if (!c && Object.prototype.hasOwnProperty.call(MANUAL_CLIENTS, client)) return manualInstall(ref, client, remove);
  if (!c) fail(`unknown client "${client}". Installs into: ${Object.keys(CLIENTS).join(', ')}. Steps to follow by hand: ${Object.keys(MANUAL_CLIENTS).join(', ')}`);
  const opts = { global: args.includes('--global'), project: args.includes('--project') };
  if (opts.global && client !== 'claude-code') fail('--global is for claude-code; cursor is global by default (use --project for this folder only)');
  if (opts.project && client !== 'cursor') fail('--project is for cursor; claude-code writes this folder\'s .mcp.json by default (use --global for all projects)');
  const dry = args.includes('--dry-run');
  const useKey = args.includes('--key');
  /* `claude mcp add-json` takes the entry as an argument, where any process on the
     machine can read it (ps). A key never travels that way: sign in instead. */
  if (opts.global && useKey) fail('--key cannot be used with --global (the key would pass through the command line). Leave out --key and sign in from Claude Code, or write this folder\'s .mcp.json.');

  const server = await resolveServer(ref);
  if (!remove && server.state !== 'live') fail(`${server.name} is not live yet, so a client could not reach it. Publish it first: kaiva-bridge publish ${server.id}`);
  const url = gatewayUrl(server.slug);
  const name = entryName(flag(args, 'name') || server.name) || entryName(server.slug);

  // Claude Code's user scope belongs to Claude Code: change it through its own command.
  if (opts.global) {
    const claude = (a) => spawnSync('claude', a, { encoding: 'utf8' });
    const probe = claude(['mcp', 'get', name]);
    if (probe.error) fail('the claude command was not found. Install Claude Code, or leave out --global to write this folder\'s .mcp.json.');
    const present = probe.status === 0;
    const pointsHere = present && String(probe.stdout).includes(url);
    if (remove) {
      if (!present) { say(`${name} is not in Claude Code's user settings. Nothing to remove.`); return; }
      if (!pointsHere) fail(`${name} in Claude Code points somewhere else, so it was left as it is.`);
      if (dry) { say(`would run: claude mcp remove ${name} --scope user`); return; }
      const r = claude(['mcp', 'remove', name, '--scope', 'user']);
      if (r.status !== 0) fail(`claude mcp remove failed: ${(r.stderr || r.stdout || '').trim()}`);
      say(`Removed ${name} from Claude Code (all projects).`);
      return;
    }
    if (present && pointsHere) { say(`${name} is already in Claude Code (all projects). Nothing changed.`); return; }
    if (present) fail(`Claude Code already has a server called ${name} that points somewhere else. Choose another name with --name.`);
    const json = JSON.stringify(c.entry(url, null));
    if (dry) { say(`would run: claude mcp add-json --scope user ${name} '${json}'`); return; }
    const r = claude(['mcp', 'add-json', '--scope', 'user', name, json]);
    if (r.status !== 0) fail(`claude mcp add-json failed: ${(r.stderr || r.stdout || '').trim()}`);
    say(`Added ${name} to Claude Code (all projects).`);
    say(c.signIn(name));
    say(`Undo: kaiva-bridge uninstall ${server.id} --client ${client} --global`);
    out({ client, name, url, scope: 'user', key: false });
    return;
  }

  const file = c.file(opts);
  const cfg = readClientConfig(file);
  const servers = cfg.data.mcpServers;
  const own = (k) => Object.prototype.hasOwnProperty.call(servers, k);
  // Already there under any name: that is the entry, never a second one.
  const existing = Object.keys(servers).find((k) => urlOf(servers[k]) === url);

  if (remove) {
    const target = flag(args, 'name') ? (own(name) ? name : null) : existing;
    if (!target) { say(`${server.name} is not in ${file}. Nothing to remove.`); return; }
    if (urlOf(servers[target]) !== url) fail(`${target} in ${file} points somewhere else, so it was left as it is.`);
    if (dry) { say(`would remove ${target} from ${file}`); return; }
    delete servers[target];
    writeClientConfig(file, cfg.data, cfg);
    await revokeInstallKeys(server.id, client, file);
    say(`Removed ${target} from ${file}. The previous file is saved as ${file}.kaiva-bridge.bak`);
    out({ client, name: target, file, removed: true });
    return;
  }

  if (existing) {
    say(`${server.name} is already in ${file} as ${existing}. Nothing changed.`);
    out({ client, name: existing, file, url, changed: false });
    return;
  }
  if (own(name)) fail(`${file} already has a server called ${name} that points somewhere else. Choose another name with --name.`);

  if (dry) {
    say(`would add to ${file}${cfg.existed ? '' : ' (a new file)'}:`);
    say(JSON.stringify({ [name]: c.entry(url, useKey ? 'kv_live_…' : null) }, null, 2));
    say(`other entries kept: ${Object.keys(servers).length}`);
    return;
  }
  const key = useKey ? await mintInstallKey(server.id, client, file) : null;
  servers[name] = c.entry(url, key);
  writeClientConfig(file, cfg.data, { ...cfg, secret: !!key });
  say(`Added ${name} to ${file} (${c.label}).${cfg.existed ? ` The previous file is saved as ${file}.kaiva-bridge.bak` : ''}`);
  if (key && (client === 'claude-code' || opts.project)) say(`This file now holds a gateway key for ${server.name}. Keep it out of version control.`);
  if (!key) say(c.signIn(name));
  say(`Undo: kaiva-bridge uninstall ${server.id} --client ${client}${opts.project ? ' --project' : ''}`);
  out({ client, name, file, url, changed: true, key: !!key });
}

/* One key per client per server: an earlier install key for this pair is revoked
   when a new one is made, and when the entry is uninstalled. */
async function revokeInstallKeys(serverId, client, file) {
  const label = installKeyLabel(client, file);
  const all = (await api('GET', '/keys')).keys || [];
  let n = 0;
  for (const k of all) {
    const ids = k.server_ids || [];
    if (k.label === label && !k.revoked_at && !k.management && ids.length === 1 && ids[0] === serverId) {
      await api('DELETE', `/keys/${k.id}`);
      n += 1;
    }
  }
  if (n) say(`revoked ${n} earlier key${n === 1 ? '' : 's'} for ${client}`);
}
async function mintInstallKey(serverId, client, file) {
  await revokeInstallKeys(serverId, client, file);
  const r = await api('POST', '/keys', { label: installKeyLabel(client, file), serverIds: [serverId] });
  const k = r?.key?.key;
  // Only a gateway key ever goes into a client's config.
  if (typeof k !== 'string' || !k.startsWith('kv_live_')) fail('the server did not return a gateway key, so nothing was written.');
  return k;
}

/* ── doctor: why does (or doesn't) this server work in a client? ──────────────
   Steps in the order a client meets them: our own sign-in, the server being live
   with tools exposed, the MCP handshake at its address, the tools a client is
   given, and (only when asked, only a tool that reads) one real call to the
   source. A step that did not run says so; it never reads as passed. The
   handshake uses a temporary gateway key for this server, revoked at the end, or
   the key piped in with --key-stdin. */
async function tryApi(method, path, body) {
  try {
    const res = await fetch(`${BASE}${path}`, {
      redirect: 'error', // the key is for this address only: a redirect is refused, never followed
      method,
      headers: { Authorization: `Bearer ${TOKEN}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    let data = null;
    try { data = await res.json(); } catch { /* empty */ }
    return { ok: res.ok, status: res.status, data };
  } catch (e) {
    return { ok: false, status: 0, data: null, network: e.message };
  }
}

// One JSON-RPC message to the gateway, answered as JSON or as an event stream.
async function mcpCall(url, key, msg, version) {
  const res = await fetch(url, {
    redirect: 'error', // the key is for this address only: a redirect is refused, never followed
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(version ? { 'MCP-Protocol-Version': version } : {}),
    },
    body: JSON.stringify(msg),
  });
  const text = await res.text();
  if (msg.id === undefined) return { status: res.status, body: null };
  let body = null;
  if ((res.headers.get('content-type') || '').includes('text/event-stream')) {
    for (const line of text.split('\n')) {
      if (!line.startsWith('data:')) continue;
      try { const m = JSON.parse(line.slice(5)); if (m && m.id === msg.id) body = m; } catch { /* not JSON */ }
    }
  } else {
    try { body = JSON.parse(text); } catch { body = null; }
  }
  return { status: res.status, body };
}

const CALL_FIX = {
  credential: (id) => `update the credential: kaiva-bridge credential set ${id} --type bearer --secret-stdin (then: kaiva-bridge credential test ${id})`,
  spec: (id) => `check the source's address on the server's Source tab in the console; if the source changed, re-read it: kaiva-bridge introspect ${id}`,
  arguments: () => 'check the values passed with --args against the tool\'s inputs (kaiva-bridge tools <server>)',
  retry: () => 'the source failed or did not answer in time: retry shortly; if it persists, check the source is up',
};

async function doctor(args) {
  const ref = args[0];
  if (!ref || ref.startsWith('--')) fail('usage: kaiva-bridge doctor <server> [--call <tool> [--args \'{"k":"v"}\']] [--key-stdin] [--json]');
  const steps = [];
  // Every result carries a stable code, so scripts and support read the same thing.
  const add = (step, status, code, detail, fix) => { steps.push({ step, status, code, detail, ...(fix ? { fix } : {}) }); };
  const ORDER = ['reachability', 'auth', 'publication', 'handshake', 'discovery', 'call'];
  const stop = (name) => { for (const n of ORDER.slice(ORDER.indexOf(name) + 1)) add(n, 'not_run', 'not_run', 'not run: an earlier step failed'); };
  const callName = flag(args, 'call');
  let callArgs = {};
  if (flag(args, 'args')) { try { callArgs = JSON.parse(flag(args, 'args')); } catch { fail('--args must be valid JSON'); } }
  const pipedKey = args.includes('--key-stdin') ? (await readSecretStdin()).trim() : null;
  if (pipedKey && !pipedKey.startsWith('kv_live_')) fail('--key-stdin takes a gateway key (kv_live_). A management key never goes to the MCP endpoint.');
  let server = null;
  let tempKey = null;

  const finish = async () => {
    if (tempKey) {
      const r = await tryApi('DELETE', `/keys/${tempKey.id}`);
      if (!r.ok) process.stderr.write(plain(`warning: the temporary key "${tempKey.label}" could not be revoked (${r.status || r.network}). Revoke it in the console under Keys & access.\n`));
    }
    const failed = steps.find((x) => x.status === 'failed');
    /* What to send support: no key, no token, no arguments, no source text. The
       API host, the server id and each step's code are enough to find it. */
    const receipt = {
      id: `dr_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
      at: new Date().toISOString(),
      api: new URL(BASE).host,
      server: server ? server.id : null,
      steps: steps.map((x) => `${x.step}:${x.code}`).join(' '),
    };
    const result = { server: server ? { id: server.id, name: server.name, url: gatewayUrl(server.slug) } : { ref }, ok: !failed, failedStep: failed ? failed.step : null, code: failed ? failed.code : 'ok', steps, receipt };
    if (JSON_MODE) out(result);
    else {
      const mark = { passed: 'PASS', failed: 'FAIL', not_run: '----', skipped: 'SKIP' };
      for (const x of steps) {
        say(`${mark[x.status]}  ${x.step.padEnd(12)} ${x.detail}`);
        if (x.fix) say(`      ${''.padEnd(12)} fix: ${x.fix}`);
      }
      say(`receipt ${receipt.id}  ${receipt.at}  ${receipt.api}${receipt.server ? `  ${receipt.server}` : ''}`);
      say(`        ${receipt.steps}`);
    }
    if (failed) process.exitCode = 1;
  };

  // 1. reachability: is Kaiva there at all?
  try {
    const h = await fetch(`${ROOT}/health`);
    if (!h.ok) throw new Error(`HTTP ${h.status}`);
    add('reachability', 'passed', 'ok', `Kaiva answered at ${new URL(BASE).host}`);
  } catch (e) {
    add('reachability', 'failed', 'kaiva_unreachable', `could not reach Kaiva at ${new URL(BASE).host} (${e.message})`, 'check the network or proxy, or KAIVA_BRIDGE_URL; status: https://kaiv.ai/bridge/status');
    stop('reachability'); return finish();
  }

  // 2. auth: is this CLI signed in, and does the key still act?
  if (!TOKEN) {
    add('auth', 'failed', 'auth_missing', 'not signed in', 'run kaiva-bridge login (CI: set KAIVA_BRIDGE_TOKEN to a management key)');
    stop('auth'); return finish();
  }
  const who = await tryApi('GET', '/whoami');
  if (!who.ok) {
    const e = who.data?.error;
    if (who.network) add('auth', 'failed', 'kaiva_unreachable', `could not reach Kaiva at ${BASE} (${who.network})`, 'check the network, or KAIVA_BRIDGE_URL');
    else if (e === 'key_issuer_not_permitted') add('auth', 'failed', 'auth_issuer_removed', 'the person who approved this key is no longer an owner or admin', 'an owner or admin runs kaiva-bridge login on this machine');
    else if (e === 'wrong_key_type') add('auth', 'failed', 'auth_wrong_key_type', 'KAIVA_BRIDGE_TOKEN holds a gateway key (kv_live_), not a management key', 'use a management key, or unset it and run kaiva-bridge login');
    else if (who.status === 401) add('auth', 'failed', 'auth_revoked', `the ${ENV_TOKEN ? 'key in KAIVA_BRIDGE_TOKEN' : 'saved login'} was revoked or is no longer valid`, ENV_TOKEN ? 'create a new management key in the console (Keys & access)' : 'run kaiva-bridge login');
    else add('auth', 'failed', 'auth_error', `Kaiva answered ${who.status}${e ? ` (${e})` : ''}`, 'retry shortly');
    stop('auth'); return finish();
  }
  add('auth', 'passed', 'ok', `signed in to ${who.data?.workspace?.name || 'the workspace'}${who.data?.user?.email ? ` as ${who.data.user.email}` : ''}`);

  // 3. publication: the server exists, is live, and exposes tools.
  const list = await tryApi('GET', '/servers');
  const hits = (list.data?.servers || []).filter((x) => x.id === ref || x.slug === ref || x.name === ref);
  if (!list.ok) { add('publication', 'failed', 'servers_unavailable', `could not list servers (${list.status || list.network})`, 'retry shortly'); stop('publication'); return finish(); }
  if (hits.length !== 1) {
    add('publication', 'failed', hits.length ? 'server_ambiguous' : 'server_not_found', hits.length ? `"${ref}" matches ${hits.length} servers` : `no server "${ref}" in this workspace`, 'use the id from kaiva-bridge servers');
    stop('publication'); return finish();
  }
  server = hits[0];
  const detail = await tryApi('GET', `/servers/${server.id}`);
  const tools = (detail.data?.server || detail.data || {}).tools || [];
  const exposed = tools.filter((t) => t.exposed);
  if (server.state !== 'live') {
    add('publication', 'failed', 'server_not_live', `${server.name} is a ${server.state || 'draft'}: clients cannot reach it`, `publish it: kaiva-bridge publish ${server.id}`);
    stop('publication'); return finish();
  }
  if (!exposed.length) {
    add('publication', 'failed', 'no_tools_exposed', `${server.name} is live but exposes no tools (${tools.length} available)`, `choose tools in the console: Servers, ${server.name}, Tools`);
    stop('publication'); return finish();
  }
  add('publication', 'passed', 'ok', `live, ${exposed.length} of ${tools.length} tools exposed`);

  // 4. handshake, as a client does it.
  const url = gatewayUrl(server.slug);
  let key = pipedKey;
  if (!key) {
    const m = await tryApi('POST', '/keys', { label: 'doctor (temporary)', serverIds: [server.id] });
    const k = m.data?.key;
    if (!m.ok || typeof k?.key !== 'string' || !k.key.startsWith('kv_live_')) {
      add('handshake', 'failed', 'test_key_unavailable', `could not make a temporary key to test with (${m.data?.message || m.data?.error || m.status || m.network})`, 'pipe a gateway key for this server in with --key-stdin');
      stop('handshake'); return finish();
    }
    tempKey = { id: k.id, label: k.label || 'doctor (temporary)' };
    key = k.key;
  }
  let version = null;
  try {
    const init = await mcpCall(url, key, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'kaiva-bridge-doctor', version: '1' } } });
    const v = init.body?.result?.protocolVersion;
    if (init.status === 401 || init.status === 403) {
      add('handshake', 'failed', 'endpoint_refused_key', `the endpoint refused the ${pipedKey ? 'key given' : 'temporary key'} (${init.status})`, pipedKey ? 'the key is revoked or for another server: make one with kaiva-bridge key <server>' : 'retry; if it persists, check Keys & access');
    } else if (init.status === 404) {
      add('handshake', 'failed', 'endpoint_not_found', `nothing answers at ${url} (404)`, 'the server was deleted or renamed: check kaiva-bridge servers');
    } else if (!v) {
      add('handshake', 'failed', 'endpoint_no_mcp', `no MCP answer at ${url} (HTTP ${init.status}${init.body?.error?.message ? `: ${init.body.error.message}` : ''})`, 'retry shortly; if it persists, send the receipt below to support@kaiv.ai');
    } else {
      version = v;
      await mcpCall(url, key, { jsonrpc: '2.0', method: 'notifications/initialized' }, v);
      add('handshake', 'passed', 'ok', `${init.body.result.serverInfo?.name || server.name} answered, protocol ${v}`);
    }
  } catch (e) {
    add('handshake', 'failed', 'endpoint_unreachable', `could not reach ${url} (${e.message})`, 'check the network; Kaiva may be briefly unavailable');
  }
  if (!version) { stop('handshake'); return finish(); }

  // 5. discovery: the tools a client is given.
  let listed = [];
  try {
    const tl = await mcpCall(url, key, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, version);
    if (!Array.isArray(tl.body?.result?.tools)) throw new Error(tl.body?.error?.message || `HTTP ${tl.status}`);
    listed = tl.body.result.tools;
  } catch (e) {
    add('discovery', 'failed', 'tools_list_failed', `tools/list did not answer (${e.message})`, 'retry shortly; if it persists, send the receipt below to support@kaiv.ai');
    stop('discovery'); return finish();
  }
  if (!listed.length) {
    add('discovery', 'failed', 'no_tools_listed', 'a client is given no tools', `choose tools in the console: Servers, ${server.name}, Tools`);
    stop('discovery'); return finish();
  }
  const reads = listed.filter((t) => t.annotations?.readOnlyHint === true).length;
  add('discovery', 'passed', 'ok', `${listed.length} tools listed (${reads} read only)${listed.length !== exposed.length ? `; the console shows ${exposed.length} exposed` : ''}`);

  // 6. call: only one the person names, and only one that reads.
  if (!callName) {
    add('call', 'not_run', 'not_requested', 'no call made: add --call <tool> to make one read-only call to the source');
    return finish();
  }
  const lt = listed.find((t) => t.name === callName);
  if (!lt) {
    add('call', 'failed', 'tool_not_listed', `${callName} is not among the tools a client is given`, `pick one of: ${listed.slice(0, 8).map((t) => t.name).join(', ')}${listed.length > 8 ? ', …' : ''}`);
    return finish();
  }
  if (lt.annotations?.readOnlyHint !== true) {
    add('call', 'skipped', 'tool_may_write', `${callName} may change data, so doctor does not call it`, 'pick a tool that reads; test writes from the console\'s Test tab');
    return finish();
  }
  const mt = tools.find((t) => t.name === callName);
  if (!mt) { add('call', 'failed', 'tool_not_found', `${callName} was not found on the server`, `re-read the source: kaiva-bridge introspect ${server.id}`); return finish(); }
  /* BR-066: the published definition said "reads", but the server's current one is
     what a call runs. A held change can turn a published read into a write under the
     same name, so a current definition that writes is refused here, before anything
     is sent, and the server enforces the same with readOnly (on the definition it
     executes, bound to the published one). */
  if (!['GET', 'HEAD', 'OPTIONS', 'SELECT'].includes(String(mt.method || '').toUpperCase())) {
    add('call', 'skipped', 'tool_may_write', `${callName} reads in the published definition, but its current definition (${String(mt.method || 'unknown').toUpperCase()}) may change data, so doctor does not call it`, `publish or reject the held change first: kaiva-bridge revisions ${server.id}`);
    return finish();
  }
  const r = await tryApi('POST', `/servers/${server.id}/tools/${mt.id}/invoke`, { arguments: callArgs, readOnly: true });
  if (r.ok && r.data?.ok) {
    add('call', 'passed', 'ok', `${callName} answered in ${r.data.latencyMs}ms${r.data.simulated ? ' (test mode: a recorded answer, not the source)' : ''}`);
  } else if (r.data?.error === 'tool_may_write' || r.data?.error === 'tool_changed') {
    add('call', 'skipped', r.data.error === 'tool_changed' ? 'tool_changed' : 'tool_may_write', r.data.message || `${callName} was not called`, `publish or reject the held change first: kaiva-bridge revisions ${server.id}`);
  } else if (r.data?.error === 'invalid_arguments') {
    add('call', 'failed', 'call_arguments', `${callName} needs other arguments: ${r.data.message || ''}`.trim(), CALL_FIX.arguments());
  } else if (r.data?.error === 'upstream_error') {
    const kind = Object.prototype.hasOwnProperty.call(CALL_FIX, r.data.fix) ? r.data.fix : 'retry';
    const code = { credential: 'source_credential_refused', spec: 'source_address', arguments: 'call_arguments', retry: 'source_failed' }[kind];
    add('call', 'failed', code, `${r.data.title}${r.data.message ? `. ${r.data.message}` : ''}`, CALL_FIX[kind](server.id));
  } else {
    add('call', 'failed', 'call_failed', `${callName} failed (${r.data?.message || r.data?.error || r.status || r.network})`, 'retry shortly');
  }
  return finish();
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
    /* With --project this folder is in a repository someone else may have prepared:
       a link at SKILL.md, or at the folder, would send the write elsewhere. So a link
       is refused, and the file is written fresh (exclusive create) and renamed in. */
    const target = join(dir, 'SKILL.md');
    for (const p of [dir, target]) {
      let st = null;
      try { st = lstatSync(p); } catch { /* not there yet */ }
      if (st && st.isSymbolicLink()) fail(`${p} is a link to somewhere else, so the skill was not installed. Remove the link and run this again.`);
    }
    const tmp = `${target}.${process.pid}.${Date.now().toString(36)}${Math.random().toString(36).slice(2)}.tmp`;
    const fd = openSync(tmp, 'wx', 0o644);
    try { writeFileSync(fd, body); } finally { closeSync(fd); }
    renameSync(tmp, target);
    say(`installed the Kaiva Bridge skill: ${join(dir, 'SKILL.md')}`);
    say('ask your coding agent: "connect my database to Claude Code with Kaiva Bridge"');
    return;
  }

  if (cmd === 'login') return login(args);
  if (cmd === 'install') return install(args);
  if (cmd === 'doctor') return doctor(args);
  if (cmd === 'uninstall') return install(args, { remove: true });
  if (cmd === 'logout') return logout();
  if (cmd === 'whoami') {
    const r = await api('GET', '/whoami');
    const via = ENV_TOKEN ? 'KAIVA_BRIDGE_TOKEN (environment)' : `saved login (${CRED_FILE})`;
    if (JSON_MODE) { out({ workspace: r.workspace, email: r.user?.email || null, key: r.key, via: ENV_TOKEN ? 'env' : 'login', api: BASE }); return; }
    say(`workspace  ${r.workspace?.name || r.workspace?.id}`);
    if (r.user?.email) say(`account    ${r.user.email}`);
    say(`key        ${r.key?.label || ''}${r.key?.prefix ? `  (${r.key.prefix}…)` : ''}`);
    say(`from       ${via}`);
    say(`api        ${BASE}`);
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
        if (secret) process.stderr.write(plain(`warning: --${secretFlag} leaves the secret in shell history and visible to other processes. Use --secret-stdin instead.\n`));
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
