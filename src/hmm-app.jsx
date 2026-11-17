// hmm-app.jsx — Root App
const { useState, useEffect, useCallback } = React;
const { AppCtx, S, genId, GistSync, RailwaySync, SyncCrypto, CHANGELOG, providerProfile } = window;
const { Sidebar, WelcomeScreen, ChatView, FoldersPage, McpSetupModal, LocalModelsModal } = window;
const { ToastStack, CommandPalette, SettingsModal, CharEditorModal, GroupEditorModal, ImportModal, HistoryModal, PersonasModal, SyncModal, LorebookModal, ChangelogModal } = window;

// Persistent warning when a storage write fails. A toast would vanish before
// the user acts on it, and the whole point is that data may not be saved.
function StorageAlert({ fault, onExport }) {
  const [dismissed, setDismissed] = useState(-1);
  const [usage, setUsage] = useState(null);
  const failing = !!fault && !fault.ok;

  useEffect(() => {
    if (!failing) return;
    navigator.storage?.estimate?.().then(setUsage).catch(() => {});
  }, [failing, fault?.count]);

  if (!failing || dismissed === fault.count) return null;

  const msg = fault.kind === 'quota'
    ? 'Storage is full — recent changes were NOT saved. Export a backup, then delete some chats or images.'
    : fault.kind === 'blocked'
    ? 'The browser is blocking site storage (private window or blocked site data). Changes will not persist.'
    : fault.kind === 'unavailable'
    ? 'IndexedDB is unavailable — data is in memory only and will be lost when this tab closes.'
    : 'Some saves are failing. Export a backup to be safe.';
  const size = usage?.quota ? `${(usage.usage / 1048576).toFixed(1)} / ${(usage.quota / 1048576).toFixed(0)} MB` : null;

  return (
    <div className="storage-alert" role="alert">
      <span aria-hidden="true" style={{ color: 'var(--danger)', fontWeight: 700 }}>!</span>
      <span className="storage-alert-text">{msg}{size ? ` (${size})` : ''}</span>
      <button className="btn-secondary btn-sm" onClick={onExport}>EXPORT BACKUP</button>
      <button className="btn-secondary btn-sm" onClick={() => setDismissed(fault.count)}>DISMISS</button>
    </div>
  );
}

