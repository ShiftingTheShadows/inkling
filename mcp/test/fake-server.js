// In-memory stand-in for server/index.js so the MCP server can be tested
// without Postgres or real credentials. Mirrors the same contract, including
// the revision compare-and-swap.
import http from 'node:http';
import crypto from 'node:crypto';

const hashToken = t => crypto.createHash('sha256').update(t).digest('hex');

export function startFakeSync() {
  const store = new Map(); // tokenHash -> { data, revision, updatedAt }
  let pendingExternalWrite = null; // test hook: fires once, mid-flight, before a CAS write

  const read = req => new Promise(res => {
    let b = '';
    req.on('data', c => { b += c; });
    req.on('end', () => { try { res(JSON.parse(b || '{}')); } catch { res({}); } });
  });
  const send = (res, code, obj) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const token = url.searchParams.get('token') || '';
    const key = hashToken(token);

    if (url.pathname === '/__test/seed') {
      const { token: t, data } = await read(req);
      store.set(hashToken(t), { data, revision: 1, updatedAt: new Date().toISOString() });
      return send(res, 200, { ok: true });
    }
    if (url.pathname === '/__test/dump') {
      const row = store.get(hashToken(url.searchParams.get('token')));
      return send(res, 200, row || { data: null });
    }
    // Arrange for one external write to land between the MCP's read and write
    if (url.pathname === '/__test/race-once') {
      const { token: t, mutation } = await read(req);
      pendingExternalWrite = { key: hashToken(t), mutation };
      return send(res, 200, { ok: true });
    }

    if (url.pathname === '/api/sync/meta' && req.method === 'GET') {
      const row = store.get(key);
      return send(res, 200, { updatedAt: row?.updatedAt ?? null, revision: row?.revision ?? null });
    }

    if (url.pathname === '/api/sync' && req.method === 'GET') {
      const row = store.get(key);
      return send(res, 200, row ? { data: row.data, updatedAt: row.updatedAt, revision: row.revision } : { data: null, revision: null });
    }

    if (url.pathname === '/api/sync' && req.method === 'POST') {
      const { token: t, data, expectedRevision } = await read(req);
      const k = hashToken(t || '');
      if (!data) return send(res, 400, { error: 'missing data' });

      if (pendingExternalWrite && pendingExternalWrite.key === k) {
        const row = store.get(k);
        if (row) {
          // Simulate the browser saving something after the MCP read the blob
          if (pendingExternalWrite.mutation === 'add-character') {
            row.data.characters.push({ id: 'raced', name: 'Raced In', firstMessage: 'hi', tags: [] });
          }
          row.revision += 1;
          row.updatedAt = new Date().toISOString();
        }
        pendingExternalWrite = null;
      }

      const row = store.get(k);
      if (expectedRevision !== undefined && expectedRevision !== null) {
        // Mirrors server/index.js exactly: 0 means "I expect no row yet", so
        // it must conflict when one already exists. Stored revisions start
        // at 1 for the same reason.
        const conflict = expectedRevision === 0 ? !!row : (row?.revision ?? null) !== expectedRevision;
        if (conflict) {
          return send(res, 409, { error: 'revision conflict', revision: row?.revision ?? null });
        }
      }
      const next = { data, revision: (row?.revision ?? 0) + 1, updatedAt: new Date().toISOString() };
      store.set(k, next);
      return send(res, 200, { ok: true, updatedAt: next.updatedAt, revision: next.revision });
    }

    send(res, 404, { error: 'not found' });
  });

  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() });
    });
  });
}
