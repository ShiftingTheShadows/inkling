// G1: AI assist drafts are reviewed, not written over the composer. These
// assertions pin the state machine behind the review sheet (accept / retry /
// keep original, three variants) and the wiring that uses it.
import fs from 'node:fs';
import { loadSlice, makeRunner } from './harness.js';

const { eq, ok, done } = makeRunner();

let M = null;
try { M = loadSlice('/* ASSIST-REVIEW-START */', '/* ASSIST-REVIEW-END */'); }
catch (e) { ok('assist review helpers are present', false, e.message); }
if (!M) { ok('assist review state machine is testable', false, 'helpers missing'); done(); }

const { assistReviewNext, assistReviewText, assistReviewCycle } = M;

const first = assistReviewNext(null, { mode: 'write', direction: '', length: 'medium', original: 'my draft', text: 'A generated line.' });
eq('a first assist starts a review', first, { mode: 'write', direction: '', length: 'medium', original: 'my draft', variants: ['A generated line.'], index: 0 });
eq('the review shows the generated text', assistReviewText(first), 'A generated line.');
eq('the composer draft is preserved untouched', first.original, 'my draft');

const retried = assistReviewNext(first, { mode: 'write', original: 'my draft', text: 'A second line.', retry: true });
eq('retry keeps the original and adds a variant', retried.original, 'my draft');
eq('retry selects the newest variant', [retried.variants.length, retried.index], [2, 1]);
eq('the newest variant is shown', assistReviewText(retried), 'A second line.');

const third = assistReviewNext(retried, { mode: 'write', original: 'my draft', text: 'Third.', retry: true });
const fourth = assistReviewNext(third, { mode: 'write', original: 'my draft', text: 'Fourth.', retry: true });
eq('variants are capped at three', fourth.variants, ['A second line.', 'Third.', 'Fourth.']);
eq('the cap keeps the newest selection', fourth.index, 2);

const replaced = assistReviewNext(fourth, { mode: 'enhance', original: 'my draft', text: 'Enhanced.', retry: false });
eq('a fresh request replaces the previous review', [replaced.mode, replaced.variants, replaced.index], ['enhance', ['Enhanced.'], 0]);

const retryOther = assistReviewNext(first, { mode: 'enhance', original: 'my draft', text: 'Enhanced.', retry: true });
eq('retrying a different mode starts a new review', retryOther.variants, ['Enhanced.']);

eq('an empty generation does not disturb the review', assistReviewNext(first, { mode: 'write', text: '   ', retry: true }), first);
eq('no review yields no text', assistReviewText(null), '');

const clamped = { ...fourth, index: 9 };
eq('an out-of-range index falls back to the last variant', assistReviewText(clamped), 'Fourth.');
eq('cycling forward wraps', assistReviewCycle(fourth, 1).index, 0);
eq('cycling backward wraps', assistReviewCycle(fourth, -1).index, 1);
eq('cycling a single variant is a no-op', assistReviewCycle(first, 1), first);

const chat = fs.readFileSync(new URL('../src/hmm-chat.jsx', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
ok('assist results go through the review reducer', /assistReviewNext\(prev,/.test(chat));
ok('the old silent composer overwrite is gone', !/updateInput\(clean\)/.test(chat));
ok('accepting writes the selected variant', /const v = assistReviewText\(assistReview\)/.test(chat) && /updateInput\(v\)/.test(chat));
ok('Escape closes the review without touching the draft', /assistReview && e\.key === 'Escape'/.test(chat));
ok('Ctrl+Enter accepts the review', /assistReview && e\.ctrlKey && e\.key === 'Enter'/.test(chat));
ok('the review sheet is rendered with the three actions', /className="assist-review"/.test(chat) && /TRY AGAIN/.test(chat) && /KEEP ORIGINAL/.test(chat));
ok('the review sheet has styles', /\.assist-review-text/.test(css));

done();
