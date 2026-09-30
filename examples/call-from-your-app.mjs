// Call your Kaiva Bridge MCP server from your own app. Node 18+, no dependencies.
//
//   export KAIVA_MCP_URL=https://api.kaiv.ai/api/bridge/mcp/<your-server>
//   export KAIVA_MCP_KEY=kv_live_...          # npx @kaiva/bridge key <server-id> --label my-app --replace
//   node call-from-your-app.mjs                          # lists tools, calls the first read tool
//   node call-from-your-app.mjs get_orders '{"limit":5}' # calls a tool you name
const url = process.env.KAIVA_MCP_URL;
const key = process.env.KAIVA_MCP_KEY;
if (!url || !key) { console.error('set KAIVA_MCP_URL and KAIVA_MCP_KEY'); process.exit(1); }

// Tool names and results come from the source, so they reach the terminal as plain text:
// control characters (escape sequences that move the cursor or rewrite lines) and bidi
// overrides become '?'. Do the same wherever your app shows tool output in a terminal.
// eslint-disable-next-line no-control-regex
const plain = (s) => String(s).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, '?');

let id = 0;
async function rpc(method, params) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
  });
  const text = await res.text();
  // The server may answer as JSON or as a server-sent event; both carry one JSON-RPC message.
  const body = text.trimStart().startsWith('{') ? text : (text.match(/^data: (.*)$/m) || [])[1];
  const msg = body ? JSON.parse(body) : null;
  if (!res.ok || !msg) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  if (msg.error) throw new Error(msg.error.message);
  return msg.result;
}

await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'my-app', version: '1.0.0' } });
const { tools } = await rpc('tools/list', {});
console.log(`${tools.length} tools:`, plain(tools.map((t) => t.name).join(', ')));

const [name, argsJson] = process.argv.slice(2);
const tool = name ? tools.find((t) => t.name === name) : tools.find((t) => !(t.inputSchema?.required || []).length);
if (!tool) { console.error(name ? `no tool named ${plain(name)}` : 'no tool without required inputs; name one'); process.exit(1); }
const result = await rpc('tools/call', { name: tool.name, arguments: argsJson ? JSON.parse(argsJson) : {} });
const out = result.content?.[0]?.text ?? JSON.stringify(result);
console.log(`${plain(tool.name)}${result.isError ? ' (error)' : ''}:`, plain(out.length > 600 ? `${out.slice(0, 600)}…` : out));
