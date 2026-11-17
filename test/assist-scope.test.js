// G2: Enhance rewrites only the selected fragment and splices it back, and
// tone presets steer that rewrite. These assertions pin the pure scope helpers
// and the wiring that uses them.
import fs from 'node:fs';
import { loadSlice, makeRunner } from './harness.js';

const { eq, ok, done } = makeRunner();

let M = null;
try { M = loadSlice('/* ASSIST-SCOPE-START */', '/* ASSIST-SCOPE-END */'); }
catch (e) { ok('assist scope helpers are present', false, e.message); }
if (!M) { ok('assist scope helpers are testable', false, 'helpers missing'); done(); }

const { assistScopeFromDraft, assistScopeSplice, assistToneHint, assistTonePresets } = M;

// ── which span an enhance applies to ────────────────────────────────
const draft = 'She waits by the door. He never answers.';
const whole = assistScopeFromDraft(draft, 5, 5);
eq('an empty selection scopes the whole draft', whole, { scoped: false, text: draft, start: 0, end: draft.length });
const sel = assistScopeFromDraft(draft, 4, 22);
eq('a selection scopes just that fragment', sel, { scoped: true, text: 'waits by the door.', start: 4, end: 22 });

const padded = 'before   hums a tune   after';
const trimmed = assistScopeFromDraft(padded, 6, 23);
eq('surrounding spaces are trimmed out of the fragment', [trimmed.text, trimmed.start, trimmed.end], ['hums a tune', 9, 20]);
eq('a whitespace-only selection falls back to the whole draft',
  assistScopeFromDraft(padded, 6, 9), { scoped: false, text: padded, start: 0, end: padded.length });
eq('an out-of-range selection is clamped',
  assistScopeFromDraft('abc', -5, 99), { scoped: true, text: 'abc', start: 0, end: 3 });
eq('a missing draft scopes to nothing', assistScopeFromDraft(null, 0, 0), { scoped: false, text: '', start: 0, end: 0 });

// ── splicing the accepted rewrite back ──────────────────────────────
const spliced = assistScopeSplice(draft, sel, 'waits, listening.');
eq('a scoped rewrite keeps the rest of the draft', spliced.value, 'She waits, listening. He never answers.');
eq('the caret lands after the rewritten fragment', [spliced.start, spliced.end], [21, 21]);
eq('trimmed padding survives the splice',
  assistScopeSplice(padded, trimmed, 'hums').value, 'before   hums   after');
eq('a whole-draft rewrite replaces everything',
  assistScopeSplice('old draft', whole, 'new one'), { value: 'new one', start: 7, end: 7 });
eq('no scope means the whole draft is replaced',
  assistScopeSplice('old draft', null, 'new one'), { value: 'new one', start: 7, end: 7 });

// ── tone presets ────────────────────────────────────────────────────
const presets = assistTonePresets();
eq('four tone presets are offered', presets.map(p => p.id), ['descriptive', 'plainer', 'dialogue', 'shorten']);
ok('every preset has a label and a usable hint', presets.every(p => p.label && p.hint && p.hint.length > 20));
eq('a preset hint is looked up by id', assistToneHint('plainer'), presets[1].hint);
eq('an unknown preset adds no hint', assistToneHint('nonsense'), '');
eq('no preset adds no hint', assistToneHint(''), '');

// ── wiring: the composer actually uses them ─────────────────────────
const chat = fs.readFileSync(new URL('../src/hmm-chat.jsx', import.meta.url), 'utf8');
const docs = fs.readFileSync(new URL('../docs/IDEAS.md', import.meta.url), 'utf8');
ok('enhance reads the composer selection', /assistScopeFromDraft\(inputVal/.test(chat));
ok('the scoped prompt rewrites only the fragment', /Rewrite only this fragment/.test(chat));
ok('accepting a scoped rewrite splices it back', /assistScopeSplice\(assistReview\.original/.test(chat));
ok('the review remembers the span it was generated for', /\.\.\.\(scope \? \{ scope \} : \{\}\)/.test(chat));
ok('a retry reuses the chosen tone', /tone: assistReview\.tone/.test(chat));
ok('the popover offers the tone presets', /assistTonePresets\(\)\.map/.test(chat) && /setAssistTone/.test(chat));
ok('the review sheet names a fragment rewrite', /ENHANCED FRAGMENT/.test(chat) && /REPLACE FRAGMENT/.test(chat));
ok('the backlog records G2 as done', /G2 — done\./.test(docs));

done();
