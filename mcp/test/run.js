// End-to-end: real MCP server over stdio, talking to a fake sync backend.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startFakeSync } from './fake-server.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOKEN = 'test-token-1234';

let pass = 0, fail = 0;
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log(`ok   ${name}`); }
  else { fail++; console.log(`FAIL ${name}${extra ? '\n     ' + JSON.stringify(extra) : ''}`); }
};

const sync = await startFakeSync();

const seed = data => fetch(`${sync.url}/__test/seed`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ token: TOKEN, data }),
});
const dump = () => fetch(`${sync.url}/__test/dump?token=${TOKEN}`).then(r => r.json());

await seed({
  version: 2,
  characters: [
    { id: 'c1', name: 'Vera', description: 'A tired detective', firstMessage: 'You again.', tags: ['noir'], avatar: 'data:image/png;base64,' + 'A'.repeat(4000), createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
    { id: 'c2', name: 'Verity', description: 'An archivist', firstMessage: 'Mind the dust.', tags: ['calm'], createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
  ],
  chats: { c1: [{ id: 'm1', role: 'assistant', content: 'You again.' }], c2: [] },
  histories: { c1: [], c2: [] },
  personas: [{ id: 'p1', name: 'You' }],
  scripts: [],
  settings: {},
});

const client = new Client({ name: 'test', version: '0' }, { capabilities: {} });
await client.connect(new StdioClientTransport({
  command: process.execPath,
  args: [path.join(HERE, '..', 'index.js')],
  env: { ...process.env, INKLING_SYNC_URL: sync.url, INKLING_SYNC_TOKEN: TOKEN },
}));

const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  const text = r.content?.[0]?.text ?? '';
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { isError: !!r.isError, text, json };
};

// ── tools are advertised ──────────────────────────────────
const { tools } = await client.listTools();
check('exposes 6 tools', tools.length === 6, tools.map(t => t.name));
check('create requires name + first_message',
  JSON.stringify(tools.find(t => t.name === 'inkling_create_character').inputSchema.required) === '["name","first_message"]');

// ── status ────────────────────────────────────────────────
const status = await call('inkling_status');
check('status reports counts', status.json?.characters === 2 && status.json?.totalMessages === 1, status.json);

// ── listing ───────────────────────────────────────────────
const list = await call('inkling_list_characters');
check('lists all characters', list.json?.count === 2);
check('listing omits avatar blobs', !list.text.includes('AAAA'));
check('listing reports message counts', list.json.characters.find(c => c.id === 'c1').messages === 1);

const search = await call('inkling_list_characters', { search: 'noir' });
check('search filters by tag', search.json?.count === 1 && search.json.characters[0].name === 'Vera');

// ── get ───────────────────────────────────────────────────
const got = await call('inkling_get_character', { character: 'c1' });
check('get returns full record', got.json?.description === 'A tired detective');
check('get omits avatar by default', /data URI omitted/.test(got.json?.avatar || ''), got.json?.avatar?.slice(0, 60));
const gotAv = await call('inkling_get_character', { character: 'c1', include_avatar: true });
check('include_avatar returns the real value', (gotAv.json?.avatar || '').startsWith('data:image/png'));

// ── name resolution ───────────────────────────────────────
const exact = await call('inkling_get_character', { character: 'Vera' });
check('resolves exact name over partial match', exact.json?.id === 'c1');
const ambiguous = await call('inkling_get_character', { character: 'Ver' });
check('ambiguous partial name errors', ambiguous.isError && /ambiguous/i.test(ambiguous.text), ambiguous.text);
const missing = await call('inkling_get_character', { character: 'Nobody' });
check('unknown name errors', missing.isError && /No character matches/.test(missing.text));

// ── create ────────────────────────────────────────────────
const created = await call('inkling_create_character', {
  name: 'Mox', first_message: 'Well well.', description: 'A fixer',
  personality: 'Sly', tags: ['crime', 'ally'], alternate_greetings: ['Back so soon?'],
});
check('creates a character', created.json?.created?.name === 'Mox', created.text);
let blob = await dump();
const mox = blob.data.characters.find(c => c.name === 'Mox');
check('new character persisted', !!mox);
check('new character has generated id', !!mox?.id && mox.id.length > 5);
check('new character has empty chat seeded', Array.isArray(blob.data.chats[mox.id]));
check('tags stored as array', Array.isArray(mox.tags) && mox.tags.length === 2);
check('alternateGreetings mapped from snake_case', mox.alternateGreetings?.[0] === 'Back so soon?');
check('unknown fields are dropped', mox.bogus === undefined);

const dupe = await call('inkling_create_character', { name: 'Mox', first_message: 'x' });
check('duplicate name refused', dupe.isError && /already exists/.test(dupe.text));

const noGreeting = await call('inkling_create_character', { name: 'Ghost', first_message: '  ' });
check('blank first_message refused', noGreeting.isError && /firstMessage is required/.test(noGreeting.text));

// ── update ────────────────────────────────────────────────
const upd = await call('inkling_update_character', { character: 'Mox', personality: 'Sly, impatient', tags: ['crime'] });
check('update succeeds', !upd.isError, upd.text);
blob = await dump();
const mox2 = blob.data.characters.find(c => c.name === 'Mox');
check('updated field changed', mox2.personality === 'Sly, impatient');
check('untouched field preserved', mox2.description === 'A fixer');
check('updatedAt bumped', mox2.updatedAt !== mox2.createdAt);

const noop = await call('inkling_update_character', { character: 'Mox' });
check('update with no fields errors', noop.isError && /No fields/.test(noop.text));

const collide = await call('inkling_update_character', { character: 'Mox', name: 'Vera' });
check('rename onto existing name refused', collide.isError && /already named/.test(collide.text));

// ── concurrency ───────────────────────────────────────────
await fetch(`${sync.url}/__test/race-once`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ token: TOKEN, mutation: 'add-character' }),
});
const raced = await call('inkling_create_character', { name: 'Late', first_message: 'hi' });
check('write survives a concurrent change', !raced.isError, raced.text);
blob = await dump();
check('concurrent external write NOT clobbered', !!blob.data.characters.find(c => c.id === 'raced'),
  blob.data.characters.map(c => c.name));
check('our write also landed', !!blob.data.characters.find(c => c.name === 'Late'));

// ── delete ────────────────────────────────────────────────
const unconfirmed = await call('inkling_delete_character', { character: 'Late', confirm: false });
check('delete without confirm refused', unconfirmed.isError && /confirm:true/.test(unconfirmed.text));
blob = await dump();
check('refused delete changed nothing', !!blob.data.characters.find(c => c.name === 'Late'));

const del = await call('inkling_delete_character', { character: 'c1', confirm: true });
check('delete succeeds', !del.isError, del.text);
blob = await dump();
check('character removed', !blob.data.characters.find(c => c.id === 'c1'));
check('its chat history removed', blob.data.chats.c1 === undefined);
check('other characters untouched', !!blob.data.characters.find(c => c.id === 'c2'));

// ── empty backup ──────────────────────────────────────────
await client.close();
const client2 = new Client({ name: 'test2', version: '0' }, { capabilities: {} });
await client2.connect(new StdioClientTransport({
  command: process.execPath,
  args: [path.join(HERE, '..', 'index.js')],
  env: { ...process.env, INKLING_SYNC_URL: sync.url, INKLING_SYNC_TOKEN: 'unused-token-9999' },
}));
const empty = await client2.callTool({ name: 'inkling_list_characters', arguments: {} });
check('empty backup gives a clear message', /No backup found/.test(empty.content[0].text));
await client2.close();

sync.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