function App() {
  const [chars, setChars]               = useState(() => S.chars());
  const [currentChar, setCurrentChar]   = useState(null);
  const [settings, setSettingsState]    = useState(() => S.settings());
  const [toasts, setToasts]             = useState([]);
  const [modal, setModal]               = useState(null);
  const [page, setPage]                 = useState(null); // null = chat/welcome, 'folders' = Character Folders
  const [cmdOpen, setCmdOpen]           = useState(false);
  // B12: a palette hit for one message selects its chat and asks ChatView to
  // scroll to and flash that message.
  const [jumpTo, setJumpTo]             = useState(null);
  const [sidebarWidth, setSidebarWidth] = useState(260);
  const [isMobile, setIsMobile] = useState(() => window.matchMedia('(max-width: 720px)').matches);
  const [collapsed, setCollapsed]       = useState(() => window.matchMedia('(max-width: 720px)').matches);
  const [personas, setPersonas]         = useState(() => S.personas());
  const [activePersonaId, setActivePersonaIdState] = useState(() => S.activePersonaId());
  const [storageFault, setStorageFault] = useState(() => S.storageHealth());

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
    root.style.setProperty('--msg-align', settings.msgAlign || 'left');
    // Textbox grid. The CSS sizes the box from these so the drag handle and the
    // pagination arithmetic can never disagree about how big a page is.
    root.style.setProperty('--tbx-cols', settings.textboxCols || 46);
    root.style.setProperty('--tbx-rows', settings.textboxRows || 3);
    document.body.classList.toggle('reduce-motion', !!settings.reduceMotion);
    // Subtle UI polish (soft corners, hover motion, gentle entrances). On by
    // default; the legacy look is this class removed. reduce-motion still
    // neutralises the moving parts independently. Skipped for win98, whose
    // beveled square chrome is the whole point.
    document.body.classList.toggle('polish', settings.uiPolish !== false && theme !== 'win98');
  }, [settings.theme, settings.fontSize, settings.density, settings.reduceMotion, settings.msgAlign,
      settings.textboxCols, settings.textboxRows, settings.uiPolish]);

  // Custom background image (GIFs animate natively) + custom CSS injection
  useEffect(() => {
    document.documentElement.classList.toggle('has-custom-bg', !!settings.customBackground);
    if (settings.customBackground) {
      document.body.style.backgroundImage = `url("${settings.customBackground}")`;
      document.body.style.backgroundSize = 'cover';
      document.body.style.backgroundPosition = 'center';
      document.body.style.backgroundAttachment = 'fixed';
      document.body.style.backgroundRepeat = 'no-repeat';
    } else {
      document.body.style.backgroundImage = '';
      document.body.style.backgroundSize = '';
      document.body.style.backgroundPosition = '';
      document.body.style.backgroundAttachment = '';
      document.body.style.backgroundRepeat = '';
    }
  }, [settings.customBackground]);

  useEffect(() => {
    let styleTag = document.getElementById('hmm-custom-css');
    if (!styleTag) {
      styleTag = document.createElement('style');
      styleTag.id = 'hmm-custom-css';
      document.head.appendChild(styleTag);
    }
    styleTag.textContent = settings.customCSS || '';
  }, [settings.customCSS]);

  // Restore last character on mount
  useEffect(() => {
    const lastId = localStorage.getItem('hmm_current');
    if (lastId) {
      const c = S.chars().find(x => x.id === lastId);
      if (c) setCurrentChar(c);
    }
  }, []);

  // Auto-popup "What's New" for returning users after an update — skip on a
  // totally fresh install, since there's nothing to have missed yet
  useEffect(() => {
    const latest = CHANGELOG[0]?.version;
    if (!latest) return;
    const seen = S.lastSeenChangelog();
    if (seen === latest) return;
    if (!seen && S.chars().length === 0) { S.setLastSeenChangelog(latest); return; }
    setModal({ type: 'changelog' });
    S.setLastSeenChangelog(latest);
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

  // Storage failures are reported from outside React (utils), so subscribe
  // rather than polling. onStorageError fires once immediately, which catches
  // a failure that happened during boot-time migration.
  useEffect(() => S.onStorageError(setStorageFault), []);

  // F44: every modal behaves like a dialog — role/aria-modal, a focus trap while
  // it is open, and focus restored to whatever opened it. Icon-only buttons get
  // an accessible name from their title, including ones rendered later.
  useEffect(() => {
    const fixLabels = root => root?.querySelectorAll?.('[title]:not([aria-label])').forEach(el => el.setAttribute('aria-label', el.getAttribute('title')));
    fixLabels(document);
    const obs = new MutationObserver(muts => muts.forEach(m => m.addedNodes.forEach(n => { if (n.nodeType === 1) fixLabels(n); })));
    obs.observe(document.body, { childList: true, subtree: true });
    return () => obs.disconnect();
  }, []);

  useEffect(() => {
    if (!modal) return;
    const overlay = document.querySelector('.modal-overlay');
    if (!overlay) return;
    const dialog = overlay.querySelector('.modal') || overlay.firstElementChild || overlay;
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    if (!dialog.getAttribute('aria-label')) {
      const title = dialog.querySelector('.modal-title')?.textContent?.trim();
      dialog.setAttribute('aria-label', title || 'Dialog');
    }
    const prev = document.activeElement;
    const focusables = () => Array.from(dialog.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'))
      .filter(el => !el.disabled && el.offsetParent !== null);
    if (!dialog.contains(document.activeElement)) focusables()[0]?.focus();
    const onKey = e => {
      if (e.key !== 'Tab') return;
      const list = focusables();
      if (!list.length) return;
      const i = list.indexOf(document.activeElement);
      if (e.shiftKey && i <= 0) { e.preventDefault(); list[list.length - 1].focus(); }
      else if (!e.shiftKey && (i === -1 || i === list.length - 1)) { e.preventDefault(); list[0].focus(); }
    };
    dialog.addEventListener('keydown', onKey);
    return () => {
      dialog.removeEventListener('keydown', onKey);
      try { prev?.focus?.(); } catch {}
    };
  }, [modal]);

  // D26: drop trash older than the 30-day retention once per launch.
  useEffect(() => { S.purgeTrash(); }, []);

  // Railway auto-sync: push shortly after any local data change (see
  // __notifyDataChange in hmm-utils.jsx), and pull-then-reload when another
  // device has pushed something newer. Opt-in via Settings → Sync → Railway.
  // Config lives in localStorage (not React state) since SyncModal owns it;
  // it dispatches 'hmm-railway-config-changed' whenever it's edited so this
  // restarts with the new url/token/enabled without needing a page reload.
  useEffect(() => {
    let pushTimer = null;
    let pushInFlight = false;
    let pollTimer = null;
    let warnedLocked = false;

    // One toast per launch: an encrypted backup with no key would otherwise
    // nag on every local edit and every 60s poll.
    const warnLocked = msg => {
      if (warnedLocked) return;
      warnedLocked = true;
      addToast(msg || 'Sync is locked — open Settings → Sync and unlock with your passphrase.', 'warning');
    };

    const stop = () => {
      clearTimeout(pushTimer); pushTimer = null;
      clearInterval(pollTimer); pollTimer = null;
      delete window.__hmmOnDataChange;
    };

    const doPush = async (url, token) => {
      pushInFlight = true;
      try {
        const res = await RailwaySync.push(url, token, S.syncRevision());
        localStorage.setItem('hmm_railway_last_sync', res.updatedAt);
        S.setSyncRevision(res.revision);
      } catch (e) {
        // Another device wrote since this one last read: never overwrite it
        // unattended — pull and merge instead, which is what poll() already
        // does (and it only reloads when something actually changed).
        if (e.locked) {
          warnLocked(e.message);
        } else if (e.conflict) {
          pushInFlight = false;
          await poll(url, token);
        } else {
          console.warn('Auto-sync push failed:', e);
        }
      } finally {
        pushInFlight = false;
      }
    };

    const poll = async (url, token) => {
      if (pushInFlight || pushTimer) return; // local changes pending, don't clobber them
      try {
        const remote = await RailwaySync.meta(url, token);
        // D29: don't pull (and definitely don't push) a blob this session
        // cannot decrypt; wait for the user to unlock instead.
        if (remote && remote.encrypted && !SyncCrypto.unlocked()) {
          warnLocked('Sync is end-to-end encrypted — open Settings → Sync and enter your passphrase to receive changes.');
          return;
        }
        const remoteUpdatedAt = remote && remote.updatedAt;
        const lastSync = localStorage.getItem('hmm_railway_last_sync');
        if (remoteUpdatedAt && (!lastSync || new Date(remoteUpdatedAt) > new Date(lastSync))) {
          const { data, revision } = await RailwaySync.pull(url, token);
          if (revision != null) S.setSyncRevision(revision);
          // Merge, never replace: an unattended poll must not discard what was
          // typed here since the last push. Only reload when something landed.
          const stats = GistSync.restorePayload(data, { mode: 'merge' });
          // Store the server's updated_at (from the meta check above), not
          // data.exportedAt: that's the *other* device's client clock, which
          // would make this device think its own pull is instantly stale again.
          localStorage.setItem('hmm_railway_last_sync', remoteUpdatedAt);
          if (stats && stats.changed > 0) {
            addToast(`Synced ${stats.changed} change${stats.changed === 1 ? '' : 's'} from another device, reloading...`, 'success');
            setTimeout(() => window.location.reload(), 1400);
          }
        }
      } catch (e) {
        if (e.locked) warnLocked(e.message);
        else console.warn('Auto-sync poll failed:', e);
      }
    };

    const start = async () => {
      stop();
      const url = localStorage.getItem('hmm_railway_url');
      const token = localStorage.getItem('hmm_railway_token');
      const enabled = localStorage.getItem('hmm_railway_autosync') === 'true';
      if (!enabled || !url || !token) return;
      // A remembered key has to be in memory before the first poll, otherwise
      // pulling an encrypted backup would report itself as locked.
      await SyncCrypto.loadRemembered();
      window.__hmmOnDataChange = () => {
        clearTimeout(pushTimer);
        pushTimer = setTimeout(() => { pushTimer = null; doPush(url, token); }, 4000);
      };
      poll(url, token); // catch up on load
      pollTimer = setInterval(() => poll(url, token), 60000);
    };

    start();
    window.addEventListener('hmm-railway-config-changed', start);
    return () => { window.removeEventListener('hmm-railway-config-changed', start); stop(); };
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
    if (c) { setCurrentChar(c); setPage(null); }
    // On phones, close the drawer after picking a character
    if (window.matchMedia('(max-width: 720px)').matches) setCollapsed(true);
  }, []);

  const exportAll = useCallback(() => {
    // Same payload shape as GistSync (characters, chats, histories, lorebook,
    // scripts, personas, secret-stripped settings) so this file round-trips
    // through both the gist sync and the Import Character file picker.
    const data = GistSync.buildPayload();
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    Object.assign(document.createElement('a'), {
      href: url,
      download: `inkling_backup_${new Date().toLocaleDateString().replace(/\//g, '-')}.json`
    }).click();
    URL.revokeObjectURL(url);
    addToast('Full backup exported', 'success');
  }, [addToast]);

  // Global keyboard shortcuts
  useEffect(() => {
    const fn = e => {
      if (e.ctrlKey && e.key === 'k') { e.preventDefault(); setCmdOpen(v => !v); }
      if (e.ctrlKey && e.key === ',') { e.preventDefault(); openModal('settings'); }
      if (e.ctrlKey && e.key === 'n') { e.preventDefault(); openModal('char-editor', null); }
      if (e.ctrlKey && e.key === 's') { e.preventDefault(); openModal('sync'); }
      if (e.key === 'Escape') {
        setCmdOpen(false);
        // Modals with unsaved-work risk (char/group editor) register a guard
        // that confirms before letting Escape discard changes.
        if (!window.__hmmModalGuard || window.__hmmModalGuard()) closeModal();
      }
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

  // Show the model actually in use: settings.model is the Anthropic id and is
  // stale/meaningless once OpenRouter or a local endpoint is selected.
  const provider = settings.provider || 'claude';
  const activeModel = providerProfile(settings).model;
  const modelShort = (activeModel || 'no model').replace(/^claude-/, '').replace(/-20\d{6}$/, '');

  const ctx = {
    chars, setChars,
    currentChar, setCurrentChar,
    settings, saveSettings,
    toasts, addToast,
    modal, openModal, closeModal,
    page, setPage,
    cmdOpen, setCmdOpen,
    jumpTo, setJumpTo,
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
            <div className="logo" onClick={() => { setCurrentChar(null); setPage(null); }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" style={{ color: 'var(--accent)', flexShrink: 0 }}>
                <path d="M12 2C12 2 5 11 5 15.5C5 19.09 8.13 22 12 22C15.87 22 19 19.09 19 15.5C19 11 12 2 12 2Z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round"/>
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
            <button className="btn-icon" title="Export full backup (characters, chats, lorebook, personas)" onClick={exportAll}>
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
            {page === 'folders'
              ? <FoldersPage onClose={() => setPage(null)} />
              : !currentChar
              ? <WelcomeScreen chars={chars} onNewChar={() => openModal('char-editor', null)} onImport={() => openModal('import')} onSelectChar={selectChar} />
              : <ChatView key={currentChar.id} />
            }
          </main>
        </div>

        <StorageAlert fault={storageFault} onExport={exportAll} />

        {/* ── Status bar ── */}
        <div className="statusbar">
          <span>{chars.length} character{chars.length !== 1 ? 's' : ''}</span>
          <span>|</span>
          <span>{provider !== 'claude' ? `${provider} · ` : ''}{modelShort}</span>
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
      {modal?.type === 'changelog'   && <ChangelogModal onClose={closeModal} />}
      {modal?.type === 'mcp-setup'   && <McpSetupModal onClose={closeModal} />}
      {modal?.type === 'local-models' && <LocalModelsModal onClose={closeModal} />}
      {modal?.type === 'history' && currentChar && (
        <HistoryModal char={currentChar} onRestore={restoreHistory} onClose={closeModal} />
      )}
    </AppCtx.Provider>
  );
}

// Wait for IndexedDB hydration before first render (fixes quota-era data loading)
(window.InklingStorageReady || Promise.resolve()).then(() => {
  // C21: install a saved textbox font before the first render, so the textbox
  // measures and paints with it rather than swapping fonts a frame later.
  window.applyTextboxFont(window.S.textboxFont());
  ReactDOM.createRoot(document.getElementById('root')).render(<App />);
});
