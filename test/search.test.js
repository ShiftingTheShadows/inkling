// F40: page reading, keyless search and the SSRF/DNS-rebinding gate in
// api/search.js. Everything runs against an injected fetch, so the suite needs
// no network and can assert exactly which URLs were requested.
import { makeRunner } from './harness.js';
import {
  isPrivateAddress, safeUrl, assertPublicUrl, readPage, extractReadable,
  jinaRead, jinaSearch, parseReaderSearch, searchWeb, parseDuckDuckGo,
} from '../api/search.js';

const { eq, ok, done } = makeRunner();

const PUBLIC = '93.184.216.34';
const resolvePublic = async () => [PUBLIC];

const response = ({ status = 200, body = '', headers = {} } = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: k => headers[k.toLowerCase()] ?? null },
  text: async () => body,
  json: async () => JSON.parse(body),
});

const articleHtml = '<html><head><title>Story</title></head><body><article><p>' +
  'the quick brown fox jumps over the lazy dog '.repeat(30) + '</p></article></body></html>';
const shellHtml = '<html><head><title>App</title></head><body><div id="root"></div>' +
  '<script src="/app.js"></script></body></html>';

// ── address checks ──────────────────────────────────────────
ok('loopback v4 is private', isPrivateAddress('127.0.0.1'));
ok('private v4 ranges are private',
  ['10.1.2.3', '192.168.1.10', '172.16.0.1', '172.31.255.255', '169.254.169.254', '100.64.0.1', '0.0.0.0']
    .every(isPrivateAddress));
ok('reserved and multicast v4 are private', ['224.0.0.1', '255.255.255.255', '198.18.0.1'].every(isPrivateAddress));
ok('public v4 is allowed', !isPrivateAddress(PUBLIC) && !isPrivateAddress('1.1.1.1'));
ok('ipv6 loopback and unique-local are private',
  ['::1', '::', 'fd00::1', 'fc00::1', 'fe80::1', 'ff02::1', '::ffff:127.0.0.1'].every(isPrivateAddress));
ok('public ipv6 is allowed', !isPrivateAddress('2606:4700:4700::1111'));

eq('localhost urls are refused', safeUrl('http://localhost:3000/x'), null);
eq('loopback urls are refused', safeUrl('http://127.0.0.1/'), null);
eq('private urls are refused', safeUrl('http://10.0.0.5/'), null);
eq('cloud metadata is refused', safeUrl('http://169.254.169.254/latest/meta-data/'), null);
eq('ipv6 loopback is refused', safeUrl('http://[::1]:8080/'), null);
eq('bare internal hostnames are refused', safeUrl('http://intranet/'), null);
eq('.internal and .local are refused', safeUrl('http://db.internal/'), null);
eq('non-http schemes are refused', safeUrl('file:///etc/passwd'), null);
ok('a normal https url is allowed', safeUrl('https://example.com/page') instanceof URL);

// ── DNS rebinding ───────────────────────────────────────────
{
  const calls = [];
  const fetchImpl = async url => { calls.push(String(url)); return response({ body: articleHtml }); };
  let error = null;
  try {
    await readPage('https://rebind.example/', { fetchImpl, resolve: async () => ['127.0.0.1'] });
  } catch (e) { error = e; }
  ok('a hostname resolving to loopback is refused', error && /private address/.test(error.message), error?.message);
  eq('and the page is never fetched', calls, []);
}

{
  const calls = [];
  const fetchImpl = async url => { calls.push(String(url)); return response({ body: articleHtml }); };
  let error = null;
  try {
    await assertPublicUrl('https://rebind.example/', { fetchImpl, resolve: async () => [PUBLIC, '10.0.0.9'] });
  } catch (e) { error = e; }
  ok('any private answer poisons the whole lookup', error && /private address/.test(error.message), error?.message);
  eq('and nothing is fetched while verifying', calls, []);
}

{
  let error = null;
  try {
    await readPage('https://cannot-resolve.example/', {
      fetchImpl: async () => response({ body: articleHtml }),
      resolve: async () => { throw new Error('dns is down'); },
    });
  } catch (e) { error = e; }
  ok('an unverifiable address fails closed', error && /dns is down/.test(error.message), error?.message);
}

