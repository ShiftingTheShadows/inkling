// hmm-utils.jsx — Storage, utilities, AI, Context
const { createContext } = React;

const AppCtx = createContext(null);

// ── Storage — IndexedDB-backed with in-memory cache ─────────────
// Fixes the localStorage QuotaExceededError: base64 avatars + chat
// images blow past the ~5MB localStorage cap. IndexedDB holds
// hundreds of MB. All reads hit an in-memory Map (synchronous),
// writes go to the Map immediately and to IDB asynchronously.
/* STORAGE-CORE-START */
const __mem = new Map();
let __db = null;

function __idbOpen() {
  return new Promise((res, rej) => {
    const req = indexedDB.open('hmm_db', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('kv');
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}
// ── Storage failure reporting ────────────────────────────────────
// A refused write (disk full, private window, lost backing store) used to be a
// console.warn while the in-memory cache kept returning the "saved" value —
// silent data loss. Writes now report failures so the UI can warn and offer a
// backup export.
/* STORAGE-EXPORTS-START */
// Classify a write error so the banner can say something actionable.
function storageErrorKind(err) {
  if (!err) return 'unknown';
  const name = typeof err === 'string' ? '' : (err.name || '');
  const msg = typeof err === 'string' ? err : String(err.message || '');
  if (name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
      (typeof err === 'object' && err.code === 22) || /quota|disk is full|no space/i.test(msg)) return 'quota';
  if (name === 'SecurityError' || /denied|not allowed|blocked/i.test(msg)) return 'blocked';
  if (name === 'InvalidStateError' || /backing store|not open|connection is closing/i.test(msg)) return 'unavailable';
  return 'unknown';
}
/* STORAGE-EXPORTS-END */

const __storageErrorListeners = new Set();
let __storageHealth = { ok: true, count: 0, kind: null, last: null };
let __lastStorageFault = null; // { sig, at } — one failing tx can fire request + abort

function __reportStorageError(key, err) {
  const kind = storageErrorKind(err);
  const name = (err && err.name) || '';
  const message = String((err && err.message) || err || '').slice(0, 200);
  const now = Date.now();
  const sig = `${key}|${kind}|${name}|${message}`;
  if (__lastStorageFault && __lastStorageFault.sig === sig && now - __lastStorageFault.at < 1000) {
    __lastStorageFault.at = now;
    __storageHealth = { ...__storageHealth, count: __storageHealth.count + 1 };
    return;
  }
  __lastStorageFault = { sig, at: now };
  __storageHealth = {
    ok: false,
    count: __storageHealth.count + 1,
    kind,
    last: { key, kind, name, message, at: new Date().toISOString() },
  };
  for (const fn of [...__storageErrorListeners]) {
    try { fn({ ...__storageHealth }); } catch (e) { console.warn('Storage error listener failed:', e); }
  }
}

function __idbPut(key, val) {
  if (!__db) {
    // Fallback: best-effort localStorage (may hit quota, but don't crash)
    try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) { console.warn('Storage write failed:', key, e); __reportStorageError(key, e); }
    return;
  }
  try {
    const tx = __db.transaction('kv', 'readwrite');
    const req = tx.objectStore('kv').put(val, key);
    req.onerror = () => __reportStorageError(key, req.error);
    // A request error also aborts the transaction; the reporter dedupes that
    // within a second so one failure isn't announced twice.
    tx.onabort = () => __reportStorageError(key, tx.error);
  } catch (e) { console.warn('IDB write failed:', key, e); __reportStorageError(key, e); }
}
function __idbDel(key) {
  if (!__db) { try { localStorage.removeItem(key); } catch (e) { __reportStorageError(key, e); } return; }
  try {
    const tx = __db.transaction('kv', 'readwrite');
    const req = tx.objectStore('kv').delete(key);
    req.onerror = () => __reportStorageError(key, req.error);
    tx.onabort = () => __reportStorageError(key, tx.error);
  } catch (e) { __reportStorageError(key, e); }
}
const __get = (k, fb) => __mem.has(k) ? __mem.get(k) : fb;
// Drafts are intentionally excluded, they're not part of GistSync.buildPayload(),
// so writing them shouldn't schedule an auto-sync push (see hmm-app.jsx).
// Drafts and the automatic restore point are device-local and not part of the
// sync payload, so writing them must not schedule an auto-sync push.
const __notifyDataChange = k => { if (!k.startsWith('hmm_draft_') && !k.startsWith('hmm_snapshot_') && k !== 'hmm_textbox_font' && window.__hmmOnDataChange) window.__hmmOnDataChange(); };
const __set = (k, v) => { __mem.set(k, v); __idbPut(k, v); __notifyDataChange(k); };
// F36: chat summaries are derived state - writing one is not a data change, or
// every message save would queue a second auto-sync push for data the payload
// never carries.
const __setQuiet = (k, v) => { __mem.set(k, v); __idbPut(k, v); };

// ── Lazy chat loading (F42) ─────────────────────────────────────
// Chat bodies used to be hydrated into memory at boot along with everything
// else, so a large library paid for every message up front. Boot now keeps
// only the small records (characters, settings, meta, ...) and remembers which
// characters have a chat on disk; a chat is read when it is opened.
/* STORAGE-BOOT-START */
// `hmm_chat_meta` is the small F36 summary map, not a chat body.
function deferredChatId(key) {
  if (typeof key !== 'string' || key === 'hmm_chat_meta') return null;
  if (key.startsWith('hmm_chat_')) return key.slice('hmm_chat_'.length);
  if (key.startsWith('hmm_hist_')) return key.slice('hmm_hist_'.length);
  return null;
}

// What boot does with one stored record: keep it in memory, or note that this
// character has a chat on disk and defer its body. Split out so the storage
// test can drive the real rule instead of a copy of it.
function createBootIngest(mem) {
  const hydrated = [];
  const deferred = new Set();
  return {
    accept(key, value) {
      const id = deferredChatId(key);
      if (id != null) { deferred.add(id); return false; }
      mem.set(key, value); hydrated.push(key);
      return true;
    },
    hydrated: () => hydrated.slice(),
    deferred: () => [...deferred],
  };
}

// A save from a view that mounted before its chat loaded would otherwise
// replace the real history with an empty list or a fresh greeting. Writing is
// allowed when the chat is in memory, or when nothing is on disk yet.
function chatSaveAllowed(id, loaded, onDisk) {
  return !!loaded || !(onDisk && onDisk.has(id));
}
/* STORAGE-BOOT-END */

const __chatOnDisk = new Set(); // ids whose chat/history body is still only in IDB
const __chatLoaded = new Set(); // ids whose body is in memory now
let __allChatsLoaded = false;

function __idbGet(key) {
  return new Promise((res, rej) => {
    if (!__db) return res(undefined);
    try {
      const req = __db.transaction('kv', 'readonly').objectStore('kv').get(key);
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    } catch (e) { rej(e); }
  });
}

// Read one character's chat + saved sessions into memory. Idempotent, so a view
// can await it every time a character is opened.
async function __loadChats(id) {
  if (!id || __chatLoaded.has(id)) return __get(`hmm_chat_${id}`, []);
  try {
    const [chat, hist] = await Promise.all([__idbGet(`hmm_chat_${id}`), __idbGet(`hmm_hist_${id}`)]);
    if (chat !== undefined && !__mem.has(`hmm_chat_${id}`)) __mem.set(`hmm_chat_${id}`, chat);
    if (hist !== undefined && !__mem.has(`hmm_hist_${id}`)) __mem.set(`hmm_hist_${id}`, hist);
  } catch (e) { console.warn('Inkling: could not load chat for', id, e); }
  __chatOnDisk.delete(id);
  __chatLoaded.add(id);
  // F36 summary for a chat saved before the meta map existed. Derived state, so
  // the sidebar stays correct without loading every chat.
  if (!(__get('hmm_chat_meta', {}) || {})[id]) __writeChatMeta(id, __get(`hmm_chat_${id}`, []));
  return __get(`hmm_chat_${id}`, []);
}

// Everything-at-once read for the paths that genuinely need every chat: sync,
// backups, snapshots, deep search and restore merging.
async function __loadAllChats() {
  if (__allChatsLoaded) return;
  if (!__db) { __allChatsLoaded = true; return; } // no IDB: boot kept everything
  await new Promise((res, rej) => {
    const req = __db.transaction('kv', 'readonly').objectStore('kv').openCursor();
    req.onsuccess = () => {
      const cur = req.result;
      if (!cur) return res();
      const id = deferredChatId(cur.key);
      if (id != null) { __mem.set(cur.key, cur.value); __chatLoaded.add(id); }
      cur.continue();
    };
    req.onerror = () => rej(req.error);
  });
  __chatOnDisk.clear();
  __allChatsLoaded = true;
}

// Boot: open IDB, hydrate the small records, defer chat bodies, one-time
// migration from localStorage.
window.InklingStorageReady = (async () => {
  try {
    __db = await __idbOpen();
    const ingest = createBootIngest(__mem);
    await new Promise((res, rej) => {
      const req = __db.transaction('kv', 'readonly').objectStore('kv').openCursor();
      req.onsuccess = () => {
        const cur = req.result;
        if (cur) { ingest.accept(cur.key, cur.value); cur.continue(); } else res();
      };
      req.onerror = () => rej(req.error);
    });
    ingest.deferred().forEach(id => __chatOnDisk.add(id));
    if (ingest.deferred().length) {
      console.info(`Inkling: ${ingest.deferred().length} chat(s) stay on disk until opened`);
    }
    // Migrate legacy localStorage data once, then free the quota
    const legacy = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (/^hmm_(chars$|chat_|hist_|lorebook$|settings$|personas$)/.test(k)) legacy.push(k);
    }
    legacy.forEach(k => {
      if (!__mem.has(k)) {
        try {
          const v = JSON.parse(localStorage.getItem(k));
          if (!ingest.accept(k, v)) __chatOnDisk.add(deferredChatId(k));
          __idbPut(k, v); // deferred or not, it now lives in IDB
        } catch (e) { console.warn('Migration skipped corrupt key:', k); }
      }
    });
    legacy.forEach(k => { try { localStorage.removeItem(k); } catch {} });
    if (legacy.length) console.info(`Inkling: migrated ${legacy.length} record(s) from localStorage → IndexedDB`);
  } catch (e) {
    console.error('IndexedDB unavailable — falling back to localStorage:', e);
    __db = null;
    // No IDB to lazy-load from later: keep everything resident so nothing is
    // unreachable.
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (/^hmm_(chars$|chat_|hist_|lorebook$|settings$|personas$)/.test(k)) {
        try { __mem.set(k, JSON.parse(localStorage.getItem(k))); } catch {}
      }
    }
    __allChatsLoaded = true;
  }
  __backfillChatMeta();
})();
/* STORAGE-CORE-END */

/* SIDEBAR-EXPORTS-START */
// F36: the character list needs one line of preview per row, nothing more. It
// used to read every character's whole chat history to find that line, so each
// render re-scanned every message in the library; the summary below is written
// once when a chat is saved and the sidebar reads that single small map
// instead. `sidebarRows` is pure and is only allowed to call
// `store.chatMeta()` - a test throws from `store.chat` to catch any regression.
function chatPreviewText(raw) {
  return String(raw ?? '').replace(/\*/g, '').replace(/\s+/g, ' ').trim().slice(0, 50);
}

function chatMetaFromMessages(msgs) {
  const list = Array.isArray(msgs) ? msgs : [];
  const last = list.length ? list[list.length - 1] : null;
  const text = last
    ? (typeof last.content === 'string'
      ? last.content
      : last.content?.find?.(c => c.type === 'text')?.text || '')
    : '';
  return {
    count: list.length,
    preview: chatPreviewText(text),
    lastRole: last?.role || null,
    lastAt: last?.timestamp || null,
  };
}

// Rows come back in the order given - the sidebar's own search/filter/sort has
// already run. A chat with no messages falls back to the greeting, then the
// description, exactly as the old per-row read did.
function sidebarRows(chars, store) {
  const meta = (store && typeof store.chatMeta === 'function' ? store.chatMeta() : null) || {};
  return (chars || []).map(char => {
    const m = meta[char.id];
    return {
      char,
      count: m?.count || 0,
      lastAt: m?.lastAt || null,
      preview: chatPreviewText(m?.preview || char.firstMessage || char.description || ''),
    };
  });
}

// F37: the sidebar's order choices, in display order. Lives here rather than
// inline so a test can fail if A→Z disappears, and so the value read back from
// settings is validated against exactly what the UI offers.
function sidebarSortOptions() {
  return [
    ['all', 'ALL'],
    ['fav', '★ FAV'],
    ['recent', 'RECENT'],
    ['alpha', 'A→Z'],
  ];
}

// The stored choice, or ALL when nothing (or something retired) is saved.
function sidebarSortValue(settings) {
  const v = settings?.sidebarSort;
  return sidebarSortOptions().some(([id]) => id === v) ? v : 'all';
}

// Persisted through settings like every other choice in the app, so a reload
// keeps the option selected. Returns a new object; never mutates the input.
function withSidebarSort(settings, mode) {
  const v = sidebarSortOptions().some(([id]) => id === mode) ? mode : 'all';
  return { ...(settings || {}), sidebarSort: v };
}

// Applied after search/filtering, so the visible order is what the label says.
// Alphabetical compares lowercased names, so 'anna' sorts before 'Bob'; equal
// names keep their existing order because Array#sort is stable.
function sidebarSortCharacters(chars, mode) {
  const list = [...(chars || [])];
  if (mode === 'recent') return list.sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));
  if (mode === 'alpha') {
    return list.sort((a, b) => {
      const an = String(a?.name || '').toLowerCase();
      const bn = String(b?.name || '').toLowerCase();
      return an < bn ? -1 : an > bn ? 1 : 0;
    });
  }
  return list;
}
/* SIDEBAR-EXPORTS-END */

// Keep `hmm_chat_meta` in step with the one write path every chat goes through
// (saveChat). An empty chat has no entry, so its row falls back to the
// greeting instead of showing a stale snippet.
function __writeChatMeta(id, msgs) {
  if (!id) return;
  const map = { ...(__get('hmm_chat_meta', {}) || {}) };
  if (Array.isArray(msgs) && msgs.length) map[id] = chatMetaFromMessages(msgs);
  else delete map[id];
  __setQuiet('hmm_chat_meta', map);
}

// F36: chats saved before this map existed (or by a build that predates it)
// get their summary built on the next boot from the value boot already loaded,
// so no extra IDB read is needed. Entries for deleted characters are dropped
// here too - the summary map is derived state and never syncs.
function __backfillChatMeta() {
  const chars = __get('hmm_chars', []) || [];
  const meta = { ...(__get('hmm_chat_meta', {}) || {}) };
  const ids = new Set(chars.map(c => c.id));
  let changed = false;
  for (const id of Object.keys(meta)) if (!ids.has(id)) { delete meta[id]; changed = true; }
  for (const c of chars) {
    const key = `hmm_chat_${c.id}`;
    if (!__mem.has(key)) continue;
    const msgs = __mem.get(key);
    const next = Array.isArray(msgs) && msgs.length ? chatMetaFromMessages(msgs) : null;
    const prev = meta[c.id];
    if (next && (!prev || prev.count !== next.count)) { meta[c.id] = next; changed = true; }
    else if (!next && prev) { delete meta[c.id]; changed = true; }
  }
  if (changed) __setQuiet('hmm_chat_meta', meta);
}

