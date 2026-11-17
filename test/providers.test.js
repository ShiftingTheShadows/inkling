// Settings → Test connection: request construction and status reporting.
// Every fetch is injected, so nothing here touches a network or a real key.
import { loadSlice, makeRunner } from './harness.js';

const { buildProviderProbe, normalizeBaseUrl, testProvider } = loadSlice(
  '/* PROVIDER-EXPORTS-START */', '/* PROVIDER-EXPORTS-END */',
);
const { eq, ok, done } = makeRunner();

const body = init => JSON.parse(init.body);

// ── endpoint normalization ─────────────────────────────────────
eq('trailing slash stripped', normalizeBaseUrl('https://openrouter.ai/api/'), 'https://openrouter.ai/api');
eq('/v1 suffix stripped', normalizeBaseUrl('http://localhost:11434/v1'), 'http://localhost:11434');
eq('empty stays empty', normalizeBaseUrl(''), '');

// ── probe construction ─────────────────────────────────────────
{
  const p = buildProviderProbe({ provider: 'custom', localEndpoint: 'https://example.test/api/', localModel: 'my/model', localApiKey: 'k' });
  eq('external url', p.url, 'https://example.test/api/v1/chat/completions');
  eq('external body is one token', body(p.init).max_tokens, 1);
  eq('external body has no tools', body(p.init).tools, undefined);
  ok('bearer header used when a key is set', p.init.headers.Authorization === 'Bearer k');
}

{
  const p = buildProviderProbe({ provider: 'local', localEndpoint: 'http://localhost:11434', localModel: 'llama3.2:3b' });
  eq('keyless local has no Authorization header', p.init.headers.Authorization, undefined);
}

{
  const p = buildProviderProbe({ provider: 'openrouter' });
  eq('openrouter default endpoint', p.url, 'https://openrouter.ai/api/v1/chat/completions');
  eq('openrouter default model', body(p.init).model, 'anthropic/claude-sonnet-5');
}

{
  const p = buildProviderProbe({ provider: 'local', localModel: 'llama3' });
  eq('ollama default endpoint', p.url, 'http://localhost:11434/v1/chat/completions');
}

{
  let err = null;
  try { buildProviderProbe({ provider: 'claude' }); } catch (e) { err = e.message; }
  ok('claude without a key is rejected before any request', /API key/.test(err || ''));
}

{
  let err = null;
  try { buildProviderProbe({ provider: 'custom', localModel: 'm' }); } catch (e) { err = e.message; }
  ok('missing endpoint is rejected', /endpoint/i.test(err || ''));
}

{
  let err = null;
  try { buildProviderProbe({ provider: 'custom', localEndpoint: 'https://x.test' }); } catch (e) { err = e.message; }
  ok('missing model is rejected', /model/i.test(err || ''));
}

// ── status handling ────────────────────────────────────────────
const reply = (status, payload, statusText = '') => async () => ({
  ok: status >= 200 && status < 300,
  status,
  statusText,
  text: async () => (payload === undefined ? '' : JSON.stringify(payload)),
});

{
  const r = await testProvider({ provider: 'custom', localEndpoint: 'https://x.test', localModel: 'm' }, { fetchImpl: reply(200, { choices: [] }) });
  eq('200 is ok', r.ok, true);
  ok('200 reports elapsed time', typeof r.ms === 'number');
}

{
  const r = await testProvider({ provider: 'custom', localEndpoint: 'https://x.test', localModel: 'm' }, { fetchImpl: reply(401, { error: { message: 'invalid api key' } }) });
  eq('401 is not ok', r.ok, false);
  ok('401 hint points at the key', /key/i.test(r.hint || ''));
  eq('provider message is surfaced', r.detail, 'invalid api key');
}

{
  const r = await testProvider({ provider: 'claude', apiKey: 'k', model: 'claude-haiku-4-5' }, { fetchImpl: reply(404, { error: { message: 'not found' } }) });
  ok('claude 404 mentions the api proxy', /proxy/i.test(r.hint || ''));
}

{
  const r = await testProvider({ provider: 'custom', localEndpoint: 'https://x.test', localModel: 'm' }, { fetchImpl: reply(400, { error: 'bad model' }) });
  eq('string error bodies are read', r.detail, 'bad model');
  ok('400 hint mentions the model', /model/i.test(r.hint || ''));
}

{
  const r = await testProvider({ provider: 'custom', localEndpoint: 'https://x.test', localModel: 'm' }, { fetchImpl: reply(429, {}) });
  ok('429 hint mentions limits or credit', /rate limited|credit/i.test(r.hint || ''));
}

{
  const r = await testProvider({ provider: 'custom', localEndpoint: 'https://x.test', localModel: 'm' }, { fetchImpl: async () => { throw new Error('ECONNREFUSED'); } });
  eq('network failure is not ok', r.ok, false);
  ok('network failure names the endpoint', /could not reach/.test(r.detail || ''));
}

{
  const hanging = (_url, init) => new Promise((_, reject) => {
    init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  });
  const r = await testProvider({ provider: 'custom', localEndpoint: 'https://x.test', localModel: 'm' }, { fetchImpl: hanging, timeoutMs: 30 });
  eq('timeout is not ok', r.ok, false);
  ok('timeout is reported as a timeout', /timed out/.test(r.detail || ''));
}

{
  // Ollama pre-check: version answers, model absent from tags → no completion call.
  let completionCalls = 0;
  const fake = async (url) => {
    if (url.endsWith('/api/version')) return { ok: true, json: async () => ({ version: '0.9.0' }), text: async () => '' };
    if (url.endsWith('/api/tags')) return { ok: true, json: async () => ({ models: [{ name: 'other:latest' }] }), text: async () => '' };
    completionCalls++;
    return { ok: true, status: 200, text: async () => '{}' };
  };
  const r = await testProvider({ provider: 'local', localEndpoint: 'http://localhost:11434', localModel: 'llama3.2:3b' }, { fetchImpl: fake });
  eq('unpulled ollama model fails', r.ok, false);
  ok('unpulled message names the model', /llama3\.2:3b/.test(r.detail || ''));
  eq('no completion request is spent on an unpulled model', completionCalls, 0);
}

done();
