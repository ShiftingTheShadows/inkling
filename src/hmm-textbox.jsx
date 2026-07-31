// hmm-textbox.jsx — Undertale / Deltarune dialogue box.
// Deliberately self-contained: it takes text and a character, and renders a
// box. It knows nothing about chat, sending or storage, so the later
// fullscreen "present mode" can reuse it unchanged.
const { useState, useEffect, useRef, useMemo, useCallback } = React;
const { parseTextbox, expressionAt, resolveExpressionKey, pitchForCharacter } = window;

const DEFAULT_COLS = 46;
const DEFAULT_ROWS = 3;
// Clamps for the drag handle. Below ~20 cols words stop fitting on a line at
// all; above ~120 the box outgrows the chat column on a laptop.
const MIN_COLS = 20, MAX_COLS = 120;
const MIN_ROWS = 1, MAX_ROWS = 12;

// Square-wave blip per character. Synthesized rather than sampled: no bundled
// audio, nothing copyrighted, works offline, and per-character pitch is closer
// to what the games do than one shared sample.
let __audioCtx = null;
function blip(pitch) {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    __audioCtx = __audioCtx || new Ctx();
    if (__audioCtx.state === 'suspended') return; // needs a user gesture first
    const osc = __audioCtx.createOscillator();
    const gain = __audioCtx.createGain();
    osc.type = 'square';
    osc.frequency.value = pitch;
    gain.gain.setValueAtTime(0.04, __audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, __audioCtx.currentTime + 0.05);
    osc.connect(gain).connect(__audioCtx.destination);
    osc.start();
    osc.stop(__audioCtx.currentTime + 0.05);
  } catch { /* audio is decorative, never break rendering over it */ }
}

