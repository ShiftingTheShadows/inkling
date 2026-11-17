# Implementation Plan — Data Safety & Connection Check

> **For agentic workers:** Track with checkbox (`- [ ]`) steps. Work task by task; run the
> checks listed at the end of each task before moving on. Do not start a later task while an
> earlier one is red.

**Goal:** Implement the three highest-priority items from `docs/IDEAS.md`:

1. **D24** — surface IndexedDB write failures instead of logging them to the console.
2. **D27** — merge backups on restore instead of replacing local data wholesale.
3. **A3** — a Settings **Test connection** button per provider.

**Why this order:** D24 first, because every later change writes storage and a failing disk
must be visible while testing it. D27 second: it is the largest and riskiest change and its
result summary is shown in the banner/toast plumbing built in D24. A3 last: it is a
self-contained 1–2 hour feature in one modal plus one helper, and its manual test needs
nothing from the other two.

**Tech stack:** React 18 via `window` globals, Babel standalone in dev, esbuild for `dist/`,
Node's built-in test runner (no framework), IndexedDB via the `S` wrapper in
`src/hmm-utils.jsx`.

**Non-goals (explicitly out of scope at the time):**

> **Update (2026-11-17):** D28 (revision CAS on browser pushes) and D29 (end-to-end sync
> encryption) have both since shipped. This plan is kept as the record of that batch; see
> `docs/IDEAS.md` for their current, shipped descriptions.

- Per-provider profiles / preset URL picker (IDEA A1, A2) — A3 only *tests* the current form.
- Chat error bubbles with Retry (B11) — A3 avoids `callAI` entirely for this reason.
- Revision CAS on browser pushes (D28) and E2E encryption (D29). Merge makes clobbering much
  rarer but does not eliminate it; D28 remains the follow-up.
- Any IDB schema/version bump or `hmm_*` key rename.

## Global constraints

- **No new runtime dependencies.** Node's built-in runner and `fetch` only.
- **No new `src/*.jsx` file.** A new file needs entries in both `index.html` and
  `build.mjs`'s `files` array; keeping changes inside existing files avoids that class of
  mistake. New *test* files are fine.
- **Pure logic goes inside slice markers** so Node can test it (the `TEXTBOX-EXPORTS` pattern
  already in `src/hmm-utils.jsx` + `test/harness.js`). No React or DOM access inside a marked
  region.
- **Secrets never sync.** Any new key added to settings must be added to *both*
  `GistSync.buildPayload`'s strip list and the preserve list in the restore path.
- **Dev/prod parity:** any new hook must be destructured at the top of its file
  (`const { useState } = React;`) or `test/hooks-check.mjs` fails — that test exists because
  production wraps each file in an IIFE.
- **Changelog:** after all three land, add one entry at the top of `CHANGELOG` in
  `src/hmm-utils.jsx` and bump its `version` (returning users get the auto-popup).

---

## Task 1 — D24: surface IndexedDB write failures

**Files**

- Modify: `src/hmm-utils.jsx` (`__idbPut`, `__idbDel`, `S`, new marked region)
- Modify: `src/hmm-app.jsx` (banner + subscription)
- Modify: `index.html` (`.storage-alert` CSS)
- Modify: `src/hmm-modals.jsx` (`StorageMeter`)
- Create: `test/storage.test.js`
- Modify: `test/harness.js` (generic slice loader)
- Modify: `package.json` (`test` script)

**Current state:** `__idbPut` (≈ line 28) reports only via `console.warn` in three places:
the localStorage fallback catch, `tx.onerror`, and the synchronous `try` catch. `__idbDel` is
fully silent. A quota error therefore loses data with no UI signal, while the in-memory `Map`
still returns the "saved" value on every read for the rest of the session.

### Step 1: pure classifier + reporter

Inside a new marker block in `src/hmm-utils.jsx`, above `__idbPut`:

```js
/* STORAGE-EXPORTS-START */
function storageErrorKind(err) { /* 'quota' | 'blocked' | 'unavailable' | 'unknown' */ }
/* STORAGE-EXPORTS-END */
```

Rules — `quota` for `QuotaExceededError` / `NS_ERROR_DOM_QUOTA_REACHED` / `err.code === 22` /
`/quota/i` in the message; `blocked` for `SecurityError` or a permission message;
`unavailable` for `InvalidStateError` / "backing store" / closed connection; otherwise
`unknown`. Never throw on `null`/strings.

Then module-scope state next to it (not exported to tests):

```js
const __storageErrorListeners = new Set();
let __storageHealth = { ok: true, count: 0, last: null, kind: null };
function __reportStorageError(key, err) { /* update state, notify listeners */ }
```

