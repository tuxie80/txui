/**
 * The `kill …` / `killall` popup — a live processlist that appears at the caret
 * the moment you start typing a kill, so you never kill a number you guessed.
 *
 * It is keyboard-only by design: the editor keeps focus (you keep typing, and
 * what you type filters the list), while the popup CLAIMS ↑/↓/PgUp/PgDn/⇥/⏎/Esc
 * for as long as it is open — via a document-level capture listener, so nothing
 * in CodeMirror (autocomplete, default bindings, the run shortcut) can race it
 * for those keys. Keys with ⌘/Ctrl/Alt are deliberately left alone, so ⌘↵ still
 * runs the statement. Everything that matters about a thread is on its row —
 * age (colour-coded), user, db, state, transaction age, lock relationships,
 * statement — and `killall` additionally analyses the situation and pre-marks
 * the threads it believes are the actual problem, with its reasoning shown.
 *
 * **The window never moves on its own** — it is anchored where it opened (the
 * host freezes the anchor) and has a FIXED size, so growing content cannot shove
 * it around. The only thing that moves it is you: drag the header, and that
 * position is remembered.
 *
 * **The rows are always sorted** (running work first, longest first — see
 * `compareRows`), re-sorted on every poll, because a thread's age is not
 * monotonic: a connection that starts a new statement resets its `TIME`, so a
 * frozen order drifts away from the truth within a second. Reordering is safe
 * because the highlight is a **thread id**, not a row index — it stays glued to
 * its thread, and ⏎ can never hit a different one. A thread that dies while you
 * watch stays visible, struck through, and sinks below the live rows.
 *
 * Keys:  ↑↓ move · PgUp/PgDn ±10 · ⇥ mark/unmark · ⏎ KILL · ⇧⏎ insert the id
 *        into the editor instead · Esc close (⌘↵ still runs the statement)
 */
import { errorDisplay } from '../utils/appError';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { Session } from '../types';
import {
  aged, killable, matchProc, mergeRows, noVerdictReason, oneLine, orderProcs, recommend,
  trackHistory,
} from '../utils/killAnalyze';
import type {
  History, KillMode, KillTrigger, ProcInfo, Recommendation, RowState,
} from '../utils/killAnalyze';
import { executeKill } from '../utils/killExec';
import { measureText } from '../utils/measure';
import { historyFor, rememberPoll, seedProcs } from '../store/killPickerState';
import type { KillOutcome } from '../utils/killExec';
import { shortcuts } from '../utils/platform';

/** Shortcut labels for this platform — see utils/platform. */
const SC = shortcuts();

export type KillKey =
  | 'up' | 'down' | 'pageup' | 'pagedown'
  | 'enter' | 'shift-enter' | 'tab' | 'esc';

interface Props {
  session: Session;
  trigger: KillTrigger;
  /** caret position in viewport coordinates, frozen at open time by the host */
  anchor: { x: number; y: number; lineBottom: number };
  /** ⇧⏎ — write the chosen id(s) into the editor instead of killing */
  onInsertIds: (text: string) => void;
  onClose: () => void;
}

const POLL_MS = 1000;
/** Rows kept in memory (merged across polls). */
const MAX_ROWS = 300;
/**
 * Rows actually put in the DOM. The popup is ~25 rows tall and repaints every
 * second, so rendering hundreds of rows means thousands of nodes reconciled per
 * second for something nobody can see. Beyond this, the footer says so and the
 * filter (what you keep typing) is how you reach the rest.
 */
const RENDER_ROWS = 60;
/**
 * Finished threads stay in place (so the list never shifts under your cursor),
 * but only this many: on a churning server every poll retires threads and adds
 * new ones, and an unbounded tail of corpses would fill MAX_ROWS and starve the
 * live rows — the ones you came to kill — right out of the list.
 */
const GONE_KEEP = 30;
const POP_W = 1320;
const POP_H = 430;
const DRAG_KEY = 'dbgui.killPickerOffset';

