/**
 * CodeMirror 6-based SQL / Redis editor.
 * Schema-aware autocomplete is injected via the `schemaCompletions` prop.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { EditorView, keymap, highlightActiveLine,
  drawSelection, rectangularSelection, crosshairCursor, Decoration, hoverTooltip,
  gutter, GutterMarker, highlightWhitespace, highlightTrailingWhitespace,
  scrollPastEnd, ViewPlugin, WidgetType } from '@codemirror/view';
import type { DecorationSet, ViewUpdate } from '@codemirror/view';
import { EditorState, Compartment, StateField, StateEffect, Annotation, EditorSelection, type Text, type Extension } from '@codemirror/state';
import { parseKillTrigger } from '../utils/killAnalyze';
import { callSiteAt, resolveHover, signatureArgs } from '../utils/sqlHover';
import type { HoverContext, HoverTarget } from '../utils/sqlHover';
import { keywordCatalog } from '../utils/sqlKeywords';
import { blank, findAliases } from '../utils/sqlAlias';
import { insertContext } from '../utils/sqlContext';
import { renameTargetAt, planRename, applyRename, type RenameSchemaTable } from '../utils/renameRefactor';
import { promptDialog } from '../utils/appDialog';
import { diagnose, emptyDiagContext } from '../utils/sqlDiagnostics';
import { fixesFor } from '../utils/sqlQuickFix';
import { activeProfile, applyProfile } from '../utils/formatProfiles';
import type { DiagContext, Diagnostic } from '../utils/sqlDiagnostics';
import type { KillTrigger } from '../utils/killAnalyze';
import { splitStatements, statementAt, statementAtCaret, firstCodeOffset, type Statement } from '../utils/sqlSplit';
import { insertValueHints } from '../utils/insertHints';
import {
  defaultKeymap, history, historyField, historyKeymap, indentWithTab,
  moveLineUp, moveLineDown, copyLineUp, copyLineDown, deleteLine,
  toggleComment, indentMore, indentLess, cursorMatchingBracket,
} from '@codemirror/commands';
import { sql, MSSQL, MySQL, PostgreSQL, StandardSQL } from '@codemirror/lang-sql';
import {
  autocompletion, closeBrackets, closeBracketsKeymap, acceptCompletion,
} from '@codemirror/autocomplete';
import { buildCompletionSource } from '../utils/sqlComplete';
import { fmtDurationCompact } from '../utils/fmtDuration';
import { nextRunTick, runningIndex, runStamp, spinnerFrame, tickElapsed, timingLine } from '../utils/runMarkers';
import type { RunTick } from '../utils/runMarkers';
import { selectedLineNumbers } from '../utils/selectionLines';
import { expandRange } from '../utils/selectionExpand';
import { usageBoost, bumpUsageFromSql } from '../utils/usageRank';
import { buildRedisCompletionSource } from '../utils/redisComplete';
import type { FkEdge } from '../utils/sqlComplete';
import { appEditorTheme } from '../utils/editorTheme';
import { bracketMatching, indentOnInput, foldGutter, codeFolding, foldKeymap } from '@codemirror/language';
import { searchKeymap, highlightSelectionMatches, search, openSearchPanel, gotoLine } from '@codemirror/search';
import { selectNextOccurrence } from '@codemirror/search';
import { selectAllOccurrences, splitSelectionIntoLines, surroundInputHandler } from '../utils/editorSelect';
import { occurrenceHighlighter } from '../utils/occurrenceHighlight';
import { symbolRefs, type SymbolRefs } from '../utils/symbolRefs';
import { completeStatement } from '../utils/completeStatement';
import { todoMarkers, jumpTarget } from '../utils/todoMarkers';
import { wrapInSubquery, extractCte, parseSelect, transformStatement,
  selectToInsert, selectToCreateTable, selectToCreateView, selectToDelete, selectToUpdate } from '../utils/sqlRefactor';
import { copyToClipboard } from '../utils/exportersIo';
import { formatSql } from '../utils/sqlBeautify';
import { minimap } from './minimap';
import { indentGuides } from './indentGuides';
import { rulers } from './editorRulers';
import { changeBars } from './editorChangeBars';
import { searchCountBadge } from './searchBadge';
import { sqlPatternSearch } from './sqlPatternSearch';
import { ContextMenu, ContextMenuItem } from './ContextMenu';
import { CommandPalette } from './CommandPalette';
import { EDITOR_COMMANDS, formatKeys } from '../utils/commandRegistry';
import { MacroRecorder, isRecordable } from '../utils/macroRecorder';
import type { Engine } from '../types';
import { getPref, PREFS, sqlDelimiter } from '../store/preferences';
import { SqlTemplatesStore } from '../store/sqlTemplates';
import { shortcuts, shortcut } from '../utils/platform';
import { pushClip, clips } from '../utils/clipboardRing';
import {
  convertCaseCmd, dedupeLinesCmd, insertNumberSequenceCmd, joinLinesCmd,
  keepDuplicatesCmd, removeBlankLinesCmd, reverseLinesCmd, shuffleLinesCmd,
  sortLinesCmd, trimTrailingCmd, indentToTabsCmd, indentToSpacesCmd,
} from './editorLineCommands';

/** Shortcut labels for this platform — see utils/platform. */
const SC = shortcuts();

const WRAP_KEY = 'dbgui:editor-wrap';

/** ⌘⇧V paste-history label for this platform (e.g. `⌘⇧V` / `Ctrl+Shift+V`). */
const PASTE_HISTORY_SC = shortcut('V', { shift: true });

/** ⌘\ split-editor label (VS Code's shortcut for the same thing). */
const SPLIT_SC = shortcut('\\');

/**
 * Split view (Editor §5.7). Two `EditorView`s edit ONE document: they hold
 * independent `EditorState`s kept byte-for-byte in sync by forwarding every
 * document change to the peer. `splitSync` tags a forwarded transaction so the
 * peer applies it without echoing it straight back — otherwise the two panes
 * would bounce a single keystroke between them forever.
 */
const splitSync = Annotation.define<boolean>();

/**
 * One-line, length-capped preview of a clip for the paste-history picker.
 * Runs of whitespace (incl. newlines) collapse to a single space so a
 * multi-line copy still reads as one row.
 */
function clipPreview(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > 60 ? oneLine.slice(0, 59) + '…' : oneLine;
}

/**
 * Pretty-print with sql-formatter (lazy import). Formats the SELECTION when
 * there is one — a DBA usually wants to tidy the statement in hand, not
 * reflow a 500-line scratch buffer — and the whole document otherwise.
 * Keyword case follows the editor preference.
 */
function formatDocument(view: EditorView, engine: Engine) {
  import('sql-formatter').then(({ format }) => {
    const dialectMap: Record<Engine, 'mysql' | 'postgresql' | 'sql' | 'transactsql'> = {
      mysql: 'mysql', postgres: 'postgresql', redis: 'sql',
      // sql-formatter has no ClickHouse dialect; generic SQL keeps
      // its formatting conservative rather than mangling CH syntax.
      clickhouse: 'sql',
      sqlite: 'sql',
      parquet: 'sql',
      // No DuckDB dialect either; DuckDB SQL is Postgres-flavoured but the
      // generic formatter is the conservative choice for its extensions
      // (PIVOT, FROM-first, positional join).
      duckdb: 'sql',
      // MongoDB never mounts the SQL editor; total map, inert entry.
      mongodb: 'sql',
      // sql-formatter ships a real Transact-SQL dialect.
      sqlserver: 'transactsql',
    };
    const sel = view.state.selection.main;
    const from = sel.empty ? 0 : sel.from;
    const to = sel.empty ? view.state.doc.length : sel.to;
    const source = view.state.doc.sliceString(from, to);
    let formatted: string;
    try {
      const profile = activeProfile(localStorage);
      formatted = format(source, {
        language: dialectMap[engine],
        // Always two here, then re-indented to the profile's unit below —
        // one place decides indentation instead of two disagreeing.
        tabWidth: 2,
        keywordCase: profile.keywordCase,
      });
      formatted = applyProfile(formatted, profile);
    } catch {
      return; // unparseable — leave the text untouched
    }
    // Keep the selection's own indentation when formatting a fragment.
    if (!sel.empty) {
      const lineStart = view.state.doc.lineAt(from).from;
      const indent = view.state.doc.sliceString(lineStart, from).match(/^[ \t]*/)?.[0] ?? '';
      if (indent) formatted = formatted.split('\n').join('\n' + indent);
    }
    view.dispatch({ changes: { from, to, insert: formatted },
      selection: { anchor: from, head: from + formatted.length } });
    view.focus();
  });
}

// Dialect map
const DIALECT: Record<Engine, typeof MySQL | typeof StandardSQL> = {
  mysql:    MySQL,
  postgres: PostgreSQL,
  redis:    StandardSQL,
  // ClickHouse quotes identifiers with backticks like MySQL, which is the
  // part of the dialect that matters for bracket matching and completion.
  clickhouse: MySQL,
  // SQLite quotes with double quotes like the standard, and its dialect is
  // closest to StandardSQL of the ones bundled.
  sqlite: StandardSQL,
  // Parquet has no SQL at all; the editor is not offered for it, and this
  // entry exists only so the map stays total.
  parquet: StandardSQL,
  // DuckDB SQL is Postgres-flavoured: double-quoted identifiers, single-quoted
  // strings, `$$` dollar quoting. The PostgreSQL dialect is the closest of the
  // bundled ones — that is also why sqlIdent quotes DuckDB like PostgreSQL.
  duckdb: PostgreSQL,
  // MongoDB sessions mount MongoBrowser, not this editor — the entry exists
  // only so the map stays total.
  mongodb: StandardSQL,
  // T-SQL is what this editor is for here — @codemirror/lang-sql ships MSSQL.
  sqlserver: MSSQL,
};

/** Marks our own auto-format transactions so the listener doesn't re-fire. */
const autoFormatAn = Annotation.define<boolean>();

/**
 * Beautify the selection, or the statement under the caret, with the pure
 * formatter (utils/sqlBeautify.ts) — keyword case follows the preference.
 * Unlike ⌘⇧F (sql-formatter, whole document) this is surgical: it rewrites
 * exactly the block in hand.
 */
function beautifyBlock(view: EditorView, engine: Engine): boolean {
  if (engine === 'redis') return false;
  const profile = activeProfile(localStorage);
  const opts = { keywordCase: profile.keywordCase, engine };
  const style = (text: string) => applyProfile(text, profile);
  const sel = view.state.selection.main;
  if (!sel.empty) {
    const source = view.state.sliceDoc(sel.from, sel.to);
    const lineStart = view.state.doc.lineAt(sel.from).from;
    const indent = view.state.sliceDoc(lineStart, sel.from).match(/^[ \t]*/)?.[0] ?? '';
    let formatted = style(formatSql(source, opts));
    if (indent) formatted = formatted.split('\n').join('\n' + indent);
    view.dispatch({ changes: { from: sel.from, to: sel.to, insert: formatted },
      selection: { anchor: sel.from + formatted.length } });
  } else {
    const doc = view.state.doc.toString();
    const stmt = statementAtCaret(doc, sel.head, sqlDelimiter());
    if (!stmt || !stmt.text.trim()) return false;
    const formatted = style(formatSql(stmt.text, opts));
    if (formatted === stmt.text) return true;
    view.dispatch({ changes: { from: stmt.from, to: stmt.to, insert: formatted },
      selection: { anchor: stmt.from } });
  }
  view.focus();
  return true;
}

/**
 * Auto-format listener for the `dbgui.editorAutoFormat` preference:
 *  - semicolon: format the statement a freshly typed `;` just terminated
 *    (only when the typed `;` IS the statement terminator — inside a string
 *    or mid-statement it stays quiet);
 *  - paste: format a pasted chunk that looks like SQL.
 * Our own transactions carry `autoFormatAn` so this never recurses.
 */
function autoFormatListener(engine: Engine) {
  return EditorView.updateListener.of(update => {
    if (engine === 'redis' || !update.docChanged) return;
    const mode = getPref(PREFS.editorAutoFormat);
    if (mode === 'off') return;
    if (update.transactions.some(tr => tr.annotation(autoFormatAn) !== undefined)) return;
    // The same profile the explicit format commands use — auto-format that
    // disagreed with ⇧⌥F would fight the user on every semicolon.
    const profile = activeProfile(localStorage);
    const opts = { keywordCase: profile.keywordCase, engine };
    const style = (text: string) => applyProfile(text, profile);

    for (const tr of update.transactions) {
      if (mode === 'semicolon' && tr.isUserEvent('input.type')) {
        let semiEnd = -1;
        tr.changes.iterChanges((_fA, _tA, fB, _tB, inserted) => {
          if (inserted.toString() === ';') semiEnd = fB + inserted.length;
        });
        if (semiEnd < 0) continue;
        const doc = update.state.doc.toString();
        const stmt = statementAt(doc, semiEnd, sqlDelimiter());
        if (!stmt || stmt.to !== semiEnd || stmt.text.length < 4) continue;
        const formatted = style(formatSql(stmt.text, opts));
        if (!formatted || formatted === stmt.text) continue;
        update.view.dispatch({
          changes: { from: stmt.from, to: stmt.to, insert: formatted },
          selection: { anchor: stmt.from + formatted.length },
          annotations: autoFormatAn.of(true),
        });
      } else if (mode === 'paste' && tr.isUserEvent('input.paste')) {
        const edits: { from: number; to: number; insert: string }[] = [];
        tr.changes.iterChanges((_fA, _tA, fB, tB, inserted) => {
          const text = inserted.toString();
          if (!/\b(select|insert|update|delete|with|create|alter|drop|explain)\b/i.test(text)) return;
          const formatted = formatSql(text.trim(), opts);
          if (formatted && formatted !== text.trim()) {
            const lead = text.slice(0, text.length - text.trimStart().length);
            edits.push({ from: fB, to: tB, insert: lead + formatted });
          }
        });
        if (edits.length) {
          update.view.dispatch({ changes: edits, annotations: autoFormatAn.of(true) });
        }
      }
    }
  });
}

// ── Statement-split cache ────────────────────────────────────────────────────
// CodeMirror's `Text` is immutable, so a doc that hasn't changed is the SAME
// object — a sound cache key. Splitting is O(n); the caret-highlight field, the
// run-marker gutter and statement lookups all want the same split, and it would
// otherwise be recomputed several times per keystroke AND on every arrow-key.
// Keyed on (doc, delimiter) since a settings change can alter the split.
const splitCache = new WeakMap<Text, { delim: string; stmts: Statement[] }>();
function splitDoc(doc: Text, delim: string): Statement[] {
  const hit = splitCache.get(doc);
  if (hit && hit.delim === delim) return hit.stmts;
  const stmts = splitStatements(doc.toString(), delim);
  splitCache.set(doc, { delim, stmts });
  return stmts;
}
/** statementAt over a cached split — the whitespace/comment gap rule of statementAt. */
function stmtAtIn(stmts: Statement[], pos: number): Statement | null {
  if (stmts.length === 0) return null;
  for (const s of stmts) if (pos >= s.from && pos <= s.to) return s;
  let prev: Statement | null = null;
  for (const s of stmts) { if (s.to <= pos) prev = s; else break; }
  return prev ?? stmts[0];
}

// ── Current-statement highlight (statement-at-caret is what ⌘↵ runs) ────────

const stmtMark = Decoration.mark({ class: 'cm-cur-stmt' });

function computeStmtDeco(state: EditorState): DecorationSet {
  const sel = state.selection.main;
  if (!sel.empty) return Decoration.none;
  const stmts = splitDoc(state.doc, sqlDelimiter());
  if (stmts.length <= 1) return Decoration.none; // single statement: no noise
  const s = stmtAtIn(stmts, sel.head);
  if (!s || s.to <= s.from) return Decoration.none;
  return Decoration.set([stmtMark.range(s.from, s.to)]);
}

const currentStmtField = StateField.define<DecorationSet>({
  create: computeStmtDeco,
  update(deco, tr) {
    if (tr.docChanged || tr.selection) return computeStmtDeco(tr.state);
    return deco;
  },
  provide: f => EditorView.decorations.from(f),
});

// ── live diagnostics (squiggles) ─────────────────────────────────────────────
// Implemented as plain decorations rather than @codemirror/lint: no extra
// dependency, and the messages are surfaced through the same hover tooltip that
// explains identifiers, so there is one place to look.

const setDiagnostics = StateEffect.define<Diagnostic[]>();

/**
 * Per-statement run markers: after a script runs, each statement's first line
 * gets a status chip and its wall time, so you can see WHICH statement was slow
 * (or failed) without reading the results list. Fed by the host via
 * `statementRuns`. The type + state fields live in editorRunMarkers.ts (state-
 * only, unit-tested headless); re-exported here for existing importers.
 */
export type { StatementRun } from './editorRunMarkers';
import { setStatementRuns, statementRunsField, setRunTick, runElapsedField } from './editorRunMarkers';
import type { StatementRun } from './editorRunMarkers';

