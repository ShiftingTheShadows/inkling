// Web search + page reader for Inkling's built-in search tool.
// Like api/anthropic.js, the client sends its own provider key (kept in the
// browser); nothing is stored here. Providers:
//   tavily — LLM-oriented results with extracted page text (best quality)
//   brave  — Brave Search API
//   ddg    — no key; scrapes DuckDuckGo's HTML endpoint (best effort), then
//            falls back to Jina's reader search when DDG blocks or returns
//            nothing, so keyless search still works with no key at all.
// POST { action: 'search', provider, key, query, max }  -> { results: [{title,url,snippet,content?}], provider }
// POST { action: 'read', url }                          -> { url, title, text, reader }
//
// F40: `read` renders client-side pages through r.jina.ai when the raw HTML is
// only an empty shell, and every outbound page URL (including each redirect
// hop) is checked against DNS before it is fetched, so a hostname that looks
// public but resolves to 127.0.0.1 / 169.254.169.254 is refused.

export const config = { runtime: 'edge' };

// A real browser UA: DuckDuckGo answers a bot UA with a 202 "anomaly" page,
// which is what silently broke keyless search. Send ONLY the UA - adding
// Accept/Accept-Language headers puts DDG back on the anomaly page, so the
// minimal browser identity is the one that works.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const HTML_HEADERS = { 'User-Agent': UA };
const DOH_ENDPOINT = 'https://cloudflare-dns.com/dns-query';
const READER_PREFIX = 'https://r.jina.ai';
const READER_SEARCH = 'https://s.jina.ai';
// Below this much extracted text, a text/html response is treated as a
// client-rendered shell (React root, script tags, no prose) and re-read through
// the renderer. A real article is far above it.
const MIN_ARTICLE_CHARS = 400;
const MAX_REDIRECTS = 3;

const clip = (s, n) => (s || '').replace(/\s+/g, ' ').trim().slice(0, n);
const decode = s => (s || '')
  .replace(/<[^>]+>/g, '')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&nbsp;/g, ' ')
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));

async function tavily(key, query, max, fetchImpl = fetch) {
  const r = await fetchImpl('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ query, max_results: max, search_depth: 'basic', include_answer: false }),
  });
  if (!r.ok) throw new Error(`Tavily ${r.status}: ${clip(await r.text(), 160)}`);
  const j = await r.json();
  return (j.results || []).map(x => ({ title: x.title, url: x.url, snippet: clip(x.content, 400), content: clip(x.content, 1500) }));
}

async function brave(key, query, max, fetchImpl = fetch) {
  const r = await fetchImpl(`https://api.search.brave.com/res/v1/web/search?count=${max}&q=${encodeURIComponent(query)}`, {
    headers: { Accept: 'application/json', 'X-Subscription-Token': key },
  });
  if (!r.ok) throw new Error(`Brave ${r.status}: ${clip(await r.text(), 160)}`);
  const j = await r.json();
  return (j.web?.results || []).map(x => ({
    title: decode(x.title), url: x.url,
    snippet: clip(decode(x.description), 400),
    content: clip([decode(x.description), ...(x.extra_snippets || []).map(decode)].join(' '), 1200),
  }));
}

// Pure so the parsing can be tested against captured DDG markup.
export function parseDuckDuckGo(html, max = 5) {
  const out = [];
  const source = String(html || '');
  const links = [...source.matchAll(/<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)];
  for (let i = 0; i < links.length && out.length < max; i++) {
    const m = links[i];
    // Snippet lives between this link and the next result's link
    const block = source.slice(m.index + m[0].length, links[i + 1]?.index ?? source.length);
    const snip = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/);
    let url = m[1].replace(/&amp;/g, '&');
    const redirect = url.match(/[?&]uddg=([^&]+)/);
    if (redirect) url = decodeURIComponent(redirect[1]);
    if (url.startsWith('//')) url = 'https:' + url;
    if (!/^https?:\/\//.test(url) || /duckduckgo\.com\/y\.js/.test(url)) continue; // skip ads
    out.push({ title: clip(decode(m[2]), 140), url, snippet: clip(decode(snip?.[1]), 400) });
  }
  return out;
}

async function ddg(query, max, fetchImpl = fetch) {
  // GET, not POST: the POST form returns DDG's anomaly page even with browser
  // headers, while GET with the same headers returns the result list.
  const r = await fetchImpl(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, { headers: HTML_HEADERS });
  if (!r.ok) throw new Error(`DuckDuckGo ${r.status}`);
  const html = await r.text();
  const out = parseDuckDuckGo(html, max);
  if (!out.length && /anomaly|captcha|unusual traffic/i.test(html)) throw new Error('DuckDuckGo blocked the request — add a Tavily or Brave key in Settings');
  return out;
}

