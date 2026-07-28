// Thin client for the Inkling sync server (server/index.js), plus the
// read-modify-write loop every mutating tool goes through.
//
// The backend stores ONE JSON blob per token — characters, chats, histories,
// personas, settings and scripts all live in the same row. So a write here is
// never "insert a character": it's "replace the entire backup". That makes a
// stale read genuinely destructive (it would roll back chats saved from the
// browser in the meantime), which is why every write goes through
// mutate() with the server's revision as a compare-and-swap key.

const trimUrl = u => String(u || '').replace(/\/+$/, '');

export class SyncClient {
  constructor({ url, token, fetchImpl = fetch }) {
    this.url = trimUrl(url);
    this.token = token;
    this.fetch = fetchImpl;
  }

  async #json(res) {
    const text = await res.text().catch(() => '');
    try { return text ? JSON.parse(text) : {}; } catch { return { _raw: text }; }
  }

  async meta() {
    const res = await this.fetch(`${this.url}/api/sync/meta?token=${encodeURIComponent(this.token)}`);
    const body = await this.#json(res);
    if (!res.ok) throw new Error(`sync server ${res.status}: ${body.error || body._raw || res.statusText}`);
    return body;
  }

  async pull() {
    const res = await this.fetch(`${this.url}/api/sync?token=${encodeURIComponent(this.token)}`);
    const body = await this.#json(res);
    if (!res.ok) throw new Error(`sync server ${res.status}: ${body.error || body._raw || res.statusText}`);
    return { data: body.data, revision: body.revision ?? null, updatedAt: body.updatedAt ?? null };
  }

  async push(data, expectedRevision) {
    const res = await this.fetch(`${this.url}/api/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: this.token, data, expectedRevision }),
    });
    const body = await this.#json(res);
    if (res.status === 409) {
      const err = new Error('revision conflict');
      err.conflict = true;
      throw err;
    }
    if (!res.ok) throw new Error(`sync server ${res.status}: ${body.error || body._raw || res.statusText}`);
    return body;
  }

  // Read → apply → write, retrying from a fresh read when someone else wrote
  // first. `apply` must be pure enough to run again on the newer blob.
  async mutate(apply, { attempts = 4 } = {}) {
    let lastConflict = null;
    for (let n = 0; n < attempts; n++) {
      const { data, revision } = await this.pull();
      if (!data) throw new Error('No backup found for this token yet. Open Inkling and let it sync once first.');

      const draft = structuredClone(data);
      const result = apply(draft);
      if (result && result.abort) return { aborted: true, message: result.abort, data: draft };

      draft.exportedAt = new Date().toISOString();
      try {
        const pushed = await this.push(draft, revision ?? 0);
        return { aborted: false, result, revision: pushed.revision, data: draft };
      } catch (e) {
        if (!e.conflict) throw e;
        lastConflict = e;
        // Someone (your browser, another device) wrote between our read and
        // write. Re-read and replay rather than clobbering their change.
      }
    }
    throw new Error(
      `Gave up after ${attempts} attempts - the backup kept changing mid-write. ` +
      `Something is actively syncing; try again in a moment.`
    );
  }
}

// The sync server accepts a blob with no schema, so a malformed payload would
// only surface later as a broken app. Cheap sanity check before every push.
export function assertPayloadShape(data) {
  if (!data || typeof data !== 'object') throw new Error('backup payload is not an object');
  if (!Array.isArray(data.characters)) throw new Error('backup payload has no characters array');
  return data;
}