const S = {
  chars: () => __get('hmm_chars', []),
  saveChars: v => __set('hmm_chars', v),
  folders: () => __get('hmm_folders', []),
  saveFolders: v => __set('hmm_folders', v),
  chat: id => __get(`hmm_chat_${id}`, []),
  // F42: chats are no longer all resident. Views await loadChats(id) for the
  // character they are about to show; loadAllChats() is for the few paths that
  // really need every chat (sync, backups, snapshots, deep search, restore).
  chatLoaded: id => __chatLoaded.has(id),
  chatsLoaded: () => __allChatsLoaded,
  loadChats: id => __loadChats(id),
  loadAllChats: () => __loadAllChats(),
  chatCacheStats: () => ({ inMemory: __chatLoaded.size, onDisk: __chatOnDisk.size, allLoaded: __allChatsLoaded }),
  // F36: the sidebar reads this instead of every chat. Derived on save, so it
  // is never stale and never part of buildPayload().
  chatMeta: () => __get('hmm_chat_meta', {}) || {},
  saveChat: (id, v) => {
    if (!chatSaveAllowed(id, __chatLoaded.has(id), __chatOnDisk)) {
      console.warn(`Inkling: refused to save chat ${id} before it was loaded`);
      return false;
    }
    __chatLoaded.add(id); __chatOnDisk.delete(id);
    __set(`hmm_chat_${id}`, v); __writeChatMeta(id, v);
    return true;
  },
  history: id => __get(`hmm_hist_${id}`, []),
  saveHistory: (id, v) => __set(`hmm_hist_${id}`, v),
  // AI-assist design chat, per character. Lives in IndexedDB and rides the
  // normal sync payload so your character-building conversations follow you
  // across devices like chats and histories do.
  assistChat: id => __get(`hmm_assist_${id}`, []),
  saveAssistChat: (id, v) => (v && v.length)
    ? __set(`hmm_assist_${id}`, v)
    : (__mem.delete(`hmm_assist_${id}`), __idbDel(`hmm_assist_${id}`), __notifyDataChange(`hmm_assist_${id}`)),
  draft: id => __get(`hmm_draft_${id}`, ''),
  saveDraft: (id, v) => v ? __set(`hmm_draft_${id}`, v) : (__mem.delete(`hmm_draft_${id}`), __idbDel(`hmm_draft_${id}`)),
  lorebook: () => __get('hmm_lorebook', []),
  saveLorebook: v => __set('hmm_lorebook', v),
  // Scripts — attachable lorebooks with advanced trigger rules.
  // Auto-migrates the legacy flat lorebook into a global script.
  scripts: () => {
    const sc = __get('hmm_scripts', null);
    if (sc) return sc;
    const legacy = __get('hmm_lorebook', []);
    if (!legacy.length) return [];
    return [{
      id: 'legacy_lorebook', name: 'Lorebook', description: 'Migrated from the old Lorebook',
      enabled: true, global: true, charIds: [],
      entries: legacy.map(e => ({ probability: 100, minMessages: 0, order: 5, group: '', groupWeight: 100, depth: 8, ...e })),
    }];
  },
  saveScripts: v => __set('hmm_scripts', v),
  deleteCharData: id => {
    __mem.delete(`hmm_chat_${id}`); __mem.delete(`hmm_hist_${id}`); __mem.delete(`hmm_draft_${id}`); __mem.delete(`hmm_assist_${id}`);
    __idbDel(`hmm_chat_${id}`); __idbDel(`hmm_hist_${id}`); __idbDel(`hmm_draft_${id}`); __idbDel(`hmm_assist_${id}`);
    __chatOnDisk.delete(id); __chatLoaded.delete(id);
    const meta = { ...(__get('hmm_chat_meta', {}) || {}) };
    if (id in meta) { delete meta[id]; __setQuiet('hmm_chat_meta', meta); }
  },
  clearAll: () => new Promise(res => {
    __mem.clear(); __chatOnDisk.clear(); __chatLoaded.clear(); __allChatsLoaded = true;
    if (!__db) return res();
    try {
      const tx = __db.transaction('kv', 'readwrite');
      tx.objectStore('kv').clear();
      tx.onerror = () => __reportStorageError('hmm_*', tx.error);
      tx.oncomplete = tx.onabort = () => res();
    } catch (e) { __reportStorageError('hmm_*', e); res(); }
  }),
  // Storage diagnostics. onStorageError fires immediately with the current
  // state so a component that mounts after a boot-time failure still sees it.
  storageHealth: () => ({ ...__storageHealth }),
  onStorageError: fn => {
    __storageErrorListeners.add(fn);
    try { fn({ ...__storageHealth }); } catch {}
    return () => __storageErrorListeners.delete(fn);
  },
  // One automatic restore point, overwritten by each destructive action. Not
  // synced (buildPayload never reads it) and skipped when a second copy would
  // eat a large share of the quota. Built here rather than in the UI so every
  // caller gets the same payload shape as a normal backup.
  snapshot: () => __get('hmm_snapshot_auto', null),
  snapshotNow: async label => {
    try {
      await __loadAllChats();
      const payload = GistSync.buildPayload();
      if (JSON.stringify(payload).length > 4000000) return null; // ~8MB — not worth the quota
      const snap = { at: new Date().toISOString(), label, payload };
      __set('hmm_snapshot_auto', snap);
      return snap;
    } catch (e) { console.warn('Auto snapshot failed:', e); return null; }
  },
  clearSnapshot: () => { __mem.delete('hmm_snapshot_auto'); __idbDel('hmm_snapshot_auto'); },
  settings: () => {
    const saved = { ...__get('hmm_settings', {}) };
    const DEFAULT_PROVIDERS = {
      openrouter: { endpoint: 'https://openrouter.ai/api', key: '', model: 'anthropic/claude-sonnet-5' },
      local: { endpoint: '', key: '', model: 'llama3' },
      custom: { endpoint: '', key: '', model: '' },
    };
    const savedProviders = saved.providers || {};
    const providers = Object.fromEntries(Object.entries(DEFAULT_PROVIDERS).map(([id, def]) => [id, { ...def, ...(savedProviders[id] || {}) }]));
    if (!saved.providers && saved.provider && saved.provider !== 'claude' && providers[saved.provider]) {
      providers[saved.provider] = {
        endpoint: saved.localEndpoint ?? providers[saved.provider].endpoint,
        key: saved.localApiKey ?? providers[saved.provider].key,
        model: saved.localModel || providers[saved.provider].model,
      };
    }
    // Retired Anthropic model ids saved before the 2026-07 refresh — old ids now 404
    const MODEL_MIGRATE = {
      'claude-sonnet-4-20250514': 'claude-sonnet-5',
      'claude-opus-4-20250514': 'claude-opus-4-8',
    };
    if (MODEL_MIGRATE[saved.model]) saved.model = MODEL_MIGRATE[saved.model];
    return {
      model: 'claude-haiku-4-5',
      temperature: 0.8,
      maxTokens: 1024,
      topP: 0.9,
      // Provider feature parity — only sent when set, so backends that don't
      // understand them never see them.
      stopSequences: '', // one per line, max 4
      presencePenalty: 0, // 0 = backend default
      frequencyPenalty: 0,
      topK: 0, // 0 = backend default
      seed: '', // blank = random
      // A7: assists, summaries and character generation can use a cheaper model
      // than the chat. Blank = follow the chat provider/model.
      utilityModel: '',
      utilityProvider: '',
      autoScroll: true,
      showTokens: true,
      showTimestamps: true, // B17 toggle lives in Settings → Appearance
      sidebarSort: 'all', // F37: ALL | FAV | RECENT | A→Z, persisted like any other choice
      imageHost: 'freeimage', // F41: freeimage | imgbb | custom — the destination for greeting images
      imageHostEndpoint: '', // F41: only used by the custom host; must be a public https URL
      theme: 'terminal',
      avatarScale: 1, // 0.4 (tiny) – 2.5 (huge)
      provider: 'claude', // 'claude' | 'openrouter' | 'local' | 'custom'
      assistStyleGuidelines: '',
      assistGuidelines: '', // the per-use GUIDELINES box in the assist panel; persisted so it's not retyped
      charFormatTemplate: 'plain', // 'plain' | 'w++' | 'boostyle' — character generator only
      webSearch: false,
      searchBackend: 'auto', // 'auto' | 'tavily' | 'brave' | 'ddg' | 'native' (native = Claude / OpenRouter built-in)
      searchMaxUses: 3,      // most lookups the model may make per reply
      searchMaxResults: 5,
      tavilyKey: '',
      braveKey: '',
      uiPolish: true, // subtle rounded corners + motion; false = legacy square look
      ...saved,
      // One saved profile per external provider, so switching OpenRouter →
      // Ollama → back no longer makes you retype URL, key and model. The flat
      // localEndpoint/localApiKey/localModel fields are migrated once, for
      // whichever provider was active when they were written.
      providers,
    };
  },
  saveSettings: v => __set('hmm_settings', v),
  personas: () => __get('hmm_personas', null) || [{ id: 'default', name: 'You', description: '', avatar: '' }],
  savePersonas: v => __set('hmm_personas', v),
  // D26: soft deletes. A deleted character (with its chat and history) or a
  // cleared chat sits here for 30 days and can be restored from Settings.
  trash: () => __get('hmm_trash', []) || [],
  addTrash: entry => {
    const list = __get('hmm_trash', []) || [];
    const next = [{ ...entry, tid: genId(), deletedAt: new Date().toISOString() }, ...list].slice(0, 50);
    __set('hmm_trash', next);
    return next;
  },
  purgeTrash: () => {
    const list = (__get('hmm_trash', []) || []).filter(e => !trashExpired(e));
    __set('hmm_trash', list);
    return list;
  },
  restoreTrash: tid => {
    const list = __get('hmm_trash', []) || [];
    const entry = list.find(e => e.tid === tid);
    if (!entry) return null;
    if (entry.type === 'character' && entry.character) {
      const chars = S.chars();
      if (!chars.some(c => c.id === entry.character.id)) S.saveChars([...chars, entry.character]);
      if (Array.isArray(entry.chat)) S.saveChat(entry.character.id, entry.chat);
      if (Array.isArray(entry.history)) S.saveHistory(entry.character.id, entry.history);
    } else if (entry.type === 'chat' && entry.charId) {
      S.saveChat(entry.charId, entry.chat || []);
    }
    __set('hmm_trash', list.filter(e => e.tid !== tid));
    return entry;
  },
  emptyTrash: () => __set('hmm_trash', []),
  // Revision of the sync backup this device last read or wrote. null means
  // "never seen one", which opts the push out of optimistic concurrency.
  syncRevision: () => {
    const v = localStorage.getItem('hmm_sync_revision');
    return v == null ? null : Number(v);
  },
  setSyncRevision: rev => { if (Number.isInteger(rev) && rev >= 0) localStorage.setItem('hmm_sync_revision', String(rev)); },
  // Per-chat persona override, keyed by character id. Device-local on purpose:
  // which face you present in a story is a here-and-now choice, not something
  // to sync around.
  chatPersonaId: charId => (__get('hmm_chat_personas', {}) || {})[charId] || '',
  setChatPersonaId: (charId, id) => {
    if (!charId) return;
    const m = { ...(__get('hmm_chat_personas', {}) || {}) };
    if (id) m[charId] = id; else delete m[charId];
    __set('hmm_chat_personas', m);
  },
  activePersonaId: () => localStorage.getItem('hmm_active_persona') || 'default',
  setActivePersonaId: id => { localStorage.setItem('hmm_active_persona', id); __notifyDataChange('hmm_active_persona'); },
  // C21: the uploaded textbox font is a binary asset, device-local by design —
  // it is not in buildPayload(), so it neither syncs nor rides the backup JSON.
  // Re-upload on another device (or after clearing site data).
  textboxFont: () => __get('hmm_textbox_font', null),
  saveTextboxFont: v => { __set('hmm_textbox_font', v); return true; },
  clearTextboxFont: () => { __mem.delete('hmm_textbox_font'); __idbDel('hmm_textbox_font'); },
  lastSeenChangelog: () => localStorage.getItem('hmm_changelog_seen') || '',
  setLastSeenChangelog: v => localStorage.setItem('hmm_changelog_seen', v),
};

// Changelog: newest entry first. Bump the top `version` (a date works
// fine) whenever entries are added so returning users get an auto-popup.
const CHANGELOG = [
  {
    version: '2026-11-17',
    date: 'Nov 17, 2026',
    items: [
      'Changed: chats load when you open a character instead of all at startup — a big library now boots with far less memory and no up-front history read. Message counts and previews in the sidebar and on the welcome screen still appear immediately.',
      'Changed: greeting images can upload to imgbb or a custom upload URL (self-hosted, S3/R2) instead of only freeimage.host — pick the host in Settings → Integrations. Unconfigured installs keep using freeimage.host exactly as before.',
      'Changed: web search reads JavaScript-rendered pages. A page that arrives as an empty shell is re-read through a renderer instead of coming back blank, and keyless search falls back to a second no-key provider when DuckDuckGo blocks the request, so search still works with no API key set. Page reads also verify where a hostname actually points (including each redirect) before fetching, and the remote MCP server refuses requests addressed to an unexpected host or coming from another site.',
      'New: an A→Z sort for the character sidebar, alongside ALL, ★ FAV and RECENT. The choice is saved with your settings, so it is still selected after a reload.',
      'Changed: the character sidebar no longer re-reads every chat to draw its preview lines. A one-line summary is written when a chat is saved and the list reads that, so big libraries no longer scan every message on every render; existing chats are summarized once on the next load.',
      'New: MCP can edit or delete a single chat message by id or position instead of clearing the chat, read the folder structure as a nested tree, and fetch only the character fields it needs — so long backups stop flooding the assistant\'s context.',
      'New: per-character textbox blips. Each character can override the global typing-sound setting (on, off, or follow Settings) and set its own volume, alongside the blip pitch it already had — all on the character record, so it syncs with the rest of the character.',
      'New: long textbox replies can turn their own pages (Settings → Appearance → Auto-advance textbox pages). The newest reply types, waits two seconds, then moves to the next page until the box is done; clicking or using the arrows takes over and stops it.',
      'New: end-to-end encryption for Railway sync. The backup is stored as an AES-GCM envelope keyed by a passphrase the server never sees, unlocked once per device (optionally remembered). Enabling encrypts and replaces the plaintext backup, LOCK NOW drops the key, and changing the passphrase re-encrypts and re-uploads the backup; a forgotten passphrase cannot be recovered, so download a plaintext backup first.',
      'Changed: a locked or unencrypted browser refuses to push plaintext over an encrypted backup, and MCP says it cannot read or edit ciphertext instead of writing over it.',
      'Note for self-hosted sync servers: the encrypted-backup flag on /api/sync/meta takes effect once server/ is redeployed. Until then pulls still detect and decrypt encrypted backups, but a browser without the passphrase cannot be warned before it pushes.',
      'New: upload your own textbox font (Settings → Appearance) — TTF, OTF, WOFF or WOFF2 up to 2 MB, checked by file signature rather than extension, applied immediately and on every reload. It is stored on this device only, so sync and backup files never carry it; reset to the bundled Determination Mono any time, with its licence shown beside the control.',
      'New: group chats can hand direction to a cheap utility model — DIRECTOR picks who speaks next instead of strict rotation, with an automatic fallback to rotation when the model answers with something unusable.',
      'New: a group can produce 1–3 replies per turn, one after another, each seeing the previous reply. Set it per group in the group editor or from the chat menu.',
      'New: the context meter now uses real token counts reported by the provider (including cached Anthropic input) and the model\'s actual context window — from Settings, the live model list, or a known model family — instead of an estimate divided by a fixed 16k. Endpoints that report no usage still fall back to the estimate.',
      'New: a CONTEXT WINDOW field in Settings for local and custom models, so auto-summarize fires at the right point instead of at 75% of 16k.',
      'New: storage warnings. If the browser refuses a save (disk full, private window, blocked site data), a banner says so and offers a backup export instead of failing silently.',
      'Changed: restoring a backup now merges by default — new characters, folders and scripts are added, newer records win, and a longer local chat is never replaced by an older one. Gist pull, Railway pull, auto-sync and file import all use it; "Replace everything" is still one click away.',
      'New: TEST CONNECTION in Settings sends a one-token request and reports exactly what is wrong — key, endpoint, model, timeout, or a missing /api proxy — instead of a broken reply in the chat.',
      'Fixed: web search. DuckDuckGo started rejecting the app\'s non-browser request, so keyless search quietly returned nothing; it now uses a normal browser request, and a failed lookup is shown under the reply instead of only being told to the AI.',
      'New: the status bar shows the model of the provider you actually selected, including OpenRouter and local models.',
      'New: one automatic restore point is taken before deleting a character, clearing a chat, or replacing all data. Restore or discard it in Settings → Storage.',
      'New: each provider (OpenRouter, local, custom) keeps its own endpoint, key and model, so switching back no longer means retyping — and a synced phone no longer inherits localhost.',
      'New: provider presets fill the endpoint and a starting model in one pick (OpenAI, Gemini, Groq, DeepSeek, Mistral, xAI, Together, Cerebras, Fireworks, LM Studio, Ollama).',
      'New: per-chat persona — choose a face for one story without changing the global default, with USE GLOBAL and SET AS GLOBAL in the persona menu.',
      'New: a failed reply stays in the chat with the reason and RETRY / SWITCH PROVIDER. Transient 429/5xx errors retry twice, and a stalled provider times out after 90 seconds instead of hanging.',
      'New: stop sequences, presence/frequency penalty, top-k and seed in Settings, plus prompt caching on Claude calls.',
      'New: LOAD LIVE MODEL LIST in Settings pulls OpenRouter\'s current catalogue with context size and input price.',
      'Changed: Railway sync uses the server\'s revision, so two devices pushing at once no longer overwrite each other silently. A conflict offers merge-theirs (recommended) or overwrite-mine, and unattended auto-sync always merges.',
      'Changed: the sync server throttles requests per IP, answers CORS only for the app and local development, and has a purge path (DELETE /api/sync).',
      'New: MCP tools inkling_search_messages (full-text across every chat) and INKLING_MCP_READ_ONLY=1, which exposes read-only tools only.',
      'New: when a chat reaches ~75% of the context window it summarizes the oldest turns by itself, and the result appears as a collapsible "Earlier context summarized" note.',
      'New: present mode — fullscreen, hidden chrome, a larger textbox, and click/Space to advance (← back, Esc exits), from the chat menu.',
      'New: search inside a chat shows "n of m" with prev/next jumping, and Ctrl+K now finds matching messages and lorebook entries across every chat.',
      'New: paste or drag images straight into the composer (up to four per message), plus a camera button on mobile.',
      'New: undo-friendly message editing — SAVE changes a message in place, SAVE & RESEND keeps the old behaviour, and swiping your own message opens the editor.',
      'New: an optional utility model for assists, summaries and character generation, so the expensive chat model is not spent on housekeeping.',
      'New: per-chat export as Markdown, JSON or HTML from the chat menu — the HTML is a self-contained readable page.',
      'New: a CONTINUE button in solo chats moves the scene on without inventing a message from you.',
      'New: deleted characters and cleared chats go to Trash for 30 days and can be restored from Settings → Storage.',
      'Changed: modals are real dialogs — screen readers announce them, Tab stays inside, focus returns where it was, and icon buttons take their accessible name from their tooltip.',
      'Changed: the timestamp toggle is on by default and remembered, so message times can be hidden from Settings → Appearance.',
    ],
  },
  {
    version: '2026-10-17',
    date: 'Oct 17, 2026',
    items: [
      'New: Web search rebuilt. The model now decides when to look something up and writes its own query, instead of your roleplay message being fed to a search engine every turn. It can also read pages, and you get a "sources" strip under the reply.',
      'New: Web search works on every provider — Claude (native search), OpenRouter, and local/custom models (built-in search tool, with a fallback for models that cannot call tools).',
      'New: Connect Claude (MCP) setup guide — Sync → Railway or Ctrl+K. Generates copy-paste config for Claude Code, Claude Desktop, Cursor, and VS Code with your sync URL filled in.',
      'New: Local Models manager (Ctrl+K, or Settings → Local) — self-host text models with Ollama: see what\'s installed, download new ones with a progress bar, switch with one click, delete.',
      'New: Linux desktop app (AppImage / .deb) — see the README.',
      'New: Search backends — Tavily or Brave (add a key) or keyless DuckDuckGo. Pick in Settings → Web Search. Keys stay on your device and are never synced.',
    ],
  },
  {
    version: '2026-10-16',
    date: 'Oct 16, 2026',
    items: [
      'New: Character Folders — a visual page (📁 FOLDERS in the sidebar) to organize characters into nestable, color-coded folders. Drag characters onto folders, or use the ⇢ button on touch screens. Replaces the old sidebar GROUP toggle.',
    ],
  },
  {
    version: '2026-07-19',
    date: 'Jul 19, 2026',
    items: [
      'New: "What\'s New" changelog, opens automatically after an update, or any time from the command palette.',
      'New: Drag-and-drop or pick an image on a greeting to auto-upload it and embed it, no more manual upload-then-paste. Needs a free freeimage.host API key in Settings → Integrations.',
      'New: Paste raw JSON directly into the character editor instead of only importing from a file.',
      'New: Custom chat background image (animated GIFs supported) and custom CSS injection, in Settings → Theme.',
      'New: The message box now remembers your draft per-character across refreshes and character switches, and can be manually resized.',
      'New: Railway sync, an alternative to GitHub Gist sync backed by your own Postgres database (Settings → Sync → Railway tab). See server/README.md to deploy it.',
      'New: Railway auto-sync, pushes a few seconds after any change and pulls automatically when another device has pushed something newer.',
      'Fixed: group chat messages from different characters replying back-to-back no longer hide each other\'s avatar/name.',
      'Fixed: a restored draft now resizes the message box to fit instead of staying cramped at minimum height.',
      'New: Settings → AI Assist — universal style guidelines applied to every AI-generated response (chat, write/enhance/impersonate, character & persona generation), plus a character format template (Plain/W++/Boostyle).',
      'New: markdown rendering now covers headers, lists, blockquotes, horizontal rules, and strikethrough, not just bold/italic/code/links.',
      'Changed: the character generator\'s web search toggle now follows the global Web Search setting instead of its own separate one-off checkbox.',
    ],
  },
];

