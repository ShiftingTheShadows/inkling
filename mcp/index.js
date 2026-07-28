#!/usr/bin/env node
// Inkling MCP server — create and edit characters from a Claude conversation.
//
// Inkling keeps its data in browser IndexedDB, which nothing outside the tab
// can reach. The bridge is the Railway sync backend (server/index.js): this
// server reads the backup blob, edits the characters array, and writes it
// back. The open Inkling tab polls every 60s, sees the newer revision, pulls
// and reloads — so changes show up on their own within about a minute.
//
// Config, in priority order:
//   1. env INKLING_SYNC_URL / INKLING_SYNC_TOKEN
//   2. ~/.inkling-mcp.json  ->  { "url": "...", "token": "..." }
// The file exists so the token lives in exactly one place instead of being
// copied into every MCP client's config (Claude Code, Claude Desktop, ...).

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { SyncClient, assertPayloadShape } from './sync.js';
import { buildCharacter, normalizeInput, summarize, detail, resolveCharacter } from './characters.js';

export const CONFIG_PATH = path.join(os.homedir(), '.inkling-mcp.json');

function loadConfig() {
  let url = process.env.INKLING_SYNC_URL;
  let token = process.env.INKLING_SYNC_TOKEN;

  if ((!url || !token) && fs.existsSync(CONFIG_PATH)) {
    let file;
    try {
      file = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    } catch (e) {
      throw new Error(`${CONFIG_PATH} is not valid JSON: ${e.message}`);
    }
    url = url || file.url;
    token = token || file.token;
  }

  const placeholder = v => !v || /^(PASTE|YOUR|<)/i.test(String(v).trim());
  if (placeholder(url) || placeholder(token)) {
    throw new Error(
      `Inkling sync is not configured yet.\n` +
      `Edit ${CONFIG_PATH} and fill in:\n` +
      `  { "url": "https://your-app.up.railway.app", "token": "your-sync-token" }\n` +
      `Both values are in the app under Settings > Sync > Railway.`
    );
  }
  return { url, token };
}

let sync = null;
let configError = null;
try {
  const cfg = loadConfig();
  sync = new SyncClient(cfg);
} catch (e) {
  // Start anyway so the tools can report the problem in-chat. Exiting here
  // just shows up as an opaque "server failed to start" in the client.
  configError = e.message;
}

const TOOLS = [
  {
    name: 'inkling_status',
    description: 'Check the connection to the Inkling sync backend and report how many characters, personas and scripts are stored. Use this first if anything else fails.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'inkling_list_characters',
    description: 'List every character (bot) with id, name, tags and message count. Avatars are never included. Use before editing so you can reference a character precisely.',
    inputSchema: {
      type: 'object',
      properties: {
        search: { type: 'string', description: 'Optional filter matched against name, tags and description.' },
      },
    },
  },
  {
    name: 'inkling_get_character',
    description: 'Read one character in full: description, personality, scenario, first message, example dialogues, system prompt, alternate greetings.',
    inputSchema: {
      type: 'object',
      properties: {
        character: { type: 'string', description: 'Character id or name.' },
        include_avatar: { type: 'boolean', description: 'Include the raw avatar data URI. Off by default because it is large.' },
      },
      required: ['character'],
    },
  },
  {
    name: 'inkling_create_character',
    description: 'Create a new character (bot). Only name and first_message are required; fill in the rest for a richer bot.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Display name.' },
        first_message: { type: 'string', description: "The character's opening message. Required - without it the chat opens empty." },
        description: { type: 'string', description: 'Who they are, appearance, background.' },
        personality: { type: 'string', description: 'Traits, manner, voice.' },
        scenario: { type: 'string', description: 'The situation the chat opens in.' },
        example_dialogues: { type: 'string', description: 'Sample exchanges that demonstrate their voice.' },
        system_prompt: { type: 'string', description: 'Extra instructions injected for this character only.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Tags for filtering in the sidebar.' },
        alternate_greetings: { type: 'array', items: { type: 'string' }, description: 'Additional opening messages you can swipe between.' },
        avatar: { type: 'string', description: 'Optional image URL or data URI.' },
      },
      required: ['name', 'first_message'],
    },
  },
  {
    name: 'inkling_update_character',
    description: 'Edit fields on an existing character. Only the fields you pass change; everything else is left alone.',
    inputSchema: {
      type: 'object',
      properties: {
        character: { type: 'string', description: 'Character id or name.' },
        name: { type: 'string' },
        first_message: { type: 'string' },
        description: { type: 'string' },
        personality: { type: 'string' },
        scenario: { type: 'string' },
        example_dialogues: { type: 'string' },
        system_prompt: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        alternate_greetings: { type: 'array', items: { type: 'string' } },
        avatar: { type: 'string' },
      },
      required: ['character'],
    },
  },
  {
    name: 'inkling_delete_character',
    description: 'Permanently delete a character AND its entire chat history. Destructive and not undoable - always confirm with the user first, then pass confirm:true.',
    inputSchema: {
      type: 'object',
      properties: {
        character: { type: 'string', description: 'Character id or name.' },
        confirm: { type: 'boolean', description: 'Must be true. Guards against accidental deletion.' },
      },
      required: ['character', 'confirm'],
    },
  },
];

