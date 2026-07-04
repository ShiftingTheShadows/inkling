// hmm-app.jsx — Root App
const { useState, useEffect, useCallback } = React;
const { AppCtx, S, genId } = window;
const { Sidebar, WelcomeScreen, ChatView } = window;
const { ToastStack, CommandPalette, SettingsModal, CharEditorModal, GroupEditorModal, ImportModal, HistoryModal, PersonasModal, SyncModal, LorebookModal } = window;

function App() {
  const [chars, setChars]               = useState(() => S.chars());
  const [currentChar, setCurrentChar]   = useState(null);
  const [settings, setSettingsState]    = useState(() => S.settings());
  const [toasts, setToasts]             = useState([]);
  const [modal, setModal]               = useState(null);
  const [cmdOpen, setCmdOpen]           = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(260);
  const [isMobile, setIsMobile] = useState(() => window.matchMedia('(max-width: 720px)').matches);
  const [collapsed, setCollapsed]       = useState(() => window.matchMedia('(max-width: 720px)').matches);
  const [personas, setPersonas]         = useState(() => S.personas());
  const [activePersonaId, setActivePersonaIdState] = useState(() => S.activePersonaId());

  const setActivePersonaId = useCallback(id => {
    S.setActivePersonaId(id);
    setActivePersonaIdState(id);
  }, []);

  const activePersona = personas.find(p => p.id === activePersonaId) || personas[0] || { id: 'default', name: 'You', description: '', avatar: '' };

  // Apply theme + interface prefs to root element
  useEffect(() => {
    const theme = settings.theme || 'terminal';
    document.documentElement.setAttribute('data-theme', theme === 'terminal' ? '' : theme);
    const root = document.documentElement;
    root.style.setProperty('--chat-font-size', (settings.fontSize || 13) + 'px');
    const dens = settings.density || 'cozy';
    root.style.setProperty('--msg-pad', dens === 'compact' ? '5px 4px' : dens === 'roomy' ? '13px 4px' : '8px 4px');
    root.style.setProperty('--msg-gap', dens === 'compact' ? '8px' : dens === 'roomy' ? '16px' : '12px');
    document.body.classList.toggle('reduce-motion', !!settings.reduceMotion);
  }, [settings.theme, settings.fontSize, settings.density, settings.reduceMotion]);

  // Restore last character on mount
  useEffect(() => {
    const lastId = localStorage.getItem('hmm_current');
    if (lastId) {
      const c = S.chars().find(x => x.id === lastId);
      if (c) setCurrentChar(c);
    }
  }, []);

  useEffect(() => {
    if (currentChar) localStorage.setItem('hmm_current', currentChar.id);
    else localStorage.removeItem('hmm_current');
  }, [currentChar?.id]);

  const addToast = useCallback((message, type = 'info') => {
    const id = genId();
    setToasts(prev => [...prev, { id, message, type }]);
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 3000);
  }, []);

  const openModal  = useCallback((type, data = null) => setModal({ type, data }), []);
  const closeModal = useCallback(() => setModal(null), []);

  const saveSettings = useCallback(s => {
    S.saveSettings(s);
    setSettingsState(s);
    document.documentElement.setAttribute('data-theme', (!s.theme || s.theme === 'terminal') ? '' : s.theme);
  }, []);

  const selectChar = useCallback(id => {
    const c = S.chars().find(x => x.id === id);
    if (c) setCurrentChar(c);
    // On phones, close the drawer after picking a character
    if (window.matchMedia('(max-width: 720px)').matches) setCollapsed(true);
  }, []);

  const exportAll = useCallback(() => {
    const data = { version: 1, characters: S.chars(), exportedAt: new Date().toISOString() };
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    Object.assign(document.createElement('a'), {
      href: url,
      download: `hmm_backup_${new Date().toLocaleDateString().replace(/\//g, '-')}.json`
    }).click();
    URL.revokeObjectURL(url);
    addToast('All data exported', 'success');
  }, [addToast]);

  // Global keyboard shortcuts
  useEffect(() => {
    const fn = e => {
      if (e.ctrlKey && e.key === 'k') { e.preventDefault(); setCmdOpen(v => !v); }
      if (e.ctrlKey && e.key === ',') { e.preventDefault(); openModal('settings'); }
      if (e.ctrlKey && e.key === 'n') { e.preventDefault(); openModal('char-editor', null); }
      if (e.ctrlKey && e.key === 's') { e.preventDefault(); openModal('sync'); }
      if (e.key === 'Escape') { setCmdOpen(false); closeModal(); }
    };
    window.addEventListener('keydown', fn);
    return () => window.removeEventListener('keydown', fn);
  }, [openModal, closeModal]);

  // Sidebar drag-resize
  const startResize = useCallback(e => {
    const startX = e.clientX, startW = sidebarWidth;
    const onMove = ev => setSidebarWidth(Math.max(200, Math.min(420, startW + ev.clientX - startX)));
    const onUp   = () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [sidebarWidth]);

  // Track viewport — keep isMobile in sync, auto-collapse when crossing into mobile
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 720px)');
    const onChange = e => { setIsMobile(e.matches); setCollapsed(e.matches); };
    mq.addEventListener ? mq.addEventListener('change', onChange) : mq.addListener(onChange);
    return () => { mq.removeEventListener ? mq.removeEventListener('change', onChange) : mq.removeListener(onChange); };
  }, []);

  // History restore helper
  const restoreHistory = msgs => {
    if (!currentChar) return;
    const cur = S.chat(currentChar.id);
    if (cur.length > 0) {
      const hist = S.history(currentChar.id);
      const title = cur.find(m => m.role === 'user');
      const titleText = title ? (typeof title.content === 'string' ? title.content : title.content?.find?.(c => c.type === 'text')?.text || '') : 'Session';
      S.saveHistory(currentChar.id, [{ id: genId(), title: titleText.slice(0, 60), messages: cur, savedAt: new Date().toISOString(), messageCount: cur.length }, ...hist].slice(0, 50));
    }
    S.saveChat(currentChar.id, msgs);
    // Force ChatView remount by briefly nulling then restoring
    const saved = currentChar;
    setCurrentChar(null);
    setTimeout(() => {
      const fresh = S.chars().find(c => c.id === saved.id);
      setCurrentChar(fresh || saved);
    }, 30);
    addToast('Session restored', 'success');
  };

  const modelShort = settings.model?.replace('claude-', '').replace(/-20\d{6}$/, '') || 'haiku';

  const ctx = {
    chars, setChars,
    currentChar, setCurrentChar,
    settings, saveSettings,
    toasts, addToast,
    modal, openModal, closeModal,
    cmdOpen, setCmdOpen,
    sidebarWidth,
    selectChar, exportAll,
    personas, setPersonas,
    activePersonaId, setActivePersonaId,
    activePersona,
  };

  return (
    <AppCtx.Provider value={ctx}>
      <div className="app">

        {/* ── Top bar ── */}
        <header className="topbar">
          <div className="topbar-left">
            <button
              className="btn-icon" style={{ width: 30, height: 30 }}
              onClick={() => setCollapsed(v => !v)}
              title={collapsed ? 'Show sidebar' : 'Hide sidebar'}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                <path d="M3 6H21M3 12H21M3 18H21" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
              </svg>
            </button>
            <div className="logo" onClick={() => setCurrentChar(null)}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" style={{ color: 'var(--accent)', flexShrink: 0 }}>
                <path d="M12 2L2 7L12 12L22 7L12 2Z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round"/>
                <path d="M2 17L12 22L22 17" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/>
                <path d="M2 12L12 17L22 12" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/>
              </svg>
              <span className="logo-text">Inkling</span>
            </div>
          </div>

          <button className="cmd-trigger" onClick={() => setCmdOpen(true)} title="Command palette (Ctrl+K)">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
              <circle cx="11" cy="11" r="8" stroke="currentColor" strokeWidth="2"/>
              <path d="M21 21L16.65 16.65" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
            </svg>
            <span style={{ flex: 1, textAlign: 'left' }}>Search characters or commands...</span>
            <span className="cmd-kbd">Ctrl K</span>
          </button>

          <div className="topbar-right">
            <button className="btn-icon" title="Scripts / World Info" onClick={() => openModal('lorebook')}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none"><path d="M4 4V20C4 20.5 4.5 21 5 21H19C19.5 21 20 20.5 20 20V8L14 2H5C4.5 2 4 2.5 4 3V4Z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round"/><path d="M14 2V8H20" stroke="currentColor" strokeWidth="2" strokeLinejoin="round"/><path d="M8 13H16M8 17H13" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"/></svg>
            </button>
            <button className="btn-icon" title="Sync to GitHub Gist (Ctrl+S)" onClick={() => openModal('sync')} style={{ color: localStorage.getItem('hmm_gh_token') ? 'var(--accent2)' : 'var(--text2)' }}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2z" stroke="currentColor" strokeWidth="2"/><path d="M12 8v4l3 3" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/><path d="M16.24 7.76A6 6 0 1 0 7.76 16.24" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/><path d="M22 12h-4M18 8l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
            </button>
            <button className="btn-icon" title="Export all data" onClick={exportAll}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none"><path d="M21 15V19C21 20.1 20.1 21 19 21H5C3.9 21 3 20.1 3 19V15" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/><path d="M7 10L12 15L17 10M12 15V3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
            </button>
            <button className="btn-icon" title="Import character" onClick={() => openModal('import')}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none"><path d="M21 15V19C21 20.1 20.1 21 19 21H5C3.9 21 3 20.1 3 19V15" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/><path d="M17 8L12 3L7 8M12 3V15" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
            </button>
            <button className="btn-icon" title="Settings (Ctrl+,)" onClick={() => openModal('settings')}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="2"/><path d="M12 1V3M12 21V23M4.22 4.22L5.64 5.64M18.36 18.36L19.78 19.78M1 12H3M21 12H23M4.22 19.78L5.64 18.36M18.36 5.64L19.78 4.22" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
            </button>
          </div>
        </header>

        {/* ── Main ── */}
        <div className={`main${isMobile ? ' is-mobile' : ''}`}>
          {!collapsed && (
            <>
              {isMobile && <div className="sidebar-backdrop" onClick={() => setCollapsed(true)} />}
              <Sidebar />
              {!isMobile && <div className="resize-handle" onMouseDown={startResize} title="Drag to resize" />}
            </>
          )}
          <main className="chat-area">
            {!currentChar
              ? <WelcomeScreen chars={chars} onNewChar={() => openModal('char-editor', null)} onImport={() => openModal('import')} onSelectChar={selectChar} />
              : <ChatView key={currentChar.id} />
            }
          </main>
        </div>

        {/* ── Status bar ── */}
        <div className="statusbar">
          <span>{chars.length} character{chars.length !== 1 ? 's' : ''}</span>
          <span>|</span>
          <span>{modelShort}</span>
          {currentChar && (
            <>
              <span>|</span>
              <span style={{ color: 'var(--accent)' }}>{currentChar.name}</span>
            </>
          )}
          <span className="statusbar-right">Ctrl+K → palette · Ctrl+F → search · Ctrl+, → settings</span>
        </div>
      </div>

      {/* ── Overlays ── */}
      <ToastStack />
      <CommandPalette />

      {modal?.type === 'settings'    && <SettingsModal onClose={closeModal} />}
      {modal?.type === 'char-editor' && <CharEditorModal editId={modal.data} onClose={closeModal} />}
      {modal?.type === 'group-editor' && <GroupEditorModal editId={modal.data} onClose={closeModal} />}
      {modal?.type === 'import'      && <ImportModal onClose={closeModal} />}
      {modal?.type === 'personas'    && <PersonasModal onClose={closeModal} />}
      {modal?.type === 'sync'        && <SyncModal onClose={closeModal} />}
      {modal?.type === 'lorebook'    && <LorebookModal onClose={closeModal} />}
      {modal?.type === 'history' && currentChar && (
        <HistoryModal char={currentChar} onRestore={restoreHistory} onClose={closeModal} />
      )}
    </AppCtx.Provider>
  );
}

// Wait for IndexedDB hydration before first render (fixes quota-era data loading)
(window.InklingStorageReady || Promise.resolve()).then(() => {
  ReactDOM.createRoot(document.getElementById('root')).render(<App />);
});
