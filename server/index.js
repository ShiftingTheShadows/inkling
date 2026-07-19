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
    const { rows } = await pool.query('SELECT updated_at FROM backups WHERE token_hash = $1', [hashToken(token)]);
    res.json({ updatedAt: rows.length ? rows[0].updated_at : null });
  } catch (e) {
    console.error('GET /api/sync/meta failed:', e);
    res.status(500).json({ error: 'internal error' });
  }
});

app.get('/api/sync', async (req, res) => {
  const token = String(req.query.token || '');
  if (token.length < MIN_TOKEN_LEN) return res.status(400).json({ error: `token must be at least ${MIN_TOKEN_LEN} characters` });
  try {
    const { rows } = await pool.query('SELECT data, updated_at FROM backups WHERE token_hash = $1', [hashToken(token)]);
    res.json(rows.length ? { data: rows[0].data, updatedAt: rows[0].updated_at } : { data: null });
  } catch (e) {
    console.error('GET /api/sync failed:', e);
    res.status(500).json({ error: 'internal error' });
  }
});

app.post('/api/sync', async (req, res) => {
  const { token, data } = req.body || {};
  if (typeof token !== 'string' || token.length < MIN_TOKEN_LEN) return res.status(400).json({ error: `token must be at least ${MIN_TOKEN_LEN} characters` });
  if (!data || typeof data !== 'object') return res.status(400).json({ error: 'missing data' });
  try {
    // Return the server-assigned updated_at (Postgres now(), not the client's
    // payload timestamp) so the client's auto-sync poll can compare against
    // the exact value it'll see on GET /api/sync/meta later. Using the
    // client's own clock here would make every push look "outdated" the
    // moment it lands, since now() is always a beat after the payload was built.
    const { rows } = await pool.query(
      `INSERT INTO backups (token_hash, data, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (token_hash) DO UPDATE SET data = $2, updated_at = now()
       RETURNING updated_at`,
      [hashToken(token), data]
    );
    res.json({ ok: true, updatedAt: rows[0].updated_at });
  } catch (e) {
    console.error('POST /api/sync failed:', e);
    res.status(500).json({ error: 'internal error' });
  }
});

const port = process.env.PORT || 3000;
ensureSchema()
  .then(() => app.listen(port, () => console.log(`Inkling sync server listening on ${port}`)))
  .catch(err => { console.error('Failed to initialize schema:', err); process.exit(1); });
