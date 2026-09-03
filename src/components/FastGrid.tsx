/**
 * FastGrid — the one grid for every tabular surface in dbgui.
 *
 * Performance design (the reason this exists):
 * - Both-axis virtualization: only visible rows AND visible columns get DOM.
 * - No <table>: fixed-height absolutely-positioned rows, flex cells with
 *   fixed widths — no cross-row layout dependency, scroll never reflows
 *   off-screen content.
 * - Scroll commits are coalesced to one per animation frame (rAF), holding
 *   the latest scroll position, and pinned to that frame's paint with
 *   flushSync. Committing per scroll EVENT spends the frame budget several
 *   times over (every commit remounts the window — rows are keyed by
 *   absolute index), starving the main thread while the compositor scrolls
 *   ahead and paints background — the fast-scroll blank. Vertical overscan
 *   scales with the gap since the last commit (one viewport at rest, capped
 *   at 2 per side during flicks; kept in refs — never a prop, so row
 *   memoization is untouched). Only the near-bottom fetch stays a separate
 *   rAF. Rows are React.memo'd and keyed by absolute index, so scrolling
 *   only mounts/unmounts edge rows.
 * - Event delegation: one mouse handler on the container, zero per-cell
 *   closures.
 * - O(1) per-cell lookups: pending-edit Set, prefix-summed column offsets.
 *
 * Feature surface: selection (cell/range/row/all) with keyboard navigation,
 * header-inclusive copy, column resize + canvas-measured auto-widths,
 * sort indicators, NULL styling, numeric right-alignment, optional inline
 * editing (browser mode), FK click-through, cell viewer hook.
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import type { ColumnInfo } from '../types';
import type { TableColumn, SortClause, RowChange } from '../types/browser';
import { useGridSettings, gridRowHeight } from '../store/gridSettings';
import { measureText } from '../utils/measure';
import { toTsv, cellText } from '../utils/exporters';
import { copyToClipboard } from '../utils/exportersIo';
import { getPref, PREFS } from '../store/preferences';
import { readFontScale } from '../utils/fontScale';
import { gridWindow } from '../utils/gridWindow';
import { shortcuts } from '../utils/platform';

/** Shortcut labels for this platform — see utils/platform. */
const SC = shortcuts();

// ── Public types ──────────────────────────────────────────────────────────────

export interface SelRect { r1: number; c1: number; r2: number; c2: number }

export interface FastGridApi {
  /** Selected slice (or full result when nothing is selected) — header included. */
  getSelectionData(): { columns: string[]; rows: unknown[][] };
  hasSelection(): boolean;
  selectAll(): void;
  /**
   * Select a whole row and scroll it into view.
   *
   * For views that are *about* a row and are not the grid — the 🗺 Map picks
   * a point, and the row it came from has to be findable when you switch back.
   */
  selectRow(row: number): void;
}

