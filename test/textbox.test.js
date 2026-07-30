import { loadTextboxModule, makeRunner } from './harness.js';

const M = loadTextboxModule();
const { eq, ok, done } = makeRunner();

ok('module exposes stripExpressionTags', typeof M.stripExpressionTags === 'function');

done();
