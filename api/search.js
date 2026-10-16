// Web search + page reader for Inkling's built-in search tool.
// Like api/anthropic.js, the client sends its own provider key (kept in the
// browser); nothing is stored here. Providers:
//   tavily — LLM-oriented results with extracted page text (best quality)
//   brave  — Brave Search API
//   ddg    — no key; scrapes DuckDuckGo's HTML endpoint (best effort)
// POST { action: 'search', provider, key, query, max }  -> { results: [{title,url,snippet,content?}], provider }
// POST { action: 'read', url }                          -> { url, title, text }

export const config = { runtime: 'edge' };

const UA = 'Mozilla/5.0 (compatible; InklingBot/1.0)';
const clip = (s, n) => (s || '').replace(/\s+/g, ' ').trim().slice(0, n);
const decode = s => (s || '')
  .replace(/<[^>]+>/g, '')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&nbsp;/g, ' ')
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));

async function tavily(key, query, max) {
  const r = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ query, max_results: max, search_depth: 'basic', include_answer: false }),
  });
  if (!r.ok) throw new Error(`Tavily ${r.status}: ${clip(await r.text(), 160)}`);
  const j = await r.json();
  return (j.results || []).map(x => ({ title: x.title, url: x.url, snippet: clip(x.content, 400), content: clip(x.content, 1500) }));
}

async function brave(key, query, max) {
  const r = await fetch(`https://api.search.brave.com/res/v1/web/search?count=${max}&q=${encodeURIComponent(query)}`, {
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

async function ddg(query, max) {
  const r = await fetch('https://html.duckduckgo.com/html/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA },
    body: 'q=' + encodeURIComponent(query),
  });
  if (!r.ok) throw new Error(`DuckDuckGo ${r.status}`);
  const html = await r.text();
  const out = [];
  const links = [...html.matchAll(/<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)];
  for (let i = 0; i < links.length && out.length < max; i++) {
    const m = links[i];
    // Snippet lives between this link and the next result's link
    const block = html.slice(m.index + m[0].length, links[i + 1]?.index ?? html.length);
    const snip = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/);
    let url = m[1].replace(/&amp;/g, '&');
    const redirect = url.match(/[?&]uddg=([^&]+)/);
    if (redirect) url = decodeURIComponent(redirect[1]);
    if (url.startsWith('//')) url = 'https:' + url;
    if (!/^https?:\/\//.test(url) || /duckduckgo\.com\/y\.js/.test(url)) continue; // skip ads
    out.push({ title: clip(decode(m[2]), 140), url, snippet: clip(decode(snip?.[1]), 400) });
  }
  if (!out.length && /anomaly|captcha|unusual traffic/i.test(html)) throw new Error('DuckDuckGo blocked the request — add a Tavily or Brave key in Settings');
  return out;
}

// Refuse obviously internal targets — this runs on someone's server.
function safeUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  const h = u.hostname.toLowerCase();
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal') || !h.includes('.') && !h.includes(':')) return null;
  if (/^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.)/.test(h) || h === '::1' || h.startsWith('[')) return null;
  return u;
}

async function readPage(raw) {
  const u = safeUrl(raw);
  if (!u) throw new Error('That URL is not allowed');
  const r = await fetch(u, { headers: { 'User-Agent': UA, Accept: 'text/html,text/plain' }, redirect: 'follow' });
  if (!r.ok) throw new Error(`Page returned ${r.status}`);
  const type = r.headers.get('content-type') || '';
  if (!/text\/|html|xml|json/.test(type)) throw new Error(`Not a readable page (${type || 'unknown type'})`);
  const html = (await r.text()).slice(0, 600000);
  const title = decode((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '');
  const body = html
    .replace(/<(head|title|script|style|noscript|svg|nav|footer|header|form|aside)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|li|h[1-6]|tr|br|section|article)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n');
  const text = decode(body).replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
  return { url: u.toString(), title: clip(title, 160), text: text.slice(0, 7000) };
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
    const results = provider === 'tavily' ? await tavily(key, query, max)
      : provider === 'brave' ? await brave(key, query, max)
      : await ddg(query, max);
    return Response.json({ provider, results }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    return Response.json({ error: e.message || 'Search failed' }, { status: 502 });
  }
};