interface Props {
  columns: ColumnInfo[];
  rows: unknown[][];
  /** Sort indicators + header-click callback (server- or client-side, parent decides) */
  sort?: SortClause[];
  onSortCol?: (col: string) => void;
  /** Header funnel icon — parent owns the filter popover + row filtering */
  onFilterCol?: (col: string, anchor: { x: number; y: number }) => void;
  filteredCols?: Set<string>;
  /** Browser mode: enables editing + pk/fk decorations */
  meta?: TableColumn[];
  pkColumns?: string[];
  /** O(1) pending-edit lookup; key = `${JSON.stringify(pk_values)}|${column}` */
  pendingKeys?: Set<string>;
  onEdit?: (change: RowChange) => void;
  onFkClick?: (fkTable: string, fkColumn: string, value: unknown) => void;
  /** Open cell viewer (dbl-click in read-only grids, Shift+Enter everywhere) */
  onOpenCell?: (rowIdx: number, colIdx: number) => void;
  /** Fired on selection change; `dragging` marks intermediate updates during
   *  a mouse drag — heavy per-selection work should wait for the final one. */
  onSelectionChange?: (sel: SelRect | null, dragging?: boolean) => void;
  /** Fired when the user scrolls near the bottom — parent loads more rows */
  onNearBottom?: () => void;
  /** Extra class per row (e.g. duration-threshold tints) — '' for none */
  rowClass?: (rowIdx: number) => string;
  /** Imperative access for parent toolbars (copy menu, aggregates) */
  apiRef?: React.MutableRefObject<FastGridApi | null>;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const OVERSCAN_ROWS = 12;  // floor only — the real row overscan is ≥1 viewport (see window calc)
const OVERSCAN_COLS = 2;
const MAX_OVERSCAN_VP = 2;  // gap-scaled overscan cap, in viewports per side
const ROWNUM_MIN_W  = 40;   // row-number gutter width floor
const ROWNUM_PAD    = 20;   // horizontal padding + separator accounted in gutter width
const MIN_COL_W     = 48;
const MAX_COL_W     = 480;
const CELL_PAD      = 18;   // horizontal padding accounted in auto-width
const SAMPLE_ROWS   = 120;  // rows sampled for auto-width measurement

const NUMERIC_TYPES = /INT|DECIMAL|NUMERIC|FLOAT|DOUBLE|REAL|SERIAL|MONEY|NUMBER/i;

// ── Row (memoized — the scroll hot path) ─────────────────────────────────────

interface RowProps {
  row: unknown[];
  rowIdx: number;
  top: number;
  rowH: number;
  totalW: number;
  colStart: number;
  colEnd: number;              // exclusive
  widths: number[];
  leftPad: number;             // sum of widths of skipped leading columns
  rightPad: number;
  numeric: boolean[];
  fkCols: (TableColumn | null)[];
  zebra: boolean;
  /** column range of the selection touching this row, null when not selected */
  sel: { c1: number; c2: number } | null;
  active: number | null;       // active-cell column when the active row, else null
  pendingCols: number[] | null; // visible col indices with pending edits, usually null
  rowCls: string;               // extra row class from Props.rowClass, '' for none
  /** Formatted-cell cache shared by every row of this grid — see FastGrid body. */
  textCache: WeakMap<unknown[], (string | undefined)[]>;
}

function cellsEqual(a: RowProps, b: RowProps): boolean {
  return a.row === b.row
    && a.top === b.top
    && a.rowH === b.rowH
    && a.totalW === b.totalW
    && a.colStart === b.colStart
    && a.colEnd === b.colEnd
    && a.widths === b.widths
    && a.zebra === b.zebra
    && a.rowCls === b.rowCls
    && a.textCache === b.textCache
    && selEq(a.sel, b.sel)
    && a.active === b.active
    && pendingEq(a.pendingCols, b.pendingCols);
}
function selEq(a: RowProps['sel'], b: RowProps['sel']) {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.c1 === b.c1 && a.c2 === b.c2;
}
function pendingEq(a: number[] | null, b: number[] | null) {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

const GridRow = memo(function GridRow(p: RowProps) {
  const cells = [];
  let texts = p.textCache.get(p.row);
  if (!texts) { texts = new Array(p.row.length); p.textCache.set(p.row, texts); }
  for (let c = p.colStart; c < p.colEnd; c++) {
    const v = p.row[c];
    const isNull = v === null || v === undefined;
    const inSel = p.sel !== null && c >= p.sel.c1 && c <= p.sel.c2;
    const isActive = p.active === c;
    const isPending = p.pendingCols !== null && p.pendingCols.includes(c);
    const fk = p.fkCols[c];
    const cls = [
      'fg-cell',
      isNull ? 'fg-null' : '',
      p.numeric[c] ? 'fg-num' : '',
      inSel ? 'fg-sel' : '',
      isActive ? 'fg-active' : '',
      isPending ? 'fg-pending' : '',
      fk && !isNull ? 'fg-fk' : '',
    ].join(' ');
    cells.push(
      <div
        key={c}
        className={cls}
        style={{ width: p.widths[c] }}
        data-r={p.rowIdx}
        data-c={c}
      >
        {isNull ? 'NULL' : (texts[c] ??= cellText(v))}
      </div>
    );
  }

  return (
    <div
      className={`fg-row ${p.zebra && p.rowIdx % 2 === 1 ? 'fg-odd' : ''}${p.rowCls ? ` ${p.rowCls}` : ''}`}
      style={{ top: p.top, height: p.rowH, width: p.totalW }}
    >
      {p.leftPad > 0 && <div style={{ width: p.leftPad, flex: 'none' }} />}
      {cells}
      {p.rightPad > 0 && <div style={{ width: p.rightPad, flex: 'none' }} />}
    </div>
  );
}, cellsEqual);

// ── Main component ────────────────────────────────────────────────────────────

interface EditingCell { r: number; c: number; value: string }

export function FastGrid({
  columns, rows, sort, onSortCol, onFilterCol, filteredCols, meta, pkColumns, pendingKeys,
  onEdit, onFkClick, onOpenCell, onSelectionChange, onNearBottom, apiRef, rowClass,
}: Props) {
  const { settings } = useGridSettings();
  // stable ref so the rAF scroll handler always sees the latest callback
  const onNearBottomRef = useRef(onNearBottom);
  useEffect(() => { onNearBottomRef.current = onNearBottom; }, [onNearBottom]);
  // The grid scales with the app-wide font setting: effective px = the grid's
  // base size × --font-scale. The CSS side is a live calc(); the canvas side
  // (column auto-width, row height) needs the resolved multiplier and must
  // re-measure + repaint when the app font size changes.
  const [fontScale, setFontScale] = useState(readFontScale);
  useEffect(() => {
    const on = (e: Event) => {
      if ((e as CustomEvent<{ key: string }>).detail?.key === PREFS.appFontSize.key) {
        setFontScale(readFontScale());
      }
    };
    window.addEventListener('dbgui:prefs-changed', on);
    return () => window.removeEventListener('dbgui:prefs-changed', on);
  }, []);
  const effFontSize = settings.fontSize * fontScale;
  const rowH = gridRowHeight({ ...settings, fontSize: effFontSize });
  const headerH = rowH + 6;
  const font = `${effFontSize}px ${settings.fontFamily}`;

  const scrollRef = useRef<HTMLDivElement>(null);
  const gutterViewRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef(0);
  const scrollRafRef = useRef(0);
  // Scroll dynamics in refs (never props/state of their own — they feed the
  // window calc and must not re-render or break the row memo):
  //  - veloRef.jumpPx: how far scrollTop has moved since the last COMMITTED
  //    render (halves per event, so the buffer decays to one viewport when
  //    scrolling slows) — the overscan the next commit must carry.
  //  - committedRef.top: the scroll position of the last committed render.
  const veloRef = useRef({ jumpPx: 0 });
  const committedRef = useRef({ top: 0 });
  const [scroll, setScroll] = useState({ top: 0, left: 0 });
  const [view, setView] = useState({ w: 800, h: 500 });
  const [overrides, setOverrides] = useState<Map<number, number>>(new Map());
  const [selection, setSelection] = useState<SelRect | null>(null);
  const [active, setActive] = useState<{ r: number; c: number } | null>(null);
  const [editing, setEditing] = useState<EditingCell | null>(null);
  const draggingRef = useRef(false);
  const editInputRef = useRef<HTMLInputElement>(null);
  // Find-in-results (⌘F) — jumps the selection to matching cells (read-only).
  const [findOpen, setFindOpen] = useState(false);
  const [findText, setFindText] = useState('');
  // The scan walks every row × column; it runs on a debounced copy of the
  // query so typing into a 1M-row result never re-scans per character.
  const [findQuery, setFindQuery] = useState('');
  const [matchIdx, setMatchIdx] = useState(-1);
  const findInputRef = useRef<HTMLInputElement>(null);

  const nCols = columns.length;
  const nRows = rows.length;
  const editable = !!onEdit && !!pkColumns && pkColumns.length > 0;
  const showRowNum = settings.showRowNumbers;
  // Gutter width fits the row count's digits instead of a fixed 52px: a small
  // table doesn't donate 52px to "1..42", and a 1M-row result doesn't clip
  // Gutter width fits the row count's digits instead of a fixed 52px: a small
  // table doesn't donate 52px to "1..42", and a 1M-row result doesn't clip
  // "1000000". Measured with the grid font (tabular-nums, so '8' is the
  // widest case); floored so the '#' header never gets cramped.
  // The gutter is NOT part of the scrolled content: it lives in a separate
  // overlay column (see the render) because one position:sticky element per
  // visible row was the single biggest raster cost during fast scrolling in
  // WebKit (measured with dev/grid-scroll-repro.mjs: 87% → 15% blank
  // presented frames on a sustained flick).
  const rnW = useMemo(() => {
    if (!showRowNum) return 0;
    const digits = String(Math.max(nRows, 1)).length;
    return Math.max(ROWNUM_MIN_W, Math.ceil(measureText('8'.repeat(digits), font)) + ROWNUM_PAD);
  }, [showRowNum, nRows, font]);

  // Reset per-result state when the column set changes identity
  useEffect(() => {
    setOverrides(new Map());
    setSelection(null);
    setActive(null);
    setEditing(null);
  }, [columns]);

  // Container size tracking
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setView({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setView({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  // ── Column geometry ────────────────────────────────────────────────────────

  // Widths are measured ONCE from the first sample of rows, then frozen — they
  // must NOT recompute on every scroll-append (that re-measured all columns per
  // page and caused the sluggishness on big / infinite-scroll results). Keyed
  // on columns/font + a boolean "has data yet", so it runs when data first
  // arrives and when columns/font change, but never on subsequent appends.
  const hasData = nRows > 0;
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  // Formatted-cell cache, keyed by row ARRAY identity. Virtualization
  // remounts rows as they leave/re-enter the window, and each mount re-ran
  // cellText (JSON.stringify for objects) per visible cell. Row arrays are
  // stable across renders (appends spread a new outer array but reuse the
  // inner rows) and never mutated in place (edits go through pendingKeys +
  // refetch), so a WeakMap needs no eviction — entries die with the data.
  // Lazy per cell: only columns that are actually rendered get formatted.
  const [textCache] = useState(() => new WeakMap<unknown[], (string | undefined)[]>());
  const measured = useMemo(() => {
    const r0 = rowsRef.current;
    const sample = Math.min(r0.length, SAMPLE_ROWS);
    return columns.map((col, ci) => {
      let w = measureText(col.name, font) + (onFilterCol ? 42 : 26); // header: name + sort arrow (+ funnel) room
      for (let r = 0; r < sample; r++) {
        const v = r0[r][ci];
        if (v === null || v === undefined) continue;
        const t = typeof v === 'object' ? JSON.stringify(v) : String(v);
        const tw = measureText(t.length > 80 ? t.slice(0, 80) : t, font);
        if (tw > w) w = tw;
      }
      return Math.min(MAX_COL_W, Math.max(MIN_COL_W, Math.ceil(w) + CELL_PAD));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [columns, font, hasData]);

  const widths = useMemo(() => {
    if (overrides.size === 0) return measured;
    return measured.map((w, i) => overrides.get(i) ?? w);
  }, [measured, overrides]);

  const offsets = useMemo(() => {
    const off = new Array<number>(nCols + 1);
    off[0] = 0;
    for (let i = 0; i < nCols; i++) off[i + 1] = off[i] + widths[i];
    return off;
  }, [widths, nCols]);

  const totalW = offsets[nCols];
  const totalH = headerH + nRows * rowH;

  const numeric = useMemo(
    () => columns.map(c => NUMERIC_TYPES.test(c.type_name)),
    [columns]
  );

  const fkCols = useMemo<(TableColumn | null)[]>(() => {
    if (!meta) return columns.map(() => null);
    const byName = new Map(meta.map(m => [m.name, m]));
    return columns.map(c => {
      const m = byName.get(c.name);
      return m && m.fk_table ? m : null;
    });
  }, [columns, meta]);

  const pkSet = useMemo(() => new Set(pkColumns ?? []), [pkColumns]);

  // ── Visible window ─────────────────────────────────────────────────────────

  // Window math lives in utils/gridWindow (pure, unit-tested): overscan tracks
  // the uncommitted scroll gap, and a stale scrollTop is clamped so the window
  // is never empty while nRows > 0.
  const { effTop, rowStart, rowEnd } = gridWindow({
    scrollTop: scroll.top,
    jumpPx: veloRef.current.jumpPx,
    viewH: view.h,
    rowH,
    headerH,
    nRows,
    overscanFloor: OVERSCAN_ROWS,
    maxOverscanVp: MAX_OVERSCAN_VP,
  });

  let colStart = 0;
  while (colStart < nCols - 1 && offsets[colStart + 1] < scroll.left) colStart++;
  colStart = Math.max(0, colStart - OVERSCAN_COLS);
  let colEnd = colStart;
  while (colEnd < nCols && offsets[colEnd] < scroll.left + view.w) colEnd++;
  colEnd = Math.min(nCols, colEnd + OVERSCAN_COLS);

  const leftPad = offsets[colStart];
  const rightPad = offsets[nCols] - offsets[colEnd];
  // What is actually on screen after this commit — handleScroll measures the
  // uncommitted gap (overscan sizing) against this position.
  committedRef.current = { top: effTop };

  // ── Scroll ─────────────────────────────────────────────────────────────────

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    // Overscan bookkeeping: the gap since the last COMMIT (committedRef), not
    // since the last event — several scroll events can land in one frame and
    // the buffer must cover their sum. Decays by half per event once the
    // scrolling slows, back toward the one-viewport rest buffer.
    veloRef.current.jumpPx = Math.max(
      Math.abs(el.scrollTop - committedRef.current.top),
      veloRef.current.jumpPx * 0.5
    );
    // Gutter sync: the row-number overlay is NOT in the scrolled content (one
    // sticky element per visible row was the top raster cost in WebKit), so
    // between commits it must track the live scroll position imperatively —
    // one transform write per event, compositor-cheap. Reset to '' right
    // after each commit, whose render repositions the gutter cells.
    if (gutterViewRef.current) {
      gutterViewRef.current.style.transform =
        `translateY(${committedRef.current.top - el.scrollTop}px)`;
    }
    // One commit per frame, holding the LATEST scroll position: input events
    // can arrive several times per frame, and every commit remounts the whole
    // window (keys are absolute row indexes), so committing per event spends
    // the frame budget several times over and starves the main thread — the
    // compositor then scrolls ahead of a busy main thread and paints
    // background (the reported blank). flushSync inside the rAF pins the
    // commit to that frame's paint; continuous-priority setScroll alone can
    // be restarted by the next event and starve for several frames.
    if (!scrollRafRef.current) {
      scrollRafRef.current = requestAnimationFrame(() => {
        scrollRafRef.current = 0;
        const el2 = scrollRef.current;
        if (el2) flushSync(() => setScroll({ top: el2.scrollTop, left: el2.scrollLeft }));
        // The commit re-rendered the gutter cells at the new position —
        // drop the live-scroll compensation (see handleScroll).
        if (gutterViewRef.current) gutterViewRef.current.style.transform = '';
      });
    }
    // The near-bottom fetch stays rAF-coalesced — its callback kicks the
    // parent's page machinery, and once per frame is plenty for that.
    if (onNearBottomRef.current && !rafRef.current) {
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = 0;
        const el2 = scrollRef.current;
        if (el2 && onNearBottomRef.current
            && el2.scrollHeight - el2.scrollTop - el2.clientHeight < el2.clientHeight * 2) {
          onNearBottomRef.current();
        }
      });
    }
  }, []);
  useEffect(() => () => {
    cancelAnimationFrame(rafRef.current);
    cancelAnimationFrame(scrollRafRef.current);
  }, []);

  // ── Selection helpers ──────────────────────────────────────────────────────

  const normSel = useCallback((s: SelRect): SelRect => ({
    r1: Math.min(s.r1, s.r2), r2: Math.max(s.r1, s.r2),
    c1: Math.min(s.c1, s.c2), c2: Math.max(s.c1, s.c2),
  }), []);

  const setSel = useCallback((s: SelRect | null, dragging = false) => {
    setSelection(s);
    onSelectionChange?.(s ? {
      r1: Math.min(s.r1, s.r2), r2: Math.max(s.r1, s.r2),
      c1: Math.min(s.c1, s.c2), c2: Math.max(s.c1, s.c2),
    } : null, dragging);
  }, [onSelectionChange]);

  const getSelectionData = useCallback(() => {
    const names = columns.map(c => c.name);
    if (!selection) return { columns: names, rows };
    const s = normSel(selection);
    const cols = names.slice(s.c1, s.c2 + 1);
    const out: unknown[][] = [];
    for (let r = s.r1; r <= Math.min(s.r2, nRows - 1); r++) {
      out.push(rows[r].slice(s.c1, s.c2 + 1));
    }
    return { columns: cols, rows: out };
  }, [columns, rows, selection, normSel, nRows]);

  useEffect(() => {
    if (!apiRef) return;
    apiRef.current = {
      getSelectionData,
      hasSelection: () => selection !== null,
      selectAll: () => setSel({ r1: 0, c1: 0, r2: nRows - 1, c2: nCols - 1 }),
      selectRow: (row: number) => {
        if (row < 0 || row >= nRows) return;
        setSel({ r1: row, c1: 0, r2: row, c2: nCols - 1 });
        // Centre it rather than merely revealing it: the caller is pointing at
        // this row from somewhere else, so it should land where the eye is.
        const el = scrollRef.current;
        if (el) el.scrollTop = Math.max(0, row * rowH - el.clientHeight / 2);
      },
    };
    return () => { apiRef.current = null; };
  }, [apiRef, getSelectionData, selection, nRows, nCols, setSel, rowH]);

  // ── Editing ────────────────────────────────────────────────────────────────

  const getPkValues = useCallback((rowIdx: number): Record<string, unknown> => {
    const pk: Record<string, unknown> = {};
    for (const pkCol of pkColumns ?? []) {
      const ci = columns.findIndex(c => c.name === pkCol);
      if (ci >= 0) pk[pkCol] = rows[rowIdx][ci];
    }
    return pk;
  }, [pkColumns, columns, rows]);

  const startEdit = useCallback((r: number, c: number) => {
    if (!editable || pkSet.has(columns[c].name)) return;
    const v = rows[r][c];
    setEditing({ r, c, value: v === null || v === undefined ? '' : String(v) });
    setTimeout(() => editInputRef.current?.select(), 0);
  }, [editable, pkSet, columns, rows]);

  const commitEdit = useCallback(() => {
    if (!editing || !onEdit) { setEditing(null); return; }
    const original = rows[editing.r][editing.c];
    const newVal = editing.value === '' ? null : editing.value;
    if (String(original ?? '') !== String(newVal ?? '')) {
      onEdit({
        pk_values: getPkValues(editing.r),
        column: columns[editing.c].name,
        new_value: newVal,
      });
    }
    setEditing(null);
  }, [editing, onEdit, rows, columns, getPkValues]);

  // ── Mouse (event delegation — one handler for every cell) ─────────────────

  const cellFromEvent = useCallback((e: React.MouseEvent): { r: number; c: number } | null => {
    const el = (e.target as HTMLElement).closest('[data-r]') as HTMLElement | null;
    if (!el || el.dataset.r === undefined || el.dataset.c === undefined) return null;
    return { r: Number(el.dataset.r), c: Number(el.dataset.c) };
  }, []);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;
    const cell = cellFromEvent(e);
    if (!cell) return;
    if (e.shiftKey && active) {
      setSel({ r1: active.r, c1: active.c, r2: cell.r, c2: cell.c });
    } else {
      setActive(cell);
      setSel({ r1: cell.r, c1: cell.c, r2: cell.r, c2: cell.c });
      draggingRef.current = true;
    }
  }, [cellFromEvent, active, setSel]);

  // Row-number gutter click selects the whole row. The gutter is a separate
  // overlay column now (see the render), so it gets its own delegated handler.
  const handleGutterMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;
    const rn = (e.target as HTMLElement).closest('[data-rn]') as HTMLElement | null;
    if (!rn || rn.dataset.rn === undefined) return;
    const r = Number(rn.dataset.rn);
    setSel({ r1: r, c1: 0, r2: r, c2: nCols - 1 });
    setActive({ r, c: 0 });
  }, [nCols, setSel]);

  // Drag selection is rAF-coalesced (the scroll handler shows the pattern):
  // raw mousemoves arrive faster than frames, and every applied selection
  // re-renders the grid and re-runs the parent's aggregate scan.
  const dragRafRef = useRef(0);
  const dragSelRef = useRef<SelRect | null>(null);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!draggingRef.current || !active) return;
    const cell = cellFromEvent(e);
    if (!cell) return;
    dragSelRef.current = { r1: active.r, c1: active.c, r2: cell.r, c2: cell.c };
    if (dragRafRef.current) return;
    dragRafRef.current = requestAnimationFrame(() => {
      dragRafRef.current = 0;
      if (dragSelRef.current) setSel(dragSelRef.current, true);
    });
  }, [cellFromEvent, active, setSel]);

  useEffect(() => {
    const up = () => {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      // Flush the last coalesced position as the FINAL selection (dragging
      // false), so deferred work like aggregates runs exactly once.
      if (dragRafRef.current) { cancelAnimationFrame(dragRafRef.current); dragRafRef.current = 0; }
      if (dragSelRef.current) { setSel(dragSelRef.current); dragSelRef.current = null; }
    };
    window.addEventListener('mouseup', up);
    return () => {
      window.removeEventListener('mouseup', up);
      cancelAnimationFrame(dragRafRef.current);
    };
  }, [setSel]);

  const handleDoubleClick = useCallback((e: React.MouseEvent) => {
    const cell = cellFromEvent(e);
    if (!cell) return;
    const fk = fkCols[cell.c];
    if (fk && onFkClick && !e.altKey) {
      const v = rows[cell.r][cell.c];
      if (v !== null && v !== undefined) {
        onFkClick(fk.fk_table!, fk.fk_column!, v);
        return;
      }
    }
    if (editable) startEdit(cell.r, cell.c);
    else onOpenCell?.(cell.r, cell.c);
  }, [cellFromEvent, fkCols, onFkClick, rows, editable, startEdit, onOpenCell]);

  // ── Keyboard ───────────────────────────────────────────────────────────────

  const ensureVisible = useCallback((r: number, c: number) => {
    const el = scrollRef.current;
    if (!el) return;
    const cellTop = headerH + r * rowH;
    const cellLeft = offsets[c];
    const cellRight = offsets[c + 1];
    if (cellTop < el.scrollTop + headerH) el.scrollTop = cellTop - headerH;
    else if (cellTop + rowH > el.scrollTop + el.clientHeight) {
      el.scrollTop = cellTop + rowH - el.clientHeight;
    }
    if (cellLeft < el.scrollLeft) el.scrollLeft = cellLeft;
    else if (cellRight > el.scrollLeft + el.clientWidth) {
      el.scrollLeft = cellRight - el.clientWidth;
    }
  }, [headerH, rowH, offsets]);

  // Cells matching the find query (case-insensitive substring), capped so a
  // huge result never freezes the scan. Only computed while the bar is open,
  // and only once the debounced query settles.
  useEffect(() => {
    const t = setTimeout(() => setFindQuery(findText), 200);
    return () => clearTimeout(t);
  }, [findText]);

  const matches = useMemo(() => {
    const q = findQuery.trim().toLowerCase();
    if (!findOpen || !q) return [] as { r: number; c: number }[];
    const out: { r: number; c: number }[] = [];
    const CAP = 5000;
    for (let r = 0; r < nRows; r++) {
      const row = rows[r];
      for (let c = 0; c < nCols; c++) {
        const v = row[c];
        if (v != null && String(v).toLowerCase().includes(q)) {
          out.push({ r, c });
          if (out.length >= CAP) return out;
        }
      }
    }
    return out;
  }, [findOpen, findQuery, rows, nRows, nCols]);

  // Distinct matching rows → red ticks on the scroll rail (VSCode-style).
  const matchRows = useMemo(() => [...new Set(matches.map(m => m.r))], [matches]);
  // Rendered ticks, bucketed by permille of rail height (WP-14 14.1): the
  // rail is a few hundred px tall, so two matches in the same thousandth are
  // one tick — this caps the DOM at ≤1000 nodes instead of one per matching
  // row (up to the 5000-match cap), and the useMemo stops the array being
  // rebuilt on every rAF scroll frame while the find bar is open.
  const matchTicks = useMemo(() => {
    if (matchRows.length === 0 || nRows === 0) return [];
    const buckets = new Set<number>();
    for (const r of matchRows) {
      buckets.add(Math.floor((r / nRows) * 1000));
    }
    return [...buckets].map(b => (
      <div key={b} className="fg-match-tick" style={{ top: `${b / 10}%` }} />
    ));
  }, [matchRows, nRows]);

  const goToMatch = useCallback((idx: number) => {
    if (matches.length === 0) return;
    const i = ((idx % matches.length) + matches.length) % matches.length;
    setMatchIdx(i);
    const m = matches[i];
    setActive({ r: m.r, c: m.c });
    setSel({ r1: m.r, c1: m.c, r2: m.r, c2: m.c });
    ensureVisible(m.r, m.c);
  }, [matches, setSel, ensureVisible]);

  const closeFind = useCallback(() => { setFindOpen(false); setFindText(''); setMatchIdx(-1); }, []);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (editing) return; // input handles its own keys
    const mod = e.metaKey || e.ctrlKey;

    if (mod && e.key === 'f') {
      e.preventDefault();
      setFindOpen(true);
      setTimeout(() => findInputRef.current?.select(), 0);
      return;
    }

    if (mod && e.key === 'c') {
      e.preventDefault();
      const { columns: cols, rows: data } = getSelectionData();
      const text = getPref(PREFS.copyHeaders)
        ? toTsv(cols, data)
        : data.map(r => r.map(cellText).join('\t')).join('\n') + '\n';
      copyToClipboard(text).catch(() => {});
      return;
    }
    if (mod && e.key === 'a') {
      e.preventDefault();
      setSel({ r1: 0, c1: 0, r2: nRows - 1, c2: nCols - 1 });
      return;
    }
    if (!active) return;

    if (e.key === 'Enter' && e.shiftKey) {
      e.preventDefault();
      onOpenCell?.(active.r, active.c);
      return;
    }
    if (e.key === 'Enter' && editable) {
      e.preventDefault();
      startEdit(active.r, active.c);
      return;
    }

    let { r, c } = active;
    const pageRows = Math.max(1, Math.floor((view.h - headerH) / rowH) - 1);
    switch (e.key) {
      case 'ArrowUp':    r -= 1; break;
      case 'ArrowDown':  r += 1; break;
      case 'ArrowLeft':  c -= 1; break;
      case 'ArrowRight': c += 1; break;
      case 'PageUp':     r -= pageRows; break;
      case 'PageDown':   r += pageRows; break;
      case 'Home':       c = 0; if (mod) r = 0; break;
      case 'End':        c = nCols - 1; if (mod) r = nRows - 1; break;
      default: return;
    }
    e.preventDefault();
    r = Math.max(0, Math.min(nRows - 1, r));
    c = Math.max(0, Math.min(nCols - 1, c));
    setActive({ r, c });
    if (e.shiftKey && selection) {
      setSel({ r1: selection.r1, c1: selection.c1, r2: r, c2: c });
    } else {
      setSel({ r1: r, c1: c, r2: r, c2: c });
    }
    ensureVisible(r, c);
  }, [
    editing, active, selection, nRows, nCols, view.h, headerH, rowH,
    getSelectionData, setSel, ensureVisible, editable, startEdit, onOpenCell,
  ]);

  // ── Column resize ──────────────────────────────────────────────────────────

  const resizeRef = useRef<{ col: number; startX: number; startW: number } | null>(null);
  const suppressSortRef = useRef(false); // a resize drag must not fire the header's sort click

  const handleResizeStart = useCallback((col: number, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    suppressSortRef.current = true;
    resizeRef.current = { col, startX: e.clientX, startW: widths[col] };
    const move = (ev: MouseEvent) => {
      const st = resizeRef.current;
      if (!st) return;
      const w = Math.max(MIN_COL_W, st.startW + ev.clientX - st.startX);
      setOverrides(prev => {
        const next = new Map(prev);
        next.set(st.col, w);
        return next;
      });
    };
    const up = () => {
      resizeRef.current = null;
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  }, [widths]);

  const autoFit = useCallback((col: number, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setOverrides(prev => {
      if (!prev.has(col)) return prev;
      const next = new Map(prev);
      next.delete(col);
      return next;
    });
  }, []);

  // ── Pending-edit decoration (browser mode) ─────────────────────────────────

  const pendingByRow = useMemo(() => {
    if (!pendingKeys || pendingKeys.size === 0 || !pkColumns?.length) return null;
    const map = new Map<number, number[]>();
    // Resolve pk column indices once, not once per visible row.
    const pkIdx = pkColumns.map(pkCol => columns.findIndex(c => c.name === pkCol));
    // Only visible rows need decoration — bounded work per render
    for (let r = rowStart; r < rowEnd; r++) {
      const pk = JSON.stringify(
        Object.fromEntries(pkColumns.map((pkCol, k) => {
          const ci = pkIdx[k];
          return [pkCol, ci >= 0 ? rows[r][ci] : undefined];
        }))
      );
      let cols: number[] | null = null;
      for (let c = colStart; c < colEnd; c++) {
        if (pendingKeys.has(`${pk}|${columns[c].name}`)) {
          (cols ??= []).push(c);
        }
      }
      if (cols) map.set(r, cols);
    }
    return map.size > 0 ? map : null;
  }, [pendingKeys, pkColumns, columns, rows, rowStart, rowEnd, colStart, colEnd]);

  // ── Render ─────────────────────────────────────────────────────────────────

  const sel = selection ? normSel(selection) : null;

  const bodyRows = [];
  for (let r = rowStart; r < rowEnd; r++) {
    const rowSel = sel && r >= sel.r1 && r <= sel.r2 ? { c1: sel.c1, c2: sel.c2 } : null;
    bodyRows.push(
      <GridRow
        key={r}
        row={rows[r]}
        rowIdx={r}
        top={headerH + r * rowH}
        rowH={rowH}
        totalW={totalW}
        colStart={colStart}
        colEnd={colEnd}
        widths={widths}
        leftPad={leftPad}
        rightPad={rightPad}
        numeric={numeric}
        fkCols={fkCols}
        zebra={settings.zebraStripes}
        sel={rowSel}
        active={active && active.r === r ? active.c : null}
        pendingCols={pendingByRow?.get(r) ?? null}
        rowCls={rowClass?.(r) ?? ''}
        textCache={textCache}
      />
    );
  }

  const headerCells = [];
  for (let c = colStart; c < colEnd; c++) {
    const col = columns[c];
    const dir = sort?.find(s => s.column === col.name)?.direction ?? null;
    const isPk = pkSet.has(col.name);
    const fk = fkCols[c];
    headerCells.push(
      <div
        key={c}
        className={`fg-hcell ${isPk ? 'fg-hpk' : ''}`}
        style={{ width: widths[c] }}
        title={`${col.name} · ${col.type_name}${isPk ? ' · PRIMARY KEY' : ''}${fk ? ` · FK → ${fk.fk_table}` : ''}`}
        onClick={onSortCol ? () => {
          if (suppressSortRef.current) { suppressSortRef.current = false; return; }
          onSortCol(col.name);
        } : undefined}
      >
        <span className="fg-hname">
          {isPk ? '🔑 ' : ''}{fk ? '🔗 ' : ''}{col.name}
          {dir && <span className="fg-sort">{dir === 'asc' ? ' ▴' : ' ▾'}</span>}
        </span>
        {onFilterCol && (
          <span
            className={`fg-hfilter ${filteredCols?.has(col.name) ? 'on' : ''}`}
            title={filteredCols?.has(col.name) ? `Filtered: ${col.name}` : `Filter ${col.name}`}
            onClick={e => {
              e.stopPropagation();
              const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
              onFilterCol(col.name, { x: r.left, y: r.bottom + 4 });
            }}
            onMouseDown={e => e.stopPropagation()}
          >
            <svg width="10" height="10" viewBox="0 0 12 12" aria-hidden>
              <path d="M1 1h10L7.5 6v4L4.5 8.5V6L1 1z" fill="currentColor" />
            </svg>
          </span>
        )}
        <div
          className="fg-resize"
          onMouseDown={e => handleResizeStart(c, e)}
          onDoubleClick={e => autoFit(c, e)}
        />
      </div>
    );
  }

  // Editing overlay geometry
  const editStyle = editing ? {
    top: headerH + editing.r * rowH,
    left: offsets[editing.c],
    width: widths[editing.c],
    height: rowH,
  } : undefined;

  // Row-number gutter cells — the overlay column beside the scroller (see
  // fg-gutter in App.css). Cells sit at the same content-y as their row minus
  // the committed scroll position; handleScroll tracks live scrolling with a
  // single transform on the container between commits.
  const gutterCells = [];
  if (showRowNum) {
    for (let r = rowStart; r < rowEnd; r++) {
      const rowSel = sel && r >= sel.r1 && r <= sel.r2;
      gutterCells.push(
        <div
          key={r}
          className={`fg-rownum${rowSel ? ' fg-rn-sel' : ''}`}
          style={{ top: headerH + r * rowH - effTop, height: rowH }}
          data-rn={r}
        >
          {r + 1}
        </div>
      );
    }
  }

  return (
    <div
      className="fg-wrap"
      style={{
        '--fg-font': settings.fontFamily,
        // Base px × the app-wide --font-scale — the grid follows the Settings
        // font-size stepper live (calc resolves without a re-render). Set on
        // the wrap so the gutter overlay (outside .fg-scroll) inherits too.
        '--fg-size': `calc(${settings.fontSize}px * var(--font-scale, 1))`,
        '--fg-rowh': `${rowH}px`,
        '--fg-lines': settings.verticalLines ? '1px' : '0px',
      } as React.CSSProperties}
    >
    {findOpen && matchTicks.length > 0 && (
      <div className="fg-match-rail" style={{ top: headerH }} aria-hidden>
        {matchTicks}
      </div>
    )}
    {findOpen && (
      <div className="fg-find">
        <input
          ref={findInputRef}
          className="fg-find-input"
          placeholder="Find in results…"
          value={findText}
          onChange={e => { setFindText(e.target.value); setMatchIdx(-1); }}
          onKeyDown={e => {
            if (e.key === 'Enter') { e.preventDefault(); goToMatch(e.shiftKey ? matchIdx - 1 : matchIdx + 1); }
            else if (e.key === 'Escape') { e.preventDefault(); closeFind(); scrollRef.current?.focus(); }
            e.stopPropagation();
          }}
        />
        <span className="fg-find-count">
          {findText.trim()
            ? (matches.length ? `${matchIdx >= 0 ? matchIdx + 1 : 0}/${matches.length}` : 'no matches')
            : ''}
        </span>
        <button className="fg-find-btn" onMouseDown={e => e.preventDefault()} onClick={() => goToMatch(matchIdx - 1)} title={`Previous (${SC.shiftEnter})`}>‹</button>
        <button className="fg-find-btn" onMouseDown={e => e.preventDefault()} onClick={() => goToMatch(matchIdx + 1)} title="Next (⏎)">›</button>
        <button className="fg-find-btn" onMouseDown={e => e.preventDefault()} onClick={() => { closeFind(); scrollRef.current?.focus(); }} title="Close (Esc)">✕</button>
      </div>
    )}
    <div className="fg-body">
    {showRowNum && (
      <div className="fg-gutter" style={{ width: rnW }} onMouseDown={handleGutterMouseDown}>
        <div className="fg-gutter-head" style={{ height: headerH }}>#</div>
        <div className="fg-gutter-view" ref={gutterViewRef}>
          {gutterCells}
        </div>
      </div>
    )}
    <div
      ref={scrollRef}
      className="fg-scroll"
      tabIndex={0}
      onScroll={handleScroll}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onDoubleClick={handleDoubleClick}
      onKeyDown={handleKeyDown}
    >
      <div className="fg-content" style={{ width: totalW, height: totalH }}>
        {/* Sticky header */}
        <div className="fg-header" style={{ height: headerH, width: totalW }}>
          {leftPad > 0 && <div style={{ width: leftPad, flex: 'none' }} />}
          {headerCells}
          {rightPad > 0 && <div style={{ width: rightPad, flex: 'none' }} />}
        </div>

        {bodyRows}

        {/* Inline edit overlay — outside rows so typing never re-renders them */}
        {editing && (
          <input
            ref={editInputRef}
            className="fg-edit"
            style={editStyle}
            value={editing.value}
            onChange={e => setEditing({ ...editing, value: e.target.value })}
            onBlur={commitEdit}
            onKeyDown={e => {
              if (e.key === 'Enter')  { e.preventDefault(); commitEdit(); }
              if (e.key === 'Escape') { setEditing(null); }
              e.stopPropagation();
            }}
            onMouseDown={e => e.stopPropagation()}
            onDoubleClick={e => e.stopPropagation()}
          />
        )}
      </div>

      {nRows === 0 && <div className="fg-empty">No rows.</div>}
    </div>
    </div>
    </div>
  );
}
