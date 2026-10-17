// Tiny local web server for the desktop app. Serves the built web app and runs
// the same api/*.js functions that Vercel runs in production (they are plain
// Web-standard Request -> Response handlers), so Claude, web search and image
// upload work with no hosting at all.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ico': 'image/x-icon',
};

async function handleApi(root, name, req, res) {
  const file = path.join(root, 'api', `${name}.js`);
  if (!/^[a-z0-9_-]+$/i.test(name) || !fs.existsSync(file)) { res.writeHead(404).end('Not found'); return; }
  const mod = await import(pathToFileURL(file).href);
  let body;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    body = Buffer.concat(chunks);
  }
  const request = new Request(`http://${req.headers.host}${req.url}`, { method: req.method, headers: req.headers, body, duplex: 'half' });
  const response = await mod.default(request);
  res.writeHead(response.status, Object.fromEntries(response.headers));
  if (!response.body) { res.end(); return; }
  // Stream through chunk by chunk — chat replies arrive as SSE
  const reader = response.body.getReader();
  res.on('close', () => reader.cancel().catch(() => {}));
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
  } catch { /* client went away */ }
  res.end();
}

function createServer(root, preferredPort) {
  const server = http.createServer(async (req, res) => {
    try {
      // Refuse requests whose Host isn't us (DNS-rebinding protection)
      const addr = server.address();
      const hostOk = addr && [`127.0.0.1:${addr.port}`, `localhost:${addr.port}`].includes(req.headers.host);
      if (!hostOk) { res.writeHead(403).end('Forbidden'); return; }

      const url = new URL(req.url, 'http://x');
      if (url.pathname.startsWith('/api/')) { await handleApi(root, url.pathname.slice(5), req, res); return; }

      let rel = decodeURIComponent(url.pathname);
      if (rel.endsWith('/')) rel += 'index.html';
      const file = path.normalize(path.join(root, rel));
      if (!file.startsWith(root + path.sep) && file !== root) { res.writeHead(403).end('Forbidden'); return; }
      const target = fs.existsSync(file) && fs.statSync(file).isFile() ? file : path.join(root, 'index.html');
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(target).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
      });
      fs.createReadStream(target).pipe(res);
    } catch (e) {
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
  });

  // A stable port matters: the app's data (IndexedDB/localStorage) is keyed by
  // origin, so a different port every launch would look like an empty install.
  const attempt = port => new Promise((resolve, reject) => {
    const onError = err => reject(err);
    server.once('error', onError);
    server.listen(port, '127.0.0.1', () => { server.removeListener('error', onError); resolve(); });
  });
  return attempt(preferredPort).then(
    () => ({ server, port: server.address().port, fellBack: false }),
    err => {
      if (err.code !== 'EADDRINUSE' || preferredPort === 0) throw err;
      return attempt(0).then(() => ({ server, port: server.address().port, fellBack: true }));
    });
}

module.exports = { createServer };