`last` must be JSON-safe: `{ key, kind, name, message, at }` with `message` clipped to ~200
chars. Dedupe: if the same `key + kind + message` arrives within 1 second, increment `count`
but do not re-notify (a failing transaction can fire `req.onerror` **and** `tx.onabort`).

### Step 2: wire the reporter into writes

- `__idbPut`, fallback branch: replace the `console.warn` in the catch with
  `__reportStorageError(key, e)` and keep the warn (console is still useful in dev).
- `__idbPut`, IDB branch: capture the request and abort explicitly —
  `const req = store.put(val, key); req.onerror = () => __reportStorageError(key, req.error); tx.onabort = () => __reportStorageError(key, tx.error);`
  Drop the current `tx.onerror` warn to avoid triple reporting (request errors bubble to
  abort). Keep the synchronous `try/catch` → report.
- `__idbDel`: same `req.onerror` / `tx.onabort` plumbing.
- `clearAll`: report on `tx.onerror` before resolving (one-shot, no dedupe concern).

### Step 3: expose health + subscription on `S`

```js
storageHealth: () => ({ ...__storageHealth }),
onStorageError: fn => { __storageErrorListeners.add(fn); fn({ ...__storageHealth }); return () => __storageErrorListeners.delete(fn); },
```

Calling `fn` immediately on subscribe matters: boot-time migration writes happen before
`App` mounts, and a late subscriber must still see the fault.

### Step 4: banner in `hmm-app.jsx`

- `const [storageFault, setStorageFault] = useState(() => S.storageHealth());`
- `useEffect(() => S.onStorageError(setStorageFault), []);`
- Render `<StorageAlert fault={storageFault} onExport={exportAll} />` between `.main` and
  `.statusbar`. Component lives in `hmm-app.jsx` (small, app-level chrome, no modal).
- Copy by kind:
  - `quota` — "Storage is full — changes are **not** being saved. Export a backup, then delete
    something." Plus `usage / quota` from `navigator.storage.estimate()` when available.
  - `blocked` — "The browser is blocking site storage (private window or blocked cookies)."
  - `unavailable` — "IndexedDB is unavailable; data is in memory only and will be lost."
  - `unknown` — "Some saves are failing. Export a backup to be safe."
- Buttons: **EXPORT BACKUP** → `exportAll()`; **DISMISS** → local `useState` hide (do not
  clear the underlying health, and re-show on the next new error).
- Style: add one `.storage-alert` block to `index.html` beside the other chrome rules; use
  `--danger`, 10–11px mono, dense padding, `flex-wrap` so it survives mobile widths.

### Step 5: `StorageMeter`

When `!S.storageHealth().ok`, the headline becomes red: replace "no more quota errors" with
"Last write failed — changes may not persist". Keep the existing estimate bar.

### Step 6: test

- Generalize `test/harness.js`: add `loadSlice(startMarker, endMarker)` that does the
  existing extraction, and keep `loadTextboxModule()` as a wrapper so `textbox.test.js` is
  untouched.
- `test/storage.test.js` asserts `storageErrorKind` for: a real `DOMException` with name
  `QuotaExceededError`, `{ code: 22 }`, `/disk is full/` message, `SecurityError`,
  `InvalidStateError`, `null`, and a plain string. Use `makeRunner()` from the harness.
- Add `node test/storage.test.js` to the root `test` script.

### Step 7: manual verification

1. Open the app, confirm no banner with healthy storage.
2. In DevTools console:
   `IDBObjectStore.prototype.put = () => { throw new DOMException('simulated','QuotaExceededError'); }`
3. Change a setting or send a message → banner appears within a render, export button works.
4. Reload (the patch is gone) → banner disappears.

**Done when:** a forced write failure shows the banner, exports a valid backup, and the unit
tests pass. No changes to storage keys or IDB version.

---

## Task 2 — D27: merge on restore instead of replace

**Files**

- Modify: `src/hmm-utils.jsx` (`GistSync.buildPayload`, `restorePayload`, new marked merge
  region, new `writePayload`)
- Modify: `src/hmm-modals.jsx` (`SyncModal` pull handlers + tabs copy, `ImportModal`
  `processOne` backup branch)
- Modify: `src/hmm-app.jsx` (auto-sync pull)
- Create: `test/merge.test.js`
- Modify: `test/harness.js` (reuse `loadSlice`), `package.json`

**Current state**

- `ImportModal` already merges full backups by id, **add-only** (≈ lines 2009–2047): it never
  updates an existing character, never touches folders, and restores chats only when the local
  chat is empty. That behaviour is deliberate for imports — an old file must not clobber a
  live conversation.
