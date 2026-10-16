// hmm-folders.jsx — Character Folders page: organize characters into visual,
// nestable folders. Membership lives on the character (`folderId`), folder
// definitions in S.folders(); both ride the normal sync payload.
const { useState, useContext, useMemo } = React;
const { AppCtx, S, genId, CharAvatar, avatarPx } = window;

const FOLDER_COLORS = ['#e0a526', '#e5645a', '#e58a3c', '#6bbf59', '#3fb6a8', '#4a9be0', '#8a6be0', '#d664b6', '#8f98a3'];
const DRAG_CHAR = 'application/x-inkling-char';
const DRAG_FOLDER = 'application/x-inkling-folder';

function FolderIcon({ color, size = 64, open }) {
  return (
    <svg width={size} height={size * 0.8} viewBox="0 0 64 52" fill="none" style={{ flexShrink: 0 }}>
      <path d="M3 9C3 6.8 4.8 5 7 5H24L30 11H57C59.2 11 61 12.8 61 15V45C61 47.2 59.2 49 57 49H7C4.8 49 3 47.2 3 45V9Z"
        fill={color} opacity="0.55" />
      <path d={open ? 'M3 22C3 19.8 4.8 18 7 18H57C59.2 18 61 19.8 61 22V45C61 47.2 59.2 49 57 49H7C4.8 49 3 47.2 3 45V22Z'
                    : 'M3 17C3 14.8 4.8 13 7 13H57C59.2 13 61 14.8 61 17V45C61 47.2 59.2 49 57 49H7C4.8 49 3 47.2 3 45V17Z'}
        fill={color} />
    </svg>
  );
}

// Every folder id at or under `id` (used to block dropping a folder into itself).
function descendantIds(folders, id) {
  const out = new Set([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const f of folders) if (f.parentId && out.has(f.parentId) && !out.has(f.id)) { out.add(f.id); grew = true; }
  }
  return out;
}

function FolderEditDialog({ initial, onSave, onDelete, onCancel }) {
  const [draft, setDraft] = useState(initial);
  return (
    <div className="modal-overlay" onClick={onCancel}>
      <form className="fld-dialog" onClick={e => e.stopPropagation()} onSubmit={e => { e.preventDefault(); onSave(draft); }}>
        <div className="fld-dialog-title">{draft.isNew ? 'New folder' : 'Edit folder'}</div>
        <input
          autoFocus className="fld-name-input" placeholder="Folder name" maxLength={60}
          value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })}
        />
        <div className="fld-swatches">
          {FOLDER_COLORS.map(col => (
            <button type="button" key={col} className={`fld-swatch${draft.color === col ? ' on' : ''}`}
              style={{ background: col }} onClick={() => setDraft({ ...draft, color: col })} aria-label={col} />
          ))}
        </div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'space-between' }}>
          {!draft.isNew
            ? <button type="button" className="btn-secondary" style={{ color: 'var(--danger)' }} onClick={() => onDelete(draft)}>DELETE</button>
            : <span />}
          <span style={{ display: 'flex', gap: 8 }}>
            <button type="button" className="btn-secondary" onClick={onCancel}>CANCEL</button>
            <button type="submit" className="btn-primary" disabled={!draft.name.trim()}>SAVE</button>
          </span>
        </div>
      </form>
    </div>
  );
}

