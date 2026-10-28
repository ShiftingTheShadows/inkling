// Tools beyond character CRUD: personas, chat messages, folders, scripts.
// Shapes mirror what the app writes (PersonasModal, FolderEditDialog,
// LorebookModal in src/), so anything created here opens cleanly in the UI.

import { resolveCharacter, genId } from './characters.js';
import { assertPayloadShape } from './sync.js';

const str = v => String(v ?? '');
const arr = v => (Array.isArray(v) ? v.map(String) : typeof v === 'string' && v.trim() ? v.split(',').map(s => s.trim()).filter(Boolean) : []);
const lc = v => str(v).toLowerCase().trim();

// Same id-then-exact-name-then-unique-partial lookup characters use.
function resolveBy(list, ref, label) {
  const needle = str(ref).trim();
  if (!needle) throw new Error(`${label} reference is empty`);
  const byId = list.find(x => x.id === needle);
  if (byId) return byId;
  const exact = list.filter(x => lc(x.name) === lc(needle));
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) throw new Error(`"${needle}" matches ${exact.length} ${label}s. Use an id: ${exact.map(x => x.id).join(', ')}`);
  const part = list.filter(x => lc(x.name).includes(lc(needle)));
  if (part.length === 1) return part[0];
  if (part.length > 1) throw new Error(`"${needle}" is ambiguous: ${part.map(x => `${x.name} (${x.id})`).join(', ')}`);
  throw new Error(`No ${label} matches "${needle}"`);
}

const personaView = p => ({ ...p, avatar: p.avatar ? `[${Math.round(p.avatar.length / 1024)}KB data URI omitted]` : '' });
const needBackup = data => { if (!data) throw new Error('No backup found yet. Open Inkling and let it sync once first.'); return data; };

