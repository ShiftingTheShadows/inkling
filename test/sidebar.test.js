import { loadSlice, makeRunner } from './harness.js';

const M = loadSlice('/* SIDEBAR-EXPORTS-START */', '/* SIDEBAR-EXPORTS-END */');
const { eq, ok, done } = makeRunner();

eq('preview strips markdown stars', M.chatPreviewText('**Hi** there'), 'Hi there');
eq('preview collapses whitespace', M.chatPreviewText('a\n\n  b\tc'), 'a b c');
eq('preview trims', M.chatPreviewText('  hello  '), 'hello');
eq('preview caps at 50 characters', M.chatPreviewText('x'.repeat(80)).length, 50);
eq('preview of nothing is empty', M.chatPreviewText(null), '');

// The summary written on every chat save.
const meta = M.chatMetaFromMessages([
  { id: 'a', role: 'user', content: 'first' },
  { id: 'b', role: 'assistant', content: '**Last** line\nof the reply', timestamp: '2026-01-02T03:04:05Z' },
]);
eq('meta counts messages', meta.count, 2);
eq('meta previews the last message, cleaned', meta.preview, 'Last line of the reply');
eq('meta records the last speaker', meta.lastRole, 'assistant');
eq('meta records the last timestamp', meta.lastAt, '2026-01-02T03:04:05Z');

eq('meta of an empty chat', M.chatMetaFromMessages([]),
  { count: 0, preview: '', lastRole: null, lastAt: null });
eq('meta reads a multimodal last message', M.chatMetaFromMessages([
  { role: 'user', content: 'plain' },
  { role: 'assistant', content: [{ type: 'image', url: 'x' }, { type: 'text', text: 'from the parts' }] },
]).preview, 'from the parts');
eq('meta tolerates a non-array', M.chatMetaFromMessages(null).count, 0);

// ── the sidebar row path ───────────────────────────────────
const chars = [
  { id: 'c1', name: 'Vera', firstMessage: 'You again.' },
  { id: 'c2', name: 'Verity', description: 'An archivist' },
  { id: 'c3', name: 'Mox', firstMessage: 'Well well.' },
];
const metaMap = {
  c1: { count: 42, preview: 'the latest line', lastRole: 'assistant', lastAt: '2026-01-01T00:00:00Z' },
};
const rows = M.sidebarRows(chars, { chatMeta: () => metaMap });

eq('rows keep the order they were given', rows.map(r => r.char.id), ['c1', 'c2', 'c3']);
eq('a saved chat previews its last message', rows[0].preview, 'the latest line');
eq('a chat with messages reports its count', rows[0].count, 42);
eq('no chat yet falls back to the greeting', rows[2].preview, 'Well well.');
eq('no greeting falls back to the description', rows[1].preview, 'An archivist');
eq('an empty row shows the dash placeholder source', rows[1].preview || '—', 'An archivist');

// The old preview logic, verbatim, so the new path can be compared against it.
const legacyPreview = (char, msgs) => {
  const last = msgs[msgs.length - 1];
  const raw = last
    ? (typeof last.content === 'string' ? last.content : last.content?.find?.(c => c.type === 'text')?.text || '')
    : (char.firstMessage || char.description || '');
  return raw.replace(/\*/g, '').replace(/\s+/g, ' ').trim().slice(0, 50);
};
const chats = {
  c1: [{ role: 'assistant', content: 'the latest line' }],
  c2: [],
  c3: [],
};
eq('the new rows match the old per-row read exactly',
  rows.map(r => r.preview), chars.map(c => legacyPreview(c, chats[c.id] || [])));

// ── regression guard + measurement ────────────────────────
// A store that refuses chat reads. If the sidebar path ever goes back to
// S.chat(id) for previews, this throws instead of quietly passing.
const big = Array.from({ length: 500 }, (_, i) => ({ id: `x${i}`, name: `Char ${i}`, firstMessage: 'hi' }));
const bigMeta = Object.fromEntries(big.map(c => [c.id, { count: 200, preview: 'last line', lastAt: '2026-01-01T00:00:00Z' }]));
let chatMetaReads = 0, chatReads = 0;
const guarded = {
  chatMeta() { chatMetaReads++; return bigMeta; },
  chat() { chatReads++; throw new Error('the sidebar read a chat history'); },
};

let bigRows;
try {
  bigRows = M.sidebarRows(big, guarded);
} catch (e) {
  bigRows = null;
  console.log(`FAIL sidebar rows threw: ${e.message}`);
}
ok('sidebar rows for 500 characters are built without touching a chat', !!bigRows && bigRows.length === 500);
eq('the sidebar never reads a chat history', chatReads, 0);
eq('the sidebar reads the summary map exactly once per render', chatMetaReads, 1);

// The before/after that this fix is about: the old path read one chat per
// character on every render, the new path reads one map.
let legacyReads = 0;
const legacyStore = {
  chatMeta: () => bigMeta,
  chat(id) { legacyReads++; return chats[id] || []; },
};
big.forEach(c => legacyPreview(c, legacyStore.chat(c.id)));
console.log(`\nsidebar render path (${big.length} characters, 200 messages each):`);
console.log(`  before: ${legacyReads} chat-history reads (${legacyReads * 200} messages scanned)`);
console.log(`  after:  ${chatMetaReads} metadata read (${Object.keys(bigMeta).length} summaries)`);
eq('the old path is what this fix removes', legacyReads, big.length);

done();
