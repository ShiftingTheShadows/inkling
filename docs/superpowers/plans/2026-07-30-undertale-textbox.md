# Undertale / Deltarune Textbox Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render a character's replies as Undertale/Deltarune dialogue boxes - pixel font, typewriter, per-character blip, portrait sprites, page-by-page advance, and clickable choices the AI offers.

**Architecture:** Pure parsing helpers live in `src/hmm-utils.jsx` next to `renderMarkdown`. A self-contained `<Textbox>` component lives in a new `src/hmm-textbox.jsx` so the later fullscreen "present mode" can reuse it unchanged. `hmm-chat.jsx` only picks a renderer and handles choice-to-send. The default rendering path is untouched when a character has no textbox style.

**Tech Stack:** React 18 via window globals (no JSX build in dev - Babel standalone), esbuild for `dist/`, plain CSS in `index.html`, WebAudio for blips, Node's built-in runner for unit tests, Playwright for browser tests.

**Spec:** `docs/superpowers/specs/2026-07-30-undertale-textbox-design.md`

## Global Constraints

- **No build step in dev.** `index.html` loads `src/*.jsx` via `type="text/babel"`. Every new file must be added to both `index.html` and the `files` array in `build.mjs`.
- **Window globals, not modules.** Each `src/*.jsx` ends with `Object.assign(window, {...})` and starts with `const { ... } = window`. esbuild wraps each file in an IIFE, so top-level `const` names would otherwise collide.
- **No new runtime dependencies.** Nothing may be added to the root `package.json` dependencies.
- **Storage keys stay `hmm_*`.** Renaming them breaks existing users' saved data.
- **Sprites and audio are never committed to the repo.** Sprites live in per-character synced data; blips are synthesized.
- **Sound defaults off.** `textboxSpeed` default `30` cps.
- **Box is 3 lines per page**, line width clamped to a 46 character maximum.
- **`reduceMotion` and `prefers-reduced-motion` both render instantly with no audio.**
- Commit messages: `feat:` / `fix:` / `test:` / `docs:` prefix, and end with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.

---

### Task 1: Unit test harness

The repo has no test runner for frontend code. `hmm-utils.jsx` is a window-global JSX file that Node cannot import, so tests slice a marked region out of it and evaluate that.

**Files:**
- Create: `test/harness.js`
- Create: `test/textbox.test.js`
- Modify: `package.json`
- Modify: `src/hmm-utils.jsx` (add region markers)

**Interfaces:**
- Produces: `loadTextboxModule()` returning every function defined between the markers.

- [ ] **Step 1: Add region markers to `src/hmm-utils.jsx`**

Immediately after the `renderMarkdown` function's closing brace, add:

```js
// ── Textbox parsing ──────────────────────────────────────────────
// Everything between the TEXTBOX-EXPORTS markers is pure and gets sliced out
// by test/harness.js to run under Node. Keep it free of React and DOM access.
/* TEXTBOX-EXPORTS-START */
/* TEXTBOX-EXPORTS-END */
```

- [ ] **Step 2: Write the harness**

Create `test/harness.js`:

```js
import fs from 'node:fs';

const SRC = new URL('../src/hmm-utils.jsx', import.meta.url);

export function loadTextboxModule() {
  const src = fs.readFileSync(SRC, 'utf8');
  const start = src.indexOf('/* TEXTBOX-EXPORTS-START */');
  const end = src.indexOf('/* TEXTBOX-EXPORTS-END */');
  if (start < 0 || end < 0) throw new Error('TEXTBOX-EXPORTS markers not found in hmm-utils.jsx');
  const body = src.slice(start, end);

  const names = [...body.matchAll(/^function\s+([A-Za-z_$][\w$]*)/gm)].map(m => m[1]);
  if (!names.length) throw new Error('no functions found between TEXTBOX-EXPORTS markers');

  return new Function(`${body}\nreturn { ${names.join(', ')} };`)();
}

export function makeRunner() {
  let pass = 0, fail = 0;
  const eq = (name, actual, expected) => {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a === e) { pass++; console.log(`ok   ${name}`); }
    else { fail++; console.log(`FAIL ${name}\n     expected: ${e}\n     actual:   ${a}`); }
  };
  const ok = (name, cond, extra) => {
    if (cond) { pass++; console.log(`ok   ${name}`); }
    else { fail++; console.log(`FAIL ${name}${extra ? '\n     ' + JSON.stringify(extra) : ''}`); }
  };
  const done = () => {
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  };
  return { eq, ok, done };
}
```

- [ ] **Step 3: Write a smoke test that fails**

Create `test/textbox.test.js`:

```js
import { loadTextboxModule, makeRunner } from './harness.js';

const M = loadTextboxModule();
const { eq, ok, done } = makeRunner();

ok('module exposes stripExpressionTags', typeof M.stripExpressionTags === 'function');

done();
```

- [ ] **Step 4: Add the test script**

In `package.json`, change the `scripts` block to:

```json
  "scripts": {
    "build": "node build.mjs",
    "test": "node test/textbox.test.js"
  },
```

- [ ] **Step 5: Run it to verify it fails**

Run: `npm test`
Expected: FAIL - `no functions found between TEXTBOX-EXPORTS markers`

- [ ] **Step 6: Commit**

```bash
git add test/harness.js test/textbox.test.js package.json src/hmm-utils.jsx
git commit -m "test: harness for textbox parsing

Frontend code is window-global JSX that Node cannot import, so the
harness slices a marked pure region out of hmm-utils.jsx.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Expression tag parsing

**Files:**
- Modify: `src/hmm-utils.jsx` (between the TEXTBOX-EXPORTS markers)
- Modify: `test/textbox.test.js`

**Interfaces:**
- Produces: `stripExpressionTags(text) -> { text, tags }` where `tags` is `[{ at: number, name: string }]` and `at` is an offset into the **returned** (stripped) text.

- [ ] **Step 1: Write the failing tests**

Replace the body of `test/textbox.test.js` (keep the imports and `done()`):

```js
eq('no tags leaves text alone',
  M.stripExpressionTags('Hello there.'),
  { text: 'Hello there.', tags: [] });

