// Run with `npm test` in desktop/. Exercises the local server against a temp
// app root so it needs no Electron, network, or built web app.
'use strict';
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
const { createServer, unpackedPath } = require('../server');

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'inkling-srv-'));
  fs.mkdirSync(path.join(root, 'api'));
  fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module"}');
  fs.writeFileSync(path.join(root, 'index.html'), '<h1>hi</h1>');
  fs.writeFileSync(path.join(root, 'api', 'echo.js'),
    `export default async (req) => Response.json({ method: req.method, body: await req.text() });`);
  fs.writeFileSync(path.join(root, 'api', 'stream.js'), `export default async () => new Response(new ReadableStream({
    async start(c) { for (const w of ['a','b','c']) { c.enqueue(new TextEncoder().encode('data: '+w+'\\n\\n')); await new Promise(r => setTimeout(r, 30)); } c.close(); } }),
    { headers: { 'content-type': 'text/event-stream' } });`);

  const { server, port, fellBack } = await createServer(root, 0);
  const base = `http://127.0.0.1:${port}`;
  let pass = 0;
  const ok = (n, c) => { assert(c, n); pass++; console.log('ok  ', n); };

  ok('serves index', (await (await fetch(base + '/')).text()) === '<h1>hi</h1>');
  ok('SPA fallback', (await (await fetch(base + '/nope/deep')).text()) === '<h1>hi</h1>');
  ok('traversal blocked', (await fetch(base + '/..%2f..%2fetc%2fpasswd')).status !== 200 || (await (await fetch(base + '/..%2f..%2fetc%2fpasswd')).text()) === '<h1>hi</h1>');
  const echo = await (await fetch(base + '/api/echo', { method: 'POST', body: 'payload' })).json();
  ok('api POST body passes through', echo.method === 'POST' && echo.body === 'payload');
  ok('unknown api 404', (await fetch(base + '/api/missing')).status === 404);
  ok('api name traversal rejected', (await fetch(base + '/api/..%2findex')).status === 404);

  // Packaged app: electron-builder moves asarUnpack'd files next to the
  // archive, and Electron's ESM loader cannot import from inside app.asar, so
  // the API has to be loaded from app.asar.unpacked.
  ok('unpackedPath is exported', typeof unpackedPath === 'function');
  if (typeof unpackedPath === 'function') {
    ok('an asar path maps to its unpacked copy',
      unpackedPath('/opt/Inkling/resources/app.asar/web/api/search.js') === '/opt/Inkling/resources/app.asar.unpacked/web/api/search.js');
    ok('an unpacked path is left alone',
      unpackedPath('/opt/Inkling/resources/app.asar.unpacked/web/api/search.js') === '/opt/Inkling/resources/app.asar.unpacked/web/api/search.js');
    ok('an ordinary path is left alone', unpackedPath('/home/me/desktop/web/api/search.js') === '/home/me/desktop/web/api/search.js');
  }

  const packed = fs.mkdtempSync(path.join(os.tmpdir(), 'inkling-asar-'));
  const asarRoot = path.join(packed, 'resources', 'app.asar', 'web');
  const unpackedApi = path.join(packed, 'resources', 'app.asar.unpacked', 'web', 'api');
  fs.mkdirSync(asarRoot, { recursive: true });
  fs.mkdirSync(unpackedApi, { recursive: true });
  fs.writeFileSync(path.join(asarRoot, 'index.html'), '<h1>packed</h1>');
  fs.writeFileSync(path.join(packed, 'resources', 'app.asar', 'package.json'), '{"type":"module"}');
  fs.writeFileSync(path.join(unpackedApi, 'echo.js'),
    `export default async (req) => Response.json({ packed: true, body: await req.text() });`);

  const packedSrv = await createServer(asarRoot, 0);
  const packedBase = `http://127.0.0.1:${packedSrv.port}`;
  ok('the packaged app serves its page', (await (await fetch(packedBase + '/')).text()) === '<h1>packed</h1>');
  const packedEcho = await fetch(packedBase + '/api/echo', { method: 'POST', body: 'hi' });
  ok('a packaged api module is found in app.asar.unpacked', packedEcho.status === 200);
  ok('a packaged api call reaches the module', (await packedEcho.json()).body === 'hi');
  packedSrv.server.close();

  const chunks = [];
  const r = await fetch(base + '/api/stream');
  const reader = r.body.getReader();
  for (;;) { const { done, value } = await reader.read(); if (done) break; chunks.push(Buffer.from(value).toString()); }
  ok('SSE arrives in separate chunks', chunks.length >= 2 && chunks.join('') === 'data: a\n\ndata: b\n\ndata: c\n\n');

  // wrong Host header (DNS rebinding) is refused
  const http = require('http');
  const status = await new Promise(res => http.get({ host: '127.0.0.1', port, path: '/', headers: { host: 'evil.example' } }, r => res(r.statusCode)));
  ok('foreign Host refused', status === 403);

  // port already taken -> falls back instead of crashing
  const second = await createServer(root, port);
  ok('port conflict falls back', second.fellBack === true && second.port !== port);
  second.server.close(); server.close();
  console.log(`${pass} passed`);
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
