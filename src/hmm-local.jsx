// hmm-local.jsx — Local Models manager: self-host text models with Ollama.
// Detects a running Ollama, lists installed models, pulls new ones with a
// progress bar, deletes them, and points Inkling's "Local" provider at one.
const { useState, useEffect, useContext, useRef } = React;
const { AppCtx } = window;

const OLLAMA_DEFAULT = 'http://localhost:11434';
// Approximate download sizes (Q4). Tool-capable ones can also use web search.
const LOCAL_SUGGESTIONS = [
  ['llama3.2:3b', '~2 GB', 'Tiny and quick. Runs on almost anything, including CPU-only.'],
  ['qwen3:8b', '~5 GB', 'Strong all-rounder at 8B; good instruction following.'],
  ['llama3.1:8b', '~5 GB', 'Reliable general model with tool support.'],
  ['hermes3:8b', '~5 GB', 'Llama-based, steerable, less preachy — popular for roleplay.'],
  ['gemma2:9b', '~5.5 GB', 'Fluent, creative prose.'],
  ['mistral-nemo', '~7 GB', '12B with a big context window; a roleplay favourite.'],
];

const ollamaBase = ep => (ep || OLLAMA_DEFAULT).trim().replace(/\/+$/, '').replace(/\/v1$/, '');
const fmtSize = b => b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.round(b / 1e6)} MB`;

async function timedFetch(url, opts = {}, ms = 4000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ctl.signal }); } finally { clearTimeout(t); }
}

function LocalModelsModal({ onClose }) {
  const ctx = useContext(AppCtx);
  const s = ctx.settings;
  const [endpoint, setEndpoint] = useState(s.provider === 'local' && s.localEndpoint ? s.localEndpoint : OLLAMA_DEFAULT);
  const [status, setStatus] = useState({ state: 'checking' });
  const [models, setModels] = useState([]);
  const [pull, setPull] = useState(null); // { name, text, pct }
  const [custom, setCustom] = useState('');
  const abortRef = useRef(null);
  const base = ollamaBase(endpoint);

  const refresh = async () => {
    setStatus({ state: 'checking' });
    try {
      const v = await (await timedFetch(`${base}/api/version`)).json();
      const tags = await (await timedFetch(`${base}/api/tags`)).json();
      setModels((tags.models || []).sort((a, b) => a.name.localeCompare(b.name)));
      setStatus({ state: 'up', version: v.version });
    } catch {
      setModels([]);
      setStatus({ state: 'down' });
    }
  };
  useEffect(() => { refresh(); return () => abortRef.current?.abort(); }, []);

  const useModel = name => {
    ctx.saveSettings({ ...ctx.settings, provider: 'local', localEndpoint: base, localModel: name });
    ctx.addToast(`Now chatting with ${name}`, 'success');
  };

  const doPull = async name => {
    name = name.trim();
    if (!name || pull) return;
    const ctl = new AbortController();
    abortRef.current = ctl;
    setPull({ name, text: 'starting…', pct: 0 });
    try {
      const resp = await fetch(`${base}/api/pull`, { method: 'POST', body: JSON.stringify({ model: name, stream: true }), signal: ctl.signal });
      if (!resp.ok) throw new Error(`${resp.status} ${(await resp.text()).slice(0, 160)}`);
      const reader = resp.body.getReader();
      const dec = new TextDecoder();
      let buf = '', ok = false;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() || '';
        for (const line of lines) {
          if (!line.trim()) continue;
          const j = JSON.parse(line);
          if (j.error) throw new Error(j.error);
          if (j.status === 'success') ok = true;
          setPull({ name, text: j.status, pct: j.total ? Math.round((j.completed || 0) / j.total * 100) : null });
        }
      }
      if (!ok) throw new Error('download ended early');
      ctx.addToast(`${name} downloaded`, 'success');
      setCustom('');
      await refresh();
    } catch (e) {
      if (e.name !== 'AbortError') ctx.addToast(`Pull failed: ${e.message}`, 'error');
    } finally {
      abortRef.current = null;
      setPull(null);
    }
  };

  const remove = async name => {
    if (!window.confirm(`Delete ${name} from disk? You can pull it again later.`)) return;
    try {
      const r = await timedFetch(`${base}/api/delete`, { method: 'DELETE', body: JSON.stringify({ model: name, name }) }, 15000);
      if (!r.ok) throw new Error(`${r.status}`);
      await refresh();
    } catch (e) { ctx.addToast(`Delete failed: ${e.message}`, 'error'); }
  };

  const installed = new Set(models.map(m => m.name.replace(/:latest$/, '')));
  const isInstalled = n => installed.has(n) || installed.has(n.replace(/:latest$/, ''));
  const active = s.provider === 'local' ? s.localModel : null;
  const box = { background: 'var(--surface2)', border: '1px solid var(--border2)', padding: '12px 16px', marginBottom: 16, fontSize: 11, color: 'var(--text2)', lineHeight: 1.8 };
  const code = t => <code style={{ background: 'var(--bg)', padding: '1px 5px', border: '1px solid var(--border2)' }}>{t}</code>;

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && !pull && onClose()}>
      <div className="modal modal-lg">
        <div className="modal-header">
          <span className="modal-title">LOCAL MODELS</span>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>
        <div className="modal-body">
          <div style={box}>
            Run text models on your own machine with <b style={{ color: 'var(--text)' }}>Ollama</b> — private, free, offline. Nothing you write leaves your computer.
            Rule of thumb: a model needs about its download size <b style={{ color: 'var(--text)' }}>+ 2–3 GB</b> of free RAM (or VRAM on a GPU, which is much faster).
          </div>

          <div className="form-group">
            <label className="form-label">OLLAMA ADDRESS</label>
            <div style={{ display: 'flex', gap: 8 }}>
              <input className="form-input" value={endpoint} onChange={e => setEndpoint(e.target.value)} onKeyDown={e => e.key === 'Enter' && refresh()} placeholder={OLLAMA_DEFAULT} />
              <button className="btn-secondary" onClick={refresh} disabled={!!pull}>CHECK</button>
            </div>
            <div className="form-hint" style={{ color: status.state === 'up' ? 'var(--accent2)' : status.state === 'down' ? 'var(--warning)' : 'var(--text3)' }}>
              {status.state === 'checking' && 'Checking…'}
              {status.state === 'up' && `✓ Ollama ${status.version} is running — ${models.length} model${models.length !== 1 ? 's' : ''} installed`}
              {status.state === 'down' && '✗ Can\'t reach Ollama at that address.'}
            </div>
          </div>

          {status.state === 'down' && (
            <div style={box}>
              <div style={{ fontWeight: 700, color: 'var(--text)', fontSize: 10, letterSpacing: '0.1em', marginBottom: 6 }}>GET OLLAMA RUNNING</div>
              1. Install it (Linux): {code('curl -fsSL https://ollama.com/install.sh | sh')} — macOS/Windows installers at ollama.com/download.<br />
              2. Make sure it's running: {code('ollama serve')} (the Linux installer already sets it up as a service).<br />
              3. Hit CHECK.<br />
              <span style={{ color: 'var(--text3)' }}>
                Using the hosted website instead of the desktop app? Browsers block it unless you allow the site:
                {' '}{code('OLLAMA_ORIGINS=https://your-site.example ollama serve')}. The desktop app needs nothing extra.
                LM Studio / llama.cpp servers work too — pick <i>Local</i> in Settings and enter their address; they just aren't managed here.
              </span>
            </div>
          )}

          {pull && (
            <div style={{ ...box, borderColor: 'var(--accent)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                <span style={{ color: 'var(--text)', fontWeight: 700 }}>Downloading {pull.name}</span>
                <button className="btn-secondary btn-sm" onClick={() => abortRef.current?.abort()}>CANCEL</button>
              </div>
              <div style={{ height: 8, background: 'var(--bg)', border: '1px solid var(--border2)' }}>
                <div style={{ height: '100%', width: `${pull.pct ?? 5}%`, background: 'var(--accent)', transition: 'width 0.2s' }} />
              </div>
              <div style={{ marginTop: 4, color: 'var(--text3)' }}>{pull.pct != null ? `${pull.pct}% · ` : ''}{pull.text}</div>
            </div>
          )}

          {status.state === 'up' && (
            <>
              <div className="settings-section-title">INSTALLED</div>
              {models.length === 0 && <div className="form-hint" style={{ marginBottom: 12 }}>Nothing yet — pick one below to download.</div>}
              {models.map(m => (
                <div key={m.name} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {m.name} {active === m.name && <span style={{ color: 'var(--accent)', fontSize: 9, letterSpacing: '0.1em', marginLeft: 6 }}>IN USE</span>}
                    </div>
                    <div style={{ fontSize: 10, color: 'var(--text3)' }}>{[m.details?.parameter_size, m.details?.quantization_level, fmtSize(m.size)].filter(Boolean).join(' · ')}</div>
                  </div>
                  <button className="btn-primary btn-sm" disabled={active === m.name} onClick={() => useModel(m.name)}>USE</button>
                  <button className="btn-secondary btn-sm" style={{ color: 'var(--danger)' }} onClick={() => remove(m.name)} disabled={!!pull}>DELETE</button>
                </div>
              ))}

              <div className="settings-section-title" style={{ marginTop: 20 }}>DOWNLOAD A MODEL</div>
              {LOCAL_SUGGESTIONS.map(([name, size, blurb]) => (
                <div key={name} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)' }}>{name} <span style={{ color: 'var(--text3)', fontWeight: 400 }}>{size}</span></div>
                    <div style={{ fontSize: 10, color: 'var(--text3)' }}>{blurb}</div>
                  </div>
                  {isInstalled(name)
                    ? <span style={{ fontSize: 10, color: 'var(--accent2)' }}>✓ INSTALLED</span>
                    : <button className="btn-secondary btn-sm" disabled={!!pull} onClick={() => doPull(name)}>PULL</button>}
                </div>
              ))}
              <div className="form-group" style={{ marginTop: 14 }}>
                <label className="form-label">ANY OTHER MODEL</label>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input className="form-input" value={custom} onChange={e => setCustom(e.target.value)} onKeyDown={e => e.key === 'Enter' && doPull(custom)}
                    placeholder="name from ollama.com/library, or hf.co/user/repo:Q4_K_M" />
                  <button className="btn-secondary" disabled={!custom.trim() || !!pull} onClick={() => doPull(custom)}>PULL</button>
                </div>
                <div className="form-hint">Any GGUF on Hugging Face works via <code>hf.co/user/repo:quant</code> — that's how community roleplay finetunes get in.</div>
              </div>
              <div className="form-hint">Web search needs a model that supports tool calls (llama3.1, qwen3, mistral-nemo…). Others still get search results automatically via a fallback.</div>
            </>
          )}
        </div>
        <div className="modal-footer">
          <button className="btn-primary" onClick={onClose} disabled={!!pull}>DONE</button>
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { LocalModelsModal });