export const EXTRA_TOOLS = [
  // personas
  { name: 'inkling_list_personas', description: 'List the user personas (who the user plays as in chats), and which one is active.',
    inputSchema: { type: 'object', properties: {} } },
  { name: 'inkling_create_persona', description: 'Create a user persona.',
    inputSchema: { type: 'object', properties: {
      name: { type: 'string' }, description: { type: 'string', description: 'Who the user is, as the characters see them.' },
      avatar: { type: 'string', description: 'Optional image URL or data URI.' },
    }, required: ['name'] } },
  { name: 'inkling_update_persona', description: 'Edit a persona. Only the fields you pass change.',
    inputSchema: { type: 'object', properties: {
      persona: { type: 'string', description: 'Persona id or name.' },
      name: { type: 'string' }, description: { type: 'string' }, avatar: { type: 'string' },
    }, required: ['persona'] } },
  { name: 'inkling_delete_persona', description: 'Delete a persona. The last remaining persona cannot be deleted. Confirm with the user first, then pass confirm:true.',
    inputSchema: { type: 'object', properties: {
      persona: { type: 'string' }, confirm: { type: 'boolean' },
    }, required: ['persona', 'confirm'] } },

  // chats
  { name: 'inkling_get_chat', description: 'Read a character\'s chat messages (most recent first page by default). Use offset to page backwards.',
    inputSchema: { type: 'object', properties: {
      character: { type: 'string', description: 'Character id or name.' },
      limit: { type: 'number', description: 'Messages to return (default 20, max 100).' },
      offset: { type: 'number', description: 'Skip this many messages from the end (default 0).' },
    }, required: ['character'] } },
  { name: 'inkling_add_message', description: 'Append a message to a character\'s chat, e.g. to seed a scene or leave a note. Role is "user" or "assistant".',
    inputSchema: { type: 'object', properties: {
      character: { type: 'string' }, role: { type: 'string', enum: ['user', 'assistant'] }, content: { type: 'string' },
    }, required: ['character', 'role', 'content'] } },
  { name: 'inkling_clear_chat', description: 'Delete every message in a character\'s chat (the character stays). Not undoable. Confirm with the user first, then pass confirm:true.',
    inputSchema: { type: 'object', properties: {
      character: { type: 'string' }, confirm: { type: 'boolean' },
    }, required: ['character', 'confirm'] } },

  // folders
  { name: 'inkling_list_folders', description: 'List character folders (nestable) with parent and how many characters each holds directly.',
    inputSchema: { type: 'object', properties: {} } },
  { name: 'inkling_create_folder', description: 'Create a character folder, optionally inside another folder.',
    inputSchema: { type: 'object', properties: {
      name: { type: 'string' }, color: { type: 'string', description: 'CSS color, e.g. "#e0a030".' },
      parent: { type: 'string', description: 'Parent folder id or name. Omit for top level.' },
    }, required: ['name'] } },
  { name: 'inkling_move_character', description: 'Put a character in a folder, or pass folder:"" to move it back to the top level.',
    inputSchema: { type: 'object', properties: {
      character: { type: 'string' }, folder: { type: 'string', description: 'Folder id or name, or empty string for top level.' },
    }, required: ['character', 'folder'] } },
  { name: 'inkling_delete_folder', description: 'Delete a folder. Its characters and subfolders move up to its parent; nothing else is lost. Requires confirm:true.',
    inputSchema: { type: 'object', properties: {
      folder: { type: 'string' }, confirm: { type: 'boolean' },
    }, required: ['folder', 'confirm'] } },

  // scripts
  { name: 'inkling_list_scripts', description: 'List scripts (lorebooks) with type, scope and entry count.',
    inputSchema: { type: 'object', properties: {} } },
  { name: 'inkling_get_script', description: 'Read one script with all its entries.',
    inputSchema: { type: 'object', properties: { script: { type: 'string', description: 'Script id or name.' } }, required: ['script'] } },
  { name: 'inkling_create_script', description: 'Create a lorebook script. Global by default; pass characters to scope it to specific bots instead.',
    inputSchema: { type: 'object', properties: {
      name: { type: 'string' }, description: { type: 'string' },
      characters: { type: 'array', items: { type: 'string' }, description: 'Character ids or names. If given, the script is not global.' },
    }, required: ['name'] } },
  { name: 'inkling_add_script_entry', description: 'Add a keyword-triggered entry to a lorebook script. When a keyword shows up in the chat, the content is whispered to the AI.',
    inputSchema: { type: 'object', properties: {
      script: { type: 'string', description: 'Script id or name.' },
      name: { type: 'string' },
      keywords: { type: 'array', items: { type: 'string' } },
      content: { type: 'string' },
      probability: { type: 'number', description: '0-100, default 100.' },
    }, required: ['script', 'name', 'keywords', 'content'] } },
];

