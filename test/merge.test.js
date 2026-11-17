// Backup merge rules. Pure function only — no storage, no DOM. The rules here
// are the gate on data safety: an ambiguous case must keep local data.
import { loadSlice, makeRunner } from './harness.js';

const { mergePayloads } = loadSlice('/* MERGE-EXPORTS-START */', '/* MERGE-EXPORTS-END */');
const { eq, ok, done } = makeRunner();

const SYNC = { records: 'newer', chats: 'prefer-longer', settings: 'local' };
const IMPORT = { records: 'keep-local', chats: 'keep-local', settings: 'local' };

const char = (id, updatedAt, name) => ({ id, name: name || id, updatedAt });
const msg = (id, timestamp) => ({ id, role: 'user', content: id, timestamp });
const payload = over => ({
  version: 2,
  settings: {},
  personas: [{ id: 'p1', name: 'Me' }],
  activePersonaId: 'p1',
  characters: [],
  chats: {},
  histories: {},
  assistChats: {},
  lorebook: [],
  scripts: [],
  folders: [],
  ...over,
});

// ── characters ──────────────────────────────────────────────────
{
  const local = payload({ characters: [char('a', '2026-01-01'), char('b', '2026-01-01')] });
  const remote = payload({ characters: [char('b', '2026-01-01'), char('c', '2026-01-01')] });
  const { merged, stats } = mergePayloads(local, remote, SYNC);
  eq('sync: local-only character survives', merged.characters.map(c => c.id).sort(), ['a', 'b', 'c']);
  eq('sync: remote-only character is added', stats.characters.added, 1);
}

{
  const local = payload({ characters: [char('a', '2026-01-02', 'newer local')] });
  const remote = payload({ characters: [char('a', '2026-01-01', 'older remote')] });
  const { merged, stats } = mergePayloads(local, remote, SYNC);
  eq('sync: older remote does not replace local', merged.characters[0].name, 'newer local');
  eq('sync: older remote counted as kept', stats.characters.kept, 1);

  const newerRemote = payload({ characters: [char('a', '2026-01-03', 'newer remote')] });
  const r2 = mergePayloads(local, newerRemote, SYNC);
  eq('sync: newer remote replaces local', r2.merged.characters[0].name, 'newer remote');
  eq('sync: replacement counted as updated', r2.stats.characters.updated, 1);
}

{
  const local = payload({ characters: [char('a', '2026-01-02', 'local')] });
  const remote = payload({ characters: [char('a', '2026-02-02', 'remote')] });
  const { merged } = mergePayloads(local, remote, IMPORT);
  eq('import: existing id is never replaced', merged.characters[0].name, 'local');
}

{
  const local = payload({ characters: [char('a')] });
  const remote = payload({ characters: [char('a', '2026-05-05', 'remote')] });
  const { merged } = mergePayloads(local, remote, SYNC);
  eq('sync: missing local updatedAt loses to a dated remote', merged.characters[0].name, 'remote');
}

// ── chats ───────────────────────────────────────────────────────
{
  const local = payload({ chats: { a: [msg('m1', '2026-01-01'), msg('m2', '2026-01-02')] } });
  const remote = payload({ chats: { a: [msg('m1', '2026-01-01')] } });
  const { merged } = mergePayloads(local, remote, SYNC);
  eq('sync: shorter remote never rolls back a chat', merged.chats.a.length, 2);

  const longerRemote = payload({ chats: { a: [msg('m1', '2026-01-01'), msg('m2', '2026-01-02'), msg('m3', '2026-01-03')] } });
  const r2 = mergePayloads(local, longerRemote, SYNC);
  eq('sync: longer remote chat replaces local', r2.merged.chats.a.length, 3);
  eq('sync: adopted chat counted as updated', r2.stats.chats.updated, 1);
}

