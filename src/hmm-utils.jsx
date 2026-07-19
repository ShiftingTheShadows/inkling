// hmm-utils.jsx — Storage, utilities, AI, Context
const { createContext } = React;

const AppCtx = createContext(null);

// ── Storage — IndexedDB-backed with in-memory cache ─────────────
// Fixes the localStorage QuotaExceededError: base64 avatars + chat
// images blow past the ~5MB localStorage cap. IndexedDB holds
// hundreds of MB. All reads hit an in-memory Map (synchronous),
// writes go to the Map immediately and to IDB asynchronously.
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
function __idbPut(key, val) {
  if (!__db) {
    // Fallback: best-effort localStorage (may hit quota, but don't crash)
    try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) { console.warn('Storage write failed:', key, e); }
    return;
  }
  try {
    const tx = __db.transaction('kv', 'readwrite');
    tx.objectStore('kv').put(val, key);
    tx.onerror = () => console.warn('IDB write failed:', key, tx.error);
  } catch (e) { console.warn('IDB write failed:', key, e); }
}
function __idbDel(key) {
  if (!__db) { try { localStorage.removeItem(key); } catch {} return; }
  try { __db.transaction('kv', 'readwrite').objectStore('kv').delete(key); } catch {}
}
const __get = (k, fb) => __mem.has(k) ? __mem.get(k) : fb;
// Drafts are intentionally excluded, they're not part of GistSync.buildPayload(),
// so writing them shouldn't schedule an auto-sync push (see hmm-app.jsx).
const __notifyDataChange = k => { if (!k.startsWith('hmm_draft_') && window.__hmmOnDataChange) window.__hmmOnDataChange(); };
const __set = (k, v) => { __mem.set(k, v); __idbPut(k, v); __notifyDataChange(k); };

// Boot: open IDB, hydrate cache, one-time migration from localStorage
window.InklingStorageReady = (async () => {
  try {
    __db = await __idbOpen();
    await new Promise((res, rej) => {
      const req = __db.transaction('kv', 'readonly').objectStore('kv').openCursor();
      req.onsuccess = () => {
        const cur = req.result;
        if (cur) { __mem.set(cur.key, cur.value); cur.continue(); } else res();
      };
      req.onerror = () => rej(req.error);
    });
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
          __mem.set(k, v); __idbPut(k, v);
        } catch (e) { console.warn('Migration skipped corrupt key:', k); }
      }
    });
    legacy.forEach(k => { try { localStorage.removeItem(k); } catch {} });
    if (legacy.length) console.info(`Inkling: migrated ${legacy.length} record(s) from localStorage → IndexedDB`);
  } catch (e) {
    console.error('IndexedDB unavailable — falling back to localStorage:', e);
    __db = null;
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (/^hmm_(chars$|chat_|hist_|lorebook$|settings$|personas$)/.test(k)) {
        try { __mem.set(k, JSON.parse(localStorage.getItem(k))); } catch {}
      }
    }
  }
})();

const S = {
  chars: () => __get('hmm_chars', []),
  saveChars: v => __set('hmm_chars', v),
  chat: id => __get(`hmm_chat_${id}`, []),
  saveChat: (id, v) => __set(`hmm_chat_${id}`, v),
  history: id => __get(`hmm_hist_${id}`, []),
  saveHistory: (id, v) => __set(`hmm_hist_${id}`, v),
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
    __mem.delete(`hmm_chat_${id}`); __mem.delete(`hmm_hist_${id}`); __mem.delete(`hmm_draft_${id}`);
    __idbDel(`hmm_chat_${id}`); __idbDel(`hmm_hist_${id}`); __idbDel(`hmm_draft_${id}`);
  },
  clearAll: () => new Promise(res => {
    __mem.clear();
    if (!__db) return res();
    try {
      const tx = __db.transaction('kv', 'readwrite');
      tx.objectStore('kv').clear();
      tx.oncomplete = tx.onerror = () => res();
    } catch { res(); }
  }),
  settings: () => {
    const saved = { ...__get('hmm_settings', {}) };
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
      autoScroll: true,
      showTokens: true,
      theme: 'terminal',
      avatarScale: 1, // 0.4 (tiny) – 2.5 (huge)
      provider: 'claude', // 'claude' | 'openrouter' | 'local'
      openrouterKey: '',
      openrouterModel: 'anthropic/claude-sonnet-5',
      localEndpoint: '',
      localApiKey: '',
      localModel: 'llama3',
      ...saved,
    };
  },
  saveSettings: v => __set('hmm_settings', v),
  personas: () => __get('hmm_personas', null) || [{ id: 'default', name: 'You', description: '', avatar: '' }],
  savePersonas: v => __set('hmm_personas', v),
  activePersonaId: () => localStorage.getItem('hmm_active_persona') || 'default',
  setActivePersonaId: id => { localStorage.setItem('hmm_active_persona', id); __notifyDataChange('hmm_active_persona'); },
  lastSeenChangelog: () => localStorage.getItem('hmm_changelog_seen') || '',
  setLastSeenChangelog: v => localStorage.setItem('hmm_changelog_seen', v),
};