export async function handleExtra(name, args, { sync, ok, fail }) {
  switch (name) {
    case 'inkling_list_personas': {
      const { data } = await sync.pull();
      needBackup(data);
      return ok({ activePersonaId: data.activePersonaId ?? null, personas: (data.personas || []).map(personaView) });
    }

    case 'inkling_create_persona': {
      if (!str(args.name).trim()) return fail('name is required');
      const p = { id: genId(), name: str(args.name).trim(), description: str(args.description), avatar: str(args.avatar) };
      const res = await sync.mutate(d => {
        assertPayloadShape(d);
        d.personas = d.personas || [];
        if (d.personas.some(x => lc(x.name) === lc(p.name))) return { abort: `A persona named "${p.name}" already exists.` };
        d.personas.push(p);
      });
      if (res.aborted) return fail(res.message);
      return ok({ created: personaView(p), revision: res.revision });
    }

    case 'inkling_update_persona': {
      const patch = {};
      for (const k of ['name', 'description', 'avatar']) if (args[k] !== undefined) patch[k] = str(args[k]);
      if (!Object.keys(patch).length) return fail('No fields to update were provided.');
      let updated;
      const res = await sync.mutate(d => {
        assertPayloadShape(d);
        const p = resolveBy(d.personas || [], args.persona, 'persona');
        if (patch.name && lc(patch.name) !== lc(p.name) && d.personas.some(x => x.id !== p.id && lc(x.name) === lc(patch.name))) {
          return { abort: `Another persona is already named "${patch.name}".` };
        }
        Object.assign(p, patch);
        updated = p;
      });
      if (res.aborted) return fail(res.message);
      return ok({ updated: personaView(updated), changed: Object.keys(patch), revision: res.revision });
    }

    case 'inkling_delete_persona': {
      if (args.confirm !== true) return fail('Refusing to delete without confirm:true. Ask the user first.');
      let removed;
      const res = await sync.mutate(d => {
        assertPayloadShape(d);
        const list = d.personas || [];
        const p = resolveBy(list, args.persona, 'persona');
        if (list.length <= 1) return { abort: 'Cannot delete the only persona.' };
        d.personas = list.filter(x => x.id !== p.id);
        if (d.activePersonaId === p.id) d.activePersonaId = d.personas[0].id;
        removed = p;
      });
      if (res.aborted) return fail(res.message);
      return ok({ deleted: { id: removed.id, name: removed.name }, revision: res.revision });
    }

    case 'inkling_get_chat': {
      const { data } = await sync.pull();
      needBackup(data);
      const char = resolveCharacter(data.characters || [], args.character);
      const msgs = data.chats?.[char.id] || [];
      const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 100);
      const offset = Math.max(Number(args.offset) || 0, 0);
      const end = Math.max(msgs.length - offset, 0);
      const page = msgs.slice(Math.max(end - limit, 0), end).map(m => ({
        id: m.id, role: m.role, timestamp: m.timestamp,
        content: typeof m.content === 'string' ? m.content : (m.content?.find?.(c => c.type === 'text')?.text ?? '[non-text content]'),
      }));
      return ok({ character: char.name, total: msgs.length, returned: page.length, offset, messages: page });
    }

    case 'inkling_add_message': {
      if (!['user', 'assistant'].includes(args.role)) return fail('role must be "user" or "assistant".');
      if (!str(args.content).trim()) return fail('content is empty.');
      const msg = { id: genId(), role: args.role, content: str(args.content), timestamp: new Date().toISOString() };
      let charName;
      const res = await sync.mutate(d => {
        assertPayloadShape(d);
        const char = resolveCharacter(d.characters, args.character);
        charName = char.name;
        d.chats = d.chats || {};
        (d.chats[char.id] = d.chats[char.id] || []).push(msg);
      });
      if (res.aborted) return fail(res.message);
      return ok({ added: { id: msg.id, role: msg.role, character: charName }, revision: res.revision });
    }

    case 'inkling_clear_chat': {
      if (args.confirm !== true) return fail('Refusing to clear without confirm:true. Ask the user first.');
      let cleared, charName;
      const res = await sync.mutate(d => {
        assertPayloadShape(d);
        const char = resolveCharacter(d.characters, args.character);
        charName = char.name;
        d.chats = d.chats || {};
        cleared = (d.chats[char.id] || []).length;
        d.chats[char.id] = [];
      });
      if (res.aborted) return fail(res.message);
      return ok({ character: charName, messagesCleared: cleared, revision: res.revision });
    }

    case 'inkling_list_folders': {
      const { data } = await sync.pull();
      needBackup(data);
      const chars = data.characters || [];
      return ok({ folders: (data.folders || []).map(f => ({ ...f, characters: chars.filter(c => c.folderId === f.id).length })) });
    }

    case 'inkling_create_folder': {
      if (!str(args.name).trim()) return fail('name is required');
      let folder;
      const res = await sync.mutate(d => {
        assertPayloadShape(d);
        d.folders = d.folders || [];
        const parent = args.parent ? resolveBy(d.folders, args.parent, 'folder') : null;
        folder = { id: genId(), name: str(args.name).trim().slice(0, 60), color: args.color || '#7c6cf0', parentId: parent?.id };
        d.folders.push(folder);
      });
      if (res.aborted) return fail(res.message);
      return ok({ created: folder, revision: res.revision });
    }

    case 'inkling_move_character': {
      let info;
      const res = await sync.mutate(d => {
        assertPayloadShape(d);
        const char = resolveCharacter(d.characters, args.character);
        const target = str(args.folder).trim() ? resolveBy(d.folders || [], args.folder, 'folder') : null;
        if (target) char.folderId = target.id; else delete char.folderId;
        char.updatedAt = new Date().toISOString();
        info = { character: char.name, folder: target ? target.name : '(top level)' };
      });
      if (res.aborted) return fail(res.message);
      return ok({ moved: info, revision: res.revision });
    }

    case 'inkling_delete_folder': {
      if (args.confirm !== true) return fail('Refusing to delete without confirm:true. Ask the user first.');
      let info;
      const res = await sync.mutate(d => {
        assertPayloadShape(d);
        const f = resolveBy(d.folders || [], args.folder, 'folder');
        // Same reparenting the app does: contents move up one level.
        d.characters.forEach(c => { if (c.folderId === f.id) { if (f.parentId) c.folderId = f.parentId; else delete c.folderId; } });
        d.folders.forEach(x => { if (x.parentId === f.id) { if (f.parentId) x.parentId = f.parentId; else delete x.parentId; } });
        d.folders = d.folders.filter(x => x.id !== f.id);
        info = { id: f.id, name: f.name };
      });
      if (res.aborted) return fail(res.message);
      return ok({ deleted: info, revision: res.revision });
    }

    case 'inkling_list_scripts': {
      const { data } = await sync.pull();
      needBackup(data);
      return ok({ scripts: (data.scripts || []).map(s => ({
        id: s.id, name: s.name, type: s.type || 'lorebook', enabled: s.enabled !== false,
        global: s.global !== false, charIds: s.charIds || [], entries: (s.entries || []).length,
      })) });
    }

    case 'inkling_get_script': {
      const { data } = await sync.pull();
      needBackup(data);
      return ok(resolveBy(data.scripts || [], args.script, 'script'));
    }

    case 'inkling_create_script': {
      if (!str(args.name).trim()) return fail('name is required');
      let script;
      const res = await sync.mutate(d => {
        assertPayloadShape(d);
        d.scripts = d.scripts || [];
        if (d.scripts.some(s => lc(s.name) === lc(args.name))) return { abort: `A script named "${args.name}" already exists.` };
        const ids = (args.characters || []).map(ref => resolveCharacter(d.characters, ref).id);
        script = { id: genId(), name: str(args.name).trim(), description: str(args.description), type: 'lorebook',
          enabled: true, global: ids.length === 0, charIds: ids, entries: [] };
        d.scripts.push(script);
      });
      if (res.aborted) return fail(res.message);
      return ok({ created: script, revision: res.revision });
    }

    case 'inkling_add_script_entry': {
      const keywords = arr(args.keywords);
      if (!str(args.name).trim() || !keywords.length || !str(args.content).trim()) return fail('name, keywords and content are all required.');
      const prob = args.probability === undefined ? 100 : Math.min(Math.max(Number(args.probability) || 0, 0), 100);
      // Defaults match ScriptEntryEditor's initial state.
      const entry = { id: genId(), probability: prob, minMessages: 0, depth: 8, order: 5, group: '', groupWeight: 100, enabled: true,
        name: str(args.name).trim(), keywords, content: str(args.content) };
      let scriptName;
      const res = await sync.mutate(d => {
        assertPayloadShape(d);
        const s = resolveBy(d.scripts || [], args.script, 'script');
        if ((s.type || 'lorebook') !== 'lorebook') return { abort: `"${s.name}" is an Advanced (JS) script and has no entries.` };
        (s.entries = s.entries || []).push(entry);
        scriptName = s.name;
      });
      if (res.aborted) return fail(res.message);
      return ok({ added: { id: entry.id, name: entry.name, script: scriptName }, revision: res.revision });
    }

    default:
      return undefined;
  }
}
