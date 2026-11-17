// A8: usage parsing, context-window resolution and the meter — pure helpers.
import { loadSlice, makeRunner } from './harness.js';

const {
  parseOpenAIUsage, parseAnthropicUsage, mergeUsage, contextTokensFromMessages,
  resolveContextLength, contextMeter,
} = loadSlice('/* USAGE-START */', '/* USAGE-END */');
const { eq, ok, done } = makeRunner();

// ── OpenAI-compatible usage ─────────────────────────────────────
{
  eq('prompt/completion tokens become input/output', parseOpenAIUsage({ prompt_tokens: 1200, completion_tokens: 300 }), { input: 1200, output: 300, total: 1500 });
  eq('input/output aliases are understood', parseOpenAIUsage({ input_tokens: 40, output_tokens: 2 }), { input: 40, output: 2, total: 42 });
  eq('missing usage is null', parseOpenAIUsage(undefined), null);
  eq('null usage is null', parseOpenAIUsage(null), null);
  eq('zeroed usage is null', parseOpenAIUsage({ prompt_tokens: 0, completion_tokens: 0 }), null);
  eq('cached tokens stay part of the prompt count', parseOpenAIUsage({ prompt_tokens: 900, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 800 } }).total, 910);
}

// ── Anthropic usage ────────────────────────────────────────────
{
  eq('cached input is added to the context size',
    parseAnthropicUsage({ input_tokens: 100, cache_creation_input_tokens: 500, cache_read_input_tokens: 9000, output_tokens: 250 }),
    { input: 9600, output: 250, total: 9850 });
  eq('plain anthropic usage', parseAnthropicUsage({ input_tokens: 30, output_tokens: 12 }), { input: 30, output: 12, total: 42 });
  eq('empty anthropic usage is null', parseAnthropicUsage({ input_tokens: 0, output_tokens: 0 }), null);
}

// ── merging start/delta reports ────────────────────────────────
{
  const start = parseAnthropicUsage({ input_tokens: 1000, output_tokens: 1 });
  const delta = parseAnthropicUsage({ output_tokens: 400 });
  eq('delta keeps the request size and raises output', mergeUsage(start, delta), { input: 1000, output: 400, total: 1400 });
  eq('merging with nothing returns the other side', mergeUsage(null, delta), delta);
  eq('merging into nothing returns the existing side', mergeUsage(start, null), start);
  const older = parseAnthropicUsage({ input_tokens: 800, output_tokens: 900 });
  eq('the larger value wins on both sides', mergeUsage(start, older), { input: 1000, output: 900, total: 1900 });
}

// ── which tokens the meter counts ──────────────────────────────
{
  const msgs = [
    { id: 'u1', role: 'user', content: 'a'.repeat(400) }, // ~100 estimated
    { id: 'a1', role: 'assistant', content: 'b'.repeat(400) },
  ];
  const est = contextTokensFromMessages(msgs);
  eq('with no usage it estimates at 4 chars/token', est, { tokens: 200, exact: false });

  const withUsage = [...msgs, { id: 'a2', role: 'assistant', content: 'short', usage: { input: 5000, output: 250 } }];
  eq('the latest reply usage wins', contextTokensFromMessages(withUsage), { tokens: 5250, exact: true });

  const zeroUsage = [{ id: 'a1', content: 'x'.repeat(40), usage: { input: 0, output: 0 } }];
  eq('zero usage is ignored, not trusted', contextTokensFromMessages(zeroUsage), { tokens: 10, exact: false });

  const olderUsage = [
    { id: 'a1', content: 'x', usage: { input: 900, output: 100 } },
    { id: 'u2', content: 'y'.repeat(200) },
  ];
  eq('an older usage report is not summed with new messages', contextTokensFromMessages(olderUsage), { tokens: 1000, exact: true });

  const arrayContent = [{ content: [{ type: 'image' }, { type: 'text', text: 'z'.repeat(80) }] }];
  eq('multimodal messages use their text part', contextTokensFromMessages(arrayContent), { tokens: 20, exact: false });

  eq('empty chat is zero', contextTokensFromMessages([]), { tokens: 0, exact: false });
  eq('missing messages is zero', contextTokensFromMessages(undefined), { tokens: 0, exact: false });
}

// ── context window resolution ──────────────────────────────────
{
  eq('Settings override wins', resolveContextLength({ override: 32000, model: 'claude-haiku-4-5', catalog: { 'x': 1 } }), 32000);
  eq('live catalogue wins over the family guess', resolveContextLength({ model: 'anthropic/claude-sonnet-5', catalog: { 'anthropic/claude-sonnet-5': 64000 } }), 64000);
  eq('Claude defaults to 200k', resolveContextLength({ model: 'claude-sonnet-5' }), 200000);
  eq('gpt-4o is 128k', resolveContextLength({ model: 'gpt-4o-mini' }), 128000);
  eq('Gemini is 1M', resolveContextLength({ model: 'gemini-2.5-pro' }), 1048576);
  eq('the llama 3 family reports a 128k window', resolveContextLength({ model: 'llama3:8b' }), 131072);
  eq('an unrecognised model falls back to 16k', resolveContextLength({ model: 'my-finetune-v3' }), 16000);
  eq('garbage override falls back instead of zero', resolveContextLength({ override: 'abc', model: 'my-finetune-v3' }), 16000);
  eq('negative override is ignored', resolveContextLength({ override: -5, model: 'my-finetune-v3' }), 16000);
}

// ── the meter ──────────────────────────────────────────────────
{
  const usage = [{ id: 'a', content: 'x', usage: { input: 50000, output: 1000 } }];
  eq('percent uses the real window', contextMeter(usage, 100000), { tokens: 51000, exact: true, pct: 51 });
  eq('percent caps at 100', contextMeter(usage, 20000).pct, 100);
  eq('missing window uses the default', contextMeter([], undefined), { tokens: 0, exact: false, pct: 0 });
  ok('auto-summarize threshold is reachable', contextMeter(usage, 64000).pct > 75);
  ok('a short chat stays under threshold', contextMeter([{ content: 'hello' }], 200000).pct < 1);
}

done();