// Reader results are markdown links, sometimes with a fenced block per result.
// Pure so a captured reader page can be tested without the network.
export function parseReaderSearch(text, max = 5) {
  const out = [];
  const seen = new Set();
  const source = String(text || '');
  for (const m of source.matchAll(/\[([^\]\n]{3,160})\]\((https?:\/\/[^)\s]+)\)/g)) {
    const url = m[2];
    if (!/^https?:\/\//.test(url) || /(^|\.)jina\.ai\//.test(url)) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    out.push({ title: clip(decode(m[1]), 140), url, snippet: '' });
    if (out.length >= max) break;
  }
  return out;
}

// Keyless fallback for search: Jina's reader search needs no key and renders
// its own pages, so it survives when DDG's HTML endpoint starts blocking.
export async function jinaSearch(query, max, fetchImpl = fetch) {
  const r = await fetchImpl(`${READER_SEARCH}/${encodeURIComponent(query)}`, {
    headers: { 'User-Agent': UA, Accept: 'text/plain' },
  });
  if (!r.ok) throw new Error(`Reader search ${r.status}`);
  const results = parseReaderSearch(await r.text(), max);
  if (!results.length) throw new Error('Reader search returned no results');
  return results;
}

// ── address sanity ────────────────────────────────────────────────────────
// Rejects anything that is not a public unicast destination. Hostname checks
// alone can't do this: a hostile domain can resolve to a private address
// (DNS rebinding), so the resolved answer is checked too.
export function isPrivateAddress(ip) {
  const raw = String(ip || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!raw) return true;
  const mapped = raw.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  const v4 = mapped ? mapped[1] : raw;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(v4)) {
    const [a, b] = v4.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;          // link-local / cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
    if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
    if (a >= 224) return true;                         // multicast, reserved, broadcast
    return false;
  }
  if (v4 === '::' || v4 === '::1') return true;
  if (/^fe[89ab]/.test(v4)) return true; // link-local fe80::/10
  if (/^f[cd]/.test(v4)) return true;    // unique-local fc00::/7
  if (/^ff/.test(v4)) return true;       // multicast
  return false;
}

const isIpLiteral = h => /^\d+\.\d+\.\d+\.\d+$/.test(h) || h.includes(':');

// Refuse obviously internal targets — this runs on someone's server.
export function safeUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return null;
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return null;
  if (!isIpLiteral(h) && !h.includes('.')) return null; // bare hostname, e.g. http://intranet/
  if (isIpLiteral(h) && isPrivateAddress(h)) return null;
  return u;
}

// Resolve through DNS-over-HTTPS so the check works where the runtime has no
// resolver API (edge/serverless). Fails closed: if the address cannot be
// verified, the page is not fetched.
export async function resolveHostIps(host, fetchImpl = fetch) {
  const ips = new Set();
  for (const type of ['A', 'AAAA']) {
    const r = await fetchImpl(`${DOH_ENDPOINT}?name=${encodeURIComponent(host)}&type=${type}`, {
      headers: { Accept: 'application/dns-json' },
    });
    if (!r.ok) throw new Error(`Could not look up ${host} (${r.status})`);
    let j = null;
    try { j = await r.json(); } catch { j = null; }
    if (!j || j.Status !== 0) continue;
    for (const a of j.Answer || []) {
      if ((a.type === 1 || a.type === 28) && a.data) ips.add(String(a.data));
    }
  }
  return [...ips];
}

// The one gate every outbound page request goes through: URL rules plus a
// verified public address for the host.
export async function assertPublicUrl(raw, { fetchImpl = fetch, resolve = resolveHostIps } = {}) {
  const u = safeUrl(raw);
  if (!u) throw new Error('That URL is not allowed');
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (isIpLiteral(host)) {
    if (isPrivateAddress(host)) throw new Error('That URL points at a private address');
    return u;
  }
  const ips = await resolve(host, fetchImpl);
  if (!ips.length) throw new Error(`Could not resolve ${host}`);
  if (ips.some(isPrivateAddress)) throw new Error('That URL points at a private address');
  return u;
}

// Manual redirect handling so every hop is re-checked; `redirect: 'follow'`
// would let a public page bounce the request into the metadata service.
export async function fetchPublic(raw, { fetchImpl = fetch, resolve = resolveHostIps } = {}) {
  let target = await assertPublicUrl(raw, { fetchImpl, resolve });
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await fetchImpl(target.toString(), { headers: HTML_HEADERS, redirect: 'manual' });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) throw new Error(`Page returned ${res.status} without a location`);
      target = await assertPublicUrl(new URL(loc, target).toString(), { fetchImpl, resolve });
      continue;
    }
    return { res, url: target };
  }
  throw new Error('Too many redirects');
}