eq('single tag stripped, offset recorded',
  M.stripExpressionTags('\\E[Anxious]Hi.'),
  { text: 'Hi.', tags: [{ at: 0, name: 'Anxious' }] });

eq('offset is against the stripped text',
  M.stripExpressionTags('Hi. \\E[Grin]Bye.'),
  { text: 'Hi. Bye.', tags: [{ at: 4, name: 'Grin' }] });

eq('multiple tags accumulate correctly',
  M.stripExpressionTags('\\E[A]one \\E[B]two \\E[C]three'),
  { text: 'one two three', tags: [
    { at: 0, name: 'A' }, { at: 4, name: 'B' }, { at: 8, name: 'C' } ] });

eq('names may contain spaces and parentheses',
  M.stripExpressionTags('\\E[Grin (No Eyes)]hi'),
  { text: 'hi', tags: [{ at: 0, name: 'Grin (No Eyes)' }] });

eq('name is trimmed',
  M.stripExpressionTags('\\E[  Serious  ]x'),
  { text: 'x', tags: [{ at: 0, name: 'Serious' }] });

eq('empty tag is stripped and ignored',
  M.stripExpressionTags('a\\E[]b'),
  { text: 'ab', tags: [] });

eq('unclosed tag is left as literal text',
  M.stripExpressionTags('a\\E[oops'),
  { text: 'a\\E[oops', tags: [] });

eq('empty input', M.stripExpressionTags(''), { text: '', tags: [] });
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test`
Expected: FAIL - `M.stripExpressionTags is not a function`

- [ ] **Step 3: Implement**

Between the TEXTBOX-EXPORTS markers in `src/hmm-utils.jsx`:

```js
// Inline "\E[Name]" portrait tags. Names are bracketed because real sprite
// names contain spaces and parentheses ("Grin (No Eyes)"), and readable names
// prompt the model far better than opaque codes.
// Offsets are recorded against the STRIPPED text so they stay valid as the
// typewriter reveals characters.
function stripExpressionTags(raw) {
  const text = String(raw ?? '');
  const tags = [];
  let out = '';
  let i = 0;

  while (i < text.length) {
    const hit = text.indexOf('\\E[', i);
    if (hit === -1) { out += text.slice(i); break; }
    const close = text.indexOf(']', hit);
    // Unclosed tag: not a tag at all, keep it literal
    if (close === -1) { out += text.slice(i); break; }

    out += text.slice(i, hit);
    const name = text.slice(hit + 3, close).trim();
    if (name) tags.push({ at: out.length, name });
    i = close + 1;
  }

  return { text: out, tags };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test`
Expected: PASS, 9 passed 0 failed

- [ ] **Step 5: Commit**

```bash
git add src/hmm-utils.jsx test/textbox.test.js
git commit -m "feat: parse \\E[Name] expression tags

Offsets are recorded against the stripped text so the portrait can
change mid-page as the typewriter passes each tag.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Choices fence parsing

**Files:**
- Modify: `src/hmm-utils.jsx`
- Modify: `test/textbox.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `parseChoiceFence(text) -> { text, choices }` where `choices` is `string[]`.

- [ ] **Step 1: Write the failing tests**

Append to `test/textbox.test.js` before `done()`:

```js
eq('no fence',
  M.parseChoiceFence('Just talking.'),
  { text: 'Just talking.', choices: [] });

eq('basic fence',
  M.parseChoiceFence('Well?\n:::choices\nAsk\nLeave\n:::'),
  { text: 'Well?', choices: ['Ask', 'Leave'] });

eq('fence is case-insensitive',
  M.parseChoiceFence('x\n:::CHOICES\nA\n:::'),
  { text: 'x', choices: ['A'] });

eq('blank lines inside the fence are ignored',
  M.parseChoiceFence('x\n:::choices\nA\n\nB\n:::'),
  { text: 'x', choices: ['A', 'B'] });

eq('inline marks stripped from options',
  M.parseChoiceFence('x\n:::choices\n**Ask** the *thing*\n:::'),
  { text: 'x', choices: ['Ask the thing'] });

eq('last fence wins, earlier one stays literal',
  M.parseChoiceFence('a\n:::choices\nOLD\n:::\nb\n:::choices\nNEW\n:::'),
  { text: 'a\n:::choices\nOLD\n:::\nb', choices: ['NEW'] });

eq('empty fence is dropped entirely',
  M.parseChoiceFence('x\n:::choices\n:::'),
  { text: 'x', choices: [] });

ok('caps at 8 options',
  M.parseChoiceFence('x\n:::choices\n' + Array.from({length: 12}, (_, i) => `opt${i}`).join('\n') + '\n:::').choices.length === 8);

eq('unclosed fence stays literal',
  M.parseChoiceFence('x\n:::choices\nA'),
  { text: 'x\n:::choices\nA', choices: [] });

eq('trailing whitespace trimmed from prose',
  M.parseChoiceFence('hi\n\n:::choices\nA\n:::'),
  { text: 'hi', choices: ['A'] });
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test`
Expected: FAIL - `M.parseChoiceFence is not a function`

- [ ] **Step 3: Implement**

```js
// ":::choices ... :::" - a fence rather than "* option" lines because "*"
// already means a markdown bullet, rp-action italics, AND is UT's own prefix
// for ordinary dialogue lines. A fourth meaning could fire by accident.
const MAX_CHOICES = 8;

function parseChoiceFence(raw) {
  const text = String(raw ?? '');
  const lines = text.split('\n');

  // Walk backwards: only the LAST fence is live, earlier ones stay literal
  let openIdx = -1, closeIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i].trim();
    if (closeIdx === -1 && /^:::$/.test(t)) { closeIdx = i; continue; }
    if (closeIdx !== -1 && /^:::choices$/i.test(t)) { openIdx = i; break; }
  }
  if (openIdx === -1 || closeIdx === -1) return { text, choices: [] };

  const choices = lines.slice(openIdx + 1, closeIdx)
    .map(l => l.trim())
    .filter(Boolean)
    .map(l => l
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/\*([^*]+)\*/g, '$1')
      .replace(/__([^_]+)__/g, '$1')
      .replace(/~~([^~]+)~~/g, '$1')
      .replace(/`([^`]+)`/g, '$1'))
    .slice(0, MAX_CHOICES);

  const prose = lines.slice(0, openIdx).join('\n').replace(/\s+$/, '');
  return { text: prose, choices };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test`
