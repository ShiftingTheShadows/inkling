// Remote transport: real Streamable HTTP client against http.js + fake sync backend.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startFakeSync } from './fake-server.js';
import http from 'node:http';

const TOKEN = 'test-token-1234';
const SECRET = 'a'.repeat(32);
let pass = 0, fail = 0;
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log(`ok   ${name}`); }
  else { fail++; console.log(`FAIL ${name}${extra ? '\n     ' + JSON.stringify(extra) : ''}`); }
};

const sync = await startFakeSync();
await fetch(`${sync.url}/__test/seed`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ token: TOKEN, data: {
    version: 2, characters: [{ id: 'c1', name: 'Vera', firstMessage: 'Hi', tags: [] }],
    chats: { c1: [] }, histories: { c1: [] }, personas: [{ id: 'p1', name: 'You' }], scripts: [], settings: {},
  } }),
});

process.env.INKLING_SYNC_URL = sync.url;
process.env.INKLING_SYNC_TOKEN = TOKEN;
process.env.INKLING_MCP_SECRET = SECRET;
const { httpServer } = await import('../http.js');
await new Promise(r => httpServer.listen(0, r));
const base = `http://127.0.0.1:${httpServer.address().port}`;

// MCP client over the real transport
const client = new Client({ name: 'test', version: '0' }, { capabilities: {} });
await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp/${SECRET}`)));
const { tools } = await client.listTools();
check('lists tools over HTTP', tools.length === 31, tools.length);
const st = await client.callTool({ name: 'inkling_status', arguments: {} });
check('status works over HTTP', JSON.parse(st.content[0].text).characters === 1);
const cr = await client.callTool({ name: 'inkling_create_character', arguments: { name: 'Remote', first_message: 'hello from phone' } });
check('mutation works over HTTP', !cr.isError && /Remote/.test(cr.content[0].text), cr.content[0].text);
await client.close();

// auth + routing
const post = (path, body = '{}') => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body });
check('wrong secret -> 404', (await post(`/mcp/${'b'.repeat(32)}`)).status === 404);
check('no secret -> 404', (await post('/mcp')).status === 404);
check('GET on endpoint -> 405', (await fetch(`${base}/mcp/${SECRET}`)).status === 405);
check('bad JSON -> 400', (await post(`/mcp/${SECRET}`, '{nope')).status === 400);
check('health is open', (await fetch(`${base}/health`)).status === 200);

// ── DNS rebinding / cross-site guard (F40) ────────────────
// These go through node:http because fetch() refuses to set a Host header.
const rawRequest = (path, headers = {}, method = 'GET', body = null) => new Promise((resolve, reject) => {
  const req = http.request({
    host: '127.0.0.1', port: httpServer.address().port, path, method, headers,
  }, res => {
    let data = '';
    res.on('data', c => { data += c; });
    res.on('end', () => resolve({ status: res.statusCode, body: data }));
  });
  req.on('error', reject);
  if (body) req.write(body);
  req.end();
});

const rebound = await rawRequest('/health', { Host: 'evil.example' });
check('a rebinding Host header is refused', rebound.status === 403, rebound);
const reboundMcp = await rawRequest(`/mcp/${SECRET}`, {
  Host: 'evil.example', 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
}, 'POST', '{}');
check('a rebinding Host cannot reach the MCP endpoint', reboundMcp.status === 403, reboundMcp.status);
const crossSite = await rawRequest('/health', { Host: 'evil.example', Origin: 'http://evil.example' });
check('a rebinding host is refused even with a matching Origin', crossSite.status === 403, crossSite.status);
const foreignOrigin = await rawRequest('/health', { Origin: 'https://evil.example' });
check('a cross-site Origin is refused on a good Host', foreignOrigin.status === 403, foreignOrigin.status);
const sameOrigin = await rawRequest('/health', { Origin: base });
check('a same-origin request is still served', sameOrigin.status === 200, sameOrigin.status);
const noOrigin = await rawRequest('/health', { Host: new URL(base).host });
check('a server-to-server request (no Origin) is still served', noOrigin.status === 200, noOrigin.status);

process.env.INKLING_MCP_ALLOWED_HOSTS = 'mcp.example.com';
const listedHost = await rawRequest('/health', { Host: 'mcp.example.com' });
check('an operator-listed host is served', listedHost.status === 200, listedHost.status);
const unlistedHost = await rawRequest('/health', { Host: 'other.example.com' });
check('an unlisted public host is still refused', unlistedHost.status === 403, unlistedHost.status);
delete process.env.INKLING_MCP_ALLOWED_HOSTS;

httpServer.close();
await sync.close?.();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
