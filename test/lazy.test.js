// F42: boot keeps only the small records in memory and leaves chat/history
// bodies on disk until a character is opened. These tests drive the real boot
// ingestion rule (the same function the IndexedDB cursor feeds) so the lazy
// behavior is measured, not described.
import { loadSlice, makeRunner } from './harness.js';

const L = loadSlice('/* STORAGE-BOOT-START */', '/* STORAGE-BOOT-END */');
const { eq, ok, done } = makeRunner();

// What a two-character library looks like in IndexedDB.
const AVATAR = 'data:image/png;base64,' + Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]).toString('base64');
const messages = n => Array.from({ length: n }, (_, i) => ({ role: 'user', content: `message ${i}` }));
const records = new Map([
  ['hmm_chars', [{ id: 'a', name: 'Ana', avatar: AVATAR }, { id: 'b', name: 'Bo' }]],
  ['hmm_settings', { theme: 'terminal' }],
  ['hmm_chat_meta', { a: { count: 12, preview: 'message 11' } }],
  ['hmm_chat_a', messages(12)],
  ['hmm_hist_a', [{ id: 's1', messages: messages(1) }]],
  ['hmm_chat_b', messages(3)],
]);
const storedMessages = 16;

// Before F42 every record went into the in-memory cache at boot.
const before = new Map();
for (const [k, v] of records) before.set(k, v);

const mem = new Map();
const ingest = L.createBootIngest(mem);
for (const [k, v] of records) ingest.accept(k, v);

eq('the old boot held every record', before.size, 6);
eq('the new boot holds only the small records', [...mem.keys()].sort(), ['hmm_chars', 'hmm_chat_meta', 'hmm_settings']);
eq('both characters\' chat bodies are deferred', ingest.deferred().sort(), ['a', 'b']);
ok('no chat or history body is resident', ![...mem.keys()].some(k => L.deferredChatId(k)));
const residentMessages = [...mem.values()].reduce((n, v) => n + (Array.isArray(v) ? v.length : 0), 0);
ok('the message bodies that used to be held are gone', residentMessages < storedMessages, { residentMessages, storedMessages });
eq('characters and settings are still synchronous', mem.get('hmm_settings').theme, 'terminal');
eq('the character list is still synchronous', mem.get('hmm_chars').length, 2);

// The F36 summary map is a small record, not a chat: deferring it would empty
// the sidebar and the welcome screen.
eq('the summary map is not treated as a chat', L.deferredChatId('hmm_chat_meta'), null);
eq('a chat key maps to its character', L.deferredChatId('hmm_chat_zeta'), 'zeta');
eq('a history key maps to its character', L.deferredChatId('hmm_hist_a'), 'a');
eq('unrelated keys are kept', L.deferredChatId('hmm_folders'), null);

// Saving must not replace a chat that is still on disk but not loaded — that
// is how a view mounted too early would wipe a real conversation.
const onDisk = new Set(['a', 'b']);
ok('a save for an unloaded chat is refused', !L.chatSaveAllowed('a', false, onDisk));
ok('a save for a loaded chat is allowed', L.chatSaveAllowed('a', true, onDisk));
ok('a brand-new character can be saved', L.chatSaveAllowed('new', false, onDisk));
ok('with nothing on disk a save is allowed', L.chatSaveAllowed('a', false, new Set()));


// ── the real storage module, run against a fake IndexedDB ───────
// This executes the shipping boot/load code (not a copy of its rules) so the
// deferred-then-loaded behavior is observed, not just asserted about.
import fs from 'node:fs';

function fakeIdb(initial) {
  const store = initial instanceof Map ? initial : new Map(initial);
  const tx = () => ({
    objectStore: () => ({
      get(key) {
        const req = {};
        setTimeout(() => { req.result = store.get(key); req.onsuccess && req.onsuccess(); }, 0);
        return req;
      },
      put(value, key) { store.set(key, value); return {}; },
      delete(key) { store.delete(key); return {}; },
      clear() { store.clear(); return {}; },
      openCursor() {
        const keys = [...store.keys()];
        let i = 0;
        const req = {};
        const step = () => {
          if (i >= keys.length) { req.result = null; req.onsuccess && req.onsuccess(); return; }
          const key = keys[i++];
          req.result = { key, value: store.get(key), continue: step };
          req.onsuccess && req.onsuccess();
        };
        setTimeout(step, 0);
        return req;
      },
    }),
  });
  return { open: () => {
    const req = {};
    setTimeout(() => {
      req.result = { transaction: tx, createObjectStore: () => ({}) };
      req.onupgradeneeded && req.onupgradeneeded();
      req.onsuccess && req.onsuccess();
    }, 0);
    return req;
  }, store };
}

function fakeLocalStorage() {
  const map = new Map();
  return { map, get length() { return map.size; }, key: i => [...map.keys()][i] || null,
    getItem: k => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)),
    removeItem: k => map.delete(k) };
}

const src = fs.readFileSync(new URL('../src/hmm-utils.jsx', import.meta.url), 'utf8');
const body = src.slice(src.indexOf('/* STORAGE-CORE-START */'), src.indexOf('/* STORAGE-CORE-END */'));
const prelude = `
  function __backfillChatMeta() {}
  function __writeChatMeta() {}
`;
const expose = `
  return {
    ready: window.InklingStorageReady,
    mem: __mem,
    onDisk: __chatOnDisk,
    loaded: __chatLoaded,
    chatOf: id => __get('hmm_chat_' + id, []),
    histOf: id => __get('hmm_hist_' + id, []),
    meta: () => __get('hmm_chat_meta', {}),
    loadChats: __loadChats,
    loadAllChats: __loadAllChats,
    saveAllowed: (id) => chatSaveAllowed(id, __chatLoaded.has(id), __chatOnDisk),
    allLoaded: () => __allChatsLoaded,
    db: () => __db,
    chars: () => __get('hmm_chars', []),
    writeChars: v => __storeAvatarList('hmm_chars', v),
  };
`;

