// B15: group turn planning — speaker rotation, mention handling, director output
// parsing and the replies-per-turn normalization.
import { loadSlice, makeRunner } from './harness.js';

const { nextGroupSpeaker, parseDirectorChoice, normalizeGroupReplies } = loadSlice(
  '/* GROUP-TURN-START */', '/* GROUP-TURN-END */',
);
const { eq, ok, done } = makeRunner();

const members = [
  { id: 'c1', name: 'Vera' },
  { id: 'c2', name: 'Ivo' },
  { id: 'c3', name: 'Mira' },
];
const said = id => ({ id: `m-${id}`, role: 'assistant', charId: id, content: '…' });
const user = { id: 'u1', role: 'user', content: 'hello' };

// ── rotation ───────────────────────────────────────────────────
{
  eq('no history starts with the first member', nextGroupSpeaker(members, []).id, 'c1');
  eq('rotates after the last speaker', nextGroupSpeaker(members, [user, said('c1')]).id, 'c2');
  eq('wraps to the first member', nextGroupSpeaker(members, [said('c3')]).id, 'c1');
  eq('user messages are not speakers', nextGroupSpeaker(members, [said('c2'), user]).id, 'c3');
  eq('narrator turns are not speakers', nextGroupSpeaker(members, [said('c1'), { id: 'n', role: 'assistant', narrator: true }]).id, 'c2');
  eq('an unknown last id starts over', nextGroupSpeaker(members, [said('gone')]).id, 'c1');
  eq('no members is null', nextGroupSpeaker([], [said('c1')]), null);
  eq('missing list is null', nextGroupSpeaker(undefined, []), null);
  eq('null entries are ignored', nextGroupSpeaker([null, members[1]], []).id, 'c2');
}

// ── mentions ───────────────────────────────────────────────────
{
  eq('a mentioned member answers out of order', nextGroupSpeaker(members, [said('c1')], { mentionText: 'Mira, what do you think?' }).id, 'c3');
  eq('mentions are case-insensitive', nextGroupSpeaker(members, [], { mentionText: 'ivo?' }).id, 'c2');
  eq('no mention falls back to rotation', nextGroupSpeaker(members, [said('c1')], { mentionText: 'anyone?' }).id, 'c2');
  eq('mention text is ignored when empty', nextGroupSpeaker(members, [], { mentionText: '' }).id, 'c1');
}

// ── director parsing ───────────────────────────────────────────
{
  eq('a bare name is accepted', parseDirectorChoice('Ivo', members)?.id, 'c2');
  eq('case does not matter', parseDirectorChoice('mira', members)?.id, 'c3');
  eq('trailing punctuation is stripped', parseDirectorChoice('Mira:', members)?.id, 'c3');
  eq('quotes and bold are stripped', parseDirectorChoice('**"Ivo."**', members)?.id, 'c2');
  eq('a sentence starting with the name works', parseDirectorChoice('Vera — she has been quiet.', members)?.id, 'c1');
  eq('a name mentioned mid-sentence works', parseDirectorChoice('I think Mira should speak next.', members)?.id, 'c3');
  eq('the last speaker can be excluded', parseDirectorChoice('Vera', members, { excludeId: 'c1' }), null);
  eq('exclusion still allows others', parseDirectorChoice('Mira', members, { excludeId: 'c1' })?.id, 'c3');
  eq('an invented name is rejected', parseDirectorChoice('the narrator', members), null);
  eq('an empty answer is rejected', parseDirectorChoice('   ', members), null);
  eq('a null answer is rejected', parseDirectorChoice(null, members), null);
  eq('single-member group is null when that member is excluded', parseDirectorChoice('Vera', [members[0]], { excludeId: 'c1' }), null);
}

// ── replies per turn ──────────────────────────────────────────
{
  eq('default is one', normalizeGroupReplies(undefined), 1);
  eq('one stays one', normalizeGroupReplies(1), 1);
  eq('two is allowed', normalizeGroupReplies(2), 2);
  eq('three is allowed', normalizeGroupReplies(3), 3);
  eq('four is clamped to the default', normalizeGroupReplies(4), 1);
  eq('zero is the default', normalizeGroupReplies(0), 1);
  eq('negative is the default', normalizeGroupReplies(-2), 1);
  eq('numeric strings work', normalizeGroupReplies('3'), 3);
  eq('fractions round', normalizeGroupReplies(2.4), 2);
  eq('the menu cycle 3 wraps to 1', normalizeGroupReplies(3) % 3 + 1, 1);
  ok('the menu cycle 1 becomes 2', normalizeGroupReplies(1) % 3 + 1 === 2);
}

done();
