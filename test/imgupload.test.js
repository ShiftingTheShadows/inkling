// F41: configurable image host. Covers the target each configured host builds,
// response parsing, the custom endpoint's public-address gate, and the real
// /api/imgupload handler end to end with an injected fetch.
import { loadSlice, makeRunner } from './harness.js';
import handler, {
  resolveImageHost, imageHostNeedsKey, customEndpointProblem,
  imageUploadTarget, imageUrlFromResponse, uploadToHost,
} from '../api/imgupload.js';

const C = loadSlice('/* IMAGE-HOST-START */', '/* IMAGE-HOST-END */');
const { eq, ok, done } = makeRunner();

const withFetch = async (stub, fn) => {
  const real = globalThis.fetch;
  globalThis.fetch = stub;
  try { return await fn(); } finally { globalThis.fetch = real; }
};

const png = () => new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'greeting.png', { type: 'image/png' });

const uploadRequest = (fields = {}) => {
  const fd = new FormData();
  fd.append('file', png());
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  return new Request('https://app.example/api/imgupload', { method: 'POST', body: fd });
};

// ── default behavior is exactly what shipped before ─────────
eq('no setting means the original host', resolveImageHost({}), 'freeimage');
eq('an unknown host falls back to the original', resolveImageHost({ imageHost: 'nope' }), 'freeimage');
eq('the unconfigured target is the original freeimage request',
  imageUploadTarget('freeimage', '', 'KEY'), {
    url: 'https://freeimage.host/api/1/upload?key=KEY',
    field: 'source',
    extra: { format: 'json' },
  });
ok('freeimage and imgbb need a key', imageHostNeedsKey('freeimage') && imageHostNeedsKey('imgbb'));
ok('a custom endpoint may be open', !imageHostNeedsKey('custom'));
eq('the original response envelope still parses',
  imageUrlFromResponse('freeimage', { image: { url: 'https://iili.io/x.png' } }), 'https://iili.io/x.png');

const clientCfg = C.imageUploadConfig({});
eq('the client sends no host override by default', clientCfg.host, 'freeimage');
ok('the client agrees with the server on the default', clientCfg.host === resolveImageHost({}));
for (const h of ['freeimage', 'imgbb', 'custom', 'bogus']) {
  eq(`client and server agree on "${h}"`, C.resolveImageHost({ imageHost: h }), resolveImageHost({ imageHost: h }));
}
eq('the client reads the configured key and endpoint',
  C.imageUploadConfig({ imageHost: 'custom', imageHostApiKey: ' k ', imageHostEndpoint: ' https://img.example.com/up ' }),
  { host: 'custom', apiKey: 'k', endpoint: 'https://img.example.com/up', needsKey: false });

// ── imgbb ───────────────────────────────────────────────────
eq('imgbb posts the file under its own field',
  imageUploadTarget('imgbb', '', 'K2'), { url: 'https://api.imgbb.com/1/upload?key=K2', field: 'image', extra: {} });
eq('imgbb responses parse', imageUrlFromResponse('imgbb', { data: { url: 'https://i.ibb.co/a.png' } }), 'https://i.ibb.co/a.png');
eq('imgbb display_url is a fallback',
  imageUrlFromResponse('imgbb', { data: { display_url: 'https://i.ibb.co/b.png' } }), 'https://i.ibb.co/b.png');

{
  const calls = [];
  await withFetch(async (url, opts) => {
    calls.push({ url: String(url), body: opts.body });
    return { ok: true, status: 200, text: async () => JSON.stringify({ data: { url: 'https://i.ibb.co/real.png' } }) };
  }, async () => {
    const url = await uploadToHost({ host: 'imgbb', apiKey: 'K2', file: png() });
    eq('uploadToHost returns the imgbb URL', url, 'https://i.ibb.co/real.png');
  });
  eq('uploadToHost called the configured imgbb endpoint', calls[0].url, 'https://api.imgbb.com/1/upload?key=K2');
  ok('the file is sent as multipart "image"', calls[0].body instanceof FormData && calls[0].body.get('image')?.name === 'greeting.png');
}

// ── custom / self-hosted ────────────────────────────────────
eq('the custom target is the configured URL', imageUploadTarget('custom', 'https://img.example.com/up', 'k').url, 'https://img.example.com/up');
eq('a custom JSON response parses', imageUrlFromResponse('custom', { url: 'https://cdn.example.com/i.png' }), 'https://cdn.example.com/i.png');
eq('a nested custom response parses', imageUrlFromResponse('custom', { data: { url: 'https://cdn.example.com/j.png' } }), 'https://cdn.example.com/j.png');
eq('a bare-text custom response parses', imageUrlFromResponse('custom', null, 'https://cdn.example.com/k.png\n'), 'https://cdn.example.com/k.png');
eq('garbage from a custom host yields nothing', imageUrlFromResponse('custom', { ok: true }, 'not a url'), null);