Expected: PASS, 19 passed 0 failed

- [ ] **Step 5: Commit**

```bash
git add src/hmm-utils.jsx test/textbox.test.js
git commit -m "feat: parse :::choices fence

A fence rather than '* option' lines, which would collide with
markdown bullets, rp-action italics and UT's own dialogue prefix.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: Word wrap and pagination

**Files:**
- Modify: `src/hmm-utils.jsx`
- Modify: `test/textbox.test.js`

**Interfaces:**
- Produces: `wrapPages(text, cols, rows) -> [{ text, start }]`. `text` is up to `rows` lines joined by `\n`; `start` is the offset of the page's first character in the input.

- [ ] **Step 1: Write the failing tests**

Append to `test/textbox.test.js`:

```js
eq('short text is one page',
  M.wrapPages('hello', 20, 3),
  [{ text: 'hello', start: 0 }]);

eq('wraps on word boundaries',
  M.wrapPages('aaa bbb ccc', 7, 3),
  [{ text: 'aaa bbb\nccc', start: 0 }]);

eq('splits into pages at the row limit',
  M.wrapPages('a b c d', 1, 2),
  [{ text: 'a\nb', start: 0 }, { text: 'c\nd', start: 4 }]);

eq('word longer than cols hard-breaks',
  M.wrapPages('abcdefgh', 3, 3),
  [{ text: 'abc\ndef\ngh', start: 0 }]);

eq('blank line starts a new page',
  M.wrapPages('one\n\ntwo', 20, 3),
  [{ text: 'one', start: 0 }, { text: 'two', start: 5 }]);

eq('explicit newline is a line break, not a page break',
  M.wrapPages('one\ntwo', 20, 3),
  [{ text: 'one\ntwo', start: 0 }]);

eq('empty input yields one empty page',
  M.wrapPages('', 20, 3),
  [{ text: '', start: 0 }]);