// ── Utilities ────────────────────────────────────────────────────
const genId = () => Math.random().toString(36).slice(2, 9) + Date.now().toString(36);

// Character/persona avatar size — user-configurable scale (slider, 0.4-2.5x)
// applied on top of each call site's base size (sidebar list, message row,
// chat header). Legacy small/medium/large presets map to a scale for
// settings saved before the slider replaced them.
const AVATAR_SIZE_PRESET = { small: 0.75, medium: 1, large: 1.3 };
const avatarPx = (settings, base) => {
  const scale = typeof settings?.avatarScale === 'number' ? settings.avatarScale : (AVATAR_SIZE_PRESET[settings?.avatarSize] || 1);
  return Math.round(base * scale);
};

// Downscale + re-encode an image data-URL so stored avatars/attachments stay small
function compressImage(dataUrl, maxDim = 512, quality = 0.85) {
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
      if (scale === 1 && dataUrl.length < 250000) return resolve(dataUrl);
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(img.width * scale));
      c.height = Math.max(1, Math.round(img.height * scale));
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      try {
        const out = c.toDataURL('image/webp', quality);
        resolve(out.length < dataUrl.length ? out : dataUrl);
      } catch { resolve(dataUrl); }
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}
/* IMAGE-HOST-START */
// F41: greeting-image uploads used to be hardwired to freeimage.host. The host
// is now a setting; 'freeimage' stays the default so an unconfigured install
// sends exactly the request it always did. Pure — maps settings onto the
// multipart fields /api/imgupload reads (the server repeats these rules, so
// the two must agree; test/imgupload.test.js pins that they do).
const IMAGE_HOST_IDS = ['freeimage', 'imgbb', 'custom'];
function resolveImageHost(settings) {
  const id = String(settings?.imageHost || 'freeimage');
  return IMAGE_HOST_IDS.includes(id) ? id : 'freeimage';
}
// freeimage and imgbb need a key; a custom endpoint may be open or may take
// the key as an optional 'key' field.
function imageHostNeedsKey(host) {
  return host !== 'custom';
}
function imageUploadConfig(settings) {
  const host = resolveImageHost(settings);
  return {
    host,
    apiKey: String(settings?.imageHostApiKey || '').trim(),
    endpoint: String(settings?.imageHostEndpoint || '').trim(),
    needsKey: imageHostNeedsKey(host),
  };
}
/* IMAGE-HOST-END */

// Uploads an image to the configured host and returns its public URL, used to
// auto-embed images in greetings instead of a manual upload-then-paste-the-link
// workflow. Routed through /api/imgupload rather than calling the host directly
// since the hosts, like Catbox, send no CORS headers a browser fetch() could
// work with (see api/imgupload.js for the full history).
async function uploadImage(file, settings) {
  const cfg = imageUploadConfig(settings);
  if (cfg.needsKey && !cfg.apiKey) throw new Error('Add an image host API key in Settings first');
  if (cfg.host === 'custom' && !cfg.endpoint) throw new Error('Add the custom image host URL in Settings first');
  const fd = new FormData();
  fd.append('file', file);
  fd.append('host', cfg.host);
  fd.append('apiKey', cfg.apiKey);
  if (cfg.host === 'custom') fd.append('endpoint', cfg.endpoint);
  const res = await fetch('/api/imgupload', { method: 'POST', body: fd });
  let j = null;
  try { j = await res.json(); } catch {}
  if (!res.ok || !j?.url) throw new Error(j?.error || `Upload failed (${res.status})`);
  return j.url;
}

const estimateTokens = text => Math.ceil((text || '').length / 4);
/* FONT-VALIDATE-START */
// C21: user-supplied textbox fonts. Magic bytes decide the format, not the file
// extension or the browser-reported MIME, so a renamed file is rejected before
// anything large or unparseable reaches IndexedDB. Pure so test/font.test.js can
// cover it without a DOM.
const TEXTBOX_FONT_MAX_BYTES = 2 * 1024 * 1024;
const TEXTBOX_FONT_FORMATS = { ttf: 'font/ttf', otf: 'font/otf', woff: 'font/woff', woff2: 'font/woff2' };

// The test harness returns functions only, so the limit is reachable from the
// pure slice without duplicating the number in the tests.
function textboxFontMaxBytes() { return TEXTBOX_FONT_MAX_BYTES; }

function detectFontFormat(bytes) {
  const b = bytes || [];
  const at = i => Number(b[i] ?? -1);
  if (at(0) === 0 && at(1) === 1 && at(2) === 0 && at(3) === 0) return 'ttf';
  if (at(0) === 0x74 && at(1) === 0x72 && at(2) === 0x75 && at(3) === 0x65) return 'ttf'; // 'true'
  if (at(0) === 0x4F && at(1) === 0x54 && at(2) === 0x54 && at(3) === 0x4F) return 'otf'; // 'OTTO'
  if (at(0) === 0x77 && at(1) === 0x4F && at(2) === 0x46 && at(3) === 0x46) return 'woff'; // 'wOFF'
  if (at(0) === 0x77 && at(1) === 0x4F && at(2) === 0x46 && at(3) === 0x32) return 'woff2';
  return null;
}

function validateTextboxFont({ name, size, bytes } = {}) {
  const label = String(name || 'font');
  const byteLength = Number(size) || (bytes && bytes.length) || 0;
  if (!bytes || !byteLength) return { ok: false, error: `${label} is empty` };
  if (byteLength > TEXTBOX_FONT_MAX_BYTES) {
    return { ok: false, error: `${label} is ${(byteLength / 1048576).toFixed(1)} MB — fonts must be 2 MB or smaller` };
  }
  const format = detectFontFormat(bytes);
  if (!format) return { ok: false, error: `${label} is not a TTF, OTF, WOFF or WOFF2 font` };
  const ext = String(label).split('.').pop().toLowerCase();
  if (TEXTBOX_FONT_FORMATS[ext] && ext !== format) {
    return { ok: false, error: `${label} contains ${format.toUpperCase()} data but is named .${ext}` };
  }
  return { ok: true, format, mime: TEXTBOX_FONT_FORMATS[format], size: byteLength };
}

// The textbox paginates by character count, so a proportional font still
// "works" but visibly misaligns. Measured widths of 'i' and 'W' are a cheap
// check; it warns, never blocks, because some pixel fonts differ by a hair.
function isMonospaceMetrics({ i, W, tolerance = 0.5 } = {}) {
  if (!Number.isFinite(i) || !Number.isFinite(W)) return false;
  return Math.abs(i - W) <= tolerance;
}
/* FONT-VALIDATE-END */

// C21: install an uploaded font for the textbox. The family name is fixed, so
// the stylesheet var can point at it, and the data URL is whatever the FileReader
// produced from the file we already validated.
function applyTextboxFont(font) {
  const existing = document.getElementById('hmm-custom-font');
  if (existing) existing.remove();
  const root = document.documentElement;
  if (!font || !font.dataUrl) {
    root.style.removeProperty('--tbx-font');
    return false;
  }
  const style = document.createElement('style');
  style.id = 'hmm-custom-font';
  style.textContent = `@font-face{font-family:'Inkling Custom Textbox';src:url('${font.dataUrl}');font-display:block;}`;
  document.head.appendChild(style);
  root.style.setProperty('--tbx-font', "'Inkling Custom Textbox', 'Determination Mono', 'JetBrains Mono', monospace");
  try { document.fonts?.load?.('16px "Inkling Custom Textbox"'); } catch {}
  return true;
}

// Widths of a narrow and a wide glyph in the installed font, for the monospace
// warning. Null when the FontFace API is unavailable.
async function textboxFontMetrics() {
  try {
    await document.fonts?.load?.('16px "Inkling Custom Textbox"');
    const ctx = document.createElement('canvas').getContext('2d');
    if (!ctx) return null;
    ctx.font = '16px "Inkling Custom Textbox"';
    return { i: ctx.measureText('i').width, W: ctx.measureText('W').width };
  } catch { return null; }
}

/* GROUP-TURN-START */
// B15: multi-member group turns. The director prompt and the rotation fallback
// are pure so test/group.test.js can pin the behaviour without a model call.
const MAX_GROUP_REPLIES = 3;

function normalizeGroupReplies(n) {
  const v = Math.round(Number(n));
  return v >= 2 && v <= MAX_GROUP_REPLIES ? v : 1;
}

// Who speaks next: an explicit mention wins, otherwise round-robin after the
// last character who spoke. A user message or narrator note never counts as a
// speaker, and an unknown/absent last id starts the rotation at the top.
function nextGroupSpeaker(members, messages, { mentionText = '' } = {}) {
  const list = (members || []).filter(Boolean);
  if (!list.length) return null;
  const text = String(mentionText || '').toLowerCase();
  if (text) {
    const mentioned = list.filter(m => String(m.name || '').trim() && text.includes(String(m.name).toLowerCase()));
    if (mentioned.length) return mentioned[0];
  }
  const lastId = [...(messages || [])]
    .reverse()
    .find(m => m && m.role === 'assistant' && m.charId)?.charId;
  const idx = list.findIndex(m => m.id === lastId);
  return list[(idx + 1) % list.length];
}

// The director is asked for one name. Accept "Vera", "Vera:", "Vera — she…",
// quoted or bolded forms, and never return someone who just spoke or a name
// that is not actually a member.
function parseDirectorChoice(text, members, { excludeId } = {}) {
  const list = (members || []).filter(Boolean).filter(m => m.id !== excludeId);
  if (!list.length) return null;
  const raw = String(text || '')
    .trim()
    .replace(/^[*_"'`]+/, '')
    .replace(/[*_"'`.,:;!]+$/, '')
    .trim();
  if (!raw) return null;
  const lower = raw.toLowerCase();
  const exact = list.find(m => String(m.name || '').toLowerCase() === lower);
  if (exact) return exact;
  const starts = list.find(m => String(m.name || '').trim() && lower.startsWith(String(m.name).toLowerCase()));
  if (starts) return starts;
  return list.find(m => String(m.name || '').trim() && lower.includes(String(m.name).toLowerCase())) || null;
}
/* GROUP-TURN-END */

/* USAGE-START */
// A8: honest token accounting. Providers report what they actually charged;
// prefer that over counting characters, and divide by the model's real context
// window instead of a fixed 16k. Kept DOM-free so test/usage.test.js can run it.
const DEFAULT_CONTEXT_LENGTH = 16000;

// Conservative fallbacks for families whose window is stable and well known.
// Anything else (local models especially) uses the Settings override or the
// 16k default rather than a guess.
const KNOWN_CONTEXT_LENGTHS = [
  [/^claude/i, 200000],
  [/^gpt-4\.1/i, 1047576],
  [/^gpt-4o/i, 128000],
  [/^gpt-4-turbo/i, 128000],
  [/^gpt-3\.5/i, 16385],
  [/^o[134](-|$)/i, 200000],
  [/^gemini/i, 1048576],
  [/^mistral-large/i, 128000],
  [/^llama-?3/i, 131072],
];

// OpenAI-compatible endpoints: prompt_tokens/completion_tokens, some gateways
// use input_tokens/output_tokens. Either way, total = input + output.
function parseOpenAIUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const input = Number(usage.prompt_tokens ?? usage.input_tokens ?? 0);
  const output = Number(usage.completion_tokens ?? usage.output_tokens ?? 0);
  if (!input && !output) return null;
  return { input, output, total: input + output };
}

// Anthropic splits cached input out of input_tokens, so the real context is the
// sum of all three. message_start carries input, message_delta carries the
// final output count; both arrive in a stream.
function parseAnthropicUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const input = Number(usage.input_tokens || 0)
    + Number(usage.cache_creation_input_tokens || 0)
    + Number(usage.cache_read_input_tokens || 0);
  const output = Number(usage.output_tokens || 0);
  if (!input && !output) return null;
  return { input, output, total: input + output };
}

// Combine two partial reports (start + delta, or a retry). Input only grows, so
// the largest seen value is the request size; output is cumulative too.
function mergeUsage(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  const input = Math.max(a.input || 0, b.input || 0);
  const output = Math.max(a.output || 0, b.output || 0);
  return { input, output, total: input + output };
}

function estimateContextTokens(messages) {
  return (messages || []).reduce((sum, m) => {
    const text = typeof m?.content === 'string'
      ? m.content
      : (m?.content?.find?.(c => c.type === 'text')?.text || '');
    return sum + Math.ceil((text || '').length / 4);
  }, 0);
}

// The latest reply's reported input+output is the actual context the model just
// saw. Older exact counts are stale (messages were added, summarized or edited
// since), so never sum them; fall back to the character estimate only when no
// turn has reported usage yet.
function contextTokensFromMessages(messages) {
  const list = messages || [];
  for (let i = list.length - 1; i >= 0; i--) {
    const u = list[i] && list[i].usage;
    const total = u ? Number(u.input || 0) + Number(u.output || 0) : 0;
    if (total > 0) return { tokens: total, exact: true };
  }
  return { tokens: estimateContextTokens(list), exact: false };
}

// Window resolution order: explicit Settings value, the live catalogue cached
// by LOAD LIVE MODEL LIST, a known model family, then the historical default.
function resolveContextLength({ override, model, catalog, fallback = DEFAULT_CONTEXT_LENGTH } = {}) {
  const n = Number(override);
  if (Number.isFinite(n) && n > 0) return Math.round(n);
  const key = String(model || '');
  const fromCatalog = catalog && key ? Number(catalog[key]) : 0;
  if (Number.isFinite(fromCatalog) && fromCatalog > 0) return Math.round(fromCatalog);
  for (const [re, len] of KNOWN_CONTEXT_LENGTHS) if (re.test(key)) return len;
  return fallback;
}

function contextMeter(messages, contextLength) {
  const info = contextTokensFromMessages(messages);
  const window = Number(contextLength) > 0 ? Number(contextLength) : DEFAULT_CONTEXT_LENGTH;
  return { tokens: info.tokens, exact: info.exact, pct: Math.min(100, (info.tokens / window) * 100) };
}
/* USAGE-END */

// A8: the window for the active provider/model, from Settings or the cached
// OpenRouter catalogue (written by LOAD LIVE MODEL LIST in Settings).
function modelContextLength(settings) {
  const s = settings || S.settings();
  const prof = providerProfile(s);
  let catalog = {};
  try { catalog = JSON.parse(localStorage.getItem('hmm_model_contexts') || '{}') || {}; } catch { catalog = {}; }
  return resolveContextLength({ override: prof.contextLength, model: prof.model, catalog });
}
const formatTime = ts => ts ? new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
const formatDate = ts => {
  if (!ts) return '';
  const d = new Date(ts), now = new Date(), diff = now - d;
  if (diff < 86400000) return formatTime(ts);
  if (diff < 604800000) return d.toLocaleDateString([], { weekday: 'short' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
};

// Inline formatting + embeds/links — applied within each block below, never
// inside fenced code. Single-asterisk stays styled as roleplay action text
// (*looks around*), not italic — that's a deliberate app convention, not a
// markdown gap.
function __mdInline(s) {
  let html = s
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/~~([^~\n]+)~~/g, '<del>$1</del>')
    .replace(/\*([^*\n<>]+)\*/g, '<em class="rp-action">$1</em>')
    .replace(/__([^_\n<>]+)__/g, '<u>$1</u>')
    .replace(/_([^_\n<>]+)_/g, '<em>$1</em>');

  // Markdown image: ![alt](url)
  html = html.replace(/!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/g,
    (_, alt, url) => `<img class="embed-img" src="${url}" alt="${alt||''}" loading="lazy" onclick="window.__hmmLightbox&&window.__hmmLightbox('${url}')" onerror="this.style.display='none'">`);
  // Markdown link: [text](url)
  html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    (_, t, url) => `<a href="${url}" target="_blank" rel="noopener">${t}</a>`);

  // Bare URLs (not already inside an attribute) → embed by type
  html = html.replace(/(^|[\s>])(https?:\/\/[^\s<]+)/g, (m, pre, url) => {
    if (/__hmm|src=|href=/.test(m)) return m;
    const clean = url.replace(/[.,!?;:)]+$/, '');
    const trail = url.slice(clean.length);
    // Image
    if (/\.(png|jpe?g|gif|webp|avif|bmp)(\?.*)?$/i.test(clean)) {
      return `${pre}<img class="embed-img" src="${clean}" loading="lazy" onclick="window.__hmmLightbox&&window.__hmmLightbox('${clean}')" onerror="this.replaceWith(Object.assign(document.createElement('a'),{href:'${clean}',target:'_blank',rel:'noopener',textContent:'${clean}'}))">${trail}`;
    }
    // YouTube
    const yt = clean.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([\w-]{11})/);
    if (yt) {
      return `${pre}<span class="embed-yt"><iframe src="https://www.youtube.com/embed/${yt[1]}" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen></iframe></span>${trail}`;
    }
    // Audio
    if (/\.(mp3|ogg|wav|m4a)(\?.*)?$/i.test(clean)) {
      return `${pre}<audio controls src="${clean}" class="embed-audio"></audio>${trail}`;
    }
    // Video
    if (/\.(mp4|webm|mov)(\?.*)?$/i.test(clean)) {
      return `${pre}<video controls src="${clean}" class="embed-video"></video>${trail}`;
    }
    return `${pre}<a href="${clean}" target="_blank" rel="noopener">${clean}</a>${trail}`;
  });

  return html;
}

