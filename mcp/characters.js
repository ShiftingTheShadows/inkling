// Character record helpers. Field list mirrors CharEditorModal's form in
// src/hmm-modals.jsx — anything outside it is dropped rather than written
// through, so a typo'd field can't quietly bloat every future backup.

export const CHAR_FIELDS = [
  'name', 'description', 'personality', 'scenario',
  'firstMessage', 'exampleDialogues', 'systemPrompt',
  'tags', 'avatar', 'alternateGreetings',
];

// Matches genId() in src/hmm-utils.jsx
export const genId = () => Math.random().toString(36).slice(2, 9) + Date.now().toString(36);

const asArray = v => (Array.isArray(v) ? v : typeof v === 'string' && v.trim() ? v.split(',').map(s => s.trim()).filter(Boolean) : []);

export function normalizeInput(input = {}) {
  const out = {};
  for (const k of CHAR_FIELDS) {
    if (input[k] === undefined) continue;
    if (k === 'tags' || k === 'alternateGreetings') out[k] = asArray(input[k]);
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
export function summarize(char, data = {}) {
  return {
    id: char.id,
    name: char.name,
    tags: char.tags || [],
    isGroup: !!char.isGroup,
    hasAvatar: !!char.avatar,
    descriptionPreview: (char.description || '').slice(0, 120),
    messages: (data.chats?.[char.id] || []).length,
    updatedAt: char.updatedAt,
  };
}

export function detail(char, { includeAvatar = false } = {}) {
  const out = { ...char };
  if (!includeAvatar) {
    out.avatar = char.avatar ? `[${Math.round(char.avatar.length / 1024)}KB data URI omitted - pass include_avatar:true]` : '';
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