// Redirect to the metadata service must be re-checked, not followed blindly.
{
  const calls = [];
  const fetchImpl = async url => {
    calls.push(String(url));
    if (String(url).startsWith('https://example.com/')) {
      return response({ status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data/' } });
    }
    return response({ body: 'secret metadata' });
  };
  let error = null;
  try {
    await readPage('https://example.com/go', { fetchImpl, resolve: resolvePublic });
  } catch (e) { error = e; }
  ok('a redirect into a private address is refused', error && /not allowed|private address/.test(error.message), error?.message);
  ok('the metadata endpoint is never contacted', !calls.some(u => u.includes('169.254.169.254')), calls);
}

// ── page reading ────────────────────────────────────────────
{
  const calls = [];
  const fetchImpl = async url => { calls.push(String(url)); return response({ headers: { 'content-type': 'text/html' }, body: articleHtml }); };
  const page = await readPage('https://example.com/story', { fetchImpl, resolve: resolvePublic });
  eq('an article is read directly', page.reader, 'html');
  eq('its title comes from <title>', page.title, 'Story');
  ok('its text is real prose', /quick brown fox/.test(page.text) && page.text.length > 400, page.text.slice(0, 80));
  ok('the reader is not called for a normal page', !calls.some(u => u.startsWith('https://r.jina.ai/')), calls);
}

{
  const calls = [];
  const fetchImpl = async url => {
    calls.push(String(url));
    if (String(url).startsWith('https://r.jina.ai/')) {
      return response({
        headers: { 'content-type': 'text/plain' },
        body: 'Title: Rendered App\nURL Source: https://spa.example/page\nMarkdown Content:\n' +
          'This text only exists after JavaScript runs. '.repeat(8),
      });
    }
    return response({ headers: { 'content-type': 'text/html' }, body: shellHtml });
  };
  const page = await readPage('https://spa.example/page', { fetchImpl, resolve: resolvePublic });
  eq('a JS-rendered shell is read through the renderer', page.reader, 'jina');
  ok('the rendered text is returned', /only exists after JavaScript runs/.test(page.text), page.text.slice(0, 80));
  ok('the reader was asked for that exact page', calls.includes('https://r.jina.ai/https://spa.example/page'), calls);
  eq('the shell text is not returned as content', extractReadable(shellHtml), '');
}

{
  // Jina's anonymous tier can answer with a JSON refusal. That must fall back
  // to the shell text instead of putting JSON into the model's context.
  const fetchImpl = async url => {
    if (String(url).startsWith('https://r.jina.ai/')) {
      return response({ headers: { 'content-type': 'text/plain' }, body: '{"code":401,"message":"blocked"}' });
    }
    return response({ headers: { 'content-type': 'text/html' }, body: shellHtml });
  };
  const page = await readPage('https://spa.example/page', { fetchImpl, resolve: resolvePublic });
  eq('a refused reader falls back to the direct read', page.reader, 'html');
  ok('and never returns the JSON error as page text', !page.text.includes('"code"'), page.text);
  eq('jinaRead reports a refusal as no content', await jinaRead('https://spa.example/page', fetchImpl), null);
}

// ── keyless search ──────────────────────────────────────────
const ddgHtml = [
  '<a class="result__a" href="https://example.com/one">First &amp; best</a>',
  '<div class="result__snippet" href="x">First snippet</div></a>',
  '<a class="result__a" href="https://example.com/two">Second</a>',
  '<div class="result__snippet" href="x">Second snippet</div></a>',
].join('');
eq('ddg markup parses into results', parseDuckDuckGo(ddgHtml, 5).map(r => r.url), ['https://example.com/one', 'https://example.com/two']);

{
  const calls = [];
  const fetchImpl = async url => {
    calls.push(String(url));
    if (String(url).includes('duckduckgo')) return response({ headers: { 'content-type': 'text/html' }, body: ddgHtml });
    throw new Error(`unexpected fetch ${url}`);
  };
  // No key arguments at all: keyless has to work on its own.
  const out = await searchWeb({ provider: 'auto', query: 'inkling', max: 5 }, { fetchImpl });
  eq('keyless search uses DuckDuckGo when it answers', out.provider, 'ddg');
  eq('and returns its results', out.results.map(r => r.url), ['https://example.com/one', 'https://example.com/two']);
  ok('the reader is not needed when DDG works', !calls.some(u => u.includes('s.jina.ai')), calls);
}

{
  const calls = [];
  const fetchImpl = async url => {
    calls.push(String(url));
    if (String(url).includes('duckduckgo')) {
      return response({ status: 202, headers: { 'content-type': 'text/html' }, body: '<html>anomaly: unusual traffic</html>' });
    }
    if (String(url).includes('s.jina.ai')) {
      return response({
        headers: { 'content-type': 'text/plain' },
        body: '# Search Results\n[Inkling manual](https://example.com/manual)\nThe manual.\n' +
          '[Second result](https://example.com/second)\nAnother one.\n',
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  const out = await searchWeb({ provider: 'auto', query: 'inkling', max: 5 }, { fetchImpl });
  eq('a blocked DDG request falls back to the keyless reader search', out.provider, 'ddg+reader');
  eq('the fallback still returns usable results',
    out.results.map(r => r.url), ['https://example.com/manual', 'https://example.com/second']);
  eq('results carry titles', out.results[0].title, 'Inkling manual');
  ok('both keyless paths were tried', calls.some(u => u.includes('duckduckgo')) && calls.some(u => u.includes('s.jina.ai')), calls);
}

{
  let error = null;
  try {
    await searchWeb({ provider: 'auto', query: 'x', max: 3 }, {
      fetchImpl: async url => {
        if (String(url).includes('duckduckgo')) throw new Error('DuckDuckGo 503');
        return response({ status: 500, body: 'nope' });
      },
    });
  } catch (e) { error = e; }
  ok('when both keyless paths fail the DDG error is reported', error && /DuckDuckGo 503/.test(error.message), error?.message);
}

eq('reader markup with no links yields nothing', parseReaderSearch('just prose', 5), []);

{
  const results = await jinaSearch('q', 5, async () => response({
    headers: { 'content-type': 'text/plain' },
    body: '[One](https://one.example/a)\n[Two](https://two.example/b)\n',
  }));
  eq('reader search parses markdown links', results.map(r => r.url), ['https://one.example/a', 'https://two.example/b']);
}

done();