class RunMarker extends GutterMarker {
  // Explicit fields, not parameter properties: `erasableSyntaxOnly` forbids
  // the shorthand (it would need emitted code).
  readonly run: StatementRun;
  /** Live elapsed ms while the statement runs — from the ticker field. */
  readonly elapsed?: number;
  constructor(run: StatementRun, elapsed?: number) { super(); this.run = run; this.elapsed = elapsed; }
  // Without eq, every tick would rebuild EVERY visible gutter element; with it,
  // only the line whose elapsed actually moved gets a fresh DOM node.
  override eq(other: RunMarker) {
    return other.run.status === this.run.status
      && other.run.ms === this.run.ms
      && other.elapsed === this.elapsed
      // The background enrichments (auto-EXPLAIN badge, digest stats) land
      // after the run's own marker — without comparing them the badge would
      // never repaint onto the existing chip.
      && other.run.hasPlan === this.run.hasPlan
      && other.run.stats?.runs === this.run.stats?.runs
      && other.run.stats?.p95Ms === this.run.stats?.p95Ms;
  }
  override toDOM() {
    const el = document.createElement('span');
    el.className = `cm-run-marker cm-run-${this.run.status}`;
    // Hover leads with WHEN the statement started — the same stamp the
    // session log prefixes its lines with, so the two read as one record.
    const stamp = this.run.startedAt != null ? `${runStamp(this.run.startedAt)} ` : '';
    const tip = [this.run.ms != null
      ? `${stamp}${this.run.status} · ${this.run.ms} ms`
      : `${stamp}${this.run.status}`];
    // The digest line answers "is this run unusual FOR THIS STATEMENT" —
    // the chip's own ms alone cannot say.
    if (this.run.stats) {
      tip.push(`ran ${this.run.stats.runs}× in history · p95 ${fmtDurationCompact(this.run.stats.p95Ms)}`);
    }
    if (this.run.hasPlan) tip.push('plan available — right-click → Open plan');
    el.title = tip.join('\n');
    // Finished: a coloured chip (green/red via the status class) plus the
    // compact wall time — the ✓/✗ glyphs spent the gutter's width saying less.
    if (this.run.status === 'ok' || this.run.status === 'error') {
      const chip = document.createElement('span');
      chip.className = 'cm-run-chip';
      el.appendChild(chip);
      if (this.run.ms != null) {
        const ms = document.createElement('span');
        ms.className = 'cm-run-ms';
        ms.textContent = fmtDurationCompact(this.run.ms);
        el.appendChild(ms);
      }
      // Auto-EXPLAIN landed for this statement: a small plan glyph beside the
      // time. Clicking it opens the plan; the right-click menu says the same.
      if (this.run.hasPlan) {
        const plan = document.createElement('span');
        plan.className = 'cm-run-plan';
        plan.textContent = '▦';
        el.appendChild(plan);
      }
      return el;
    }
    // Running: a six-dot braille spinner plus the rising wall time — the host
    // only knows the FINAL ms, so this counts up from a local clock instead.
    if (this.run.status === 'running') {
      const spin = document.createElement('span');
      spin.className = 'cm-run-spinner';
      spin.textContent = spinnerFrame(this.elapsed ?? 0);
      el.appendChild(spin);
      const ms = document.createElement('span');
      ms.className = 'cm-run-ms';
      ms.textContent = fmtDurationCompact(this.elapsed ?? 0);
      el.appendChild(ms);
      return el;
    }
    el.textContent = '·';
    return el;
  }
}

/**
 * Ticks the 'running' gutter marker at ~8 Hz. Pure decision-making lives in
 * utils/runMarkers (nextRunTick); this is only the interval + dispatch. The
 * timer exists ONLY while some statement reports 'running' — stopped the
 * moment the run ends, and on destroy, so nothing leaks past the editor.
 */
const TICK_MS = 125;

const runTickerPlugin = ViewPlugin.fromClass(class {
  // Explicit fields (erasableSyntaxOnly, same as RunMarker).
  tick: RunTick | null = null;
  timer: number | undefined;

  update(update: ViewUpdate) {
    const next = nextRunTick(this.tick, update.state.field(statementRunsField), Date.now());
    if (next === this.tick) return;           // same statement still running (or none)
    const wasRunning = this.tick !== null;
    this.tick = next;
    if (next === null) { this.stop(); return; }
    if (!wasRunning) this.start(update.view);
    // Zero the visible counter for the new statement — DEFERRED, never
    // synchronous: EditorView.dispatch inside a plugin update re-enters
    // view.update, which throws "not allowed while an update is in progress";
    // CM catches that, logs "CodeMirror plugin crashed" and DEACTIVATES the
    // plugin. That was the frozen spinner: the first run killed the ticker
    // before its interval ever started.
    const view = update.view;
    window.setTimeout(() => {
      if (this.tick === next) view.dispatch({ effects: setRunTick.of(0) });
    }, 0);
  }

  start(view: EditorView) {
    this.stop();
    this.timer = window.setInterval(() => {
      const t = this.tick;
      if (!t) { this.stop(); return; }  // belt-and-braces: never outlive the run
      // setInterval fires outside any update cycle, so this dispatch is legal.
      view.dispatch({ effects: setRunTick.of(tickElapsed(t, Date.now())) });
    }, TICK_MS);
  }

  stop() {
    if (this.timer !== undefined) { window.clearInterval(this.timer); this.timer = undefined; }
  }

  destroy() { this.stop(); }
});

/**
 * line offset → marker, computed ONCE per (document, runs) instead of splitting
 * the whole script again for every visible line — that was O(lines × doc).
 * While a statement is RUNNING there is no cache: the map embeds the tick's
 * elapsed value, so it must be rebuilt on every tick (splitDoc is itself
 * cached by Text identity, so a rebuild is cheap).
 */
const runMarkersByLine = new WeakMap<readonly StatementRun[], { doc: Text; map: Map<number, RunMarker> }>();

function markerMap(view: EditorView): Map<number, RunMarker> {
  const runs = view.state.field(statementRunsField);
  const doc = view.state.doc;
  const ticking = runs.some(r => r.status === 'running');
  if (!ticking) {
    const cached = runMarkersByLine.get(runs);
    // Reuse only when BOTH the runs and the exact doc are unchanged. `Text` is
    // immutable, so object identity is the correct key — the old length check let
    // any equal-length edit (transposing two lines, foo→bar) return markers built
    // against the previous line offsets, misattributing which statement failed.
    if (cached && cached.doc === doc) return cached.map;
  }
  const elapsed = view.state.field(runElapsedField, false) ?? 0;
  const map = new Map<number, RunMarker>();
  if (runs.length > 0) {
    const text = doc.toString();
    const stmts = splitDoc(doc, sqlDelimiter()).filter(x => x.text.trim());
    for (let i = 0; i < stmts.length && i < runs.length; i++) {
      const at = Math.min(text.length, firstCodeOffset(stmts[i]));
      map.set(doc.lineAt(at).from,
        new RunMarker(runs[i], runs[i].status === 'running' ? elapsed : undefined));
    }
  }
  if (!ticking) runMarkersByLine.set(runs, { doc, map });
  return map;
}

/**
 * Which statement (the gutter's enumeration: non-blank, split order) has its
 * marker on this line, or -1. Shared by the marker's right-click menu and the
 * plan-badge click, so the two can never disagree about which statement a
 * click belonged to.
 */
function runStatementIndexAt(view: EditorView, lineFrom: number): number {
  const doc = view.state.doc;
  const stmts = splitDoc(doc, sqlDelimiter()).filter(x => x.text.trim());
  return stmts.findIndex(s =>
    doc.lineAt(Math.min(doc.length, firstCodeOffset(s))).from === lineFrom);
}

const statementGutter = gutter({
  class: 'cm-run-gutter',
  lineMarker(view, line) {
    if (view.state.field(statementRunsField).length === 0) return null;
    return markerMap(view).get(line.from) ?? null;
  },
  initialSpacer: () => new RunMarker({ status: 'skipped' }),
  // WITHOUT THIS the gutter only repaints on doc/viewport changes: a rerun of
  // the same script dispatches effect-only transactions, and the old chips and
  // times stayed frozen on screen until the next unrelated keystroke — the
  // "markers don't reset on rerun" bug.
  lineMarkerChange: (update) =>
    update.transactions.some(tr =>
      tr.effects.some(e => e.is(setStatementRuns) || e.is(setRunTick))),
  domEventHandlers: {
    // Clicking the ▦ badge of a marker with a cached auto-EXPLAIN plan opens
    // the plan view (the host listens for dbgui:open-plan). Only the badge is
    // clickable — a click on the chip or the time keeps doing nothing.
    click(view, line, event) {
      if (!(event.target as HTMLElement).closest?.('.cm-run-plan')) return false;
      const marker = markerMap(view).get(line.from);
      if (!marker?.run.hasPlan) return false;
      const idx = runStatementIndexAt(view, line.from);
      if (idx < 0) return false;
      window.dispatchEvent(new CustomEvent('dbgui:open-plan', { detail: { idx } }));
      return true;
    },
  },
});

// ── line numbers with selection coverage ─────────────────────────────────────
// Stock lineNumbers() + highlightActiveLineGutter() light only the caret's
// line. This gutter renders the numbers itself so EVERY line a selection
// covers gets the same lit number (multi-cursor: union of ranges) — and no
// line is singled out while a selection exists ("one of many", per the owner).
// Bare caret: today's active-line style, unchanged. The coverage decision is
// pure (utils/selectionLines), cached per immutable EditorState.

class LineNoMarker extends GutterMarker {
  // Explicit fields, not parameter properties (erasableSyntaxOnly).
  readonly text: string;
  override readonly elementClass: string;
  constructor(text: string, elementClass: string) {
    super();
    this.text = text;
    this.elementClass = elementClass;
  }
  override eq(other: LineNoMarker) {
    return other.text === this.text && other.elementClass === this.elementClass;
  }
  override toDOM() {
    const el = document.createElement('div');
    el.textContent = this.text;
    return el;
  }
}

// Markers are immutable — cache one per (text, class) so a selection change
// doesn't churn every visible gutter element's DOM (eq makes CM reuse them).
// Bounded (WP-14 14.8): the cache is module-level and shared by every editor,
// so distinct line numbers accumulated forever; past the cap it simply resets
// (markers are cheap to rebuild — the cache exists for churn, not cost).
const LINE_MARKER_CACHE_CAP = 4096;
const lineNoMarkerCache = new Map<string, LineNoMarker>();
function lineNoMarker(text: string, elementClass: string): LineNoMarker {
  const key = `${elementClass}·${text}`;
  let m = lineNoMarkerCache.get(key);
  if (!m) {
    if (lineNoMarkerCache.size >= LINE_MARKER_CACHE_CAP) lineNoMarkerCache.clear();
    m = new LineNoMarker(text, elementClass);
    lineNoMarkerCache.set(key, m);
  }
  return m;
}

const litLinesCache = new WeakMap<EditorState, ReadonlySet<number>>();
function litLines(state: EditorState): ReadonlySet<number> {
  let s = litLinesCache.get(state);
  if (!s) {
    s = selectedLineNumbers(state.doc.toString(), state.selection.ranges);
    litLinesCache.set(state, s);
  }
  return s;
}

const selectionLineNumbers = gutter({
  class: 'cm-lineNumbers',
  lineMarker(view, line) {
    const n = view.state.doc.lineAt(line.from).number;
    const lit = litLines(view.state);
    if (lit.size > 0) {
      return lineNoMarker(String(n), lit.has(n) ? 'cm-selLineGutter' : '');
    }
    // Bare caret(s): the stock look — every caret line gets the active style.
    const heads = new Set<number>();
    for (const r of view.state.selection.ranges) {
      heads.add(view.state.doc.lineAt(r.head).number);
    }
    return lineNoMarker(String(n), heads.has(n) ? 'cm-activeLineGutter' : '');
  },
  // Selection moves repaint the gutter too — the default is doc/viewport only
  // (the same gap that froze the run markers).
  lineMarkerChange: (update) => update.docChanged || update.selectionSet || update.viewportChanged,
  // Four digits always fit (the App.css min-width agrees); the gutter still
  // grows past line 9999 on content.
  initialSpacer: () => lineNoMarker('8888', ''),
});

const diagMark: Record<string, Decoration> = {
  error:   Decoration.mark({ class: 'cm-diag cm-diag-error' }),
  warning: Decoration.mark({ class: 'cm-diag cm-diag-warning' }),
  info:    Decoration.mark({ class: 'cm-diag cm-diag-info' }),
};

// ── INSERT … VALUES inlay hints ──────────────────────────────────────────────
// `INSERT INTO t (a, b, c) VALUES (1, 'x', NULL)` draws a muted `a =`, `b =`,
// `c =` before each value, so a wide tuple stops being a counting exercise.
// The pairing is computed by utils/insertHints (pure, conservative: arity
// mismatch or a subquery yields NOTHING rather than a wrong hint). Always on —
// the parse is silent for every non-INSERT document, so there is no pref.

class InsertHintWidget extends WidgetType {
  // Explicit field, not a parameter property (erasableSyntaxOnly).
  readonly label: string;
  constructor(label: string) { super(); this.label = label; }
  override eq(other: InsertHintWidget) { return other.label === this.label; }
  override toDOM() {
    const el = document.createElement('span');
    el.className = 'cm-insert-hint';
    el.textContent = this.label;
    return el;
  }
}

const insertHintsPlugin = ViewPlugin.fromClass(class {
  decorations: DecorationSet;
  // The parse is cached on the immutable Text's identity: a viewport-only
  // update (scrolling a long script) re-FILTERS the same hints instead of
  // re-splitting the document.
  hintDoc: Text | null = null;
  hints: { pos: number; label: string }[] = [];

  constructor(view: EditorView) { this.decorations = this.build(view); }

  update(update: ViewUpdate) {
    if (update.docChanged || update.viewportChanged) {
      this.decorations = this.build(update.view);
    }
  }

  build(view: EditorView): DecorationSet {
    if (view.state.doc !== this.hintDoc) {
      this.hintDoc = view.state.doc;
      this.hints = insertValueHints(view.state.doc.toString(), sqlDelimiter());
    }
    if (this.hints.length === 0) return Decoration.none;
    // Decorations only for the visible ranges — the hints list itself is
    // document-wide (statement boundaries don't respect the viewport), but a
    // 10k-row paste must not materialize 50k widgets.
    const widgets = this.hints
      .filter(h => view.visibleRanges.some(r => h.pos >= r.from && h.pos <= r.to))
      .map(h => Decoration.widget({ widget: new InsertHintWidget(h.label), side: -1 }).range(h.pos));
    return Decoration.set(widgets);
  }
}, { decorations: v => v.decorations });

interface DiagState { list: Diagnostic[]; deco: DecorationSet }

const diagnosticsField = StateField.define<DiagState>({
  create: () => ({ list: [], deco: Decoration.none }),
  update(value, tr) {
    let next = value;
    for (const e of tr.effects) {
      if (!e.is(setDiagnostics)) continue;
      const len = tr.state.doc.length;
      const list = e.value.filter(d => d.from >= 0 && d.to <= len && d.to > d.from);
      next = {
        list,
        deco: Decoration.set(
          list.map(d => (diagMark[d.severity] ?? diagMark.info).range(d.from, d.to)), true),
      };
    }
    // Keep the marks aligned with edits until the next analysis lands.
    if (next === value && tr.docChanged) {
      return { list: value.list, deco: value.deco.map(tr.changes) };
    }
    return next;
  },
  provide: f => EditorView.decorations.from(f, v => v.deco),
});

// ── Semantic symbol reference highlight (utils/symbolRefs) ───────────────────
// The textual occurrence highlighter (cm-occurrence) answers "where does this
// WORD appear"; this answers "where does this SYMBOL live" — the rename
// classifier's `definite` occurrences of the identifier under the caret, with
// the definition (alias / CTE) in a distinct shade. Recomputed on a debounce
// by an update listener below (dispatching synchronously inside
// EditorView.update() is off-limits); this field only holds what it is told.
const symbolRefMark = Decoration.mark({ class: 'cm-symbol-ref' });
const symbolDefMark = Decoration.mark({ class: 'cm-symbol-def' });
const setSymbolRefs = StateEffect.define<SymbolRefs | null>();

const symbolRefsField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    if (tr.docChanged) deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (!e.is(setSymbolRefs)) continue;
      const v = e.value;
      deco = !v || v.refs.length === 0 ? Decoration.none : Decoration.set([
        ...v.refs.map(r => symbolRefMark.range(r.from, r.to)),
        ...(v.def ? [symbolDefMark.range(v.def.from, v.def.to)] : []),
      ], true);
    }
    return deco;
  },
  provide: f => EditorView.decorations.from(f),
});

// ── TODO / FIXME markers (utils/todoMarkers) ─────────────────────────────────
// Comment-only by construction (strings are not comments there); recomputed
// on doc change — one blank() pass over the buffer, cheap enough per edit.
const todoMark = Decoration.mark({ class: 'cm-todo-marker' });

function buildTodoDeco(text: string): DecorationSet {
  const marks = todoMarkers(text);
  return marks.length === 0
    ? Decoration.none
    : Decoration.set(marks.map(m => todoMark.range(m.from, m.to)), true);
}

const todoField = StateField.define<DecorationSet>({
  create: s => buildTodoDeco(s.doc.toString()),
  update(deco, tr) {
    return tr.docChanged ? buildTodoDeco(tr.state.doc.toString()) : deco;
  },
  provide: f => EditorView.decorations.from(f),
});

export interface SchemaCompletion {
  label: string;
  type: 'table' | 'view' | 'column' | 'keyword' | 'schema' | 'database';
  /** precise object kind for context filtering (CALL → procedures, USE → schemas, …) */
  kind?: 'table' | 'view' | 'procedure' | 'function' | 'trigger' | 'event' | 'schema';
  detail?: string;
  /** text inserted on pick when different from the label (e.g. schema-qualified) */
  apply?: string;
  /** column is (part of) the primary key — sorted first in column contexts */
  pk?: boolean;
  /** longer explanation shown in the completion docs pane (type, path, flags) */
  info?: string;
  /**
   * Position in the unqualified-name resolution order (the chosen default
   * database on MySQL/ClickHouse; each search_path schema in path order on
   * PostgreSQL — see utils/searchPath.ts). Absent = off-path or unknown.
   * Table contexts (FROM/JOIN/INTO/…) hint only tagged entries; anything else
   * remains reachable by spelling its schema (`analytics.orders`).
   */
  scopeRank?: number;
}

