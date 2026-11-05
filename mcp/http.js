#!/usr/bin/env node
// Remote (Streamable HTTP) entry point, for claude.ai custom connectors and
// the Claude mobile apps, which can't spawn a local stdio process.
//
// Auth: claude.ai custom connectors accept only a URL (or OAuth) - they cannot
// send a bearer header. So the connector URL itself is the credential:
//     https://<host>/mcp/<INKLING_MCP_SECRET>
// Treat it like a password. It is deliberately NOT the sync token, so it never
// ends up in URLs, proxy logs or the claude.ai connector list.
//
// Env: INKLING_MCP_SECRET (required, 24+ chars), INKLING_SYNC_URL,
//      INKLING_SYNC_TOKEN, PORT (default 3001).

import http from 'node:http';
import crypto from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer } from './core.js';

const MIN_SECRET_LEN = 24;
const MAX_BODY = 25 * 1024 * 1024; // base64 avatars can be large

const secret = process.env.INKLING_MCP_SECRET || '';
if (secret.length < MIN_SECRET_LEN) {
  console.error(`INKLING_MCP_SECRET must be set to a random string of at least ${MIN_SECRET_LEN} characters.\n` +
    `Generate one with:  node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"`);
  process.exit(1);
}

const secretBuf = crypto.createHash('sha256').update(secret).digest();
const secretMatches = candidate =>
  crypto.timingSafeEqual(crypto.createHash('sha256').update(candidate).digest(), secretBuf);

const send = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

const readBody = req => new Promise((resolve, reject) => {
  let size = 0;
  const chunks = [];
  req.on('data', c => {
    size += c.length;
    if (size > MAX_BODY) { reject(Object.assign(new Error('payload too large'), { status: 413 })); req.destroy(); return; }
    chunks.push(c);
  });
  req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  req.on('error', reject);
});

export const httpServer = http.createServer(async (req, res) => {
  try {
    const { pathname } = new URL(req.url, 'http://localhost');
    if (pathname === '/' || pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      return res.end('Inkling MCP server is running.');
    }

    const m = pathname.match(/^\/mcp\/([^/]+)\/?$/);
    // Same 404 for a wrong secret as for a wrong path: don't confirm the route exists.
    if (!m || !secretMatches(decodeURIComponent(m[1]))) return send(res, 404, { error: 'not found' });

    // Stateless mode has no standalone SSE stream or sessions to tear down.
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return send(res, 405, { jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null });
    }

    let parsed;
    try { parsed = JSON.parse(await readBody(req)); }
    catch (e) {
      if (e.status) return send(res, e.status, { error: e.message });
      return send(res, 400, { jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null });
    }

    const server = createServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { transport.close(); server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, parsed);
  } catch (e) {
    console.error('request failed:', e);
    if (!res.headersSent) send(res, 500, { jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
  }
});

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const port = Number(process.env.PORT) || 3001;
  httpServer.listen(port, () => console.error(`inkling-mcp (http) listening on ${port}`));
}