- `GistSync.restorePayload` (≈ line 1289) replaces every collection outright and is used by
  the gist pull (`hmm-modals.jsx` ≈2527), the Railway pull (≈2553) and unattended auto-sync
  (`hmm-app.jsx` ≈147). Auto-sync therefore reloads the page and can discard local work.
- `buildPayload` strips six secret keys but **not** `imageHostApiKey`, which is both synced
  and overwritten on restore. Fix that while in here.

### Step 1: pure merge function

New marked region in `src/hmm-utils.jsx` (above `GistSync`):

```js
/* MERGE-EXPORTS-START */
function mergePayloads(local, remote, opts = {}) { /* -> { merged, stats } */ }
/* MERGE-EXPORTS-END */
```

Options and policies — keep two named presets exported to callers:

| Collection | `records: 'keep-local'` (import) | `records: 'newer'` (sync) |
|---|---|---|
| `characters` | union by `id`; local wins | union by `id`; greater `updatedAt` wins, ties → local, missing → 0 |
| `folders` | union by `id`; local wins | local wins |
| `scripts` | union by `id`; local wins; count same-name/different-id as `nameConflicts` | same |
| `lorebook` | union by `id`; local wins | same |
| `personas` | union by `id`; local wins | same |

- `chats`, `histories`, `assistChats`: keyed by character id, same policy for all three —
  `chats: 'keep-local'` keeps the local array unless it is empty; `chats: 'prefer-longer'`
  takes the longer array, tie broken by the last message's `timestamp`, then local.
- `activePersonaId`: keep local if it exists in the merged persona list; otherwise the first
  merged persona.
- `settings`: `opts.settings` = `'local'` (default; merge mode) or `'remote-if-empty'` (fresh
  install: no local settings row at all). Never merge settings key-by-key.
- `version` / `exportedAt`: set `version` to the higher of the two; set `exportedAt` to now.
- `stats` shape must be stable and UI-ready:
  `{ added: {...}, updated: {...}, kept: {...}, nameConflicts: n, changed: n }` where
  `changed = sum(added) + sum(updated)`. `previewRestore` relies on this.
- The function is pure: no `S`, no `Date.now` beyond a passed `now` argument (default
  `new Date().toISOString()`), no DOM. It must not mutate its inputs (clone arrays/objects).

### Step 2: extract `writePayload`

Move the write half of the current `restorePayload` into
`GistSync.writePayload(payload, { preserveSecrets = true })`:

- Settings: when `preserveSecrets`, spread `payload.settings` but restore the local values of
  `apiKey`, `openrouterKey`, `localApiKey`, `globalPrompt`, `tavilyKey`, `braveKey`, **and
  `imageHostApiKey`**.
- Write `personas`, `activePersonaId`, `lorebook`, `scripts`, `folders`, `characters` as today.
- **Fix:** iterate `Object.keys(payload.chats)` (and histories/assistChats) rather than only
  characters present in `payload.characters` — a merged payload can carry a chat for a
  character that a previous partial write dropped.

### Step 3: `restorePayload(data, opts)`

```js
GistSync.restorePayload(data, { mode = 'merge', policy = 'sync' } = {}) // -> stats | null
```

- `mode: 'replace'` → exact current behaviour (`writePayload(data)`), returns `null`.
- `mode: 'merge'` → `const local = this.buildPayload();` then
  `mergePayloads(local, data, policy === 'import' ? IMPORT_OPTS : SYNC_OPTS)`, write, return
  `stats`.
- Add `GistSync.previewRestore(data, opts)` → `{ stats }` with no writes, for the dialog.
- Add `imageHostApiKey` to `buildPayload`'s strip list.

### Step 4: `SyncModal` — explicit choice instead of "OVERWRITE"

- Both `doPull` (gist) and `doRailwayPull` currently `window.confirm('...OVERWRITE...')`.
  Replace with a small `RestoreDialog` rendered inside `SyncModal` (component in
  `hmm-modals.jsx`, same visual language as `fld-dialog`/modals):
  - Radio: **Merge (recommended)** — default — and **Replace everything**.
  - Shows `previewRestore(data).stats` counts ("3 new characters, 1 updated, 12 chats kept").
  - Confirm runs `restorePayload(data, { mode })`; merge shows the returned counts in the
    existing status line; replace keeps today's wording.
  - Reload the page after either (React state is hydrated at mount), but only after a merge
    that changed something — otherwise just report "already up to date".
- Update the Railway tab copy at ≈ line 2708 ("Overwrites local data…") to describe the choice.