{
  const local = payload({ chats: {} });
  const remote = payload({ chats: { a: [msg('m1', '2026-01-01')] } });
  const { merged, stats } = mergePayloads(local, remote, SYNC);
  eq('sync: empty local chat is filled', merged.chats.a.length, 1);
  eq('sync: filled chat counted as added', stats.chats.added, 1);
}

{
  const local = payload({ chats: { a: [msg('m1', '2026-01-02')] } });
  const remote = payload({ chats: { a: [msg('m0', '2026-01-03')] } });
  const { merged, stats } = mergePayloads(local, remote, SYNC);
  eq('sync: equal length tie goes to the later message', merged.chats.a[0].id, 'm0');
  eq('sync: tie counted as updated', stats.chats.updated, 1);
}

// ── collections ────────────────────────────────────────────────
{
  const local = payload({ folders: [{ id: 'f1', name: 'Local' }] });
  const remote = payload({ folders: [{ id: 'f1', name: 'Remote' }, { id: 'f2', name: 'New' }] });
  const { merged, stats } = mergePayloads(local, remote, SYNC);
  eq('folders: union by id', merged.folders.map(f => f.id).sort(), ['f1', 'f2']);
  eq('folders: local folder wins a clash', merged.folders.find(f => f.id === 'f1').name, 'Local');
  eq('folders: added counted', stats.folders.added, 1);
}

{
  const local = payload({ scripts: [{ id: 's1', name: 'Lore' }] });
  const remote = payload({ scripts: [{ id: 's2', name: 'lore' }] });
  const { merged, stats } = mergePayloads(local, remote, SYNC);
  eq('scripts: same-name/different-id both kept', merged.scripts.length, 2);
  eq('scripts: name collision counted', stats.nameConflicts, 1);
}

{
  const local = payload({ lorebook: [{ id: 'l1' }], personas: [{ id: 'p1', name: 'Me' }] });
  const remote = payload({ lorebook: [{ id: 'l1' }, { id: 'l2' }], personas: [{ id: 'p2', name: 'Them' }] });
  const { merged, stats } = mergePayloads(local, remote, SYNC);
  eq('lorebook: union by id', merged.lorebook.length, 2);
  eq('lorebook: added counted', stats.lorebook.added, 1);
  eq('personas: added counted', stats.personas.added, 1);
  eq('personas: local active persona kept', merged.activePersonaId, 'p1');
}

{
  const local = payload({ personas: [{ id: 'p1', name: 'Me' }], activePersonaId: 'gone' });
  const remote = payload({ personas: [] });
  const { merged } = mergePayloads(local, remote, SYNC);
  eq('personas: missing active id falls back to the first persona', merged.activePersonaId, 'p1');
}

// ── settings + purity ──────────────────────────────────────────
{
  const local = payload({ settings: { theme: 'local' } });
  const remote = payload({ settings: { theme: 'remote' } });
  const mergedLocal = mergePayloads(local, remote, SYNC).merged;
  eq('settings: merge keeps local settings', mergedLocal.settings.theme, 'local');
  const fresh = mergePayloads(local, remote, { ...SYNC, settings: 'remote-if-empty', localHasSettings: false }).merged;
  eq('settings: fresh install adopts remote settings', fresh.settings.theme, 'remote');
}

{
  const local = payload({ characters: [char('a', '2026-01-01')] });
  const remote = payload({ characters: [char('b', '2026-01-01')] });
  const snapshot = JSON.stringify([local, remote]);
  const { stats } = mergePayloads(local, remote, SYNC);
  eq('inputs are not mutated', JSON.stringify([local, remote]), snapshot);
  eq('changed = added + updated', stats.changed, 1);
}

{
  const { merged } = mergePayloads(payload({}), payload({ version: 2 }), SYNC);
  eq('version carried through', merged.version, 2);
  ok('exportedAt is an ISO timestamp', /^\d{4}-\d{2}-\d{2}T/.test(merged.exportedAt));
}

done();