interface Props {
  engine: Engine;
  /**
   * Which MySQL-protocol server, when known — MariaDB accepts statements MySQL
   * does not and vice versa, so completion has to offer a different set.
   * Absent means plain MySQL, which is the safer default: it never suggests
   * MariaDB-only syntax to a MySQL server.
   */
  flavor?: 'mysql' | 'mariadb' | 'percona';
  initialValue?: string;
  /**
   * Serialized CodeMirror undo history to rehydrate on mount (Editor §5.2) —
   * the opaque `historyField` JSON kept by utils/editorHistoryStore. Restoring
   * is best-effort: a blob that does not match the restored text falls back to
   * an empty history rather than throwing.
   */
  initialHistory?: unknown;
  /**
   * Reports the serialized undo history (debounced) so the host can persist it,
   * so the undo stack survives closing the tab and quitting the app.
   */
  onHistoryChange?: (history: unknown) => void;
  /**
   * Show the code minimap. Defaults to the user's preference.
   *
   * A panel that embeds the editor as a *field* rather than as the workspace —
   * the long-running-query watcher types one statement into a pane a few lines
   * tall — has no use for a map of a document that fits on screen, and the
   * strip costs width the panel needs for its progress readout.
   */
  minimap?: boolean;
  schemaCompletions: SchemaCompletion[];
  /** Lazy column lookup for alias-aware completion (`alias.` → columns) */
  getColumns?: (table: string) => Promise<SchemaCompletion[]>;
  /** Lazy FK lookup — powers JOIN / ON clause suggestions */
  getFks?: (table: string) => Promise<FkEdge[]>;
  /** Tables of a schema (lazy for system schemas) — powers `db.` → tables */
  getSchemaTables?: (schema: string) => Promise<SchemaCompletion[]>;
  /** `SHOW VARIABLES` / pg_settings — powers `@@…` completion */
  getServerVariables?: () => Promise<{ name: string; value: string }[]>;
  /**
   * Run SQL. `from` is the doc offset of the statement being run (its first
   * non-whitespace char), so the host can pin the gutter's run marker to THAT
   * statement — the offset survives variable substitution, which rewrites the
   * text. Omitted for whole-buffer runs (script markers cover those).
   * `opts.noResults` (F9) runs a script for side effects/timings only —
   * the host suppresses the per-statement Result tabs.
   */
  onRun: (sql: string, from?: number, opts?: { noResults?: boolean }) => void;
  onExplain?: (sql: string) => void;
  onChange?: (sql: string) => void;
  /** Reports caret line/col + selection length + caret count for the status bar */
  onCursor?: (pos: { line: number; col: number; selLen: number; carets: number }) => void;
  insertTextRef?: React.MutableRefObject<((text: string) => void) | null>;
  /** Parent toolbar can trigger explain-at-caret through this */
  explainNowRef?: React.MutableRefObject<(() => void) | null>;
  /**
   * Parent toolbar's Run button triggers the run through this, so it takes the
   * exact same path as ⌘↵: the selection when there is one, else the statement
   * under the caret. Without it the button ran `liveSql` (the whole buffer),
   * which ignored the selection.
   */
  runNowRef?: React.MutableRefObject<(() => void) | null>;
  /** Same hand-off as runNowRef, but for the F9 no-results script run — the
   *  toolbar caret's entry must honor the selection exactly like the key. */
  runBareNowRef?: React.MutableRefObject<(() => void) | null>;
  /**
   * Identity of the buffer this editor edits, echoed in targeted `dbgui:*`
   * events (`replace-sql`, `goto-line`). An event carrying a different id is
   * ignored; an event with NO id is honored only by the active editor — an
   * untargeted broadcast must never hit every mounted buffer (that is how a
   * BufferHistory restore once replaced every open document).
   */
  tabId?: number | string;
  /**
   * Is this the workspace's focused editor? Gates app-wide per-buffer
   * commands (format, wrap toggle, the goto-line dialog) to exactly one
   * editor. Editors embedded in panels omit it and never react to those.
   */
  active?: boolean;
  placeholder?: string;
  /** Render spaces, tabs and trailing whitespace (View → Show invisibles). */
  showInvisibles?: boolean;
  /** Make the document read-only — distinct from a read-only connection. */
  readOnly?: boolean;
  /** Per-editor font zoom, in percent. 100 is the app font size. */
  zoom?: number;
  /** Zoom step from the keyboard: +10 / -10, or 0 to reset. */
  onZoom?: (delta: number) => void;
  /** Lines marked by the host, drawn in the gutter. */
  bookmarks?: number[];
  /**
   * A `kill …` / `killall` command is being typed (or is no longer): the host
   * shows the live process picker at `anchor`. Fires on every caret/doc change.
   */
  onKillContext?: (ctx: KillContext | null) => void;
  /** Replace the typed kill command with text (the picker's ⇧⏎ insert-id) */
  killReplaceRef?: React.MutableRefObject<((text: string) => void) | null>;
  /**
   * ⌘-click (or F12) on a table/view name — the host opens it. Without this the
   * only way from a name in the editor to its data was retyping it into ⌘P.
   */
  onOpenObject?: (name: string) => void;
  /** Peek an object's DDL inline (Quick Definition) without leaving the editor. */
  onPeekObject?: (name: string) => void;
  /** Open the AI assistant (generate / explain the current statement). */
  onAiAssist?: (mode: 'generate' | 'explain' | 'fix', sql?: string) => void;
  /** MySQL: capture and show the optimizer trace for the current statement. */
  onOptimizerTrace?: (sql: string) => void;
  /**
   * Everything the diagnostics need that only the host knows (loaded objects,
   * cached columns, index columns, whether a default database is selected).
   * Omit it and the editor simply reports fewer things.
   */
  diagContext?: (doc: string) => DiagContext;
  /**
   * Per-statement outcomes of the last script run (same order as the
   * statements) — drawn in the gutter.
   */
  statementRuns?: StatementRun[];
  /** Diagnostic counts for the status bar. */
  onDiagnostics?: (d: { errors: number; warnings: number; infos: number }) => void;
  /**
   * Parameter list of a stored procedure / function, for signature help:
   * `"my_proc" → "my_proc(IN a int, OUT b varchar)"`. Lazy + cached by the host.
   */
  getRoutineSignature?: (name: string) => Promise<string | null>;
  /**
   * Report lines from a rename refactoring (⇧F6): one `ok` summary plus one
   * `warn` per occurrence left for review. The host writes them to the session
   * log; without this prop the report is simply not shown.
   */
  onRenameReport?: (entries: { level: 'ok' | 'warn'; line: string }[]) => void;
}

export interface KillContext {
  trigger: KillTrigger;
  /** caret position in viewport coordinates */
  anchor: { x: number; y: number; lineBottom: number };
}

