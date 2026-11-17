// Character record helpers. Field list mirrors CharEditorModal's form in
// src/hmm-modals.jsx — anything outside it is dropped rather than written
// through, so a typo'd field can't quietly bloat every future backup.

export const CHAR_FIELDS = [
  'name', 'description', 'personality', 'scenario',
  'firstMessage', 'exampleDialogues', 'systemPrompt',
  'tags', 'avatar', 'alternateGreetings',
  'textboxStyle', 'blipPitch', 'blipSound', 'blipVolume', 'defaultExpression',
];

// Matches genId() in src/hmm-utils.jsx
export const genId = () => Math.random().toString(36).slice(2, 9) + Date.now().toString(36);

const asArray = v => (Array.isArray(v) ? v : typeof v === 'string' && v.trim() ? v.split(',').map(s => s.trim()).filter(Boolean) : []);

export function normalizeInput(input = {}) {
  const out = {};
  for (const k of CHAR_FIELDS) {
    if (input[k] === undefined) continue;
    if (k === 'tags' || k === 'alternateGreetings') out[k] = asArray(input[k]);
    else if (k === 'blipPitch' || k === 'blipVolume') out[k] = input[k] === null ? null : Number(input[k]);
    else if (k === 'blipSound') out[k] = input[k] === null ? null : !!input[k];
    else out[k] = String(input[k] ?? '');
  }
  return out;
}

export function buildCharacter(input) {
  const fields = normalizeInput(input);
  if (!fields.name?.trim()) throw new Error('name is required');
  if (!fields.firstMessage?.trim()) {
    // The app enforces this in the editor; a character without a greeting
    // opens to an empty chat and looks broken.
    throw new Error('firstMessage is required - it is the character\'s opening message');
  }
  const now = new Date().toISOString();
  return {
    id: genId(),
    name: '', description: '', personality: '', scenario: '',
    firstMessage: '', exampleDialogues: '', systemPrompt: '',
    tags: [], avatar: '', alternateGreetings: [],
    ...fields,
    createdAt: now,
    updatedAt: now,
  };
}

// Avatars are base64 data URIs and can be hundreds of KB. Never return them
// in a listing, and only on request for a single character.
// E32: SillyTavern-compatible chara_card_v2, so a character can move between
// installs without a browser round-trip.
export function charaCardV2(char) {
  return {
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
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

export function summarize(char, data = {}) {
  return {
    id: char.id,
    name: char.name,
    tags: char.tags || [],
    isGroup: !!char.isGroup,
    hasAvatar: !!char.avatar,
    expressionCount: Object.keys(char.expressions || {}).length,
    descriptionPreview: (char.description || '').slice(0, 120),
    messages: (data.chats?.[char.id] || []).length,
    updatedAt: char.updatedAt,
  };
}

// E33: `fields` on inkling_get_character. A full record carries every long
// prose field plus a sprite summary, so asking for two of them keeps the
// caller's context small. Identity (id + name) always comes back so the answer
// still says who it is, and an unknown name is an error listing what exists
// rather than a silently missing key.
const FIELD_ALIASES = {
  first_message: 'firstMessage',
  example_dialogues: 'exampleDialogues',
  system_prompt: 'systemPrompt',
  alternate_greetings: 'alternateGreetings',
  textbox_style: 'textboxStyle',
  blip_sound: 'blipSound',
  blip_volume: 'blipVolume',
  default_expression: 'defaultExpression',
  created_at: 'createdAt',
  updated_at: 'updatedAt',
  folder_id: 'folderId',
  is_group: 'isGroup',
  group_replies: 'groupReplies',
};

export function pickCharacterFields(detail, fields) {
  const list = Array.isArray(fields) ? fields : typeof fields === 'string' ? fields.split(',') : [];
  const names = list.map(v => String(v).trim()).filter(Boolean);
  if (!names.length) throw new Error('fields must be a non-empty array of character field names.');
  const out = { id: detail.id, name: detail.name };
  for (const raw of names) {
    const key = FIELD_ALIASES[raw] || FIELD_ALIASES[raw.toLowerCase()] || raw;
    if (key === 'id' || key === 'name') continue;
    if (!(key in detail)) {
      throw new Error(`Unknown character field "${raw}". Valid fields: ${Object.keys(detail).sort().join(', ')}`);
    }
    out[key] = detail[key] ?? null;
  }
  return out;
}

export function detail(char, { includeAvatar = false } = {}) {
  const out = { ...char };
  if (!includeAvatar) {
    out.avatar = char.avatar ? `[${Math.round(char.avatar.length / 1024)}KB data URI omitted - pass include_avatar:true]` : '';
  }
  // Expression sprites are base64 data URIs, same blow-up risk as avatar —
  // an Undertale/Deltarune character can carry dozens of them. Always
  // summarize rather than dump: unlike the avatar there's no legitimate
  // single-character use case for pulling the raw pixel data through the
  // agent's context.
  if (char.expressions && Object.keys(char.expressions).length) {
    out.expressions = { count: Object.keys(char.expressions).length, names: Object.keys(char.expressions) };
  }
  return out;
}

// Accepts an id or a name (case-insensitive). Names are what a chat actually
// refers to, but they aren't unique, so an ambiguous name is an error rather
// than a guess at which bot you meant.
export function resolveCharacter(characters, ref) {
  const needle = String(ref || '').trim();
  if (!needle) throw new Error('character reference is empty');

  const byId = characters.find(c => c.id === needle);
  if (byId) return byId;

  const byName = characters.filter(c => (c.name || '').toLowerCase() === needle.toLowerCase());
  if (byName.length === 1) return byName[0];
  if (byName.length > 1) {
    throw new Error(`"${needle}" matches ${byName.length} characters. Use an id instead: ${byName.map(c => c.id).join(', ')}`);
  }

  const partial = characters.filter(c => (c.name || '').toLowerCase().includes(needle.toLowerCase()));
  if (partial.length === 1) return partial[0];
  if (partial.length > 1) {
    throw new Error(`"${needle}" is ambiguous: ${partial.map(c => `${c.name} (${c.id})`).join(', ')}`);
  }
  throw new Error(`No character matches "${needle}"`);
}
