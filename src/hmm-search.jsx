// hmm-search.jsx — model-driven web search.
//
// The model decides WHEN to search and writes its own query (via tool calls),
// instead of every request getting the raw roleplay message shoved into a
// search engine. Results come back through /api/search (Tavily, Brave, or
// keyless DuckDuckGo) and are surfaced on the message as sources.
// Claude uses Anthropic's native web_search tool; see callAI in hmm-utils.jsx.

const WebSearch = {
  enabled: s => !!s?.webSearch,

  maxUses: s => Math.max(1, Math.min(Number(s?.searchMaxUses) || 3, 8)),
  maxResults: s => Math.max(1, Math.min(Number(s?.searchMaxResults) || 5, 10)),

  // Instructions appended to the system prompt whenever search is on.
  note(roleplay, native = false) {
    const tools = (native ? 'You have a web_search tool. ' : 'You have web_search and read_page tools. ')
      + 'Use it only for real-world, recent, or factual questions you cannot answer reliably from memory — never for in-story events or small talk. '
      + 'Write queries the way a person types into a search engine (topic keywords), never roleplay text or asterisk actions.'
      + (native ? '' : ' If snippets are not enough, call read_page on the most promising result.');
    return roleplay
      ? `[WEB ACCESS]\n${tools} After searching, answer fully in character and work the facts in naturally; do not paste URLs, say "according to search results", or break character. If a search fails or finds nothing, stay in character and say you are not sure rather than inventing facts.`
      : `[WEB ACCESS]\n${tools} Prefer fresh sources, name the source site when you rely on it, and say so plainly if a search fails or finds nothing instead of guessing.`;
  },

  // OpenAI-format tool definitions for the client-side tool loop.
  tools: [
    { type: 'function', function: {
      name: 'web_search',
      description: 'Search the web. Returns titles, URLs and snippets for the top results.',
      parameters: { type: 'object', properties: { query: { type: 'string', description: 'Search-engine style keywords' } }, required: ['query'] },
    } },
    { type: 'function', function: {
      name: 'read_page',
      description: 'Fetch a web page and return its readable text. Use on a URL from search results.',
      parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
    } },
  ],

  host(url) { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; } },
  isHttp: url => /^https?:\/\//i.test(url || ''),

  async post(body, signal) {
    let resp;
    try {
      resp = await fetch('/api/search', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      throw new Error('search backend unreachable');
    }
    if (resp.status === 404) throw new Error('search backend (/api/search) is not deployed here');
    const j = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(j.error || `search failed (${resp.status})`);
    return j;
  },

  async search(query, settings, signal) {
    const provider = settings.searchBackend && settings.searchBackend !== 'native' ? settings.searchBackend : 'auto';
    return this.post({
      action: 'search', provider, query, max: this.maxResults(settings),
      tavilyKey: settings.tavilyKey || '', braveKey: settings.braveKey || '',
    }, signal);
  },

  // Executes one tool call. `state` ({queries, sources}) is mutated so the UI
  // can show what was searched and where the facts came from. Always resolves
  // to a string for the model — failures are reported, not thrown, so it can
  // recover gracefully (except aborts, which propagate).
  async runTool(name, args, settings, signal, state) {
    try {
      if (name === 'read_page') {
        const url = String(args.url || '');
        const page = await this.post({ action: 'read', url }, signal);
        this.addSource(state, { title: page.title || this.host(url), url: page.url || url });
        return `${page.title ? page.title + '\n' : ''}${page.url}\n\n${page.text}`;
      }
      const query = String(args.query || '').trim();
      if (!query) return 'No query given.';
      state.queries.push(query);
      const { results } = await this.search(query, settings, signal);
      if (!results.length) return `No results for "${query}". Try different keywords.`;
      results.forEach(r => this.addSource(state, r));
      return results.map((r, i) => `[${i + 1}] ${r.title}\n${r.url}\n${r.content || r.snippet || ''}`).join('\n\n');
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      return `Search error: ${e.message}. Tell the user you could not look this up and answer from what you know, flagging uncertainty.`;
    }
  },

  addSource(state, r) {
    if (!r?.url || !this.isHttp(r.url) || state.sources.some(s => s.url === r.url)) return;
    state.sources.push({ title: (r.title || this.host(r.url)).slice(0, 140), url: r.url });
  },

  // Fallback for models/endpoints that reject tools: search once on the last
  // user message (action asterisks and brackets stripped) and hand the model
  // the results as context.
  async preRetrieve(messages, settings, signal, state) {
    const last = [...messages].reverse().find(m => m.role === 'user');
    const raw = typeof last?.content === 'string' ? last.content : '';
    const query = raw.replace(/\*[^*]*\*/g, ' ').replace(/\[[^\]]*\]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
    if (query.length < 4) return '';
    const out = await this.runTool('web_search', { query }, settings, signal, state);
    return out.startsWith('Search error') || out.startsWith('No results') ? '' : `[WEB RESULTS for "${query}"]\n${out}`;
  },
};

Object.assign(window, { WebSearch });
