// hmm-chat.jsx — Chat view, messages, input
const { useState, useContext, useEffect, useRef } = React;
const { AppCtx, S, genId, estimateTokens, formatTime, renderMarkdown, charBg, charFg, callAI, buildSystemPrompt, summarizeMessages, compressImage, downloadCharJson, downloadCharPng } = window;
const { CharAvatar } = window;

function UserAvatar({ persona, size = 32 }) {
  const name = persona?.name || 'You';
  const [failed, setFailed] = useState(false);
  if (persona?.avatar && !failed) {
    return (
      <img
        src={persona.avatar} alt={name} onError={() => setFailed(true)}
        style={{ width: size, height: size, objectFit: 'cover', flexShrink: 0, border: '1px solid var(--border2)' }}
      />
    );
  }
  return (
    <div style={{
      width: size, height: size,
      background: 'oklch(0.2 0.05 230deg)',
      color: 'oklch(0.65 0.1 230deg)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontSize: Math.round(size * 0.36), fontWeight: 700,
      flexShrink: 0, border: '1px solid var(--border2)', fontFamily: 'var(--font)',
    }}>
      {name.slice(0, 2).toUpperCase()}
    </div>
  );
}

function Message({ msg, char, settings, isStreaming, grouped, onDelete, onCopy, onRegen, onRegenGuided, onEdit, onBranch, onPin }) {
  const isUser = msg.role === 'user';
  const isNarrator = msg.narrator;
  const author = isNarrator ? 'NARRATOR' : (isUser ? (settings?.activePersona?.name || 'You') : char.name);
  const [editing, setEditing] = useState(false);
  const [editVal, setEditVal] = useState('');
  const [copied, setCopied] = useState(false);
  const editRef = useRef(null);

  let textContent = '';
  if (typeof msg.content === 'string') textContent = msg.content;
  else if (Array.isArray(msg.content)) textContent = msg.content.find(c => c.type === 'text')?.text || '';

  let imgEl = null;
  if (Array.isArray(msg.content)) {
    const ib = msg.content.find(c => c.type === 'image');
    if (ib?.source) { const src = `data:${ib.source.media_type};base64,${ib.source.data}`; imgEl = <img className="msg-image" src={src} alt="Attached" onClick={() => window.__hmmLightbox?.(src)} style={{ cursor: 'zoom-in' }} />; }
  }

  const hasBranches = msg.branches && msg.branches.length > 1;

  const handleCopy = async () => {
    try { await navigator.clipboard.writeText(textContent); } catch {}
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
    onCopy?.();
  };

  const startEdit = () => { setEditVal(textContent); setEditing(true); setTimeout(() => editRef.current?.focus(), 40); };
  const submitEdit = () => { if (editVal.trim()) onEdit?.(msg.id, editVal.trim()); setEditing(false); };

  return (
    <div className={`msg${isUser ? ' user' : ' assistant'}${isNarrator ? ' narrator' : ''}${msg.pinned ? ' pinned' : ''}${grouped ? ' grouped' : ''}`} data-msg-id={msg.id} style={isNarrator ? { borderLeft: '2px solid var(--warning)', paddingLeft: 10 } : msg.pinned ? { borderLeft: '2px solid var(--accent)' } : {}}>
      {grouped
        ? <div className="msg-gutter">{settings?.showTimestamps !== false ? formatTime(msg.timestamp) : ''}</div>
        : isNarrator
          ? <div style={{ width: 42, height: 42, background: 'var(--surface3)', border: '1px dashed var(--warning)', color: 'var(--warning)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 17, flexShrink: 0 }}>◈</div>
          : isUser
            ? <UserAvatar persona={settings?.activePersona} size={42} />
            : <CharAvatar char={char} size={42} />
      }
      <div className="msg-body">
        {!grouped && (
        <div className="msg-meta">
          <span className={`msg-author${isUser ? ' user' : ''}`} style={isNarrator ? { color: 'var(--warning)' } : !isUser ? { color: charFg(char.name) } : {}}>{author}</span>
          {settings?.showTimestamps !== false && <span className="msg-time">{formatTime(msg.timestamp)}</span>}
          {msg.edited && <span className="msg-edited">(edited)</span>}
          {msg.pinned && <span style={{ fontSize: 10, color: 'var(--accent)', letterSpacing: '0.1em' }} title="Pinned to context">📌 PINNED</span>}
        </div>
        )}
        {imgEl}
        {editing ? (
          <div className="msg-edit-area">
            <textarea
              ref={editRef}
              className="msg-edit-textarea"
              value={editVal}
              onChange={e => setEditVal(e.target.value)}
              onKeyDown={e => {
                if (e.ctrlKey && e.key === 'Enter') submitEdit();
                if (e.key === 'Escape') setEditing(false);
              }}
            />
            <div className="msg-edit-actions">
              <button className="btn-secondary btn-sm" onClick={() => setEditing(false)}>CANCEL</button>
              <button className="btn-primary btn-sm" onClick={submitEdit}>SAVE &amp; RESEND</button>
            </div>
          </div>
        ) : (
          <div
            className="msg-content"
            dangerouslySetInnerHTML={{
              __html: renderMarkdown(textContent) + (isStreaming ? '<span class="cursor"></span>' : '')
            }}
          />
        )}
        <div className="msg-footer">
          {hasBranches && (
            <div className="branch-nav">
              <button className="branch-btn" disabled={msg.currentBranch === 0} onClick={() => onBranch(msg.id, -1)}>‹</button>
              <span className="branch-indicator">{msg.currentBranch + 1}/{msg.branches.length}</span>
              <button className="branch-btn" disabled={msg.currentBranch === msg.branches.length - 1} onClick={() => onBranch(msg.id, 1)}>›</button>
            </div>
          )}
          <div className="msg-actions">
            <button className="msg-action-btn" onClick={() => onPin?.(msg.id)} title={msg.pinned ? 'Unpin from context' : 'Pin to context'}>
              {msg.pinned ? '📌' : <svg width="11" height="11" viewBox="0 0 24 24" fill="none"><path d="M12 17V22M8 7L8 11L4 14V16H20V14L16 11L16 7L18 5H6L8 7Z" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"/></svg>}
            </button>
            <button className="msg-action-btn" onClick={handleCopy} title="Copy">
              {copied ? '✓' : <svg width="11" height="11" viewBox="0 0 24 24" fill="none"><rect x="9" y="9" width="13" height="13" stroke="currentColor" strokeWidth="2"/><path d="M5 15H4C2.9 15 2 14.1 2 13V4C2 2.9 2.9 2 4 2H13C14.1 2 15 2.9 15 4V5" stroke="currentColor" strokeWidth="2"/></svg>}
            </button>
            {isUser ? (
              <button className="msg-action-btn" onClick={startEdit} title="Edit &amp; Resend">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none"><path d="M11 4H4C2.9 4 2 4.9 2 6V20C2 21.1 2.9 22 4 22H18C19.1 22 20 21.1 20 20V13" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/><path d="M18.5 2.5C19.3 1.7 20.7 1.7 21.5 2.5C22.3 3.3 22.3 4.7 21.5 5.5L12 15L8 16L9 12L18.5 2.5Z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
              </button>
            ) : (
              <>
                <button className="msg-action-btn" onClick={() => onRegen?.(msg.id)} title="Regenerate">
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none"><path d="M1 4V10H7" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/><path d="M23 20V14H17" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/><path d="M20.49 9A9 9 0 0 0 5.64 5.64L1 10M23 14L18.36 18.36A9 9 0 0 1 3.51 15" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
                </button>
                <button className="msg-action-btn" onClick={() => onRegenGuided?.(msg.id)} title="Regenerate with direction">
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none"><path d="M12 20H9C7.3 20 6 18.7 6 17V7C6 5.3 7.3 4 9 4H15C16.7 4 18 5.3 18 7V9" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/><path d="M15 16H22M22 16L19 13M22 16L19 19" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
                </button>
              </>
            )}
            <button className="msg-action-btn danger" onClick={() => onDelete?.(msg.id)} title="Delete">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none"><path d="M3 6H21M8 6V4C8 2.9 8.9 2 10 2H14C15.1 2 16 2.9 16 4V6M19 6V20C19 21.1 18.1 22 17 22H7C5.9 22 5 21.1 5 20V6H19Z" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function VariationsPanel({ messages, char, settings, onClose, onUse, addToast }) {
  const [count, setCount] = useState(3);
  const [items, setItems] = useState([]);
  const [running, setRunning] = useState(false);

  const generate = async () => {
    if (running) return;
    const apiMsgs = messages
      .filter((m, i) => !(m.role === 'assistant' && i === messages.length - 1))
      .map(m => ({ role: m.role, content: typeof m.content === 'string' ? m.content : m.content?.find?.(c => c.type === 'text')?.text || '' }))
      .filter(m => m.content);
    if (!apiMsgs.length || apiMsgs[apiMsgs.length - 1].role !== 'user') {
      addToast('Send a message first', 'warning'); return;
    }
    setRunning(true);
    setItems(Array.from({ length: count }, (_, i) => ({ id: i, status: 'loading', text: '' })));
    await Promise.all(Array.from({ length: count }, async (_, i) => {
      try {
        const text = await callAI(apiMsgs, char, settings || S.settings());
        setItems(prev => prev.map(x => x.id === i ? { id: i, status: 'done', text } : x));
      } catch (e) {
        setItems(prev => prev.map(x => x.id === i ? { id: i, status: 'error', text: e.message } : x));
      }
    }));
    setRunning(false);
  };

  return (
    <div className="var-panel">
      <div className="var-header">
        <span className="var-title">VARIATIONS</span>
        <button className="btn-icon" onClick={onClose} style={{ width: 24, height: 24, fontSize: 18 }}>×</button>
      </div>
      <div className="var-controls">
        <span style={{ fontSize: 10, color: 'var(--text3)' }}>COUNT</span>
        <select value={count} onChange={e => setCount(Number(e.target.value))} style={{ padding: '2px 6px', fontSize: 11, width: 52 }}>
          {[2, 3, 4, 5].map(n => <option key={n} value={n}>{n}</option>)}
        </select>
        <button className="btn-primary btn-sm" onClick={generate} disabled={running}>
          {running ? 'RUNNING...' : 'GENERATE'}
        </button>
      </div>
      <div className="var-list">
        {items.length === 0 && (
          <p style={{ fontSize: 11, color: 'var(--text3)', padding: '16px 8px', lineHeight: 1.7, textAlign: 'center' }}>
            Generate multiple response variations and pick your favorite.
          </p>
        )}
        {items.map(item => (
          <div key={item.id} className="var-card">
            <div className="var-num">VARIATION {item.id + 1}</div>
            {item.status === 'loading'
              ? <div className="typing" style={{ padding: '8px 0' }}><div className="typing-dot"/><div className="typing-dot"/><div className="typing-dot"/></div>
              : <>
                  <div className="var-text" style={item.status === 'error' ? { color: 'var(--danger)' } : {}}>{item.text}</div>
                  {item.status === 'done' && (
                    <div className="var-actions">
                      <button className="btn-primary btn-sm" onClick={() => onUse(item.text)}>USE THIS</button>
                      <button className="btn-secondary btn-sm" onClick={() => navigator.clipboard.writeText(item.text)}>COPY</button>
                    </div>
                  )}
                </>
            }
          </div>
        ))}
      </div>
    </div>
  );
}

function WelcomeScreen({ chars, onNewChar, onImport, onSelectChar }) {
  const totalMsgs = chars.reduce((s, c) => s + S.chat(c.id).length, 0);

  // Recent convos: chars with messages, sorted by updatedAt
  const recent = [...chars]
    .filter(c => S.chat(c.id).length > 0)
    .sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0))
    .slice(0, 4);

  return (
    <div className="welcome" style={{ alignItems: 'flex-start', overflowY: 'auto', padding: '48px 24px' }}>
      <div className="welcome-inner" style={{ margin: '0 auto', maxWidth: 640, width: '100%', textAlign: 'left', padding: 0 }}>
        {/* Hero */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 8 }}>
          <svg className="welcome-logo" width="40" height="40" viewBox="0 0 24 24" fill="none" style={{ marginBottom: 0, flexShrink: 0 }}>
            <path d="M12 2L2 7L12 12L22 7L12 2Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/>
            <path d="M2 17L12 22L22 17" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/>
            <path d="M2 12L12 17L22 12" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/>
          </svg>
          <div>
            <h2 className="welcome-title" style={{ marginBottom: 2, fontSize: 22 }}>HMM<span style={{ color: 'var(--accent)' }}>.</span></h2>
            <p className="welcome-sub" style={{ marginBottom: 0, lineHeight: 1.6 }}>Unrestricted AI roleplay. Your characters, your rules.</p>
          </div>
        </div>
        <div style={{ fontSize: 10, color: 'var(--text3)', letterSpacing: '0.08em', marginBottom: 20 }}>
          {chars.length} CHARACTER{chars.length !== 1 ? 'S' : ''} · {chars.filter(c => c.favorite).length} FAV · {totalMsgs.toLocaleString()} MESSAGES
        </div>
        <div className="welcome-actions" style={{ justifyContent: 'flex-start', marginBottom: 32 }}>
          <button className="btn-primary" onClick={onNewChar}>CREATE CHARACTER</button>
          <button className="btn-secondary" onClick={onImport}>IMPORT PNG / JSON</button>
        </div>

        {chars.length === 0 && (
          <div style={{ border: '1px dashed var(--border3)', padding: '36px 24px', textAlign: 'center', color: 'var(--text3)', fontSize: 11, lineHeight: 1.9 }}>
            No characters yet.<br/>Create one from scratch or drop in a TavernAI / SillyTavern PNG card.
          </div>
        )}

        {recent.length > 0 && (
          <div>
            <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.18em', color: 'var(--text3)', marginBottom: 10, textAlign: 'left' }}>CONTINUE WHERE YOU LEFT OFF</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {recent.map(c => {
                const msgs = S.chat(c.id);
                const last = msgs[msgs.length - 1];
                const lastText = last
                  ? (typeof last.content === 'string' ? last.content : last.content?.find?.(x => x.type === 'text')?.text || '')
                  : '';
                const preview = lastText.replace(/\*/g, '').replace(/\s+/g, ' ').trim().slice(0, 72);
                const lastAuthor = last?.role === 'user' ? 'You' : c.name;
                const when = c.updatedAt ? formatDate(c.updatedAt) : '';
                return (
                  <div
                    key={c.id}
                    onClick={() => onSelectChar(c.id)}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px',
                      background: 'var(--surface)', border: '1px solid var(--border2)',
                      cursor: 'pointer', textAlign: 'left', transition: 'border-color 0.1s',
                      borderLeft: '2px solid var(--border2)',
                    }}
                    onMouseEnter={e => { e.currentTarget.style.borderLeftColor = 'var(--accent)'; e.currentTarget.style.borderColor = 'var(--border3)'; }}
                    onMouseLeave={e => { e.currentTarget.style.borderLeftColor = 'var(--border2)'; e.currentTarget.style.borderColor = 'var(--border2)'; }}
                  >
                    <CharAvatar char={c} size={38} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 2 }}>
                        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)' }}>{c.name}</span>
                        <span style={{ fontSize: 10, color: 'var(--text3)' }}>{when}</span>
                        <span style={{ fontSize: 9, color: 'var(--text3)', marginLeft: 'auto', whiteSpace: 'nowrap' }}>{msgs.length} msgs</span>
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--text3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        <span style={{ color: 'var(--text2)', marginRight: 4 }}>{lastAuthor}:</span>{preview || '—'}
                      </div>
                    </div>
                    <div style={{ color: 'var(--text3)', fontSize: 14, flexShrink: 0 }}>›</div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {chars.length > 0 && (
          <div style={{ marginTop: 28 }}>
            <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.18em', color: 'var(--text3)', marginBottom: 10 }}>ALL CHARACTERS</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 8 }}>
              {chars.map(c => {
                const count = S.chat(c.id).length;
                return (
                  <div
                    key={c.id}
                    onClick={() => onSelectChar(c.id)}
                    style={{
                      display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8,
                      padding: '16px 10px 12px', background: 'var(--surface)',
                      border: '1px solid var(--border2)', cursor: 'pointer',
                      textAlign: 'center', transition: 'border-color 0.1s, background 0.1s', position: 'relative',
                    }}
                    onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--accent)'; e.currentTarget.style.background = 'var(--surface2)'; }}
                    onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border2)'; e.currentTarget.style.background = 'var(--surface)'; }}
                  >
                    {c.favorite && <span style={{ position: 'absolute', top: 4, right: 6, color: 'var(--warning)', fontSize: 11 }}>★</span>}
                    <CharAvatar char={c} size={56} />
                    <div style={{ minWidth: 0, width: '100%' }}>
                      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name}</div>
                      <div style={{ fontSize: 9, color: 'var(--text3)', marginTop: 3, letterSpacing: '0.06em' }}>
                        {count > 0 ? `${count} MSG${count !== 1 ? 'S' : ''}` : (c.tags?.[0] || 'NEW').toUpperCase().slice(0, 14)}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function ChatView() {
  const ctx = useContext(AppCtx);
  const char = ctx.currentChar;
  const settings = { ...ctx.settings, activePersona: ctx.activePersona };

  const [messages, setMessages] = useState([]);
  const [streamingId, setStreamingId] = useState(null);
  const [generating, setGenerating] = useState(false);
  const [inputVal, setInputVal] = useState('');
  const [pendingImage, setPendingImage] = useState(null);
  const [showVarPanel, setShowVarPanel] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const [searchQ, setSearchQ] = useState('');
  const [regenModal, setRegenModal] = useState({ open: false });
  const [tempPreset, setTempPreset] = useState('balanced');
  const [replyLen, setReplyLen] = useState('auto');
  const [avatarLightbox, setAvatarLightbox] = useState(false);
  const [lightboxSrc, setLightboxSrc] = useState(null);
  useEffect(() => { window.__hmmLightbox = src => setLightboxSrc(src); return () => { delete window.__hmmLightbox; }; }, []);

  const [showPersonaSwitcher, setShowPersonaSwitcher] = useState(false);
  const [aiAssisting, setAiAssisting] = useState(null); // 'write'|'enhance'|'continue'|'impersonate'
  const [assistPopover, setAssistPopover] = useState(null); // {mode} when open
  const [assistDir, setAssistDir] = useState('');
  const [assistLen, setAssistLen] = useState('medium');
  const personas = ctx.personas;
  const activePersona = ctx.activePersona;

  const msgsEndRef = useRef(null);
  const inputRef = useRef(null);
  const fileRef = useRef(null);
  const regenInstrRef = useRef(null);

  const getTempVal = () => tempPreset === 'precise' ? 0.3 : tempPreset === 'creative' ? 1.0 : 0.7;
  const REPLY_HINTS = {
    auto: null,
    short: 'Keep your response short — 1-2 sentences.',
    medium: 'Keep your response to a moderate length — 2-4 sentences.',
    long: 'Write a long, detailed response — a full rich paragraph or more with vivid sensory detail.',
  };
  const aiSettings = () => ({ ...settings, temperature: getTempVal(), replyLengthHint: REPLY_HINTS[replyLen] });

  // Build the opening message, wiring alternate greetings into the branch system for swiping
  const buildGreeting = () => {
    const greetings = [char.firstMessage, ...(char.alternateGreetings || [])].filter(g => g && g.trim());
    if (!greetings.length) return null;
    const msg = { id: genId(), role: 'assistant', content: greetings[0], timestamp: new Date().toISOString() };
    if (greetings.length > 1) { msg.branches = greetings; msg.currentBranch = 0; }
    return msg;
  };

  // Load messages when char changes
  useEffect(() => {
    if (!char) return;
    const saved = S.chat(char.id);
    if (saved.length === 0 && (char.firstMessage || char.alternateGreetings?.length)) {
      const g = buildGreeting();
      const first = g ? [g] : [];
      setMessages(first);
      S.saveChat(char.id, first);
    } else {
      setMessages(saved);
    }
    setInputVal('');
    setShowSearch(false);
    setSearchQ('');
    setShowVarPanel(false);
  }, [char?.id]);

  // Auto-scroll
  useEffect(() => {
    if (settings.autoScroll && msgsEndRef.current) {
      msgsEndRef.current.scrollTop = msgsEndRef.current.scrollHeight;
    }
  }, [messages, streamingId]);

  // Ctrl+F search shortcut
  useEffect(() => {
    const fn = e => {
      if (e.ctrlKey && e.key === 'f' && ctx.currentChar) { e.preventDefault(); setShowSearch(s => !s); }
    };
    window.addEventListener('keydown', fn);
    return () => window.removeEventListener('keydown', fn);
  }, [ctx.currentChar]);

  const handleInputChange = e => {
    setInputVal(e.target.value);
    const ta = e.target;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 160) + 'px';
  };

  const totalTokens = messages.reduce((s, m) => {
    const t = typeof m.content === 'string' ? m.content : m.content?.find?.(c => c.type === 'text')?.text || '';
    return s + estimateTokens(t);
  }, 0);
  const tokenPct = Math.min(100, (totalTokens / 16000) * 100);

  const saveAndSync = (msgs) => {
    S.saveChat(char.id, msgs);
    ctx.setChars(prev => {
      const next = prev.map(c => c.id === char.id ? { ...c, updatedAt: new Date().toISOString() } : c);
      S.saveChars(next);
      return next;
    });
  };

  const sendMessage = async () => {
    if (!inputVal.trim() || !char || generating) return;
    const text = inputVal.trim();
    setInputVal('');
    if (inputRef.current) inputRef.current.style.height = 'auto';

    let userContent = text;
    if (pendingImage) {
      userContent = [
        { type: 'image', source: { type: 'base64', media_type: pendingImage.mediaType, data: pendingImage.base64 } },
        { type: 'text', text }
      ];
      setPendingImage(null);
    }

    const userMsg = { id: genId(), role: 'user', content: userContent, timestamp: new Date().toISOString() };
    const withUser = [...messages, userMsg];
    const streamMsgId = genId();
    const streamMsg = { id: streamMsgId, role: 'assistant', content: '', timestamp: new Date().toISOString() };
    setMessages([...withUser, streamMsg]);
    setStreamingId(streamMsgId);
    setGenerating(true);

    try {
      await callAI(withUser, char, aiSettings(), (partial, done) => {
        setMessages(prev => prev.map(m => m.id === streamMsgId ? { ...m, content: partial } : m));
        if (done) {
          setStreamingId(null);
          setMessages(prev => { const f = prev.map(m => m.id === streamMsgId ? { ...m, content: partial } : m); saveAndSync(f); return f; });
        }
      });
    } catch (e) {
      ctx.addToast(`Error: ${e.message}`, 'error');
      setStreamingId(null);
      setMessages(prev => prev.filter(m => m.id !== streamMsgId));
    } finally {
      setGenerating(false);
    }
  };

  const regenerate = async (instruction = null) => {
    if (generating) return;
    let lastIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) { if (messages[i].role === 'assistant') { lastIdx = i; break; } }
    if (lastIdx === -1) return;

    const last = messages[lastIdx];
    const apiMsgs = messages.slice(0, lastIdx).map(m => ({
      role: m.role,
      content: Array.isArray(m.content) ? m.content.find(c => c.type === 'text')?.text || '' : m.content
    }));
    if (instruction && apiMsgs.length > 0 && apiMsgs[apiMsgs.length - 1].role === 'user') {
      apiMsgs[apiMsgs.length - 1] = { ...apiMsgs[apiMsgs.length - 1], content: `${apiMsgs[apiMsgs.length - 1].content}\n\n[Direction: ${instruction}]` };
    }

    setGenerating(true);
    setStreamingId(last.id);
    setMessages(prev => prev.map(m => m.id === last.id ? { ...m, content: '' } : m));

    try {
      await callAI(apiMsgs, char, aiSettings(), (partial, done) => {
        setMessages(prev => prev.map(m => m.id === last.id ? { ...m, content: partial } : m));
        if (done) {
          setStreamingId(null);
          setMessages(prev => {
            const f = prev.map(m => {
              if (m.id !== last.id) return m;
              const branches = [...(m.branches || [m.content]), partial];
              return { ...m, content: partial, branches, currentBranch: branches.length - 1 };
            });
            saveAndSync(f);
            return f;
          });
        }
      });
    } catch (e) { ctx.addToast(`Error: ${e.message}`, 'error'); setStreamingId(null); }
    finally { setGenerating(false); }
  };

  const editAndResend = async (msgId, newText) => {
    if (generating) return;
    const idx = messages.findIndex(m => m.id === msgId);
    if (idx === -1) return;
    const edited = { ...messages[idx], content: newText, edited: true };
    const trimmed = [...messages.slice(0, idx), edited];
    const streamMsgId = genId();
    const streamMsg = { id: streamMsgId, role: 'assistant', content: '', timestamp: new Date().toISOString() };
    setMessages([...trimmed, streamMsg]);
    setStreamingId(streamMsgId);
    setGenerating(true);

    const apiMsgs = trimmed.map(m => ({
      role: m.role,
      content: Array.isArray(m.content) ? m.content.find(c => c.type === 'text')?.text || '' : m.content
    }));

    try {
      await callAI(apiMsgs, char, aiSettings(), (partial, done) => {
        setMessages(prev => prev.map(m => m.id === streamMsgId ? { ...m, content: partial } : m));
        if (done) {
          setStreamingId(null);
          setMessages(prev => { const f = prev.map(m => m.id === streamMsgId ? { ...m, content: partial } : m); saveAndSync(f); return f; });
        }
      });
    } catch (e) { ctx.addToast(`Error: ${e.message}`, 'error'); setStreamingId(null); }
    finally { setGenerating(false); }
  };

  const deleteMessage = id => setMessages(prev => { const f = prev.filter(m => m.id !== id); saveAndSync(f); return f; });

  const togglePin = id => setMessages(prev => {
    const f = prev.map(m => m.id === id ? { ...m, pinned: !m.pinned } : m);
    saveAndSync(f);
    return f;
  });

  const sendAsNarrator = async () => {
    if (!inputVal.trim() || !char || generating) return;
    const text = inputVal.trim();
    setInputVal('');
    if (inputRef.current) inputRef.current.style.height = 'auto';

    const narratorMsg = { id: genId(), role: 'user', content: text, timestamp: new Date().toISOString(), narrator: true };
    const withNarr = [...messages, narratorMsg];
    const streamMsgId = genId();
    const streamMsg = { id: streamMsgId, role: 'assistant', content: '', timestamp: new Date().toISOString() };
    setMessages([...withNarr, streamMsg]);
    setStreamingId(streamMsgId);
    setGenerating(true);

    try {
      await callAI(withNarr, char, aiSettings(), (partial, done) => {
        setMessages(prev => prev.map(m => m.id === streamMsgId ? { ...m, content: partial } : m));
        if (done) {
          setStreamingId(null);
          setMessages(prev => { const f = prev.map(m => m.id === streamMsgId ? { ...m, content: partial } : m); saveAndSync(f); return f; });
        }
      });
    } catch (e) {
      ctx.addToast(`Error: ${e.message}`, 'error');
      setStreamingId(null);
      setMessages(prev => prev.filter(m => m.id !== streamMsgId));
    } finally {
      setGenerating(false);
    }
  };

  const summarizeContext = async () => {
    if (messages.length < 8) { ctx.addToast('Need at least 8 messages to summarize', 'warning'); return; }
    if (!window.confirm(`Summarize the first ${messages.length - 4} messages into a compact note? The last 4 messages stay intact. Original messages can be unhidden later.`)) return;
    setGenerating(true);
    ctx.addToast('Generating summary...', 'info');
    try {
      const summary = await summarizeMessages(messages, char, settings);
      if (!summary) throw new Error('Summary returned empty');
      // Mark all but last 4 messages as hidden, prepend a summary message
      const summaryMsg = {
        id: genId(),
        role: 'assistant',
        content: `[CONTEXT SUMMARY]\n${summary}`,
        timestamp: new Date().toISOString(),
        narrator: true,
        pinned: true,
        isSummary: true,
      };
      const kept = messages.slice(-4);
      const f = [summaryMsg, ...kept];
      setMessages(f);
      saveAndSync(f);
      ctx.addToast('Conversation summarized', 'success');
    } catch(e) { ctx.addToast(`Summarize error: ${e.message}`, 'error'); }
    setGenerating(false);
  };

  const navigateBranch = (msgId, dir) => setMessages(prev => {
    const f = prev.map(m => {
      if (m.id !== msgId || !m.branches) return m;
      const nb = m.currentBranch + dir;
      if (nb < 0 || nb >= m.branches.length) return m;
      return { ...m, currentBranch: nb, content: m.branches[nb] };
    });
    saveAndSync(f);
    return f;
  });

  const useVariation = text => {
    setMessages(prev => {
      const f = [...prev];
      const idx = f.map(m => m.role).lastIndexOf('assistant');
      if (idx >= 0) {
        const m = f[idx];
        const branches = [...(m.branches || [m.content]), text];
        f[idx] = { ...m, content: text, branches, currentBranch: branches.length - 1 };
      } else {
        f.push({ id: genId(), role: 'assistant', content: text, timestamp: new Date().toISOString() });
      }
      saveAndSync(f);
      return f;
    });
    setShowVarPanel(false);
    ctx.addToast('Variation applied', 'success');
  };

  const newChat = () => {
    if (messages.length > 0) {
      const hist = S.history(char.id);
      const firstUser = messages.find(m => m.role === 'user');
      const titleText = firstUser ? (typeof firstUser.content === 'string' ? firstUser.content : firstUser.content?.find?.(c => c.type === 'text')?.text || '') : 'Session';
      S.saveHistory(char.id, [{ id: genId(), title: titleText.slice(0, 60), messages: [...messages], savedAt: new Date().toISOString(), messageCount: messages.length }, ...hist].slice(0, 50));
    }
    const g = buildGreeting();
    const fresh = g ? [g] : [];
    setMessages(fresh);
    S.saveChat(char.id, fresh);
    ctx.addToast('New chat started — previous session saved to history', 'info');
  };

  const exportChat = () => {
    const text = messages.map(m => {
      const a = m.role === 'user' ? (settings.userPersona || 'You') : char.name;
      const c = typeof m.content === 'string' ? m.content : m.content?.find?.(x => x.type === 'text')?.text || '';
      return `[${new Date(m.timestamp).toLocaleString()}] ${a}:\n${c}`;
    }).join('\n\n---\n\n');
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    Object.assign(document.createElement('a'), { href: url, download: `${char.name}_chat.txt` }).click();
    URL.revokeObjectURL(url);
    ctx.addToast('Chat exported', 'success');
  };

  const toggleFav = () => {
    ctx.setChars(prev => { const n = prev.map(c => c.id === char.id ? { ...c, favorite: !c.favorite } : c); S.saveChars(n); return n; });
    ctx.setCurrentChar(prev => ({ ...prev, favorite: !prev.favorite }));
  };

  const handleImgAttach = e => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async ev => {
      // Downscale before storing — keeps chat records small
      const url = await compressImage(ev.target.result, 1024, 0.85);
      const mediaType = url.startsWith('data:image/webp') ? 'image/webp' : file.type;
      setPendingImage({ base64: url.split(',')[1], mediaType, name: file.name, previewUrl: url });
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  };

  const filtered = searchQ
    ? messages.filter(m => { const t = typeof m.content === 'string' ? m.content : m.content?.find?.(c => c.type === 'text')?.text || ''; return t.toLowerCase().includes(searchQ.toLowerCase()); })
    : messages;

  // ── AI assist helpers ──────────────────────────────────────────
  const LENGTH_HINTS = {
    short:  'Keep it brief — 1-2 sentences, punchy.',
    medium: 'Medium length — 2-4 sentences.',
    long:   'Long and detailed — a full rich paragraph (5-8 sentences) with vivid sensory detail.',
  };

  const assist = async (mode, opts = {}) => {
    if (generating || aiAssisting) return;
    const direction = (opts.direction || '').trim();
    const length = opts.length || 'medium';
    const lengthHint = LENGTH_HINTS[length] || LENGTH_HINTS.medium;
    const dirHint = direction ? `\n\nSpecific direction to follow: ${direction}` : '';
    setAiAssisting(mode);
    setAssistPopover(null);
    try {
      const settingsNow = { ...settings, temperature: 0.9 };
      let result;

      if (mode === 'write') {
        const history = messages.map(m => {
          const t = typeof m.content === 'string' ? m.content : m.content?.find?.(c=>c.type==='text')?.text||'';
          return `${m.role === 'user' ? (activePersona?.name||'You') : char.name}: ${t}`;
        }).join('\n');
        const sysMsg = `You are helping write the NEXT message from ${activePersona?.name||'You'} in a roleplay with ${char.name}.${activePersona?.description ? ` ${activePersona.name} is: ${activePersona.description}.` : ''} Write ONLY the message text — no quotes, no labels, no explanation. Make it natural and fitting the tone. ${lengthHint}${dirHint}`;
        const fakeChar = { name: activePersona?.name||'You', description: '', personality: '', scenario: '', firstMessage: '', exampleDialogues: '', systemPrompt: sysMsg };
        const fakeMsgs = [{ role: 'user', content: `Conversation so far:\n${history}\n\nWrite ${activePersona?.name||'You'}'s next message.` }];
        result = await callAI(fakeMsgs, fakeChar, settingsNow);

      } else if (mode === 'enhance') {
        const draft = inputVal.trim();
        if (!draft) { ctx.addToast('Type something to enhance first', 'warning'); setAiAssisting(null); return; }
        const history = messages.slice(-6).map(m => {
          const t = typeof m.content === 'string' ? m.content : m.content?.find?.(c=>c.type==='text')?.text||'';
          return `${m.role === 'user' ? (activePersona?.name||'You') : char.name}: ${t}`;
        }).join('\n');
        const sysMsg = `You are a creative writing assistant. Enhance the user's draft message for a roleplay — make it more vivid, expressive and immersive while keeping the same core intent. ${lengthHint}${dirHint}\n\nReturn ONLY the enhanced message — no explanation, no quotes.`;
        const fakeChar = { name: 'Assistant', description: '', personality: '', scenario: '', firstMessage: '', exampleDialogues: '', systemPrompt: sysMsg };
        const fakeMsgs = [{ role: 'user', content: `Recent context:\n${history}\n\nMy draft: "${draft}"\n\nEnhance it.` }];
        result = await callAI(fakeMsgs, fakeChar, settingsNow);

      } else if (mode === 'continue') {
        const lastAsst = [...messages].reverse().find(m => m.role === 'assistant');
        if (!lastAsst) { ctx.addToast('No assistant message to continue', 'warning'); setAiAssisting(null); return; }
        const lastText = typeof lastAsst.content === 'string' ? lastAsst.content : lastAsst.content?.find?.(c=>c.type==='text')?.text||'';
        const apiMsgs = [
          ...messages.slice(0, messages.indexOf(lastAsst)).map(m => ({ role: m.role, content: typeof m.content==='string'?m.content:m.content?.find?.(c=>c.type==='text')?.text||'' })),
          { role: 'user', content: `Continue your last message naturally from where it left off. Do NOT repeat what was already said.${dirHint} Continue from: "…${lastText.slice(-120)}"` }
        ];
        const sysMsg = buildSystemPrompt(char, settings) + `\n\nIMPORTANT: You are continuing your previous message. Write ONLY the continuation — do not repeat anything already written. ${lengthHint}`;
        const fakeChar = { ...char, systemPrompt: sysMsg };
        result = await callAI(apiMsgs, fakeChar, settingsNow);
        setMessages(prev => {
          const f = prev.map(m => {
            if (m.id !== lastAsst.id) return m;
            const newContent = lastText + ' ' + result;
            const branches = [...(m.branches || [lastText]), newContent];
            return { ...m, content: newContent, branches, currentBranch: branches.length - 1 };
          });
          saveAndSync(f);
          return f;
        });
        ctx.addToast('Message continued', 'success');
        setAiAssisting(null);
        return;

      } else if (mode === 'impersonate') {
        const history = messages.slice(-8).map(m => {
          const t = typeof m.content === 'string' ? m.content : m.content?.find?.(c=>c.type==='text')?.text||'';
          return `${m.role === 'user' ? (activePersona?.name||'You') : char.name}: ${t}`;
        }).join('\n');
        const sysMsg = `You are writing dialogue AS ${activePersona?.name||'You'}${activePersona?.description ? ` (${activePersona.description})` : ''} in a roleplay with ${char.name}. Write a natural, in-character response from ${activePersona?.name||'You'}'s perspective. ${lengthHint}${dirHint}\n\nReturn ONLY the message text.`;
        const fakeChar = { name: activePersona?.name||'You', description: '', personality: '', scenario: '', firstMessage: '', exampleDialogues: '', systemPrompt: sysMsg };
        const fakeMsgs = [{ role: 'user', content: `Conversation:\n${history}\n\nWrite ${activePersona?.name||'You'}'s response.` }];
        result = await callAI(fakeMsgs, fakeChar, settingsNow);
      }

      if (result) {
        const clean = result.trim().replace(/^["']|["']$/g, '');
        setInputVal(clean);
        if (inputRef.current) {
          inputRef.current.style.height = 'auto';
          inputRef.current.style.height = Math.min(inputRef.current.scrollHeight, 160) + 'px';
          inputRef.current.focus();
        }
      }
    } catch(e) { ctx.addToast(`Assist error: ${e.message}`, 'error'); }
    setAiAssisting(null);
  };

  // Slash command handler
  const handleSlash = e => {
    if (e.key === 'Tab' && inputVal.startsWith('/')) {
      e.preventDefault();
      const cmd = inputVal.toLowerCase().trim();
      if (cmd === '/write' || cmd === '/w') { setInputVal(''); assist('write'); }
      else if (cmd === '/enhance' || cmd === '/e') { assist('enhance'); }
      else if (cmd === '/continue' || cmd === '/c') { setInputVal(''); assist('continue'); }
      else if (cmd === '/imp' || cmd === '/impersonate') { setInputVal(''); assist('impersonate'); }
    }
  };

  const iconBtn = (title, active, danger, onClick, icon) => (
    <button key={title} className={`btn-icon${active ? ' active' : ''}${danger ? ' danger' : ''}`} onClick={onClick} title={title}>{icon}</button>
  );

  return (
    <div className="chat-view">
      {/* Header */}
      <div className="chat-header">
        <div className="chat-header-left">
          <div onClick={() => char.avatar && !char.avatar.startsWith('/assets/') && setAvatarLightbox(true)} style={{ cursor: char.avatar && !char.avatar.startsWith('/assets/') ? 'pointer' : 'default' }} title={char.avatar && !char.avatar.startsWith('/assets/') ? 'View avatar' : ''}>
            <CharAvatar char={char} size={40} />
          </div>
          <div>
            <div className="chat-name">{char.name}</div>
            <div className="chat-status">{generating ? 'typing...' : 'online'}</div>
          </div>
        </div>
        <div className="chat-header-right">
          {iconBtn('Favorite', char.favorite, false, toggleFav,
            <svg width="15" height="15" viewBox="0 0 24 24" fill={char.favorite ? 'currentColor' : 'none'}><path d="M12 2L15.09 8.26L22 9.27L17 14.14L18.18 21.02L12 17.77L5.82 21.02L7 14.14L2 9.27L8.91 8.26L12 2Z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round"/></svg>
          )}
          {iconBtn('Edit Character', false, false, () => ctx.openModal('char-editor', char.id),
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none"><path d="M11 4H4C2.9 4 2 4.9 2 6V20C2 21.1 2.9 22 4 22H18C19.1 22 20 21.1 20 20V13" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/><path d="M18.5 2.5C19.3 1.7 20.7 1.7 21.5 2.5C22.3 3.3 22.3 4.7 21.5 5.5L12 15L8 16L9 12L18.5 2.5Z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
          )}
          {iconBtn('Variations Panel', showVarPanel, false, () => setShowVarPanel(v => !v),
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none"><rect x="2" y="3" width="20" height="18" stroke="currentColor" strokeWidth="2"/><path d="M8 3V21M16 3V21" stroke="currentColor" strokeWidth="2"/></svg>
          )}
          {iconBtn('Search Messages (Ctrl+F)', showSearch, false, () => setShowSearch(v => !v),
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none"><circle cx="11" cy="11" r="8" stroke="currentColor" strokeWidth="2"/><path d="M21 21L16.65 16.65" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
          )}
          {iconBtn('Chat History', false, false, () => ctx.openModal('history'),
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none"><path d="M12 8V12L15 15" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/><path d="M3.05 11A9 9 0 1 0 4 7.4M3 4V8H7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
          )}
          {iconBtn('New Chat', false, false, newChat,
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none"><path d="M12 5V19M5 12H19" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"/></svg>
          )}
          {iconBtn('Export Chat', false, false, exportChat,
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none"><path d="M21 15V19C21 20.1 20.1 21 19 21H5C3.9 21 3 20.1 3 19V15" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/><path d="M7 10L12 15L17 10M12 15V3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
          )}
          {iconBtn('Download PNG Card (SillyTavern-compatible)', false, false,
            () => downloadCharPng(char)
              .then(() => ctx.addToast('PNG card downloaded', 'success'))
              .catch(e => ctx.addToast(`Export failed: ${e.message}`, 'error')),
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none"><rect x="3" y="3" width="18" height="18" stroke="currentColor" strokeWidth="2"/><circle cx="8.5" cy="8.5" r="1.5" fill="currentColor"/><path d="M21 15L16 10L5 21" stroke="currentColor" strokeWidth="2" strokeLinejoin="round"/></svg>
          )}
          {iconBtn('Download JSON Card', false, false,
            () => { downloadCharJson(char); ctx.addToast('JSON card downloaded', 'success'); },
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none"><path d="M8 3H7C5.9 3 5 3.9 5 5V9C5 10.1 4.1 11 3 11V13C4.1 13 5 13.9 5 15V19C5 20.1 5.9 21 7 21H8M16 3H17C18.1 3 19 3.9 19 5V9C19 10.1 19.9 11 21 11V13C19.9 13 19 13.9 19 15V19C19 20.1 18.1 21 17 21H16" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
          )}
          {iconBtn('Delete Character', false, true, () => {
            if (!window.confirm(`Delete "${char.name}"? Cannot be undone.`)) return;
            ctx.setChars(prev => { const n = prev.filter(c => c.id !== char.id); S.saveChars(n); return n; });
            S.deleteCharData(char.id);
            ctx.setCurrentChar(null);
            ctx.addToast('Character deleted', 'info');
          },
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none"><path d="M3 6H21M8 6V4C8 2.9 8.9 2 10 2H14C15.1 2 16 2.9 16 4V6M19 6V20C19 21.1 18.1 22 17 22H7C5.9 22 5 21.1 5 20V6H19Z" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
          )}
        </div>
      </div>

      {/* Context bar */}
      <div className="context-bar">
        <div className={`context-fill${tokenPct > 80 ? ' crit' : tokenPct > 55 ? ' warn' : ''}`} style={{ width: `${tokenPct}%` }} />
      </div>

      {/* Search */}
      {showSearch && (
        <div className="search-bar">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" style={{ color: 'var(--text3)', flexShrink: 0 }}>
            <circle cx="11" cy="11" r="8" stroke="currentColor" strokeWidth="2"/>
            <path d="M21 21L16.65 16.65" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
          </svg>
          <input autoFocus placeholder="Search messages..." value={searchQ} onChange={e => setSearchQ(e.target.value)} onKeyDown={e => e.key === 'Escape' && (setShowSearch(false), setSearchQ(''))} />
          {searchQ && <span className="search-count">{filtered.length} match{filtered.length !== 1 ? 'es' : ''}</span>}
          <button className="btn-icon" style={{ width: 22, height: 22, fontSize: 16 }} onClick={() => { setShowSearch(false); setSearchQ(''); }}>×</button>
        </div>
      )}

      {/* Body */}
      <div className="chat-body">
        <div className="messages-container" ref={msgsEndRef}>
          {filtered.length === 0 && (
            <div className="chat-empty">
              <svg width="36" height="36" viewBox="0 0 24 24" fill="none" style={{ color: 'var(--text3)' }}>
                <path d="M21 15C21 15.5 20.8 16 20.4 16.4C20 16.8 19.5 17 19 17H7L3 21V5C3 4.5 3.2 4 3.6 3.6C4 3.2 4.5 3 5 3H19C19.5 3 20 3.2 20.4 3.6C20.8 4 21 4.5 21 5V15Z" stroke="currentColor" strokeWidth="1.5"/>
              </svg>
              <span style={{ fontSize: 12, color: 'var(--text3)' }}>{searchQ ? 'No messages match' : 'Send a message to begin'}</span>
            </div>
          )}
          {filtered.map((msg, i) => {
            const prev = filtered[i - 1];
            const grouped = !!prev && prev.role === msg.role && !msg.narrator && !prev.narrator && !msg.pinned && !prev.pinned &&
              (new Date(msg.timestamp) - new Date(prev.timestamp)) < 5 * 60 * 1000;
            return (
            <Message
              key={msg.id} msg={msg} char={char} settings={settings}
              isStreaming={msg.id === streamingId} grouped={grouped}
              onDelete={deleteMessage} onCopy={() => ctx.addToast('Copied', 'success')}
              onRegen={() => regenerate(null)}
              onRegenGuided={() => setRegenModal({ open: true })}
              onEdit={editAndResend} onBranch={navigateBranch} onPin={togglePin}
            />
            );
          })}
        </div>
        {showVarPanel && (
          <VariationsPanel messages={messages} char={char} settings={settings} onClose={() => setShowVarPanel(false)} onUse={useVariation} addToast={ctx.addToast} />
        )}
      </div>

      {/* Input */}
      <div className="input-area">
        <div className="input-statusbar">
          <div className="input-meta">
            <span className="token-count">~{totalTokens.toLocaleString()} tkns</span>
            {inputVal.trim() && <span style={{ color: 'var(--text3)' }}>· {inputVal.trim().split(/\s+/).length}w</span>}
            <span style={{ color: 'var(--text3)' }}>|</span>
            <span>{settings.model?.replace('claude-','').replace(/-20\d{6}/,'')}</span>
            <span style={{ color: 'var(--text3)' }}>|</span>
            {/* Persona switcher */}
            <div style={{ position: 'relative' }}>
              <button
                onClick={() => setShowPersonaSwitcher(v => !v)}
                style={{ display: 'flex', alignItems: 'center', gap: 5, background: 'transparent', border: '1px solid var(--border2)', padding: '2px 7px 2px 4px', cursor: 'pointer', fontSize: 10, color: 'var(--text2)', fontFamily: 'var(--font)' }}
                title="Switch persona"
              >
                <UserAvatar persona={activePersona} size={16} />
                <span>{activePersona?.name || 'You'}</span>
                <span style={{ color: 'var(--text3)', fontSize: 8 }}>▾</span>
              </button>
              {showPersonaSwitcher && (
                <div style={{ position: 'absolute', bottom: '100%', left: 0, marginBottom: 4, background: 'var(--surface)', border: '1px solid var(--border3)', minWidth: 180, zIndex: 100, boxShadow: '0 8px 24px rgba(0,0,0,0.5)' }}>
                  {personas.map(p => (
                    <div
                      key={p.id}
                      onClick={() => { ctx.setActivePersonaId(p.id); setShowPersonaSwitcher(false); }}
                      style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', cursor: 'pointer', background: p.id === ctx.activePersonaId ? 'var(--surface3)' : 'transparent', borderLeft: p.id === ctx.activePersonaId ? '2px solid var(--accent)' : '2px solid transparent' }}
                      onMouseEnter={e => e.currentTarget.style.background = 'var(--surface2)'}
                      onMouseLeave={e => e.currentTarget.style.background = p.id === ctx.activePersonaId ? 'var(--surface3)' : 'transparent'}
                    >
                      <UserAvatar persona={p} size={24} />
                      <div>
                        <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text)' }}>{p.name}</div>
                        {p.description && <div style={{ fontSize: 10, color: 'var(--text3)', maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.description}</div>}
                      </div>
                      {p.id === ctx.activePersonaId && <span style={{ marginLeft: 'auto', color: 'var(--accent)', fontSize: 10 }}>✓</span>}
                    </div>
                  ))}
                  <div style={{ borderTop: '1px solid var(--border2)', padding: '6px 10px' }}>
                    <button
                      onClick={() => { ctx.openModal('personas'); setShowPersonaSwitcher(false); }}
                      style={{ fontSize: 10, color: 'var(--accent2)', fontFamily: 'var(--font)', letterSpacing: '0.06em', cursor: 'pointer' }}
                    >MANAGE PERSONAS →</button>
                  </div>
                </div>
              )}
            </div>
            <span style={{ color: 'var(--text3)' }}>|</span>
            <div className="temp-presets">
              {[['precise','PRECISE'],['balanced','BALANCED'],['creative','CREATIVE']].map(([v,l]) => (
                <button key={v} className={`temp-preset${tempPreset===v?' active':''}`} onClick={() => setTempPreset(v)} title={v==='precise'?'Temp: 0.3':v==='balanced'?'Temp: 0.7':'Temp: 1.0'}>{l}</button>
              ))}
            </div>
            <span style={{ color: 'var(--text3)' }}>|</span>
            <span style={{ color: 'var(--text3)', fontSize: 9 }}>REPLY</span>
            <div className="temp-presets">
              {[['auto','AUTO'],['short','S'],['medium','M'],['long','L']].map(([v,l]) => (
                <button key={v} className={`temp-preset${replyLen===v?' active':''}`} onClick={() => setReplyLen(v)} title={`AI reply length: ${v}`}>{l}</button>
              ))}
            </div>
          </div>
          <div className="input-actions-row">
            <button className="btn-icon" style={{ width: 26, height: 26 }} title="Send as Narrator — scene-setting in third person" onClick={sendAsNarrator} disabled={!inputVal.trim() || generating}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none"><path d="M3 12L9 6V10H21V14H9V18L3 12Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" transform="rotate(180 12 12)"/></svg>
            </button>
            <button className="btn-icon" style={{ width: 26, height: 26 }} title="Summarize old messages to save context" onClick={summarizeContext} disabled={messages.length < 8 || generating}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none"><path d="M3 6H21M3 12H15M3 18H21" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
            </button>
            <button className="btn-icon" style={{ width: 26, height: 26 }} title='Format dialogue "quotes"' onClick={() => {
              if (inputRef.current?.value) {
                const v = inputRef.current.value.replace(/(?<!")\"([^\"]+)\"/g, '\u201c$1\u201d');
                setInputVal(v);
              }
            }}><span style={{ fontSize: 13, fontWeight: 700 }}>"</span></button>
            <button className="btn-icon" style={{ width: 26, height: 26 }} title="Attach image" onClick={() => fileRef.current?.click()}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none"><rect x="3" y="3" width="18" height="18" stroke="currentColor" strokeWidth="2"/><circle cx="8.5" cy="8.5" r="1.5" fill="currentColor"/><path d="M21 15L16 10L5 21" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
            </button>
            <button className="btn-icon" style={{ width: 26, height: 26 }} title="Clear chat" onClick={() => { if (window.confirm('Clear all messages?')) { setMessages([]); S.saveChat(char.id, []); } }}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none"><path d="M3 6H21M8 6V4C8 2.9 8.9 2 10 2H14C15.1 2 16 2.9 16 4V6M19 6V20C19 21.1 18.1 22 17 22H7C5.9 22 5 21.1 5 20V6H19Z" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
            </button>
          </div>
        </div>
        {pendingImage && (
          <div className="image-preview-bar">
            <img src={pendingImage.previewUrl} alt="Preview" />
            <div className="img-info">
              <div style={{ fontSize: 11, color: 'var(--text)' }}>{pendingImage.name}</div>
              <div style={{ fontSize: 10, color: 'var(--text3)' }}>Will be sent with next message</div>
            </div>
            <button className="btn-icon danger" style={{ width: 26, height: 26, fontSize: 18 }} onClick={() => setPendingImage(null)}>×</button>
          </div>
        )}
        <div className="input-main">
          {/* Assist buttons */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 3, flexShrink: 0, position: 'relative' }}>
            {[
              ['write',       '✍',  'Write for me',  'Generate a message for you'],
              ['enhance',     '✦',  'Enhance draft', 'Improve what you\'ve typed'],
              ['continue',    '→',  'Continue',      'AI continues its last message'],
              ['impersonate', '◈',  'Impersonate',   'AI writes as your persona'],
            ].map(([mode, icon, label, tip]) => (
              <button
                key={mode}
                title={`${label} — ${tip}\nClick for options · Slash: /${mode.slice(0,1)} + Tab`}
                onClick={() => { setAssistDir(''); setAssistPopover(assistPopover === mode ? null : mode); }}
                disabled={!!aiAssisting || generating}
                style={{
                  width: 36, height: 36,
                  display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                  background: (aiAssisting === mode || assistPopover === mode) ? 'var(--accent3)' : 'var(--surface2)',
                  border: `1px solid ${(aiAssisting === mode || assistPopover === mode) ? 'var(--accent3)' : 'var(--border2)'}`,
                  color: (aiAssisting === mode || assistPopover === mode) ? 'var(--accent)' : 'var(--text3)',
                  fontSize: 14, cursor: aiAssisting || generating ? 'not-allowed' : 'pointer',
                  opacity: aiAssisting && aiAssisting !== mode ? 0.4 : 1,
                  transition: 'all 0.1s', fontFamily: 'var(--font)',
                  gap: 1,
                }}
                onMouseEnter={e => { if (!aiAssisting && !generating && assistPopover !== mode) { e.currentTarget.style.color = 'var(--accent)'; e.currentTarget.style.borderColor = 'var(--accent3)'; }}}
                onMouseLeave={e => { if (aiAssisting !== mode && assistPopover !== mode) { e.currentTarget.style.color = 'var(--text3)'; e.currentTarget.style.borderColor = 'var(--border2)'; }}}
              >
                {aiAssisting === mode
                  ? <div className="typing" style={{ gap: 2 }}><div className="typing-dot"/><div className="typing-dot"/></div>
                  : <span>{icon}</span>
                }
                <span style={{ fontSize: 7, letterSpacing: '0.04em', lineHeight: 1, opacity: 0.7 }}>{label.split(' ')[0].toUpperCase()}</span>
              </button>
            ))}

            {/* Assist options popover */}
            {assistPopover && (
              <div
                style={{ position: 'absolute', bottom: 0, left: '100%', marginLeft: 8, width: 280, background: 'var(--surface)', border: '1px solid var(--accent3)', boxShadow: '0 8px 32px rgba(0,0,0,0.6)', zIndex: 200, padding: 12 }}
                onClick={e => e.stopPropagation()}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
                  <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.12em', color: 'var(--accent)' }}>
                    {assistPopover === 'write' ? '✍ WRITE FOR ME' : assistPopover === 'enhance' ? '✦ ENHANCE DRAFT' : assistPopover === 'continue' ? '→ CONTINUE' : '◈ IMPERSONATE'}
                  </span>
                  <button className="btn-icon" style={{ width: 20, height: 20, fontSize: 15 }} onClick={() => setAssistPopover(null)}>×</button>
                </div>

                <div style={{ marginBottom: 10 }}>
                  <label style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.1em', color: 'var(--text3)', display: 'block', marginBottom: 4 }}>LENGTH</label>
                  <div style={{ display: 'flex', gap: 3 }}>
                    {[['short','SHORT'],['medium','MED'],['long','LONG']].map(([v,l]) => (
                      <button key={v}
                        onClick={() => setAssistLen(v)}
                        style={{ flex: 1, padding: '5px 4px', fontSize: 9, fontWeight: 700, letterSpacing: '0.06em', fontFamily: 'var(--font)', background: assistLen===v?'var(--accent3)':'var(--surface2)', border: `1px solid ${assistLen===v?'var(--accent3)':'var(--border2)'}`, color: assistLen===v?'var(--accent)':'var(--text3)', cursor: 'pointer' }}
                      >{l}</button>
                    ))}
                  </div>
                </div>

                <div style={{ marginBottom: 10 }}>
                  <label style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.1em', color: 'var(--text3)', display: 'block', marginBottom: 4 }}>WHAT DO YOU WANT? (optional)</label>
                  <textarea
                    autoFocus
                    value={assistDir}
                    onChange={e => setAssistDir(e.target.value)}
                    onKeyDown={e => { if (e.ctrlKey && e.key === 'Enter') assist(assistPopover, { direction: assistDir, length: assistLen }); if (e.key === 'Escape') setAssistPopover(null); }}
                    placeholder={assistPopover === 'enhance' ? 'e.g. more tension, darker tone, add body language...' : assistPopover === 'continue' ? 'e.g. escalate, introduce a twist, slow it down...' : 'e.g. flirtatious, suspicious, change the subject to...'}
                    style={{ width: '100%', minHeight: 54, padding: '6px 8px', fontSize: 11, lineHeight: 1.5, resize: 'vertical', background: 'var(--surface2)', border: '1px solid var(--border2)', color: 'var(--text)', fontFamily: 'var(--font)' }}
                  />
                </div>

                <button className="btn-primary" style={{ width: '100%' }} onClick={() => assist(assistPopover, { direction: assistDir, length: assistLen })}>
                  RUN {assistDir.trim() ? 'WITH DIRECTION' : ''} →
                </button>
                <div style={{ fontSize: 9, color: 'var(--text3)', textAlign: 'center', marginTop: 5 }}>Ctrl+Enter to run</div>
              </div>
            )}
          </div>
          <textarea
            ref={inputRef} className="msg-input" rows={1}
            placeholder={`Message ${char.name}... (Ctrl+Enter to send)`}
            value={inputVal} onChange={handleInputChange}
            onKeyDown={e => {
              handleSlash(e);
              if (settings.sendOnEnter && e.key === 'Enter' && !e.shiftKey && !e.ctrlKey) { e.preventDefault(); sendMessage(); }
              else if (e.ctrlKey && e.key === 'Enter') { e.preventDefault(); sendMessage(); }
            }}
          />
          <button className="btn-send" onClick={sendMessage} disabled={!inputVal.trim() || generating} title="Send (Ctrl+Enter)">
            {generating
              ? <div className="typing" style={{ gap: 3 }}><div className="typing-dot"/><div className="typing-dot"/><div className="typing-dot"/></div>
              : <svg width="17" height="17" viewBox="0 0 24 24" fill="none"><path d="M22 2L11 13" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/><path d="M22 2L15 22L11 13L2 9L22 2Z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
            }
          </button>
        </div>
      </div>

      <input ref={fileRef} type="file" accept="image/*" className="sr-only" onChange={handleImgAttach} />

      {/* Avatar / image lightbox */}
      {(avatarLightbox && char.avatar || lightboxSrc) && (
        <div onClick={() => { setAvatarLightbox(false); setLightboxSrc(null); }} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.9)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 5000, padding: 40 }}>
          <img src={lightboxSrc || char.avatar} alt={char.name} style={{ maxWidth: '90%', maxHeight: '90%', objectFit: 'contain', border: '1px solid var(--border3)' }} />
          <button className="btn-icon" style={{ position: 'absolute', top: 20, right: 20, width: 40, height: 40, fontSize: 24, color: '#fff' }} onClick={() => { setAvatarLightbox(false); setLightboxSrc(null); }}>×</button>
        </div>
      )}

      {/* Regen guided modal */}
      {regenModal.open && (
        <div className="modal-overlay" onClick={e => e.target === e.currentTarget && setRegenModal({ open: false })}>
          <div className="modal" style={{ maxWidth: 440 }}>
            <div className="modal-header">
              <span className="modal-title">REGENERATE WITH DIRECTION</span>
              <button className="modal-close" onClick={() => setRegenModal({ open: false })}>×</button>
            </div>
            <div className="modal-body">
              <p style={{ fontSize: 12, color: 'var(--text2)', marginBottom: 12 }}>Tell the AI how to approach this response:</p>
              <textarea ref={regenInstrRef} autoFocus className="form-textarea" rows={3} placeholder="e.g. Make it more dramatic, be shorter, add more detail..."
                onKeyDown={e => { if (e.ctrlKey && e.key === 'Enter') { const v = regenInstrRef.current?.value?.trim(); setRegenModal({ open: false }); regenerate(v || null); } }}
              />
            </div>
            <div className="modal-footer">
              <button className="btn-secondary" onClick={() => setRegenModal({ open: false })}>CANCEL</button>
              <button className="btn-primary" onClick={() => { const v = regenInstrRef.current?.value?.trim(); setRegenModal({ open: false }); regenerate(v || null); }}>REGENERATE</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

Object.assign(window, { WelcomeScreen, ChatView, UserAvatar });
