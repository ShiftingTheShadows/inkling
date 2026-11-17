// G3: continuing a group scene has to run as the member who wrote the line —
// the group record has no voice of its own. These assertions pin the speaker
// resolver and the wiring that uses it in the continue path.
import fs from 'node:fs';
import { loadSlice, makeRunner } from './harness.js';

const { eq, ok, done } = makeRunner();

let M = null;
try { M = loadSlice('/* GROUP-CONTINUE-START */', '/* GROUP-CONTINUE-END */'); }
catch (e) { ok('group continue helper is present', false, e.message); }
if (!M) { ok('group continue helper is testable', false, 'helper missing'); done(); }

const { groupContinueSpeaker } = M;

const ann = { id: 'ann', name: 'Ann', personality: 'sharp' };
const ben = { id: 'ben', name: 'Ben', personality: 'warm' };
const members = [ann, ben];

eq('the member who wrote the line is resolved', groupContinueSpeaker(members, { role: 'assistant', charId: 'ben', content: 'Hi.' }), ben);
eq('the other member is resolved for their own line', groupContinueSpeaker(members, { role: 'assistant', charId: 'ann' }).name, 'Ann');
eq('an unknown speaker is refused', groupContinueSpeaker(members, { role: 'assistant', charId: 'ghost' }), null);
eq('a message with no speaker is refused', groupContinueSpeaker(members, { role: 'assistant', content: 'Someone said this.' }), null);
eq('a narrator line is refused', groupContinueSpeaker(members, { role: 'assistant', narrator: true, charId: 'ann' })?.name || null, null);
eq('a missing member list is refused', groupContinueSpeaker(null, { charId: 'ann' }), null);
eq('an empty member list is refused', groupContinueSpeaker([], { charId: 'ann' }), null);
eq('a null message is refused', groupContinueSpeaker(members, null), null);
eq('a gap in the member list is skipped', groupContinueSpeaker([null, ben], { charId: 'ben' }), ben);
eq('a member id that is not a string still matches', groupContinueSpeaker([{ id: 7, name: 'Seven' }], { charId: 7 })?.name, 'Seven');

// ── wiring: the continue path runs as that member ───────────────────
const chat = fs.readFileSync(new URL('../src/hmm-chat.jsx', import.meta.url), 'utf8');
const utils = fs.readFileSync(new URL('../src/hmm-utils.jsx', import.meta.url), 'utf8');
const docs = fs.readFileSync(new URL('../docs/IDEAS.md', import.meta.url), 'utf8');

ok('the continue path resolves the last line\'s member', /groupContinueSpeaker\(members, lastAsst\)/.test(chat));
ok('a group continuation uses the member system prompt', /groupSystem\(speaker, before\)/.test(chat));
ok('group history keeps the speakers apart', /groupApiMsgs\(before\)/.test(chat));
ok('the continuation is attributed to the member by name', /continuing your previous message as \$\{speaker\.name\}/.test(chat));
ok('a non-group continuation still uses the character', /buildSystemPrompt\(char, settings\)/.test(chat));
ok('a speaker-less message is refused instead of misattributed', /Only a member.s message can be continued in a group/.test(chat));
ok('the helper is exported for the app', /groupContinueSpeaker,/.test(utils));
ok('the changelog records group continuations', /Continue in a group scene now speaks as the member who wrote the line/.test(utils));
ok('the backlog records G3 as done', /G3 — done\./.test(docs));

done();