/** Where the user dragged the popup last time — survives close/reopen. */
function loadOffset(): { dx: number; dy: number } {
  try {
    const raw = localStorage.getItem(DRAG_KEY);
    if (raw) {
      const o = JSON.parse(raw) as { dx: number; dy: number };
      if (Number.isFinite(o.dx) && Number.isFinite(o.dy)) return o;
    }
  } catch { /* corrupt/absent — start unmoved */ }
  return { dx: 0, dy: 0 };
}

/**
 * Column widths are measured from the rows actually on screen with the real
 * font (canvas, same helper the result grids use), then held to a **budget**:
 * everything you only glance at — id, age, user, host, db, command — may take
 * at most `GLANCE_SHARE` of the row, and is scaled down proportionally if it
 * would take more. The **statement always keeps the rest**, whatever the window
 * size or how long a hostname happens to be: it is the one column you read
 * before killing something.
 */
type ColKey = 'id' | 'time' | 'user' | 'host' | 'db' | 'cmd';
type ColWidths = Record<ColKey, number>;              // px

const COL_KEYS: ColKey[] = ['id', 'time', 'user', 'host', 'db', 'cmd'];
/** [floor, ceiling] in px — the ceiling caps a pathological single value. */
const COL_PX: Record<ColKey, [number, number]> = {
  id:   [26, 70],
  time: [34, 82],
  user: [40, 130],
  host: [40, 175],
  db:   [30, 120],
  cmd:  [58, 200],
};
const ROW_FONT = "11.5px 'JetBrains Mono','Fira Mono','Menlo',monospace";
/** Share of the row the glanceable columns may occupy, together. */
const GLANCE_SHARE = 0.45;
/** Row chrome that is not a measured column: padding, gaps, mark, flag. */
const ROW_CHROME = 16 + 7 * 6 + 12 + 14;

function fitColumns(labels: Record<ColKey, string[]>, rowWidth: number): ColWidths {
  const raw = {} as ColWidths;
  let sum = 0;
  for (const key of COL_KEYS) {
    const [min, max] = COL_PX[key];
    let w = min;
    for (const v of labels[key]) {
      const m = measureText(v, ROW_FONT) + 4;         // +4: a hair of slack
      if (m > w) w = m;
    }
    raw[key] = Math.min(max, w);
    sum += raw[key];
  }
  const budget = Math.max(120, (rowWidth - ROW_CHROME) * GLANCE_SHARE);
  if (sum <= budget) return raw;
  // Over budget: shrink proportionally, never below each column's floor.
  const scale = budget / sum;
  for (const key of COL_KEYS) {
    raw[key] = Math.max(COL_PX[key][0], Math.floor(raw[key] * scale));
  }
  return raw;
}

/** Age → colour band. Same idea as the plan-cost colouring: red = look here. */
function ageClass(t: number): string {
  if (t >= 300) return 'kp-age-crit';
  if (t >= 60) return 'kp-age-high';
  if (t >= 10) return 'kp-age-mid';
  if (t >= 1) return 'kp-age-low';
  return 'kp-age-none';
}

function fmtAge(t: number): string {
  if (t < 0) return '—';
  if (t < 60) return `${t}s`;
  if (t < 3600) return `${Math.floor(t / 60)}m${String(t % 60).padStart(2, '0')}s`;
  return `${Math.floor(t / 3600)}h${String(Math.floor((t % 3600) / 60)).padStart(2, '0')}m`;
}

/**
 * One character standing in for the whole transaction/lock story, worst first:
 * a blocker outranks a waiter, which outranks a plain open transaction. The
 * tooltip carries the numbers, and `killall`'s verdict spells them out anyway.
 */
function flagGlyph(r: RowState): string {
  const p = r.proc;
  if (r.gone) return '✕';
  if (p.blocking.length > 0) return '⛓';
  if (p.blockedBy.length > 0) return '⏳';
  if (p.isSelf) return '☞';
  if (p.trxAge >= 0) return '●';
  return '';
}

function flagClass(r: RowState): string {
  const p = r.proc;
  if (r.gone) return 'kp-flag-gone';
  if (p.blocking.length > 0) return 'kp-flag-blocker';
  if (p.blockedBy.length > 0) return 'kp-flag-blocked';
  if (p.isSelf) return 'kp-flag-self';
  if (p.trxAge >= 0) return 'kp-flag-trx';
  return '';
}