// Block-level markdown: headers, fenced code, blockquotes, ordered/unordered
// lists, horizontal rules, paragraphs. Walks line-by-line so multi-line
// constructs (lists, quotes, code fences) group correctly instead of the
// old approach of regexing the whole string as one blob, which couldn't
// tell "consecutive list lines" from unrelated text.
const __escHtml = s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

// Alignment fence:  ":::center" … ":::"  — wraps its contents in an aligned
// block, overriding the global --msg-align. Written by the composer's align
// buttons; also usable by hand.
const __MD_ALIGN_OPEN  = /^:::[ \t]*(left|center|right|justify)[ \t]*$/i;
const __MD_ALIGN_CLOSE = /^:::[ \t]*$/;

function renderMarkdown(text) {
  if (!text) return '';
  // Block detection runs on the raw (unescaped) text — blockquote markers
  // are literal ">" characters, which HTML-escaping would otherwise turn
  // into "&gt;" before this ever got a chance to see them. Each block
  // escapes its own content right before formatting it.
  return __mdBlocks(text.split('\n'));
}

// Split out from renderMarkdown so an alignment fence can recurse and keep
// every other block type working inside it.
function __mdBlocks(lines) {
  const blocks = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    // Blank lines. One blank line is the ordinary paragraph separator and the
    // gap between blocks already expresses it. Every *extra* one was typed
    // deliberately to space things out (greetings especially), so keep it —
    // collapsing them is what made whole messages read as one block.
    if (!trimmed) {
      let blanks = 0;
      while (i < lines.length && !lines[i].trim()) { blanks++; i++; }
      // Nothing follows → trailing whitespace, don't pad the end of the message
      if (i < lines.length) for (let k = 1; k < blanks; k++) blocks.push('<span class="md-gap"></span>');
      continue;
    }

    // Alignment fence
    const al = trimmed.match(__MD_ALIGN_OPEN);
    if (al) {
      const inner = [];
      i++;
      let depth = 1;
      while (i < lines.length) {
        const t = lines[i].trim();
        if (__MD_ALIGN_OPEN.test(t)) depth++;
        else if (__MD_ALIGN_CLOSE.test(t)) { depth--; if (!depth) { i++; break; } }
        inner.push(lines[i]);
        i++;
      }
      blocks.push(`<div class="md-align" style="text-align:${al[1].toLowerCase()}">${__mdBlocks(inner)}</div>`);
      continue;
    }

    // Fenced code block
    if (/^```/.test(trimmed)) {
      const code = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i].trim())) { code.push(__escHtml(lines[i])); i++; }
      i++; // consume closing fence
      blocks.push(`<pre><code>${code.join('\n')}</code></pre>`);
      continue;
    }

    // Horizontal rule
    if (/^(?:-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      blocks.push('<hr class="md-hr">');
      i++;
      continue;
    }

    // Header
    const h = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (h) {
      blocks.push(`<h${h[1].length} class="md-h">${__mdInline(__escHtml(h[2].trim()))}</h${h[1].length}>`);
      i++;
      continue;
    }

    // Blockquote — consecutive lines starting with >
    if (/^>\s?/.test(line)) {
      const q = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) { q.push(__mdInline(__escHtml(lines[i].replace(/^>\s?/, '')))); i++; }
      blocks.push(`<blockquote class="md-quote">${q.join('<br>')}</blockquote>`);
      continue;
    }

    // Unordered list — consecutive lines starting with -, *, or +
    if (/^[-*+]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^[-*+]\s+/.test(lines[i])) { items.push(__mdInline(__escHtml(lines[i].replace(/^[-*+]\s+/, '')))); i++; }
      blocks.push(`<ul class="md-list">${items.map(it => `<li>${it}</li>`).join('')}</ul>`);
      continue;
    }

    // Ordered list — consecutive lines starting with "1. "
    if (/^\d+\.\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i])) { items.push(__mdInline(__escHtml(lines[i].replace(/^\d+\.\s+/, '')))); i++; }
      blocks.push(`<ol class="md-list">${items.map(it => `<li>${it}</li>`).join('')}</ol>`);
      continue;
    }

    // Paragraph — consecutive plain lines up to the next blank line or block start
    const para = [];
    while (
      i < lines.length && lines[i].trim() &&
      !/^```/.test(lines[i].trim()) && !/^(?:-{3,}|\*{3,}|_{3,})$/.test(lines[i].trim()) &&
      !/^#{1,6}\s+/.test(lines[i].trim()) && !/^>\s?/.test(lines[i]) &&
      !/^[-*+]\s+/.test(lines[i]) && !/^\d+\.\s+/.test(lines[i]) &&
      !__MD_ALIGN_OPEN.test(lines[i].trim()) && !__MD_ALIGN_CLOSE.test(lines[i].trim())
    ) { para.push(lines[i]); i++; }
    blocks.push(`<p class="md-p">${__mdInline(__escHtml(para.join('\n'))).replace(/\n/g, '<br>')}</p>`);
  }

  // Joined bare: every block carries its own spacing now. The old '<br>' glue
  // gave paragraphs a single line break, so a blank line between them did
  // nothing visible no matter how many you typed.
  return blocks.join('');
}

// ── Textbox parsing ──────────────────────────────────────────────
// Everything between the TEXTBOX-EXPORTS markers is pure and gets sliced out
// by test/harness.js to run under Node. Keep it free of React and DOM access.
/* TEXTBOX-EXPORTS-START */
// Inline "\E[Name]" portrait tags. Names are bracketed because real sprite
// names contain spaces and parentheses ("Grin (No Eyes)"), and readable names
// prompt the model far better than opaque codes.
// Offsets are recorded against the STRIPPED text so they stay valid as the
// typewriter reveals characters.
function stripExpressionTags(raw) {
  const text = String(raw ?? '');
  const tags = [];
  let out = '';
  let i = 0;

  while (i < text.length) {
    const hit = text.indexOf('\\E[', i);
    if (hit === -1) { out += text.slice(i); break; }
    const close = text.indexOf(']', hit);
    // Unclosed tag: not a tag at all, keep it literal
    if (close === -1) { out += text.slice(i); break; }

    out += text.slice(i, hit);
    const name = text.slice(hit + 3, close).trim();
    if (name) tags.push({ at: out.length, name });
    i = close + 1;
  }

  return { text: out, tags };
}

// ":::choices ... :::" - a fence rather than "* option" lines because "*"
// already means a markdown bullet, rp-action italics, AND is UT's own prefix
// for ordinary dialogue lines. A fourth meaning could fire by accident.
const MAX_CHOICES = 8;

// Strip inline markdown marks. Nested/adjacent marks (e.g. "**bold *inner* **")
// need more than one pass — a single sweep of one-shot replaces leaves stray
// characters behind. Reapply the same five patterns until a pass changes
// nothing, capped so malformed input can't spin forever.
function __stripChoiceMarks(s) {
  let prev = s;
  for (let n = 0; n < 5; n++) {
    const next = prev
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/\*([^*]+)\*/g, '$1')
      .replace(/__([^_]+)__/g, '$1')
      .replace(/~~([^~]+)~~/g, '$1')
      .replace(/`([^`]+)`/g, '$1');
    if (next === prev) break;
    prev = next;
  }
  return prev;
}

function parseChoiceFence(raw, { streaming = false } = {}) {
  const text = String(raw ?? '');
  const lines = text.split('\n');

  // Only the LAST fence is live, earlier ones stay literal. Find the last
  // open, then the first close after it — this way a genuinely-unclosed
  // last fence can never fall back onto an earlier well-formed one.
  let openIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^:::choices$/i.test(lines[i].trim())) { openIdx = i; break; }
  }
  if (openIdx === -1) return { text, choices: [] };

  let closeIdx = -1;
  for (let i = openIdx + 1; i < lines.length; i++) {
    if (lines[i].trim() === ':::') { closeIdx = i; break; }
  }
  if (closeIdx === -1) {
    // Mid-stream, an unterminated trailing fence is a message still arriving,
    // not malformed prose — drop it from the prose entirely (no choices yet)
    // instead of typing the raw ":::choices" fence out on screen. Once the
    // closing "::: " lands this falls through to the normal branch below,
    // and the prose it yields is identical, so `full` only ever grows.
    if (streaming) {
      const prose = lines.slice(0, openIdx).join('\n').replace(/\s+$/, '');
      return { text: prose, choices: [] };
    }
    return { text, choices: [] };
  }

  const choices = lines.slice(openIdx + 1, closeIdx)
    .map(l => l.trim())
    .filter(Boolean)
    .map(l => __stripChoiceMarks(l).trim())
    .slice(0, MAX_CHOICES);

  const prose = lines.slice(0, openIdx).concat(lines.slice(closeIdx + 1))
    .join('\n').replace(/\s+$/, '');
  return { text: prose, choices };
}

// Trim trailing whitespace off a wrapped line's text, dropping the same
// number of trailing entries from its parallel source-offset map so the two
// stay the same length.
function __trimTrailingWs(text, map) {
  const m = text.match(/\s+$/);
  const n = m ? m[0].length : 0;
  return n ? { text: text.slice(0, -n), map: map.slice(0, map.length - n) } : { text, map };
}

// The box font is monospace, so characters-per-line is deterministic and
// wrapping is pure arithmetic - no DOM measurement, identical on every device.
// `start` is the offset of each page's first character in the source text, so
// expression-tag offsets can be mapped onto the page being typed.
// `map[i]` is the source-text offset of `text[i]` for that page. It's needed
// alongside `start` because a page's rendered text is NOT a verbatim slice of
// the source: whitespace runs collapse to a single space, and wrapped lines
// join with a synthetic '\n' that has no source character of its own (it's
// given the offset of the last real character before it, so a tag doesn't
// fire until the character it precedes has actually been typed). Built here,
// character by character, while the true source cursor is known — trying to
// reconstruct it afterwards by matching strings would be unreliable.
function wrapPages(raw, cols, rows) {
  const text = String(raw ?? '');
  const width = Math.max(1, cols | 0);
  const height = Math.max(1, rows | 0);

  const lines = [];               // { text, start, map } | null
  let cursor = 0;

  for (const rawLine of text.split('\n')) {
    const lineStart = cursor;
    cursor += rawLine.length + 1; // +1 for the consumed '\n'

    if (!rawLine.trim()) { lines.push(null); continue; } // blank = page break

    let at = 0;
    let buf = '';
    let bufMap = [];               // source offset for each char already in buf
    let bufStart = lineStart;
    const words = rawLine.split(/(\s+)/); // keep separators to track offsets

    for (const piece of words) {
      if (/^\s+$/.test(piece)) {
        // A run of whitespace collapses to one space — record the offset of
        // its FIRST source character, since that's where the collapse begins.
        if (buf) { buf += ' '; bufMap.push(lineStart + at); }
        at += piece.length;
        continue;
      }
      const wordStart = lineStart + at;
      let word = piece;

      if (word.length > width) {
        // Word can never fit on a single line - flush whatever's already
        // buffered so the hard break always starts at a clean line, then
        // chop it into width-sized chunks, each chunk's start following
        // directly from the previous one (not from the original word start).
        if (buf) {
          const t = __trimTrailingWs(buf, bufMap);
          lines.push({ text: t.text, start: bufStart, map: t.map });
          buf = ''; bufMap = [];
        }
        let chunkStart = wordStart;
        while (word.length > width) {          // hard-break over-long words
          const chunkMap = [];
          for (let k = 0; k < width; k++) chunkMap.push(chunkStart + k);
          lines.push({ text: word.slice(0, width), start: chunkStart, map: chunkMap });
          word = word.slice(width);
          chunkStart += width;
        }
        bufStart = chunkStart;
        buf = word;
        bufMap = [];
        for (let k = 0; k < word.length; k++) bufMap.push(chunkStart + k);
      } else {
        if (buf.length + word.length > width) {
          const t = __trimTrailingWs(buf, bufMap);
          lines.push({ text: t.text, start: bufStart, map: t.map });
          buf = ''; bufMap = [];
        }
        if (!buf) bufStart = wordStart;
        for (let k = 0; k < word.length; k++) bufMap.push(wordStart + k);
        buf += word;
      }
      at += piece.length;
    }
    const t = __trimTrailingWs(buf, bufMap);
    lines.push({ text: t.text, start: bufStart, map: t.map });
  }

  const pages = [];
  let group = [];
  const flush = () => {
    if (!group.length) return;
    let pageText = '';
    let pageMap = [];
    let lastOffset = group[0].start;
    group.forEach((l, idx) => {
      if (idx > 0) {
        pageText += '\n';
        // Synthetic join newline: no source character of its own, so reuse
        // the offset of the last real character already typed.
        pageMap.push(lastOffset);
      }
      pageText += l.text;
      pageMap = pageMap.concat(l.map);
      if (l.map.length) lastOffset = l.map[l.map.length - 1];
    });
    pages.push({ text: pageText, start: group[0].start, map: pageMap });
    group = [];
  };
  // Pages fill to `height` lines rather than breaking at every blank line, so
  // a one-line beat and a two-line beat share a box instead of burning two.
  //
  // But a beat is kept whole: if it will not fit in what is left of the
  // current page it starts the next one, the way widow control works in
  // print. Filling without this splits sentences across boxes, which is
  // exactly what makes a dialogue box feel broken. A beat longer than a whole
  // page still has to span pages - nothing can be done about that.
  const beats = [];
  let beat = [];
  for (const line of lines) {
    if (line === null) { if (beat.length) { beats.push(beat); beat = []; } continue; }
    beat.push(line);
  }
  if (beat.length) beats.push(beat);

  for (const b of beats) {
    if (group.length && group.length + b.length > height) flush();
    for (const line of b) {
      group.push(line);
      if (group.length === height) flush();
    }
  }
  flush();

  return pages.length ? pages : [{ text: '', start: 0, map: [] }];
}

function parseTextbox(raw, { cols = 46, rows = 3, streaming = false } = {}) {
  const fenced = parseChoiceFence(raw, { streaming });
  const stripped = stripExpressionTags(fenced.text);
  return {
    pages: wrapPages(stripped.text, cols, rows),
    choices: fenced.choices,
    tags: stripped.tags,
  };
}

// Latest tag at or before `offset`. Linear scan: tag counts are tiny.
function expressionAt(tags, offset) {
  let name = null;
  for (const t of tags || []) {
    if (t.at <= offset) name = t.name; else break;
  }
  return name;
}

function resolveExpressionKey(expressions, name) {
  if (!expressions || !name) return null;
  const keys = Object.keys(expressions);
  const needle = String(name).trim().toLowerCase();
  return keys.find(k => k.toLowerCase() === needle) || null;
}

// "Anxious Side Eye [323643].png" -> "Anxious Side Eye"
function expressionNameFromFilename(filename) {
  return String(filename || '')
    .replace(/\.[a-z0-9]+$/i, '')
    .replace(/\s*\[\d+\]\s*$/, '')
    .trim();
}

// Distinct voice per character with zero authoring. Deliberately NOT built on
// top of nameHash: nameHash folds down to a 0-359 hue for colour, and two
// short names easily land on the same hue ('Vera' and 'Mox' both hash to 158)
// which would give them the identical pitch too. Hashing straight to the
// 600-wide pitch range keeps far more entropy and avoids that collision.
function pitchForCharacter(char) {
  if (typeof char?.blipPitch === 'number') return char.blipPitch;
  const name = char?.name || '';
  let h = 0;
  for (let i = 0; i < name.length; i++) h = name.charCodeAt(i) + ((h << 5) - h);
  return 200 + (Math.abs(h) % 600);
}

// C23: how long a finished page sits before the box turns itself. Long enough
// to read the last line, short enough that a four-page reply does not feel
// stuck; once typing is done the reader can always click to go faster.
const TEXTBOX_AUTO_ADVANCE_MS = 2000;
function textboxAutoAdvanceMs() { return TEXTBOX_AUTO_ADVANCE_MS; }

// Whether the newest textbox should turn its own page. Historical boxes are
// already fully revealed and must stay still, a streaming reply is still
// growing, the last page has nowhere to go, and `paused` is set the moment the
// reader pages by hand so they keep control of that box.
function shouldAutoAdvancePage({ enabled, instant, isLatest, streaming, done, page, pageCount, paused } = {}) {
  if (!enabled || instant || !isLatest || streaming || !done || paused) return false;
  if (!Number.isInteger(page) || !Number.isInteger(pageCount)) return false;
  return page >= 0 && page < pageCount - 1;
}

// C22: per-character blip volume and on/off. `textboxSound` in Settings stays
// the global switch; a character may override it (a whisper, a shout, a silent
// one in a group scene) and scale the blip's gain. A missing override means
// "follow the global setting at full volume", so every existing character
// sounds exactly as it did before this existed.
const DEFAULT_BLIP_VOLUME = 1;
function clampBlipVolume(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return DEFAULT_BLIP_VOLUME;
  return Math.min(1, Math.max(0, v));
}
function blipForCharacter(char, settings) {
  const override = char?.blipSound;
  const followsGlobal = override !== true && override !== false;
  const on = followsGlobal ? !!settings?.textboxSound : override;
  const volume = clampBlipVolume(char?.blipVolume);
  return { on: on && volume > 0, pitch: pitchForCharacter(char), volume };
}
/* TEXTBOX-EXPORTS-END */

function nameHash(name) {
  let h = 0;
  for (let i = 0; i < (name || '').length; i++) h = name.charCodeAt(i) + ((h << 5) - h);
  return (h % 360 + 360) % 360;
}
const charBg = name => `oklch(0.22 0.07 ${nameHash(name)}deg)`;
const charFg = name => `oklch(0.72 0.14 ${nameHash(name)}deg)`;

// ── Lorebook injection ────────────────────────────────────────────
// ── Scripts engine ─────────────────────────────────────────
// Keyword-triggered injection with probability (re-rolled every message),
// min-messages, scan depth (1 = only your last message), inclusion groups
// with weighted lottery + key-match priority, and order-based priority.
function getMatchedLoreEntries(messages, char) {
  const scripts = S.scripts().filter(s =>
    s.enabled !== false && (s.global !== false || (char?.id && (s.charIds || []).includes(char.id)))
  );
  if (!scripts.length) return [];

  const msgText = m => (typeof m.content === 'string' ? m.content : m.content?.find?.(c => c.type === 'text')?.text || '');
  const lastUserText = (() => {
    for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === 'user') return msgText(messages[i]).toLowerCase();
    return '';
  })();
  const windowText = d => messages.slice(-Math.max(1, d)).map(msgText).join(' ').toLowerCase();

  // 1. Match phase
  const matched = [];
  scripts.forEach(s => (s.entries || []).forEach(e => {
    if (e.enabled === false) return;
    if ((e.minMessages || 0) > messages.length) return;
    const depth = e.depth ?? 8;
    const scan = depth === 1 ? lastUserText : windowText(depth);
    const keys = (e.keywords || []).filter(k => k.trim());
    if (!keys.length) return;
    const hits = keys.filter(k => scan.includes(k.trim().toLowerCase())).length;
    if (!hits) return;
    if ((e.probability ?? 100) < 100 && Math.random() * 100 >= (e.probability ?? 100)) return; // re-rolled every message, never sticky
    matched.push({ ...e, _hits: hits });
  }));
  if (!matched.length) return [];

  // 2. Inclusion groups — one winner per group (key-match priority, then weighted lottery)
  const winners = [];
  const groups = {};
  matched.forEach(e => {
    const gs = (e.group || '').split(',').map(x => x.trim()).filter(Boolean);
    if (!gs.length) { winners.push(e); return; }
    gs.forEach(g => (groups[g] = groups[g] || []).push(e));
  });
  const suppressed = new Set(), chosen = new Set();
  Object.values(groups).forEach(list => {
    const alive = list.filter(e => !suppressed.has(e.id) && !chosen.has(e.id));
    if (!alive.length) return;
    const maxHits = Math.max(...alive.map(e => e._hits));
    const best = alive.filter(e => e._hits === maxHits);
    const total = best.reduce((sum, e) => sum + (e.groupWeight ?? 100), 0);
    let r = Math.random() * total, win = best[0];
    for (const e of best) { r -= (e.groupWeight ?? 100); if (r <= 0) { win = e; break; } }
    chosen.add(win.id);
    list.forEach(e => { if (e.id !== win.id) suppressed.add(e.id); });
  });
  matched.forEach(e => { if (chosen.has(e.id) && !suppressed.has(e.id)) winners.push(e); });

  // 3. Priority order (lower = first)
  return winners.sort((a, b) => (a.order ?? 5) - (b.order ?? 5));
}

function __legacyGetMatched(messages) {
  const entries = S.lorebook().filter(e => e.enabled !== false);
  if (!entries.length) return [];
  // Scan last 8 messages for keyword matches
  const recentText = messages.slice(-8).map(m =>
    typeof m.content === 'string' ? m.content : m.content?.find?.(c => c.type==='text')?.text || ''
  ).join(' ').toLowerCase();
  return entries.filter(e =>
    (e.keywords || []).some(kw => kw.trim() && recentText.includes(kw.trim().toLowerCase()))
  );
}

// ── Advanced scripts — user JS run against a mutable context each message ──
function runAdvancedScripts(char, settings, messages) {
  const scripts = S.scripts().filter(s =>
    s.enabled !== false && s.type === 'advanced' && (s.code || '').trim() &&
    (s.global !== false || (char?.id && (s.charIds || []).includes(char.id)))
  );
  if (!scripts.length) return char;

  const msgText = m => (typeof m?.content === 'string' ? m.content : m?.content?.find?.(c => c.type === 'text')?.text || '');
  const lastUser = [...messages].reverse().find(m => m.role === 'user');
  // Mutable copy — scripts edit scenario/personality/etc without touching the saved character
  const c = {
    name: char.name || '', description: char.description || '', personality: char.personality || '',
    scenario: char.scenario || '', systemPrompt: char.systemPrompt || '',
  };
  const notes = [];
  const context = {
    chat: {
      message_count: messages.length,
      last_message: msgText(messages[messages.length - 1]),
      last_user_message: msgText(lastUser),
      messages: messages.map(m => ({ role: m.role, text: msgText(m) })),
    },
    character: c,
    user: { name: settings?.activePersona?.name || 'You', description: settings?.activePersona?.description || '' },
    inject: t => { if (t) notes.push(String(t)); },
    chance: p => Math.random() * 100 < p,
  };
  scripts.forEach(s => {
    try { new Function('context', s.code)(context); }
    catch (e) { console.warn(`Advanced script "${s.name}" error:`, e.message); }
  });
  return { ...char, description: c.description, personality: c.personality, scenario: c.scenario, systemPrompt: c.systemPrompt, _scriptNotes: notes };
}

// ── Macro substitution — {{user}}/{{bot}} (+ SillyTavern-style {{char}}) ──
function substituteMacros(text, char, settings) {
  if (!text) return text;
  const userName = settings?.activePersona?.name || 'You';
  const charName = char?.name || 'Character';
  return String(text)
    .replace(/\{\{user\}\}/gi, userName)
    .replace(/\{\{(char|bot)\}\}/gi, charName);
}

// ── System prompt builder ─────────────────────────────────────────
function buildSystemPrompt(char, settings, messages = []) {
  char = runAdvancedScripts(char, settings, messages);
  const lore = getMatchedLoreEntries(messages, char);
  const pinnedMsgs = (messages || []).filter(m => m.pinned);
  const m = t => substituteMacros(t, char, settings);

  let textboxInstructions = null;
  if (char?.textboxStyle && char.textboxStyle !== 'none') {
    const names = Object.keys(char.expressions || {});
    textboxInstructions =
      'FORMAT: your replies are shown in an Undertale-style dialogue box.\n' +
      'To offer the user choices, end your message with:\n' +
      ':::choices\nFirst option\nSecond option\n:::\n' +
      'Use 2-4 options, only when a choice makes sense. Never explain the format.' +
      (names.length
        ? `\nTo change your portrait mid-line, write \\E[Name] using exactly one of: ${names.join(', ')}`
        : '');
  }

  return [
    m(settings?.globalPrompt?.trim()) || null,
    `You are ${char.name}, engaging in an unrestricted creative roleplay session.`,
    char.description  && `Description: ${m(char.description)}`,
    char.personality  && `Personality: ${m(char.personality)}`,
    char.scenario     && `Scenario: ${m(char.scenario)}`,
    char.exampleDialogues && `Example dialogues:\n${m(char.exampleDialogues)}`,
    m(char.systemPrompt),
    settings?.activePersona?.name && settings.activePersona.name !== 'You'
      ? `The user's character is: ${settings.activePersona.name}${settings.activePersona.description ? ' — ' + m(settings.activePersona.description) : ''}.`
      : null,
    settings?.replyLengthHint || null,
    lore.length > 0 && `[WORLD INFO — inject naturally into responses when relevant]\n${lore.map(e => `### ${e.name}\n${m(e.content)}`).join('\n\n')}`,
    char._scriptNotes?.length > 0 && `[SCRIPT NOTES — weave into the response naturally]\n${char._scriptNotes.join('\n')}`,
    pinnedMsgs.length > 0 && `[PINNED CONTEXT — always keep in mind]\n${pinnedMsgs.map(m2 => {
      const t = typeof m2.content === 'string' ? m2.content : m2.content?.find?.(c=>c.type==='text')?.text||'';
      return `${m2.role === 'user' ? (settings?.activePersona?.name||'You') : char.name}: ${t}`;
    }).join('\n')}`,
    `Stay in character as ${char.name}. Use *asterisks* for actions/narration. Be engaging, vivid, and responsive.`,
    `When you see a message starting with [NARRATOR:], treat it as an omniscient narrator setting the scene — respond accordingly.`,
    settings?.assistStyleGuidelines?.trim() && `[STYLE GUIDELINES — apply to every response]\n${m(settings.assistStyleGuidelines.trim())}`,
    textboxInstructions,
  ].filter(Boolean).join('\n\n');
}