// Changelog: newest entry first. Bump the top `version` (a date works
// fine) whenever entries are added so returning users get an auto-popup.
const CHANGELOG = [
  {
    version: '2026-07-19',
    date: 'Jul 19, 2026',
    items: [
      'New: "What\'s New" changelog, opens automatically after an update, or any time from the command palette.',
      'New: Drag-and-drop or pick an image on a greeting to auto-upload it to Catbox and embed it, no more manual upload-then-paste.',
      'New: Paste raw JSON directly into the character editor instead of only importing from a file.',
      'New: Custom chat background image (animated GIFs supported) and custom CSS injection, in Settings → Theme.',
      'New: The message box now remembers your draft per-character across refreshes and character switches, and can be manually resized.',
      'New: Railway sync, an alternative to GitHub Gist sync backed by your own Postgres database (Settings → Sync → Railway tab). See server/README.md to deploy it.',
      'New: Railway auto-sync, pushes a few seconds after any change and pulls automatically when another device has pushed something newer.',
      'Fixed: group chat messages from different characters replying back-to-back no longer hide each other\'s avatar/name.',
      'Fixed: a restored draft now resizes the message box to fit instead of staying cramped at minimum height.',
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
// Uploads an image to Catbox and returns its public URL, used to auto-embed
// images in greetings instead of a manual upload-then-paste-the-link workflow.
async function uploadToCatbox(file) {
  const fd = new FormData();
  fd.append('reqtype', 'fileupload');
  fd.append('fileToUpload', file);
  const res = await fetch('https://catbox.moe/user/api.php', { method: 'POST', body: fd });
  if (!res.ok) throw new Error(`Catbox upload failed (${res.status})`);
  const text = (await res.text()).trim();
  if (!/^https?:\/\//.test(text)) throw new Error(text || 'Unexpected response from Catbox');
  return text;
}

const estimateTokens = text => Math.ceil((text || '').length / 4);
const formatTime = ts => ts ? new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
const formatDate = ts => {
  if (!ts) return '';
  const d = new Date(ts), now = new Date(), diff = now - d;
  if (diff < 86400000) return formatTime(ts);
  if (diff < 604800000) return d.toLocaleDateString([], { weekday: 'short' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
};

function renderMarkdown(text) {
  if (!text) return '';
  const esc = text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  let html = esc
    .replace(/```([\s\S]*?)```/g, (_, c) => `<pre><code>${c.trim()}</code></pre>`)
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*\n<>]+)\*/g, '<em class="rp-action">$1</em>')
    .replace(/_([^_\n<>]+)_/g, '<em>$1</em>');

  // ── Embeds & links ──────────────────────────────────────────────
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

  return html.replace(/\n/g, '<br>');
}

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

  // ── External provider (OpenRouter / Local / Custom OpenAI-compatible) ──
  const useExternal = resolvedSettings?.provider && resolvedSettings.provider !== 'claude';
  let endpoint = '';
  if (useExternal) {
    if (resolvedSettings.provider === 'openrouter') {
      endpoint = 'https://openrouter.ai/api';
    } else {
      endpoint = resolvedSettings?.localEndpoint?.trim() || '';
    }
  }
  if (endpoint) {
    try {
      const base = endpoint.replace(/\/+$/, '').replace(/\/v1$/, '');
      const url = base + '/v1/chat/completions';
      let model = resolvedSettings.localModel || (resolvedSettings.provider === 'openrouter' ? 'anthropic/claude-sonnet-5' : 'llama3');
      // Web search: OpenRouter supports the :online suffix for live web access
      if (resolvedSettings.webSearch && resolvedSettings.provider === 'openrouter' && !/:online$/.test(model)) {
        model += ':online';
      }
      const apiKey = resolvedSettings.localApiKey;
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
      };
      if (structured) body.response_format = { type: 'json_object' };
      const headers = { 'Content-Type': 'application/json' };
      if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
      if (resolvedSettings.provider === 'openrouter') {
        headers['HTTP-Referer'] = window.location.origin || 'https://inkling.local';
        headers['X-Title'] = 'Inkling Roleplay';
      }

      let resp = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: opts.signal });
      // Some models/endpoints reject response_format — retry once without it
      if (!resp.ok && body.response_format && resp.status >= 400 && resp.status < 500) {
        delete body.response_format;
        resp = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: opts.signal });
      }
      if (!resp.ok) {
        const errTxt = await resp.text().catch(() => '');
        throw new Error(`${resp.status} ${resp.statusText} ${errTxt.slice(0, 200)}`);
      }

      if (onChunk) {
        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let partial = '';
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
                const j = JSON.parse(trimmed);
                const delta = j.choices?.[0]?.delta?.content;
                if (delta) { partial += delta; onChunk(partial, false); }
              } catch {}
            }
          }
        } catch (err) {
          // User pressed stop mid-stream — keep what was generated so far
          if (err.name !== 'AbortError') throw err;
        }
        onChunk(partial, true);
        return partial;
      } else {
        const j = await resp.json();
        result = j.choices?.[0]?.message?.content || '';
      }
    } catch(e) {
      if (e.name === 'AbortError') { if (onChunk) onChunk('', true); return ''; }
      const providerName = resolvedSettings.provider === 'openrouter' ? 'OpenRouter' : resolvedSettings.provider === 'local' ? 'Local model' : 'Custom endpoint';
      result = `*${providerName} error: ${e.message}*\n\nCheck your endpoint URL, API key, and model ID in Settings.`;
    }
    if (onChunk && result) onChunk(result, true);
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

      const resp = await fetch('/api/anthropic', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: opts.signal,
        body: JSON.stringify({
          apiKey: resolvedSettings.apiKey,
          model: resolvedSettings.model || 'claude-haiku-4-5',
          system,
          messages: anthMsgs,
          maxTokens: structured ? Math.max(4096, resolvedSettings.maxTokens || 1024) : (resolvedSettings.maxTokens || 1024),
          temperature: resolvedSettings.temperature,
          stream: !!onChunk,
        }),
      });

      if (resp.ok) {
        if (onChunk) {
          const reader = resp.body.getReader();
          const decoder = new TextDecoder();
          let partial = '';
          let buffer = '';
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
                  if (j.type === 'content_block_delta' && j.delta?.type === 'text_delta') {
                    partial += j.delta.text;
                    onChunk(partial, false);
                  }
                } catch {}
              }
            }
          } catch (err) {
            // User pressed stop mid-stream — keep what was generated so far
            if (err.name !== 'AbortError') throw err;
          }
          onChunk(partial, true);
          return partial;
        }
        const j = await resp.json();
        result = (j.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
        if (j.stop_reason === 'refusal' && !result) {
          result = '*The model declined this request (safety refusal). Try rephrasing, or switch provider in Settings.*';
        }
      } else if (resp.status !== 404) {
        const errTxt = await resp.text().catch(() => '');
        result = `*Anthropic error: ${resp.status} ${errTxt.slice(0, 200)}*\n\nCheck your API key and model in Settings.`;
      }
      // 404 → functions not deployed here; fall through to the shim below
    } catch (e) {
      if (e.name === 'AbortError') { if (onChunk) onChunk('', true); return ''; }
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

// ── Context summarizer ────────────────────────────────────────────
async function summarizeMessages(messages, char, settings) {
  if (messages.length < 6) return null;
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

// ── GitHub Gist Sync ─────────────────────────────────────────────
const GistSync = {
  FILENAME: 'hmm-data.json',
  headers(token) {
    return { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', 'Accept': 'application/vnd.github+json' };
  },
  buildPayload() {
    const chars = S.chars();
    const chats = {}, histories = {};
    chars.forEach(c => { chats[c.id] = S.chat(c.id); histories[c.id] = S.history(c.id); });
    // Strip all secrets — never sync API keys to a gist (they get auto-disabled if detected)
    const { apiKey, openrouterKey, localApiKey, globalPrompt, ...safeSettings } = S.settings();
    return {
      version: 2,
      exportedAt: new Date().toISOString(),
      settings: safeSettings,
      personas: S.personas(),
      activePersonaId: S.activePersonaId(),
      characters: chars,
      chats,
      histories,
      lorebook: S.lorebook(),
      scripts: S.scripts(),
    };
  },
  restorePayload(data) {
    if (data.settings) {
      // Preserve local secrets — restore everything else from gist
      const current = S.settings();
      S.saveSettings({
        ...data.settings,
        apiKey: current.apiKey,
        openrouterKey: current.openrouterKey,
        localApiKey: current.localApiKey,
        globalPrompt: current.globalPrompt,
      });
    }
    if (data.personas)        S.savePersonas(data.personas);
    if (data.activePersonaId) S.setActivePersonaId(data.activePersonaId);
    if (data.lorebook)        S.saveLorebook(data.lorebook);
    if (data.scripts)         S.saveScripts(data.scripts);
    if (Array.isArray(data.characters)) {
      S.saveChars(data.characters);
      data.characters.forEach(c => {
        if (data.chats?.[c.id])     S.saveChat(c.id, data.chats[c.id]);
        if (data.histories?.[c.id]) S.saveHistory(c.id, data.histories[c.id]);
      });
    }
  },
  async push(token, gistId) {
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

// Railway sync: a self-hosted alternative to Gist sync (see server/).
// Same payload shape (GistSync.buildPayload/restorePayload), just pushed to
// your own Postgres-backed endpoint instead of a GitHub gist.
const RailwaySync = {
  async push(baseUrl, token) {
    const payload = GistSync.buildPayload();
    const content = JSON.stringify(payload);
    try { JSON.parse(content); } catch (e) { throw new Error('Local data is corrupted, cannot push: ' + e.message); }
    const r = await fetch(`${baseUrl.replace(/\/+$/, '')}/api/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, data: payload }),
    });
    if (!r.ok) throw new Error(`Sync server ${r.status}: ${(await r.text().catch(() => '')) || r.statusText}`);
    // The server's own updated_at, not payload.exportedAt: auto-sync compares
    // this against GET /api/sync/meta's updatedAt, which is server-clocked too.
    return (await r.json()).updatedAt;
  },
  async pull(baseUrl, token) {
    const r = await fetch(`${baseUrl.replace(/\/+$/, '')}/api/sync?token=${encodeURIComponent(token)}`);
    if (!r.ok) throw new Error(`Sync server ${r.status}: ${(await r.text().catch(() => '')) || r.statusText}`);
    const j = await r.json();
    if (!j.data) throw new Error('No backup found for this token yet, push from another device first.');
    return j.data;
  },
  // Lightweight poll for auto-sync, just the remote's last-updated timestamp
  async meta(baseUrl, token) {
    const r = await fetch(`${baseUrl.replace(/\/+$/, '')}/api/sync/meta?token=${encodeURIComponent(token)}`);
    if (!r.ok) throw new Error(`Sync server ${r.status}: ${(await r.text().catch(() => '')) || r.statusText}`);
    return (await r.json()).updatedAt;
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
  AppCtx, S, genId, estimateTokens, compressImage, uploadToCatbox, CHANGELOG,
  formatTime, formatDate, renderMarkdown,
  charBg, charFg, buildSystemPrompt, substituteMacros, callAI, avatarPx,
  summarizeMessages, GistSync, RailwaySync,
  downloadCharJson, downloadCharPng,
});