{
  const db = fakeIdb([...records]);
  const ls = fakeLocalStorage();
  const win = {};
  const make = new Function('indexedDB', 'localStorage', 'window', 'console',
    prelude + body + expose);
  const M = make(db, ls, win, { info() {}, warn() {}, error() {} });
  await M.ready;

  eq('boot leaves chat bodies out of memory', M.mem.has('hmm_chat_a') || M.mem.has('hmm_chat_b'), false);
  eq('but remembers which characters have chats', [...M.onDisk].sort(), ['a', 'b']);
  eq('reading an unopened chat yields nothing yet', M.chatOf('a'), []);
  eq('the summary map survives boot', M.meta().a.count, 12);
  ok('saving an unopened chat is refused', !M.saveAllowed('a'));

  await M.loadChats('a');
  eq('opening a character reads its chat from IDB', M.chatOf('a').length, 12);
  eq('and its saved sessions', M.histOf('a').length, 1);
  eq('and it is then resident', M.loaded.has('a'), true);
  ok('saving a loaded chat is allowed', M.saveAllowed('a'));
  eq('the other character is still on disk', M.onDisk.has('b'), true);
  eq('with its body still out of memory', M.mem.has('hmm_chat_b'), false);

  ok('a backup payload only becomes possible once every chat is loaded', !M.allLoaded());
  await M.loadAllChats();
  eq('loadAllChats brings the rest in', M.chatOf('b').length, 3);
  ok('and clears the on-disk set', M.onDisk.size === 0 && M.allLoaded());

  // ── F42: avatars are Blobs at rest, base64 in memory ──
  eq('a stored avatar is hydrated back to its data URL', M.chars()[0].avatar, AVATAR);
  ok('the record on disk was rewritten with a Blob avatar', db.store.get('hmm_chars')[0].avatar instanceof Blob);
  ok('and the stored value no longer carries base64', !JSON.stringify(db.store.get('hmm_chars')).includes('base64'));

  M.writeChars([{ id: 'a', name: 'Ana', avatar: AVATAR }, { id: 'c', name: 'Cee', avatar: 'https://example.com/c.png' }]);
  ok('saving a character writes a Blob avatar', db.store.get('hmm_chars')[0].avatar instanceof Blob);
  eq('a remote avatar is stored untouched', db.store.get('hmm_chars')[1].avatar, 'https://example.com/c.png');
  eq('the in-memory character still holds the exact data URL', M.chars()[0].avatar, AVATAR);
  eq('so the sync/export input is unchanged', JSON.stringify(M.chars()[0].avatar), JSON.stringify(AVATAR));

  // A reload reads the Blob back into the same string.
  const again = make(fakeIdb(db.store), fakeLocalStorage(), {}, { info() {}, warn() {}, error() {} });
  await again.ready;
  eq('a reload restores the identical avatar data URL', again.chars()[0].avatar, AVATAR);
}

// ── the avatar conversion itself ────────────────────────────
const A = loadSlice('/* AVATAR-BLOB-START */', '/* AVATAR-BLOB-END */');
{
  const list = [
    { id: 'a', name: 'Ana', avatar: AVATAR },
    { id: 'b', name: 'Bo', avatar: 'https://example.com/b.png' },
    { id: 'c', name: 'Cee', avatar: '' },
  ];
  const stored = A.charsToStored(list);
  ok('a base64 avatar becomes a Blob', stored[0].avatar instanceof Blob);
  eq('carrying its media type', stored[0].avatar.type, 'image/png');
  eq('with the decoded byte length', stored[0].avatar.size, 6);
  ok('the name and id survive', stored[0].name === 'Ana' && stored[0].id === 'a');
  eq('a remote avatar is passed through', stored[1].avatar, 'https://example.com/b.png');
  eq('an empty avatar is passed through', stored[2].avatar, '');
  ok('nothing base64-shaped is left at rest', !JSON.stringify(stored).includes('base64'));
  ok('a pre-existing base64 record is flagged for compaction', A.avatarsNeedCompaction(list));
  ok('a compacted record is not', !A.avatarsNeedCompaction(stored));

  const back = await A.charsFromStored(stored);
  eq('the blob round-trips to the exact original string', back[0].avatar, AVATAR);
  ok('and the character fields are intact', back[0].id === 'a' && back[0].name === 'Ana');
  eq('a remote avatar survives the round trip', back[1].avatar, 'https://example.com/b.png');

  const broken = A.charsToStored([{ id: 'd', avatar: 'data:image/png;base64,!!!not-base64!!!' }]);
  eq('a malformed data URL is left alone rather than corrupted', broken[0].avatar, 'data:image/png;base64,!!!not-base64!!!');
  const svg = A.charsToStored([{ id: 'e', avatar: 'data:image/svg+xml,<svg/>' }]);
  eq('a non-base64 data URL is left alone', svg[0].avatar, 'data:image/svg+xml,<svg/>');
  ok('and neither is flagged', !A.avatarsNeedCompaction([{ avatar: 'data:image/svg+xml,<svg/>' }]));
}
done();