// ── AI ───────────────────────────────────────────────────────────
async function callAI(messages, char, settings, onChunk, opts = {}) {
  const resolvedSettings = settings || S.settings();
  // opts.system: caller-supplied clean system prompt — skips the roleplay
  // scaffolding (persona, lorebook, global prompt, "stay in character / use
  // *asterisks*") that otherwise pollutes utility calls (assists, summarizer).
  // opts.structured additionally requests JSON output (response_format + token floor).
  const structured = !!opts.structured;
  const system = opts.system != null ? opts.system : buildSystemPrompt(char, resolvedSettings, messages);

  // Web search runs for normal chat turns by default; utility calls that bring
  // their own system prompt (assists, summaries) opt in with opts.search.
  const searchOn = WebSearch.enabled(resolvedSettings) && (opts.search ?? opts.system == null);
  const searchRoleplay = opts.roleplay ?? opts.system == null;
  const sState = { queries: [], sources: [], error: null };
  const emitSearch = (active, doing = '') =>
    opts.onSearch?.({ active, doing, error: sState.error, queries: [...sState.queries], sources: [...sState.sources] });

  // Build clean API messages — preserve images (vision), handle narrator
  const apiMsgs = messages
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .map(m => {
      if (Array.isArray(m.content)) {
        let text = m.content.find(c => c.type === 'text')?.text || '';
        if (m.narrator) text = `[NARRATOR: ${text}]`;
        const img = m.content.find(c => c.type === 'image');
        if (img?.source) {
          const dataUrl = `data:${img.source.media_type};base64,${img.source.data}`;
          return { role: m.role, _multimodal: [
            { type: 'text', text: text || ' ' },
            { type: 'image_url', image_url: { url: dataUrl } },
          ], content: text };
        }
        return { role: m.role, content: text };
      }
      let content = typeof m.content === 'string' ? m.content : '';
      if (m.narrator) content = `[NARRATOR: ${content}]`;
      return { role: m.role, content };
    })
    .filter(m => m.content || m._multimodal);

  if (!apiMsgs.length) return '';

  let result = '';
  let shown = ''; // visible text accumulated across tool rounds (kept on abort)
  // A8: last real usage report seen in this call. A tool loop overwrites it per
  // round, so the meter reflects the final request rather than the sum of
  // intermediate lookups.
  let usage = null;

  // Transient failures are common (429 rate limits, 502/503 cold starts) and a
  // failed turn used to mean retyping the prompt. Retry twice with a short
  // backoff before surfacing the error; an abort is never retried.
  const fetchRetry = async (url, init, timeoutMs = 90000) => {
    for (let attempt = 0; ; attempt++) {
      const ctl = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; ctl.abort(); }, timeoutMs);
      const onAbort = () => ctl.abort();
      init.signal?.addEventListener('abort', onAbort, { once: true });
      try {
        const resp = await fetch(url, { ...init, signal: ctl.signal });
        if (resp.ok || attempt >= 2 || !(resp.status === 429 || resp.status >= 500)) return resp;
      } catch (e) {
        // A stalled provider used to hang a turn forever; 90s without response
        // headers is long enough for any real model call.
        if (timedOut) throw new Error(`timed out after ${Math.round(timeoutMs / 1000)}s`);
        if (init.signal?.aborted) throw Object.assign(new Error('Aborted'), { name: 'AbortError' });
        if (attempt >= 2) throw e;
      } finally {
        clearTimeout(timer);
        init.signal?.removeEventListener('abort', onAbort);
      }
      await new Promise(resolve => setTimeout(resolve, 700 * 2 ** attempt));
    }
  };

  // ── External provider (OpenRouter / Local / Custom OpenAI-compatible) ──
  // Per-provider profiles: the active provider supplies endpoint/key/model, so
  // switching providers restores that provider's saved configuration.
  const prof = providerProfile(resolvedSettings);
  const endpoint = prof.provider !== 'claude' ? prof.endpoint : '';
  if (endpoint) {
    try {
      const base = normalizeBaseUrl(endpoint);
      const url = base + '/v1/chat/completions';
      let model = prof.model;
      const apiKey = prof.key;
      // Expand multimodal messages into OpenAI vision format
      const outMsgs = apiMsgs.map(m => m._multimodal ? { role: m.role, content: m._multimodal } : { role: m.role, content: m.content });
      const body = {
        model,
        messages: [{ role: 'system', content: system }, ...outMsgs],
        temperature: resolvedSettings.temperature || 0.8,
        // Structured JSON (all fields at once) needs more room than a chat turn —
        // truncated JSON was the main cause of assist parse failures
        max_tokens: structured ? Math.max(4096, resolvedSettings.maxTokens || 1024) : (resolvedSettings.maxTokens || 1024),
        top_p: resolvedSettings.topP,
        stream: !!onChunk,
        ...generationExtras(resolvedSettings),
      };
      // Ask OpenAI-compatible servers to end the stream with real token counts.
      // Endpoints that reject the field are retried without it below.
      if (onChunk) body.stream_options = { include_usage: true };
      if (structured) body.response_format = { type: 'json_object' };
      const headers = { 'Content-Type': 'application/json' };
      if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
      if (resolvedSettings.provider === 'openrouter') {
        headers['HTTP-Referer'] = window.location.origin || 'https://inkling.local';
        headers['X-Title'] = 'Inkling Roleplay';
      }

      // ── Web search ──
      // OpenRouter "native" mode uses its web plugin; every other mode gives the
      // model web_search/read_page tools and runs the loop client-side.
      const nativeSearch = searchOn && resolvedSettings.provider === 'openrouter' && resolvedSettings.searchBackend === 'native';
      let toolsOn = searchOn && !nativeSearch;
      const convo = [{ role: 'system', content: toolsOn ? `${system}\n\n${WebSearch.note(searchRoleplay)}` : system }, ...outMsgs];
      body.messages = convo;
      if (nativeSearch) body.plugins = [{ id: 'web', max_results: WebSearch.maxResults(resolvedSettings) }];
      if (toolsOn) body.tools = WebSearch.tools;
      const rounds = toolsOn ? WebSearch.maxUses(resolvedSettings) + 1 : 1;

      const send = async () => {
        let resp = await fetchRetry(url, { method: 'POST', headers, body: JSON.stringify(body), signal: opts.signal });
        // Some models/endpoints reject response_format — retry once without it
        if (!resp.ok && body.response_format && resp.status >= 400 && resp.status < 500) {
          delete body.response_format;
          resp = await fetchRetry(url, { method: 'POST', headers, body: JSON.stringify(body), signal: opts.signal });
        }
        // Same for stream_options: not every OpenAI-compatible server knows it.
        if (!resp.ok && body.stream_options && resp.status >= 400 && resp.status < 500) {
          delete body.stream_options;
          resp = await fetchRetry(url, { method: 'POST', headers, body: JSON.stringify(body), signal: opts.signal });
        }
        // Endpoint/model doesn't do tool calls — search once up front instead
        if (!resp.ok && body.tools && resp.status >= 400 && resp.status < 500) {
          delete body.tools; toolsOn = false;
          emitSearch(true, 'searching');
          const found = await WebSearch.preRetrieve(apiMsgs, resolvedSettings, opts.signal, sState);
          convo[0].content = system + (found ? `\n\n${found}\n${searchRoleplay ? 'Work these facts in naturally, in character, without citing them.' : 'Use these results and name the source sites.'}` : '');
          resp = await fetchRetry(url, { method: 'POST', headers, body: JSON.stringify(body), signal: opts.signal });
        }
        if (!resp.ok) {
          const errTxt = await resp.text().catch(() => '');
          throw new Error(`${resp.status} ${resp.statusText} ${errTxt.slice(0, 200)}`);
        }
        return resp;
      };
      const takeAnnotations = list => (list || []).forEach(a => a?.url_citation && WebSearch.addSource(sState, a.url_citation));

      for (let round = 0; round < rounds; round++) {
        if (toolsOn && round === rounds - 1) delete body.tools; // out of lookups — answer now
        body.stream = !!onChunk;
        const resp = await send();
        const prefix = shown ? shown + '\n\n' : '';
        let text = '';
        const calls = []; // { id, name, raw }

        if (onChunk) {
          const reader = resp.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              buffer += decoder.decode(value, { stream: true });
              const lines = buffer.split('\n');
              buffer = lines.pop() || '';
              for (const line of lines) {
                const trimmed = line.replace(/^data: ?/, '').trim();
                if (!trimmed || trimmed === '[DONE]') continue;
                try {
                  const chunk = JSON.parse(trimmed);
                  // Final frame (include_usage) has no choices, only usage.
                  const u = parseOpenAIUsage(chunk.usage);
                  if (u) usage = u;
                  const delta = chunk.choices?.[0]?.delta;
                  if (delta?.content) { text += delta.content; shown = prefix + text; onChunk(shown, false, usage); }
                  takeAnnotations(delta?.annotations);
                  for (const tc of delta?.tool_calls || []) {
                    const c = calls[tc.index ?? 0] || (calls[tc.index ?? 0] = { id: '', name: '', raw: '' });
                    if (tc.id) c.id = tc.id;
                    if (tc.function?.name) c.name += tc.function.name;
                    if (tc.function?.arguments) c.raw += tc.function.arguments;
                  }
                } catch {}
              }
            }
          } catch (err) {
            // User pressed stop mid-stream — keep what was generated so far
            if (err.name !== 'AbortError') throw err;
          }
        } else {
          const j = await resp.json();
          usage = parseOpenAIUsage(j.usage) || usage;
          const msg = j.choices?.[0]?.message;
          text = msg?.content || '';
          takeAnnotations(msg?.annotations);
          (msg?.tool_calls || []).forEach(tc => calls.push({ id: tc.id, name: tc.function?.name || '', raw: tc.function?.arguments || '' }));
          if (text) shown = prefix + text;
        }

        const live = calls.filter(c => c && c.name);
        if (opts.signal?.aborted || !body.tools || !live.length) break;

        // Run the model's tool calls, feed results back, go another round
        convo.push({
          role: 'assistant', content: text || null,
          tool_calls: live.map(c => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.raw || '{}' } })),
        });
        for (const c of live) {
          let args = {};
          try { args = JSON.parse(c.raw || '{}'); } catch {}
          emitSearch(true, c.name === 'read_page' ? `reading ${WebSearch.host(String(args.url || ''))}` : `searching: ${String(args.query || '').slice(0, 80)}`);
          const out = await WebSearch.runTool(c.name, args, resolvedSettings, opts.signal, sState);
          convo.push({ role: 'tool', tool_call_id: c.id, content: out });
        }
        emitSearch(true, 'thinking');
      }

      if (searchOn) emitSearch(false);
      if (onChunk) { onChunk(shown, true, usage); return shown; }
      result = shown;
    } catch(e) {
      if (e.name === 'AbortError') { if (searchOn) emitSearch(false); if (onChunk) onChunk(shown, true, usage); return shown; }
      if (searchOn) emitSearch(false);
      const providerName = resolvedSettings.provider === 'openrouter' ? 'OpenRouter' : resolvedSettings.provider === 'local' ? 'Local model' : 'Custom endpoint';
      result = `*${providerName} error: ${e.message}*\n\nCheck your endpoint URL, API key, and model ID in Settings.`;
    }
    if (onChunk && result) onChunk(result, true, usage);
    return result;
  }

  // ── Claude (Anthropic API via Netlify function) ───────────────
  // Real API call with model choice, temperature (where supported), max tokens,
  // and true SSE streaming. Falls through to the window.claude shim when the
  // function isn't deployed (404 / network error) or no API key is set.
  if (resolvedSettings.apiKey) {
    try {
      // Convert to Anthropic message format (image parts → base64 source blocks)
      const anthMsgs = apiMsgs.map(m => m._multimodal
        ? {
            role: m.role,
            content: m._multimodal.map(p => p.type === 'image_url'
              ? { type: 'image', source: { type: 'base64', media_type: p.image_url.url.slice(5, p.image_url.url.indexOf(';')), data: p.image_url.url.split(',')[1] } }
              : { type: 'text', text: p.text || ' ' }),
          }
        : { role: m.role, content: m.content });
      // Anthropic requires the first message to be a user turn; chats open with
      // the character's greeting (assistant), so prepend a neutral user turn
      if (anthMsgs[0]?.role === 'assistant') anthMsgs.unshift({ role: 'user', content: '[Begin roleplay]' });

      const resp = await fetchRetry('/api/anthropic', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: opts.signal,
        body: JSON.stringify({
          apiKey: resolvedSettings.apiKey,
          model: resolvedSettings.model || 'claude-haiku-4-5',
          // Cacheable block: system prompt + lorebook are re-sent every turn,
          // so marking the prefix cuts cost and latency on long roleplays.
          system: [{
            type: 'text',
            text: searchOn ? `${system}\n\n${WebSearch.note(searchRoleplay, true)}` : system,
            cache_control: { type: 'ephemeral' },
          }],
          messages: anthMsgs,
          topP: resolvedSettings.topP,
          topK: resolvedSettings.topK,
          stopSequences: generationExtras(resolvedSettings).stop,
          maxTokens: structured ? Math.max(4096, resolvedSettings.maxTokens || 1024) : (resolvedSettings.maxTokens || 1024),
          temperature: resolvedSettings.temperature,
          stream: !!onChunk,
          webSearch: searchOn ? { maxUses: WebSearch.maxUses(resolvedSettings) } : undefined,
        }),
      });

      if (resp.ok) {
        if (onChunk) {
          const reader = resp.body.getReader();
          const decoder = new TextDecoder();
          let partial = '';
          let buffer = '';
          const toolJson = {}; // block index -> accumulating server-tool input JSON
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              buffer += decoder.decode(value, { stream: true });
              const lines = buffer.split('\n');
              buffer = lines.pop() || '';
              for (const line of lines) {
                if (!line.startsWith('data:')) continue;
                try {
                  const j = JSON.parse(line.slice(5).trim());
                  if (j.type === 'message_start') usage = mergeUsage(usage, parseAnthropicUsage(j.message?.usage));
                  else if (j.type === 'message_delta') usage = mergeUsage(usage, parseAnthropicUsage(j.usage));
                  if (j.type === 'content_block_start') {
                    const cb = j.content_block || {};
                    if (cb.type === 'text' && partial) partial += '\n\n'; // text resuming after a search
                    if (cb.type === 'server_tool_use') { toolJson[j.index] = ''; emitSearch(true, 'searching'); }
                    if (cb.type === 'web_search_tool_result') {
                      (Array.isArray(cb.content) ? cb.content : []).forEach(r => WebSearch.addSource(sState, r));
                      emitSearch(true, 'thinking');
                    }
                  } else if (j.type === 'content_block_delta' && j.delta?.type === 'input_json_delta' && j.index in toolJson) {
                    toolJson[j.index] += j.delta.partial_json || '';
                  } else if (j.type === 'content_block_stop' && j.index in toolJson) {
                    try { const q = JSON.parse(toolJson[j.index] || '{}').query; if (q) { sState.queries.push(q); emitSearch(true, `searching: ${q.slice(0, 80)}`); } } catch {}
                    delete toolJson[j.index];
                  } else if (j.type === 'content_block_delta' && j.delta?.type === 'text_delta') {
                    partial += j.delta.text;
                    onChunk(partial, false, usage);
                  }
                } catch {}
              }
            }
          } catch (err) {
            // User pressed stop mid-stream — keep what was generated so far
            if (err.name !== 'AbortError') throw err;
          }
          if (searchOn) emitSearch(false);
          onChunk(partial, true, usage);
          return partial;
        }
        const j = await resp.json();
        (j.content || []).forEach(b => {
          if (b.type === 'server_tool_use' && b.input?.query) sState.queries.push(b.input.query);
          if (b.type === 'web_search_tool_result' && Array.isArray(b.content)) b.content.forEach(r => WebSearch.addSource(sState, r));
        });
        if (searchOn) emitSearch(false);
        usage = parseAnthropicUsage(j.usage) || usage;
        result = (j.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n\n');
        if (j.stop_reason === 'refusal' && !result) {
          result = '*The model declined this request (safety refusal). Try rephrasing, or switch provider in Settings.*';
        }
      } else if (resp.status !== 404) {
        const errTxt = await resp.text().catch(() => '');
        result = `*Anthropic error: ${resp.status} ${errTxt.slice(0, 200)}*\n\nCheck your API key and model in Settings.`;
      }
      // 404 → functions not deployed here; fall through to the shim below
    } catch (e) {
      if (e.name === 'AbortError') { if (searchOn) emitSearch(false); if (onChunk) onChunk('', true, usage); return ''; }
      console.error('Anthropic API error:', e);
    }
  }

  // ── Claude (window.claude helper — artifact/shim fallback) ────
  try {
    if (!result && window.claude) {
      const fullMsgs = [
        { role: 'user',      content: `[System]\n${system}` },
        { role: 'assistant', content: structured
          ? 'Understood. I will respond with only the requested JSON — no commentary, no markdown fences.'
          : (opts.system != null
            ? 'Understood. I will follow those instructions exactly.'
            : `Understood. I am ${char.name} and will stay in character.`) },
        ...apiMsgs.map(m => ({ role: m.role, content: m.content })),
      ];
      result = await window.claude.complete({ messages: fullMsgs });
    }
  } catch (e) { console.error('AI error:', e); }

  if (!result) {
    result = `*${char.name} looks at you quietly.*\n\nNo API response — add your Anthropic key in Settings to enable live AI.`;
  }

  if (onChunk) {
    const tokens = result.split(/(\s+)/);
    let partial = '';
    for (const tok of tokens) {
      if (opts.signal?.aborted) break;
      partial += tok;
      onChunk(partial, false);
      await new Promise(r => setTimeout(r, 9 + Math.random() * 12));
    }
    onChunk(partial, true);
    return partial;
  }
  return result;
}