ok('start offsets index the original text', (() => {
  const src = 'alpha beta gamma delta';
  const pages = M.wrapPages(src, 11, 1);
  return pages.every(p => src.slice(p.start).startsWith(p.text.split('\n')[0]));
})());
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test`
Expected: FAIL - `M.wrapPages is not a function`

- [ ] **Step 3: Implement**

```js
// The box font is monospace, so characters-per-line is deterministic and
// wrapping is pure arithmetic - no DOM measurement, identical on every device.
// `start` is the offset of each page's first character in the source text, so
// expression-tag offsets can be mapped onto the page being typed.
function wrapPages(raw, cols, rows) {
  const text = String(raw ?? '');
  const width = Math.max(1, cols | 0);
  const height = Math.max(1, rows | 0);

  const lines = [];               // { text, start }
  let cursor = 0;

  for (const rawLine of text.split('\n')) {
    const lineStart = cursor;
    cursor += rawLine.length + 1; // +1 for the consumed '\n'

    if (!rawLine.trim()) { lines.push(null); continue; } // blank = page break

    let at = 0;
    let buf = '';
    let bufStart = lineStart;
    const words = rawLine.split(/(\s+)/); // keep separators to track offsets

    for (const piece of words) {
      if (/^\s+$/.test(piece)) {
        if (buf) buf += ' ';
        at += piece.length;
        continue;
      }
      let word = piece;
      while (word.length > width) {          // hard-break over-long words
        const room = width - buf.length;
        if (room > 0) { buf += word.slice(0, room); word = word.slice(room); }
        lines.push({ text: buf, start: bufStart });
        bufStart = lineStart + at + (piece.length - word.length);
        buf = '';
      }
      if (buf.length + word.length > width) {
        lines.push({ text: buf.replace(/\s+$/, ''), start: bufStart });
        bufStart = lineStart + at;
        buf = '';
      }
      if (!buf) bufStart = lineStart + at;
      buf += word;
      at += piece.length;
    }
    lines.push({ text: buf.replace(/\s+$/, ''), start: bufStart });
  }

  const pages = [];
  let group = [];
  const flush = () => {
    if (!group.length) return;
    pages.push({ text: group.map(l => l.text).join('\n'), start: group[0].start });
    group = [];
  };
  for (const line of lines) {
    if (line === null) { flush(); continue; }   // blank line forces a break
    group.push(line);
    if (group.length === height) flush();
  }
  flush();

  return pages.length ? pages : [{ text: '', start: 0 }];
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test`
Expected: PASS, 27 passed 0 failed

- [ ] **Step 5: Commit**

```bash
git add src/hmm-utils.jsx test/textbox.test.js
git commit -m "feat: monospace word wrap and pagination

Wrapping is arithmetic rather than DOM measurement because the box
font is monospace, so it is identical on every device.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: Compose parseTextbox and resolve expressions

**Files:**
- Modify: `src/hmm-utils.jsx`
- Modify: `test/textbox.test.js`

**Interfaces:**
- Consumes: `stripExpressionTags`, `parseChoiceFence`, `wrapPages`.
- Produces:
  - `parseTextbox(raw, { cols, rows }) -> { pages, choices, tags }`
  - `expressionAt(tags, offset) -> string | null`
  - `resolveExpressionKey(expressions, name) -> string | null`
  - `expressionNameFromFilename(filename) -> string`
  - `pitchForCharacter(char) -> number`

- [ ] **Step 1: Write the failing tests**

Append to `test/textbox.test.js`:

```js
{
  const r = M.parseTextbox('\\E[Grin]Hi there.\n:::choices\nAsk\n:::', { cols: 20, rows: 3 });
  eq('parseTextbox pages', r.pages, [{ text: 'Hi there.', start: 0 }]);
  eq('parseTextbox choices', r.choices, ['Ask']);
  eq('parseTextbox tags', r.tags, [{ at: 0, name: 'Grin' }]);
}

eq('parseTextbox on empty input',
  M.parseTextbox('', { cols: 20, rows: 3 }),
  { pages: [{ text: '', start: 0 }], choices: [], tags: [] });

eq('expressionAt before any tag', M.expressionAt([{ at: 5, name: 'A' }], 0), null);
eq('expressionAt at the tag', M.expressionAt([{ at: 5, name: 'A' }], 5), 'A');
eq('expressionAt takes the latest passed tag',
  M.expressionAt([{ at: 0, name: 'A' }, { at: 5, name: 'B' }], 9), 'B');
eq('expressionAt with no tags', M.expressionAt([], 3), null);

{
  const set = { 'Grin (No Eyes)': 'd1', Neutral: 'd2' };
  eq('resolve exact', M.resolveExpressionKey(set, 'Neutral'), 'Neutral');
  eq('resolve case-insensitive', M.resolveExpressionKey(set, 'nEuTrAl'), 'Neutral');
  eq('resolve with parens', M.resolveExpressionKey(set, 'grin (no eyes)'), 'Grin (No Eyes)');
  eq('resolve unknown', M.resolveExpressionKey(set, 'Nope'), null);
  eq('resolve on empty set', M.resolveExpressionKey({}, 'Neutral'), null);
}

eq('filename strips id suffix',
  M.expressionNameFromFilename('Anxious Side Eye [323643].png'), 'Anxious Side Eye');
eq('filename without id', M.expressionNameFromFilename('Neutral.png'), 'Neutral');
eq('filename with parens',
  M.expressionNameFromFilename('Grin (No Eyes) [323564].png'), 'Grin (No Eyes)');

ok('pitch is stable and in range', (() => {
  const a = M.pitchForCharacter({ name: 'Vera' });
  const b = M.pitchForCharacter({ name: 'Vera' });
  return a === b && a >= 200 && a <= 800;
})());
ok('explicit blipPitch wins', M.pitchForCharacter({ name: 'Vera', blipPitch: 440 }) === 440);
ok('different names differ',
  M.pitchForCharacter({ name: 'Vera' }) !== M.pitchForCharacter({ name: 'Mox' }));
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test`
Expected: FAIL - `M.parseTextbox is not a function`

- [ ] **Step 3: Implement**

```js
function parseTextbox(raw, { cols = 46, rows = 3 } = {}) {
  const fenced = parseChoiceFence(raw);
  const stripped = stripExpressionTags(fenced.text);
  return {
    pages: wrapPages(stripped.text, cols, rows),
    choices: fenced.choices,
    tags: stripped.tags,
  };
}

// Latest tag at or before `offset`. Linear scan: tag counts are tiny.
function expressionAt(tags, offset) {
  let name = null;
  for (const t of tags || []) {
    if (t.at <= offset) name = t.name; else break;
  }
  return name;
}

function resolveExpressionKey(expressions, name) {
  if (!expressions || !name) return null;
  const keys = Object.keys(expressions);
  const needle = String(name).trim().toLowerCase();
  return keys.find(k => k.toLowerCase() === needle) || null;
}

// "Anxious Side Eye [323643].png" -> "Anxious Side Eye"
function expressionNameFromFilename(filename) {
  return String(filename || '')
    .replace(/\.[a-z0-9]+$/i, '')
    .replace(/\s*\[\d+\]\s*$/, '')
    .trim();
}

// Distinct voice per character with zero authoring, reusing nameHash so the
// pitch matches the colour the app already derives from the same name.
function pitchForCharacter(char) {
  if (typeof char?.blipPitch === 'number') return char.blipPitch;
  return 200 + (nameHash(char?.name || '') / 360) * 600;
}
```

`nameHash` is defined later in the file but is a hoisted function declaration, so this works. The test harness slice does **not** include it, so add this shim inside the markers, immediately above `pitchForCharacter`:

```js
// nameHash lives outside the exported region; declare it here if absent so the
// test harness can evaluate this block standalone.
if (typeof nameHash !== 'function') {
  var nameHash = name => {
    let h = 0;
    for (let i = 0; i < (name || '').length; i++) h = name.charCodeAt(i) + ((h << 5) - h);
    return (h % 360 + 360) % 360;
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test`
Expected: PASS, 47 passed 0 failed

- [ ] **Step 5: Export the new helpers**

In the `Object.assign(window, { ... })` call at the bottom of `src/hmm-utils.jsx`, add to the list:

```js
  parseTextbox, expressionAt, resolveExpressionKey, expressionNameFromFilename, pitchForCharacter,
```

- [ ] **Step 6: Commit**

```bash
git add src/hmm-utils.jsx test/textbox.test.js
git commit -m "feat: compose parseTextbox and expression resolution

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: Font and box CSS

**Files:**
- Create: `fonts/determination-mono.woff2`
- Modify: `index.html`
- Modify: `build.mjs`

**Interfaces:**
- Produces: CSS classes `.tbx`, `.tbx-inner`, `.tbx-portrait`, `.tbx-text`, `.tbx-next`, `.tbx-counter`, `.tbx-choices`, `.tbx-choice`, and the `--tbx-font` variable.

- [ ] **Step 1: Add the font file**

Download Determination Mono Web (woff2) and save it as `fonts/determination-mono.woff2`. If unavailable, any monospace pixel woff2 works - the pagination maths depends only on the font being monospace.

- [ ] **Step 2: Add CSS**

In `index.html`, immediately before the `.msg-content .md-align` rule, add:

```css
/* ── Undertale / Deltarune textbox ─────────────────────────────── */
@font-face {
  font-family: 'Determination Mono';
  src: url('fonts/determination-mono.woff2') format('woff2');
  font-display: swap;
}
:root { --tbx-font: 'Determination Mono', 'JetBrains Mono', monospace; }

.tbx { background: #000; border: 4px solid #fff; padding: 10px 12px; margin: 6px 0;
  font-family: var(--tbx-font); color: #fff; max-width: 46ch; cursor: pointer; user-select: none; }
.tbx.deltarune { border-width: 3px; border-color: #fff; background: #000; }
.tbx-inner { display: flex; gap: 12px; align-items: flex-start; }
.tbx-portrait { width: 60px; height: 60px; flex-shrink: 0; image-rendering: pixelated; }
.tbx-text { flex: 1; min-width: 0; white-space: pre-wrap; line-height: 1.5;
  font-size: 16px; letter-spacing: 0.04em; min-height: 4.5em; }
.tbx-foot { display: flex; align-items: center; justify-content: flex-end; gap: 10px;
  margin-top: 4px; min-height: 16px; font-size: 12px; color: #fff; }
.tbx-counter { opacity: 0.55; }
.tbx-next { animation: tbx-bob 0.7s infinite steps(2); }
@keyframes tbx-bob { 0%,100% { transform: translateY(0); } 50% { transform: translateY(2px); } }
body.reduce-motion .tbx-next { animation: none; }
.tbx-nav { background: none; border: none; color: #fff; font-family: var(--tbx-font);
  font-size: 12px; cursor: pointer; opacity: 0.55; }
.tbx-nav:hover:not(:disabled) { opacity: 1; }
.tbx-nav:disabled { opacity: 0.2; cursor: not-allowed; }

.tbx-choices { background: #000; border: 4px solid #fff; padding: 8px 12px; margin: 6px 0;
  font-family: var(--tbx-font); max-width: 46ch; }
.tbx-choice { display: flex; align-items: center; gap: 10px; padding: 3px 0;
  background: none; border: none; color: #fff; font-family: var(--tbx-font);
  font-size: 16px; width: 100%; text-align: left; cursor: pointer; }
.tbx-heart { width: 1em; color: #f00; opacity: 0; flex-shrink: 0; }
.tbx-choice:hover .tbx-heart, .tbx-choice:focus-visible .tbx-heart { opacity: 1; }
```

- [ ] **Step 3: Copy fonts into `dist/`**

In `build.mjs`, change the PWA assets block to:

```js
cpSync('manifest.webmanifest', 'dist/manifest.webmanifest');
cpSync('sw.js', 'dist/sw.js');
cpSync('icons', 'dist/icons', { recursive: true });
cpSync('fonts', 'dist/fonts', { recursive: true });
console.log('copied manifest, sw.js, icons/, fonts/');
```

- [ ] **Step 4: Verify the build**

Run: `npm run build`
Expected: succeeds, and `dist/fonts/determination-mono.woff2` exists.

- [ ] **Step 5: Commit**

```bash
git add index.html build.mjs fonts/
git commit -m "feat: textbox styles and pixel font

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 7: Textbox component

**Files:**
- Create: `src/hmm-textbox.jsx`
- Modify: `index.html` (script tag)
- Modify: `build.mjs` (files array)

**Interfaces:**
- Consumes: `parseTextbox`, `expressionAt`, `resolveExpressionKey`, `pitchForCharacter`, `renderMarkdown`.
- Produces: `window.Textbox`, a component taking
  `{ char, text, settings, streaming, onChoice }`.

- [ ] **Step 1: Write the component**

Create `src/hmm-textbox.jsx`:

```jsx
// hmm-textbox.jsx — Undertale / Deltarune dialogue box.
// Deliberately self-contained: it takes text and a character, and renders a
// box. It knows nothing about chat, sending or storage, so the later
// fullscreen "present mode" can reuse it unchanged.
const { useState, useEffect, useRef, useMemo, useCallback } = React;
const { parseTextbox, expressionAt, resolveExpressionKey, pitchForCharacter } = window;

const MAX_COLS = 46;
const ROWS = 3;

// Square-wave blip per character. Synthesized rather than sampled: no bundled
// audio, nothing copyrighted, works offline, and per-character pitch is closer
// to what the games do than one shared sample.
let __audioCtx = null;
function blip(pitch) {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    __audioCtx = __audioCtx || new Ctx();
    if (__audioCtx.state === 'suspended') return; // needs a user gesture first
    const osc = __audioCtx.createOscillator();
    const gain = __audioCtx.createGain();
    osc.type = 'square';
    osc.frequency.value = pitch;
    gain.gain.setValueAtTime(0.04, __audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, __audioCtx.currentTime + 0.05);
    osc.connect(gain).connect(__audioCtx.destination);
    osc.start();
    osc.stop(__audioCtx.currentTime + 0.05);
  } catch { /* audio is decorative, never break rendering over it */ }
}

function Textbox({ char, text, settings, streaming, onChoice }) {
  const reduce = !!settings?.reduceMotion
    || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

  const parsed = useMemo(
    () => parseTextbox(text || '', { cols: MAX_COLS, rows: ROWS }),
    [text]
  );
  const { pages, choices, tags } = parsed;

  const [page, setPage] = useState(0);
  const [shown, setShown] = useState(reduce ? Infinity : 0);
  const timer = useRef(null);

  const current = pages[Math.min(page, pages.length - 1)] || { text: '', start: 0 };
  const full = current.text;
  const done = shown >= full.length;

  // Restart typing when the page changes or new streamed text arrives
  useEffect(() => { setShown(reduce ? Infinity : 0); }, [page, full, reduce]);

  useEffect(() => {
    if (reduce || done) return;
    const cps = Math.max(1, settings?.textboxSpeed || 30);
    timer.current = setInterval(() => {
      setShown(n => {
        const next = n + 1;
        const ch = full[n];
        if (settings?.textboxSound && ch && !/\s|[.,!?;:]/.test(ch)) blip(pitchForCharacter(char));
        return next;
      });
    }, 1000 / cps);
    return () => clearInterval(timer.current);
  }, [full, done, reduce, settings?.textboxSpeed, settings?.textboxSound, char]);

  const skip = useCallback(() => setShown(Infinity), []);

  const visible = done ? full : full.slice(0, shown);
  const portraitKey = char?.textboxStyle === 'deltarune'
    ? resolveExpressionKey(char?.expressions, expressionAt(tags, current.start + Math.min(shown, full.length)))
      || resolveExpressionKey(char?.expressions, char?.defaultExpression)
      || Object.keys(char?.expressions || {})[0]
    : null;
  const portrait = portraitKey ? char.expressions[portraitKey] : null;

  const last = page >= pages.length - 1;
  const showChoices = choices.length > 0 && last && done && !streaming;

  return (
    <div>
      <div className={`tbx${char?.textboxStyle === 'deltarune' ? ' deltarune' : ''}`} onClick={skip}>
        <div className="tbx-inner">
          {portrait && <img className="tbx-portrait" src={portrait} alt={portraitKey} />}
          <div className="tbx-text">{visible}</div>
        </div>
        <div className="tbx-foot" onClick={e => e.stopPropagation()}>
          {pages.length > 1 && (
            <>
              <button className="tbx-nav" disabled={page === 0}
                onClick={() => setPage(p => Math.max(0, p - 1))}>◀ BACK</button>
              <span className="tbx-counter">{Math.min(page + 1, pages.length)}/{pages.length}</span>
            </>
          )}
          {!last && done && (
            <button className="tbx-nav tbx-next"
              onClick={() => setPage(p => Math.min(pages.length - 1, p + 1))}>▼</button>
          )}
        </div>
      </div>

      {showChoices && (
        <div className="tbx-choices">
          {choices.map((c, i) => (
            <button key={i} className="tbx-choice" onClick={() => onChoice?.(c)}>
              <span className="tbx-heart">♥</span>{c}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

Object.assign(window, { Textbox });
```

- [ ] **Step 2: Register the file**

In `index.html`, add after the `hmm-utils.jsx` script tag:

```html
    <script type="text/babel" src="src/hmm-textbox.jsx"></script>
```

In `build.mjs`, change the files array to:

```js
const files = ['hmm-utils.jsx', 'hmm-textbox.jsx', 'hmm-sidebar.jsx', 'hmm-chat.jsx', 'hmm-modals.jsx', 'hmm-app.jsx'];
```

- [ ] **Step 3: Verify the build**

Run: `npm run build`
Expected: prints `built dist/hmm-textbox.js` among the others.

- [ ] **Step 4: Commit**

```bash
git add src/hmm-textbox.jsx index.html build.mjs
git commit -m "feat: Textbox component with typewriter, paging and blips

Self-contained so the later fullscreen present mode reuses it whole.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 8: Chat integration

**Files:**
- Modify: `src/hmm-chat.jsx:3` (globals), around `:101` (message body), and the send path

**Interfaces:**
- Consumes: `window.Textbox`.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Import the component**

In `src/hmm-chat.jsx` line 3, add `Textbox` to the destructured globals list.

- [ ] **Step 2: Render conditionally**

In `MessageRow`, replace the `<div className="msg-content" dangerouslySetInnerHTML=...>` block with:

```jsx
{char?.textboxStyle && char.textboxStyle !== 'none' && msg.role === 'assistant' ? (
  <Textbox
    char={char}
    text={textContent}
    settings={settings}
    streaming={isStreaming}
    onChoice={onChoice}
  />
) : (
  <div
    className="msg-content"
    dangerouslySetInnerHTML={{
      __html: renderMarkdown(textContent) + (isStreaming ? '<span class="cursor"></span>' : '')
    }}
  />
)}
```

`MessageRow` must accept `char`, `settings` and `onChoice` props; add them to its signature and pass them at the call site in `ChatView` (near line 1055), where `char` and `settings` are already in scope.

- [ ] **Step 3: Handle a chosen option**

In `ChatView`, next to `sendMessage`, add:

```jsx
// A chosen option is just a user message - reuse the normal send path so
// branching, history and token accounting all behave identically.
const sendChoice = useCallback(text => {
  if (generating) return;
  setInputVal(text);
  requestAnimationFrame(() => sendMessage(text));
}, [generating, sendMessage]);
```

If `sendMessage` does not already accept an override argument, change its signature to `sendMessage(override)` and use `const body = (override ?? inputVal).trim();` in place of reading `inputVal` directly.

Pass `onChoice={sendChoice}` to `MessageRow`.

- [ ] **Step 4: Manual check**

Run: `npm run build` then serve and open a character with `textboxStyle` unset.
Expected: rendering is unchanged from before.

- [ ] **Step 5: Commit**

```bash
git add src/hmm-chat.jsx
git commit -m "feat: render assistant messages as textboxes when enabled

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 9: Character editor - style, pitch, expressions

**Files:**
- Modify: `src/hmm-modals.jsx:1147` (TABS), `:963` (form defaults), tab bodies

**Interfaces:**
- Produces: character fields `textboxStyle`, `blipPitch`, `expressions`, `defaultExpression`.

- [ ] **Step 1: Add the tab and form defaults**

Line 1147, change TABS to:

```js
const TABS = [['basic', 'BASIC'], ['advanced', 'ADVANCED'], ['avatar', 'AVATAR'], ['textbox', 'TEXTBOX']];
```

In the `useState` form initialiser (line ~963), add to the defaults object:

```js
    textboxStyle: 'none', blipPitch: null, expressions: {}, defaultExpression: '',
```

- [ ] **Step 2: Add the tab body**

After the `{tab === 'avatar' && (...)}` block, add:

```jsx
{tab === 'textbox' && (
  <div>
    <div className="form-group">
      <label className="form-label">TEXTBOX STYLE</label>
      <div style={{ display: 'flex', gap: 4 }}>
        {[['none','OFF'],['undertale','UNDERTALE'],['deltarune','DELTARUNE']].map(([v,l]) => (
          <button key={v} type="button" onClick={() => set('textboxStyle', v)}
            style={{ flex: 1, padding: '6px', fontSize: 9, fontWeight: 700, letterSpacing: '0.08em',
              fontFamily: 'var(--font)',
              background: (form.textboxStyle||'none')===v?'var(--accent3)':'var(--surface3)',
              border: `1px solid ${(form.textboxStyle||'none')===v?'var(--accent3)':'var(--border2)'}`,
              color: (form.textboxStyle||'none')===v?'var(--accent)':'var(--text3)', cursor: 'pointer' }}>{l}</button>
        ))}
      </div>
      <div className="form-hint" style={{ marginTop: 4 }}>
        Portraits show in DELTARUNE style only - Undertale has none in overworld dialogue.
      </div>
    </div>

    <div className="form-group">
      <label className="form-label">
        BLIP PITCH: {form.blipPitch ? `${Math.round(form.blipPitch)} Hz` : 'auto (from name)'}
      </label>
      <input type="range" className="form-range" min={150} max={900} step={10}
        value={form.blipPitch || 400}
        onChange={e => set('blipPitch', Number(e.target.value))} />
      <button type="button" className="btn-secondary btn-sm" style={{ marginTop: 6 }}
        onClick={() => set('blipPitch', null)}>RESET TO AUTO</button>
    </div>

    <div className="form-group">
      <label className="form-label">
        EXPRESSIONS ({Object.keys(form.expressions || {}).length})
      </label>
      <input type="file" accept="image/*" multiple
        onChange={async e => {
          const files = [...e.target.files].filter(f => f.type.startsWith('image/'));
          if (files.length + Object.keys(form.expressions||{}).length > 200) {
            ctx.addToast('Too many sprites (200 max)', 'error'); return;
          }
          const added = {};
          for (const f of files) {
            if (f.size > 256 * 1024) { ctx.addToast(`${f.name} is over 256KB, skipped`, 'error'); continue; }
            added[window.expressionNameFromFilename(f.name)] =
              await new Promise(res => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(f); });
          }
          setForm(fm => ({ ...fm, expressions: { ...fm.expressions, ...added } }));
          e.target.value = '';
        }} />
      <div className="form-hint">
        Select many at once. Names come from filenames - "Anxious [323643].png" becomes "Anxious".
      </div>
    </div>

    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(84px, 1fr))', gap: 8 }}>
      {Object.entries(form.expressions || {}).map(([name, src]) => (
        <div key={name} style={{ border: `1px solid ${form.defaultExpression === name ? 'var(--accent)' : 'var(--border2)'}`, padding: 4, textAlign: 'center' }}>
          <img src={src} alt={name} style={{ width: 60, height: 60, imageRendering: 'pixelated' }} />
          <div style={{ fontSize: 9, color: 'var(--text3)', wordBreak: 'break-word', margin: '2px 0' }}>{name}</div>
          <div style={{ display: 'flex', gap: 2, justifyContent: 'center' }}>
            <button type="button" className="btn-secondary btn-sm" title="Set as default"
              onClick={() => set('defaultExpression', name)}>★</button>
            <button type="button" className="btn-secondary btn-sm" title="Remove"
              onClick={() => setForm(fm => {
                const next = { ...fm.expressions }; delete next[name];
                return { ...fm, expressions: next,
                  defaultExpression: fm.defaultExpression === name ? '' : fm.defaultExpression };
              })}>×</button>
          </div>
        </div>
      ))}
    </div>
  </div>
)}
```

- [ ] **Step 3: Manual check**

Run: `npm run build`, serve, open a character, go to the TEXTBOX tab, select all 64 PNGs from `C:\Users\shand\Downloads\kris-missingno-v20-textbox-sprites`.
Expected: 64 thumbnails appear with names like `Anxious Side Eye`; saving the character persists them.

- [ ] **Step 4: Commit**

```bash
git add src/hmm-modals.jsx
git commit -m "feat: textbox tab in the character editor

Bulk sprite import derives expression names from filenames, since a
64-sprite set is unusable one file at a time.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 10: Settings and system prompt

**Files:**
- Modify: `src/hmm-modals.jsx` (INTERFACE settings block)
- Modify: `src/hmm-utils.jsx` (`buildSystemPrompt`)

- [ ] **Step 1: Add global settings**

In the INTERFACE section of `SettingsModal`, after the MESSAGE ALIGNMENT group, add:

```jsx
<div className="form-group">
  <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 12 }}>
    <input type="checkbox" checked={!!form.textboxSound}
      onChange={e => set('textboxSound', e.target.checked)}
      style={{ width: 14, height: 14, accentColor: 'var(--accent)', flexShrink: 0 }} />
    Textbox typing sound
  </label>
</div>
<div className="form-group">
  <label className="form-label">TEXTBOX SPEED: {form.textboxSpeed || 30} chars/sec</label>
  <input type="range" className="form-range" min={5} max={120} step={5}
    value={form.textboxSpeed || 30}
    onChange={e => set('textboxSpeed', Number(e.target.value))} />
</div>
```

- [ ] **Step 2: Teach the model the syntax**

In `buildSystemPrompt` in `src/hmm-utils.jsx`, before the final return, add:

```js
  if (char?.textboxStyle && char.textboxStyle !== 'none') {
    const names = Object.keys(char.expressions || {});
    parts.push(
      'FORMAT: your replies are shown in an Undertale-style dialogue box.\n' +
      'To offer the user choices, end your message with:\n' +
      ':::choices\nFirst option\nSecond option\n:::\n' +
      'Use 2-4 options, only when a choice makes sense. Never explain the format.' +
      (names.length
        ? `\nTo change your portrait mid-line, write \\E[Name] using exactly one of: ${names.join(', ')}`
        : '')
    );
  }
```

Match `parts.push` to however `buildSystemPrompt` accumulates its sections - read the surrounding function and follow it.

- [ ] **Step 3: Manual check**

Enable textbox mode on a character, send a message.
Expected: the reply renders in a box; when the model offers choices they appear as clickable rows.

- [ ] **Step 4: Commit**

```bash
git add src/hmm-modals.jsx src/hmm-utils.jsx
git commit -m "feat: textbox settings and system prompt

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 11: MCP field passthrough

**Files:**
- Modify: `mcp/characters.js`
- Modify: `mcp/index.js`

- [ ] **Step 1: Extend the field whitelist**

In `mcp/characters.js`, change `CHAR_FIELDS` to:

```js
export const CHAR_FIELDS = [
  'name', 'description', 'personality', 'scenario',
  'firstMessage', 'exampleDialogues', 'systemPrompt',
  'tags', 'avatar', 'alternateGreetings',
  'textboxStyle', 'blipPitch', 'defaultExpression',
];
```

`expressions` is deliberately excluded - it is a map of base64 sprites, far too large to pass through a chat tool.

In `normalizeInput`, handle the non-string fields before the generic `String(...)` cast:

```js
    if (k === 'tags' || k === 'alternateGreetings') out[k] = asArray(input[k]);
    else if (k === 'blipPitch') out[k] = input[k] === null ? null : Number(input[k]);
    else out[k] = String(input[k] ?? '');
```

- [ ] **Step 2: Expose it on the tools**

In `mcp/index.js`, add to the `properties` of both `inkling_create_character` and `inkling_update_character`:

```js
        textbox_style: { type: 'string', enum: ['none', 'undertale', 'deltarune'], description: 'Render this character\'s replies as an Undertale or Deltarune dialogue box.' },
```

And add to `ARG_MAP`:

```js
  textbox_style: 'textboxStyle',
```

- [ ] **Step 3: Add a test**

In `mcp/test/run.js`, before the delete section:

```js
const tbx = await call('inkling_update_character', { character: 'Mox', textbox_style: 'deltarune' });
check('textbox_style round-trips', !tbx.isError, tbx.text);
blob = await dump();
check('textboxStyle persisted',
  blob.data.characters.find(c => c.name === 'Mox').textboxStyle === 'deltarune');
```

- [ ] **Step 4: Run the MCP tests**

Run: `cd mcp && npm test`
Expected: PASS, all checks green.

- [ ] **Step 5: Commit**

```bash
git add mcp/
git commit -m "feat: expose textboxStyle through the MCP server

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 12: Browser end-to-end tests

**Files:**
- Create: `test/browser.mjs`

- [ ] **Step 1: Write the test**

Create `test/browser.mjs`:

```js
import { createRequire } from 'node:module';
const { chromium } = createRequire('file:///C:/Users/shand/_logo_scratch/')('playwright');

const PORT = 8899;
let pass = 0, fail = 0;
const check = (n, c, x) => { if (c) { pass++; console.log(`ok   ${n}`); }
  else { fail++; console.log(`FAIL ${n}${x ? '\n     ' + JSON.stringify(x) : ''}`); } };

const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1280, height: 900 } });
const errs = [];
p.on('pageerror', e => errs.push(e.message));