function Textbox({ char, text, settings, streaming, onChoice, onResize }) {
  const reduce = !!settings?.reduceMotion
    || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

  // While dragging, the live size lives here so the box tracks the finger
  // without a storage write per pointermove. Committed on release.
  const [drag, setDrag] = useState(null);
  const cols = drag ? drag.cols : (settings?.textboxCols || DEFAULT_COLS);
  const rows = drag ? drag.rows : (settings?.textboxRows || DEFAULT_ROWS);

  const parsed = useMemo(
    () => parseTextbox(text || '', { cols, rows, streaming }),
    [text, streaming, cols, rows]
  );
  const { pages, choices, tags } = parsed;

  const [page, setPage] = useState(0);
  const [shown, setShown] = useState(reduce ? Infinity : 0);
  const timer = useRef(null);

  const current = pages[Math.min(page, pages.length - 1)] || { text: '', start: 0, map: [] };
  const full = current.text;
  const done = shown >= full.length;

  // Restart typing only when the page actually changed, or when the new
  // `full` is NOT a forward extension of what we had (a genuinely different
  // page's text). `text` grows in place while an AI response streams in, so
  // on every chunk `full` is just a longer prefix of itself — in that case
  // leave `shown` alone so typing continues forward into the newly arrived
  // characters instead of wiping back to empty and re-typing from scratch.
  const prevFullRef = useRef(full);
  const prevPageRef = useRef(page);
  useEffect(() => {
    const pageChanged = page !== prevPageRef.current;
    const isExtension = !pageChanged && full.startsWith(prevFullRef.current);
    if (reduce) setShown(Infinity);
    else if (pageChanged || !isExtension) setShown(0);
    prevFullRef.current = full;
    prevPageRef.current = page;
  }, [page, full, reduce]);

  useEffect(() => {
    if (reduce || done) return;
    const cps = Math.max(1, settings?.textboxSpeed || 30);
    timer.current = setInterval(() => {
      setShown(n => {
        const next = n + 1;
        const ch = full[n];
        if (settings?.textboxSound && ch && !/\s|[.,!?;:]/.test(ch)) blip(pitchForCharacter(char));
        return next;
      });
    }, 1000 / cps);
    return () => clearInterval(timer.current);
  }, [full, done, reduce, settings?.textboxSpeed, settings?.textboxSound, char]);

  const skip = useCallback(() => setShown(Infinity), []);

  // ── Resize grip ────────────────────────────────────────────────
  // Pointer events rather than mouse+touch pairs: one code path covers mouse,
  // touch and pen, and setPointerCapture keeps the drag alive when the finger
  // slides outside the handle. `touch-action: none` on .tbx-grip is what stops
  // iOS Safari scrolling the page instead of reporting the move to us.
  const boxRef = useRef(null);
  const textRef = useRef(null);
  const dragRef = useRef(null);

  const onGripDown = useCallback(e => {
    if (!textRef.current) return;
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture?.(e.pointerId);

    const cs = getComputedStyle(textRef.current);
    const lineH = parseFloat(cs.lineHeight) || 24;
    // Measure the real advance width of one character in the box's own font
    // instead of assuming, since the font may still be swapping in.
    const probe = document.createElement('span');
    probe.textContent = '0'.repeat(20);
    probe.style.cssText = `position:absolute;visibility:hidden;white-space:pre;font-family:${cs.fontFamily};font-size:${cs.fontSize};letter-spacing:${cs.letterSpacing}`;
    document.body.appendChild(probe);
    const charW = probe.getBoundingClientRect().width / 20 || 9;
    probe.remove();

    dragRef.current = { x: e.clientX, y: e.clientY, cols, rows, charW, lineH };
    setDrag({ cols, rows });
  }, [cols, rows]);

  const onGripMove = useCallback(e => {
    const d = dragRef.current;
    if (!d) return;
    e.preventDefault();
    const nextCols = Math.min(MAX_COLS, Math.max(MIN_COLS, d.cols + Math.round((e.clientX - d.x) / d.charW)));
    const nextRows = Math.min(MAX_ROWS, Math.max(MIN_ROWS, d.rows + Math.round((e.clientY - d.y) / d.lineH)));
    setDrag(prev => (prev && prev.cols === nextCols && prev.rows === nextRows)
      ? prev : { cols: nextCols, rows: nextRows });
  }, []);

  const onGripUp = useCallback(e => {
    const d = dragRef.current;
    if (!d) return;
    dragRef.current = null;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    setDrag(cur => {
      // Commit once, on release, rather than writing storage every pointermove
      if (cur && (cur.cols !== d.cols || cur.rows !== d.rows)) onResize?.(cur.cols, cur.rows);
      return null;
    });
  }, [onResize]);

  const visible = done ? full : full.slice(0, shown);
  // `current.map[i]` is the source-text offset of `current.text[i]` — pages
  // aren't verbatim slices of the source (collapsed whitespace, hard breaks),
  // so the portrait offset must come from the map rather than arithmetic on
  // `current.start`.
  const portraitOffset = current.map?.[Math.min(shown, full.length) - 1] ?? current.start;
  const portraitKey = char?.textboxStyle === 'deltarune'
    ? resolveExpressionKey(char?.expressions, expressionAt(tags, portraitOffset))
      || resolveExpressionKey(char?.expressions, char?.defaultExpression)
      || Object.keys(char?.expressions || {})[0]
    : null;
  const portrait = portraitKey ? char.expressions[portraitKey] : null;

  const last = page >= pages.length - 1;
  const showChoices = choices.length > 0 && last && done && !streaming;

  return (
    <div>
      <div
        ref={boxRef}
        className={`tbx${char?.textboxStyle === 'deltarune' ? ' deltarune' : ''}${drag ? ' resizing' : ''}`}
        style={drag ? { '--tbx-cols': drag.cols, '--tbx-rows': drag.rows } : undefined}
        onClick={skip}
      >
        <div className="tbx-inner">
          {portrait && <img className="tbx-portrait" src={portrait} alt={portraitKey}
            onError={e => { e.target.style.display = 'none'; }} />}
          <div className="tbx-text" ref={textRef}>{visible}</div>
        </div>
        <div className="tbx-foot" onClick={e => e.stopPropagation()}>
          {pages.length > 1 && (
            <>
              <button className="tbx-nav" disabled={page === 0}
                onClick={() => setPage(p => Math.max(0, p - 1))}>◀ BACK</button>
              <span className="tbx-counter">{Math.min(page + 1, pages.length)}/{pages.length}</span>
            </>
          )}
          {!last && done && (
            <button className="tbx-nav tbx-next"
              onClick={() => setPage(p => Math.min(pages.length - 1, p + 1))}>▼</button>
          )}
        </div>
        {onResize && (
          <div
            className={`tbx-grip${drag ? ' dragging' : ''}`}
            role="separator"
            aria-label={`Resize textbox, ${cols} by ${rows}`}
            title={`${cols} x ${rows} - drag to resize`}
            onPointerDown={onGripDown}
            onPointerMove={onGripMove}
            onPointerUp={onGripUp}
            onPointerCancel={onGripUp}
            onClick={e => e.stopPropagation()}
          />
        )}
      </div>

      {showChoices && (
        <div className="tbx-choices">
          {choices.map((c, i) => (
            <button key={i} className="tbx-choice" onClick={() => onChoice?.(c)}>
              <span className="tbx-heart">♥</span>{c}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

Object.assign(window, { Textbox });