// snake_case tool args → camelCase record fields
const ARG_MAP = {
  first_message: 'firstMessage',
  example_dialogues: 'exampleDialogues',
  system_prompt: 'systemPrompt',
  alternate_greetings: 'alternateGreetings',
};
const toFields = args => {
  const out = {};
  for (const [k, v] of Object.entries(args || {})) {
    if (k === 'character' || k === 'confirm' || k === 'include_avatar' || k === 'search') continue;
    out[ARG_MAP[k] || k] = v;
  }
  return out;
};

const ok = payload => ({ content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] });
const fail = message => ({ content: [{ type: 'text', text: `Error: ${message}` }], isError: true });

async function handle(name, args) {
  if (configError) return fail(configError);
  switch (name) {
    case 'inkling_status': {
      const { data, revision, updatedAt } = await sync.pull();
      if (!data) return ok({ connected: true, backup: null, note: 'No backup yet. Open Inkling and let it sync once.' });
      return ok({
        connected: true,
        url: sync.url,
        revision,
        lastSync: updatedAt,
        characters: (data.characters || []).length,
        personas: (data.personas || []).length,
        scripts: (data.scripts || []).length,
        totalMessages: Object.values(data.chats || {}).reduce((n, c) => n + (c?.length || 0), 0),
      });
    }

    case 'inkling_list_characters': {
      const { data } = await sync.pull();
      if (!data) return fail('No backup found yet. Open Inkling and let it sync once first.');
      let chars = data.characters || [];
      const q = (args.search || '').toLowerCase().trim();
      if (q) {
        chars = chars.filter(c =>
          (c.name || '').toLowerCase().includes(q) ||
          (c.description || '').toLowerCase().includes(q) ||
          (c.tags || []).some(t => String(t).toLowerCase().includes(q)));
      }
      return ok({ count: chars.length, characters: chars.map(c => summarize(c, data)) });
    }

    case 'inkling_get_character': {
      const { data } = await sync.pull();
      if (!data) return fail('No backup found yet. Open Inkling and let it sync once first.');
      const char = resolveCharacter(data.characters || [], args.character);
      return ok(detail(char, { includeAvatar: !!args.include_avatar }));
    }

    case 'inkling_create_character': {
      const char = buildCharacter(toFields(args));
      const res = await sync.mutate(draft => {
        assertPayloadShape(draft);
        if ((draft.characters || []).some(c => (c.name || '').toLowerCase() === char.name.toLowerCase())) {
          return { abort: `A character named "${char.name}" already exists. Pick a different name, or use inkling_update_character to edit it.` };
        }
        draft.characters.push(char);
        draft.chats = draft.chats || {};
        draft.histories = draft.histories || {};
        draft.chats[char.id] = [];
        draft.histories[char.id] = [];
      });
      if (res.aborted) return fail(res.message);
      return ok({ created: summarize(char), revision: res.revision, note: 'Inkling will pick this up within ~60s, or hit Sync now in Settings.' });
    }

    case 'inkling_update_character': {
      const patch = normalizeInput(toFields(args));
      if (!Object.keys(patch).length) return fail('No fields to update were provided.');
      let updated = null;
      const res = await sync.mutate(draft => {
        assertPayloadShape(draft);
        const char = resolveCharacter(draft.characters, args.character);
        // Renaming onto another character's name would make both unaddressable
        if (patch.name && patch.name.toLowerCase() !== (char.name || '').toLowerCase()
            && draft.characters.some(c => c.id !== char.id && (c.name || '').toLowerCase() === patch.name.toLowerCase())) {
          return { abort: `Another character is already named "${patch.name}".` };
        }
        Object.assign(char, patch, { updatedAt: new Date().toISOString() });
        updated = char;
      });
      if (res.aborted) return fail(res.message);
      return ok({ updated: summarize(updated), changed: Object.keys(patch), revision: res.revision });
    }

    case 'inkling_delete_character': {
      if (args.confirm !== true) return fail('Refusing to delete without confirm:true. Ask the user first - this also deletes the entire chat history.');
      let removed = null;
      const res = await sync.mutate(draft => {
        assertPayloadShape(draft);
        const char = resolveCharacter(draft.characters, args.character);
        removed = summarize(char, draft);
        draft.characters = draft.characters.filter(c => c.id !== char.id);
        delete draft.chats?.[char.id];
        delete draft.histories?.[char.id];
      });
      if (res.aborted) return fail(res.message);
      return ok({ deleted: removed, revision: res.revision });
    }

    default:
      return fail(`Unknown tool: ${name}`);
  }
}

const server = new Server({ name: 'inkling', version: '0.1.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
server.setRequestHandler(CallToolRequestSchema, async req => {
  try {
    return await handle(req.params.name, req.params.arguments || {});
  } catch (e) {
    return fail(e.message);
  }
});

await server.connect(new StdioServerTransport());
console.error('inkling-mcp ready');