export function extractReadable(html) {
  const body = String(html || '')
    .replace(/<(head|title|script|style|noscript|svg|nav|footer|header|form|aside)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|li|h[1-6]|tr|br|section|article)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n');
  return decode(body).replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
}

// r.jina.ai renders the page (JS included) and answers with a small header
// block plus markdown. Its anonymous tier can refuse an IP with a JSON error,
// which must be treated as "no reader" rather than as page content.
export async function jinaRead(url, fetchImpl = fetch) {
  const r = await fetchImpl(`${READER_PREFIX}/${url}`, { headers: { 'User-Agent': UA, Accept: 'text/plain' } });
  if (!r.ok) return null;
  const raw = await r.text();
  const trimmed = raw.trim();
  if (trimmed.startsWith('{')) {
    try { const j = JSON.parse(trimmed); if (j && (j.code || j.error || j.data === null)) return null; } catch { /* not JSON after all */ }
  }
  const title = decode((raw.match(/^Title:\s*(.+)$/m) || [])[1] || '').trim();
  const text = decode(raw
    .replace(/^(Title|URL Source|Published Time|Description|Markdown Content):.*$/gm, '')
    .replace(/^Markdown Content:\s*/i, ''))
    .trim();
  if (text.length < 80) return null;
  return { title: clip(title, 160), text: text.slice(0, 20000) };
}

export async function readPage(raw, { fetchImpl = fetch, resolve = resolveHostIps } = {}) {
  const { res, url } = await fetchPublic(raw, { fetchImpl, resolve });
  if (!res.ok) throw new Error(`Page returned ${res.status}`);
  const type = res.headers.get('content-type') || '';
  if (!/text\/|html|xml|json/.test(type)) throw new Error(`Not a readable page (${type || 'unknown type'})`);
  const html = (await res.text()).slice(0, 600000);
  const title = decode((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '');
  const direct = extractReadable(html);

  // A JS-rendered page arrives as an empty shell: fetch it through the reader
  // instead of returning a page with no prose in it.
  if (/text\/html/i.test(type) && direct.length < MIN_ARTICLE_CHARS) {
    const rendered = await jinaRead(url.toString(), fetchImpl).catch(() => null);
    if (rendered && rendered.text.length > direct.length) {
      return { url: url.toString(), title: rendered.title || clip(title, 160), text: rendered.text.slice(0, 7000), reader: 'jina' };
    }
  }
  return { url: url.toString(), title: clip(title, 160), text: direct.slice(0, 7000), reader: 'html' };
}

// Search with whatever is available. No key at all is a supported state: DDG
// is tried first, and when it blocks, the reader search takes over.
export async function searchWeb({ provider, key, query, max }, { fetchImpl = fetch } = {}) {
  if (provider === 'tavily') return { provider, results: await tavily(key, query, max, fetchImpl) };
  if (provider === 'brave') return { provider, results: await brave(key, query, max, fetchImpl) };

  let ddgError = null;
  try {
    const results = await ddg(query, max, fetchImpl);
    if (results.length) return { provider: 'ddg', results };
  } catch (e) { ddgError = e; }
  try {
    return { provider: 'ddg+reader', results: await jinaSearch(query, max, fetchImpl) };
  } catch (e) {
    throw ddgError || e;
  }
}

export default async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  let p;
  try { p = await req.json(); } catch { return Response.json({ error: 'Invalid JSON body' }, { status: 400 }); }

  try {
    if (p.action === 'read') return Response.json(await readPage(p.url), { headers: { 'Cache-Control': 'no-store' } });

    const query = clip(p.query, 300);
    if (!query) return Response.json({ error: 'Missing query' }, { status: 400 });
    const max = Math.max(1, Math.min(Number(p.max) || 5, 10));
    let provider = p.provider;
    if (!provider || provider === 'auto') provider = p.tavilyKey ? 'tavily' : p.braveKey ? 'brave' : 'ddg';
    const key = p.key || (provider === 'tavily' ? p.tavilyKey : provider === 'brave' ? p.braveKey : '');
    if ((provider === 'tavily' || provider === 'brave') && !key) {
      return Response.json({ error: `No ${provider} API key set` }, { status: 400 });
    }
    const { provider: used, results } = await searchWeb({ provider, key, query, max });
    return Response.json({ provider: used, results }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    return Response.json({ error: e.message || 'Search failed' }, { status: 502 });
  }
};