eq('an empty custom endpoint is refused', customEndpointProblem(''), 'Missing custom image host URL');
eq('a loopback custom endpoint is refused', customEndpointProblem('http://127.0.0.1:8080/upload'), 'The custom image host URL must be a public http(s) address');
eq('a private custom endpoint is refused', customEndpointProblem('http://10.0.0.5/upload'), 'The custom image host URL must be a public http(s) address');
eq('a non-http custom endpoint is refused', customEndpointProblem('file:///tmp/upload'), 'The custom image host URL must be a public http(s) address');
eq('a public custom endpoint is accepted', customEndpointProblem('https://img.example.com/upload'), null);

{
  const calls = [];
  await withFetch(async (url) => {
    calls.push(String(url));
    return { ok: true, status: 200, text: async () => JSON.stringify({ url: 'https://cdn.example.com/z.png' }) };
  }, async () => {
    const url = await uploadToHost({ host: 'custom', endpoint: 'https://img.example.com/up', apiKey: 'secret', file: png() });
    eq('uploadToHost returns the custom URL', url, 'https://cdn.example.com/z.png');
  });
  eq('custom uploads go to the configured endpoint, not a hardcoded host', calls[0], 'https://img.example.com/up');
}

// ── the real handler ────────────────────────────────────────
{
  const calls = [];
  const res = await withFetch(async (url, opts) => {
    calls.push({ url: String(url), body: opts.body });
    return { ok: true, status: 200, text: async () => JSON.stringify({ image: { url: 'https://iili.io/default.png' } }) };
  }, () => handler(uploadRequest({ apiKey: 'KEY' })));
  eq('an unconfigured upload still succeeds', res.status, 200);
  eq('an unconfigured upload returns the URL', (await res.json()).url, 'https://iili.io/default.png');
  eq('an unconfigured upload still hits freeimage.host', calls[0].url, 'https://freeimage.host/api/1/upload?key=KEY');
}

{
  const calls = [];
  const res = await withFetch(async (url) => {
    const u = String(url);
    calls.push(u);
    if (u.startsWith('https://cloudflare-dns.com/dns-query')) {
      return { ok: true, status: 200, json: async () => ({ Status: 0, Answer: [{ type: 1, data: '93.184.216.34' }] }) };
    }
    if (u === 'https://img.example.com/upload') {
      return { ok: true, status: 200, text: async () => JSON.stringify({ url: 'https://cdn.example.com/custom.png' }) };
    }
    throw new Error(`unexpected fetch ${u}`);
  }, () => handler(uploadRequest({ host: 'custom', endpoint: 'https://img.example.com/upload', apiKey: '' })));
  eq('a configured custom host is used', res.status, 200);
  eq('and its URL comes back', (await res.json()).url, 'https://cdn.example.com/custom.png');
  ok('the configured endpoint was the upload target', calls.includes('https://img.example.com/upload'), calls);
  ok('freeimage was not contacted when a host is configured', !calls.some(u => u.includes('freeimage.host')), calls);
}

{
  const calls = [];
  const res = await withFetch(async (url) => { calls.push(String(url)); throw new Error('should not fetch'); },
    () => handler(uploadRequest({ host: 'custom', endpoint: 'http://127.0.0.1:9000/upload' })));
  eq('a private custom endpoint is refused before any request', res.status, 400);
  ok('the refusal explains the address rule', /public http\(s\)/.test((await res.json()).error));
  eq('nothing was fetched for a private endpoint', calls, []);
}

{
  const res = await withFetch(async () => { throw new Error('should not fetch'); },
    () => handler(uploadRequest({ host: 'imgbb' })));
  eq('imgbb without a key is refused', res.status, 400);
  ok('the refusal asks for the key', /API key/.test((await res.json()).error));
}

{
  const res = await withFetch(async (url) => {
    if (String(url).startsWith('https://cloudflare-dns.com/dns-query')) {
      return { ok: true, status: 200, json: async () => ({ Status: 0, Answer: [{ type: 1, data: '93.184.216.34' }] }) };
    }
    return { ok: false, status: 500, text: async () => '{"error":{"message":"upstream broke"}}' };
  }, () => handler(uploadRequest({ host: 'custom', endpoint: 'https://img.example.com/upload' })));
  eq('an upstream failure is reported as a bad gateway', res.status, 502);
  eq('and the upstream message is passed through', (await res.json()).error, 'upstream broke');
}

{
  const res = await withFetch(async () => { throw new Error('dns down'); },
    () => handler(uploadRequest({ host: 'custom', endpoint: 'https://img.example.com/upload' })));
  eq('a custom host whose address cannot be verified is refused', res.status, 400);
}

{
  const res = await withFetch(async () => {
    const body = JSON.stringify({ data: { url: 'https://i.ibb.co/nested.png' } });
    return { ok: true, status: 200, text: async () => body };
  }, () => handler(uploadRequest({ host: 'imgbb', apiKey: 'K3' })));
  eq('an imgbb upload through the handler succeeds', res.status, 200);
  eq('and returns the imgbb URL', (await res.json()).url, 'https://i.ibb.co/nested.png');
}

done();