// ── Provider probe (Settings → Test connection) ──────────────────
// Deliberately separate from callAI: callAI turns failures into italic chat
// text and can fall back to the window.claude shim, which would make a bad key
// look like a working one. This sends its own one-token request and reports
// the status verbatim.
/* MISC-EXPORTS-START */
const __esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// B18: one normalised view of a chat that the three export formats share.
function chatExportRows(messages, char, settings) {
  return (messages || []).map(m => {
    const parts = Array.isArray(m.content) ? m.content : [];
    const text = typeof m.content === 'string'
      ? m.content
      : parts.filter(p => p.type === 'text').map(p => p.text || '').join('\n');
    const author = m.narrator ? 'Narrator'
      : m.role === 'user' ? (settings?.activePersona?.name || 'You')
      : (m.charName || char?.name || 'Character');
    return {
      author, role: m.role, narrator: !!m.narrator,
      at: m.timestamp || null, text,
      images: parts.filter(p => p.type === 'image').length,
      pinned: !!m.pinned, edited: !!m.edited,
    };
  });
}

function chatToMarkdown(messages, char, settings, exportedAt = new Date().toISOString()) {
  const rows = chatExportRows(messages, char, settings);
  const body = rows.map(r => {
    const when = r.at ? ` · ${new Date(r.at).toLocaleString()}` : '';
    const img = r.images ? `\n\n_(${r.images} image${r.images === 1 ? '' : 's'} attached)_` : '';
    return `---\n\n**${r.author}**${when}\n\n${r.text}${img}`;
  }).join('\n\n');
  return `# ${char?.name || 'Chat'}\n\n_Exported ${new Date(exportedAt).toLocaleString()} · ${rows.length} message${rows.length === 1 ? '' : 's'}_\n\n${body}\n`;
}

function chatToJson(messages, char, settings, exportedAt = new Date().toISOString()) {
  return JSON.stringify({
    spec: 'inkling-chat-v1',
    exportedAt,
    character: { id: char?.id || '', name: char?.name || '' },
    messages: chatExportRows(messages, char, settings),
  }, null, 2);
}

function chatToHtml(messages, char, settings, exportedAt = new Date().toISOString()) {
  const rows = chatExportRows(messages, char, settings);
  const articles = rows.map(r => `  <article class="${r.role}">\n    <h2>${__esc(r.author)}<span>${r.at ? __esc(new Date(r.at).toLocaleString()) : ''}</span></h2>\n    <p>${__esc(r.text).replace(/\n/g, '<br>')}</p>${r.images ? `\n    <p class="img">(${r.images} image${r.images === 1 ? '' : 's'} attached)</p>` : ''}\n  </article>`).join('\n');
  return `<!doctype html>\n<html lang="en"><head><meta charset="utf-8">\n<title>${__esc(char?.name || 'Chat')}</title>\n<style>body{background:#111;color:#ddd;font:15px/1.6 system-ui,sans-serif;max-width:760px;margin:40px auto;padding:0 18px}h1{font-size:22px}article{border-top:1px solid #333;padding:14px 0}h2{font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:#8a8a8a;margin:0 0 6px}h2 span{float:right;font-weight:400;text-transform:none;letter-spacing:0}article.user h2{color:#e0a030}p{margin:0}.img{color:#777;font-style:italic}</style>\n</head><body>\n<h1>${__esc(char?.name || 'Chat')}</h1>\n<p>${rows.length} message${rows.length === 1 ? '' : 's'} · exported ${__esc(new Date(exportedAt).toLocaleString())}</p>\n${articles}\n</body></html>\n`;
}

// D26: entries past the retention window are purged on boot.
function trashExpired(entry, now = Date.now(), days = 30) {
  const at = Date.parse(entry?.deletedAt || '');
  if (!Number.isFinite(at)) return true;
  return now - at > days * 86400000;
}
/* MISC-EXPORTS-END */

/* PROVIDER-EXPORTS-START */
const PROBE_PING = 'ping';

function normalizeBaseUrl(endpoint) {
  return String(endpoint || '').trim().replace(/\/+$/, '').replace(/\/v1$/, '');
}

// The single source of truth for "where do requests for this provider go?".
// Reads the per-provider map, then falls back to the pre-profiles flat fields
// (and to defaults) so a half-migrated settings object still works.
// Optional sampling parameters, normalised once so every request path sends the
// same thing. Returns only the keys the user actually set: an explicit 0 for a
// penalty is meaningless and a blank seed means random.
function generationExtras(settings) {
  const s = settings || {};
  const out = {};
  const stops = String(s.stopSequences || '')
    .split('\n').map(x => x.trim()).filter(Boolean).slice(0, 4);
  if (stops.length) out.stop = stops;
  const num = v => (v === '' || v == null ? null : Number(v));
  const presence = num(s.presencePenalty);
  const frequency = num(s.frequencyPenalty);
  const topK = num(s.topK);
  const seed = num(s.seed);
  if (presence) out.presence_penalty = presence;
  if (frequency) out.frequency_penalty = frequency;
  if (topK > 0) out.top_k = topK;
  if (seed != null && Number.isFinite(seed)) out.seed = seed;
  return out;
}

// B10: the auto-summarize decision, kept pure so it can be tested without a
// React tree. `lastSummarizedCount` is the history length the last summary ran
// on, which stops it firing again on every render at the same length.
function shouldAutoSummarize({ tokenPct = 0, messageCount = 0, generating = false, lastSummarizedCount = 0, minMessages = 12, threshold = 75 } = {}) {
  if (generating) return false;
  if (messageCount < minMessages) return false;
  if (messageCount === lastSummarizedCount) return false;
  return tokenPct >= threshold;
}

// A7: settings for assists/summaries/generation. No utility choice configured
// means exactly the chat settings, so callers can always use the result.
function utilitySettings(settings) {
  const s = settings || {};
  if (!s.utilityModel && !s.utilityProvider) return s;
  const provider = s.utilityProvider || s.provider || 'claude';
  if (provider === 'claude') return { ...s, provider, model: s.utilityModel || s.model };
  const prof = providerProfile({ ...s, provider });
  return {
    ...s,
    provider,
    providers: {
      ...(s.providers || {}),
      [provider]: { ...((s.providers || {})[provider] || {}), endpoint: prof.endpoint, key: prof.key, model: s.utilityModel || prof.model },
    },
  };
}

function providerProfile(settings) {
  const s = settings || {};
  const provider = s.provider || 'claude';
  if (provider === 'claude') return { provider, endpoint: '', key: s.apiKey || '', model: s.model || 'claude-haiku-4-5' };
  const prof = (s.providers && s.providers[provider]) || {};
  const endpoint = normalizeBaseUrl(prof.endpoint || s.localEndpoint || (provider === 'openrouter' ? 'https://openrouter.ai/api' : provider === 'local' ? 'http://localhost:11434' : ''));
  const key = prof.key !== undefined ? prof.key : (s.localApiKey || '');
  const model = prof.model || s.localModel || (provider === 'openrouter' ? 'anthropic/claude-sonnet-5' : provider === 'local' ? 'llama3' : '');
  // A8: the context meter needs the window the user typed for this provider's
  // model; dropping it here is why the override had no effect.
  return { provider, endpoint, key, model, contextLength: prof.contextLength };
}

function buildProviderProbe(settings) {
  const s = settings || {};
  const prof = providerProfile(s);
  const provider = prof.provider;
  if (provider === 'claude') {
    if (!prof.key) throw new Error('Add your Anthropic API key first');
    return {
      url: '/api/anthropic',
      init: {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          apiKey: prof.key,
          model: prof.model,
          messages: [{ role: 'user', content: PROBE_PING }],
          maxTokens: 1,
          stream: false,
        }),
      },
    };
  }
  const base = normalizeBaseUrl(prof.endpoint);
  if (!base) throw new Error('Set the endpoint URL first');
  const model = prof.model;
  if (!model) throw new Error('Pick or type a model id first');
  const headers = { 'Content-Type': 'application/json' };
  if (prof.key) headers.Authorization = `Bearer ${prof.key}`;
  return {
    url: `${base}/v1/chat/completions`,
    init: {
      method: 'POST',
      headers,
      // One token, no tools/plugins/response_format: the cheapest request that
      // still proves the key, endpoint and model id are all good.
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: PROBE_PING }],
        max_tokens: 1,
        temperature: 0,
        stream: false,
      }),
    },
  };
}

function probeHint(status, provider) {
  if (status === 401 || status === 403) return provider === 'claude' ? 'Check the Anthropic API key' : 'Check the API key for this provider';
  if (status === 404) return provider === 'claude'
    ? 'The /api/anthropic proxy is not available at this origin (static host or file://)'
    : 'Check the endpoint URL and the model id';
  if (status === 400) return 'Usually a wrong model id, or a parameter this provider rejects';
  if (status === 429) return 'Rate limited or out of credit';
  if (status >= 500) return 'The provider is having trouble - try again shortly';
  return null;
}

