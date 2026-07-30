import { loadTextboxModule, makeRunner } from './harness.js';

const M = loadTextboxModule();
const { eq, ok, done } = makeRunner();

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

done();