await p.goto(`http://localhost:${PORT}/index.html`);
await p.waitForFunction(() => window.S && window.InklingStorageReady, null, { timeout: 20000 });

const PX = 'data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==';
await p.evaluate(px => {
  window.S.saveChars([{
    id: 'tb', name: 'Boxy', firstMessage: 'hi', textboxStyle: 'deltarune',
    expressions: { Neutral: px, Grin: px }, defaultExpression: 'Neutral',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  }]);
  window.S.saveChat('tb', [{ id: 'm1', role: 'assistant', ts: Date.now(), content:
    'One two three four five six seven eight nine ten eleven twelve thirteen fourteen ' +
    'fifteen sixteen seventeen eighteen nineteen twenty.\n:::choices\nAsk\nLeave\n:::' }]);
  localStorage.setItem('hmm_current', 'tb');
}, PX);
await p.waitForTimeout(1000);
await p.reload();
await p.waitForSelector('.tbx', { timeout: 20000 });

check('box renders', await p.locator('.tbx').count() === 1);
check('portrait renders', await p.locator('.tbx-portrait').count() === 1);

const partial = (await p.locator('.tbx-text').innerText()).length;
await p.waitForTimeout(1500);
const later = (await p.locator('.tbx-text').innerText()).length;
check('typewriter advances', later > partial, { partial, later });