// Best effort, Ollama only: report a missing model before the completion probe
// turns it into a bare 404. LM Studio and other servers have no /api/version,
// so a null here just means "not Ollama - let the request decide".
async function ollamaModelNote(settings, fetchImpl) {
  const prof = providerProfile(settings);
  const base = normalizeBaseUrl(prof.endpoint) || 'http://localhost:11434';
  const get = async (path, ms) => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), ms);
    try {
      const r = await fetchImpl(`${base}${path}`, { signal: ctl.signal });
      return r.ok ? await r.json() : null;
    } catch { return null; } finally { clearTimeout(timer); }
  };
  if (!(await get('/api/version', 2000))) return null;
  const tags = await get('/api/tags', 3000);
  const wanted = String(prof.model || '').trim();
  if (!tags || !wanted) return null;
  const baseName = wanted.replace(/:latest$/, '');
  const found = (tags.models || []).some(m => {
    const n = String(m.name || '');
    return n === wanted || n.replace(/:latest$/, '') === baseName;
  });
  return found ? null : `Ollama is running, but "${wanted}" is not pulled yet`;
}

async function testProvider(settings, { fetchImpl = fetch, timeoutMs = 15000 } = {}) {
  const provider = (settings && settings.provider) || 'claude';
  let probe;
  try {
    probe = buildProviderProbe(settings);
  } catch (e) {
    return { ok: false, provider, detail: e.message, hint: null };
  }

  if (provider === 'local') {
    const note = await ollamaModelNote(settings, fetchImpl);
    if (note) return { ok: false, provider, detail: note, hint: 'Open Local Models and pull it' };
  }

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  const started = Date.now();
  try {
    const resp = await fetchImpl(probe.url, { ...probe.init, signal: ctl.signal });
    const text = await resp.text().catch(() => '');
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch {}
    if (resp.ok) {
      return {
        ok: true, provider, ms: Date.now() - started,
        model: providerProfile(settings).model,
      };
    }
    const detail = (body && (body.error?.message || (typeof body.error === 'string' ? body.error : '') || body.message)) || text.slice(0, 200) || resp.statusText || `HTTP ${resp.status}`;
    return { ok: false, provider, status: resp.status, detail: String(detail).slice(0, 240), hint: probeHint(resp.status, provider) };
  } catch (e) {
    if (e.name === 'AbortError') return { ok: false, provider, detail: `timed out after ${Math.round(timeoutMs / 1000)}s`, hint: 'Is the endpoint running and reachable from this browser?' };
    return { ok: false, provider, detail: `could not reach ${probe.url}`, hint: String(e.message || e).slice(0, 200) };
  } finally { clearTimeout(timer); }
}
/* PROVIDER-EXPORTS-END */

// ── Context summarizer ────────────────────────────────────────────
async function summarizeMessages(messages, char, settings) {
  if (messages.length < 6) return null;
  settings = utilitySettings(settings);
  const toSummarize = messages.slice(0, -4); // keep last 4 intact
  const text = toSummarize.map(m => {
    const t = typeof m.content === 'string' ? m.content : m.content?.find?.(c=>c.type==='text')?.text||'';
    const who = m.role === 'user' ? (settings?.activePersona?.name||'You') : char.name;
    if (m.narrator) return `[NARRATOR] ${t}`;
    return `${who}: ${t}`;
  }).join('\n');

  const sysMsg = `Summarize this roleplay conversation excerpt into a compact 3-6 sentence narrative summary. Preserve key plot points, emotional beats, established facts, and character dynamics. Write in past tense, third person. Return ONLY the summary text.`;
  const fakeChar = { name: 'Summarizer', description: '', personality: '', scenario: '', firstMessage: '', exampleDialogues: '', systemPrompt: '' };
  // Clean system prompt — the summarizer must not inherit the roleplay scaffolding
  const result = await callAI([{ role: 'user', content: text }], fakeChar, settings, null, { system: sysMsg });
  return result.trim();
}

// ── Backup merge ─────────────────────────────────────────────────
// Restores used to overwrite every collection with the backup's copy, so an
// old gist or an auto-sync poll could discard characters and chats typed on
// this device. Both policies keep local data unless the backup is genuinely
// newer; imports are stricter (add-only) so an old file can never replace a
// live conversation.
/* MERGE-EXPORTS-START */
const MERGE_POLICIES = {
  sync:   { records: 'newer', chats: 'prefer-longer', settings: 'remote-if-empty' },
  import: { records: 'keep-local', chats: 'keep-local', settings: 'local' },
};

function mergeRecordList(localList, remoteList, stats, policy) {
  const out = Array.isArray(localList) ? localList.slice() : [];
  const byId = new Map(out.filter(x => x && x.id).map(x => [x.id, x]));
  (Array.isArray(remoteList) ? remoteList : []).forEach(r => {
    if (!r || !r.id) return;
    const mine = byId.get(r.id);
    if (!mine) { out.push(r); byId.set(r.id, r); stats.added++; return; }
    if (policy === 'newer' && String(r.updatedAt || '') > String(mine.updatedAt || '')) {
      out[out.indexOf(mine)] = r;
      byId.set(r.id, r);
      stats.updated++;
    } else stats.kept++;
  });
  return out;
}

function chatStamp(msgs) {
  const last = Array.isArray(msgs) && msgs.length ? msgs[msgs.length - 1] : null;
  return String((last && last.timestamp) || '');
}

function mergeChatMap(localMap, remoteMap, stats, policy) {
  const out = { ...(localMap || {}) };
  Object.entries(remoteMap || {}).forEach(([id, msgs]) => {
    if (!Array.isArray(msgs) || !msgs.length) return;
    const mine = out[id];
    if (!Array.isArray(mine) || !mine.length) { out[id] = msgs; stats.added++; return; }
    const remoteWins = policy === 'prefer-longer' &&
      (msgs.length > mine.length || (msgs.length === mine.length && chatStamp(msgs) > chatStamp(mine)));
    if (remoteWins) { out[id] = msgs; stats.updated++; } else stats.kept++;
  });
  return out;
}

// Pure: no storage, no DOM, no mutation of either payload. `localHasSettings`
// is passed by the caller (the raw hmm_settings row exists or not), because a
// built payload always carries default settings and can't tell.
function mergePayloads(local, remote, opts = {}) {
  const policy = { ...MERGE_POLICIES.sync, ...(opts || {}) };
  const a = local || {};
  const b = remote || {};
  const stats = { changed: 0, nameConflicts: 0 };
  const box = key => (stats[key] = stats[key] || { added: 0, updated: 0, kept: 0 });

  const characters = mergeRecordList(a.characters, b.characters, box('characters'), policy.records);
  const folders    = mergeRecordList(a.folders, b.folders, box('folders'), policy.records);
  const scripts    = mergeRecordList(a.scripts, b.scripts, box('scripts'), policy.records);
  const lorebook   = mergeRecordList(a.lorebook, b.lorebook, box('lorebook'), policy.records);
  const personas   = mergeRecordList(a.personas, b.personas, box('personas'), policy.records);
  const chats      = mergeChatMap(a.chats, b.chats, box('chats'), policy.chats);
  const histories  = mergeChatMap(a.histories, b.histories, box('histories'), policy.chats);
  const assistChats = mergeChatMap(a.assistChats, b.assistChats, box('assistChats'), policy.chats);

  // Two scripts with the same name but different ids are both kept (nothing is
  // lost); they are counted so the UI can mention it.
  const seenNames = new Map();
  scripts.forEach(sc => {
    const key = String(sc.name || '').trim().toLowerCase();
    if (!key) return;
    if (seenNames.has(key) && seenNames.get(key) !== sc.id) stats.nameConflicts++;
    else seenNames.set(key, sc.id);
  });

  let activePersonaId = a.activePersonaId;
  if (!personas.some(p => p && p.id === activePersonaId)) activePersonaId = b.activePersonaId;
  if (!personas.some(p => p && p.id === activePersonaId)) activePersonaId = (personas[0] && personas[0].id) || 'default';

  const takeRemoteSettings = policy.settings === 'remote-if-empty' && !policy.localHasSettings && b.settings;
  const settings = takeRemoteSettings ? b.settings : a.settings;

  for (const key of Object.keys(stats)) {
    const c = stats[key];
    if (c && typeof c === 'object') stats.changed += c.added + c.updated;
  }

  return {
    merged: {
      version: Math.max(Number(a.version) || 0, Number(b.version) || 0),
      exportedAt: opts.now || new Date().toISOString(),
      settings,
      personas,
      activePersonaId,
      characters,
      chats,
      histories,
      lorebook,
      scripts,
      assistChats,
      folders,
    },
    stats,
  };
}
/* MERGE-EXPORTS-END */