export function SqlEditor({
  engine,
  flavor,
  initialValue = '',
  initialHistory,
  onHistoryChange,
  minimap: minimapProp,
  schemaCompletions,
  getColumns,
  getFks,
  getSchemaTables,
  getServerVariables,
  onRun,
  onExplain,
  onChange,
  onCursor,
  insertTextRef,
  explainNowRef,
  runNowRef,
  runBareNowRef,
  tabId,
  active = false,
  placeholder,
  showInvisibles = false,
  readOnly = false,
  zoom = 100,
  onZoom,
  onKillContext,
  killReplaceRef,
  onOpenObject,
  onPeekObject,
  onAiAssist,
  onOptimizerTrace,
  diagContext,
  onDiagnostics,
  getRoutineSignature,
  statementRuns,
  onRenameReport,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef      = useRef<EditorView | null>(null);
  // Identity/focus read by the window-event listeners below through refs, so
  // the listeners bind once instead of re-binding on every tab switch.
  const tabIdRef = useRef(tabId); tabIdRef.current = tabId;
  const activeRef = useRef(active); activeRef.current = active;
  // Latest run/explain command bodies, set by the mount effect (which owns
  // their closure over `currentSql`). The toolbar-trigger effects below reach
  // them through these refs so an engine rebuild swaps in the fresh command
  // without those effects re-running. See runNowRef / explainNowRef wiring.
  const runCmdRef     = useRef<((v: EditorView) => void) | null>(null);
  const runBareCmdRef = useRef<((v: EditorView) => void) | null>(null);
  const explainCmdRef = useRef<((v: EditorView) => void) | null>(null);
  const completionsCompartment = useRef(new Compartment());
  const wrapCompartment        = useRef(new Compartment());
  const minimapCompartment     = useRef(new Compartment());
  const invisiblesCompartment  = useRef(new Compartment());
  const readOnlyCompartment    = useRef(new Compartment());
  const zoomCompartment        = useRef(new Compartment());
  const rulersCompartment      = useRef(new Compartment());
  const changeBarsCompartment  = useRef(new Compartment());
  const hintsCompartment       = useRef(new Compartment());
  // Live value of the Hints preference (Settings → Editor). Updated by the
  // prefs-changed listener; read inside the mount effect's closures, which
  // must not capture a stale render-time value.
  const hintsRef               = useRef(getPref(PREFS.editorHints));
  // The hint extensions as built at mount, so the prefs listener can put
  // them back without rebuilding the editor.
  const hintExtensionsRef      = useRef<Extension[]>([]);
  // The keymap is built once; reading the handler through a ref keeps it from
  // capturing the first render's copy.
  /** Run a CodeMirror command from a menu item and keep focus in the editor. */
  const runCmd = useCallback((cmd: (v: EditorView) => boolean) => {
    const view = viewRef.current;
    if (!view) return;
    cmd(view);
    view.focus();
  }, []);
  /** Drop a clip from the paste ring in at the caret, replacing any selection. */
  const insertClip = useCallback((text: string) => {
    const view = viewRef.current;
    if (!view) return;
    const sel = view.state.selection.main;
    view.dispatch({
      changes: { from: sel.from, to: sel.to, insert: text },
      selection: { anchor: sel.from + text.length },
      userEvent: 'input.paste',
    });
    view.focus();
  }, []);
  const onZoomRef = useRef(onZoom);
  useEffect(() => { onZoomRef.current = onZoom; }, [onZoom]);
  // The prop wins when given; otherwise the user's preference decides, which
  // is what every editor in the workspace uses.
  const showMinimap = minimapProp ?? getPref(PREFS.editorMinimap);
  // Off by default (PREFS.editorChangeBars): a scratch buffer's baseline is
  // its initial value, so with the bars always on every typed line glows.
  const showChangeBars = getPref(PREFS.editorChangeBars);
  // The baseline never moves mid-session; a ref lets the prefs listener read
  // it without taking a dependency on the prop.
  const changeBarsBaselineRef = useRef(initialValue);
  // Read inside the prefs listener, which must not re-subscribe per render.
  const minimapPropRef = useRef(minimapProp);
  useEffect(() => { minimapPropRef.current = minimapProp; }, [minimapProp]);

  const [wrap, setWrap] = useState(() => localStorage.getItem(WRAP_KEY) === '1');
  /**
   * Split editor: a second pane over the SAME document, so both ends of a long
   * migration are visible at once. `split` toggles it; `splitRatio` is the
   * fraction of the width the primary (left) pane keeps, moved by the divider.
   */
  const [split, setSplit] = useState(false);
  const [splitRatio, setSplitRatio] = useState(0.5);
  const secondaryRef = useRef<HTMLDivElement>(null);
  const shellRef     = useRef<HTMLDivElement>(null);
  const splitViewRef = useRef<EditorView | null>(null);
  // Own wrap/zoom compartments so the second pane follows those prefs live,
  // exactly as the primary does, without being rebuilt on every change.
  const wrapCompartment2 = useRef(new Compartment());
  const zoomCompartment2 = useRef(new Compartment());
  const hintsCompartment2 = useRef(new Compartment());
  // Tears down an in-flight divider drag; also called on unmount so a component
  // that disappears mid-drag doesn't leak the window pointer listeners.
  const dragCleanupRef = useRef<(() => void) | null>(null);
  useEffect(() => () => { dragCleanupRef.current?.(); }, []);
  /** Drag the divider → new split ratio, clamped so neither pane vanishes. */
  const startDividerDrag = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    const shell = shellRef.current;
    if (!shell) return;
    const rect = shell.getBoundingClientRect();
    const onMove = (ev: PointerEvent) => {
      const r = (ev.clientX - rect.left) / rect.width;
      setSplitRatio(Math.min(0.85, Math.max(0.15, r)));
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      dragCleanupRef.current = null;
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    dragCleanupRef.current = onUp;
  }, []);
  /**
   * Signature help: which call the caret is inside, and the signature to show.
   * Rendered as a small bar under the editor toolbar rather than a floating
   * popup, so it never covers the code you are writing.
   */
  const [signature, setSignature] = useState<{ text: string; args: string[]; active: number } | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  /**
   * The expand-selection trail: each expand pushes the range it grew FROM, so
   * shrink just pops (utils/selectionExpand computes the climb; this retraces
   * it). Cleared on any edit — a stale range must never be restored over text
   * that changed underneath it.
   */
  const expandStackRef = useRef<{ from: number; to: number }[]>([]);
  /**
   * Right-click on a gutter run marker opens its own menu (re-run / explain /
   * copy), not the editor's. Holds the marker's run plus ITS statement's text
   * and doc offset — resolved at click time against the gutter's own
   * enumeration (non-blank statements in split order), so `from` re-pins the
   * marker to the same statement when the host re-runs it.
   */
  const [runMenu, setRunMenu] = useState<{
    x: number; y: number; sql: string; from: number; run: StatementRun;
    /** The statement's index in the gutter enumeration — the host's autoPlans
     *  map is keyed by it, so "Open plan" passes it through. */
    idx: number;
  } | null>(null);
  const [hasSelection, setHasSelection] = useState(false);
  /**
   * Paste-from-history picker: recent clips and where to anchor the list.
   * Null when closed. The ring lives in utils/clipboardRing; this only holds
   * the snapshot shown while the picker is open.
   */
  const [paste, setPaste] = useState<{ x: number; y: number; items: string[] } | null>(null);
  /**
   * "Find Action" palette (⌘⇧P). Open state only — the searchable command list
   * is built from the registry (utils/commandRegistry) against the run map in
   * `editorCommandsRef`, so every keymap command is discoverable by name.
   */
  const [actionsOpen, setActionsOpen] = useState(false);
  /**
   * Macro record & playback (§5.9). One recorder per editor instance, held in a
   * ref so the "last macro" persists for the session without re-rendering on
   * every captured command. `recording` mirrors its state only for the UI (the
   * toolbar dot and the palette label).
   */
  const macroRef = useRef(new MacroRecorder());
  const [recording, setRecording] = useState(false);

  // The mount effect below runs once per engine — route callbacks through
  // refs so the editor always calls the LATEST props, never stale closures.
  const onRunRef      = useRef(onRun);
  const onExplainRef  = useRef(onExplain);
  const onChangeRef   = useRef(onChange);
  const onCursorRef   = useRef(onCursor);
  const onHistoryChangeRef = useRef(onHistoryChange);
  // Read at mount time; a ref so a value that arrives just before the (lazy)
  // editor mounts is still seen. Never updated after mount — rehydration is a
  // one-time event.
  const initialHistoryRef = useRef(initialHistory);
  initialHistoryRef.current = initialHistory;
  const getColumnsRef = useRef(getColumns);
  const getFksRef     = useRef(getFks);
  const getSchemaTablesRef = useRef(getSchemaTables);
  const getServerVariablesRef = useRef(getServerVariables);
  const onKillContextRef = useRef(onKillContext);
  const onOpenObjectRef = useRef(onOpenObject);
  const onPeekObjectRef = useRef(onPeekObject);
  const onAiAssistRef = useRef(onAiAssist);
  const onOptimizerTraceRef = useRef(onOptimizerTrace);
  const diagContextRef = useRef(diagContext);
  const onDiagnosticsRef = useRef(onDiagnostics);
  const getRoutineSignatureRef = useRef(getRoutineSignature);
  const onRenameReportRef = useRef(onRenameReport);
  const schemaCompletionsRef = useRef(schemaCompletions);
  // The mount effect closes over these once, so route them through refs.
  const hoverCtxForRef = useRef<(doc: string) => HoverContext>(() => ({
    aliases: new Map(), objects: new Map(), functions: new Set(), keywords: new Set(),
  }));
  const describeTargetRef = useRef<(t: HoverTarget) => Promise<HTMLElement | null>>(
    async () => null);
  const diagTimerRef = useRef(0);
  /** Debounce for the semantic symbol-reference highlight (utils/symbolRefs). */
  const symTimerRef = useRef(0);
  /** Debounce for serializing the undo history out to the host (Editor §5.2). */
  const historyTimerRef = useRef(0);
  /** Editor commands the host can invoke (context menu, palette). */
  const editorCommandsRef = useRef<Record<string, () => void>>({});

  // ── Macro record & playback (§5.9) ──────────────────────────────────────────
  // Dispatch a registry command by id AND (when recording) append the id to the
  // macro. This is the choke point for menu/palette invocations; keystrokes are
  // captured separately by a record-only keymap that shadows the real bindings.
  const dispatchCommand = useCallback((id: string) => {
    macroRef.current.record(id);
    editorCommandsRef.current[id]?.();
  }, []);
  /** Start/stop recording. Bound to a key and exposed as a palette command. */
  const toggleMacroRecord = useCallback(() => {
    setRecording(macroRef.current.toggle());
  }, []);
  /**
   * Replay the last recorded macro by re-dispatching each id in order through
   * the same id→run map. Guarded so it can't run while recording (it would
   * record its own replayed commands) and no-ops when there is no macro.
   */
  const playMacro = useCallback(() => {
    const rec = macroRef.current;
    if (rec.isRecording || !rec.hasMacro()) return;
    for (const id of rec.lastMacro()) editorCommandsRef.current[id]?.();
    viewRef.current?.focus();
  }, []);
  useEffect(() => {
    onRunRef.current      = onRun;
    onExplainRef.current  = onExplain;
    onChangeRef.current   = onChange;
    onCursorRef.current   = onCursor;
    onHistoryChangeRef.current = onHistoryChange;
    getColumnsRef.current = getColumns;
    getFksRef.current     = getFks;
    getSchemaTablesRef.current = getSchemaTables;
    getServerVariablesRef.current = getServerVariables;
    onKillContextRef.current = onKillContext;
    onOpenObjectRef.current = onOpenObject;
    onPeekObjectRef.current = onPeekObject;
    onAiAssistRef.current = onAiAssist;
    onOptimizerTraceRef.current = onOptimizerTrace;
    diagContextRef.current = diagContext;
    onDiagnosticsRef.current = onDiagnostics;
    getRoutineSignatureRef.current = getRoutineSignature;
    onRenameReportRef.current = onRenameReport;
    schemaCompletionsRef.current = schemaCompletions;
    hoverCtxForRef.current = hoverCtxFor;
    describeTargetRef.current = describeTarget;
  });

  // Context-routed completion source (utils/sqlComplete.ts): clause-aware
  // objects, FK-suggested JOIN/ON clauses, CTE columns, keywords, templates.
  const makeCompletionSource = useCallback((completions: SchemaCompletion[]) => {
    // Redis is not SQL. Routing it through the SQL source offered SELECT /
    // FROM / JOIN on a Redis connection and never a single Redis command.
    if (engine === 'redis') {
      return buildRedisCompletionSource({
        // Key names come from the same lazy provider the browser uses; the
        // schema-completion list holds them for a Redis session.
        getKeys: async (prefix) => completions
          .filter(c => c.kind === 'table' || c.kind === 'view')
          .map(c => c.label)
          .filter(l => !prefix || l.toLowerCase().startsWith(prefix.toLowerCase()))
          .slice(0, 200),
      });
    }
    return buildCompletionSource(engine, completions, {
      getColumns: t => getColumnsRef.current?.(t) ?? Promise.resolve([]),
      getFks: t => getFksRef.current?.(t) ?? Promise.resolve([]),
      getSchemaTables: s => getSchemaTablesRef.current?.(s) ?? Promise.resolve([]),
      getServerVariables: () => getServerVariablesRef.current?.() ?? Promise.resolve([]),
      getTemplates: () => SqlTemplatesStore.list(),
    }, {
      upperCaseKeywords: getPref(PREFS.editorKeywordCase) === 'upper',
      flavor,
      usageBoost,
      // After a statement-ending `;` the completion source stays silent, so
      // Enter inserts a newline instead of accepting the first hint.
      delimiter: sqlDelimiter(),
    });
  }, [engine, flavor]);


  /**
   * Hover context: aliases parsed from the document + everything the schema
   * sweep knows + the function/keyword catalogs. Rebuilt per hover (cheap) so
   * it always reflects the text you are actually looking at.
   */
  // The object map and the catalogs do not change per hover — only the aliases
  // do — so build the expensive part once per schema/engine.
  const hoverBase = useMemo(() => {
    const objects = new Map<string, string>();
    for (const c of schemaCompletions) {
      if (c.kind === 'schema') { objects.set(c.label.toLowerCase(), c.label); continue; }
      const qualified = c.apply && c.apply.includes('.') ? c.apply : c.label;
      objects.set(c.label.toLowerCase(), qualified);
      if (qualified.includes('.')) objects.set(qualified.toLowerCase().replace(/[`"]/g, ''), qualified);
    }
    const cat = keywordCatalog(engine);
    return {
      objects,
      functions: new Set(cat.filter(k => k.type === 'function').map(k => k.label.toUpperCase())),
      keywords: new Set(cat.filter(k => k.type === 'keyword')
        .flatMap(k => k.label.toLowerCase().split(/[^a-z_]+/)).filter(Boolean)),
    };
  }, [engine, schemaCompletions]);

  const hoverCtxFor = useCallback(
    (doc: string): HoverContext => ({ ...hoverBase, aliases: findAliases(doc) }),
    [hoverBase]);

  /** Build the tooltip DOM for a resolved token (async for column lookups). */
  const describeTarget = useCallback(async (t: HoverTarget): Promise<HTMLElement | null> => {
    const dom = document.createElement('div');
    dom.className = 'cm-sql-tip';
    const line = (cls: string, text: string) => {
      const el = document.createElement('div');
      el.className = cls;
      el.textContent = text;
      dom.appendChild(el);
      return el;
    };

    if (t.kind === 'keyword') return null;

    if (t.kind === 'function') {
      const item = keywordCatalog(engine).find(k =>
        k.type === 'function' && k.label.toUpperCase() === t.name);
      if (!item) return null;
      line('cm-tip-head', item.label);
      if (item.detail) line('cm-tip-detail', item.detail);
      return dom;
    }

    if (t.kind === 'variable') {
      line('cm-tip-head', t.name ?? '');
      line('cm-tip-detail', t.name?.startsWith('@@')
        ? 'server / session variable'
        : t.name?.startsWith(':') ? 'TxUI query variable — prompted before the run'
        : 'user-defined session variable');
      return dom;
    }

    if (t.kind === 'table' && t.table) {
      line('cm-tip-head', t.table);
      const cols = await getColumnsRef.current?.(t.table).catch(() => []) ?? [];
      if (cols.length) {
        line('cm-tip-detail', `${cols.length} column${cols.length === 1 ? '' : 's'}`);
        const pk = cols.filter(c => c.pk).map(c => c.label);
        if (pk.length) line('cm-tip-detail', `PK: ${pk.join(', ')}`);
        const pre = document.createElement('div');
        pre.className = 'cm-tip-cols';
        pre.textContent = cols.slice(0, 14).map(c => `${c.label} ${c.detail ?? ''}`.trim()).join('\n')
          + (cols.length > 14 ? `\n… ${cols.length - 14} more` : '');
        dom.appendChild(pre);
      }
      const fks = await getFksRef.current?.(t.table).catch(() => []) ?? [];
      for (const fk of fks.slice(0, 6)) {
        line('cm-tip-fk', `${fk.fromTable}(${fk.fromCols.join(', ')}) → ${fk.toTable}(${fk.toCols.join(', ')})`);
      }
      line('cm-tip-hint', `${shortcuts().clickOpen} / F12 to browse it`);
      return dom;
    }

    if (t.kind === 'column' && t.column) {
      // A qualified column knows its table; a bare one is searched in the
      // tables of the statement in scope.
      const doc = viewRef.current?.state.doc.toString() ?? '';
      const tables = t.table ? [t.table] : [...new Set(findAliases(doc).values())];
      for (const table of tables.slice(0, 8)) {
        const cols = await getColumnsRef.current?.(table).catch(() => []) ?? [];
        const hit = cols.find(c => c.label.toLowerCase() === t.column!.toLowerCase());
        if (!hit) continue;
        line('cm-tip-head', `${table}.${hit.label}`);
        line('cm-tip-detail', [hit.detail, hit.pk ? 'PRIMARY KEY' : ''].filter(Boolean).join(' · '));
        const fks = await getFksRef.current?.(table).catch(() => []) ?? [];
        for (const fk of fks) {
          if (fk.fromCols.some(c => c.toLowerCase() === hit.label.toLowerCase())) {
            line('cm-tip-fk', `FK → ${fk.toTable}(${fk.toCols.join(', ')})`);
          }
        }
        return dom;
      }
      return null;
    }
    return null;
  }, [engine]);

  // Initial editor setup
  useEffect(() => {
    if (!containerRef.current) return;

    // Selection if any, else the statement under the caret.
    const currentSql = (view: EditorView): string => {
      const content = view.state.doc.toString();
      // Multi-cursor: run every non-empty range, in document order (CM keeps
      // ranges sorted), joined as a script — not just the primary range.
      const nonEmpty = view.state.selection.ranges.filter(r => !r.empty);
      if (nonEmpty.length > 1) {
        return nonEmpty
          .map(r => content.slice(r.from, r.to).trim().replace(/;\s*$/, ''))
          .filter(Boolean)
          .join(';\n');
      }
      const selection = view.state.selection.main;
      return (selection.empty
        ? (statementAtCaret(content, selection.head, sqlDelimiter())?.text ?? content)
        : content.slice(selection.from, selection.to)).trim();
    };

    // The doc offset of what currentSql would run — the statement's first char
    // (or the selection's start), so the gutter marker lands on the right line.
    // Multi-cursor joins ranges into a NEW text whose offsets are meaningless;
    // undefined there (the script path's per-statement markers take over).
    const currentSqlFrom = (view: EditorView): number | undefined => {
      const content = view.state.doc.toString();
      const nonEmpty = view.state.selection.ranges.filter(r => !r.empty);
      if (nonEmpty.length > 1) return undefined;
      const selection = view.state.selection.main;
      if (!selection.empty) return selection.from;
      return statementAtCaret(content, selection.head, sqlDelimiter())?.from;
    };

    // ⌘↵: run statement at caret / selection
    // Feed the ran statement's identifiers into the usage tally so completion
    // ranking learns this session's working set (utils/usageRank).
    const recordUsage = (sql: string) => {
      const known = new Set<string>();
      for (const c of schemaCompletionsRef.current) {
        known.add(c.label.toLowerCase());
        if (c.apply) known.add(String(c.apply).replace(/[`"]/g, '').split('.').pop()!.toLowerCase());
      }
      bumpUsageFromSql(sql, known);
    };
    const runCommand = (view: EditorView) => {
      const sql = currentSql(view);
      recordUsage(sql);
      onRunRef.current(sql, currentSqlFrom(view));
      return true;
    };

    // ⌘⇧↵: always the whole script
    const runAllCommand = (view: EditorView) => {
      onRunRef.current(view.state.doc.toString().trim());
      return true;
    };

    // F9: the whole script (or the selection, when one is active) run for
    // side effects and timings — statements execute exactly as in a normal
    // script run, but no per-statement Result tabs open.
    const runAllNoResultsCommand = (view: EditorView) => {
      const sel = view.state.selection.main;
      const sql = (sel.empty
        ? view.state.doc.toString()
        : view.state.doc.sliceString(sel.from, sel.to)).trim();
      if (!sql) return true;
      recordUsage(sql);
      onRunRef.current(sql, sel.empty ? undefined : sel.from, { noResults: true });
      return true;
    };

    // ⌘E: explain statement at caret / selection
    const explainCommand = (view: EditorView) => {
      onExplainRef.current?.(currentSql(view));
      return true;
    };

    /**
     * ⌘⌥F / ⌘H: open the search panel straight into the REPLACE field —
     * the stock openSearchPanel always lands in the search field.
     */
    const openReplacePanel = (view: EditorView) => {
      openSearchPanel(view);
      requestAnimationFrame(() => {
        const f = view.dom.querySelector<HTMLInputElement>('.cm-panel.cm-search input[name=replace]');
        if (f) { f.focus(); f.select(); }
      });
      return true;
    };

    /**
     * ⌘⇧8 — expand the `*` (or `alias.*`) at/nearest the caret into the real
     * column list, qualified with the alias when there is one. The single most
     * asked-for "typing" feature in any SQL IDE, and the schema is right here.
     */
    const expandStarCommand = (view: EditorView) => {
      const doc = view.state.doc.toString();
      const caret = view.state.selection.main.head;
      const stmt = statementAt(doc, caret, sqlDelimiter());
      const region = stmt ?? { from: 0, to: doc.length, text: doc };
      // The nearest SELECT-LIST star (`*` or `alias.*`) inside the statement.
      // Matching a bare `*` would happily rewrite the multiplication in
      // `SELECT price * qty`, so the star must follow SELECT, a comma or a dot —
      // and the search runs on the BLANKED text so stars inside strings and
      // comments are invisible.
      const blanked = blank(region.text);
      let best: { from: number; to: number; qualifier?: string } | null = null;
      const starRe = /(?:\bselect\s+(?:distinct\s+)?|,\s*)((?:([A-Za-z_][\w$]*)\s*\.\s*)?\*)/gi;
      for (const m of blanked.matchAll(starRe)) {
        const starOffset = m.index! + m[0].length - m[1].length;
        const from = region.from + starOffset;
        const to = from + m[1].length;
        if (best && Math.abs(caret - from) >= Math.abs(caret - best.from)) continue;
        best = { from, to, qualifier: m[2] };
      }
      if (!best) return false;

      const aliases = findAliases(region.text);
      const targets = best.qualifier
        ? [aliases.get(best.qualifier.toLowerCase()) ?? best.qualifier]
        : [...new Set(aliases.values())];
      if (targets.length === 0) return false;

      (async () => {
        const parts: string[] = [];
        for (const table of targets) {
          const cols = await getColumnsRef.current?.(table).catch(() => []) ?? [];
          if (cols.length === 0) continue;
          const ref = best!.qualifier
            ?? [...aliases.entries()].find(([, t]) => t === table)?.[0];
          const prefix = targets.length > 1 || best!.qualifier ? `${ref}.` : '';
          parts.push(...cols.map(c => `${prefix}${c.apply ?? c.label}`));
        }
        if (parts.length === 0) return;
        const v = viewRef.current;
        if (!v) return;
        v.dispatch({
          changes: { from: best!.from, to: best!.to, insert: parts.join(', ') },
          selection: { anchor: best!.from + parts.join(', ').length },
        });
        v.focus();
      })();
      return true;
    };

    /**
     * ⇧F6 — rename refactoring (utils/renameRefactor): the table, column, alias
     * or CTE under the caret, across the whole buffer (alias/CTE names stay
     * statement-scoped). The correctness gate is the point: only occurrences
     * that PROVABLY name the symbol are rewritten; plausible-but-unprovable
     * ones (ambiguous bare columns, unresolved qualifiers, strings/comments)
     * are reported to the session log, never touched. No-op (returns false)
     * when the caret is not on a renameable symbol.
     */
    const renameSymbolCommand = (view: EditorView) => {
      const doc = view.state.doc.toString();
      const caret = view.state.selection.main.head;
      const target = renameTargetAt(doc, caret, engine, sqlDelimiter());
      if (!target) return false;

      // The prompt is in-DOM and therefore async (window.prompt does not exist
      // on WKWebView and returns null on WebKitGTK). Everything that can fail
      // *before* asking is checked above, so from here the key is consumed and
      // the rename — or the user's cancel — lands in the promise.
      void (async () => {
        // Column classification needs the in-scope tables' columns; they come
        // from the host's lazy, cached provider (the same one completion uses).
        const tables: RenameSchemaTable[] = [];
        for (const t of target.tablesNeeded) {
          const cols = await getColumnsRef.current?.(t).catch(() => []) ?? [];
          if (cols.length > 0) tables.push({ name: t, columns: cols.map(c => c.label) });
        }
        const plan = planRename(doc, target, { tables }, engine, sqlDelimiter());
        const what = `${target.kind === 'cte' ? 'CTE' : target.kind} ${target.name}`;
        const hint = plan.definite > 0
          ? `${plan.definite} occurrence${plan.definite === 1 ? '' : 's'} will be rewritten`
            + (plan.review > 0
              ? `; ${plan.review} more need${plan.review === 1 ? 's' : ''} review and will be left untouched`
              : '')
          : 'nothing provably names this symbol — no text will be rewritten';
        const newName = await promptDialog(
          `Rename ${what} to:\n${hint}.\nThis buffer only — the database object is NOT altered (no ALTER TABLE is run), and no other buffer or file is touched.`,
          target.name, { title: 'Rename symbol' });
        if (!newName || newName === target.name) return;

        const result = applyRename(doc, plan, newName, engine);
        if (!result) return; // unusable new name (empty / dotted / multiline)

        view.dispatch({
          changes: { from: 0, to: doc.length, insert: result.text },
          selection: { anchor: Math.min(result.text.length, caret) },
        });
        view.focus();

        const entries: { level: 'ok' | 'warn'; line: string }[] = [{
          level: 'ok',
          line: `Renamed ${what} → ${newName.trim()}: ${result.rewritten} occurrence${result.rewritten === 1 ? '' : 's'} rewritten in this buffer (the database object itself is unchanged — no ALTER TABLE was run)`,
        }];
        const SHOWN = 20;
        for (const r of result.reviews.slice(0, SHOWN)) {
          entries.push({ level: 'warn', line: `rename: review line ${r.line}: ${r.lineText} — ${r.reason}` });
        }
        if (result.reviews.length > SHOWN) {
          entries.push({ level: 'warn', line: `rename: …and ${result.reviews.length - SHOWN} more occurrence(s) left for review` });
        }
        onRenameReportRef.current?.(entries);
      })();
      return true;
    };

    /** ⌘⌥↑ / ⌘⌥↓ — jump to the previous / next statement (D3). */
    const gotoStatement = (dir: 1 | -1) => (view: EditorView) => {
      const doc = view.state.doc.toString();
      const caret = view.state.selection.main.head;
      const stmts = splitStatements(doc, sqlDelimiter()).filter(x => x.text.trim());
      if (stmts.length === 0) return false;
      const idx = stmts.findIndex(x => caret >= x.from && caret <= x.to);
      const next = stmts[Math.min(stmts.length - 1, Math.max(0, (idx < 0 ? 0 : idx) + dir))];
      if (!next) return false;
      const at = Math.min(next.to, firstCodeOffset(next));
      view.dispatch({ selection: { anchor: at }, scrollIntoView: true });
      return true;
    };

    // ⌘⌥→ / ⌘⌥← — semantic expand / shrink selection (utils/selectionExpand).
    // NOT ⌘⌥W: the app's window-level close-tab listener fires on Mod+'w'
    // without excluding Alt, so on Windows/Linux that chord would close the
    // tab. The Mod-Alt-arrow family (statement jumping is ⌘⌥↑/↓) was free on
    // every platform — checked against the editor keymap, App.tsx's global
    // keys and CM's default/search/fold keymaps. Main range only: multi-cursor
    // expansion collapses to the primary selection.
    const expandSelectionCommand = (view: EditorView) => {
      const sel = view.state.selection.main;
      const next = expandRange(view.state.doc.toString(), sel.from, sel.to, sqlDelimiter());
      if (!next) return false;
      expandStackRef.current.push({ from: sel.from, to: sel.to });
      view.dispatch({
        selection: EditorSelection.range(next.from, next.to),
        scrollIntoView: true,
      });
      return true;
    };
    const shrinkSelectionCommand = (view: EditorView) => {
      const sel = view.state.selection.main;
      const stack = expandStackRef.current;
      // Pop until a range that nests strictly inside the current selection
      // turns up; anything else is stale (the caret was moved by other means
      // since) and gets dropped rather than teleporting the selection back.
      while (stack.length > 0) {
        const prev = stack.pop()!;
        if (prev.from >= sel.from && prev.to <= sel.to && (prev.from > sel.from || prev.to < sel.to)) {
          view.dispatch({
            selection: EditorSelection.range(prev.from, prev.to),
            scrollIntoView: true,
          });
          return true;
        }
      }
      return false;
    };

    /**
     * ⌘⌥; — Complete Current Statement (utils/completeStatement): close any
     * quote/paren/comment the statement left open, make sure it ends with the
     * delimiter, and land on a fresh line below. The chord was verified free
     * against this keymap, CM's bundled keymaps and App.tsx's global handlers
     * (the audit trail is on the commandRegistry entry).
     */
    const completeStatementCommand = (view: EditorView) => {
      const sel = view.state.selection.main;
      if (!sel.empty) return false; // completing with a selection would move text under it
      const doc = view.state.doc.toString();
      const res = completeStatement(doc, sel.head, sqlDelimiter());
      if (res.edits.length === 0 && res.caret === sel.head) return false; // nothing to complete
      view.dispatch({
        changes: res.edits,
        selection: { anchor: res.caret },
        scrollIntoView: true,
      });
      view.focus();
      return true;
    };

    /** Jump to the next / previous TODO / FIXME comment (utils/todoMarkers). */
    const jumpTodoCommand = (dir: 1 | -1) => (view: EditorView) => {
      const marks = todoMarkers(view.state.doc.toString());
      const target = jumpTarget(marks, view.state.selection.main.head, dir);
      if (!target) return false;
      view.dispatch({ selection: { anchor: target.from }, scrollIntoView: true });
      view.focus();
      return true;
    };

    /** ⌘⌥↵ — run everything from the top of the buffer up to the caret (D3). */
    const runToCursorCommand = (view: EditorView) => {
      const doc = view.state.doc.toString();
      const caret = view.state.selection.main.head;
      const stmts = splitStatements(doc, sqlDelimiter()).filter(x => x.text.trim() && x.from < caret);
      if (stmts.length === 0) return false;
      // Each statement's text already carries its own terminator (whatever the
      // active delimiter is), so join the raw texts — don't strip and re-inject
      // `;`, which corrupted scripts under a custom / MySQL DELIMITER.
      const upto = stmts.map(x => x.text).join('\n');
      // These ARE the buffer's first statements, so the offset pins the marker
      // correctly whether this ends up a script run or a single-statement one.
      onRunRef.current(upto, stmts[0].from);
      return true;
    };

    // F12 / ⌘-click: open the table or view under the cursor
    const goToObjectCommand = (view: EditorView) => {
      const doc = view.state.doc.toString();
      const target = resolveHover(doc, view.state.selection.main.head,
        hoverCtxForRef.current(doc), engine);
      if (target?.kind !== 'table' || !target.table || !onOpenObjectRef.current) return false;
      onOpenObjectRef.current(target.table);
      return true;
    };
    // Quick Definition: peek the object's DDL inline, without navigating away.
    const peekObjectCommand = (view: EditorView) => {
      const doc = view.state.doc.toString();
      const target = resolveHover(doc, view.state.selection.main.head,
        hoverCtxForRef.current(doc), engine);
      if (target?.kind !== 'table' || !target.table || !onPeekObjectRef.current) return false;
      onPeekObjectRef.current(target.table);
      return true;
    };
    // Remember every non-empty selection range as a paste-ring clip.
    const recordClips = (view: EditorView) => {
      for (const r of view.state.selection.ranges) {
        if (!r.empty) pushClip(view.state.sliceDoc(r.from, r.to));
      }
    };
    // ⌘⇧V — open the paste-history picker at the caret. No clips yet? Fall
    // through (return false) so the key does nothing rather than a blank menu.
    const pasteHistoryCommand = (view: EditorView) => {
      const items = clips();
      if (items.length === 0) return false;
      const c = view.coordsAtPos(view.state.selection.main.head);
      setPaste({ x: c?.left ?? 0, y: c?.bottom ?? 0, items });
      return true;
    };

    // ⌘. — apply the fix at the caret when there is exactly one. With several
    // it does nothing rather than choosing (the hover offers them by name).
    // Named so the keymap and the Find Action palette drive the same path.
    const applyQuickFix = (view: EditorView) => {
      const pos = view.state.selection.main.head;
      const doc = view.state.doc.toString();
      const here = view.state.field(diagnosticsField).list
        .filter(d => pos >= d.from && pos <= d.to);
      const fixes = here.flatMap(d => fixesFor(d, doc));
      if (fixes.length !== 1) return false;
      const fix = fixes[0];
      view.dispatch({
        changes: fix.edits.map(e => ({ from: e.from, to: e.to, insert: e.insert })),
        ...(fix.caret !== undefined ? { selection: { anchor: fix.caret } } : {}),
      });
      return true;
    };

    // Publish the current command bodies for the toolbar-trigger effects. NOT
    // wired onto runNowRef/explainNowRef here: those props change on every tab
    // activate/deactivate, and this effect only runs on mount ([engine]), so
    // wiring them here would leave a stale editor owning a shared trigger ref
    // (a Run button firing the wrong tab). The prop-keyed effects below own the
    // hand-off; they call through these refs so an engine rebuild is picked up.
    runCmdRef.current     = runCommand;
    runBareCmdRef.current = runAllNoResultsCommand;
    explainCmdRef.current = explainCommand;
    // The context menu, the ⌘⇧P Find Action palette and (later, §5.9) macros
    // all dispatch through this one id→run map, keyed by the stable ids in
    // utils/commandRegistry. `withView` runs a plain command that needs the
    // view; `cm` adapts a CodeMirror command and keeps focus in the editor.
    const withView = (fn: (v: EditorView) => unknown) => () => {
      if (viewRef.current) fn(viewRef.current);
    };
    const cm = (fn: (v: EditorView) => boolean) => () => runCmd(fn);
    // Toggle/step a bookmark: same custom events the keymap dispatches.
    const bookmark = (event: string) => () => {
      const v = viewRef.current;
      if (!v) return;
      const line = v.state.doc.lineAt(v.state.selection.main.head).number;
      window.dispatchEvent(new CustomEvent(event, { detail: { line } }));
    };
    editorCommandsRef.current = {
      // Run
      'editor.run':           withView(runCommand),
      'editor.runAll':        withView(runAllCommand),
      'editor.runToCursor':   withView(runToCursorCommand),
      'editor.runAllNoResults': withView(runAllNoResultsCommand),
      // Navigate
      'editor.goToObject':    withView(goToObjectCommand),
      'editor.peekObject':    withView(peekObjectCommand),
      // The F12 companion: flash the object under the caret in the sidebar's
      // schema tree instead of opening it. Palette-only (no chord) — the
      // registry carries the entry, this is its body.
      'editor.revealObject':  withView((v: EditorView) => {
        const doc = v.state.doc.toString();
        const target = resolveHover(doc, v.state.selection.main.head,
          hoverCtxForRef.current(doc), engine);
        if (target?.kind !== 'table' || !target.table) return;
        window.dispatchEvent(new CustomEvent('dbgui:reveal-object', { detail: { name: target.table } }));
      }),
      // AI
      'editor.aiGenerate':    () => onAiAssistRef.current?.('generate'),
      'editor.aiExplain':     () => { const v = viewRef.current; if (v) onAiAssistRef.current?.('explain', currentSql(v)); },
      'editor.optimizerTrace': () => { const v = viewRef.current; if (v) onOptimizerTraceRef.current?.(currentSql(v)); },
      'editor.prevStatement': withView(gotoStatement(-1)),
      'editor.nextStatement': withView(gotoStatement(1)),
      'editor.gotoLine':      cm(gotoLine),
      'editor.matchingBracket': cm(cursorMatchingBracket),
      'editor.nextTodo':      withView(jumpTodoCommand(1)),
      'editor.prevTodo':      withView(jumpTodoCommand(-1)),
      // Search
      'editor.replace':       withView(openReplacePanel),
      // Selection
      'editor.selectNextOccurrence': cm(selectNextOccurrence),
      'editor.selectAllOccurrences': cm(selectAllOccurrences),
      'editor.splitSelectionIntoLines': cm(splitSelectionIntoLines),
      'editor.expandSelection': cm(expandSelectionCommand),
      'editor.shrinkSelection': cm(shrinkSelectionCommand),
      // Refactor
      'editor.wrapInSubquery': withView(wrapInSubquery),
      'editor.extractCte': withView(extractCte),
      // Edit
      'editor.toggleComment': cm(toggleComment),
      'editor.indentMore':    cm(indentMore),
      'editor.indentLess':    cm(indentLess),
      'editor.lowerCase':     cm(convertCaseCmd('lower')),
      'editor.upperCase':     cm(convertCaseCmd('upper')),
      'editor.pasteHistory':  withView(pasteHistoryCommand),
      'editor.quickFix':      withView(applyQuickFix),
      'editor.completeStatement': withView(completeStatementCommand),
      // Lines
      'editor.moveLineUp':    cm(moveLineUp),
      'editor.moveLineDown':  cm(moveLineDown),
      'editor.copyLineUp':    cm(copyLineUp),
      'editor.copyLineDown':  cm(copyLineDown),
      'editor.deleteLine':    cm(deleteLine),
      'editor.joinLines':     cm(joinLinesCmd),
      'editor.sortLinesAsc':  cm(sortLinesCmd('asc')),
      'editor.sortLinesDesc': cm(sortLinesCmd('desc')),
      'editor.sortLinesNumeric': cm(sortLinesCmd('numeric-asc')),
      'editor.dedupeLines':   cm(dedupeLinesCmd()),
      'editor.keepDuplicates': cm(keepDuplicatesCmd),
      'editor.removeBlankLines': cm(removeBlankLinesCmd),
      'editor.trimTrailing':  cm(trimTrailingCmd),
      'editor.reverseLines':  cm(reverseLinesCmd),
      'editor.shuffleLines':  cm(shuffleLinesCmd),
      'editor.indentToTabs':  cm(indentToTabsCmd),
      'editor.indentToSpaces': cm(indentToSpacesCmd),
      'editor.insertNumberSequence': cm(insertNumberSequenceCmd()),
      // Bookmarks
      'editor.bookmarkToggle': bookmark('dbgui:bookmark-toggle'),
      'editor.bookmarkNext':   bookmark('dbgui:bookmark-next'),
      'editor.bookmarkPrev':   bookmark('dbgui:bookmark-prev'),
      // Macro (§5.9) — excluded from recording by the recorder itself, so a
      // macro can never capture the act of recording or replaying.
      'editor.macroRecordToggle': toggleMacroRecord,
      'editor.macroPlay':         playMacro,
      // View
      'editor.wordWrap':      () => window.dispatchEvent(new CustomEvent('dbgui:toggle-wrap')),
      'editor.zenMode':       () => window.dispatchEvent(new CustomEvent('dbgui:toggle-zen')),
      'editor.zoomIn':        () => onZoomRef.current?.(+10),
      'editor.zoomOut':       () => onZoomRef.current?.(-10),
      'editor.zoomReset':     () => onZoomRef.current?.(0),
      // SQL-only commands — omitted on Redis, where they do not apply.
      ...(engine === 'redis' ? {} : {
        'editor.explain':     withView(explainCommand),
        'editor.beautify':    () => { if (viewRef.current) beautifyBlock(viewRef.current, engine); },
        'editor.format':      () => { if (viewRef.current) formatDocument(viewRef.current, engine); },
        'editor.expandStar':  withView(expandStarCommand),
        'editor.renameAlias': withView(renameSymbolCommand),
        // Statement transforms (SELECT → INSERT/CTAS/…). The transform itself
        // refuses non-SELECTs, so these are safe to invoke any time.
        'editor.selectToInsert': withView(v => transformStatement(v, selectToInsert, sqlDelimiter())),
        'editor.selectToCreateTable': withView(v => transformStatement(v, selectToCreateTable, sqlDelimiter())),
        'editor.selectToCreateView': withView(v => transformStatement(v, selectToCreateView, sqlDelimiter())),
        'editor.selectToDelete': withView(v => transformStatement(v, selectToDelete, sqlDelimiter())),
        'editor.selectToUpdate': withView(v => transformStatement(v, selectToUpdate, sqlDelimiter())),
      }),
    };

    const updateListener = EditorView.updateListener.of(update => {
      if (update.docChanged) {
        onChangeRef.current?.(update.state.doc.toString());
        // The expand-selection trail points at ranges in the pre-edit text;
        // restoring one now would select the wrong span. Drop it.
        expandStackRef.current.length = 0;
        // Serializing the whole undo stack on every keystroke would be wasteful;
        // debounce it and report the latest once typing settles. The final
        // state is also flushed on unmount so closing a tab captures it.
        if (onHistoryChangeRef.current) {
          window.clearTimeout(historyTimerRef.current);
          historyTimerRef.current = window.setTimeout(() => {
            const view = viewRef.current;
            if (!view) return;
            try {
              onHistoryChangeRef.current?.(view.state.toJSON({ history: historyField }).history);
            } catch { /* serialization is best-effort — never break editing */ }
          }, 700);
        }
      }
      if (update.docChanged || update.selectionSet) {
        const sel = update.state.selection;
        const head = sel.main.head;
        const line = update.state.doc.lineAt(head);
        const selLen = sel.ranges.reduce((n, r) => n + (r.to - r.from), 0);
        onCursorRef.current?.({
          line: line.number,
          col: head - line.from + 1,
          selLen,
          carets: sel.ranges.length,
        });
        reportKillContext(update.view);
        updateSignature(update.view);
      }
    });

    /**
     * Signature help. Functions answer from the built-in catalog; a name we do
     * not know is looked up as a stored routine (lazy, cached by the host) —
     * which is the only way `CALL my_proc(` can ever tell you anything.
     */
    const updateSignature = (view: EditorView) => {
      // Signature help is one of the hint surfaces — off means off.
      if (!hintsRef.current) { setSignature(null); return; }
      const sel = view.state.selection.main;
      if (!sel.empty) { setSignature(null); return; }
      const doc = view.state.doc.toString();

      // An INSERT is a call too: the VALUES tuple has "parameters", and knowing
      // which column position 4 feeds — with its type — is the difference
      // between counting commas and just typing.
      const ins = insertContext(doc.slice(0, sel.head));
      if (ins && (ins.where === 'values' || ins.where === 'cols')) {
        getColumnsRef.current?.(ins.table).then(cols => {
          if (!cols || cols.length === 0) { setSignature(null); return; }
          const list = ins.columns && ins.columns.length > 0
            ? ins.columns.map(name =>
                cols.find(c => c.label.toLowerCase() === name.toLowerCase()) ?? { label: name, detail: '?' })
            : cols;
          setSignature({
            text: `${ins.table} →(…)`,
            args: list.map(c => `${c.label}${c.detail ? ` ${c.detail}` : ''}`),
            active: ins.where === 'values' ? ins.index : ins.index,
          });
        }).catch(() => setSignature(null));
        return;
      }

      const call = callSiteAt(doc, sel.head, engine);
      if (!call) { setSignature(null); return; }
      const upper = call.name.toUpperCase();
      const hit = keywordCatalog(engine).find(k =>
        k.type === 'function' && k.label.toUpperCase() === upper);
      if (hit?.detail) {
        setSignature({ text: hit.detail, args: signatureArgs(hit.detail), active: call.argIndex });
        return;
      }
      const provider = getRoutineSignatureRef.current;
      if (!provider) { setSignature(null); return; }
      provider(call.name).then(sig => {
        if (!sig) { setSignature(null); return; }
        // Only apply if the caret is still in the same call.
        const now = viewRef.current;
        if (!now) return;
        const stillThere = callSiteAt(now.state.doc.toString(), now.state.selection.main.head, engine);
        if (stillThere?.name.toUpperCase() !== upper) return;
        setSignature({ text: sig, args: signatureArgs(sig), active: stillThere.argIndex });
      }).catch(() => setSignature(null));
    };

    // `kill …` / `killall` under the caret → the host opens the live process
    // picker anchored at the caret. Reported as null the moment it stops
    // matching (caret moved away, command finished, selection made).
    const reportKillContext = (view: EditorView) => {
      const cb = onKillContextRef.current;
      if (!cb) return;
      const sel = view.state.selection.main;
      if (!sel.empty) { cb(null); return; }
      const trigger = parseKillTrigger(view.state.doc.sliceString(0, sel.head));
      if (!trigger) { cb(null); return; }
      const coords = view.coordsAtPos(sel.head);
      if (!coords) { cb(null); return; }
      cb({ trigger, anchor: { x: coords.left, y: coords.top, lineBottom: coords.bottom } });
    };

    // One SQL language instance for the whole editor: the extension itself, the
    // closeBrackets bracket list and any future language data must share it.
    const sqlLang = sql({
      dialect: DIALECT[engine],
      upperCaseKeywords: getPref(PREFS.editorKeywordCase) === 'upper',
    });

    // Auto-scroll tracking for the run markers: the running statement's index
    // in the last update this editor saw (-1 = none). Per editor instance.
    let lastRunningIdx = -1;

    // The automatic hint surfaces (Settings → Editor → Hints, PREFS.editorHints):
    // the live diagnostics analyser (squiggles + status-bar counts), the
    // INSERT … VALUES inlay hints and the hover tooltip. One compartment holds
    // them all so the preference strips them out of — and back into — a live
    // editor (see the prefs-changed listener below). The diagnostics FIELD
    // itself is NOT in here: the ⌘. quick-fix command reads it, so it stays
    // installed and is merely cleared when the hints go off.
    const hintExtensions: Extension[] = [
      // Re-analyse on a 350 ms debounce after typing stops: precise enough to
      // feel live, cheap enough that a 500-line script costs nothing.
      EditorView.updateListener.of(update => {
        if (!update.docChanged && !update.viewportChanged) return;
        if (!update.docChanged) return;
        window.clearTimeout(diagTimerRef.current);
        diagTimerRef.current = window.setTimeout(() => {
          const view = viewRef.current;
          if (!view) return;
          const text = view.state.doc.toString();
          const ctxNow = diagContextRef.current?.(text) ?? emptyDiagContext();
          const list = diagnose(text, ctxNow, sqlDelimiter());
          view.dispatch({ effects: setDiagnostics.of(list) });
          onDiagnosticsRef.current?.({
            errors: list.filter(d => d.severity === 'error').length,
            warnings: list.filter(d => d.severity === 'warning').length,
            infos: list.filter(d => d.severity === 'info').length,
          });
        }, 350);
      }),
      insertHintsPlugin,
      // Hover: what is this identifier? (utils/sqlHover resolves, the async
      // column/FK lookups come from the same providers completion uses)
      hoverTooltip(async (view, pos) => {
        // A diagnostic under the pointer wins: the problem is what you want
        // to read, not the column's data type.
        const diags = view.state.field(diagnosticsField).list
          .filter(d => pos >= d.from && pos <= d.to);
        if (diags.length > 0) {
          const dom = document.createElement('div');
          dom.className = 'cm-sql-tip';
          const docText = view.state.doc.toString();
          for (const d of diags) {
            const el = document.createElement('div');
            el.className = `cm-tip-diag cm-tip-diag-${d.severity}`;
            el.textContent = `${d.severity === 'error' ? '✖' : d.severity === 'warning' ? '⚠' : 'ℹ'} ${d.message}`;
            dom.appendChild(el);

            // The action, not just the complaint. Each fix is a button rather
            // than a single "fix it", because where several answers exist
            // (which table to qualify with) picking one silently would change
            // what the query reads.
            for (const fix of fixesFor(d, docText)) {
              const btn = document.createElement('button');
              btn.className = 'cm-tip-fix';
              btn.textContent = fix.title + (fix.complete ? '' : ' …');
              btn.onmousedown = ev => {
                ev.preventDefault();
                view.dispatch({
                  changes: fix.edits.map(e => ({ from: e.from, to: e.to, insert: e.insert })),
                  ...(fix.caret !== undefined ? { selection: { anchor: fix.caret } } : {}),
                });
                view.focus();
              };
              dom.appendChild(btn);
            }
          }
          return { pos: diags[0].from, end: diags[0].to, above: true, create: () => ({ dom }) };
        }
        const doc = view.state.doc.toString();
        const target = resolveHover(doc, pos, hoverCtxForRef.current(doc), engine);
        if (!target) return null;
        const dom = await describeTargetRef.current(target);
        if (!dom) return null;
        return { pos: target.span.from, end: target.span.to, above: true, create: () => ({ dom }) };
      }, { hoverTime: 250 }),
    ];
    hintExtensionsRef.current = hintExtensions;

    const editorExtensions = [
        // Multiple selections / multi-cursor + column (rectangular) selection.
        EditorState.allowMultipleSelections.of(true),
        drawSelection(),
        rectangularSelection(),   // Alt-drag → column selection
        crosshairCursor(),        // Alt shows the crosshair for column mode
        // Per-statement run markers sit LEFT of the line numbers (CM lays
        // gutters out in extension order): [chip] [ms] first, then the number.
        statementGutter,
        // Line numbers that light up for every selection-covered line (and
        // keep the stock active-line number for a bare caret) — replaces
        // lineNumbers() + highlightActiveLineGutter().
        selectionLineNumbers,
        // Change-bar gutter: a thin coloured strip on lines that differ from
        // the baseline (the buffer as first loaded this session). Mounted only
        // when the preference is on — reconfigured live by the prefs listener.
        changeBarsCompartment.current.of(showChangeBars ? changeBars(initialValue) : []),
        highlightActiveLine(),
        foldGutter(),
        codeFolding(),
        bracketMatching(),
        // Auto-close (and type-over) brackets and quotes. The bracket list is
        // attached to THIS language instance (language data is per-instance, so
        // a throwaway `sql()` here would silently do nothing) and adds MySQL's
        // backtick, which the SQL language data does not list by default.
        closeBrackets(),
        // Typing a bracket/quote with text selected wraps it (closeBrackets
        // only handles an empty caret).
        surroundInputHandler,
        // Highlight all uses of the identifier under the caret.
        occurrenceHighlighter,
        sqlLang.language.data.of({
          closeBrackets: { brackets: ['(', '[', '{', "'", '"', ...(engine === 'mysql' ? ['`'] : [])] },
        }),
        indentOnInput(),
        // Search: top panel + match highlights + the "3 of 17" badge.
        // searchKeymap (below) brings ⌘F / ⌘G / Esc with it.
        search({ top: true }),
        searchCountBadge,
        highlightSelectionMatches(),
        history(),
        appEditorTheme,
        sqlLang,
        completionsCompartment.current.of(
          hintsRef.current
            ? autocompletion({ override: [makeCompletionSource(schemaCompletions)] })
            : []
        ),
        wrapCompartment.current.of(wrap ? EditorView.lineWrapping : []),
        // Show spaces, tabs and trailing whitespace on demand — the only way
        // to see a script that mixes tabs and spaces (Notepad++ Show Symbol).
        invisiblesCompartment.current.of(
          showInvisibles
            ? [highlightWhitespace(), highlightTrailingWhitespace(), indentGuides()]
            : []),
        // Read-only is a property of the *document*, separate from the
        // connection being read-only: opening production DDL to read it and
        // being unable to fat-finger it is its own want.
        readOnlyCompartment.current.of(readOnly ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : []),
        // Per-editor zoom, independent of the app-wide font size.
        zoomCompartment.current.of(EditorView.theme({ '&': { fontSize: `${zoom}%` } })),
        // Vertical right-margin guides at the configured columns (e.g. 80/120).
        // Reconfigured live from the prefs-changed listener below.
        rulersCompartment.current.of(rulers(getPref(PREFS.editorRulers))),
        // Room to scroll the last line off the bottom, so the statement you
        // are writing is not pinned to the very edge of the pane.
        scrollPastEnd(),
        minimapCompartment.current.of(showMinimap ? minimap() : []),
        autoFormatListener(engine),
        currentStmtField,
        diagnosticsField,
        symbolRefsField,
        todoField,
        sqlPatternSearch,
        // The automatic hint surfaces (completion/lint/hover + INSERT inlay
        // hints), reconfigured out live by the Hints preference.
        hintsCompartment.current.of(hintsRef.current ? hintExtensions : []),
        statementRunsField,
        runElapsedField,
        runTickerPlugin,
        // Keep the RUNNING statement on screen: when the running index moves
        // (a script advancing, or a single run starting), scroll its first
        // line into view — 'nearest', so an already-visible line never yanks
        // the scroll position, and no transition means no scroll at all.
        // Update listeners run after the update cycle (unlike plugin.update),
        // so dispatching the scroll effect from here is legal. Primary pane
        // only — the split secondary mirrors the doc and keeps its own scroll.
        EditorView.updateListener.of(update => {
          const idx = runningIndex(update.state.field(statementRunsField));
          if (idx === lastRunningIdx) return;
          lastRunningIdx = idx;
          if (idx < 0) return;
          const stmts = splitDoc(update.state.doc, sqlDelimiter()).filter(x => x.text.trim());
          const s = stmts[idx];
          if (!s) return;
          update.view.dispatch({
            effects: EditorView.scrollIntoView(s.from, { y: 'nearest' }),
          });
        }),
        // Semantic symbol references (utils/symbolRefs): recompute on a 150 ms
        // debounce after the caret moves or the text changes — the classifier
        // parses, so no synchronous work per keystroke. The timer callback
        // dispatches asynchronously, which is the legal way to decorate from a
        // listener (never dispatch synchronously inside update()). A real
        // selection or a non-SQL engine clears the highlight instead.
        EditorView.updateListener.of(update => {
          if (!update.docChanged && !update.selectionSet) return;
          window.clearTimeout(symTimerRef.current);
          symTimerRef.current = window.setTimeout(() => {
            const view = viewRef.current;
            if (!view) return;
            const sel = view.state.selection.main;
            const refs = !sel.empty || engine === 'redis'
              ? null
              : symbolRefs(view.state.doc.toString(), sel.head, engine, sqlDelimiter());
            view.dispatch({ effects: setSymbolRefs.of(refs) });
          }, 150);
        }),
        // ⌘-click a table/view name → open it (the host decides how).
        EditorView.domEventHandlers({
          mousedown(event, view) {
            if (!(event.metaKey || event.ctrlKey) || !onOpenObjectRef.current) return false;
            const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
            if (pos == null) return false;
            const doc = view.state.doc.toString();
            const target = resolveHover(doc, pos, hoverCtxForRef.current(doc), engine);
            if (target?.kind !== 'table' || !target.table) return false;
            event.preventDefault();
            onOpenObjectRef.current(target.table);
            return true;
          },
        }),
        // Record copies and cuts into the paste ring so ⌘⇧V can bring an
        // earlier one back. `false` lets the browser's own copy/cut proceed;
        // we only observe the text. Every non-empty selection range is a clip,
        // so a multi-cursor copy remembers each piece.
        EditorView.domEventHandlers({
          copy(_event, view) { recordClips(view); return false; },
          cut(_event, view)  { recordClips(view); return false; },
        }),
        // NOTE: the kill picker does NOT take its keys through this keymap.
        // It claims ↑↓/PgUp/PgDn/⇥/⏎/Esc with a document-level capture
        // listener while it is open (see KillPicker), because a CodeMirror
        // binding at any precedence still competes with autocomplete's own
        // keymap for ⏎ — and losing that race made ⏎ do nothing.
        // Macro capture (§5.9): a record-only shadow of the real bindings.
        // For every recordable registry command that has a key, observe the
        // keypress, append its id to the in-progress macro, then RETURN FALSE
        // so the real binding below still runs. Purely additive — it changes no
        // command's behaviour, it only remembers that the command fired. Built
        // from EDITOR_COMMANDS so key strings stay in lockstep with the keymap.
        keymap.of(
          EDITOR_COMMANDS
            .filter(c => c.keys && isRecordable(c.id))
            .map(c => ({ key: c.keys!, run: () => { macroRef.current.record(c.id); return false; } })),
        ),
        keymap.of([
          // Tab accepts the completion under the cursor — muscle memory from
          // every other SQL tool. It returns false when no popup is open, so
          // `indentWithTab` below still indents.
          { key: 'Tab', run: acceptCompletion },
          ...closeBracketsKeymap,
          { key: 'Mod-Enter', run: runCommand },
          // Ctrl+Alt+Shift+Enter is the original no-results chord AND a trap:
          // some platforms/webviews normalize the Alt away and deliver it as
          // Mod-Shift-Enter (run script WITH results) — bind it explicitly,
          // before that binding, so the chord can never fall through.
          { key: 'Mod-Alt-Shift-Enter', run: runAllNoResultsCommand },
          { key: 'Mod-Shift-Enter', run: runAllCommand },
          // run the script for timings only — no Result tabs (F9)
          { key: 'F9', run: runAllNoResultsCommand },
          // ⌘⇧P / Ctrl+Shift+P — Find Action: a searchable palette of every
          // editor command, so the shortcut-only ones are discoverable.
          { key: 'Mod-Shift-p', run: () => { setActionsOpen(true); return true; } },
          // ── Macro record & playback (§5.9) ──
          // ⌘⇧M toggles recording; ⌘⇧, replays the last macro. Both keys were
          // checked against this keymap and the @codemirror default / search /
          // history / fold keymaps — neither is otherwise bound. These two
          // bindings are absent from the record-only shadow above (isRecordable
          // rejects them), so a macro can't capture its own controls.
          { key: 'Mod-Shift-m', run: () => { toggleMacroRecord(); return true; } },
          { key: 'Mod-Shift-,', run: () => { playMacro(); return true; } },
          { key: 'Mod-e', run: explainCommand },
          { key: 'F12', run: goToObjectCommand },
          { key: 'Mod-y', run: peekObjectCommand },   // Quick Definition (peek DDL)
          { key: 'Mod-i', run: () => { onAiAssistRef.current?.('generate'); return true; } }, // AI: generate SQL
          { key: 'Mod-Shift-8', run: expandStarCommand },        // expand * (B5/B8)
          { key: 'Shift-F6', run: renameSymbolCommand },         // rename symbol under caret
          { key: 'Mod-Alt-ArrowUp', run: gotoStatement(-1) },    // prev statement
          { key: 'Mod-Alt-ArrowDown', run: gotoStatement(1) },   // next statement
          // Semantic selection (see expandSelectionCommand above for why not ⌘⌥W)
          { key: 'Mod-Alt-ArrowRight', run: expandSelectionCommand },
          { key: 'Mod-Alt-ArrowLeft', run: shrinkSelectionCommand },
          { key: 'Mod-Alt-Enter', run: runToCursorCommand },     // run to cursor
          { key: 'Mod-Alt-;', run: completeStatementCommand },   // complete current statement
          { key: 'Mod-Shift-f', run: (view) => { formatDocument(view, engine); return true; } },
          { key: 'Shift-Alt-f', run: (view) => beautifyBlock(view, engine) }, // beautify statement/selection
          { key: 'Mod-Alt-f', run: openReplacePanel },                       // search & replace
          { key: 'Mod-h', run: openReplacePanel },                           // ⌘H muscle memory
          // `searchKeymap` binds gotoLine to Mod-Alt-G, which nobody guesses.
          // Ctrl/⌘G is what every editor in the comparison uses.
          { key: 'Mod-g', run: gotoLine },
          // ── Case (Notepad++ Ctrl+U / Ctrl+Shift+U) ──
          { key: 'Mod-u', run: convertCaseCmd('lower') },
          { key: 'Mod-Shift-u', run: convertCaseCmd('upper') },
          // Paste from history (Sublime / DataGrip ⌘⇧V) — pick an earlier copy
          // out of the ring instead of only the last one the clipboard kept.
          { key: 'Mod-Shift-v', run: pasteHistoryCommand },
          // ── Multi-cursor (VS Code parity) ──
          { key: 'Mod-Shift-l', run: selectAllOccurrences },   // select all occurrences of selection
          { key: 'Shift-Alt-i', run: splitSelectionIntoLines }, // cursor at end of each selected line
          // ── Line operations (Notepad++ Edit → Line Operations) ──
          { key: 'Mod-Alt-s', run: sortLinesCmd('asc') },
          { key: 'Mod-Alt-Shift-s', run: sortLinesCmd('desc') },
          { key: 'Mod-Alt-u', run: dedupeLinesCmd() },
          { key: 'Mod-j', run: joinLinesCmd },
          // A counter down a column of cursors — the column editor, no dialog.
          { key: 'Mod-Alt-n', run: insertNumberSequenceCmd() },
          // ── Per-editor zoom, independent of the app font size ──
          { key: 'Mod-=', run: () => { onZoomRef.current?.(+10); return true; } },
          { key: 'Mod-+', run: () => { onZoomRef.current?.(+10); return true; } },
          { key: 'Mod--', run: () => { onZoomRef.current?.(-10); return true; } },
          { key: 'Mod-0', run: () => { onZoomRef.current?.(0); return true; } },
          // ── Advanced multiline / multi-cursor editing ──
          { key: 'Mod-d', run: selectNextOccurrence },                 // add next match to selection
          { key: 'Alt-ArrowUp', run: moveLineUp },                     // move line(s) up
          { key: 'Alt-ArrowDown', run: moveLineDown },                 // move line(s) down
          { key: 'Shift-Alt-ArrowUp', run: copyLineUp },               // duplicate up
          { key: 'Shift-Alt-ArrowDown', run: copyLineDown },           // duplicate down
          { key: 'Shift-Mod-k', run: deleteLine },                     // delete line(s)
          { key: 'Mod-/', run: toggleComment },                        // toggle -- comment
          { key: 'Mod-]', run: indentMore },
          { key: 'Mod-[', run: indentLess },
          { key: 'Mod-Shift-\\', run: cursorMatchingBracket },        // jump to matching bracket
          // Split / unsplit the editor into two panes over one document
          // (VS Code's ⌘\). A second view of the same buffer lets you edit
          // both ends of a long migration without scrolling between them.
          { key: 'Mod-\\', run: () => { setSplit(s => !s); return true; } },
          // Bookmarks. The host owns the list (it persists them per tab), so
          // the editor only reports the line and asks.
          { key: 'Mod-F2', run: (view) => {
            const line = view.state.doc.lineAt(view.state.selection.main.head).number;
            window.dispatchEvent(new CustomEvent('dbgui:bookmark-toggle', { detail: { line } }));
            return true;
          } },
          { key: 'F2', run: (view) => {
            const line = view.state.doc.lineAt(view.state.selection.main.head).number;
            window.dispatchEvent(new CustomEvent('dbgui:bookmark-next', { detail: { line } }));
            return true;
          } },
          { key: 'Shift-F2', run: (view) => {
            const line = view.state.doc.lineAt(view.state.selection.main.head).number;
            window.dispatchEvent(new CustomEvent('dbgui:bookmark-prev', { detail: { line } }));
            return true;
          } },
          // ⌘. applies the fix at the caret when there is exactly one. With
          // several it opens nothing rather than choosing — the hover offers
          // them by name, and a shortcut that picked for you would be the one
          // that silently rewrites a query. (See applyQuickFix above.)
          { key: 'Mod-.', run: applyQuickFix },
          indentWithTab,
          ...foldKeymap,
          ...defaultKeymap,
          ...historyKeymap,
          ...searchKeymap,
        ]),
        EditorView.theme({
          // calc+var so the editor follows the app font size live (CM emits
          // the value verbatim; the browser resolves the var).
          '&': { height: '100%', fontSize: 'calc(13px * var(--font-scale, 1))' },
          '.cm-scroller': { fontFamily: "'JetBrains Mono','Fira Mono',monospace", overflow: 'auto' },
          '.cm-content': { padding: '8px 0' },
          '.cm-placeholder': { color: 'var(--text2)' },
        }),
        EditorView.domEventHandlers({
          // Allow natural scroll without capturing
        }),
        // Split view: mirror this pane's edits into the second pane. No-op when
        // the split is closed. Forwarded transactions carry `splitSync` so the
        // peer does not echo them back (see the second pane's dispatch below).
        EditorView.updateListener.of(update => {
          const peer = splitViewRef.current;
          if (!peer || !update.docChanged) return;
          if (update.transactions.some(tr => tr.annotation(splitSync))) return;
          peer.dispatch({ changes: update.changes, annotations: splitSync.of(true) });
        }),
        updateListener,
        EditorView.contentAttributes.of({ 'data-placeholder': placeholder ?? '' }),
    ];

    // Rehydrate the undo history when the buffer reopens (Editor §5.2). A blob
    // that does not line up with the restored text — saved a moment apart, or
    // hand-edited — makes fromJSON throw; we fall back to a fresh state with an
    // empty history rather than failing to open the tab.
    const restoreHist = initialHistoryRef.current;
    let state: EditorState;
    if (restoreHist != null) {
      try {
        state = EditorState.fromJSON(
          { doc: initialValue, history: restoreHist },
          { extensions: editorExtensions },
          { history: historyField },
        );
      } catch {
        state = EditorState.create({ doc: initialValue, extensions: editorExtensions });
      }
    } else {
      state = EditorState.create({ doc: initialValue, extensions: editorExtensions });
    }

    const view = new EditorView({ state, parent: containerRef.current });
    viewRef.current = view;

    // Analyse what is already in the buffer (a restored draft, a picked history
    // entry) without waiting for the first keystroke. Not when hints are off —
    // the analyser is one of them.
    if (hintsRef.current && initialValue.trim()) {
      const ctxNow = diagContextRef.current?.(initialValue) ?? emptyDiagContext();
      view.dispatch({ effects: setDiagnostics.of(diagnose(initialValue, ctxNow, sqlDelimiter())) });
    }

    return () => {
      window.clearTimeout(diagTimerRef.current);
      window.clearTimeout(symTimerRef.current);
      window.clearTimeout(historyTimerRef.current);
      // Closing a tab is exactly the moment the undo stack would be lost —
      // flush the latest history synchronously before the view is destroyed.
      if (onHistoryChangeRef.current) {
        try {
          onHistoryChangeRef.current(view.state.toJSON({ history: historyField }).history);
        } catch { /* best-effort — a failed serialize must not block teardown */ }
      }
      view.destroy();
      viewRef.current = null;
      runCmdRef.current = null;
      runBareCmdRef.current = null;
      explainCmdRef.current = null;
    };
    // Only run once on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine]);

  // Toolbar Run / Explain triggers. The host passes the shared ref only to the
  // ACTIVE tab's editor (`… === activeId ? ref : undefined`), so re-running on
  // the prop hands ownership over on every tab switch: the newly-active editor
  // claims the ref, the deactivated one releases it. Wiring these in the
  // mount-only effect instead left a hidden editor owning the ref and firing
  // the wrong tab's SQL. Same shape as insertTextRef / killReplaceRef.
  useEffect(() => {
    if (!runNowRef) return;
    runNowRef.current = () => { if (viewRef.current) runCmdRef.current?.(viewRef.current); };
    return () => { runNowRef.current = null; };
  }, [runNowRef]);
  useEffect(() => {
    if (!runBareNowRef) return;
    runBareNowRef.current = () => { if (viewRef.current) runBareCmdRef.current?.(viewRef.current); };
    return () => { runBareNowRef.current = null; };
  }, [runBareNowRef]);
  useEffect(() => {
    if (!explainNowRef) return;
    explainNowRef.current = () => { if (viewRef.current) explainCmdRef.current?.(viewRef.current); };
    return () => { explainNowRef.current = null; };
  }, [explainNowRef]);

  // Split view: build/tear down the second pane. It shares the primary's
  // CURRENT document and selection, then stays in sync by forwarding each of
  // its own edits back to the primary — whose update listener (above) forwards
  // the other way. `splitSync` on a forwarded transaction stops the echo.
  useEffect(() => {
    if (!split) return;
    const primary = viewRef.current;
    const host = secondaryRef.current;
    if (!primary || !host) return;

    const sqlLang = sql({
      dialect: DIALECT[engine],
      upperCaseKeywords: getPref(PREFS.editorKeywordCase) === 'upper',
    });

    const state = EditorState.create({
      // Share the exact live document + caret so the panes open in lock-step.
      doc: primary.state.doc,
      selection: primary.state.selection,
      extensions: [
        EditorState.allowMultipleSelections.of(true),
        drawSelection(),
        rectangularSelection(),
        crosshairCursor(),
        selectionLineNumbers,
        highlightActiveLine(),
        foldGutter(),
        codeFolding(),
        bracketMatching(),
        closeBrackets(),
        sqlLang.language.data.of({
          closeBrackets: { brackets: ['(', '[', '{', "'", '"', ...(engine === 'mysql' ? ['`'] : [])] },
        }),
        indentOnInput(),
        search({ top: true }),
        searchCountBadge,
        highlightSelectionMatches(),
        history(),
        appEditorTheme,
        sqlLang,
        hintsCompartment2.current.of(
          hintsRef.current
            ? autocompletion({ override: [makeCompletionSource(schemaCompletionsRef.current)] })
            : []),
        wrapCompartment2.current.of(wrap ? EditorView.lineWrapping : []),
        zoomCompartment2.current.of(EditorView.theme({ '&': { fontSize: `${zoom}%` } })),
        // A read-only document is read-only in both panes.
        readOnly ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : [],
        scrollPastEnd(),
        keymap.of([
          { key: 'Tab', run: acceptCompletion },
          ...closeBracketsKeymap,
          // Run the statement at THIS pane's caret / its selection.
          { key: 'Mod-Enter', run: (v) => {
            const sel = v.state.selection.main;
            const content = v.state.doc.toString();
            const stmt = sel.empty ? statementAtCaret(content, sel.head, sqlDelimiter()) : null;
            const q = (sel.empty
              ? (stmt?.text ?? content)
              : content.slice(sel.from, sel.to)).trim();
            onRunRef.current(q, sel.empty ? stmt?.from : sel.from);
            return true;
          } },
          // Ctrl+Alt+Shift-Enter aliases the no-results run (and must precede
          // Mod-Shift-Enter — see the primary pane's note).
          { key: 'Mod-Alt-Shift-Enter', run: (v) => {
            const sel = v.state.selection.main;
            const content = v.state.doc.toString();
            const sql = (sel.empty ? content : content.slice(sel.from, sel.to)).trim();
            if (sql) onRunRef.current(sql, sel.empty ? undefined : sel.from, { noResults: true });
            return true;
          } },
          { key: 'Mod-Shift-Enter', run: (v) => { onRunRef.current(v.state.doc.toString().trim()); return true; } },
          { key: 'F9', run: (v) => {
            const sel = v.state.selection.main;
            const content = v.state.doc.toString();
            const sql = (sel.empty ? content : content.slice(sel.from, sel.to)).trim();
            if (sql) onRunRef.current(sql, sel.empty ? undefined : sel.from, { noResults: true });
            return true;
          } },
          // ⌘\ closes the split from either pane.
          { key: 'Mod-\\', run: () => { setSplit(false); return true; } },
          { key: 'Mod-Shift-\\', run: cursorMatchingBracket },
          indentWithTab,
          ...foldKeymap,
          ...defaultKeymap,
          ...historyKeymap,
          ...searchKeymap,
        ]),
        EditorView.theme({
          '&': { height: '100%', fontSize: 'calc(13px * var(--font-scale, 1))' },
          '.cm-scroller': { fontFamily: "'JetBrains Mono','Fira Mono',monospace", overflow: 'auto' },
          '.cm-content': { padding: '8px 0' },
        }),
      ],
    });

    const secondary = new EditorView({
      state,
      parent: host,
      // Apply locally, then forward the doc change to the primary — unless this
      // transaction is itself a forwarded echo, in which case it stops here.
      dispatchTransactions: (trs, view) => {
        view.update(trs);
        if (trs.some(tr => tr.annotation(splitSync))) return;
        const primaryNow = viewRef.current;
        if (!primaryNow) return;
        for (const tr of trs) {
          if (!tr.changes.empty) {
            primaryNow.dispatch({ changes: tr.changes, annotations: splitSync.of(true) });
          }
        }
      },
    });
    splitViewRef.current = secondary;
    secondary.focus();

    return () => {
      splitViewRef.current = null;
      secondary.destroy();
    };
    // wrap/zoom are seeded here and then tracked by the reconfigure effects
    // below, so they are intentionally not rebuild triggers.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [split, engine, readOnly, makeCompletionSource]);

  // Keep the second pane's wrap / zoom in step with the primary's, live.
  useEffect(() => {
    splitViewRef.current?.dispatch({
      effects: wrapCompartment2.current.reconfigure(wrap ? EditorView.lineWrapping : []),
    });
  }, [wrap]);
  useEffect(() => {
    splitViewRef.current?.dispatch({
      effects: zoomCompartment2.current.reconfigure(EditorView.theme({ '&': { fontSize: `${zoom}%` } })),
    });
  }, [zoom]);

  // Script-run markers arrive from the host as a plain prop.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({ effects: setStatementRuns.of(statementRuns ?? []) });
  }, [statementRuns]);

  // Update completions when schema changes — no full re-mount
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: completionsCompartment.current.reconfigure(
        // Hints off (Settings → Editor) means no completion, however fresh
        // the schema data is.
        hintsRef.current
          ? autocompletion({ override: [makeCompletionSource(schemaCompletions)] })
          : []
      ),
    });
  }, [schemaCompletions, makeCompletionSource]);

  // Expose insert function to parent
  useEffect(() => {
    if (!insertTextRef) return;
    insertTextRef.current = (text: string) => {
      const view = viewRef.current;
      if (!view) return;
      const { from, to } = view.state.selection.main;
      view.dispatch({
        changes: { from, to, insert: text },
        selection: { anchor: from + text.length },
      });
      view.focus();
    };
    return () => { if (insertTextRef) insertTextRef.current = null; };
  }, [insertTextRef]);

  // The kill picker's ⇧⏎: replace the typed `kill …` command with real
  // statements. The range is re-parsed at call time — the user may have kept
  // typing since the picker rendered.
  useEffect(() => {
    if (!killReplaceRef) return;
    killReplaceRef.current = (text: string) => {
      const view = viewRef.current;
      if (!view) return;
      const caret = view.state.selection.main.head;
      const trigger = parseKillTrigger(view.state.doc.sliceString(0, caret));
      const from = trigger ? trigger.from : caret;
      view.dispatch({
        changes: { from, to: caret, insert: text },
        selection: { anchor: from + text.length },
      });
      view.focus();
    };
    return () => { if (killReplaceRef) killReplaceRef.current = null; };
  }, [killReplaceRef]);

  const toggleWrap = useCallback(() => {
    setWrap(prev => {
      const next = !prev;
      localStorage.setItem(WRAP_KEY, next ? '1' : '0');
      window.dispatchEvent(new CustomEvent('dbgui:prefs-changed', { detail: { key: WRAP_KEY } }));
      viewRef.current?.dispatch({
        effects: wrapCompartment.current.reconfigure(next ? EditorView.lineWrapping : []),
      });
      return next;
    });
  }, []);

  // Live reconfigure for the props that can change while the editor is open.
  // A compartment each, so toggling one does not rebuild the other extensions
  // (or lose undo history, which recreating the state would).
  useEffect(() => {
    viewRef.current?.dispatch({
      effects: invisiblesCompartment.current.reconfigure(
        showInvisibles
          ? [highlightWhitespace(), highlightTrailingWhitespace(), indentGuides()]
          : []),
    });
  }, [showInvisibles]);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: readOnlyCompartment.current.reconfigure(
        readOnly ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : []),
    });
  }, [readOnly]);

  // The status bar's Ln/Col is clickable — the same command ⌘G runs. Its own
  // event name: `dbgui:goto-line` (with a line) is the JUMP; overloading one
  // name made a bookmark jump open this dialog in every mounted editor.
  useEffect(() => {
    const go = () => {
      if (!activeRef.current) return;
      const v = viewRef.current; if (v) { gotoLine(v); v.focus(); }
    };
    window.addEventListener('dbgui:goto-line-dialog', go);
    return () => window.removeEventListener('dbgui:goto-line-dialog', go);
  }, []);

  // Jump to a specific line — how a Find-in-Files hit lands on its match.
  useEffect(() => {
    const go = (e: Event) => {
      const n = (e as CustomEvent<{ line: number }>).detail?.line;
      const v = viewRef.current;
      if (!v || !n) return;
      // Clamp: the file may have changed since the search ran.
      const line = v.state.doc.line(Math.max(1, Math.min(v.state.doc.lines, n)));
      v.dispatch({
        selection: { anchor: line.from },
        effects: EditorView.scrollIntoView(line.from, { y: 'center' }),
      });
      v.focus();
    };
    window.addEventListener('dbgui:goto-line-number', go);
    return () => window.removeEventListener('dbgui:goto-line-number', go);
  }, []);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: zoomCompartment.current.reconfigure(
        EditorView.theme({ '&': { fontSize: `${zoom}%` } })),
    });
  }, [zoom]);
  // A changed keyword-case preference must reach the completion source, which
  // reads it when it is BUILT — so rebuild it when the preference changes.
  useEffect(() => {
    const onPrefs = (e: Event) => {
      const view = viewRef.current;
      if (!view) return;
      const key = (e as CustomEvent<{ key: string }>).detail?.key;
      if (key === PREFS.editorMinimap.key) {
        view.dispatch({
          effects: minimapCompartment.current.reconfigure(
            // A caller that pinned the minimap off keeps it off when the
            // *preference* changes — the pref is the default, not an override.
            (minimapPropRef.current ?? getPref(PREFS.editorMinimap)) ? minimap() : []),
        });
        return;
      }
      if (key === PREFS.editorRulers.key) {
        view.dispatch({
          effects: rulersCompartment.current.reconfigure(rulers(getPref(PREFS.editorRulers))),
        });
        return;
      }
      if (key === PREFS.editorChangeBars.key) {
        view.dispatch({
          effects: changeBarsCompartment.current.reconfigure(
            // Toggling it on mid-session diffs against the same baseline the
            // mount used — the buffer as first loaded.
            getPref(PREFS.editorChangeBars) ? changeBars(changeBarsBaselineRef.current) : []),
        });
        return;
      }
      // The completion source reads exactly two preferences when it is built
      // (makeCompletionSource): the keyword case and the statement delimiter.
      // Rebuild it — up to 15 000 schema items — for those keys ONLY. The old
      // fallthrough rebuilt it for every unrecognized key, so editor zoom
      // key-repeat, the app font size, even the copy-headers toggle rebuilt
      // completions in every mounted editor.
      if (key === PREFS.editorKeywordCase.key || key === PREFS.sqlDelimiter.key) {
        view.dispatch({
          effects: completionsCompartment.current.reconfigure(
            hintsRef.current
              ? autocompletion({ override: [makeCompletionSource(schemaCompletionsRef.current)] })
              : []),
        });
        return;
      }
      // Settings → Editor → Hints: strip (or restore) every automatic hint
      // surface in the live editor — completion, lint squiggles, hover, INSERT
      // inlay hints. Explicit commands (⌘. quick-fix, F12, ⌘Y) are unaffected.
      if (key === PREFS.editorHints.key) {
        const on = getPref(PREFS.editorHints);
        hintsRef.current = on;
        view.dispatch({
          effects: [
            hintsCompartment.current.reconfigure(on ? hintExtensionsRef.current : []),
            completionsCompartment.current.reconfigure(
              on ? autocompletion({ override: [makeCompletionSource(schemaCompletionsRef.current)] }) : []),
          ],
        });
        splitViewRef.current?.dispatch({
          effects: hintsCompartment2.current.reconfigure(
            on ? autocompletion({ override: [makeCompletionSource(schemaCompletionsRef.current)] }) : []),
        });
        if (!on) {
          // Remove what the surfaces already produced: squiggles, the
          // status-bar counts, any signature help on screen.
          view.dispatch({ effects: setDiagnostics.of([]) });
          onDiagnosticsRef.current?.({ errors: 0, warnings: 0, infos: 0 });
          setSignature(null);
        }
        return;
      }
    };
    window.addEventListener('dbgui:prefs-changed', onPrefs);
    return () => window.removeEventListener('dbgui:prefs-changed', onPrefs);
  }, [makeCompletionSource]);

  // Global toggle from the menu (View → Word Wrap) / shortcut (⌥Z) / the
  // editor toolbar button / Settings. Active-editor only: one keystroke used
  // to run N toggleWraps (one per mounted editor), each dispatching a
  // prefs-changed event — N² work for a wrap toggle.
  useEffect(() => {
    const on = () => { if (activeRef.current) toggleWrap(); };
    window.addEventListener('dbgui:toggle-wrap', on);
    return () => window.removeEventListener('dbgui:toggle-wrap', on);
  }, [toggleWrap]);

  // Same for formatting, so the toolbar button and ⌘⇧F run the identical path.
  // Per-buffer: honored when the event names this buffer, or (untargeted) by
  // the active editor only — the toolbar button used to reformat every open
  // buffer in every session.
  useEffect(() => {
    const on = (e: Event) => {
      const target = (e as CustomEvent<{ tabId?: number | string }>).detail?.tabId;
      if (target !== undefined ? target !== tabIdRef.current : !activeRef.current) return;
      if (viewRef.current) formatDocument(viewRef.current, engine);
    };
    window.addEventListener('dbgui:format-sql', on);
    return () => window.removeEventListener('dbgui:format-sql', on);
  }, [engine]);

  // Jump to a line — how the host answers a bookmark navigation. Honored when
  // the event names this buffer, or (untargeted) by the active editor only.
  useEffect(() => {
    const on = (e: Event) => {
      const view = viewRef.current;
      const detail = (e as CustomEvent<{ line: number; tabId?: number | string }>).detail;
      const targetTab = detail?.tabId;
      if (targetTab !== undefined ? targetTab !== tabIdRef.current : !activeRef.current) return;
      const line = detail?.line;
      if (!view || typeof line !== 'number') return;
      const total = view.state.doc.lines;
      const target = view.state.doc.line(Math.max(1, Math.min(total, line)));
      view.dispatch({
        selection: { anchor: target.from },
        effects: EditorView.scrollIntoView(target.from, { y: 'center' }),
      });
      view.focus();
    };
    window.addEventListener('dbgui:goto-line', on);
    return () => window.removeEventListener('dbgui:goto-line', on);
  }, []);

  // Local history restoring a version replaces the whole document. Done as a
  // single change so ⌘Z still undoes it in one step — a restore you cannot undo
  // is just a different way to lose the text.
  useEffect(() => {
    const on = (e: Event) => {
      const view = viewRef.current;
      const detail = (e as CustomEvent<{ sql: string; tabId?: number | string }>).detail;
      // Targeted event: only the named buffer applies it. An untargeted one is
      // honored by the active editor alone — every mounted editor applying it
      // was silent cross-tab data loss (one restore replaced every document).
      const target = detail?.tabId;
      if (target !== undefined ? target !== tabIdRef.current : !activeRef.current) return;
      const sql = detail?.sql;
      if (!view || typeof sql !== 'string') return;
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: sql },
        selection: { anchor: Math.min(sql.length, view.state.selection.main.head) },
      });
      view.focus();
    };
    window.addEventListener('dbgui:replace-sql', on);
    return () => window.removeEventListener('dbgui:replace-sql', on);
  }, []);

  // The outline asks the editor to jump to a statement. Selecting the range
  // rather than only moving the caret is what makes the click feel like it
  // did something on a statement that is already on screen.
  useEffect(() => {
    const on = (e: Event) => {
      const view = viewRef.current;
      const d = (e as CustomEvent<{ from: number; to: number }>).detail;
      if (!view || !d) return;
      const max = view.state.doc.length;
      const from = Math.max(0, Math.min(max, d.from));
      const to = Math.max(from, Math.min(max, d.to));
      view.dispatch({
        selection: { anchor: from, head: to },
        effects: EditorView.scrollIntoView(from, { y: 'center' }),
        scrollIntoView: false,
      });
      view.focus();
    };
    window.addEventListener('dbgui:goto-range', on);
    return () => window.removeEventListener('dbgui:goto-range', on);
  }, []);

  /**
   * Gate for the context menu's Transform section: is the current statement
   * (or the selection) a plain SELECT? Computed at render — the menu's own
   * open state is what re-renders, so this is always evaluated against the
   * live document at the moment the menu opens.
   */
  const transformGate = (): boolean => {
    const view = viewRef.current;
    if (!view) return false;
    const sel = view.state.selection.main;
    const text = sel.empty
      ? (statementAtCaret(view.state.doc.toString(), sel.head, sqlDelimiter())?.text ?? '')
      : view.state.sliceDoc(sel.from, sel.to);
    return parseSelect(text) != null;
  };

  return (
    <>
      {/* Overlaid, not stacked: a bar that appears in the layout would push the
          code you are typing down by its own height. */}
      {signature && (
        <div className="cm-sig-bar" title="signature of the call under the cursor">
          <span className="cm-sig-name">{signature.text.split('(')[0]}</span>
          <span className="cm-sig-parens">(</span>
          {signature.args.length === 0
            ? <span className="cm-sig-none">no arguments</span>
            : signature.args.map((a, i) => (
                <span key={i} className={`cm-sig-arg ${i === signature.active ? 'cm-sig-active' : ''}`}>
                  {a}{i < signature.args.length - 1 ? ',' : ''}
                </span>
              ))}
          <span className="cm-sig-parens">)</span>
        </div>
      )}
      <div ref={shellRef} className="sqled-split-shell">
        {/* Recording indicator — overlaid, non-interactive. ⌘⇧M stops it. */}
        {recording && (
          <div
            className="sqled-macro-rec"
            title="Recording macro — press the record shortcut again to stop"
            style={{
              position: 'absolute', top: 4, right: 44, zIndex: 5,
              display: 'flex', alignItems: 'center', gap: 4,
              fontSize: 11, fontWeight: 600, letterSpacing: 0.5,
              color: '#e5484d', pointerEvents: 'none', userSelect: 'none',
            }}
          >
            <span style={{
              width: 8, height: 8, borderRadius: '50%',
              background: '#e5484d', display: 'inline-block',
            }} />
            REC
          </div>
        )}
        <div
          ref={containerRef}
          className="cm-editor-wrap"
          style={{ flexGrow: split ? splitRatio : 1, flexBasis: 0, minWidth: 0 }}
          onContextMenu={e => {
            e.preventDefault();
            const view = viewRef.current;
            // A right-click that lands on a run marker gets the marker's menu
            // instead of the editor's. The event bubbles up from the gutter;
            // resolve the clicked line to a marker with the gutter's own map,
            // then to its statement with the gutter's own enumeration, so the
            // two can never disagree about which statement was clicked.
            const onMarker = view
              && (e.target as HTMLElement).closest?.('.cm-run-marker')
              && e.target !== view.contentDOM;
            if (view && onMarker) {
              const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
              const marker = pos != null ? markerMap(view).get(view.state.doc.lineAt(pos).from) : undefined;
              if (pos != null && marker) {
                const doc = view.state.doc;
                const lineFrom = doc.lineAt(pos).from;
                const idx = runStatementIndexAt(view, lineFrom);
                if (idx >= 0) {
                  const stmts = splitDoc(doc, sqlDelimiter()).filter(x => x.text.trim());
                  setRunMenu({ x: e.clientX, y: e.clientY, sql: stmts[idx].text, from: stmts[idx].from, run: marker.run, idx });
                  return;
                }
              }
            }
            setHasSelection(!(viewRef.current?.state.selection.main.empty ?? true));
            setMenu({ x: e.clientX, y: e.clientY });
          }}
        />
        {split && (
          <div
            className="sqled-split-divider"
            title="Drag to resize · double-click to reset"
            onPointerDown={startDividerDrag}
            onDoubleClick={() => setSplitRatio(0.5)}
          />
        )}
        {split && (
          <div
            ref={secondaryRef}
            className="cm-editor-wrap"
            style={{ flexGrow: 1 - splitRatio, flexBasis: 0, minWidth: 0 }}
          />
        )}
        <button
          type="button"
          className="sqled-split-toggle"
          aria-pressed={split}
          title={`${split ? 'Close split editor' : 'Split editor'}   ${SPLIT_SC}`}
          onClick={() => setSplit(s => !s)}
        >{split ? '⬌✕' : '⬌'}</button>
      </div>
      {menu && (
        <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
          <ContextMenuItem
            label={hasSelection ? `Run selection   ${SC.run}` : `Run statement   ${SC.run}`}
            onClick={() => { editorCommandsRef.current['editor.run']?.(); setMenu(null); }}
          />
          <ContextMenuItem
            label={`Run to cursor   ${SC.runToCursor}`}
            onClick={() => { editorCommandsRef.current['editor.runToCursor']?.(); setMenu(null); }}
          />
          <ContextMenuItem
            label={`Run script — no result tabs   ${SC.runAllBare}`}
            onClick={() => { editorCommandsRef.current['editor.runAllNoResults']?.(); setMenu(null); }}
          />
          {engine !== 'redis' && (
            <ContextMenuItem
              label={`Explain   ${SC.explain}`}
              onClick={() => { editorCommandsRef.current['editor.explain']?.(); setMenu(null); }}
            />
          )}
          <ContextMenuItem
            label={`Expand *  →  column list   ${SC.expandStar}`}
            onClick={() => { editorCommandsRef.current['editor.expandStar']?.(); setMenu(null); }}
          />
          {engine !== 'redis' && (
            <ContextMenuItem
              label="Rename symbol under cursor…   ⇧F6"
              onClick={() => { editorCommandsRef.current['editor.renameAlias']?.(); setMenu(null); }}
            />
          )}
          {/* Transform section (utils/sqlRefactor selectTo*): only when the
              statement at the caret (or the selection) is a plain SELECT —
              the transforms have nothing honest to offer otherwise. Flat
              items: ContextMenuItem has no submenu support. */}
          {engine !== 'redis' && transformGate() && (
            <>
              <ContextMenuItem
                label="Transform → INSERT INTO … SELECT"
                onClick={() => { editorCommandsRef.current['editor.selectToInsert']?.(); setMenu(null); }}
              />
              <ContextMenuItem
                label="Transform → CREATE TABLE AS"
                onClick={() => { editorCommandsRef.current['editor.selectToCreateTable']?.(); setMenu(null); }}
              />
              <ContextMenuItem
                label="Transform → CREATE VIEW AS"
                onClick={() => { editorCommandsRef.current['editor.selectToCreateView']?.(); setMenu(null); }}
              />
              <ContextMenuItem
                label="Transform → DELETE with the same WHERE"
                onClick={() => { editorCommandsRef.current['editor.selectToDelete']?.(); setMenu(null); }}
              />
              <ContextMenuItem
                label="Transform → UPDATE skeleton"
                onClick={() => { editorCommandsRef.current['editor.selectToUpdate']?.(); setMenu(null); }}
              />
            </>
          )}
          <ContextMenuItem
            label="Go to table under cursor   F12"
            onClick={() => { editorCommandsRef.current['editor.goToObject']?.(); setMenu(null); }}
          />
          <ContextMenuItem
            label={`Previous statement   ${SC.prevStmt}`}
            onClick={() => { editorCommandsRef.current['editor.prevStatement']?.(); setMenu(null); }}
          />
          <ContextMenuItem
            label={`Next statement   ${SC.nextStmt}`}
            onClick={() => { editorCommandsRef.current['editor.nextStatement']?.(); setMenu(null); }}
          />
          <ContextMenuItem
            label={`Beautify ${hasSelection ? 'selection' : 'statement'}   ${SC.beautify}`}
            onClick={() => { editorCommandsRef.current['editor.beautify']?.(); setMenu(null); }}
          />
          {clips().length > 0 && menu && (
            <ContextMenuItem
              label={`Paste from history   ${PASTE_HISTORY_SC}`}
              onClick={() => { setPaste({ x: menu.x, y: menu.y, items: clips() }); setMenu(null); }}
            />
          )}
          {/* Line operations. Notepad++ keeps these in Edit → Line Operations;
              here they hang off the editor's own menu, which is where a
              right-click already lands. They act on the selection, or on the
              whole document when there is none. */}
          <ContextMenuItem
            label={`Sort lines A→Z${hasSelection ? '' : ' (whole file)'}   ${SC.sortLines}`}
            onClick={() => { runCmd(sortLinesCmd('asc')); setMenu(null); }}
          />
          <ContextMenuItem
            label="Sort lines Z→A"
            onClick={() => { runCmd(sortLinesCmd('desc')); setMenu(null); }}
          />
          <ContextMenuItem
            label="Sort lines numerically"
            onClick={() => { runCmd(sortLinesCmd('numeric-asc')); setMenu(null); }}
          />
          <ContextMenuItem
            label={`Remove duplicate lines   ${SC.dedupeLines}`}
            onClick={() => { runCmd(dedupeLinesCmd()); setMenu(null); }}
          />
          <ContextMenuItem
            label="Keep only duplicated lines"
            onClick={() => { runCmd(keepDuplicatesCmd); setMenu(null); }}
          />
          <ContextMenuItem
            label="Remove blank lines"
            onClick={() => { runCmd(removeBlankLinesCmd); setMenu(null); }}
          />
          <ContextMenuItem
            label="Trim trailing whitespace"
            onClick={() => { runCmd(trimTrailingCmd); setMenu(null); }}
          />
          <ContextMenuItem
            label="Reverse line order"
            onClick={() => { runCmd(reverseLinesCmd); setMenu(null); }}
          />
          <ContextMenuItem
            label="Shuffle lines"
            onClick={() => { runCmd(shuffleLinesCmd); setMenu(null); }}
          />
          <ContextMenuItem
            label="Indent → tabs"
            onClick={() => { runCmd(indentToTabsCmd); setMenu(null); }}
          />
          <ContextMenuItem
            label="Indent → spaces"
            onClick={() => { runCmd(indentToSpacesCmd); setMenu(null); }}
          />
          {hasSelection && (
            <ContextMenuItem
              label="Title Case selection"
              onClick={() => { runCmd(convertCaseCmd('title')); setMenu(null); }}
            />
          )}
          {hasSelection && (
            <ContextMenuItem
              label="sWAP cASE selection"
              onClick={() => { runCmd(convertCaseCmd('swap')); setMenu(null); }}
            />
          )}
          <ContextMenuItem
            label={`Format ${hasSelection ? 'selection' : 'SQL'}   ${SC.format}`}
            onClick={() => { if (viewRef.current) formatDocument(viewRef.current, engine); setMenu(null); }}
          />
          <ContextMenuItem
            label={`${wrap ? '✓' : ' '}  Word wrap   ${SC.wrap}`}
            onClick={() => { toggleWrap(); setMenu(null); }}
          />
        </ContextMenu>
      )}
      {paste && (
        <ContextMenu x={paste.x} y={paste.y} onClose={() => setPaste(null)}>
          {paste.items.map((clip, i) => (
            <ContextMenuItem
              key={i}
              label={clipPreview(clip)}
              onClick={() => { insertClip(clip); setPaste(null); }}
            />
          ))}
        </ContextMenu>
      )}
      {runMenu && (
        // The gutter marker's menu. Re-run / explain go through window events
        // so they take the host's normal run paths (pre-flight, write confirm,
        // prod limits) exactly like ⌘↵ — the editor must not grow a second,
        // unaudited way to execute SQL.
        <ContextMenu x={runMenu.x} y={runMenu.y} onClose={() => setRunMenu(null)}>
          {(runMenu.run.status === 'ok' || runMenu.run.status === 'error') && (
            <ContextMenuItem
              label="Re-run this statement"
              onClick={() => {
                window.dispatchEvent(new CustomEvent('dbgui:run-statement',
                  { detail: { sql: runMenu.sql, from: runMenu.from } }));
                setRunMenu(null);
              }}
            />
          )}
          {(runMenu.run.status === 'ok' || runMenu.run.status === 'error') && engine !== 'redis' && (
            <ContextMenuItem
              label="EXPLAIN this statement"
              onClick={() => {
                window.dispatchEvent(new CustomEvent('dbgui:explain-statement',
                  { detail: { sql: runMenu.sql } }));
                setRunMenu(null);
              }}
            />
          )}
          {/* The auto-EXPLAIN plan, when the background fetch cached one for
              this statement (the marker's hasPlan). No execution — the plan is
              already on the tab; the host just puts it in front. */}
          {runMenu.run.hasPlan && (
            <ContextMenuItem
              label="Open plan"
              onClick={() => {
                window.dispatchEvent(new CustomEvent('dbgui:open-plan',
                  { detail: { idx: runMenu.idx } }));
                setRunMenu(null);
              }}
            />
          )}
          <ContextMenuItem
            label="Copy SQL"
            onClick={() => { void copyToClipboard(runMenu.sql); setRunMenu(null); }}
          />
          {/* The timing line only exists for a timed, finished run — a running
              or skipped marker offers Copy SQL and nothing else. */}
          {timingLine(runMenu.run, runMenu.sql) && (
            <ContextMenuItem
              label="Copy timing line"
              onClick={() => {
                const line = timingLine(runMenu.run, runMenu.sql);
                if (line) void copyToClipboard(line);
                setRunMenu(null);
              }}
            />
          )}
        </ContextMenu>
      )}
      {actionsOpen && (
        <CommandPalette
          items={EDITOR_COMMANDS
            .filter(c => editorCommandsRef.current[c.id])
            .map(c => {
              // Macro commands read their live state into the label so the
              // palette says "Stop recording" mid-take and shows how many steps
              // the last macro holds.
              const steps = macroRef.current.lastMacro().length;
              const label = c.id === 'editor.macroRecordToggle' && recording
                ? 'Stop recording macro'
                : c.id === 'editor.macroPlay'
                  ? `Play last macro${steps ? ` (${steps} step${steps === 1 ? '' : 's'})` : ''}`
                  : c.label;
              return {
                id: c.id,
                label,
                hint: c.keys ? formatKeys(c.keys) : c.category,
                keywords: c.category,
                // Dispatch through the recorder choke point so a palette
                // invocation is captured into a macro just like a keystroke.
                action: () => dispatchCommand(c.id),
              };
            })}
          onClose={() => setActionsOpen(false)}
        />
      )}
    </>
  );
}