function FoldersPage({ onClose }) {
  const ctx = useContext(AppCtx);
  const [folders, setFoldersState] = useState(() => S.folders());
  const [cwd, setCwd] = useState(null);          // current folder id, null = top level
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState(null);  // folder being edited, or { isNew: true }
  const [moving, setMoving] = useState(null);    // { kind: 'char'|'folder', id }
  const [dropTarget, setDropTarget] = useState(undefined); // folder id / null(top) / undefined(none)

  const setFolders = fn => setFoldersState(prev => {
    const next = typeof fn === 'function' ? fn(prev) : fn;
    S.saveFolders(next);
    return next;
  });

  const byId = useMemo(() => Object.fromEntries(folders.map(f => [f.id, f])), [folders]);
  // A folder whose parent vanished (e.g. partial sync) is treated as top level.
  const parentOf = f => (f.parentId && byId[f.parentId] ? f.parentId : null);
  const charFolder = c => (c.folderId && byId[c.folderId] ? c.folderId : null);

  const crumbs = [];
  for (let id = cwd; id && byId[id]; id = parentOf(byId[id])) crumbs.unshift(byId[id]);

  const q = search.trim().toLowerCase();
  const matches = c => !q || c.name.toLowerCase().includes(q) ||
    (c.tags || []).some(t => t.toLowerCase().includes(q)) || (c.description || '').toLowerCase().includes(q);

  // Searching flattens everything so you can find a character in any folder.
  const subfolders = q ? [] : folders.filter(f => parentOf(f) === cwd);
  const visibleChars = ctx.chars.filter(c => matches(c) && (q || charFolder(c) === cwd));
  const countIn = id => {
    const ids = descendantIds(folders, id);
    return ctx.chars.filter(c => ids.has(charFolder(c))).length;
  };

  const moveChar = (charId, folderId) => ctx.setChars(prev => {
    const next = prev.map(c => c.id === charId ? { ...c, folderId: folderId || undefined } : c);
    S.saveChars(next);
    return next;
  });
  const moveFolder = (id, parentId) => {
    if (descendantIds(folders, id).has(parentId)) return; // no cycles
    setFolders(prev => prev.map(f => f.id === id ? { ...f, parentId: parentId || undefined } : f));
  };

  const saveFolder = f => {
    if (!f.name.trim()) return;
    if (f.isNew) setFolders(prev => [...prev, { id: genId(), name: f.name.trim(), color: f.color, parentId: cwd || undefined }]);
    else setFolders(prev => prev.map(x => x.id === f.id ? { ...x, name: f.name.trim(), color: f.color } : x));
    setEditing(null);
  };

  const deleteFolder = f => {
    const n = countIn(f.id);
    if (!window.confirm(`Delete folder "${f.name}"? ${n ? `Its ${n} character${n !== 1 ? 's' : ''} and any subfolders move up one level — nothing is deleted.` : ''}`.trim())) return;
    ctx.setChars(prev => {
      const next = prev.map(c => c.folderId === f.id ? { ...c, folderId: f.parentId || undefined } : c);
      S.saveChars(next);
      return next;
    });
    setFolders(prev => prev.filter(x => x.id !== f.id).map(x => x.parentId === f.id ? { ...x, parentId: f.parentId } : x));
    if (cwd === f.id) setCwd(f.parentId || null);
    setEditing(null);
  };

  const onDrop = (e, target) => {
    e.preventDefault(); e.stopPropagation();
    setDropTarget(undefined);
    const cid = e.dataTransfer.getData(DRAG_CHAR);
    const fid = e.dataTransfer.getData(DRAG_FOLDER);
    if (cid) moveChar(cid, target);
    else if (fid && fid !== target) moveFolder(fid, target);
  };
  const dropProps = target => ({
    onDragOver: e => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; if (dropTarget !== target) setDropTarget(target); },
    onDragLeave: () => setDropTarget(t => (t === target ? undefined : t)),
    onDrop: e => onDrop(e, target),
  });

  // Picker for the "Move to…" fallback (touch screens have no drag-and-drop).
  const renderMovePicker = () => {
    const blocked = moving.kind === 'folder' ? descendantIds(folders, moving.id) : new Set();
    const rows = [];
    const walk = (parent, depth) => folders.filter(f => parentOf(f) === parent).sort((a, b) => a.name.localeCompare(b.name)).forEach(f => {
      if (blocked.has(f.id)) return;
      rows.push({ f, depth }); walk(f.id, depth + 1);
    });
    walk(null, 0);
    const pick = target => {
      moving.kind === 'char' ? moveChar(moving.id, target) : moveFolder(moving.id, target);
      setMoving(null);
    };
    return (
      <div className="modal-overlay" onClick={() => setMoving(null)}>
        <div className="fld-dialog" onClick={e => e.stopPropagation()}>
          <div className="fld-dialog-title">Move to…</div>
          <div className="fld-picker">
            <button className="fld-pick" onClick={() => pick(null)}>⌂ Top level</button>
            {rows.map(({ f, depth }) => (
              <button key={f.id} className="fld-pick" style={{ paddingLeft: 12 + depth * 16 }} onClick={() => pick(f.id)}>
                <span style={{ color: f.color }}>■</span> {f.name}
              </button>
            ))}
          </div>
          <button className="btn-secondary" onClick={() => setMoving(null)}>CANCEL</button>
        </div>
      </div>
    );
  };

  const empty = !subfolders.length && !visibleChars.length;

  return (
    <div className="fld-page">
      <div className="fld-head">
        <button className="btn-secondary" onClick={onClose}>← BACK</button>
        <div className="fld-title">Character Folders</div>
        <div className="sidebar-search fld-search">
          <input placeholder="Search all characters..." value={search} onChange={e => setSearch(e.target.value)}
            onKeyDown={e => e.key === 'Escape' && setSearch('')} />
          {search && <button onClick={() => setSearch('')} style={{ color: 'var(--text3)' }}>×</button>}
        </div>
        <button className="btn-primary" onClick={() => setEditing({ isNew: true, name: '', color: FOLDER_COLORS[0] })}>+ NEW FOLDER</button>
      </div>

      <div className="fld-crumbs">
        <button className={`fld-crumb${dropTarget === null ? ' drop' : ''}`} onClick={() => setCwd(null)} {...dropProps(null)}>⌂ All characters</button>
        {crumbs.map(f => (
          <React.Fragment key={f.id}>
            <span className="fld-sep">/</span>
            <button className={`fld-crumb${dropTarget === f.id ? ' drop' : ''}`} onClick={() => setCwd(f.id)} {...dropProps(f.id)}>{f.name}</button>
          </React.Fragment>
        ))}
        {q && <span className="fld-sep">· searching all folders</span>}
      </div>

      <div className="fld-body" {...dropProps(cwd)}>
        {subfolders.length > 0 && (
          <div className="fld-grid">
            {subfolders.sort((a, b) => a.name.localeCompare(b.name)).map(f => (
              <div
                key={f.id} className={`fld-tile${dropTarget === f.id ? ' drop' : ''}`}
                draggable onDragStart={e => { e.dataTransfer.setData(DRAG_FOLDER, f.id); e.dataTransfer.effectAllowed = 'move'; }}
                onDragEnd={() => setDropTarget(undefined)}
                onClick={() => setCwd(f.id)} {...dropProps(f.id)}
              >
                <FolderIcon color={f.color || FOLDER_COLORS[0]} open={dropTarget === f.id} />
                <div className="fld-name">{f.name}</div>
                <div className="fld-count">{countIn(f.id)} char{countIn(f.id) !== 1 ? 's' : ''}</div>
                <div className="fld-tile-actions">
                  <button title="Edit folder" onClick={e => { e.stopPropagation(); setEditing({ ...f }); }}>✎</button>
                  <button title="Move folder" onClick={e => { e.stopPropagation(); setMoving({ kind: 'folder', id: f.id }); }}>⇢</button>
                </div>
              </div>
            ))}
          </div>
        )}

        {visibleChars.length > 0 && (
          <div className="fld-chars">
            {visibleChars.map(c => (
              <div
                key={c.id} className="fld-char" draggable
                onDragStart={e => { e.dataTransfer.setData(DRAG_CHAR, c.id); e.dataTransfer.effectAllowed = 'move'; }}
                onDragEnd={() => setDropTarget(undefined)}
                onClick={() => { ctx.selectChar(c.id); onClose(); }}
              >
                <CharAvatar char={c} size={avatarPx(ctx.settings, 56)} />
                <div className="fld-char-name">{c.isGroup ? '◈ ' : ''}{c.name}</div>
                {q && charFolder(c) && <div className="fld-count">{byId[charFolder(c)].name}</div>}
                <button className="fld-char-move" title="Move to folder…" onClick={e => { e.stopPropagation(); setMoving({ kind: 'char', id: c.id }); }}>⇢</button>
              </div>
            ))}
          </div>
        )}

        {empty && (
          <div className="chars-empty" style={{ marginTop: 60 }}>
            <div className="empty-icon">{q ? '⌀' : '▤'}</div>
            <div>{q ? `No matches for "${search}"` : cwd ? 'This folder is empty' : 'Nothing here yet'}</div>
            {!q && <div style={{ fontSize: 10, color: 'var(--text3)', marginTop: 4 }}>Make a folder, then drag characters onto it</div>}
          </div>
        )}
      </div>

      {editing && <FolderEditDialog initial={editing} onSave={saveFolder} onDelete={deleteFolder} onCancel={() => setEditing(null)} />}
      {moving && renderMovePicker()}
    </div>
  );
}

Object.assign(window, { FoldersPage });