### Step 5: auto-sync merges silently

`hmm-app.jsx` ≈ line 147 — replace `GistSync.restorePayload(data)` with
`const stats = GistSync.restorePayload(data, { mode: 'merge' });` and only toast + reload when
`stats.changed > 0`. This is the item's biggest win: today an unattended 60-second poll can
discard local messages.

### Step 6: `ImportModal` reuses the same path

Replace the inline add-only loop with
`GistSync.restorePayload(raw, { mode: 'merge', policy: 'import' })` and map `stats` onto the
existing toast fields (`backup`, `chatsRestored`, `loreAdded`, `scriptsAdded`,
`personasAdded`). Behaviour is preserved (add-only, no settings/persona switch) and folders
now restore too. Keep the "this is a full backup" detection where it is.

### Step 7: tests (`test/merge.test.js`, pure)

Cover at minimum:

- local-only character survives a sync merge; remote-only character is added;
- same-id character: newer remote replaces under `newer`, older remote is ignored, fencepost
  equal timestamps keep local; under `keep-local` remote never replaces;
- local chat with more messages survives `prefer-longer`; longer remote chat replaces a short
  local one; empty local chat is filled; equal-length tie keeps local;
- folders/scripts/lorebook/personas union by id with local wins; script name collision is
  counted, not merged;
- `activePersonaId` falls back to the first persona when the remote's active id is missing;
- `settings` untouched in merge mode; `'remote-if-empty'` takes remote when local is `{}`;
- inputs are not mutated; `stats.changed` matches added+updated;
- export constants (`SYNC_OPTS`, `IMPORT_OPTS`) are the ones used by `restorePayload`.

Add `node test/merge.test.js` to the `test` script.

### Step 8: manual verification (the important one)

1. Two browser profiles, A and B, both pointed at the same Railway/gist target.
2. A: create "Vera", push.
3. B: pull with **Merge** → Vera appears, B's own characters intact.
4. B: send three messages to a shared character. A: clear that character's chat and push.
5. B: let auto-sync poll (or trigger a pull) → B **keeps** its three messages.
6. Third profile C: pull with **Replace** → exact mirror of the backup.
7. Import a stale exported backup with **Merge** → old chat is not restored over newer local
   chat, and its folders now come through.

**Done when:** all four restore entry points (gist pull, Railway pull, auto-sync, file import)
route through `mergePayloads`/`writePayload`, the tests pass, and step 5's local messages
survive.

---

## Task 3 — A3: Test connection in Settings

**Files**

- Modify: `src/hmm-utils.jsx` (probe helpers near `callAI`)
- Modify: `src/hmm-modals.jsx` (`SettingsModal` API CONFIGURATION block)
- Create: `test/providers.test.js`
- Modify: `package.json`

**Current state:** `SettingsModal` keeps a local `form` copy of settings (`useState`,
`set(k, v)`, saved only by `ctx.saveSettings(form)` in the footer). Providers are `claude`
(→ `/api/anthropic`), and `openrouter` / `local` / `custom` (→ `${base}/v1/chat/completions`).
`callAI` cannot be reused: it turns errors into italic chat text and falls back to the
`window.claude` shim, so a failed probe would look like a success.

### Step 1: pure request builder

Inside the existing `TEXTBOX-EXPORTS` block — or a new `PROVIDER-EXPORTS` block loaded through
the same `loadSlice` — add:

```js
function buildProviderProbe(settings) // -> { url, init } ; throws Error with a readable message
```

- `claude`: url `/api/anthropic`, body
  `{ apiKey, model, system: undefined, messages: [{role:'user', content:'ping'}], maxTokens: 1, stream: false }`.
  Require `apiKey`, else throw "Add your Anthropic API key first".
- external: `base = endpoint.trim().replace(/\/+$/,'').replace(/\/v1$/,'')`, url
  `${base}/v1/chat/completions`; body
  `{ model, messages: [{role:'user', content:'ping'}], max_tokens: 1, temperature: 0, stream: false }`
  (no tools, no response_format, no plugins); headers `Content-Type` plus `Authorization:
  Bearer <key>` only when a key is set. Throw for a missing endpoint ("Set the endpoint URL")
  or missing model ("Pick or type a model id"). `openrouter` with an empty endpoint defaults to
  `https://openrouter.ai/api`; `local` defaults to `http://localhost:11434`.
- Ollama is detected by `provider === 'local'` or a `:11434` endpoint; expose
  `buildOllamaProbe(settings)` → `{ versionUrl, tagsUrl }` for the pre-check in step 2.

### Step 2: `testProvider(settings, { fetchImpl = fetch, timeoutMs = 15000 })`

