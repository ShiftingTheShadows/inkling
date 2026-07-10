// hmm-sidebar.jsx — Character list sidebar
const { useState, useContext } = React;
const { AppCtx, S, charBg, charFg, avatarPx } = window;

function CharAvatar({ char, size = 40 }) {
  const [failed, setFailed] = useState(false);
  const isPlaceholder = !char.avatar || char.avatar.includes('default-avatar') || char.avatar.startsWith('/assets/');
  if (failed || isPlaceholder) {
    return (
      <div style={{
        width: size, height: size,
        background: charBg(char.name),
        color: charFg(char.name),
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: Math.round(size * 0.36), fontWeight: 700,
        flexShrink: 0, border: '1px solid var(--border2)', fontFamily: 'var(--font)',
        letterSpacing: '0.02em',
      }}>
        {(char.name || '?').slice(0, 2).toUpperCase()}
      </div>
    );
  }
  return (
    <img
      src={char.avatar} alt={char.name} onError={() => setFailed(true)}
      style={{ width: size, height: size, objectFit: 'cover', flexShrink: 0, border: '1px solid var(--border2)' }}
    />
  );
}

function CharCard({ char, isActive, onSelect, onFav }) {
  const ctx = useContext(AppCtx);
  const msgs = S.chat(char.id);
  const last = msgs[msgs.length - 1];
  const rawPreview = last
    ? (typeof last.content === 'string' ? last.content : last.content?.find?.(c => c.type === 'text')?.text || '')
    : (char.firstMessage || char.description || '');
  const preview = rawPreview.replace(/\*/g, '').replace(/\s+/g, ' ').trim().slice(0, 50);

  return (
    <div
      className={`char-card${isActive ? ' active' : ''}`}
      onClick={() => onSelect(char.id)}
    >
      <CharAvatar char={char} size={avatarPx(ctx.settings, 48)} />
      <div className="char-card-info">
        <div className="char-card-name">{char.isGroup ? '◈ ' : ''}{char.name}</div>
        <div className="char-card-preview">{preview || '—'}</div>
        {char.tags?.length > 0 && (
          <div className="char-tags">
            {char.tags.slice(0, 3).map(t => <span key={t} className="tag">{t}</span>)}
          </div>
        )}
      </div>
      <button
        className={`fav-btn${char.favorite ? ' active' : ''}`}
        onClick={e => { e.stopPropagation(); onFav(char.id); }}
        title={char.favorite ? 'Unfavorite' : 'Favorite'}
      >★</button>
    </div>
  );
}

function Sidebar() {
  const ctx = useContext(AppCtx);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all');
  const [tagFilter, setTagFilter] = useState(null);
  const allTags = [...new Set(ctx.chars.flatMap(c => c.tags || []))].sort();

  const toggleFav = id => {
    ctx.setChars(prev => {
      const next = prev.map(c => c.id === id ? { ...c, favorite: !c.favorite } : c);
      S.saveChars(next);
      return next;
    });
  };

  let chars = [...ctx.chars];
  if (search.trim()) {
    const q = search.toLowerCase();
    chars = chars.filter(c =>
      c.name.toLowerCase().includes(q) ||
      (c.tags || []).some(t => t.toLowerCase().includes(q)) ||
      (c.description || '').toLowerCase().includes(q)
    );
  }
  if (filter === 'fav') chars = chars.filter(c => c.favorite);
  if (filter === 'recent') chars = [...chars].sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));
  if (tagFilter) chars = chars.filter(c => (c.tags || []).includes(tagFilter));

  return (
    <aside className="sidebar" style={{ width: ctx.sidebarWidth }}>
      <div className="sidebar-top">
        <div className="sidebar-search">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" style={{ color: 'var(--text3)', flexShrink: 0 }}>
            <circle cx="11" cy="11" r="8" stroke="currentColor" strokeWidth="2"/>
            <path d="M21 21L16.65 16.65" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
          </svg>
          <input
            placeholder="Search characters..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            onKeyDown={e => e.key === 'Escape' && setSearch('')}
          />
          {search && (
            <button onClick={() => setSearch('')} style={{ color: 'var(--text3)', fontSize: 14, lineHeight: 1, width: 16, height: 16, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>×</button>
          )}
        </div>
        <div className="char-filters">
          {[['all', 'ALL'], ['fav', '★ FAV'], ['recent', 'RECENT']].map(([v, l]) => (
            <button
              key={v}
              className={`filter-btn${filter === v ? ' active' : ''}`}
              onClick={() => setFilter(v)}
            >{l}</button>
          ))}
        </div>
        {allTags.length > 0 && (
          <div style={{ display: 'flex', gap: 4, overflowX: 'auto', padding: '6px 10px 2px', scrollbarWidth: 'none' }}>
            {allTags.map(t => (
              <span
                key={t} className="tag"
                onClick={() => setTagFilter(tagFilter === t ? null : t)}
                style={{ cursor: 'pointer', flexShrink: 0, ...(tagFilter === t ? { background: 'var(--accent3)', color: 'var(--accent)', fontWeight: 700 } : {}) }}
              >{t}</span>
            ))}
          </div>
        )}
      </div>

      <div className="char-list">
        {chars.length === 0 ? (
          <div className="chars-empty">
            <div className="empty-icon">{search ? '⌀' : '◈'}</div>
            {search
              ? <div>No matches for "{search}"</div>
              : <>
                  <div>No characters yet</div>
                  <div style={{ fontSize: 10, color: 'var(--text3)', marginTop: 4 }}>Use the button below to create one</div>
                </>
            }
          </div>
        ) : chars.map(c => (
          <CharCard
            key={c.id}
            char={c}
            isActive={ctx.currentChar?.id === c.id}
            onSelect={ctx.selectChar}
            onFav={toggleFav}
          />
        ))}
      </div>

      <div style={{ display: 'flex' }}>
        <button className="btn-new-char" style={{ flex: 1.4 }} onClick={() => ctx.openModal('char-editor', null)}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
            <path d="M12 5V19M5 12H19" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"/>
          </svg>
          NEW CHAR
        </button>
        <button className="btn-new-char" style={{ flex: 1, borderLeft: '1px solid var(--border2)' }} onClick={() => ctx.openModal('group-editor', null)} title="Group chat — multiple characters in one scene">
          ◈ GROUP
        </button>
      </div>
    </aside>
  );
}

Object.assign(window, { Sidebar, CharAvatar });