// ── GitHub Gist Sync ─────────────────────────────────────────────
const GistSync = {
  FILENAME: 'hmm-data.json',
  headers(token) {
    return { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', 'Accept': 'application/vnd.github+json' };
  },
  buildPayload() {
    // F42: a payload built while chat bodies are still lazy would ship empty
    // chats and overwrite the real history on the next pull. Fail loudly
    // instead; callers await S.loadAllChats() first.
    if (!__allChatsLoaded) throw new Error('Chats are not loaded yet — await S.loadAllChats() before building a payload');
    const chars = S.chars();
    const chats = {}, histories = {}, assistChats = {};
    chars.forEach(c => {
      chats[c.id] = S.chat(c.id);
      histories[c.id] = S.history(c.id);
      const ac = S.assistChat(c.id);
      if (ac.length) assistChats[c.id] = ac; // only carry non-empty ones
    });
    // Strip all secrets — never sync API keys to a gist (they get auto-disabled if detected)
    const { apiKey, localApiKey, globalPrompt, tavilyKey, braveKey, imageHostApiKey, ...safeSettings } = S.settings();
    // Keys now live inside settings.providers — blank every profile's key too.
    const providers = Object.fromEntries(Object.entries(safeSettings.providers || {}).map(([id, p]) => [id, { ...p, key: '' }]));
    return {
      version: 2,
      exportedAt: new Date().toISOString(),
      settings: { ...safeSettings, providers },
      personas: S.personas(),
      activePersonaId: S.activePersonaId(),
      characters: chars,
      chats,
      histories,
      lorebook: S.lorebook(),
      scripts: S.scripts(),
      assistChats,
      folders: S.folders(),
    };
  },
  // Write half of a restore, shared by merge and replace. `preserveSecrets`
  // keeps this device's keys even when the backup carries settings.
  writePayload(data, { preserveSecrets = true } = {}) {
    const d = data || {};
    if (d.settings) {
      if (preserveSecrets) {
        const current = S.settings();
        S.saveSettings({
          ...d.settings,
          apiKey: current.apiKey,
          localApiKey: current.localApiKey,
          globalPrompt: current.globalPrompt,
          tavilyKey: current.tavilyKey,
          braveKey: current.braveKey,
          imageHostApiKey: current.imageHostApiKey,
          // Restored settings carry provider endpoints/models but blank keys.
          providers: Object.fromEntries(Object.entries(d.settings.providers || {}).map(([id, p]) => [id, { ...p, key: (current.providers?.[id]?.key) ?? '' }])),
        });
      } else {
        S.saveSettings(d.settings);
      }
    }
    if (d.personas) S.savePersonas(d.personas);
    if (d.activePersonaId) S.setActivePersonaId(d.activePersonaId);
    if (d.lorebook) S.saveLorebook(d.lorebook);
    if (d.scripts) S.saveScripts(d.scripts);
    if (Array.isArray(d.folders)) S.saveFolders(d.folders);
    if (Array.isArray(d.characters)) S.saveChars(d.characters);
    // Chats are keyed by character id and a merge can keep a local chat whose
    // character the remote payload never listed, so write every key present.
    Object.entries(d.chats || {}).forEach(([id, msgs]) => {
      if (!Array.isArray(msgs)) return;
      // Restoring is authoritative: the incoming payload replaces whatever was
      // on disk for this character, so the write is allowed without a load.
      __chatLoaded.add(id); __chatOnDisk.delete(id);
      S.saveChat(id, msgs);
    });
    Object.entries(d.histories || {}).forEach(([id, hist]) => { if (Array.isArray(hist)) S.saveHistory(id, hist); });
    Object.entries(d.assistChats || {}).forEach(([id, msgs]) => { if (Array.isArray(msgs) && msgs.length) S.saveAssistChat(id, msgs); });
  },
  // Preview the merge without writing anything, for the restore dialog.
  async previewRestore(data, { policy = 'sync' } = {}) {
    await __loadAllChats();
    const preset = policy === 'import' ? MERGE_POLICIES.import : MERGE_POLICIES.sync;
    return mergePayloads(this.buildPayload(), data, { ...preset, localHasSettings: __get('hmm_settings', null) != null }).stats;
  },
  // mode 'merge' (default) keeps local data and folds the backup in; 'replace'
  // makes this device an exact copy (settings included, secrets excepted).
  async restorePayload(data, { mode = 'merge', policy = 'sync' } = {}) {
    if (mode === 'replace') { this.writePayload(data); return null; }
    await __loadAllChats();
    const preset = policy === 'import' ? MERGE_POLICIES.import : MERGE_POLICIES.sync;
    const { merged, stats } = mergePayloads(this.buildPayload(), data, { ...preset, localHasSettings: __get('hmm_settings', null) != null });
    this.writePayload(merged);
    return stats;
  },
  async push(token, gistId) {
    await __loadAllChats();
    const payload = this.buildPayload();
    const content = JSON.stringify(payload, null, 2);

    // Safety check: make sure it's valid JSON before sending
    try { JSON.parse(content); } catch(e) { throw new Error('Local data is corrupted — cannot push: ' + e.message); }

    const body = { description: 'Inkling Roleplay App — auto backup', public: false, files: { [this.FILENAME]: { content } } };
    let id;
    if (gistId) {
      const r = await fetch(`https://api.github.com/gists/${gistId}`, { method: 'PATCH', headers: this.headers(token), body: JSON.stringify(body) });
      if (!r.ok) throw new Error(`GitHub ${r.status}: ${r.statusText}`);
      id = gistId;
    } else {
      const r = await fetch('https://api.github.com/gists', { method: 'POST', headers: this.headers(token), body: JSON.stringify(body) });
      if (!r.ok) throw new Error(`GitHub ${r.status}: ${r.statusText}`);
      id = (await r.json()).id;
    }

    // Verify: read back and parse to catch any GitHub-side truncation
    try {
      const verify = await fetch(`https://api.github.com/gists/${id}`, { headers: this.headers(token) });
      const j = await verify.json();
      const file = j.files?.[this.FILENAME];
      if (!file) throw new Error('no content found');
      // GitHub truncates files >1MB in the API response — fetch raw_url for the full content
      let raw = file.content;
      if (file.truncated && file.raw_url) {
        const rawResp = await fetch(file.raw_url);
        if (rawResp.ok) raw = await rawResp.text();
      }
      JSON.parse(raw); // throws only if genuinely truncated
    } catch(e) {
      throw new Error(`Push verification failed: ${e.message}. Your gist may be corrupted — try pushing again.`);
    }
    return id;
  },
  async pull(token, gistId) {
    const r = await fetch(`https://api.github.com/gists/${gistId}`, { headers: this.headers(token) });
    if (!r.ok) throw new Error(`GitHub ${r.status}: ${r.statusText}`);
    const j = await r.json();
    const raw = j.files?.[this.FILENAME]?.content;
    if (!raw) throw new Error('No Inkling data found in this gist');

    // GitHub truncates very large gist files in the standard response — fetch raw_url when truncated
    let actualContent = raw;
    if (j.files[this.FILENAME].truncated && j.files[this.FILENAME].raw_url) {
      const rawResp = await fetch(j.files[this.FILENAME].raw_url);
      if (rawResp.ok) actualContent = await rawResp.text();
    }

    try {
      return JSON.parse(actualContent);
    } catch(e) {
      throw new Error(`This gist is corrupted (${e.message}). Try editing it manually on gist.github.com or push a fresh backup from another browser.`);
    }
  },
  async listGists(token) {
    const r = await fetch('https://api.github.com/gists?per_page=30', { headers: this.headers(token) });
    if (!r.ok) throw new Error(`GitHub ${r.status}: ${r.statusText}`);
    return (await r.json()).filter(g => g.files?.[this.FILENAME]);
  },
};

/* SYNC-CRYPTO-START */
// D29: end-to-end encryption for the sync blob. The server only ever stores
// this envelope: a key derived with PBKDF2-SHA256 from a passphrase the host
// never sees, and AES-GCM with a fresh 96-bit IV on every push. GCM also
// authenticates the blob, so a truncated or edited backup fails to open rather
// than decrypting into garbage. Kept free of React and DOM so test/crypto.test.js
// can run the exact shipping code under Node.
const SYNC_CRYPTO_TYPE = 'inkling-encrypted-backup';
const SYNC_CRYPTO_VERSION = 1;
// ~0.2 s on a laptop, a few seconds on an old phone: enough to make guessing
// at a stolen blob expensive, cheap enough to do once per device.
const SYNC_CRYPTO_ITERATIONS = 250000;
const SYNC_CRYPTO_SALT_BYTES = 16;

function syncB64Encode(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

function syncB64Decode(text) {
  const bin = atob(text);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function newSyncSalt() {
  return syncB64Encode(globalThis.crypto.getRandomValues(new Uint8Array(SYNC_CRYPTO_SALT_BYTES)));
}

function isEncryptedSyncBlob(data) {
  return !!data && typeof data === 'object'
    && data.type === SYNC_CRYPTO_TYPE
    && data.v === SYNC_CRYPTO_VERSION
    && typeof data.iv === 'string'
    && typeof data.data === 'string'
    && !!data.kdf && typeof data.kdf.salt === 'string';
}

async function deriveSyncKey(passphrase, saltB64, iterations = SYNC_CRYPTO_ITERATIONS) {
  if (typeof passphrase !== 'string' || passphrase.length < 8) {
    throw new Error('Passphrase must be at least 8 characters');
  }
  const subtle = globalThis.crypto.subtle;
  const base = await subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return subtle.deriveKey(
    { name: 'PBKDF2', salt: syncB64Decode(saltB64), iterations, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt'],
  );
}

// Short public check value stored beside the salt: lets a device say "wrong
// passphrase" instead of "corrupt backup", and lets a remembered key be
// validated without keeping the passphrase itself.
async function syncKeyFingerprint(key) {
  const raw = await globalThis.crypto.subtle.exportKey('raw', key);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', raw);
  return Array.from(new Uint8Array(digest).slice(0, 6), b => b.toString(16).padStart(2, '0')).join('');
}

async function encryptSyncPayload(payload, key, saltB64, iterations = SYNC_CRYPTO_ITERATIONS) {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const plain = new TextEncoder().encode(JSON.stringify(payload));
  const cipher = await globalThis.crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain);
  return {
    type: SYNC_CRYPTO_TYPE,
    v: SYNC_CRYPTO_VERSION,
    kdf: { name: 'PBKDF2-SHA256', iterations, salt: saltB64 },
    cipher: 'AES-GCM-256',
    iv: syncB64Encode(iv),
    data: syncB64Encode(new Uint8Array(cipher)),
    encryptedAt: new Date().toISOString(),
  };
}

async function decryptSyncPayload(envelope, key) {
  if (!isEncryptedSyncBlob(envelope)) throw new Error('Not an encrypted Inkling backup');
  let plain;
  try {
    plain = await globalThis.crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: syncB64Decode(envelope.iv) }, key, syncB64Decode(envelope.data),
    );
  } catch {
    throw new Error('Could not decrypt this backup — wrong passphrase, or it was re-encrypted on another device');
  }
  return JSON.parse(new TextDecoder().decode(plain));
}
/* SYNC-CRYPTO-END */

// Railway sync: a self-hosted alternative to Gist sync (see server/).
// Same payload shape (GistSync.buildPayload/restorePayload), just pushed to
// your own Postgres-backed endpoint instead of a GitHub gist.
const RailwaySync = {
  // One authenticated POST. Split out so a passphrase change can upload the
  // re-encrypted blob *before* committing the new key locally: if the upload
  // fails, this device keeps the old key, which is still the key the server's
  // copy is encrypted with.
  async send(baseUrl, token, data, expectedRevision = null) {
    const content = JSON.stringify(data);
    try { JSON.parse(content); } catch (e) { throw new Error('Local data is corrupted, cannot push: ' + e.message); }
    const body = { token, data };
    // Optimistic concurrency: a push built on a revision this device has seen
    // is rejected if another device wrote in between, instead of silently
    // overwriting its chats. null opts out (deliberate overwrite).
    if (expectedRevision != null) body.expectedRevision = expectedRevision;
    const r = await fetch(`${baseUrl.replace(/\/+$/, '')}/api/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (r.status === 409) {
      const j = await r.json().catch(() => ({}));
      const err = new Error('The backup changed on another device');
      err.conflict = true;
      err.remoteRevision = j.revision;
      throw err;
    }
    if (!r.ok) throw new Error(`Sync server ${r.status}: ${(await r.text().catch(() => '')) || r.statusText}`);
    // The server's own updated_at, not payload.exportedAt: auto-sync compares
    // this against GET /api/sync/meta's updatedAt, which is server-clocked too.
    const j = await r.json();
    return { updatedAt: j.updatedAt, revision: j.revision };
  },

  async push(baseUrl, token, expectedRevision = null) {
    await __loadAllChats();
    const payload = GistSync.buildPayload();
    let data = payload;
    if (SyncCrypto.enabled()) {
      const meta = SyncCrypto.meta();
      data = await encryptSyncPayload(payload, await SyncCrypto.requireKey(), meta.salt, meta.iterations);
    } else {
      // Never replace a ciphertext backup with plaintext because this browser
      // has not been set up with the passphrase. The meta call is a few dozen
      // bytes, unlike pulling the whole blob just to look at it.
      const remote = await this.meta(baseUrl, token).catch(() => null);
      if (remote && remote.encrypted) {
        const err = new Error('That backup is end-to-end encrypted. Enable encryption on this device with the same passphrase before pushing.');
        err.locked = true;
        throw err;
      }
    }
    return this.send(baseUrl, token, data, expectedRevision);
  },

  async pull(baseUrl, token) {
    const r = await fetch(`${baseUrl.replace(/\/+$/, '')}/api/sync?token=${encodeURIComponent(token)}`);
    if (!r.ok) throw new Error(`Sync server ${r.status}: ${(await r.text().catch(() => '')) || r.statusText}`);
    const j = await r.json();
    if (!j.data) throw new Error('No backup found for this token yet, push from another device first.');
    const encrypted = isEncryptedSyncBlob(j.data);
    let data = j.data;
    if (encrypted) {
      if (!SyncCrypto.enabled()) {
        const err = new Error('This backup is end-to-end encrypted. Open Settings → Sync → Railway and enable encryption with the passphrase you used on the other device.');
        err.locked = true;
        throw err;
      }
      data = await decryptSyncPayload(j.data, await SyncCrypto.requireKey());
    }
    return { data, revision: j.revision, encrypted };
  },

  // Lightweight poll for auto-sync: timestamp, revision and whether the blob
  // is encrypted, without transferring the (potentially multi-MB) backup.
  async meta(baseUrl, token) {
    const r = await fetch(`${baseUrl.replace(/\/+$/, '')}/api/sync/meta?token=${encodeURIComponent(token)}`);
    if (!r.ok) throw new Error(`Sync server ${r.status}: ${(await r.text().catch(() => '')) || r.statusText}`);
    const j = await r.json();
    return { updatedAt: j.updatedAt, revision: j.revision, encrypted: !!j.encrypted };
  },
};

// D29 key management. Only public material (salt, iteration count, a 12-hex
// fingerprint, whether this device remembers the key) goes to localStorage;
// the passphrase is never stored, only used to derive a key. "Remember" keeps
// the raw derived key, which is the usual trade: convenience for the ability
// to decrypt if this browser profile is compromised.
const SYNC_CRYPTO_META_KEY = 'hmm_sync_crypto';
const SYNC_CRYPTO_KEY_KEY = 'hmm_sync_crypto_key';
let __syncKey = null;

const SyncCrypto = {
  meta() {
    try {
      const m = JSON.parse(localStorage.getItem(SYNC_CRYPTO_META_KEY) || 'null');
      return m && typeof m.salt === 'string' && typeof m.fingerprint === 'string' ? m : null;
    } catch { return null; }
  },
  enabled() { return !!this.meta(); },
  unlocked() { return !!__syncKey; },
  fingerprint() { return (this.meta() || {}).fingerprint || ''; },

  async persistKey(key, remember) {
    if (!remember) { localStorage.removeItem(SYNC_CRYPTO_KEY_KEY); return; }
    const raw = await globalThis.crypto.subtle.exportKey('raw', key);
    localStorage.setItem(SYNC_CRYPTO_KEY_KEY, syncB64Encode(new Uint8Array(raw)));
  },

  // Called at launch and when the Sync modal opens. Returns whether the key is
  // in memory afterwards.
  async loadRemembered() {
    if (__syncKey) return true;
    const meta = this.meta();
    const stored = localStorage.getItem(SYNC_CRYPTO_KEY_KEY);
    if (!meta || !stored) return false;
    try {
      const key = await globalThis.crypto.subtle.importKey('raw', syncB64Decode(stored), { name: 'AES-GCM' }, true, ['encrypt', 'decrypt']);
      if (await syncKeyFingerprint(key) !== meta.fingerprint) {
        // The stored key belongs to an older passphrase (changed or cleared
        // elsewhere): drop it and ask for the passphrase instead of failing
        // decryption with a misleading "corrupt backup".
        localStorage.removeItem(SYNC_CRYPTO_KEY_KEY);
        return false;
      }
      __syncKey = key;
      return true;
    } catch {
      localStorage.removeItem(SYNC_CRYPTO_KEY_KEY);
      return false;
    }
  },

  async enable(passphrase, { remember = true } = {}) {
    const salt = newSyncSalt();
    const iterations = SYNC_CRYPTO_ITERATIONS;
    const key = await deriveSyncKey(passphrase, salt, iterations);
    const fingerprint = await syncKeyFingerprint(key);
    localStorage.setItem(SYNC_CRYPTO_META_KEY, JSON.stringify({
      v: 1, salt, iterations, fingerprint, remember: !!remember, createdAt: new Date().toISOString(),
    }));
    __syncKey = key;
    await this.persistKey(key, remember);
    window.dispatchEvent(new Event('hmm-sync-crypto-changed'));
    return fingerprint;
  },

  async unlock(passphrase) {
    const meta = this.meta();
    if (!meta) throw new Error('Encryption is not enabled on this device');
    const key = await deriveSyncKey(passphrase, meta.salt, meta.iterations);
    if (await syncKeyFingerprint(key) !== meta.fingerprint) throw new Error('Wrong passphrase');
    __syncKey = key;
    await this.persistKey(key, meta.remember);
    window.dispatchEvent(new Event('hmm-sync-crypto-changed'));
    return true;
  },

  lock() {
    __syncKey = null;
    localStorage.removeItem(SYNC_CRYPTO_KEY_KEY);
    window.dispatchEvent(new Event('hmm-sync-crypto-changed'));
  },

  // Re-keying uploads first (via `push(envelope)`) and only then commits the
  // new salt/fingerprint, so a failed upload cannot leave this device holding a
  // key the server's copy is not encrypted with.
  async changePassphrase(oldPassphrase, newPassphrase, { remember, push } = {}) {
    await this.unlock(oldPassphrase);
    const meta = this.meta();
    const salt = newSyncSalt();
    const iterations = meta.iterations;
    const key = await deriveSyncKey(newPassphrase, salt, iterations);
    const fingerprint = await syncKeyFingerprint(key);
    if (push) {
      await __loadAllChats();
      const envelope = await encryptSyncPayload(GistSync.buildPayload(), key, salt, iterations);
      await push(envelope);
    }
    localStorage.setItem(SYNC_CRYPTO_META_KEY, JSON.stringify({
      ...meta, salt, iterations, fingerprint, remember: remember != null ? !!remember : meta.remember, changedAt: new Date().toISOString(),
    }));
    __syncKey = key;
    await this.persistKey(key, remember != null ? remember : meta.remember);
    window.dispatchEvent(new Event('hmm-sync-crypto-changed'));
    return fingerprint;
  },

  // Returns null when encryption is off. Throws a `.locked` error when it is on
  // but this session has no key, so callers can tell "nothing to do" from
  // "ask the user for the passphrase".
  async requireKey() {
    if (!this.enabled()) return null;
    if (!__syncKey) await this.loadRemembered();
    if (!__syncKey) {
      const err = new Error('Sync is locked — enter your passphrase in Settings → Sync');
      err.locked = true;
      throw err;
    }
    return __syncKey;
  },
};

// ── Character card export (SillyTavern chara_card_v2 — JSON + PNG with 'chara' tEXt chunk) ──
function charToCardV2(char) {
  // Round-trip an imported card lorebook back into the exported card
  const bookScript = S.scripts().find(s => s._cardBookFor === char.id);
  const character_book = bookScript ? {
    name: `${char.name} Lorebook`,
    entries: (bookScript.entries || []).map((e, i) => ({
      keys: e.keywords || [],
      content: e.content || '',
      enabled: e.enabled !== false,
      insertion_order: e.order ?? i,
      extensions: { probability: e.probability ?? 100, scan_depth: e.depth ?? 8 },
    })),
  } : undefined;
  return {
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      ...(character_book ? { character_book } : {}),
      name: char.name || '',
      description: char.description || '',
      personality: char.personality || '',
      scenario: char.scenario || '',
      first_mes: char.firstMessage || '',
      mes_example: char.exampleDialogues || '',
      system_prompt: char.systemPrompt || '',
      post_history_instructions: '',
      alternate_greetings: char.alternateGreetings || [],
      tags: char.tags || [],
      creator: '',
      character_version: '',
      creator_notes: '',
      extensions: {},
    },
  };
}

const __safeFilename = name => ((name || '').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '_')) || 'character';

function __downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  Object.assign(document.createElement('a'), { href: url, download: filename }).click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function downloadCharJson(char) {
  const blob = new Blob([JSON.stringify(charToCardV2(char), null, 2)], { type: 'application/json' });
  __downloadBlob(blob, `${__safeFilename(char.name)}.json`);
}

const __crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
const __crc32 = bytes => {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = __crcTable[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
};

// Insert tEXt chunk (keyword 'chara', base64 JSON) before IEND; drops any pre-existing chara chunk
function embedCharaChunk(pngBytes, jsonStr) {
  const utf8 = new TextEncoder().encode(jsonStr);
  let bin = '';
  for (let i = 0; i < utf8.length; i += 0x8000) bin += String.fromCharCode.apply(null, utf8.subarray(i, i + 0x8000));
  const b64 = btoa(bin);
  const keyword = 'chara';
  const data = new Uint8Array(keyword.length + 1 + b64.length);
  for (let i = 0; i < keyword.length; i++) data[i] = keyword.charCodeAt(i);
  for (let i = 0; i < b64.length; i++) data[keyword.length + 1 + i] = b64.charCodeAt(i);

  const typeAndData = new Uint8Array(4 + data.length);
  typeAndData.set([0x74, 0x45, 0x58, 0x74]); // 'tEXt'
  typeAndData.set(data, 4);

  const chunk = new Uint8Array(12 + data.length);
  const cv = new DataView(chunk.buffer);
  cv.setUint32(0, data.length);
  chunk.set(typeAndData, 4);
  cv.setUint32(8 + data.length, __crc32(typeAndData));

  const dec = new TextDecoder('latin1');
  const parts = [pngBytes.slice(0, 8)];
  let offset = 8;
  while (offset < pngBytes.length - 11) {
    const len = (pngBytes[offset]<<24)|(pngBytes[offset+1]<<16)|(pngBytes[offset+2]<<8)|pngBytes[offset+3];
    const type = dec.decode(pngBytes.slice(offset + 4, offset + 8));
    const whole = pngBytes.slice(offset, offset + 12 + len);
    const isChara = type === 'tEXt' && dec.decode(whole.slice(8, 8 + Math.min(len, 6))).startsWith('chara\0');
    if (type === 'IEND') parts.push(chunk);
    if (!isChara) parts.push(whole);
    offset += 12 + len;
  }
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let pos = 0;
  parts.forEach(p => { out.set(p, pos); pos += p.length; });
  return out;
}

// Render avatar (or initials tile) to a 512×512 PNG blob
function __renderCharPng(char) {
  return new Promise(resolve => {
    const SIZE = 512;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = SIZE;
    const cx = canvas.getContext('2d');
    const fallback = () => {
      cx.fillStyle = charBg(char.name || 'X');
      cx.fillRect(0, 0, SIZE, SIZE);
      cx.fillStyle = charFg(char.name || 'X');
      cx.font = `700 ${Math.round(SIZE * 0.34)}px sans-serif`;
      cx.textAlign = 'center'; cx.textBaseline = 'middle';
      cx.fillText((char.name || '?').slice(0, 2).toUpperCase(), SIZE / 2, SIZE / 2);
      canvas.toBlob(resolve, 'image/png');
    };
    const src = char.avatar;
    if (!src || src.startsWith('/assets/')) return fallback();
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const s = Math.max(SIZE / img.width, SIZE / img.height);
        cx.drawImage(img, (SIZE - img.width * s) / 2, (SIZE - img.height * s) / 2, img.width * s, img.height * s);
        canvas.toBlob(b => b ? resolve(b) : fallback(), 'image/png');
      } catch { fallback(); } // tainted canvas (CORS-blocked remote avatar) → initials tile
    };
    img.onerror = fallback;
    img.src = src;
  });
}

async function downloadCharPng(char) {
  const blob = await __renderCharPng(char);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const out = embedCharaChunk(bytes, JSON.stringify(charToCardV2(char)));
  __downloadBlob(new Blob([out], { type: 'image/png' }), `${__safeFilename(char.name)}.png`);
}

Object.assign(window, {
  AppCtx, S, genId, estimateTokens, compressImage, uploadImage, CHANGELOG,
  formatTime, formatDate, renderMarkdown,
  charBg, charFg, buildSystemPrompt, substituteMacros, callAI, avatarPx,
  summarizeMessages, GistSync, RailwaySync, testProvider, providerProfile, generationExtras,
  shouldAutoSummarize, utilitySettings,
  chatToMarkdown, chatToJson, chatToHtml, chatExportRows, trashExpired,
  parseOpenAIUsage, parseAnthropicUsage, mergeUsage, contextTokensFromMessages,
  resolveContextLength, contextMeter, modelContextLength,
  nextGroupSpeaker, parseDirectorChoice, normalizeGroupReplies,
  detectFontFormat, validateTextboxFont, isMonospaceMetrics, textboxFontMaxBytes,
  applyTextboxFont, textboxFontMetrics, TEXTBOX_FONT_MAX_BYTES,
  SyncCrypto, isEncryptedSyncBlob, encryptSyncPayload, decryptSyncPayload,
  deriveSyncKey, syncKeyFingerprint, newSyncSalt,
  downloadCharJson, downloadCharPng,
  parseTextbox, expressionAt, resolveExpressionKey, expressionNameFromFilename, pitchForCharacter,
  sidebarRows, chatMetaFromMessages, chatPreviewText,
  sidebarSortOptions, sidebarSortValue, withSidebarSort, sidebarSortCharacters,
  textboxAutoAdvanceMs, shouldAutoAdvancePage,
  clampBlipVolume, blipForCharacter,
});
