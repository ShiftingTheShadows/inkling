// Inkling sync server — a tiny replacement for the GitHub Gist sync path.
// Stores one JSON blob per secret token (sha256-hashed) in Postgres, so the
// same token pulls the same backup back down on any device. No accounts,
// no per-field schema — the blob shape is whatever GistSync.buildPayload()
// produces on the client, so this server never needs to change when the
// app's data model does.
import express from 'express';
import cors from 'cors';
import pg from 'pg';
import crypto from 'crypto';

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set — add a Postgres database to this Railway project and link it to this service.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false },
});

const hashToken = token => crypto.createHash('sha256').update(token).digest('hex');
const MIN_TOKEN_LEN = 8;

async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS backups (
      token_hash TEXT PRIMARY KEY,
      data JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  // revision powers optimistic concurrency for non-browser writers (the MCP
  // server). A plain counter rather than comparing updated_at: timestamptz
  // has microsecond precision that a JS Date round-trip silently truncates,
  // so timestamp equality can't be trusted as a compare-and-swap key.
  //
  // Revisions start at 1, never 0, because expectedRevision = 0 is the
  // caller's way of saying "I expect no backup to exist yet". A stored row
  // sitting at 0 would make that check ambiguous and every compare-and-swap
  // write against it would fail forever. The backfill repairs rows created
  // by the first version of this migration, which defaulted to 0.
  await pool.query('ALTER TABLE backups ADD COLUMN IF NOT EXISTS revision BIGINT NOT NULL DEFAULT 1');
  await pool.query('ALTER TABLE backups ALTER COLUMN revision SET DEFAULT 1');
  await pool.query('UPDATE backups SET revision = 1 WHERE revision = 0');
}

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' })); // avatars/backgrounds are embedded as base64

app.get('/', (req, res) => res.send('Inkling sync server is running.'));

// Cheap polling endpoint for auto-sync: just the timestamp, not the whole
// (potentially multi-MB, avatars-and-backgrounds-included) blob.
app.get('/api/sync/meta', async (req, res) => {
  const token = String(req.query.token || '');
  if (token.length < MIN_TOKEN_LEN) return res.status(400).json({ error: `token must be at least ${MIN_TOKEN_LEN} characters` });
  try {
    const { rows } = await pool.query('SELECT updated_at, revision FROM backups WHERE token_hash = $1', [hashToken(token)]);
    res.json({
      updatedAt: rows.length ? rows[0].updated_at : null,
      revision: rows.length ? Number(rows[0].revision) : null,
    });
  } catch (e) {
    console.error('GET /api/sync/meta failed:', e);
    res.status(500).json({ error: 'internal error' });
  }
});

app.get('/api/sync', async (req, res) => {
  const token = String(req.query.token || '');
  if (token.length < MIN_TOKEN_LEN) return res.status(400).json({ error: `token must be at least ${MIN_TOKEN_LEN} characters` });
  try {
    const { rows } = await pool.query('SELECT data, updated_at, revision FROM backups WHERE token_hash = $1', [hashToken(token)]);
    res.json(rows.length
      ? { data: rows[0].data, updatedAt: rows[0].updated_at, revision: Number(rows[0].revision) }
      : { data: null, revision: null });
  } catch (e) {
    console.error('GET /api/sync failed:', e);
    res.status(500).json({ error: 'internal error' });
  }
});

app.post('/api/sync', async (req, res) => {
  const { token, data, expectedRevision } = req.body || {};
  if (typeof token !== 'string' || token.length < MIN_TOKEN_LEN) return res.status(400).json({ error: `token must be at least ${MIN_TOKEN_LEN} characters` });
  if (!data || typeof data !== 'object') return res.status(400).json({ error: 'missing data' });
  try {
    // Optimistic concurrency, opt-in. The browser omits expectedRevision and
    // keeps its existing last-write-wins behaviour; the MCP server sends the
    // revision it read, so a blob built from stale data is rejected instead of
    // silently overwriting whatever was saved in between (chats included).
    if (expectedRevision !== undefined && expectedRevision !== null) {
      if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
        return res.status(400).json({ error: 'expectedRevision must be a non-negative integer' });
      }
      const sql = expectedRevision === 0
        // 0 means "I expect no backup to exist yet"
        ? `INSERT INTO backups (token_hash, data, updated_at, revision) VALUES ($1, $2, now(), 1)
           ON CONFLICT (token_hash) DO NOTHING
           RETURNING updated_at, revision`
        : `UPDATE backups SET data = $2, updated_at = now(), revision = revision + 1
           WHERE token_hash = $1 AND revision = $3
           RETURNING updated_at, revision`;
      const params = expectedRevision === 0 ? [hashToken(token), data] : [hashToken(token), data, expectedRevision];
      const { rows } = await pool.query(sql, params);
      if (!rows.length) {
        const cur = await pool.query('SELECT updated_at, revision FROM backups WHERE token_hash = $1', [hashToken(token)]);
        return res.status(409).json({
          error: 'revision conflict - the backup changed since you read it',
          revision: cur.rows.length ? Number(cur.rows[0].revision) : null,
          updatedAt: cur.rows.length ? cur.rows[0].updated_at : null,
        });
      }
      return res.json({ ok: true, updatedAt: rows[0].updated_at, revision: Number(rows[0].revision) });
    }

    // Return the server-assigned updated_at (Postgres now(), not the client's
    // payload timestamp) so the client's auto-sync poll can compare against
    // the exact value it'll see on GET /api/sync/meta later. Using the
    // client's own clock here would make every push look "outdated" the
    // moment it lands, since now() is always a beat after the payload was built.
    const { rows } = await pool.query(
      `INSERT INTO backups (token_hash, data, updated_at, revision) VALUES ($1, $2, now(), 1)
       ON CONFLICT (token_hash) DO UPDATE SET data = $2, updated_at = now(), revision = backups.revision + 1
       RETURNING updated_at, revision`,
      [hashToken(token), data]
    );
    res.json({ ok: true, updatedAt: rows[0].updated_at, revision: Number(rows[0].revision) });
  } catch (e) {
    console.error('POST /api/sync failed:', e);
    res.status(500).json({ error: 'internal error' });
  }
});

const port = process.env.PORT || 3000;
ensureSchema()
  .then(() => app.listen(port, () => console.log(`Inkling sync server listening on ${port}`)))
  .catch(err => { console.error('Failed to initialize schema:', err); process.exit(1); });
