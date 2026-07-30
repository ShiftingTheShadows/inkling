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

eq('unclosed LAST fence keeps the whole message literal',
  M.parseChoiceFence('a\n:::choices\nOLD\n:::\nb\n:::choices\nNEW'),
  { text: 'a\n:::choices\nOLD\n:::\nb\n:::choices\nNEW', choices: [] });

eq('content after the fence close is preserved',
  M.parseChoiceFence('a\n:::choices\nX\n:::\nafter'),
  { text: 'a\nafter', choices: ['X'] });

eq('nested marks strip cleanly',
  M.parseChoiceFence('x\n:::choices\n**bold *inner* **\n:::'),
  { text: 'x', choices: ['bold inner'] });

eq('lone ::: with no open stays literal',
  M.parseChoiceFence('a\n:::\nb'),
  { text: 'a\n:::\nb', choices: [] });

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

eq('hard-break remainder keeps a correct start offset',
  M.wrapPages('abcdefgh', 3, 1),
  [{ text: 'abc', start: 0 }, { text: 'def', start: 3 }, { text: 'gh', start: 6 }]);

eq('hard-break mid-sentence keeps later offsets correct',
  M.wrapPages('hi abcdefgh yo', 4, 1),
  [{ text: 'hi', start: 0 }, { text: 'abcd', start: 3 }, { text: 'efgh', start: 7 }, { text: 'yo', start: 12 }]);

done();