await p.locator('.tbx').click();
check('click skips to full page', (await p.locator('.tbx-text').innerText()).length >= later);

check('paginates', await p.locator('.tbx-counter').innerText() === '1/2');
await p.locator('.tbx-next').click();
check('next advances', await p.locator('.tbx-counter').innerText() === '2/2');
await p.locator('.tbx-nav', { hasText: 'BACK' }).click();
check('back returns', await p.locator('.tbx-counter').innerText() === '1/2');

await p.locator('.tbx-next').click();
await p.locator('.tbx').click();
await p.waitForSelector('.tbx-choices', { timeout: 5000 });
check('choices render after the last page', await p.locator('.tbx-choice').count() === 2);

const audioMade = await p.evaluate(() => !!window.__audioCtxCreated);
check('no audio when sound is off', !audioMade);

check('no page errors', errs.length === 0, errs);
console.log(`\n${pass} passed, ${fail} failed`);
await b.close();
process.exit(fail ? 1 : 0);
```

- [ ] **Step 2: Run it**

```bash
python -m http.server 8899 &
node test/browser.mjs
```
Expected: all checks pass.

- [ ] **Step 3: Commit**

```bash
git add test/browser.mjs
git commit -m "test: browser coverage for textbox rendering

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| `parseTextbox` pipeline | 2, 3, 4, 5 |
| Data model fields | 9 (editor), 11 (MCP) |
| Choices fence + rules | 3 |
| Expression tags + resolution | 2, 5 |
| System prompt injection | 10 |
| Pagination / wrap | 4 |
| Typewriter + streaming + reduceMotion | 7 |
| Controls (next/back/counter) | 7 |
| Portraits, DR layout, missing-sprite fallback | 6 (CSS), 7 (logic) |
| Expression authoring + bulk import | 9 |
| Audio | 7 |
| Font + self-hosting | 6 |
| Degradation table | 2, 3, 7 (guards), 8 (style `none`) |
| Unit tests | 1-5 |
| Browser tests | 12 |

**Known gap:** the spec's "`textboxStyle: 'none'` produces byte-identical output to today" is covered structurally by Task 8's conditional rather than by an assertion. Add that check to Task 12 if it matters.

**Type consistency:** `parseTextbox` returns `{ pages, choices, tags }` in Task 5 and is destructured identically in Task 7. `pages` entries are `{ text, start }` in Task 4 and used as such in Task 7. `tags` entries are `{ at, name }` in Task 2, consumed by `expressionAt` in Task 5 and Task 7.