function flagTitle(r: RowState): string {
  const p = r.proc;
  const bits: string[] = [];
  if (r.gone) bits.push('no longer on the server');
  if (p.blocking.length > 0) bits.push(`blocks ${p.blocking.map(x => `#${x}`).join(', ')}`);
  if (p.blockedBy.length > 0) bits.push(`waits for ${p.blockedBy.map(x => `#${x}`).join(', ')}`);
  if (p.trxAge >= 0) bits.push(`transaction open ${fmtAge(p.trxAge)}`);
  if (p.rowsLocked > 0) bits.push(`${p.rowsLocked} rows locked`);
  if (p.isSelf) bits.push("TxUI's own connection — cannot be killed");
  if (p.isSystem) bits.push('server-internal thread');
  return bits.join(' · ') || 'nothing special';
}

export function KillPicker({ session, trigger, anchor, onInsertIds, onClose }: Props) {
  // Provisional paint only — replaced wholesale by the first poll below.
  const seed = seedProcs(session.sessionId);
  const [rows, setRows] = useState<RowState[]>(
    () => orderProcs(seed).map(p => ({ id: p.id, proc: p, gone: false })));
  const [procs, setProcs] = useState<ProcInfo[]>(seed);
  /** The first poll of THIS viewing session is authoritative. */
  const firstPollDone = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [cursorId, setCursorId] = useState<number | null>(null);
  const [marked, setMarked] = useState<Set<number>>(new Set());
  const [mode, setMode] = useState<KillMode>(trigger.mode);
  const [outcomes, setOutcomes] = useState<Map<number, KillOutcome>>(new Map());
  const [armed, setArmed] = useState(false);       // prod: ⏎ twice
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  /** Transient footer message, so a key press is never silently ignored. */
  const [flash, setFlash] = useState<string | null>(null);
  const say = useCallback((msg: string) => {
    setFlash(msg);
    window.setTimeout(() => setFlash(f => (f === msg ? null : f)), 2500);
  }, []);
  const [offset, setOffset] = useState(loadOffset);
  /**
   * Viewport size, so a window resize re-clamps the popup instead of leaving it
   * half off-screen. It is NOT re-anchored — the caret anchor and your drag
   * offset are preserved; only the clamp changes.
   */
  const [viewport, setViewport] = useState(() => ({ w: window.innerWidth, h: window.innerHeight }));
  useEffect(() => {
    let raf = 0;
    const onResize = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => setViewport({ w: window.innerWidth, h: window.innerHeight }));
    };
    window.addEventListener('resize', onResize);
    return () => { cancelAnimationFrame(raf); window.removeEventListener('resize', onResize); };
  }, []);

  const histRef = useRef<History>(historyFor(session.sessionId));
  const inFlight = useRef(false);
  /**
   * Sleeping threads are excluded server-side by default.
   *
   * On a server with fifteen thousand connections, nearly all of them are
   * idle; including them means shipping fifteen thousand rows every second so
   * the picker can show sixty. Sleepers that hold a transaction, or that have
   * been idle past ten minutes, are kept regardless — those are the ones worth
   * killing, and hiding them would defeat the point.
   */
  const [showIdle, setShowIdle] = useState(false);
  const showIdleRef = useRef(showIdle);
  useEffect(() => { showIdleRef.current = showIdle; }, [showIdle]);
  const listRef = useRef<HTMLDivElement>(null);
  const isProd = session.environment === 'prod';

  // Typing in the editor changes the mode qualifier — follow it.
  useEffect(() => { setMode(trigger.mode); }, [trigger.mode]);

  // ── live poll ──────────────────────────────────────────────────────────────
  // Rows are MERGED into the existing list, never rebuilt: known threads keep
  // their slot, new ones are appended, and vanished ones stay put marked gone.
  // That is what makes the list safe to aim at while it updates every second.
  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const list = await invoke<ProcInfo[]>('kill_candidates', {
        sessionId: session.sessionId, includeIdle: showIdleRef.current,
      });
      trackHistory(histRef.current, list, Date.now());
      rememberPoll(session.sessionId, list);
      setProcs(list);
      const first = !firstPollDone.current;
      firstPollDone.current = true;
      setRows(prev => mergeRows(prev, list, { first, goneKeep: GONE_KEEP, max: MAX_ROWS }));
      setError(null);
    } catch (e) {
      setError(errorDisplay(e));
    } finally {
      inFlight.current = false;
      setLoaded(true);
    }
  }, [session.sessionId]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, POLL_MS);
    return () => clearInterval(t);
  }, [refresh]);

  /** Rows matching the filter, in their stable order. */
  const matched = useMemo(
    () => rows.filter(r => matchProc(r.proc, trigger.filter)),
    [rows, trigger.filter]);
  /** …capped for rendering; navigation and ⏎ only ever address visible rows. */
  const view = useMemo(
    () => matched.length > RENDER_ROWS ? matched.slice(0, RENDER_ROWS) : matched,
    [matched]);

  /** Widths for exactly the rows on screen (60 max — cheap to measure). */
  const rowWidth = Math.min(POP_W, viewport.w - 24);
  const cols = useMemo<ColWidths>(() => fitColumns({
    id:   ['id',   ...view.map(r => String(r.proc.id))],
    time: ['time', ...view.map(r => {
      const g = aged(histRef.current, r.proc.id);
      return fmtAge(r.proc.time) + (g != null && g > 0 ? `↑${g}` : '');
    })],
    user: ['user', ...view.map(r => r.proc.user || '—')],
    host: ['host', ...view.map(r => r.proc.host || '—')],
    db:   ['db',   ...view.map(r => r.proc.db || '—')],
    cmd:  ['command', ...view.map(r =>
      `${r.proc.command}${r.proc.state ? ` ${r.proc.state}` : ''}`)],
  }, rowWidth), [view, rowWidth]);

  /** killall's verdict — recomputed every poll so "growing" can firm up. */
  // Never reason about the provisional snapshot: a verdict computed from it
  // could pre-mark ids that are already gone (or, worse, recycled) — so the
  // popup stays silent until the first real poll of this session has landed.
  const rec: Recommendation | null = useMemo(
    () => (trigger.kind === 'killall' && loaded) ? recommend(procs, histRef.current) : null,
    [procs, trigger.kind, loaded]);
  // Both of these group + digest every backend, so they must not run on
  // renders that only moved the cursor.
  const noVerdict = useMemo(
    () => (trigger.kind === 'killall' && !rec) ? noVerdictReason(procs, histRef.current) : null,
    [trigger.kind, rec, procs]);

  // Pre-mark what killall recommends. Two rules keep this from fighting the user:
  //   • a verdict is applied ONCE (while nothing is marked), so unmarking a row
  //     is never undone by the next poll;
  //   • it never moves the highlight — that is the user's aim, and only the user
  //     moves it. The verdict marks rows (☑); ⏎ kills the marked set.
  // A genuinely NEW verdict (different ids) does re-mark, so the popup stays
  // useful after you killed the first batch.
  const recKey = rec ? rec.ids.join(',') : '';
  const appliedRecRef = useRef<string | null>(null);
  useEffect(() => {
    if (!rec || recKey === appliedRecRef.current) return;
    if (marked.size > 0) return;              // the user has their own selection
    appliedRecRef.current = recKey;
    setMarked(new Set(rec.ids));
    setMode(rec.mode);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recKey, marked.size]);

  // Park the highlight on the LONGEST-RUNNING killable thread — once, when the
  // first poll lands (the initial order is by age, so that is the first row).
  // After that it stays exactly where it is: rows never reorder or disappear
  // under it, the verdict does not steal it, and only the user moves it. The
  // one exception is a row filtered away by what you typed.
  const cursorIdx = Math.max(0, view.findIndex(r => r.id === cursorId));
  useEffect(() => {
    if (view.length === 0) return;
    if (cursorId == null || !view.some(r => r.id === cursorId)) {
      const first = view.find(r => !r.gone && !r.proc.isSelf && !r.proc.isSystem) ?? view[0];
      setCursorId(first.id);
    }
  }, [view, cursorId]);

  // Scroll the cursor row into view (the list scrolls, the popup doesn't move).
  useEffect(() => {
    listRef.current?.querySelector('.kp-row-cursor')?.scrollIntoView({ block: 'nearest' });
  }, [cursorIdx, view.length]);

  const move = useCallback((delta: number) => {
    setArmed(false);
    if (view.length === 0) return;
    const i = Math.min(view.length - 1, Math.max(0, cursorIdx + delta));
    setCursorId(view[i].id);
  }, [view, cursorIdx]);

  const markRow = useCallback((row: RowState | undefined) => {
    if (!row || row.proc.isSelf) return;
    setArmed(false);
    setMarked(prev => {
      const next = new Set(prev);
      if (next.has(row.id)) next.delete(row.id); else next.add(row.id);
      return next;
    });
  }, []);

  /** ⇥ — mark the highlighted row and step down, so batches build up quickly. */
  const toggleMark = useCallback(() => {
    markRow(view[cursorIdx]);
    move(1);
  }, [markRow, view, cursorIdx, move]);

  /** Threads ⏎ would kill right now: everything marked, else the cursor row. */
  const targets = useMemo(() => {
    const chosen = marked.size > 0
      ? view.filter(r => marked.has(r.id))
      : (view[cursorIdx] ? [view[cursorIdx]] : []);
    return killable(chosen.filter(r => !r.gone).map(r => r.proc));
  }, [marked, view, cursorIdx]);

  const doKill = useCallback(async () => {
    if (busy) { say('still killing the previous selection…'); return; }
    // The rows on screen may still be the provisional snapshot for a few ms.
    if (!loaded) { say('still reading the processlist — try again in a moment'); return; }
    if (targets.length === 0) {
      const here = view[cursorIdx];
      say(view.length === 0
        ? 'nothing to kill — no other backend on this server'
        : here?.gone ? `#${here.id} has already finished — ↑↓ to pick another`
        : here?.proc.isSelf ? "that is TxUI's own connection — ↑↓ to pick another"
        : 'nothing selected — ↑↓ to pick a thread, ⇥ to mark several');
      return;
    }
    // Production needs a second ⏎ — the first one only arms the button.
    if (isProd && !armed) { setArmed(true); return; }
    setArmed(false);
    setBusy(true);
    try {
      const res = await executeKill({
        sessionId: session.sessionId,
        ids: targets.map(t => t.id),
        mode,
        source: trigger.kind === 'killall' ? 'killall popup' : 'kill popup',
        procs,
        hist: histRef.current,
        connectionName: session.connectionName,
        engine: session.engine,
      });
      setOutcomes(prev => {
        const next = new Map(prev);
        res.forEach(o => next.set(o.id, o));
        return next;
      });
      setMarked(new Set());
      // If we just killed what the highlight was on, step to the next thread
      // that can still be killed — so a batch can be worked through with ⏎.
      const killedIds = new Set(res.filter(o => o.ok).map(o => o.id));
      setCursorId(prev => {
        if (prev == null || !killedIds.has(prev)) return prev;
        const from = view.findIndex(r => r.id === prev);
        const next = view.slice(from + 1).find(r =>
          !r.gone && !killedIds.has(r.id) && !r.proc.isSelf && !r.proc.isSystem);
        return next ? next.id : prev;
      });
      const ok = res.filter(o => o.ok).length;
      const failed = res.length - ok;
      say(failed === 0
        ? `killed ${ok} thread(s) — logged to 📓 Log + 📜 Audit`
        : `killed ${ok}, ${failed} failed — see the row and the 📓 Log`);
      refresh();
    } catch (e) {
      setError(errorDisplay(e));
    } finally {
      setBusy(false);
    }
  }, [busy, loaded, targets, view, cursorIdx, isProd, armed, session, mode, trigger.kind,
      procs, refresh, say]);

  const insertIds = useCallback(() => {
    if (targets.length === 0) { say('nothing selected to insert'); return; }
    const kw = mode === 'query' ? 'KILL QUERY' : 'KILL';
    onInsertIds(targets.map(t => `${kw} ${t.id}`).join(';\n'));
  }, [targets, mode, onInsertIds, say]);

  // ── keys: claimed at the document, in the CAPTURE phase ───────────────────
  // The editor keeps focus (so typing keeps filtering), but these keys never
  // reach it: capture-phase + stopPropagation means no CodeMirror binding,
  // autocomplete popup or default keymap can swallow ⏎ first. Anything with a
  // modifier is left alone — ⌘↵ must still run the statement.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      let action: KillKey | null = null;
      switch (e.key) {
        case 'ArrowUp':   action = 'up'; break;
        case 'ArrowDown': action = 'down'; break;
        case 'PageUp':    action = 'pageup'; break;
        case 'PageDown':  action = 'pagedown'; break;
        case 'Tab':       action = 'tab'; break;
        case 'Escape':    action = 'esc'; break;
        case 'Enter':     action = e.shiftKey ? 'shift-enter' : 'enter'; break;
        default: return;                    // everything else keeps typing
      }
      e.preventDefault();
      e.stopPropagation();
      switch (action) {
        case 'up':          move(-1); break;
        case 'down':        move(1); break;
        case 'pageup':      move(-10); break;
        case 'pagedown':    move(10); break;
        case 'tab':         toggleMark(); break;
        case 'enter':       doKill(); break;
        case 'shift-enter': insertIds(); break;
        case 'esc':         onClose(); break;
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [move, toggleMark, doKill, insertIds, onClose]);

  // ── drag: the ONLY thing that may move this popup ──────────────────────────
  const dragFrom = useRef<{ x: number; y: number; dx: number; dy: number } | null>(null);
  const startDrag = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragFrom.current = { x: e.clientX, y: e.clientY, dx: offset.dx, dy: offset.dy };
    const onMove = (ev: MouseEvent) => {
      const from = dragFrom.current;
      if (!from) return;
      setOffset({ dx: from.dx + (ev.clientX - from.x), dy: from.dy + (ev.clientY - from.y) });
    };
    const onUp = () => {
      dragFrom.current = null;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      setOffset(o => {
        try { localStorage.setItem(DRAG_KEY, JSON.stringify(o)); } catch { /* quota */ }
        return o;
      });
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [offset]);

  const resetPosition = useCallback(() => {
    setOffset({ dx: 0, dy: 0 });
    try { localStorage.removeItem(DRAG_KEY); } catch { /* quota */ }
  }, []);

  // ── geometry: fixed size, fixed anchor, plus the user's own offset ──────────
  // Nothing here depends on content, so the box never resizes or hops as rows
  // arrive, the verdict appears, or the filter narrows the list.
  const style = useMemo<React.CSSProperties>(() => {
    const width = Math.min(POP_W, viewport.w - 24);
    const height = Math.min(POP_H, viewport.h - 80);
    // Below the caret when it fits, above it otherwise — decided from the frozen
    // anchor, so it cannot flip while you type.
    const below = viewport.h - anchor.lineBottom - 12;
    const top = below >= height ? anchor.lineBottom + 6 : Math.max(8, anchor.y - height - 6);
    const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(v, max));
    return {
      left: clamp(anchor.x - 40 + offset.dx, 8, Math.max(8, viewport.w - width - 8)),
      top: clamp(top + offset.dy, 8, Math.max(8, viewport.h - height - 8)),
      width, height,
    };
  }, [anchor, offset, viewport]);

  const killableCount = killable(procs).length;
  const verb = mode === 'query' ? 'KILL QUERY' : 'KILL';
  const moved = offset.dx !== 0 || offset.dy !== 0;

  return (
    <div className="kp-pop" style={style} onMouseDown={e => e.preventDefault()}>
      <div className="kp-head" onMouseDown={startDrag} title="Drag to move — the popup never moves by itself">
        <span className="kp-grip">⠿</span>
        <span className="kp-title">{trigger.kind === 'killall' ? '🚨 killall' : '⚡ kill'}</span>
        <span className={`kp-mode ${mode === 'query' ? 'kp-mode-soft' : 'kp-mode-hard'}`}
          title={mode === 'query'
            ? 'aborts the running statement, connection survives (KILL QUERY / pg_cancel_backend)'
            : 'drops the whole connection (KILL / pg_terminate_backend)'}
          onMouseDown={e => e.stopPropagation()}
          onClick={() => setMode(m => m === 'query' ? 'connection' : 'query')}
        >{verb}</span>
        {/* Idle threads are excluded server-side. Sleepers holding a
            transaction, or idle past ten minutes, are kept regardless. */}
        <span
          className={`kp-idle${showIdle ? ' kp-idle-on' : ''}`}
          title={showIdle
            ? 'Showing idle connections too — click to hide them again'
            : 'Idle connections hidden (kept: sleepers holding a transaction, or idle over 10 min). Click to show all.'}
          onMouseDown={e => e.stopPropagation()}
          onClick={() => setShowIdle(v => !v)}
        >{showIdle ? 'all' : 'no sleep'}</span>
        {session.readOnly && <span className="kp-ro" title="read-only connection — kills are still server-side admin commands">🔒 read-only conn</span>}
        {isProd && <span className="kp-prod">PROD</span>}
        <span className="kp-count">
          {killableCount} killable{procs.length !== killableCount ? ` · ${procs.length - killableCount} own/system` : ''}
          {trigger.filter ? ` · filter “${trigger.filter}” → ${matched.length}` : ''}
          {matched.length > view.length ? ` · showing ${view.length}, type to narrow` : ''}
        </span>
        <div style={{ flex: 1 }} />
        {moved && (
          <button className="kp-reset" onMouseDown={e => e.stopPropagation()} onClick={resetPosition}
            title="Put the popup back at the caret">reset position</button>
        )}
        <span className="kp-keys">↑↓ move · ⇥ mark · {SC.enter} {verb} · {SC.shiftEnter} insert id · esc</span>
      </div>

      {error && <div className="kp-err">{error}</div>}

      <div className="kp-table" ref={listRef}>
        <div className="kp-hrow">
          <span className="kp-c-mark" />
          <span className="kp-c-id" style={{ width: `${cols.id}px` }}>id</span>
          <span className="kp-c-time" style={{ width: `${cols.time}px` }}
            title="Sorted: running work first (longest first), then idle connections, then TxUI's own and the server's threads, then finished ones">time ↓</span>
          <span className="kp-c-user" style={{ width: `${cols.user}px` }}>user</span>
          <span className="kp-c-host" style={{ width: `${cols.host}px` }}>host</span>
          <span className="kp-c-db" style={{ width: `${cols.db}px` }}>db</span>
          <span className="kp-c-cmd" style={{ width: `${cols.cmd}px` }}>command</span>
          <span className="kp-c-flag" title="⛓ blocks others · ⏳ waiting · ● open transaction · ✕ gone">⚑</span>
          <span className="kp-c-info">statement</span>
        </div>
        {view.length === 0 && loaded && (
          <div className="kp-empty">
            {trigger.filter ? `No thread matches “${trigger.filter}”.` : 'No other backends on this server.'}
          </div>
        )}
        {view.map((r, i) => {
          const p = r.proc;
          const o = outcomes.get(p.id);
          const growth = aged(histRef.current, p.id);
          const isRec = rec?.ids.includes(p.id) ?? false;
          return (
            <div
              key={p.id}
              className={[
                'kp-row',
                i === cursorIdx ? 'kp-row-cursor' : '',
                marked.has(p.id) ? 'kp-row-marked' : '',
                isRec ? 'kp-row-rec' : '',
                p.isSelf ? 'kp-row-self' : '',
                p.isSystem ? 'kp-row-system' : '',
                r.gone ? 'kp-row-gone' : '',
                o && !o.ok ? 'kp-row-killfail' : '',
              ].filter(Boolean).join(' ')}
              onClick={() => { setCursorId(p.id); markRow(r); }}
            >
              <span className="kp-c-mark">
                {o ? (o.ok ? '☠' : '✖') : marked.has(p.id) ? '☑' : isRec ? '•' : ''}
              </span>
              <span className="kp-c-id" style={{ width: `${cols.id}px` }}>{p.id}</span>
              <span className={`kp-c-time ${ageClass(p.time)}`} style={{ width: `${cols.time}px` }}>
                {fmtAge(p.time)}
                {growth != null && growth > 0 && <i className="kp-growth" title={`aged +${growth}s while watching`}>↑{growth}</i>}
              </span>
              <span className="kp-c-user" style={{ width: `${cols.user}px` }} title={p.user}>{p.user || '—'}</span>
              <span className="kp-c-host" style={{ width: `${cols.host}px` }} title={p.host}>{p.host || '—'}</span>
              <span className="kp-c-db" style={{ width: `${cols.db}px` }} title={p.db}>{p.db || '—'}</span>
              <span className="kp-c-cmd" style={{ width: `${cols.cmd}px` }} title={`${p.command} ${p.state}`}>
                {p.command || '—'}{p.state ? <i className="kp-state"> {p.state}</i> : null}
              </span>
              {/* One glyph instead of two columns: the transaction/lock detail
                  is in the tooltip (and spelled out in the killall verdict),
                  so the statement gets the width instead. */}
              <span className={`kp-c-flag ${flagClass(r)}`} title={flagTitle(r)}>{flagGlyph(r)}</span>
              <code className="kp-c-info" title={p.info}>{oneLine(p.info, 512) || '—'}</code>
              {o && !o.ok && <span className="kp-rowerr" title={o.error ?? ''}>{oneLine(o.error ?? '', 80)}</span>}
            </div>
          );
        })}
      </div>

      {/* The verdict sits BELOW the table on purpose: appearing (or growing a
          reason) must not push the rows you are aiming at downwards. */}
      {rec && (
        <div className={`kp-rec kp-rec-${rec.confidence}`}>
          <div className="kp-rec-head">
            <b>{rec.headline}</b>
            <span className="kp-rec-conf">{rec.confidence} confidence</span>
            <span className="kp-rec-act">
              → pre-marked {rec.ids.length} thread{rec.ids.length > 1 ? 's' : ''} · {verb} · ⏎ to confirm
            </span>
          </div>
          <ul className="kp-rec-why">
            {rec.reasons.map((r, i) => <li key={i}>{r}</li>)}
          </ul>
        </div>
      )}
      {trigger.kind === 'killall' && !rec && loaded && !error && (
        <div className="kp-rec kp-rec-none">{noVerdict}</div>
      )}

      <div className={`kp-foot ${armed ? 'kp-foot-armed' : ''}`}>
        {flash ? <span className="kp-flash">{flash}</span>
          : !loaded ? <span className="kp-dim">reading the processlist…</span>
          : busy ? <span>killing…</span>
          : armed ? (
            <span className="kp-arm">
              ⚠ PROD — press ⏎ again to {verb} {targets.length} thread{targets.length > 1 ? 's' : ''}
              {targets.length ? `: ${targets.map(t => `#${t.id}`).join(' ')}` : ''}
            </span>
          ) : targets.length === 0 ? (
            <span className="kp-dim">nothing selected — ↑↓ to pick a thread, ⇥ to mark several</span>
          ) : (
            <span>
              ⏎ runs <b>{verb} {targets.map(t => t.id).join(', ')}</b>
              {marked.size > 0 ? ` (${marked.size} marked)` : ''}
              {' — '}
              {mode === 'query'
                ? 'statement aborted, connection survives'
                : 'connection dropped; an open transaction rolls back'}
            </span>
          )}
        <div style={{ flex: 1 }} />
        {outcomes.size > 0 && (
          <span className="kp-done">
            killed {[...outcomes.values()].filter(o => o.ok).length}
            {[...outcomes.values()].some(o => !o.ok) && ` · failed ${[...outcomes.values()].filter(o => !o.ok).length}`}
            {' · logged to 📓 Log + 📜 Audit'}
          </span>
        )}
      </div>
    </div>
  );
}
