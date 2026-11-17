// B18 chat export formats and D26 trash retention — both pure functions.
import { loadSlice, makeRunner } from './harness.js';

const { chatExportRows, chatToMarkdown, chatToJson, chatToHtml, trashExpired } = loadSlice(
  '/* MISC-EXPORTS-START */', '/* MISC-EXPORTS-END */',
);
const { eq, ok, done } = makeRunner();

const char = { id: 'c1', name: 'Vera' };
const settings = { activePersona: { name: 'Ace' } };
const messages = [
  { id: 'm1', role: 'user', content: 'Hello <b>world</b>', timestamp: '2026-01-02T03:04:05Z' },
  { id: 'm2', role: 'assistant', content: [{ type: 'text', text: 'Hi *there*' }, { type: 'image', source: {} }], timestamp: '2026-01-02T03:05:00Z' },
  { id: 'm3', role: 'assistant', content: '[CONTEXT SUMMARY] folded', narrator: true, pinned: true, timestamp: null },
];

// ── shared row model ────────────────────────────────────────────
{
  const rows = chatExportRows(messages, char, settings);
  eq('one row per message', rows.length, 3);
  eq('user author comes from the persona', rows[0].author, 'Ace');
  eq('character author is the character', rows[1].author, 'Vera');
  eq('narrator is labelled', rows[2].author, 'Narrator');
  eq('multimodal text is flattened', rows[1].text, 'Hi *there*');
  eq('images are counted', rows[1].images, 1);
  eq('missing timestamp stays null', rows[2].at, null);
}

// ── Markdown ────────────────────────────────────────────────────
{
  const md = chatToMarkdown(messages, char, settings, '2026-01-03T00:00:00Z');
  ok('markdown starts with the character name', md.startsWith('# Vera'));
  ok('markdown has a message count', md.includes('3 messages'));
  ok('markdown names each speaker', md.includes('**Ace**') && md.includes('**Vera**') && md.includes('**Narrator**'));
  ok('markdown notes attached images', md.includes('1 image attached'));
  ok('markdown keeps message text', md.includes('Hi *there*'));
}

// ── JSON ────────────────────────────────────────────────────────
{
  const parsed = JSON.parse(chatToJson(messages, char, settings, '2026-01-03T00:00:00Z'));
  eq('json spec tag', parsed.spec, 'inkling-chat-v1');
  eq('json records the character', parsed.character.name, 'Vera');
  eq('json exports every message', parsed.messages.length, 3);
  eq('json keeps roles', parsed.messages[1].role, 'assistant');
  eq('json is valid and self-describing', parsed.exportedAt, '2026-01-03T00:00:00Z');
}

// ── HTML ────────────────────────────────────────────────────────
{
  const html = chatToHtml(messages, char, settings, '2026-01-03T00:00:00Z');
  ok('html is a document', html.startsWith('<!doctype html>'));
  ok('html escapes user text', html.includes('Hello &lt;b&gt;world&lt;/b&gt;'));
  ok('html does not leak the raw tag', !html.includes('Hello <b>world</b>'));
  ok('html marks the user turn', html.includes('<article class="user">'));
  ok('html includes the character name', html.includes('<h1>Vera</h1>'));
  ok('html notes attached images', html.includes('1 image attached'));
}

// ── trash retention (D26) ───────────────────────────────────────
{
  const now = Date.parse('2026-02-01T00:00:00Z');
  const at = days => new Date(now - days * 86400000).toISOString();
  eq('fresh trash is kept', trashExpired({ deletedAt: at(1) }, now), false);
  eq('29 days is still inside the window', trashExpired({ deletedAt: at(29) }, now), false);
  eq('31 days is expired', trashExpired({ deletedAt: at(31) }, now), true);
  eq('a corrupt date is treated as expired', trashExpired({ deletedAt: 'not-a-date' }, now), true);
  eq('a missing entry is treated as expired', trashExpired(null, now), true);
  eq('custom retention is honoured', trashExpired({ deletedAt: at(5) }, now, 3), true);
}

done();