Returns, never throws:

```js
{ ok: true,  ms, model, provider, note? }
{ ok: false, status?, detail, hint }
```

- AbortController + `setTimeout`; always clear the timer. `AbortError` → `{ ok:false, detail:'timed out after 15s', hint:'Is the endpoint running and reachable?' }`.
- Status mapping: `200` → ok. `401|403` → "key rejected". `404` → for `claude`, "the
  /api/anthropic proxy isn't available at this origin (static host or file://)"; otherwise
  "endpoint or model not found — check the URL and model id". `400` → include the provider's
  message (usually a bad model id). `429` → "rate limited or out of credit". `5xx` → "provider
  error". Network failure → "could not reach <host>".
- Parse the body as JSON when possible and surface `error.message` (Anthropic nests it under
  `error.message`; OpenAI-compatible providers do too).
- `local` pre-check, best effort and non-fatal: `GET ${base}/api/version`, then `/api/tags`
  with a 2s timeout; if the version answers but the model is absent from tags, succeed only
  with `note: 'model is not pulled yet — open Local Models and pull it'` (LM Studio and other
  servers have no `/api/tags`, so failures here are ignored).
- The probe costs one token; mention that in the button's title attribute.

### Step 3: Settings UI

In `SettingsModal` (API CONFIGURATION section, immediately after the MODEL field, which every
provider branch renders):

- `const [probe, setProbe] = useState(null);` (`{ busy, ...result }`).
- Button `TEST CONNECTION`, disabled while `probe?.busy`; onClick sets busy, awaits
  `testProvider(form)`, stores the result, and **does not** save the form or close the modal.
  It tests the *unsaved* form so a key can be verified before `SAVE SETTINGS`.
- Result line under the button, colored `--accent2` on success, `--danger` on failure:
  `✓ claude-haiku-4-5 responded in 412 ms` / `✗ Key rejected (401) — check the key for this
  provider`.
- Clear `probe` whenever `provider`, `localEndpoint`, `localApiKey`, `apiKey` or the model
  fields change (extend `set` for those keys, or a `useEffect` on those values).
- Do not auto-run on mount; no debounce needed.

### Step 4: tests (`test/providers.test.js`)

- `buildProviderProbe`: external URL normalization (`…/v1` and trailing slash),
  OpenRouter/local defaults, missing key/endpoint/model errors, Anthropic body shape
  (`maxTokens: 1`, no `tools`), absence of `Authorization` for keyless Ollama.
- `testProvider` with an injected fake `fetchImpl`: 200 → ok + ms; 401 → "key rejected";
  400 with a JSON body → provider message surfaced; 404 for `claude` → proxy message; 429;
  rejected promise → unreachable; a never-resolving fetch plus a 50 ms `timeoutMs` → timeout.
  Assert `fetchImpl` is the only network surface (no global `fetch` use in the helper).

### Step 5: manual verification

1. Provider `claude`, no key → immediate readable error, no request.
2. Wrong Anthropic key → `401` hint, not a chat message.
3. Ollama running with no models → "model is not pulled" note.
4. Ollama with the model pulled → green with round-trip ms.
5. OpenRouter with a valid key and `anthropic/claude-sonnet-5` → green.
6. Static `index.html` (file://) with provider `claude` → "proxy isn't available" error.

**Done when:** the button reports a correct, specific result for each provider without
saving settings or writing to the chat.

---

## Wrap-up (after all three)

1. `npm test` — hooks check + textbox + new storage/merge/providers tests.
2. `npm run build` — confirms the production IIFE path still transpiles (no new `src` files,
   so `build.mjs`'s list is unchanged).
3. Optional: `node test/browser.mjs` for the existing Playwright smoke test.
4. Add one `CHANGELOG` entry in `src/hmm-utils.jsx` (bump `version`): storage warnings,
   merged restores, Test connection.
5. Cross off **D24**, **D27**, **A3** in `docs/IDEAS.md` (or mark them `~~done~~`) and leave
   D28/B11 as the noted follow-ups.

## Risk notes

- **Merge correctness is the only place data can still be lost.** The pure function is fully
  testable; treat `test/merge.test.js` as the gate. Any rule that is ambiguous in practice
  should default to keeping local data.
- **Auto-sync merge changes behaviour for existing users** (new remote characters now appear
  without a replace prompt, which is the intent). The reload stays, but it is now safe.
- **Test connection sends the key from the browser exactly as chat already does** — no new
  exposure, but do not log the key or the response body in the console.
- **Do not change storage keys, IDB version, or the payload `version: 2` field.** Existing
  backups must stay readable by the merge path.
