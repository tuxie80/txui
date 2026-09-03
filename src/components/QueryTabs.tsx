/**
 * Multi-tab query editor. Each tab has its own SQL buffer, result, and error.
 * The HistoryPanel is shown via a toggle button.
 */
import { lazy, memo, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { QueryResult, Session } from '../types';
import { ResultGrid } from './ResultGrid';
import { PanelIcon } from './panelIcons';

// CodeMirror (~260 kB) loads on demand, not at cold start
const SqlEditor = lazy(() =>
  import('./SqlEditor').then(m => ({ default: m.SqlEditor })));
const QueryStorePanel = lazy(() =>
  import('./QueryStorePanel').then(m => ({ default: m.QueryStorePanel })));
// Every tool panel below loads on the first open of its tab, not at cold
// start — otherwise the entry chunk carries ~40 panels nobody may ever open.
// React.lazy caches the resolved module, so once loaded a panel stays mounted
// for its tab's life exactly as a static import would.
const HistoryPanel = lazy(() => import('./HistoryPanel').then(m => ({ default: m.HistoryPanel })));
const ProcessListPanel = lazy(() => import('./ProcessListPanel').then(m => ({ default: m.ProcessListPanel })));
const ServerInfoPanel = lazy(() => import('./ServerInfoPanel').then(m => ({ default: m.ServerInfoPanel })));
const WatchPanel = lazy(() => import('./WatchPanel').then(m => ({ default: m.WatchPanel })));
const LocksPanel = lazy(() => import('./LocksPanel').then(m => ({ default: m.LocksPanel })));
const UsersPanel = lazy(() => import('./UsersPanel').then(m => ({ default: m.UsersPanel })));
const ReplicationPanel = lazy(() => import('./ReplicationPanel').then(m => ({ default: m.ReplicationPanel })));
const DbaViewsPanel = lazy(() => import('./DbaViewsPanel').then(m => ({ default: m.DbaViewsPanel })));
const TunerPanel = lazy(() => import('./TunerPanel').then(m => ({ default: m.TunerPanel })));
const RoutinePanel = lazy(() => import('./RoutinePanel').then(m => ({ default: m.RoutinePanel })));
const TxShellPanel = lazy(() => import('./TxShellPanel').then(m => ({ default: m.TxShellPanel })));
const SqlOutline = lazy(() => import('./SqlOutline').then(m => ({ default: m.SqlOutline })));
import {
  addSnapshot, BACKUP_INTERVAL_MS, BACKUP_KEY, describeAge, parseBackups,
  serializeBackups, type Snapshot,
} from '../utils/backups';
const FindPanel = lazy(() => import('./FindPanel').then(m => ({ default: m.FindPanel })));
import type { FindScope } from './FindPanel';
import type { CompareScope } from './ComparePanel';
import type { WatchMode, WatchTarget } from './WatchPanel';
const ColumnProfilePanel = lazy(() => import('./ColumnProfilePanel').then(m => ({ default: m.ColumnProfilePanel })));
const SequencePanel = lazy(() => import('./SequencePanel').then(m => ({ default: m.SequencePanel })));
const TypePanel = lazy(() => import('./TypePanel').then(m => ({ default: m.TypePanel })));
const ViewPanel = lazy(() => import('./ViewPanel').then(m => ({ default: m.ViewPanel })));
const DictionaryPanel = lazy(() => import('./DictionaryPanel').then(m => ({ default: m.DictionaryPanel })));
import { useServerFlavor } from '../store/serverFlavors';
import { capabilities } from '../utils/serverFlavor';
const TableDesigner = lazy(() => import('./TableDesigner').then(m => ({ default: m.TableDesigner })));
const ComparePanel = lazy(() => import('./ComparePanel').then(m => ({ default: m.ComparePanel })));
const PgListenPanel = lazy(() => import('./PgListenPanel').then(m => ({ default: m.PgListenPanel })));
const StmtStatsPanel = lazy(() => import('./StmtStatsPanel').then(m => ({ default: m.StmtStatsPanel })));
const BinlogPanel = lazy(() => import('./BinlogPanel').then(m => ({ default: m.BinlogPanel })));
const SlowLogPanel = lazy(() => import('./SlowLogPanel').then(m => ({ default: m.SlowLogPanel })));
const MaintenancePanel = lazy(() => import('./MaintenancePanel').then(m => ({ default: m.MaintenancePanel })));
const VacuumBloatPanel = lazy(() => import('./VacuumBloatPanel').then(m => ({ default: m.VacuumBloatPanel })));
const DocumenterPanel = lazy(() => import('./DocumenterPanel').then(m => ({ default: m.DocumenterPanel })));
const FleetPanel = lazy(() => import('./FleetPanel').then(m => ({ default: m.FleetPanel })));
const BufferHistory = lazy(() => import('./BufferHistory').then(m => ({ default: m.BufferHistory })));
import { snapshot, loadHistory, saveHistory, historyKey } from '../utils/bufferHistory';
import {
  toggleBookmark, nextBookmark, prevBookmark, loadBookmarks, saveBookmarks, bookmarkKey,
} from '../utils/sqlOutline';
import type { Bookmark } from '../utils/sqlOutline';
import type { BufferVersion } from '../utils/bufferHistory';
const ErDiagram = lazy(() => import('./ErDiagram').then(m => ({ default: m.ErDiagram })));
import { ContextMenu, ContextMenuItem } from './ContextMenu';
import { MenuSelect } from './MenuSelect';
import { DbScopeBar } from './DbScopeBar';
const DataGenPanel = lazy(() => import('./DataGenPanel').then(m => ({ default: m.DataGenPanel })));
const PlaygroundPanel = lazy(() => import('./PlaygroundPanel').then(m => ({ default: m.PlaygroundPanel })));
const KillPicker = lazy(() => import('./KillPicker').then(m => ({ default: m.KillPicker })));
import type { KillContext, StatementRun } from './SqlEditor';
const CsvImportPanel = lazy(() => import('./CsvImportPanel').then(m => ({ default: m.CsvImportPanel })));
const SqlQualityPanel = lazy(() => import('./SqlQualityPanel').then(m => ({ default: m.SqlQualityPanel })));
const DataBrowser = lazy(() => import('./DataBrowser').then(m => ({ default: m.DataBrowser })));
import { SchemaStore } from '../store/schema';
import { DdlModal } from './DdlModal';
const AiAssistModal = lazy(() => import('./AiAssistModal').then(m => ({ default: m.AiAssistModal })));
import type { AiMode } from './AiAssistModal';
const ExplainView = lazy(() => import('./ExplainView').then(m => ({ default: m.ExplainView })));
import type { ExplainData } from './ExplainView';
import { useSchemaCompletions } from '../hooks/useSchemaCompletions';
import { useResizable } from '../hooks/useResizable';
import { fmtDuration } from '../utils/fmtDuration';
import { resultKind, resultSummary } from '../utils/resultKind';
import { txReduce, txIsOpen, txIsBusy, txControls } from '../utils/txUi';
import { engineGapReason } from '../utils/engineGaps';
import type { TxMode } from '../utils/txUi';
const WriteConfirm = lazy(() => import('./WriteConfirm').then(m => ({ default: m.WriteConfirm })));
import type { WriteConfirmRequest } from './WriteConfirm';
import { scriptLinesToRuns, stmtRunsToRuns } from '../utils/runMarkers';
import type { PlanRun } from '../utils/planHistory';
import type { StmtRunMap } from '../utils/runMarkers';
import type { AliasDef } from '../utils/aliasExpand';
import { findVariables, substituteVariables } from '../utils/sqlVars';
import { can } from '../utils/engineCaps';
import { PLUGIN_MENU } from '../utils/pluginMenu';
import type { PluginMenuItem } from '../utils/pluginMenu';
import { errorDisplay } from '../utils/appError';
import { alertDialog, confirmDialog } from '../utils/appDialog';
import { findVirtualTables } from '../utils/sqlContext';
import { findAliases } from '../utils/sqlAlias';
import type { DiagContext } from '../utils/sqlDiagnostics';
import type { VarValue } from '../utils/sqlVars';
const SavedQueriesPanel = lazy(() => import('./SavedQueriesPanel').then(m => ({ default: m.SavedQueriesPanel })));
const VariablePrompt = lazy(() => import('./VariablePrompt').then(m => ({ default: m.VariablePrompt })));
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { formatChProgress, type ChProgressEvent } from '../utils/chProgress';
import { addLog, dropLog, setLogSink, setSessionLabel, useSessionLogCount, useSessionLogNonEmpty } from '../store/logStore';
import { LogView } from './LogView';
import { useQueryRunner } from '../hooks/useQueryRunner';
import { ConnectionsStore } from '../store/connections';
import type { ConnectionConfig } from '../types';
import { getPref, PREFS, usePreference } from '../store/preferences';
import { EngineLogo } from './engineLogos';
import { PALETTE } from '../utils/palette';
import { tabStyle } from '../utils/tabStyle';
import { stopSessionRuns } from '../store/playgroundRuns';
import { TabVisibleProvider } from '../store/tabVisibility';
import { forgetKillPickerState } from '../store/killPickerState';
import { loadBuffers, saveBuffers } from '../utils/bufferStore';
import {
  EDITOR_HISTORY_KEY, parseHistoryBlob, serializeHistoryBlob, getStoredHistory, withHistory,
  type HistoryBlob,
} from '../utils/editorHistoryStore';
import {
  dirName, diskState, isDirty, parseRecent, pushRecent, RECENT_KEY, tabLabelFor,
  type Eol, type FileBinding,
} from '../utils/sqlFile';
import type { StoredBuffer } from '../utils/bufferStore';
import * as tabModel from '../utils/tabModel';
import {
  clearSessionActivities, clearTabActivities, getActivities,
  panelTabKey, sqlTabKey, useActivityVersion } from '../store/tabActivity';
import type { TabActivity } from '../store/tabActivity';
import { CloseTabConfirm } from './CloseTabConfirm';
import { save as saveDialog } from '@tauri-apps/plugin-dialog';
const ScriptErrorPrompt = lazy(() => import('./ScriptErrorPrompt').then(m => ({ default: m.ScriptErrorPrompt })));
import {
  scriptResultTabs } from '../utils/scriptRun';
import type { ScriptErrorChoice } from '../utils/scriptRun';
import { shortcuts } from '../utils/platform';
import { explainVerdict } from '../utils/explainable';
import type { PreflightReport } from '../utils/preflight';
const ScriptPreflight = lazy(() => import('./ScriptPreflight').then(m => ({ default: m.ScriptPreflight })));
const GraphicsView = lazy(() => import('./GraphicsView').then(m => ({ default: m.GraphicsView })));
import { columnFacts } from '../utils/geoTrack';
import type { FastGridApi } from './FastGrid';
import { useSessionPrivileges } from '../store/sessionPrivileges';
import { privilegeTip } from '../utils/privileges';
import type { Capability } from '../utils/privileges';

/** Shortcut labels for this platform — see utils/platform. */
const SC = shortcuts();

export interface ScriptLine {
  text: string;
  status: 'pending' | 'running' | 'ok' | 'error' | 'skipped';
  ms?: number;
  /** Wall-clock start (epoch ms) — the gutter marker's hover tooltip. */
  startedAt?: number;
  rows?: number | null;        // rows returned or affected
  error?: string;
  /** Kept per statement so EVERY row set gets its own Result tab, not just the
   *  last. Rows are capped at SCRIPT_KEEP_ROWS (memory across N statements). */
  result?: QueryResult;
  /** "Run script — no result tabs" dropped this statement's row set on
   *  purpose — the overview says so where the Result N link would be. */
  discarded?: boolean;
}

/** What the user picked when a script statement failed. */
// Defined in utils/scriptRun alongside the rules that consume it; re-exported
// here because ScriptErrorPrompt has always imported it from this module.
export type { ScriptErrorChoice } from '../utils/scriptRun';

/** A paused script run waiting on that decision. */
export interface ScriptErrorRequest {
  /** 1-based index of the statement that failed. */
  stmtNo: number;
  total: number;
  sql: string;
  error: string;
  /** A transaction was open when it failed — so "ignore" has consequences. */
  inTransaction?: boolean;
  /** The statement was savepointed, so ignoring it is actually safe. */
  savepointed?: boolean;
  resolve: (choice: ScriptErrorChoice) => void;
}

/**
 * Turn the editor's line/column into a document offset.
 *
 * The editor reports a caret position for the status bar, and the outline needs
 * an offset to say which statement it sits in. Counting is cheaper than asking
 * the editor for a second representation of the same thing.
 */
function caretOffset(
  doc: string, cur: { line: number; col: number } | null,
): number | undefined {
  if (!cur) return undefined;
  let offset = 0;
  let line = 1;
  while (line < cur.line && offset < doc.length) {
    const nl = doc.indexOf('\n', offset);
    if (nl === -1) break;
    offset = nl + 1;
    line++;
  }
  return Math.min(doc.length, offset + Math.max(0, cur.col - 1));
}

export interface QueryTab {
  /** Pinned tabs sort to the front and cannot be dragged out of place. */
  pinned?: boolean;
  /** Where this buffer came from, when it came from a file. See utils/sqlFile. */
  file?: FileBinding;
  /** Buffer differs from disk — computed on the 250 ms sql-sync tick (and on
   *  save/reload), never by comparing whole buffers per tab per render. */
  dirty?: boolean;
  /**
   * Document read-only, distinct from a read-only *connection*.
   *
   * Opening production DDL to read it, and being unable to fat-finger it, is
   * its own want — and it is a property of this buffer, not of the server.
   */
  readOnly?: boolean;
  id: number;
  label: string;
  color?: string;
  /** what this tab is running right now (for the close-guard window) */
  runningSql?: string;
  runStartedAt?: number;
  /**
   * Set on a PLUGIN tab (Processes, Playground, …). Plugin panels are ordinary
   * tabs — they sit in the tab bar, switch, rename, colour and close like any
   * other, and "+" keeps making new SQL tabs while they stay open. They used to
   * be modal overlays that swallowed the whole workspace.
   */
  panel?: string;
  /**
   * Stable per-buffer id, minted once and carried across restarts (persisted by
   * utils/bufferStore). Unlike `id` — a per-launch counter — this survives a
   * quit, so it is the key the persisted undo history (utils/editorHistoryStore)
   * hangs a buffer's data off.
   */
  bid: string;
  sql: string;
  result: QueryResult | null;
  /** the statement that produced `result` (write-feedback wording needs it) */
  resultSql: string | null;
  scriptResults: ScriptLine[] | null;   // multi-statement run: one line per statement
  /**
   * The BUFFER statement index the last script run started at — 0 for a
   * whole-buffer run, K for a run over a selection beginning at statement K.
   * The gutter binds markers by absolute statement index, so the run's lines
   * are shifted by this (utils/runMarkers.scriptLinesToRuns).
   */
  scriptBase: number;
  /**
   * Accumulated per-statement run outcomes for the gutter (statement index →
   * status+ms). A single ⌘↵ run updates only its own entry — other statements'
   * chips persist; a script run replaces the whole map (and drives the gutter
   * from scriptResults while it exists). The index is resolved at run time;
   * nothing here is derived from the live buffer, so an edit cannot shift it —
   * the editor-side field clears markers on any doc change.
   */
  stmtRuns: StmtRunMap;
  /**
   * Auto-EXPLAIN plans fetched in the background for slow statements
   * (statement index → plan). Lives on the tab so it survives gutter repaints;
   * cleared whole on any buffer edit, consistent with the run markers it is
   * keyed alongside — a plan for edited-away text is a plan for a statement
   * that no longer exists.
   */
  autoPlans: Record<number, ExplainData>;
  /**
   * This tab's plan history (utils/planHistory PlanRun), fed by every EXPLAIN
   * opened in the tab — manual runs and opened auto-EXPLAINs alike. In-memory
   * only, per tab: comparing a plan against another SESSION's run of "the same"
   * query would be comparing two servers' data.
   */
  planRuns: PlanRun[];
  /** Which script result is in front full-area — a LINE index into
   *  scriptResults (utils/scriptRun.scriptResultTabs maps tabs to lines);
   *  null = no single result picked (the Log carries the per-statement lines). */
  scriptResultView?: number | null;
  explain: ExplainData | null;
  browsers: string[];                   // open table browsers (Result 1..N)
  activeBrowser: number;                // index into browsers when view === 'browser'
  view: 'grid' | 'plan' | 'browser' | 'log' | 'map'; // ADS-style result-area tabs
  error: string | null;
  running: boolean;
  autoLimited: number | null;           // default LIMIT that was auto-appended
  prodCap: number | null;               // prod row cap that replaced the default LIMIT
}

const LIMIT_CHOICES = [100, 1000, 10000, 0]; // 0 = no limit

/**
 * The privilege each plugin needs from the *connected role*, where it needs
 * one. Panels absent from this map need nothing beyond being able to connect.
 *
 * This exists in one place, consulted by both the menu item and the
 * keyboard shortcut, for the reason spelled out in utils/engineCaps.ts: the
 * previous generation of this gating lived in two lists that drifted, so a
 * panel could be deliberately withheld and still openable by shortcut.
 */
/**
 * The engine capability each plugin needs, mirroring the conditions the plugin
 * menu renders its items under (utils/pluginMenu.ts `when`). Panels absent
 * from this map work everywhere.
 *
 * One table rather than the menu's conditions repeated: that duplication
 * is the exact shape `utils/engineCaps.ts` was written to end, and the Tools
 * menu would otherwise have been a third copy.
 */
/**
 * The engine gate for the OTHER ways a panel opens — the Tools menu, the
 * command palette, the native menu. It must agree with `pluginMenu`'s `when`
 * for every panel, or the same panel opens from one entry point and is refused
 * from another, which reads as a bug in whichever one the user tried second.
 * `tests/toolsMenu.test.ts` compares the two.
 */
const PANEL_ENGINE_CAP: Record<string, Parameters<typeof can>[1] | undefined> = {
  processes:   'processList',
  serverinfo:  'serverInfo',
  replication: 'replication',
  routines:    'routines',
  // 'find' carries no gate: the files scope works on every engine, including
  // offline, so the panel is always worth opening — the scopes the engine
  // cannot serve are greyed inside it (components/FindPanel.tsx). 'compare'
  // is the same shape: the schema, results and scripts modes work everywhere,
  // only the data mode is engine-gated inside (components/ComparePanel.tsx).
  // 'watch' too: the Metrics mode runs any query on any engine; the Statement
  // (longQueryWatch) and Wait profile (postgres) modes are gated inside
  // (components/WatchPanel.tsx).
  // 'maintenance', not 'sqlDba': SQLite has maintenance (VACUUM, integrity
  // check, ANALYZE) without the catalog-driven DBA panels, so gating this on
  // sqlDba refused it from the palette and the native menu while the menu bar
  // offered it — the same panel, opening from one place and not another.
  maintenance: 'maintenance',
  documenter:  'documenter',
  fleet:       'fleet',
  playground:  'playground',
  locks:       'lockWaits',
  sequences:   'sequences',
  stmtstats:   'stmtStats',
  querystore:  'queryStore',
  users:       'userAdmin',
  tuner:       'tuner',
  erdiagram:   'erDiagram',
  datagen:     'dataGen',
  csvimport:   'csvImport',
  quality:     'sqlQuality',
  txshell:     'sql',
  views:       'sql',
};

/** Menu groups whose dropdown stays anchored to the button's RIGHT edge: they
    sit at the window's right edge, so opening under the word's first letter
    would push the list off-screen. Every other menu opens under its "A". */
const RIGHT_ANCHORED_MENUS = new Set(['findcompare', 'sql']);

const PANEL_PRIVILEGE: Record<string, Capability | undefined> = {
  // pg_stat_activity / SHOW PROCESSLIST show only your own work without it,
  // so both of these panels degrade to a mirror. (The Watch panel's Statement
  // mode is the third consumer — it is gated at mode level inside
  // components/WatchPanel.tsx, so Metrics stays reachable without it.)
  processes:   'processlist-all',
  locks:       'processlist-all',
  replication: 'replication',
  dbaviews:    'stats-views',
  tuner:       'stats-views',
  users:       'user-admin',
};

/**
 * Could this result be drawn on a map at all?
 *
 * Two numeric columns is the floor — a latitude and a longitude have to come
 * from somewhere. Nothing here guesses *which* two; that is the user's call
 * inside the view (see components/MapView.tsx).
 */
function mappable(result: { columns: { name: string }[]; rows: unknown[][] }): boolean {
  if (result.rows.length === 0) return false;
  const facts = columnFacts(result.columns.map(c => c.name), result.rows);
  return facts.filter(f => f.numeric >= Math.max(1, f.sampled * 0.8)).length >= 2;
}

/**
 * The result-area tab strip: Grid, per-statement script results, the
 * execution plan, Graphics, browser results and the Log (WP-16 16.1 — a pure
 * move out of the QueryTabs return). All state changes go through the host's
 * patchTab/setTabs, exactly as before.
 */
function ResultTabBar({ tab, sid, patchTab, setTabs }: {
  tab: QueryTab;
  sid: string;
  patchTab: (id: number, patch: Partial<QueryTab>) => void;
  setTabs: React.Dispatch<React.SetStateAction<QueryTab[]>>;
}) {
  return (
    <div className="rtab-bar">
      <button
        className={`rtab ${tab.view === 'grid' && tab.scriptResultView == null ? 'active' : ''}`}
        disabled={!tab.result}
        onClick={() => patchTab(tab.id, { view: 'grid', scriptResultView: null })}
      >Grid</button>
      {/* One Result tab per row-producing statement of a script run
          (utils/scriptRun.scriptResultTabs); row-less statements
          (writes, DDL, ANALYZE) keep their feedback line in the Log
          and never become tabs. */}
      {scriptResultTabs(tab.scriptResults ?? []).map((lineIdx, k) => {
        const line = tab.scriptResults?.[lineIdx];
        if (!line?.result) return null;
        return (
          <span key={lineIdx}
            className={`rtab rtab-result ${tab.view === 'grid' && tab.scriptResultView === lineIdx ? 'active' : ''}`}
            title={line.text.replace(/\s+/g, ' ').slice(0, 200)}
            onClick={() => patchTab(tab.id, { view: 'grid', scriptResultView: lineIdx })}>
            ▦ Result {k + 1}
            <span className="rtab-close" title="Close result"
              onClick={e => {
                e.stopPropagation();
                setTabs(prev => prev.map(t => {
                  if (t.id !== tab.id || !t.scriptResults) return t;
                  return {
                    ...t,
                    scriptResults: t.scriptResults.map((l, i) =>
                      i === lineIdx ? { ...l, result: undefined } : l),
                    scriptResultView: t.scriptResultView === lineIdx ? null : t.scriptResultView,
                  };
                }));
              }}>×</span>
          </span>
        );
      })}
      {tab.explain && (
        <span
          className={`rtab rtab-result ${tab.view === 'plan' ? 'active' : ''}`}
          onClick={() => patchTab(tab.id, { view: 'plan' })}
        >Execution Plan
          <span className="rtab-close" title="Close plan"
            onClick={e => {
              e.stopPropagation();
              setTabs(prev => prev.map(t => {
                if (t.id !== tab.id) return t;
                // Closing the plan you're looking at drops you back
                // on the grid when there is one, else the Log.
                const view = t.view === 'plan'
                  ? (t.result || t.scriptResultView != null ? 'grid' : 'log')
                  : t.view;
                return { ...t, explain: null, view };
              }));
            }}>×</span>
        </span>
      )}
      {/* Any result with rows can be visualised — a map (if it has
          coordinates) or a chart. The picker inside chooses which. */}
      {tab.result && tab.result.rows.length > 0 && (
        <button
          className={`rtab ${tab.view === 'map' ? 'active' : ''}`}
          data-tip="Visualise this result — a map (coordinates) or a chart"
          onClick={() => patchTab(tab.id, { view: 'map' })}
        >📈 Graphics</button>
      )}
      {tab.browsers.map((bt, bi) => (
        <span key={bt} className={`rtab rtab-result ${tab.view === 'browser' && tab.activeBrowser === bi ? 'active' : ''}`}
          title={bt}
          onClick={() => patchTab(tab.id, { view: 'browser', activeBrowser: bi })}>
          ▦ Result {bi + 1}
          <span className="rtab-close" title="Close result"
            onClick={e => {
              e.stopPropagation();
              setTabs(prev => prev.map(t => {
                if (t.id !== tab.id) return t;
                const browsers = t.browsers.filter((_, i) => i !== bi);
                const activeBrowser = Math.max(0, Math.min(t.activeBrowser, browsers.length - 1));
                return { ...t, browsers, activeBrowser, view: browsers.length ? t.view : 'grid' };
              }));
            }}>×</span>
        </span>
      ))}
      <button
        className={`rtab ${tab.view === 'log' ? 'active' : ''}`}
        title="Session execution log (bound to this query tab session)"
        onClick={() => patchTab(tab.id, { view: 'log' })}
      >📓 Log<LogCount sid={sid} /></button>
    </div>
  );
}

/** Live count badge for the 📓 Log result tab — its own component so the log
 *  subscription re-renders this span, never the whole QueryTabs tree. */
const LogCount = memo(function LogCount({ sid }: { sid: string }) {
  const n = useSessionLogCount(sid);
  return n ? <> ({n})</> : null;
});

/**
 * Plugin panels, as tabs: label shown in the tab bar. The icon is derived
 * from the panel id itself — <PanelIcon panel={id}> (components/panelIcons)
 * — so there is no icon field here to keep in sync. tests/pluginMenu.test.ts
 * and tests/toolsMenu.test.ts parse this table with a regex: keep the
 * `const PANEL_META … = {` header and the two-space `  panelId: { … }` shape.
 */
interface PanelCtx {
  session: Session;
  openSessions?: Session[];
  currentDb: string;
  dbList: string[];
  changeDb: (db: string) => void;
  tabs: QueryTab[];
  tabsRef: React.MutableRefObject<QueryTab[]>;
  activeIdRef: React.MutableRefObject<number | null>;
  liveSql: (t: QueryTab) => string;
  handleHistorySelect: (sql: string) => void;
  currentEditorSql: () => string;
  focusSqlTab: () => number;
  insertIntoEditor: (sql: string, tabId?: number) => void;
  routineTarget: { schema: string; name: string; kind: string; table?: string } | null;
  clearRoutineTarget: () => void;
  designTarget: { schema: string; table: string | null } | null;
  sequenceTarget: { schema: string; name: string } | null;
  clearSequenceTarget: () => void;
  typeTarget: { schema: string; name: string; kind: string } | null;
  clearTypeTarget: () => void;
  viewTarget: { schema: string; name: string; kind: string } | null;
  clearViewTarget: () => void;
  dictionaryTarget: { schema: string; name: string } | null;
  clearDictionaryTarget: () => void;
  findScope: FindScope | null;
  clearFindScope: () => void;
  compareScope: CompareScope | null;
  clearCompareScope: () => void;
  watchTarget: WatchTarget | null;
  clearWatchTarget: () => void;
}

/**
 * Wrap a schema-scoped panel with the in-panel database selector: picking
 * another database runs `changeDb` (backend `set_session_db`), and the new
 * `currentDb` flows back into the panel's `schema` prop. Panels that
 * re-query when `schema` changes need nothing more; panels that read it only
 * on mount get `key={c.currentDb}` on the panel element so a database switch
 * remounts them onto the new schema.
 */
function withDbScope(c: PanelCtx, panel: React.ReactNode): React.ReactNode {
  return (
    <div className="db-scope-wrap">
      <DbScopeBar sessionId={c.session.sessionId} engine={c.session.engine}
        dbList={c.dbList} currentDb={c.currentDb} onChange={c.changeDb} />
      {panel}
    </div>
  );
}

const PANEL_META: Record<string, {
  label: string;
  /** WP-16 16.1: the panel's renderer — the old 40-case switch, one entry
   *  per panel, reading component-scope values through `c`. */
  render: (c: PanelCtx, close: () => void) => React.ReactNode;
}> = {
  processes: {
    label: 'Processes',
    render: (c, close) =>
      <ProcessListPanel sessionId={c.session.sessionId}
          connectionName={c.session.connectionName} engine={c.session.engine} onClose={close} />,
  },
  replication: {
    label: 'Replication',
    render: (c, close) =>
      <ReplicationPanel sessionId={c.session.sessionId} engine={c.session.engine} onClose={close} />,
  },
  dbaviews: {
    label: 'DBA views',
    render: (c, close) =>
      <DbaViewsPanel sessionId={c.session.sessionId} engine={c.session.engine} onClose={close} />,
  },
  tuner: {
    label: 'Tuner',
    render: (c, close) =>
      <TunerPanel sessionId={c.session.sessionId} engine={c.session.engine}
          environment={c.session.environment} onClose={close} />,
  },
  routines: {
    label: 'Routines',
    render: (c, close) => withDbScope(c,
      <RoutinePanel sessionId={c.session.sessionId} connectionId={c.session.connectionId}
          engine={c.session.engine}
          schema={c.currentDb || null} environment={c.session.environment}
          readOnly={c.session.readOnly} target={c.routineTarget}
          onTargetConsumed={c.clearRoutineTarget} onClose={close} />),
  },
  txshell: {
    label: 'TxShell',
    render: (c, close) =>
      <TxShellPanel session={c.session} openSessions={c.openSessions ?? [c.session]} onClose={close} />,
  },
  find: {
    label: 'Find',
    render: (c, close) => withDbScope(c,
      <FindPanel
          key={c.currentDb}
          session={c.session}
          schema={c.currentDb || null}
          scope={c.findScope ?? undefined}
          onScopeConsumed={c.clearFindScope}
          // Every open buffer, so a script you have not saved is searched too.
          // Plugin tabs hold a panel, not SQL, so they are not scripts.
          buffers={c.tabs.filter(t => !t.panel && t.sql.trim())
            .map(t => ({ id: String(t.id), label: t.label, sql: c.liveSql(t) }))}
          initialDir={(() => {
            // Start where the file in front of you lives — that is almost
            // always the folder the question is about.
            const cur = c.tabsRef.current.find(t => t.id === c.activeIdRef.current);
            return cur?.file ? dirName(cur.file.path) : undefined;
          })()}
          onClose={close} />),
  },
  colprofile: {
    label: 'Column profile',
    render: (c, close) => withDbScope(c,
      <ColumnProfilePanel key={c.currentDb} session={c.session} schema={c.currentDb || null} onClose={close} />),
  },
  sequences: {
    label: 'Sequences',
    render: (c, close) => withDbScope(c,
      <SequencePanel key={c.currentDb} session={c.session} schema={c.currentDb || null}
          target={c.sequenceTarget} onTargetConsumed={c.clearSequenceTarget} onClose={close} />),
  },
  types: {
    label: 'Types',
    render: (c, close) => withDbScope(c,
      <TypePanel key={c.currentDb} session={c.session} schema={c.currentDb || null}
          target={c.typeTarget} onTargetConsumed={c.clearTypeTarget} onClose={close} />),
  },
  views: {
    label: 'Views',
    render: (c, close) => withDbScope(c,
      <ViewPanel key={c.currentDb} session={c.session} schema={c.currentDb || null}
          target={c.viewTarget} onTargetConsumed={c.clearViewTarget} onClose={close} />),
  },
  dictionary: {
    label: 'Dictionary',
    render: (c, close) => withDbScope(c,
      <DictionaryPanel key={c.currentDb} session={c.session} schema={c.currentDb || null}
          target={c.dictionaryTarget} onTargetConsumed={c.clearDictionaryTarget} onClose={close} />),
  },
  designer: {
    label: 'Table designer',
    render: (c, close) => withDbScope(c,
      <TableDesigner
          session={c.session}
          schema={c.designTarget?.schema ?? c.currentDb ?? ''}
          table={c.designTarget?.table ?? undefined}
          onClose={close} />),
  },
  compare: {
    label: 'Compare',
    render: (c, close) =>
      <ComparePanel
          session={c.session}
          openSessions={c.openSessions ?? [c.session]}
          schema={c.currentDb || null}
          // Every tab that currently holds a result — a panel tab holds none.
          results={c.tabs.filter(t => t.result).map(t => ({
            id: t.id, label: t.label, result: t.result!,
          }))}
          dbList={c.dbList}
          currentDb={c.currentDb}
          onChangeDb={c.changeDb}
          scope={c.compareScope ?? undefined}
          onScopeConsumed={c.clearCompareScope}
          onClose={close} />,
  },
  pglisten: {
    label: 'Listen / Notify',
    render: (c, close) =>
      <PgListenPanel session={c.session} onClose={close} />,
  },
  stmtstats: {
    label: 'Statement statistics',
    render: (c, close) =>
      <StmtStatsPanel session={c.session} onClose={close} />,
  },
  binlog: {
    label: 'Binary logs',
    render: (c, close) =>
      <BinlogPanel session={c.session} onClose={close} />,
  },
  slowlog: {
    label: 'Slow-log analyzer',
    render: (c, close) =>
      <SlowLogPanel session={c.session} onClose={close} />,
  },
  maintenance: {
    label: 'Maintenance',
    render: (c, close) => withDbScope(c,
      <MaintenancePanel session={c.session} schema={c.currentDb || null} onClose={close} />),
  },
  vacuum: {
    label: 'Vacuum & Bloat',
    render: (c, close) =>
      <Suspense fallback={null}><VacuumBloatPanel session={c.session} onClose={close} /></Suspense>,
  },
  documenter: {
    label: 'Documenter',
    render: (c, close) => withDbScope(c,
      <DocumenterPanel session={c.session} schema={c.currentDb || null} onClose={close} />),
  },
  fleet: {
    label: 'Fleet',
    render: (_c, close) =>
      <FleetPanel onClose={close} />,
  },
  erdiagram: {
    label: 'ER diagram',
    render: (c, close) =>
      <ErDiagram sessionId={c.session.sessionId} connectionId={c.session.connectionId} engine={c.session.engine} onClose={close} />,
  },
  datagen: {
    label: 'Data generator',
    render: (c, close) => withDbScope(c,
      <DataGenPanel key={c.currentDb} sessionId={c.session.sessionId} engine={c.session.engine}
          environment={c.session.environment} readOnly={c.session.readOnly}
          connectionName={c.session.connectionName} schema={c.currentDb || null} onClose={close}
          onSchemaChanged={() => window.dispatchEvent(new CustomEvent('dbgui:schema-changed'))} />),
  },
  csvimport: {
    label: 'CSV import',
    render: (c, close) =>
      <CsvImportPanel sessionId={c.session.sessionId} engine={c.session.engine}
          environment={c.session.environment} readOnly={c.session.readOnly} onClose={close}
          onSchemaChanged={() => window.dispatchEvent(new CustomEvent('dbgui:schema-changed'))} />,
  },
  playground: {
    label: 'Playground',
    render: (c, close) =>
      <PlaygroundPanel session={c.session} onClose={close} />,
  },
  quality: {
    label: 'SQL Quality',
    render: (c, close) =>
      <SqlQualityPanel session={c.session} onClose={close} />,
  },
  serverinfo: {
    label: 'Server',
    render: (c, close) =>
      <ServerInfoPanel sessionId={c.session.sessionId} engine={c.session.engine} onClose={close} />,
  },
  watch: {
    label: 'Watch',
    render: (c, close) =>
      <WatchPanel session={c.session} target={c.watchTarget}
          onTargetConsumed={c.clearWatchTarget} onClose={close} />,
  },
  locks: {
    label: 'Locks & Deadlocks',
    render: (c, close) =>
      <LocksPanel session={c.session} onClose={close} />,
  },
  querystore: {
    label: 'Query Store',
    render: (c, close) =>
      <Suspense fallback={null}><QueryStorePanel session={c.session} onClose={close} /></Suspense>,
  },
  users: {
    label: 'Users',
    render: (c, close) =>
      <UsersPanel sessionId={c.session.sessionId} engine={c.session.engine} onClose={close} />,
  },
  saved: {
    label: 'Saved',
    render: (c, close) =>
      <SavedQueriesPanel currentSql={c.currentEditorSql()}
          onInsert={sql => { const id = c.focusSqlTab(); c.insertIntoEditor(sql, id); }}
          onClose={close} />,
  },
  history: {
    label: 'History',
    render: (c, close) =>
      <HistoryPanel connectionId={c.session.connectionId}
          onSelect={c.handleHistorySelect} onClose={close} />,
  },
};

let _tabCounter = 1;

/** Next tab id from the shared sequence (SQL tabs and plugin tabs share it). */
function nextTabId(): number { return _tabCounter++; }

const pad2 = (n: number) => String(n).padStart(2, '0');

/**
 * A plugin tab: same shape as a SQL tab, `panel` decides what it renders.
 * The id is passed in and is STABLE per panel (see `idForPanel`), which makes
 * opening idempotent — two clicks in one tick can only ever mean one tab.
 */
function newPanelTab(panel: string, id: number): QueryTab {
  const meta = PANEL_META[panel];
  // The label is the NAME only. The icon is rendered separately, in a
  // fixed-width slot (<PanelIcon> — inline SVG, components/panelIcons.tsx),
  // because baked into the string it shifts every label after it and a row
  // of tabs never lines up. It also kept the icon inside the rename box
  // when you renamed a plugin tab.
  return { ...newTab(meta ? meta.label : panel), id, panel };
}

/**
 * A stable buffer id, minted once per tab and carried across restarts. Prefers
 * the platform UUID; the fallback keeps it working in any environment.
 */
function newBid(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `b-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

function newTab(label?: string): QueryTab {
  return {
    id: _tabCounter++, bid: newBid(), label: label ?? pad2(_tabCounter - 1),
    sql: '', result: null, resultSql: null, scriptResults: null, scriptBase: 0, stmtRuns: {}, explain: null,
    autoPlans: {}, planRuns: [],
    browsers: [], activeBrowser: 0, view: 'grid', error: null, running: false,
    autoLimited: null, prodCap: null,
  };
}

interface Props {
  session: Session;
  /** Every open session — TxShell writes to another one by name. */
  openSessions?: Session[];
  isActive?: boolean;
  insertTextRef?: React.MutableRefObject<((text: string) => void) | null>;
}

export function QueryTabs({ session, openSessions, isActive, insertTextRef }: Props) {
  // Restore whatever you were writing last time on this connection (utils/bufferStore).
  // One read, used by both initialisers below (it was parsed twice).
  const restoredRef = useRef<StoredBuffer[] | null>(null);
  if (restoredRef.current === null) restoredRef.current = loadBuffers(session.connectionId);

  // Persistent undo history (Editor §5.2). The blob (bufferId → serialized
  // CodeMirror history) lives in the connection's own instance directory. The
  // load is fired here, at the earliest point, so it races ahead of the *lazy*
  // SqlEditor chunk and is usually resident by the time an editor mounts; a tab
  // that mounts first simply opens with an empty undo stack — the safe default.
  const undoHistRef = useRef<HistoryBlob>({});
  const undoLoadStartedRef = useRef(false);
  // Bumped once when the blob lands, purely to re-render so each tab's
  // `initialHistory` prop re-reads the ref before its (lazy) editor mounts.
  const [undoTick, setUndoTick] = useState(0);
  void undoTick;
  if (!undoLoadStartedRef.current) {
    undoLoadStartedRef.current = true;
    void invoke<string | null>('instance_data_get', {
      connectionId: session.connectionId, key: EDITOR_HISTORY_KEY,
    })
      // Anything captured this session wins over the disk copy it came from.
      .then(raw => {
        undoHistRef.current = { ...parseHistoryBlob(raw), ...undoHistRef.current };
        setUndoTick(n => n + 1);
      })
      .catch(() => {});
  }

  const [tabs, setTabs] = useState<QueryTab[]>(() => {
    const saved = restoredRef.current ?? [];
    if (saved.length === 0) return [newTab('01')];
    // Keep the stored buffer id so the restored tab re-inherits its undo
    // history; mint a fresh one only for buffers saved before ids existed.
    return saved.map(b => ({
      ...newTab(b.label), sql: b.sql, color: b.color, ...(b.bid ? { bid: b.bid } : {}),
    }));
  });
  const tabsRef = useRef(tabs);
  useEffect(() => { tabsRef.current = tabs; }, [tabs]);
  // `null` when every tab is closed: a connected session may have zero tabs —
  // the tab bar (and its "+" and menus) stays, and the next tab is "01".
  const [activeId, setActiveId] = useState<number | null>(() => {
    const idx = (restoredRef.current ?? []).findIndex(b => b.active);
    return tabs[idx >= 0 ? idx : 0]?.id ?? 1;
  });
  const activeIdRef = useRef(activeId);
  useEffect(() => { activeIdRef.current = activeId; }, [activeId]);
  // One tab id per panel name, allocated on first use and reused afterwards.
  const panelIds = useRef(new Map<string, number>());
  const idForPanel = useCallback((panel: string) => {
    let id = panelIds.current.get(panel);
    if (id === undefined) { id = nextTabId(); panelIds.current.set(panel, id); }
    return id;
  }, []);

  /**
   * Commit a structural change (add / close / reorder) to the tab list.
   *
   * The updater runs against React's CURRENT state, never against a snapshot:
   * `patchTab`, the 250 ms SQL-sync and query-completion patches all use
   * functional updates and do not touch `tabsRef`, so committing a pre-computed
   * array would silently roll them back — a query that finished a moment before
   * you opened a tab would go back to looking like it was still running.
   * `tabsRef`/`activeIdRef` are refreshed in the same tick so back-to-back
   * actions (a fast double-click on "+") each see the previous one.
   */
  const commitTabs = useCallback(
    (update: (prev: QueryTab[]) => QueryTab[], nextActive?: number | null) => {
      setTabs(prev => {
        const next = update(prev);
        tabsRef.current = next;
        return next;
      });
      if (nextActive !== undefined) { activeIdRef.current = nextActive; setActiveId(nextActive); }
    }, []);
  // Manual transaction (autocommit off) — per session, held server-side.
  // UI state machine in utils/txUi (auto | pending | open) mirrors the backend:
  // end_transaction removes the held conn from the map BEFORE running COMMIT/
  // ROLLBACK, so any settled end — ok or failed — means back to autocommit.
  const [txMode, setTxModeState] = useState<TxMode>('auto');
  const txModeRef = useRef<TxMode>('auto');
  const setTxMode = useCallback((m: TxMode) => { txModeRef.current = m; setTxModeState(m); }, []);
  const txOpen = txIsOpen(txMode);
  const txOpenRef = useRef(txOpen);
  useEffect(() => { txOpenRef.current = txOpen; }, [txOpen]);
  const txBusy = txIsBusy(txMode);
  const beginTx = useCallback(async () => {
    const next = txReduce(txModeRef.current, 'begin');
    if (next === txModeRef.current) return;          // already pending/open
    setTxMode(next);
    try {
      await invoke('begin_transaction', { sessionId: session.sessionId });
      setTxMode(txReduce(txModeRef.current, 'begin-ok'));
      addLog(session.sessionId, { level: 'info', action: 'TX',
        detail: 'BEGIN — manual transaction opened', line: 'BEGIN' });
    } catch (e) {
      setTxMode(txReduce(txModeRef.current, 'begin-fail')); // stay AUTO, show the error
      addLog(session.sessionId, { level: 'err', action: 'TX', detail: errorDisplay(e),
        line: `! ${errorDisplay(e).replace(/\s+/g, ' ').trim()}` });
    }
  }, [session.sessionId, setTxMode]);
  /**
   * The server's own `@@autocommit`, shown beside the buttons.
   *
   * Kept separate from the app's model on purpose. `SET autocommit = 0` typed
   * into the editor changes ONE pooled connection out of several and nothing
   * else — without this readout that looks like it worked, and the first thing
   * the user learns otherwise is that their COMMIT settled nothing.
   * `null` = the engine has no such setting (PostgreSQL) or it is unknown yet.
   */
  const [serverAutocommit, setServerAutocommit] = useState<boolean | null>(null);

  const endTx = useCallback(async (cmd: 'commit_transaction' | 'rollback_transaction') => {
    const next = txReduce(txModeRef.current, 'end');
    if (next === txModeRef.current) return;          // not open (or already ending)
    setTxMode(next);
    try {
      await invoke(cmd, { sessionId: session.sessionId });
      addLog(session.sessionId, { level: 'ok', action: 'TX',
        detail: cmd === 'commit_transaction' ? 'COMMIT' : 'ROLLBACK',
        line: cmd === 'commit_transaction' ? 'COMMIT' : 'ROLLBACK' });
    } catch (e) {
      addLog(session.sessionId, { level: 'err', action: 'TX', detail: errorDisplay(e),
        line: `! ${errorDisplay(e).replace(/\s+/g, ' ').trim()}` });
    } finally {
      // Backend dropped the held conn either way (failed COMMIT rolls back on
      // drop) — autocommit is the truth again.
      setTxMode(txReduce(txModeRef.current, 'end-done'));
    }
  }, [session.sessionId, setTxMode]);


  // ── `kill …` / `killall` popup ────────────────────────────────────────────
  // The editor reports the command being typed; the picker takes over ↑↓⏎⇥
  // while the editor keeps focus. Esc dismisses THIS exact command (so it
  // doesn't pop straight back on the next keystroke) until the text changes.
  const [killCtx, setKillCtx] = useState<KillContext | null>(null);
  const killReplaceRef = useRef<((text: string) => void) | null>(null);
  const killDismissedRef = useRef<string | null>(null);
  const killSig = (c: KillContext) => `${c.trigger.kind}|${c.trigger.mode}|${c.trigger.filter}`;
  const handleKillContext = useCallback((ctx: KillContext | null) => {
    if (!ctx) { killDismissedRef.current = null; setKillCtx(null); return; }
    if (killDismissedRef.current === killSig(ctx)) return;
    killDismissedRef.current = null;
    // The popup is anchored ONCE, where it opened. Re-anchoring on every
    // keystroke made it hop around the screen while you typed a filter; the
    // only thing that may move it afterwards is the user, by dragging it.
    setKillCtx(prev => prev
      ? { trigger: ctx.trigger, anchor: prev.anchor }
      : ctx);
  }, []);
  const closeKillPicker = useCallback(() => {
    setKillCtx(prev => { if (prev) killDismissedRef.current = killSig(prev); return null; });
  }, []);
  // Another tab in front means the caret we anchored to is gone.
  useEffect(() => { setKillCtx(null); killDismissedRef.current = null; }, [activeId]);

  // `tabId` on the deferred-run states pins the run to the tab that launched it,
  // so approving a modal after switching tabs (⌘T) can't retarget the write.
  // `from` is the statement's buffer offset — the gutter marker needs it after
  // the modal round-trip exactly as an immediate run does.
  const [writeAsk, setWriteAsk] = useState<(WriteConfirmRequest & { tabId: number; from?: number; noResults?: boolean }) | null>(null);
  /** A script held at the gate: the verdict, and the SQL to run if approved. */
  const [preflight, setPreflight] = useState<{ report: PreflightReport; sql: string; tabId: number; from?: number; noResults?: boolean } | null>(null);
  // A mid-script failure parks here until the user answers; `resolve` is the
  // executeSql loop waiting on the promise.
  const [scriptAsk, setScriptAsk] = useState<ScriptErrorRequest | null>(null);
  const [varPrompt, setVarPrompt] = useState<{ vars: string[]; sql: string; tabId: number; from?: number; noResults?: boolean } | null>(null);
  // Quick Definition: peek an object's DDL inline (⌘Y from the editor).
  const [peekDdl, setPeekDdl] = useState<{ title: string; sql: string } | null>(null);
  // AI assistant modal (⌘I generate / explain / fix).
  const [aiModal, setAiModal] = useState<{ mode: AiMode; sql?: string; error?: string } | null>(null);
  // MySQL optimizer-trace viewer (pretty-printed JSON).
  const [traceJson, setTraceJson] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<number | null>(null);
  const [tabMenu, setTabMenu] = useState<{ x: number; y: number; id: number } | null>(null);
  /** The Run button's caret menu (Run script — no result tabs). */
  const [runMenu, setRunMenu] = useState<{ x: number; y: number; tabId: number } | null>(null);
  // Reflected on the toolbar's wrap button; the editor owns the actual state
  // and broadcasts a prefs-changed event when it flips.
  const [editorWrap] = usePreference(PREFS.editorWrap);
  /** Which table the designer should open — set by the diagram or the tree. */
  const [designTarget, setDesignTarget] = useState<{ schema: string; table: string | null } | null>(null);
  /** Which routine the routine editor should open — set by the schema tree.
      `table` is carried for PostgreSQL triggers, which are named per-table. */
  const [routineTarget, setRoutineTarget] = useState<{ schema: string; name: string; kind: string; table?: string } | null>(null);
  /** Which sequence the sequence editor should open — set by the schema tree. */
  const [sequenceTarget, setSequenceTarget] = useState<{ schema: string; name: string } | null>(null);
  /** Which type the type editor should open — set by the schema tree. */
  const [typeTarget, setTypeTarget] = useState<{ schema: string; name: string; kind: string } | null>(null);
  /** Which view/matview the view editor should open — set by the schema tree. */
  const [viewTarget, setViewTarget] = useState<{ schema: string; name: string; kind: string } | null>(null);
  /** Which dictionary the dictionary editor should open — set by the schema tree. */
  const [dictionaryTarget, setDictionaryTarget] = useState<{ schema: string; name: string } | null>(null);
  /** Which scope the Find panel should open on — set by a scope-carrying open. */
  const [findScope, setFindScope] = useState<FindScope | null>(null);
  /** Which mode the Compare panel should open on — set by a scope-carrying open. */
  const [compareScope, setCompareScope] = useState<CompareScope | null>(null);
  /** Which mode (+ optional pinned thread) the Watch panel should open on —
      set by Processes' "watch this thread". */
  const [watchTarget, setWatchTarget] = useState<WatchTarget | null>(null);
  // Stable so the panels' consume effects don't re-fire on every parent render.
  const clearRoutineTarget = useCallback(() => setRoutineTarget(null), []);
  const clearSequenceTarget = useCallback(() => setSequenceTarget(null), []);
  const clearTypeTarget = useCallback(() => setTypeTarget(null), []);
  const clearViewTarget = useCallback(() => setViewTarget(null), []);
  const clearDictionaryTarget = useCallback(() => setDictionaryTarget(null), []);
  const clearFindScope = useCallback(() => setFindScope(null), []);
  const clearCompareScope = useCallback(() => setCompareScope(null), []);
  const clearWatchTarget = useCallback(() => setWatchTarget(null), []);
  /**
   * `togglePanel` is declared below the listener effect, so the listener
   * reaches it through a ref rather than the binding, which is still in its
   * temporal dead zone when the effect body is created.
   */
  const togglePanelRef = useRef<((panel: string) => void) | null>(null);
  const [showInvisibles, setShowInvisibles] = usePreference(PREFS.editorInvisibles);
  const [editorZoom, setEditorZoom] = usePreference(PREFS.editorZoom);
  /** ±10 from the keyboard, 0 resets. Clamped so the text stays legible. */

  // ── Tab reordering ──────────────────────────────────────────────────────
  const dragTabRef = useRef<number | null>(null);
  const [dragOverId, setDragOverId] = useState<number | null>(null);

  /**
   * Move `from` to sit where `to` currently is.
   *
   * Pinned tabs are held at the front afterwards, so dropping an ordinary tab
   * before a pinned one cannot quietly unpin it by position.
   */
  const moveTab = useCallback((from: number, to: number) => {
    setTabs(prev => {
      const src = prev.findIndex(t => t.id === from);
      const dst = prev.findIndex(t => t.id === to);
      if (src < 0 || dst < 0) return prev;
      const next = [...prev];
      const [moved] = next.splice(src, 1);
      next.splice(dst, 0, moved);
      const pinned = next.filter(t => t.pinned);
      const rest = next.filter(t => !t.pinned);
      return [...pinned, ...rest];
    });
  }, []);

  // ── Timed backups ───────────────────────────────────────────────────────
  //
  // `bufferStore` keeps the *current* text, which covers "the app closed".
  // This covers "I deleted three hundred lines and saved twenty minutes ago",
  // for which only an older copy helps. Written to the connection's own
  // instance directory, so snapshots belong to the server they were taken
  // against.
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [recoverOpen, setRecoverOpen] = useState(false);

  // ── Plugin menu bar ──────────────────────────────────────────────────────
  //
  // The dropdowns at the right end of the tab bar (Activity, Insights, Server,
  // Schema, Data, Find & Compare, SQL — grouping in utils/pluginMenu.ts). Menubar conventions: click
  // a title to open, and while one is open, hovering another title switches
  // to it. `right`/`top` anchor the open list with position:fixed because
  // .qtab-bar clips overflow (overflow-x: auto), which would cut a normally
  // positioned dropdown off at the bar's 34 px.
  const [openMenu, setOpenMenu] = useState<{
    id: string; top: number; left?: number; right?: number;
  } | null>(null);
  const menuBarRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!openMenu) return;
    const onDown = (e: MouseEvent) => {
      if (!menuBarRef.current?.contains(e.target as Node)) setOpenMenu(null);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpenMenu(null); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [openMenu]);
  /** Open a menu anchored to its title button (click, or hover-switch). */
  const openMenuAt = (id: string, el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    // The dropdown opens under the START of the menu word — its left edge at
    // the button's left edge. The last two menus sit at the window's right
    // edge, where that would push the list off-screen, so they stay anchored
    // to the button's right edge and open leftward.
    setOpenMenu(RIGHT_ANCHORED_MENUS.has(id)
      ? { id, right: window.innerWidth - r.right, top: r.bottom + 2 }
      : { id, left: r.left, top: r.bottom + 2 });
  };

  useEffect(() => {
    let gone = false;
    invoke<string | null>('instance_data_get', {
      connectionId: session.connectionId, key: BACKUP_KEY,
    })
      .then(t => { if (!gone) setSnapshots(parseBackups(t)); })
      .catch(() => {});
    return () => { gone = true; };
  }, [session.connectionId]);

  useEffect(() => {
    const tick = () => {
      setSnapshots(prev => {
        let next = prev;
        for (const t of tabsRef.current) {
          if (t.panel) continue;
          const text = sqlRefs.current.get(t.id) ?? t.sql ?? '';
          next = addSnapshot(next, {
            label: t.label,
            ...(t.file ? { path: t.file.path } : {}),
            at: Date.now(),
            text,
          });
        }
        if (next !== prev) {
          // Scratch keeps its snapshots in memory only — the instance file
          // would be keyed to a one-off UUID nobody can ever read back.
          if (session.scratch) return next;
          void invoke('instance_data_set', {
            connectionId: session.connectionId,
            key: BACKUP_KEY,
            value: serializeBackups(next),
          }).catch(() => {});   // a failed backup must never interrupt editing
        }
        return next;
      });
    };
    const id = window.setInterval(tick, BACKUP_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [session.connectionId, session.scratch]);

  // ── Files ───────────────────────────────────────────────────────────────

  /**
   * a per-render helper would be rebuilt on every render, so anything that
   * depends on it is rebuilt too — and a focus listener that re-subscribes
   * every render is a listener that misses events. `setTabs` is stable, so
   * this equivalent has no dependencies.
   */
  const patchTab = useCallback((id: number, patch: Partial<QueryTab>) => {
    const clean = Object.fromEntries(
      Object.entries(patch).filter(([, v]) => v !== undefined)) as Partial<QueryTab>;
    setTabs(prev => prev.map(t => (t.id === id ? { ...t, ...clean } : t)));
  }, []);

  /**
   * Open a plugin panel, or focus the tab that already holds it — the
   * "open-or-focus dance" the schema tree's edit-X events all share (WP-16
   * 16.1). Reads through refs, so it is safe to call from the stable
   * global-shortcut listeners.
   */
  const openOrFocusPanel = useCallback((panel: string) => {
    const existing = tabsRef.current.find(t => t.panel === panel);
    if (existing) setActiveId(existing.id);
    else togglePanelRef.current?.(panel);
  }, []);

  const rememberRecent = useCallback((path: string) => {
    try {
      const next = pushRecent(parseRecent(localStorage.getItem(RECENT_KEY)), path);
      localStorage.setItem(RECENT_KEY, JSON.stringify(next));
      window.dispatchEvent(new CustomEvent('dbgui:recent-files-changed'));
    } catch { /* quota — the list is a convenience, not state */ }
  }, []);

  /**
   * Save the active tab. `forceDialog` is Save As.
   *
   * Two guards worth their weight: a bound path is written in place, which is
   * the whole point of keeping it; and before overwriting we re-stat, so a
   * file edited outside the app is not silently clobbered by a buffer that
   * predates the change.
   */
  const saveActive = useCallback(async (forceDialog: boolean) => {
    const id = activeIdRef.current;
    if (id === null) return;          // no tabs open — nothing to save
    const tab = tabsRef.current.find(t => t.id === id);
    if (!tab || tab.panel) return;   // a plugin tab has no document
    const text = sqlRefs.current.get(id) ?? tab.sql ?? '';
    let file = tab.file;

    if (file && !forceDialog) {
      try {
        const stat = await invoke<{ mtimeMs: number } | null>('sqlfile_stat', { path: file.path });
        const state = diskState(file, stat ? { mtimeMs: stat.mtimeMs } : null);
        if (state === 'changed' && !await confirmDialog(
          `${file.path}\n\nhas changed on disk since you opened it.\n\nOverwrite it with what is in the editor?`)) {
          return;
        }
      } catch { /* unreadable — let the write report the real reason */ }
    }

    if (!file || forceDialog) {
      const picked = await saveDialog({
        defaultPath: file?.path ?? `${tab.label || 'query'}.sql`,
        filters: [{ name: 'SQL', extensions: ['sql', 'txt'] }],
      });
      if (typeof picked !== 'string') return;      // cancelled
      file = {
        path: picked,
        encoding: file?.encoding ?? 'UTF-8',
        eol: file?.eol ?? 'lf',
        mtimeMs: 0,
        savedText: '',
      };
    }

    try {
      // The mtime we loaded/last saved at rides along: the backend refuses
      // when the file is newer on disk (an external edit), and we ask before
      // overwriting instead of silently clobbering it (WP-13 13.1).
      let stat: { mtimeMs: number };
      try {
        stat = await invoke<{ mtimeMs: number }>('sqlfile_save', {
          path: file.path, text, encoding: file.encoding, eol: file.eol,
          expectedMtimeMs: file.mtimeMs || null,
        });
      } catch (err) {
        if (!String(errorDisplay(err)).includes('changed on disk')) throw err;
        const overwrite = await confirmDialog(
          `${file.path} changed on disk since it was loaded — someone else edited it.\n\nOverwrite their changes?`,
          { danger: true, okLabel: 'Overwrite' });
        if (!overwrite) return;
        stat = await invoke<{ mtimeMs: number }>('sqlfile_save', {
          path: file.path, text, encoding: file.encoding, eol: file.eol,
          expectedMtimeMs: null,
        });
      }
      patchTab(id, {
        file: { ...file, mtimeMs: stat.mtimeMs, savedText: text },
        label: tabLabelFor(file.path),
        dirty: false,
        error: null,
      });
      rememberRecent(file.path);
    } catch (err) {
      // A silently unwritten file is indistinguishable from a written one.
      patchTab(id, { error: `Could not save: ${errorDisplay(err)}` });
    }
  }, [patchTab, rememberRecent]);

  /** Encoding labels the backend offers, fetched once. */
  const [encodings, setEncodings] = useState<string[]>(['UTF-8']);
  useEffect(() => {
    invoke<string[]>('sqlfile_encodings').then(setEncodings).catch(() => {});
  }, []);

  /**
   * Re-read the file with a different encoding.
   *
   * Re-reads rather than re-interpreting the string in memory, because the
   * original bytes are the only place the information still exists — once a
   * CP1250 file has been decoded as UTF-8, the damage cannot be undone from
   * the text.
   */
  const reopenWithEncoding = useCallback(async (id: number, encoding: string) => {
    const tab = tabsRef.current.find(t => t.id === id);
    if (!tab?.file) return;
    if (isDirty(tab.file, sqlRefs.current.get(id) ?? tab.sql ?? '')
        && !await confirmDialog('Re-reading the file discards your unsaved edits. Continue?')) {
      return;
    }
    try {
      const r = await invoke<{ text: string; encoding: string; eol: Eol; mtimeMs: number }>(
        'sqlfile_open', { path: tab.file.path, encoding });
      sqlRefs.current.set(id, r.text);
      patchTab(id, {
        sql: r.text,
        file: { path: tab.file.path, encoding: r.encoding, eol: r.eol, mtimeMs: r.mtimeMs, savedText: r.text },
        dirty: false,
        error: null,
      });
    } catch (err) {
      patchTab(id, { error: `Could not re-read as ${encoding}: ${errorDisplay(err)}` });
    }
  }, [patchTab]);

  /** Re-read a bound file from disk, discarding the buffer. */
  const reloadFromDisk = useCallback(async (id: number) => {
    const tab = tabsRef.current.find(t => t.id === id);
    if (!tab?.file) return;
    try {
      const r = await invoke<{ text: string; encoding: string; eol: Eol; mtimeMs: number }>(
        'sqlfile_open', { path: tab.file.path, encoding: tab.file.encoding });
      sqlRefs.current.set(id, r.text);
      patchTab(id, {
        sql: r.text,
        file: { path: tab.file.path, encoding: r.encoding, eol: r.eol, mtimeMs: r.mtimeMs, savedText: r.text },
        dirty: false,
        error: null,
      });
    } catch (err) {
      patchTab(id, { error: `Could not reload: ${errorDisplay(err)}` });
    }
  }, [patchTab]);

  /**
   * Notice files that changed underneath us.
   *
   * On window focus, because that is when the user has plausibly just been in
   * another tool. A clean buffer reloads silently — there is nothing to lose
   * and nothing to ask about. A dirty one asks, because either answer discards
   * somebody's work.
   */
  // Reached through refs so a focus
  // listener that re-subscribes that often is a listener that misses events.
  const saveActiveRef = useRef(saveActive);
  useEffect(() => { saveActiveRef.current = saveActive; }, [saveActive]);
  const rememberRecentRef = useRef(rememberRecent);
  useEffect(() => { rememberRecentRef.current = rememberRecent; }, [rememberRecent]);
  const reloadRef = useRef(reloadFromDisk);
  useEffect(() => { reloadRef.current = reloadFromDisk; }, [reloadFromDisk]);

  useEffect(() => {
    const check = async () => {
      for (const tab of tabsRef.current) {
        if (!tab.file) continue;
        let stat: { mtimeMs: number } | null = null;
        try {
          stat = await invoke<{ mtimeMs: number } | null>('sqlfile_stat', { path: tab.file.path });
        } catch { continue; }
        const state = diskState(tab.file, stat);
        if (state === 'same') continue;
        if (state === 'deleted') {
          patchTab(tab.id, { error: `${tab.file.path} no longer exists on disk.` });
          continue;
        }
        const current = sqlRefs.current.get(tab.id) ?? tab.sql ?? '';
        if (!isDirty(tab.file, current)) {
          void reloadRef.current(tab.id);
        } else if (await confirmDialog(
          `${tab.file.path}\n\nhas changed on disk, and you have unsaved edits.\n\n`
          + 'Reload from disk and lose your edits?')) {
          void reloadRef.current(tab.id);
        } else {
          // Accept theirs as the new baseline so we stop asking every focus;
          // the next save will still warn before overwriting.
          patchTab(tab.id, { file: { ...tab.file, mtimeMs: stat!.mtimeMs } });
        }
      }
    };
    window.addEventListener('focus', check);
    return () => window.removeEventListener('focus', check);
  }, [patchTab]);

  const bumpZoom = useCallback((delta: number) => {
    setEditorZoom(delta === 0 ? 100 : Math.max(50, Math.min(300, editorZoom + delta)));
  }, [editorZoom, setEditorZoom]);


  // A Parquet file has no query engine at all: no EXPLAIN, no transactions,
  // no sessions. SQLite is a real SQL engine but an in-process one, so it has
  // no server-side anything either — no processlist, no server settings.


  // Processlist + kill: MySQL threads, PG backends, Redis clients
  // (CLIENT LIST / CLIENT KILL), ClickHouse system.processes.
  const supportsProcesses = can(session.engine, 'processList');
  /**
   * What the *role* may do, probed once per session (store/sessionPrivileges).
   * The engine says whether a panel exists at all; this says whether this
   * account can use the one that does.
   */
  const privs = useSessionPrivileges(session.sessionId, session.engine);
  // Panels that are genuinely SQL-only (tuner rule sets, replication
  // topology, ANALYZE, locks, GRANTs, saved SQL, the playground).
  const supportsSqlDba = can(session.engine, 'sqlDba');
  // MySQL and MariaDB do not accept the same statements, so completion has to
  // know which one this is. Probed once per session and cached. The whole
  // flavour object is kept: menu gates (Sequences) read its capabilities too.
  const serverFlavor = useServerFlavor(session.sessionId, session.engine);
  const editorFlavor = serverFlavor.flavor;
  // Every engine has a settings + status view now: MySQL SHOW VARIABLES/STATUS,
  // PostgreSQL pg_settings/pg_stat_database, Redis CONFIG GET / INFO,
  // ClickHouse system.settings / system.metrics.
  const supportsServerInfo = can(session.engine, 'serverInfo');
  // ── Default-database "roulette": editor queries run against this DB ────────
  // MySQL USEs it, PostgreSQL sets search_path, ClickHouse sends it as a
  // request parameter (there is no USE over the HTTP interface).
  const supportsDbSelect = can(session.engine, 'databaseSelect');
  const [dbList, setDbList] = useState<string[]>([]);
  const [currentDb, setCurrentDb] = useState('');
  // Read inside callbacks that must not re-create on every database switch.
  const currentDbRef = useRef(currentDb);
  useEffect(() => { currentDbRef.current = currentDb; }, [currentDb]);
  useEffect(() => {
    if (!supportsDbSelect) return;
    invoke<QueryResult>('monitor_query', {
      sessionId: session.sessionId,
      sql: session.engine === 'mysql' ? 'SELECT DATABASE()'
         : session.engine === 'clickhouse' ? 'SELECT currentDatabase()'
         : 'SELECT current_schema()',
    }).then(r => setCurrentDb(String(r.rows[0]?.[0] ?? '') === 'null' ? '' : String(r.rows[0]?.[0] ?? '')))
      .catch(() => {});
    SchemaStore.listSchema(session.sessionId)
      .then(nodes => setDbList(
        nodes.filter(n => n.kind === 'database' || n.kind === 'schema').map(n => n.name)))
      .catch(() => {});
  }, [session.sessionId, session.engine, supportsDbSelect]);

  const changeDb = useCallback(async (db: string) => {
    try {
      await invoke('set_session_db', { sessionId: session.sessionId, db: db || null });
      setCurrentDb(db);
    } catch (e) {
      await alertDialog(errorDisplay(e));
    }
  }, [session.sessionId]);

  const {
    completions, getColumns, getFks, getSchemaTables,
    getServerVariables, getIndexedColumns, getRoutineSignature,
  } = useSchemaCompletions(session, currentDb);
  // ── Editor / result vertical split ───────────────────────────────────────
  // The user is the master: either pane may be dragged to near-total
  // dominance. The only reserve is SPLIT_MIN px so the collapsed pane's strip
  // (editor first line / result tab bar) stays visible and clickable — plus
  // the fixed chrome (editor toolbar, drag handle, status bar) which is
  // measured live off the active tab's wrap, so the cap tracks window resizes
  // and font scaling instead of being a hardcoded pixel cage.
  const SPLIT_MIN = 32;
  const [splitMax, setSplitMax] = useState(0); // px available to the editor pane
  const splitRORef = useRef<ResizeObserver | null>(null);
  const splitWrapRef = useCallback((el: HTMLDivElement | null) => {
    splitRORef.current?.disconnect();
    splitRORef.current = null;
    if (!el) return;
    const update = () => {
      const toolbar = el.querySelector<HTMLElement>(':scope > .editor-toolbar');
      const statusbar = el.querySelector<HTMLElement>(':scope > .qtab-statusbar');
      const chrome = (toolbar?.offsetHeight ?? 0) + 5 /* .v-resizer */
        + (statusbar?.offsetHeight ?? 0) + SPLIT_MIN;
      setSplitMax(Math.max(SPLIT_MIN, el.clientHeight - chrome));
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    splitRORef.current = ro;
  }, [SPLIT_MIN]);
  const [editorH, dragEditor] = useResizable('dbgui.editorH', 220, SPLIT_MIN, splitMax || 5000, 'y');
  // A persisted height from a larger window must not squash the result pane
  // after a resize — clamp what we render; the stored value is untouched and
  // becomes valid again when the window grows.
  const effEditorH = splitMax > 0 ? Math.min(editorH, splitMax) : editorH;

  // ── Default row limit (SELECT without LIMIT gets capped) ───────────────────
  const [defaultLimit, setDefaultLimitState] = useState<number>(() => {
    const raw = Number(localStorage.getItem('dbgui.defaultLimit'));
    return Number.isFinite(raw) && raw >= 0 ? raw : 1000;
  });
  const defaultLimitRef = useRef(defaultLimit);
  useEffect(() => { defaultLimitRef.current = defaultLimit; }, [defaultLimit]);
  // The status-bar LIMIT choice is a deliberate per-session override — it wins
  // over the prod row cap (which is why the cap is "soft").
  const limitTouchedRef = useRef(false);
  const setDefaultLimit = (n: number) => {
    limitTouchedRef.current = true;
    setDefaultLimitState(n);
    try { localStorage.setItem('dbgui.defaultLimit', String(n)); } catch { /* quota */ }
  };

  // ── Per-session activity log (📓 Log tab, store-backed) ────────────────────
  // The log CONTENT is consumed only by the leaf LogView component, which
  // subscribes itself — QueryTabs must not re-render per log line (WP-06).
  // Here only the cheap 0↔1 "has anything been logged" signal is read.
  const sid = session.sessionId;
  const sessionLogNonEmpty = useSessionLogNonEmpty(sid);
  /**
   * The active result grid, so the 🗺 Map can select the row a point came
   * from. One ref rather than one per tab: only the visible grid can be
   * driven, and only the visible map can drive it.
   */
  const gridApiRef = useRef<FastGridApi | null>(null);
  // Scope lives HERE (not in LogView) because the view unmounts on result-tab
  // switches and the chosen scope must survive that.
  const [logScope, setLogScope] = useState<'session' | 'run'>('session');
  // Full connection config (log_dir, prod hard-limit flags) — fetched once.
  const [connCfg, setConnCfg] = useState<ConnectionConfig | null>(null);

  /**
   * A connection configured without autocommit holds a transaction open for its
   * whole life: opened on connect, and re-opened the instant one is settled.
   *
   * Without the re-open there would be a window after every Commit where the
   * next statement silently autocommitted — the one moment a user is least
   * expecting it, having just deliberately committed.
   */
  const manualCommit = connCfg?.autocommit === false;
  const txCtl = txControls(txMode, manualCommit, serverAutocommit);
  // A refused BEGIN drops the machine back to `auto`, which would re-trigger
  // this effect — a tight retry loop against a server that just said no. One
  // failure stops the re-pinning for the session; the toolbar then shows
  // ⚡ AUTO and the @@autocommit mismatch, which is the honest report.
  const pinFailed = useRef(false);
  useEffect(() => {
    if (!manualCommit || pinFailed.current) return;
    if (session.engine !== 'mysql' && session.engine !== 'postgres') return;
    if (txMode !== 'auto') return;
    void beginTx().then(() => {
      if (txModeRef.current === 'auto') pinFailed.current = true;
    });
  }, [manualCommit, txMode, session.engine, beginTx]);

  // Poll the server's own setting: on connect, and after every transition, so a
  // disagreement surfaces rather than waiting to be discovered.
  useEffect(() => {
    // SQL Server joins the poll: it reports autocommit from @@OPTIONS bit 2
    // (IMPLICIT_TRANSACTIONS clear), so the mismatch warning works there too.
    if (session.engine !== 'mysql' && session.engine !== 'postgres'
        && session.engine !== 'sqlserver') return;
    let cancelled = false;
    invoke<{ held: boolean; server_autocommit: boolean | null }>(
      'tx_status', { sessionId: session.sessionId })
      .then(st => { if (!cancelled) setServerAutocommit(st.server_autocommit); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [session.sessionId, session.engine, txMode]);
  // Auto-open the Log view once per session; log the disconnect on the way out
  // (before dropLog wipes the buffer, so the server-log sink still sees it).
  useEffect(() => {
    setTabs(prev => prev.map((t, i) => i === 0 ? { ...t, view: 'log' } : t));
    return () => {
      addLog(sid, { level: 'info', action: 'DISCONNECT',
        detail: `Disconnected from ${session.connectionName}`,
        line: `Disconnected from ${session.connectionName}` });
      dropLog(sid);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sid]);
  // Seed the CONNECT line + wire the server-log sink once the config arrives.
  useEffect(() => {
    let alive = true;
    ConnectionsStore.list()
      .then(list => list.find(c => c.id === session.connectionId) ?? null)
      .catch(() => null)
      .then(cfg => {
        if (!alive) return;
        setConnCfg(cfg);
        // Server log to directory: every canonical line is mirrored to
        // <log_dir>/<connection>.log by the backend — fire-and-forget.
        // Registered BEFORE the CONNECT line so it, too, lands in the file.
        if (getPref(PREFS.serverLog) && cfg?.log_dir) {
          setLogSink(sid, line => {
            invoke('append_server_log', { connectionId: session.connectionId, lines: [line] })
              .catch(() => {});
          });
        }
        // Name this session before the CONNECT line is written, so the very
        // first entry in the joined view already says which connection it is.
        setSessionLabel(sid, session.connectionName);
        const target = session.scratch
          ? 'duckdb :memory: — scratch, nothing persists'
          : cfg?.socket_path
            ? `${session.engine} ${cfg.socket_path}`
            : `${session.engine} ${cfg?.host ?? ''}${cfg?.port != null ? `:${cfg.port}` : ''}`;
        addLog(sid, { level: 'ok', action: 'CONNECT',
          detail: `Connected to ${session.connectionName} (${target})`,
          line: `Connected to ${session.connectionName} (${target})` });
      });
    return () => { alive = false; setLogSink(sid, null); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sid]);

  // ── Command aliases (saved queries invoked by name + params) ──────────────
  const aliasesRef = useRef<Map<string, AliasDef>>(new Map());
  useEffect(() => {
    const load = () =>
      invoke<{ name: string; sql: string }[]>('list_saved_queries')
        .then(list => {
          aliasesRef.current = new Map(
            list.map(q => [q.name.toLowerCase(), { name: q.name, sql: q.sql }]));
        })
        .catch(() => {});
    load();
    window.addEventListener('dbgui:saved-queries-changed', load);
    return () => window.removeEventListener('dbgui:saved-queries-changed', load);
  }, []);

  // One insert handle per SQL tab. Plugin tabs are tabs now, so "send this SQL
  // to the editor" has to name a target editor instead of assuming the active
  // one — `lastSqlTabRef` remembers the SQL tab you came from.
  const insertRefs = useRef<Map<number, React.MutableRefObject<((text: string) => void) | null>>>(new Map());
  const insertRefFor = (id: number) => {
    let ref = insertRefs.current.get(id);
    if (!ref) { ref = { current: null }; insertRefs.current.set(id, ref); }
    return ref;
  };
  const lastSqlTabRef = useRef<number>(0);
  /** Push text into a SQL tab's editor (default: the last SQL tab in focus). */
  const insertIntoEditor = useCallback((text: string, tabId?: number) => {
    const id = tabId ?? lastSqlTabRef.current;
    insertRefs.current.get(id)?.current?.(text);
  }, []);
  /** Focus the SQL tab a plugin should hand its SQL to, creating one if needed. */
  const focusSqlTab = useCallback((): number => {
    const target = tabModel.sqlTabTarget(tabsRef.current, lastSqlTabRef.current);
    if (target) {
      activeIdRef.current = target.id;
      setActiveId(target.id);
      return target.id;
    }
    const tab = newTab(tabModel.nextSqlLabel(tabsRef.current));
    commitTabs(prev => tabModel.addTab(prev, tab).tabs, tab.id);
    return tab.id;
  }, [commitTabs]);

  // Connect parent ref → the editor of the SQL tab in focus
  useEffect(() => {
    if (!insertTextRef) return;
    insertTextRef.current = (text) => insertIntoEditor(text);
  }, [insertTextRef, insertIntoEditor]);

  const activeTab = tabs.find(t => t.id === activeId) ?? tabs[0];

  /**
   * Live ClickHouse read progress, per tab. Fed by the backend's
   * `dbgui:ch-progress` event (rows/bytes/percent from `X-ClickHouse-Progress`
   * headers + `system.processes`) while a query runs. Keyed by tabId; other
   * engines never emit, so this stays empty for them.
   */
  const [chProgress, setChProgress] = useState<Record<number, ChProgressEvent>>({});
  useEffect(() => {
    if (session.engine !== 'clickhouse') return;
    const un = listen<ChProgressEvent>('dbgui:ch-progress', e => {
      const p = e.payload;
      if (p.sessionId !== session.sessionId) return;
      setChProgress(prev => ({ ...prev, [p.tabId]: p }));
    });
    return () => { un.then(f => f()); };
  }, [session.engine, session.sessionId]);
  // Drop a tab's progress once it is no longer running, so a finished query
  // does not leave a stale figure next to an idle tab.
  useEffect(() => {
    setChProgress(prev => {
      const running = new Set(tabs.filter(t => t.running).map(t => t.id));
      let changed = false;
      const next: Record<number, ChProgressEvent> = {};
      for (const [id, v] of Object.entries(prev)) {
        if (running.has(Number(id))) next[Number(id)] = v;
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [tabs]);

  /** Which plugin tab is in front (null when a SQL tab is). */
  const activePanel = activeTab?.panel ?? null;
  /** Menu items show two states: a tab exists (`open`) and it is in front (`active`). */
  const openPanels = useMemo(
    () => new Set(tabs.filter(t => t.panel).map(t => t.panel as string)), [tabs]);

  /**
   * Does this session's engine offer the menu item at all? The `when` table
   * (utils/pluginMenu.ts) as one predicate — the conditions the icon buttons
   * used to render under inline.
   */
  const menuItemVisible = (it: PluginMenuItem) => {
    // A REGISTERED gap stays on the menu, greyed, with its reason — the house
    // rule for anything a user has cause to expect and would otherwise think
    // was missing or broken (utils/engineGaps.ts). Everything else keeps the
    // filtering: nobody needs an ER diagram greyed on Redis.
    if (engineGapReason(session.engine, it.panel)) return true;
    if (!it.when) return true;
    if (it.when === 'mysql') return session.engine === 'mysql';
    if (it.when === 'postgres') return session.engine === 'postgres';
    if (it.when === 'clickhouse') return session.engine === 'clickhouse';
    // The static `sequences` cap says "this engine family can have them"; for
    // the mysql engine the runtime flavour decides — plain MySQL has none,
    // MariaDB ≥ 10.3 does. Until the probe lands the UNKNOWN flavour yields
    // false, and the cache's re-render reveals the item on MariaDB.
    if (it.when === 'sequences' && session.engine === 'mysql') {
      return capabilities(serverFlavor).sequences;
    }
    return can(session.engine, it.when);
  };

  // Persist the buffers: debounced while typing (the text itself is synced into
  // state on a 250 ms debounce already), and once more on unmount so a
  // disconnect or a quit never loses the last keystrokes.
  //
  // A scratch session is the exception: its connectionId is a one-off UUID,
  // so a persisted buffer could never be restored — it would be localStorage
  // garbage keyed to a dead id. Scratch means nothing persists, by definition.
  const persistBuffers = useCallback(() => {
    if (session.scratch) return;
    saveBuffers(session.connectionId, tabsRef.current
      .filter(t => !t.panel)
      .map(t => ({
        label: t.label,
        color: t.color,
        sql: sqlRefs.current.get(t.id) ?? t.sql,
        active: t.id === activeIdRef.current,
        bid: t.bid,
      })));
  }, [session.connectionId, session.scratch]);
  useEffect(() => {
    const t = window.setTimeout(persistBuffers, 700);
    return () => window.clearTimeout(t);
  }, [tabs, activeId, persistBuffers]);
  useEffect(() => () => persistBuffers(), [persistBuffers]);

  // Persist the undo history alongside the buffers (Editor §5.2). Serialized
  // pruned to the tabs still open, and the in-memory copy is pruned to match so
  // a long session of open/close does not accumulate dead stacks. Debounced on
  // change, and flushed once on unmount so a disconnect keeps the last edits.
  const undoPersistTimer = useRef(0);
  const persistUndoHistory = useCallback(() => {
    if (session.scratch) return;   // scratch persists nothing (see persistBuffers)
    const bids = tabsRef.current.filter(t => !t.panel).map(t => t.bid);
    const value = serializeHistoryBlob(undoHistRef.current, bids);
    undoHistRef.current = parseHistoryBlob(value);
    void invoke('instance_data_set', {
      connectionId: session.connectionId, key: EDITOR_HISTORY_KEY, value,
    }).catch(() => {});   // a failed history save must never interrupt editing
  }, [session.connectionId, session.scratch]);
  const rememberHistory = useCallback((bid: string, h: unknown) => {
    undoHistRef.current = withHistory(undoHistRef.current, bid, h);
    window.clearTimeout(undoPersistTimer.current);
    undoPersistTimer.current = window.setTimeout(persistUndoHistory, 900);
  }, [persistUndoHistory]);
  useEffect(() => () => {
    window.clearTimeout(undoPersistTimer.current);
    persistUndoHistory();
  }, [persistUndoHistory]);

  // Disconnecting takes the whole workspace away, so a Playground run would be
  // left with nothing to manage it — stop it here (closing its TAB does not).
  useEffect(() => () => {
    stopSessionRuns(session.sessionId);
    clearSessionActivities(session.sessionId);
    forgetKillPickerState(session.sessionId);
  }, [session.sessionId]);

  const activityKeyOf = useCallback((tab: QueryTab) => tab.panel
    ? panelTabKey(session.sessionId, tab.panel)
    : sqlTabKey(session.sessionId, tab.id), [session.sessionId]);

  /**
   * Release a closed tab's per-tab memory. It deliberately does NOT clear the
   * activity registry: "Close, keep running" means the work is still running and
   * the disconnect guard must still see it. Only the *Kill & close* branch
   * clears, after the work has actually been stopped.
   */
  const forgetTabRefs = useCallback((tab: QueryTab | undefined) => {
    if (!tab || tab.panel) return;
    sqlRefs.current.delete(tab.id);
    insertRefs.current.delete(tab.id);
  }, []);

  /**
   * Keep only the tabs `keep` accepts — "Close other tabs" / "Close tabs to
   * the right".
   *
   * Same rules as the single-tab close, minus the dialog it cannot show:
   * a tab with running work stays OPEN (the guarded close would have asked,
   * and a bulk close cannot, so the safe answer is "not now") and the session
   * log names how many stayed; each closed tab's per-tab memory goes through
   * `forgetTabRefs`; and when the active tab is among the closed, the newest
   * survivor takes over — the same convention `tabModel.closeTab` uses (the
   * active id only moves when the closed tab was the active one, to the last
   * remaining tab).
   *
   * Emptying the list is fine: closing every tab no longer disconnects the
   * instance — the session stays up with zero tabs, and "+" starts a fresh
   * "01".
   */
  const closeMany = useCallback((keep: (t: QueryTab, i: number) => boolean) => {
    const prev = tabsRef.current;
    const removed = prev.filter((t, i) => !keep(t, i));
    const busy = removed.filter(t => getActivities(activityKeyOf(t)).length > 0);
    const closing = removed.filter(t => !busy.some(b => b.id === t.id));
    if (closing.length === 0) return;
    const closingIds = new Set(closing.map(t => t.id));
    for (const t of closing) forgetTabRefs(t);
    const surviving = prev.filter(t => !closingIds.has(t.id));
    const active = activeIdRef.current;
    const nextActive = active !== null && closingIds.has(active)
      ? (surviving.length > 0 ? surviving[surviving.length - 1].id : null)
      : active;
    commitTabs(cur => cur.filter(t => !closingIds.has(t.id)), nextActive);
    if (busy.length > 0) {
      addLog(session.sessionId, { level: 'info', action: 'TAB',
        detail: `${busy.length} tab(s) with running work stayed open: `
          + busy.map(t => t.label).join(', ') });
    }
  }, [activityKeyOf, commitTabs, forgetTabRefs, session.sessionId]);

  // Re-render when any tab's running work changes (tab bar shows ⟳ per tab).
  const activityVersion = useActivityVersion();
  const tabIsBusy = useCallback((tab: QueryTab) => {
    void activityVersion;   // subscription: recompute whenever the registry moves
    return getActivities(activityKeyOf(tab)).length > 0;
  }, [activityVersion, activityKeyOf]);

  // Remember which SQL tab to hand a plugin's SQL to.
  useEffect(() => {
    if (activeTab && !activeTab.panel) lastSqlTabRef.current = activeTab.id;
  }, [activeTab]);


  // ── Keystroke isolation ─────────────────────────────────────────────────
  // CodeMirror keeps its own buffer; pushing every keystroke into React state
  // re-renders the whole tab tree (grids included) and makes typing lag.
  // The live text lives in a ref; state syncs on a 250 ms debounce.
  const sqlRefs = useRef<Map<number, string>>(new Map());
  const sqlSyncTimer = useRef(0);
  /** Marked lines per tab, persisted with the buffer. */
  const bookmarksRef = useRef<Map<number, Bookmark[]>>(new Map());
  // Bumped only to re-render when a mark changes; the list lives in a ref.
  const [bookmarkTick, setBookmarkTick] = useState(0);
  void bookmarkTick;
  const marksFor = useCallback((tabId: number): Bookmark[] => {
    const cached = bookmarksRef.current.get(tabId);
    if (cached) return cached;
    const loaded = loadBookmarks(bookmarkKey(session.connectionId, tabId), localStorage);
    bookmarksRef.current.set(tabId, loaded);
    return loaded;
  }, [session.connectionId]);

  /** Version history per tab, so an overwrite is recoverable. */
  const [historyOpen, setHistoryOpen] = useState(false);
  const historyRef = useRef<Map<number, BufferVersion[]>>(new Map());
  // Bumped purely to re-render when a version lands — the list itself lives in
  // a ref so recording does not re-render on every keystroke.
  const [historyTick, setHistoryTick] = useState(0);
  void historyTick;

  /**
   * Record a version if the policy says so.
   *
   * Called on every buffer change and on every run. The policy (utils/
   * bufferHistory) decides what is worth keeping — crucially it captures a
   * large deletion immediately, which is the moment work actually disappears.
   */
  const recordVersion = useCallback((
    tabId: number, text: string, trigger: 'edit' | 'run' | 'manual' = 'edit',
  ) => {
    const key = historyKey(session.connectionId, tabId);
    const existing = historyRef.current.get(tabId) ?? loadHistory(key, localStorage);
    const next = snapshot(existing, text, Date.now(), trigger);
    if (next === existing) {
      historyRef.current.set(tabId, existing);
      return;
    }
    historyRef.current.set(tabId, next);
    if (!session.scratch) saveHistory(key, next, localStorage);
    setHistoryTick(n => n + 1);
  }, [session.connectionId, session.scratch]);

  useEffect(() => {
    const tabId = activeTab?.id;
    if (tabId === undefined) return;   // no tabs open — nothing to bookmark
    const setMarks = (marks: Bookmark[]) => {
      bookmarksRef.current.set(tabId, marks);
      // In-session only for scratch — the storage key would outlive its use.
      if (!session.scratch) saveBookmarks(bookmarkKey(session.connectionId, tabId), marks, localStorage);
      setBookmarkTick(n => n + 1);
    };
    const onToggle = (e: Event) => {
      const line = (e as CustomEvent<{ line: number }>).detail?.line;
      if (typeof line === 'number') setMarks(toggleBookmark(marksFor(tabId), line));
    };
    const jump = (find: typeof nextBookmark) => (e: Event) => {
      const line = (e as CustomEvent<{ line: number }>).detail?.line ?? 1;
      const hit = find(marksFor(tabId), line);
      if (hit) {
        window.dispatchEvent(new CustomEvent('dbgui:goto-line', { detail: { line: hit.line, tabId } }));
      }
    };
    const onNext = jump(nextBookmark);
    const onPrev = jump(prevBookmark);
    window.addEventListener('dbgui:bookmark-toggle', onToggle);
    window.addEventListener('dbgui:bookmark-next', onNext);
    window.addEventListener('dbgui:bookmark-prev', onPrev);
    return () => {
      window.removeEventListener('dbgui:bookmark-toggle', onToggle);
      window.removeEventListener('dbgui:bookmark-next', onNext);
      window.removeEventListener('dbgui:bookmark-prev', onPrev);
    };
  }, [activeTab?.id, session.connectionId, session.scratch, marksFor]);

  const handleSqlChange = useCallback((tabId: number, sql: string) => {
    sqlRefs.current.set(tabId, sql);
    window.clearTimeout(sqlSyncTimer.current);
    sqlSyncTimer.current = window.setTimeout(() => {
      // Coalesced onto the debounce tick: snapshotting a version on every
      // keystroke ran a full-buffer diff (and a localStorage write when the
      // policy kept it) on the hot typing path. 'run'/'manual' stay immediate.
      recordVersion(tabId, sqlRefs.current.get(tabId) ?? sql, 'edit');
      setTabs(prev => prev.map(t => {
        const live = sqlRefs.current.get(t.id);
        if (live === undefined || live === t.sql) return t;
        // An edit invalidates the gutter markers (the editor field clears on
        // docChanged) — the cached auto-EXPLAIN plans are keyed to the same
        // statement indices, so they go with them. Whole map, like the markers:
        // an edit can renumber every statement below it.
        return { ...t, sql: live, autoPlans: {}, dirty: isDirty(t.file, live) };
      }));
    }, 250);
  }, [recordVersion]);
  useEffect(() => () => window.clearTimeout(sqlSyncTimer.current), []);
  const flushSql = useCallback(() => {
    window.clearTimeout(sqlSyncTimer.current);
    setTabs(prev => prev.map(t => {
      const live = sqlRefs.current.get(t.id);
      // Same rule as the debounced sync: edited text invalidates the cached
      // auto-EXPLAIN plans along with the gutter markers.
      return live !== undefined && live !== t.sql ? { ...t, sql: live, autoPlans: {} } : t;
    }));
  }, []);
  /** Always-fresh buffer text (ref first, state as fallback). */
  const liveSql = useCallback(
    (tab: QueryTab) => sqlRefs.current.get(tab.id) ?? tab.sql,
    []);

  const addTab = useCallback(() => {
    // Numbered from the OPEN SQL tabs, not a global counter: with zero tabs
    // the next one is "01" again (utils/tabModel.nextSqlLabel).
    const tab = newTab(tabModel.nextSqlLabel(tabsRef.current));
    // a plugin tab in front never swallows the new tab (tests/tabModel.test.ts)
    commitTabs(prev => tabModel.addTab(prev, tab).tabs, tab.id);
  }, [commitTabs]);




  /**
   * Close a tab for real — no questions. `closeTabById` is the guarded entry
   * point everything else uses.
   */
  const forceCloseTab = useCallback((id: number) => {
    // Decision in utils/tabModel (pure, tested); this only performs it.
    // Closing the last tab is ordinary now: the session stays connected with
    // zero tabs, and the active id goes null until the next tab opens.
    const next = tabModel.closeTab(tabsRef.current, activeIdRef.current, id);
    // Only the ids matter from the decision; the list itself is filtered live.
    forgetTabRefs(tabsRef.current.find(t => t.id === id));
    commitTabs(prev => prev.filter(t => t.id !== id), next.activeId);
  }, [commitTabs, forgetTabRefs]);


  /**
   * Everything that is running in a tab, ready for the close window. A tab
   * being the last one adds nothing: the session's open transaction belongs
   * to the connection, which a tab close no longer takes away.
   */
  const closeBlockers = useCallback((tab: QueryTab): TabActivity[] =>
    [...getActivities(activityKeyOf(tab))], [activityKeyOf]);

  // The dialog stores WHICH tab is being closed; the activity list is re-read
  // on every render (subscribed via `activityVersion`), so work that finishes
  // while the window is open disappears from it — and the window then offers a
  // plain close instead of pretending there is still something to kill.
  const [closeAsk, setCloseAsk] = useState<{ tab: QueryTab } | null>(null);
  const closeAskActivities = useMemo(
    () => closeAsk ? closeBlockers(closeAsk.tab) : [],
    // activityVersion is the subscription that makes this live
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [closeAsk, closeBlockers, activityVersion]);

  /**
   * The guarded close: if the tab has live server-side work, ask first (kill it,
   * leave it running, or cancel) instead of dropping it silently.
   */
  const closeTabById = useCallback((id: number) => {
    const tab = tabsRef.current.find(t => t.id === id);
    if (!tab) return;
    const activities = closeBlockers(tab);
    if (tabModel.closeGuard(activities).ask) {
      setCloseAsk({ tab });
      return;
    }
    forceCloseTab(id);
  }, [closeBlockers, forceCloseTab]);

  /**
   * Open (or focus) a plugin tab. Choosing the menu item of the panel you are
   * already looking at closes that tab — the old toggle feel, without the old
   * modality: any other click just switches to it, and "+" still adds SQL tabs.
   */
  const togglePanel = useCallback((panel: string) => {
    flushSql();
    const decision = tabModel.panelToggle(tabsRef.current, activeIdRef.current, panel);
    if (decision.action === 'close') { closeTabById(decision.id); return; }
    if (decision.action === 'focus') {
      activeIdRef.current = decision.id;
      setActiveId(decision.id);
      return;
    }
    // One id per panel, so the updater can dedupe by id and still point
    // `activeId` at the right tab — `tabsRef` may not have caught up with a
    // click from the same tick (functional updates run at render time).
    const id = idForPanel(panel);
    commitTabs(
      prev => prev.some(t => t.id === id)
        ? prev
        : tabModel.addTab(prev, newPanelTab(panel, id)).tabs,
      id);
  }, [flushSql, closeTabById, commitTabs, idForPanel]);
  useEffect(() => { togglePanelRef.current = togglePanel; }, [togglePanel]);

  /**
   * Why this panel is unusable for *this* role, or null when it is usable.
   *
   * `unknown` privileges read as usable — see utils/privileges.ts: greying a
   * panel the user can in fact open is worse than the error it replaces.
   */
  const panelBlocked = useCallback((panel: string): string | null => {
    // Two independent reasons a panel may be unusable, and they read the same
    // way: the ENGINE cannot offer it in a shape this panel can draw
    // (engineGaps), or this ROLE may not use it (privileges). The engine reason
    // comes first because it does not change with a grant.
    const gap = engineGapReason(session.engine, panel);
    if (gap) return gap;
    const cap = PANEL_PRIVILEGE[panel];
    return cap ? privilegeTip(privs, cap, PANEL_META[panel]?.label ?? panel) : null;
  }, [privs, session.engine]);

  function closeTab(id: number, e: React.MouseEvent) {
    e.stopPropagation();
    closeTabById(id);
  }

  // WP-14 14.8: the volatile values the global-shortcut listeners read,
  // mirrored into a ref (in an effect, never during render) so the listener
  // effect below keeps an empty dependency list.
  const listenerEnvRef = useRef({
    isActive: !!isActive, activeId, closeTabById, addTab, commitTabs, flushSql,
    togglePanel, focusSqlTab, insertIntoEditor, supportsProcesses,
    supportsSqlDba, supportsServerInfo, panelBlocked,
    engine: session.engine, sessionId: session.sessionId,
    serverFlavor,
  });
  useEffect(() => {
    listenerEnvRef.current = {
      isActive: !!isActive, activeId, closeTabById, addTab, commitTabs, flushSql,
      togglePanel, focusSqlTab, insertIntoEditor, supportsProcesses,
      supportsSqlDba, supportsServerInfo, panelBlocked,
      engine: session.engine, sessionId: session.sessionId,
      serverFlavor,
    };
  });


  // Global-shortcut events (⌘T / ⌘W / palette) — only the active session
  // responds. WP-14 14.8: the handlers read every volatile value through
  // listenerEnvRef, so this effect's dep list is EMPTY — a tab switch or a
  // privilege load used to tear down and re-add all ~35 listeners. The
  // isActive gate moved from "don't attach" into the `on` wrapper, so the
  // set of listeners never changes while the component lives.
  useEffect(() => {
    const env = () => listenerEnvRef.current;
    const un: Array<() => void> = [];
    const on = (name: string, fn: (e: Event) => void) => {
      const guarded = (e: Event) => { if (env().isActive) fn(e); };
      window.addEventListener(name, guarded);
      un.push(() => window.removeEventListener(name, guarded));
    };
    const onNewTab = () => env().addTab();
    // No tabs → nothing to close (activeId is null); ⌘W is a no-op then.
    const onCloseTab = () => { const id = env().activeId; if (id !== null) env().closeTabById(id); };

    /**
     * File → Open SQL File…
     *
     * A new tab named after the file, holding its text. Deliberately not
     * "replace what is in the current tab": opening a file must never be able
     * to discard work the user has not saved anywhere.
     */
    /**
     * File → Open. The path is kept this time — that one omission was the
     * root of Save-in-place, dirty state, change detection and recents all
     * being impossible.
     */
    const onOpenSqlFile = (e: Event) => {
      const d = (e as CustomEvent<{
        path: string; sql: string; encoding: string; eol: Eol; mtimeMs: number;
      }>).detail;
      if (!d) return;
      // Already open? Focus it rather than opening a second copy that will
      // fight the first one on save.
      const existing = tabsRef.current.find(t => t.file?.path === d.path);
      if (existing) { setActiveId(existing.id); return; }
      const tab: QueryTab = {
        ...newTab(tabLabelFor(d.path)),
        sql: d.sql,
        file: {
          path: d.path, encoding: d.encoding, eol: d.eol,
          mtimeMs: d.mtimeMs, savedText: d.sql,
        },
      };
      sqlRefs.current.set(tab.id, d.sql);
      env().commitTabs(prev => tabModel.addTab(prev, tab).tabs, tab.id);
      rememberRecentRef.current(d.path);
    };

    /** File → Save. Writes back to the bound path, or asks for one. */
    const onSaveSql = () => { void saveActiveRef.current(false); };
    /** File → Save As. Always asks, and rebinds the tab to the new path. */
    const onSaveSqlAs = () => { void saveActiveRef.current(true); };

    /**
     * File → Export Results…
     *
     * Re-dispatched to the active grid rather than serialized here: the grid
     * is the only thing that knows what is currently displayed — filtered,
     * sorted, one browser tab of several — and exporting the underlying result
     * instead would quietly hand over different data than the screen shows.
     */
    const onExportResults = () => {
      window.dispatchEvent(new CustomEvent('dbgui:grid-export',
        { detail: { tabId: activeIdRef.current } }));
    };
    const onToggleHistory = () => env().togglePanel('history');
    /**
     * The Tools menu's generic opener.
     *
     * Every plugin, by id, through the same gates the bar applies: a panel the
     * engine does not have is not opened (`PANEL_ENGINE_CAP`), and one this
     * role cannot use is not opened either — silently, because the menu item
     * that led here has already been clicked and an error box would be the
     * second surprise rather than the first explanation. The plugin menu shows
     * the reason on hover; this is the same decision, not a new one.
     */
    const onTogglePanelById = (e: Event) => {
      const d = (e as CustomEvent<{
        panel: string; scope?: FindScope | CompareScope | WatchMode; threadId?: number | null;
      }>).detail;
      const panel = d?.panel;
      if (!panel || !PANEL_META[panel]) return;
      const cap = PANEL_ENGINE_CAP[panel];
      if (cap && !can(env().engine, cap)) return;
      if (env().panelBlocked(panel)) return;
      // Runtime flavour gate the static cap cannot express: the mysql engine
      // only has sequences on MariaDB ≥ 10.3, which the native Tools menu
      // cannot know. SequencePanel's own flavour branch stays as the
      // last-resort explanation.
      if (panel === 'sequences' && env().engine === 'mysql'
          && !capabilities(env().serverFlavor).sequences) return;
      // A scope-carrying open ("find usages of this column") asks to LOOK at
      // something, not to toggle — open-or-focus, like the editors' targets,
      // so it can never close the panel it means to show.
      if (panel === 'find' && d?.scope) {
        setFindScope(d.scope as FindScope);
        openOrFocusPanel(panel);
        return;
      }
      // Same dance for a mode-carrying Compare open.
      if (panel === 'compare' && d?.scope) {
        setCompareScope(d.scope as CompareScope);
        openOrFocusPanel(panel);
        return;
      }
      // Same dance for a Watch open — with an optional pinned thread id, from
      // Processes' "watch this thread" ("statement" mode, read-only).
      if (panel === 'watch' && d?.scope) {
        setWatchTarget({ mode: d.scope as WatchMode, threadId: d.threadId ?? null });
        openOrFocusPanel(panel);
        return;
      }
      env().togglePanel(panel);
    };
    const onToggleProcesses = () => { if (env().supportsProcesses && !env().panelBlocked('processes')) env().togglePanel('processes'); };
    const onToggleServerInfo = () => { if (env().supportsServerInfo) env().togglePanel('serverinfo'); };
    const onToggleWatch = () => env().togglePanel('watch');
    const onToggleLocks = () => { if (!env().panelBlocked('locks')) env().togglePanel('locks'); };
    const onToggleUsers = () => { if (!env().panelBlocked('users')) env().togglePanel('users'); };
    const onToggleReplication = () => { if (env().supportsSqlDba && !env().panelBlocked('replication')) env().togglePanel('replication'); };
    // Redis has its own curated view set (see utils/dbaViews.ts).
    const onToggleDbaViews = () => { if (!env().panelBlocked('dbaviews')) env().togglePanel('dbaviews'); };
    const onToggleTuner = () => { if (can(env().engine, 'tuner') && !env().panelBlocked('tuner')) env().togglePanel('tuner'); };
    const onToggleErDiagram = () => { if (can(env().engine, 'erDiagram')) env().togglePanel('erdiagram'); };
    const onToggleDataGen = () => { if (can(env().engine, 'dataGen')) env().togglePanel('datagen'); };
    const onToggleSaved = () => env().togglePanel('saved');
    const onToggleCsvImport = () => { if (can(env().engine, 'csvImport')) env().togglePanel('csvimport'); };
    const onToggleQuality = () => { if (can(env().engine, 'sqlQuality')) env().togglePanel('quality'); };
    const onTogglePlayground = () => { if (env().supportsSqlDba) env().togglePanel('playground'); };
    const onInsertSql = (e: Event) => {
      const sql = (e as CustomEvent<{ sql: string }>).detail?.sql;
      if (sql) { const id = env().focusSqlTab(); env().insertIntoEditor(sql, id); }
    };
    // Object explorer "Browse data": opens as a RESULT tab — editor stays.
    // The equivalent SELECT is written into the editor for consistency.
    const onBrowseTable = (e: Event) => {
      const d = (e as CustomEvent<{ table: string; kind?: 'table' | 'view' }>).detail;
      if (!d?.table) return;
      // Result browsers only render on SQL tabs. A browse fired while a PLUGIN
      // tab is active (ER diagram double-click / "Browse table") would land on
      // the panel tab, which never renders `browsers` — nothing would happen.
      // Hand it to the SQL tab in focus instead, creating one if none exists.
      const active = tabsRef.current.find(t => t.id === activeIdRef.current);
      const targetId = active && !active.panel ? active.id : env().focusSqlTab();
      // Open a NEW result browser (Result 1..N); if already open, just activate it.
      setTabs(prev => prev.map(t => {
        if (t.id !== targetId) return t;
        const idx = t.browsers.indexOf(d.table);
        const browsers = idx >= 0 ? t.browsers : [...t.browsers, d.table];
        return { ...t, browsers, activeBrowser: idx >= 0 ? idx : browsers.length - 1, view: 'browser' };
      }));
      addLog(env().sessionId, { level: 'info', action: 'BROWSE', detail: d.table });
      // …and, when the preference is on, run SHOW CREATE and drop its OUTPUT
      // (the backtick-quoted CREATE statement) into the editor — newline before,
      // newline + caret after.
      if (getPref(PREFS.showCreateOnBrowse)) {
        SchemaStore.getDdl(env().sessionId, d.table)
          .then(ddl => { if (ddl) env().insertIntoEditor(`\n${ddl.trim()}\n`, targetId); })
          .catch(() => { /* DDL fetch is best-effort */ });
      }
    };
    on('dbgui:new-tab', onNewTab);
    const onDesignTable = (e: Event) => {
      const d = (e as CustomEvent<{ schema: string; table: string | null }>).detail;
      if (!d) return;
      setDesignTarget(d);
      // Focus the designer tab if it is already open, otherwise open it.
      // `panelToggle` would *close* an open one, which is the wrong response
      // to "design this table".
      openOrFocusPanel('designer');
    };
    on('dbgui:design-table', onDesignTable);
    // Same open-or-focus dance as design-table, for the routine and sequence
    // editors: the schema tree fires these to jump straight into editing one.
    const onEditRoutine = (e: Event) => {
      const d = (e as CustomEvent<{ schema: string; name: string; kind: string }>).detail;
      if (!d) return;
      setRoutineTarget(d);
      openOrFocusPanel('routines');
    };
    on('dbgui:edit-routine', onEditRoutine);
    const onEditSequence = (e: Event) => {
      const d = (e as CustomEvent<{ schema: string; name: string }>).detail;
      if (!d) return;
      setSequenceTarget(d);
      openOrFocusPanel('sequences');
    };
    on('dbgui:edit-sequence', onEditSequence);
    // Same open-or-focus dance again, for the type editor and for a
    // PostgreSQL trigger (which the type/routine tree fires straight into).
    const onEditType = (e: Event) => {
      const d = (e as CustomEvent<{ schema: string; name: string; kind: string }>).detail;
      if (!d) return;
      setTypeTarget(d);
      openOrFocusPanel('types');
    };
    on('dbgui:edit-type', onEditType);
    // Same open-or-focus dance for the view editor: the tree fires this with
    // `kind` = 'view' | 'matview' to jump straight into editing one.
    const onEditView = (e: Event) => {
      const d = (e as CustomEvent<{ schema: string; name: string; kind: string }>).detail;
      if (!d) return;
      setViewTarget(d);
      openOrFocusPanel('views');
    };
    on('dbgui:edit-view', onEditView);
    // Same open-or-focus dance for the dictionary editor (ClickHouse): the tree
    // fires this with `{schema, name}` to jump straight into editing one.
    const onEditDictionary = (e: Event) => {
      const d = (e as CustomEvent<{ schema: string; name: string }>).detail;
      if (!d) return;
      setDictionaryTarget(d);
      openOrFocusPanel('dictionary');
    };
    on('dbgui:edit-dictionary', onEditDictionary);
    const onEditTrigger = (e: Event) => {
      const d = (e as CustomEvent<{ schema: string; table: string; name: string }>).detail;
      if (!d) return;
      // The routine editor handles triggers; a PG trigger needs its table too.
      setRoutineTarget({ schema: d.schema, name: d.name, kind: 'trigger', table: d.table });
      openOrFocusPanel('routines');
    };
    on('dbgui:edit-trigger', onEditTrigger);
    on('dbgui:open-sql-file', onOpenSqlFile);
    on('dbgui:save-sql', onSaveSql);
    on('dbgui:save-sql-as', onSaveSqlAs);
    on('dbgui:export-results', onExportResults);
    on('dbgui:close-tab', onCloseTab);
    on('dbgui:toggle-history', onToggleHistory);
    on('dbgui:toggle-panel', onTogglePanelById);
    on('dbgui:toggle-processes', onToggleProcesses);
    on('dbgui:toggle-serverinfo', onToggleServerInfo);
    on('dbgui:toggle-watch', onToggleWatch);
    on('dbgui:toggle-locks', onToggleLocks);
    on('dbgui:toggle-users', onToggleUsers);
    on('dbgui:toggle-replication', onToggleReplication);
    on('dbgui:toggle-dbaviews', onToggleDbaViews);
    on('dbgui:toggle-tuner', onToggleTuner);
    on('dbgui:toggle-erdiagram', onToggleErDiagram);
    on('dbgui:toggle-datagen', onToggleDataGen);
    on('dbgui:toggle-saved', onToggleSaved);
    on('dbgui:toggle-csvimport', onToggleCsvImport);
    on('dbgui:toggle-quality', onToggleQuality);
    on('dbgui:toggle-playground', onTogglePlayground);
    on('dbgui:insert-sql', onInsertSql);
    on('dbgui:browse-table', onBrowseTable);
    return () => { un.forEach(f => f()); };
  }, [openOrFocusPanel]);

  // Connected DB user — captured once per session, stamped into the audit log.
  // A ref (not state): only read at execution time, never rendered.
  const dbUserRef = useRef('');
  const [charset, setCharset] = useState('');
  const [cursor, setCursor] = useState<{ line: number; col: number; selLen: number; carets: number } | null>(null);
  /** The outline pane beside the editor — remembered, like every other pane. */
  const [outlineOpen, setOutlineOpen] = useState<boolean>(
    () => localStorage.getItem('dbgui.outlineOpen') === '1');
  const toggleOutline = useCallback(() => setOutlineOpen(v => {
    try { localStorage.setItem('dbgui.outlineOpen', v ? '0' : '1'); } catch { /* quota */ }
    return !v;
  }), []);
  useEffect(() => {
    const sql = session.engine === 'mysql' ? 'SELECT CURRENT_USER()'
      : session.engine === 'postgres' ? 'SELECT current_user'
      : null;
    if (!sql) { dbUserRef.current = session.engine; return; }
    invoke<QueryResult>('monitor_query', { sessionId: session.sessionId, sql })
      .then(r => { dbUserRef.current = String(r.rows[0]?.[0] ?? ''); })
      .catch(() => { dbUserRef.current = ''; });
  }, [session.sessionId, session.engine]);
  // Result character set — shown in the result meta bar (RazorSQL-style).
  useEffect(() => {
    const sql = session.engine === 'mysql' ? "SELECT @@character_set_client"
      : session.engine === 'postgres' ? 'SHOW client_encoding'
      : null;
    if (!sql) return;
    invoke<QueryResult>('monitor_query', { sessionId: session.sessionId, sql })
      .then(r => setCharset(String(r.rows[0]?.[0] ?? '')))
      .catch(() => {});
  }, [session.sessionId, session.engine]);

  // ── The run engine ───────────────────────────────────────────────────────
  // executeOne / executeSql / runQuery and their private helpers live in
  // hooks/useQueryRunner (WP-16 16.1 step 4). The modals stay here: the hook
  // defers to them through the setters below and the modal handlers call
  // executeSql to continue.
  const { runQuery, executeSql } = useQueryRunner({
    // No tabs → no editor → nothing can call runQuery; the 0 is inert.
    session, sid, activeTabId: activeTab?.id ?? 0, currentDb, connCfg,
    supportsDbSelect, txOpen,
    tabsRef, txOpenRef, currentDbRef, dbUserRef,
    defaultLimitRef, limitTouchedRef, aliasesRef,
    patchTab, liveSql, beginTx, endTx, recordVersion,
    setScriptAsk, setWriteAsk, setVarPrompt, setPreflight,
  });

  const handleVarRun = useCallback((values: Record<string, VarValue>) => {
    const prompt = varPrompt;
    setVarPrompt(null);
    // Substitution rewrites the text; the offset is what still finds the
    // statement in the buffer for the gutter marker.
    if (prompt) executeSql(substituteVariables(prompt.sql, values, session.engine), prompt.tabId, prompt.from, prompt.noResults);
  }, [varPrompt, executeSql, session.engine]);

  const runExplain = useCallback(async (sql: string, analyze = false, mode?: string) => {
    const tabId = activeTab?.id;
    if (!sql.trim() || !can(session.engine, 'sql') || tabId === undefined) return;
    // Refuse here rather than letting the server complain about a statement
    // the user did not write: `EXPLAIN CREATE TABLE …` comes back as a syntax
    // error quoting their DDL, with nothing to say that DDL simply has no plan.
    const verdict = explainVerdict(sql, session.engine);
    if (!verdict.ok) {
      patchTab(tabId, { error: verdict.reason ?? 'This statement cannot be explained.' });
      return;
    }
    try {
      const res = await invoke<{ format: string; engine: string; content: string }>('explain_query', {
        sessionId: session.sessionId,
        sql,
        analyze,
        db: currentDb || null,
        mode: mode ?? null,
      });
      patchTab(tabId, {
        explain: { ...res, analyzed: analyze, sql, mode: mode ?? undefined, at: Date.now() },
        view: 'plan',
        error: null,
      });
    } catch (err) {
      patchTab(tabId, { error: errorDisplay(err) });
    }
  }, [activeTab?.id, session, currentDb, patchTab]);

  // The gutter run-marker context menu (SqlEditor) asks to re-run / explain
  // exactly ONE statement. These listeners live here rather than in the big
  // dbgui:* block above because that block is defined before runQuery /
  // runExplain exist. `from` is the statement's doc offset — passing it
  // through runQuery is what pins the fresh gutter marker onto the same
  // statement (see executeSql's statementIndexAt resolution).
  useEffect(() => {
    const onRunStatement = (e: Event) => {
      const d = (e as CustomEvent<{ sql: string; from?: number }>).detail;
      if (d?.sql?.trim()) void runQuery(d.sql, d.from);
    };
    const onExplainStatement = (e: Event) => {
      const d = (e as CustomEvent<{ sql: string }>).detail;
      if (d?.sql?.trim()) void runExplain(d.sql);
    };
    window.addEventListener('dbgui:run-statement', onRunStatement);
    window.addEventListener('dbgui:explain-statement', onExplainStatement);
    return () => {
      window.removeEventListener('dbgui:run-statement', onRunStatement);
      window.removeEventListener('dbgui:explain-statement', onExplainStatement);
    };
  }, [runQuery, runExplain]);

  // "Open plan" (gutter badge click / marker menu): the auto-EXPLAIN plan is
  // already cached on the tab — this just puts it in front. The click came
  // from the visible editor, so the ACTIVE session's active tab owns it —
  // every session's QueryTabs is mounted, and without the isActive guard each
  // one would answer the event.
  useEffect(() => {
    if (!isActive) return;
    const onOpenPlan = (e: Event) => {
      const d = (e as CustomEvent<{ idx: number }>).detail;
      const id = activeTab?.id;
      if (d == null || id === undefined) return;
      const t = tabsRef.current.find(x => x.id === id);
      const plan = t?.autoPlans[d.idx];
      if (t && plan) patchTab(t.id, { explain: plan, view: 'plan' });
    };
    window.addEventListener('dbgui:open-plan', onOpenPlan);
    return () => window.removeEventListener('dbgui:open-plan', onOpenPlan);
  }, [activeTab?.id, isActive, patchTab]);

  // A plan handed over by a PANEL rather than produced by a run — Query Store
  // keeps the XML of every plan a query has ever had, and looking at the two
  // side by side is the whole point of finding a regression. It lands in the
  // same viewer an EXPLAIN does, because it is the same document.
  useEffect(() => {
    if (!isActive) return;
    const onShowPlan = (e: Event) => {
      const d = (e as CustomEvent<{ format: string; engine: string; content: string }>).detail;
      const id = activeTab?.id;
      if (!d?.content || id === undefined) return;
      patchTab(id, {
        // `analyzed: false` — a stored plan carries estimates, not the
        // measurements an EXPLAIN ANALYZE would have.
        explain: { ...d, analyzed: false, sql: '', at: Date.now() },
        view: 'plan',
        error: null,
      });
    };
    window.addEventListener('dbgui:show-plan', onShowPlan);
    return () => window.removeEventListener('dbgui:show-plan', onShowPlan);
  }, [activeTab?.id, isActive, patchTab]);

  /**
   * Context for the live diagnostics: the loaded object names, whatever column
   * and index metadata is already cached, the CTEs of the current buffer, and
   * whether a default database is selected. Column/index data is only used when
   * it is ALREADY there — the diagnostics stay quiet rather than guess, and the
   * caches fill up as completion and hovers touch the tables anyway.
   */
  const diagCacheRef = useRef<{ columns: Map<string, Set<string>>; indexed: Map<string, Set<string>> }>(
    { columns: new Map(), indexed: new Map() });
  const diagInflightRef = useRef<Set<string>>(new Set());
  const diagIdxInflightRef = useRef<Set<string>>(new Set());
  const [diagCounts, setDiagCounts] = useState({ errors: 0, warnings: 0, infos: 0 });

  const buildDiagContext = useCallback((doc: string): DiagContext => {
    const objects = new Set<string>();
    for (const c of completions) {
      if (c.kind === 'schema') continue;
      objects.add(c.label.toLowerCase());
      if (c.apply && c.apply.includes('.')) objects.add(c.apply.replace(/[`"]/g, '').toLowerCase());
    }
    // The document belongs to the editor that asked — using the ACTIVE tab's
    // text would mis-read CTEs and aliases for every other (restored) buffer.
    const virtual = new Set([...findVirtualTables(doc).keys()]);
    // Warm the caches for the tables in scope (async, used by the NEXT pass).
    for (const table of new Set(findAliases(doc).values())) {
      const key = table.replace(/[`"]/g, '').toLowerCase();
      // `inflight` marks "asked, not answered" so a failed lookup is retried on
      // the next pass instead of leaving the table permanently unchecked — an
      // empty Set in `columns` means "known to have no columns", which is what
      // silences the checks, and must only come from a real answer.
      if (!diagCacheRef.current.columns.has(key) && !diagInflightRef.current.has(key)) {
        diagInflightRef.current.add(key);
        getColumns(table)
          .then(cols => diagCacheRef.current.columns.set(key,
            new Set(cols.map(c => c.label.toLowerCase()))))
          .catch(() => {})
          .finally(() => diagInflightRef.current.delete(key));
      }
      if (!diagCacheRef.current.indexed.has(key) && !diagIdxInflightRef.current.has(key)) {
        diagIdxInflightRef.current.add(key);
        getIndexedColumns(table)
          .then(set => diagCacheRef.current.indexed.set(key, set))
          .catch(() => {})
          .finally(() => diagIdxInflightRef.current.delete(key));
      }
    }
    return {
      objects,
      columns: diagCacheRef.current.columns,
      indexed: diagCacheRef.current.indexed,
      hasDefaultDb: !supportsDbSelect || currentDb !== '',
      virtual,
      // Gates the dialect-sensitive checks (not-in-GROUP-BY only fires where
      // the server enforces it). diagnose() reads ctx.engine when no explicit
      // 4th argument is passed, so both editor call sites pick this up as-is.
      engine: session.engine,
    };
  }, [completions, getColumns, getIndexedColumns, supportsDbSelect, currentDb, session.engine]);

  const explainTriggerRef = useRef<(() => void) | null>(null);
  // The active editor wires this so the toolbar Run button runs exactly what
  // ⌘↵ runs — the selection, or the statement at the caret — instead of the
  // whole buffer (liveSql).
  const runTriggerRef = useRef<(() => void) | null>(null);
  const runBareTriggerRef = useRef<(() => void) | null>(null);

  async function cancelQuery() {
    if (!activeTab) return;
    await invoke('cancel_query', {
      sessionId: session.sessionId,
      tabId: activeTab.id,
    }).catch(() => {});
  }

  /**
   * A plugin tab handing SQL to the editor: focus a SQL tab (create one if the
   * user closed them all) and push the text into THAT editor. The plugin tab
   * stays open in the bar — it is a tab, not a modal.
   */
  function handleHistorySelect(sql: string) {
    const id = focusSqlTab();
    patchTab(id, { sql });
    insertIntoEditor(sql, id);
  }

  /**
   * Gutter markers for a tab: the last script run's per-statement lines while
   * they exist, otherwise the accumulated single-run outcomes (`stmtRuns`) —
   * one entry per statement ever run with ⌘↵, each persisting until its own
   * statement is re-run or the buffer is edited. The offset → statement-index
   * translation lives in utils/runMarkers (resolved once, at run time).
   * Memoised per tab so the editor does not receive a fresh array (and dispatch
   * a state effect) on every single render of the workspace.
   */
  const runMarkerCache = useRef<Map<number, { src: unknown; base: number; runs: StatementRun[] }>>(new Map());
  const statementRunsFor = (tab: QueryTab): StatementRun[] | undefined => {
    // Script lines while a script run exists; otherwise the accumulated
    // single-run map. stmtRuns holds run-time statement INDICES — deliberately
    // nothing derived from the live buffer — so editing the doc cannot move
    // the output and re-dispatch markers the editor has invalidated on edit.
    //
    // Cache key = INPUT IDENTITY (WP-14 14.3): every mutation site replaces
    // scriptResults / stmtRuns immutably (including the post-run hasPlan /
    // stats patches), so object identity fully determines the derived array —
    // the old serialized `runs.map(...).join('|')` key re-walked every
    // statement for every tab on every render during a script run.
    const src: unknown = tab.scriptResults ?? tab.stmtRuns;
    const hit = runMarkerCache.current.get(tab.id);
    if (hit && hit.src === src && hit.base === tab.scriptBase) return hit.runs;
    const runs = tab.scriptResults
      ? scriptLinesToRuns(tab.scriptResults, tab.scriptBase)
      : stmtRunsToRuns(tab.stmtRuns);
    if (!runs) { runMarkerCache.current.delete(tab.id); return undefined; }
    runMarkerCache.current.set(tab.id, { src, base: tab.scriptBase, runs });
    return runs;
  };

  /** Live text of the SQL tab a plugin should read from (⭐ "save current"). */
  const currentEditorSql = (): string => {
    const t = tabsRef.current.find(x => x.id === lastSqlTabRef.current && !x.panel);
    return t ? liveSql(t) : '';
  };

  /**
   * The plugin panels. Each one lives in its own tab: `onClose` closes THAT tab
   * (nothing else), and the panel stays mounted while the tab exists, so its
   * state survives switching away — the same rule as Result tabs.
   */
  /**
   * Per-tab panel elements, cached on the inputs that actually feed the
   * panel's props (WP-14 14.4). Returning the CACHED element identity lets
   * React bail out of reconciling that whole subtree — every mounted panel
   * used to be re-reconciled (with fresh inline closures) on every QueryTabs
   * render. The handlers the panels capture are useCallback+ref-stable, so a
   * cached element's closures never go stale; the DATA inputs are the cache
   * key, so a currentDb / target / session change re-renders exactly the
   * panels that show it. `tabs` keys only the panels whose props derive from
   * it (saved / compare / find).
   */
  const panelElemCache = useRef<Map<number, { deps: unknown[]; el: React.ReactNode }>>(new Map());
  function panelFor(tab: QueryTab): React.ReactNode {
    const deps: unknown[] = [
      tab.panel, session, openSessions, currentDb, dbList,
      routineTarget, sequenceTarget, typeTarget, viewTarget, dictionaryTarget, designTarget,
      findScope, compareScope, watchTarget,
      (tab.panel === 'saved' || tab.panel === 'compare' || tab.panel === 'find') ? tabs : null,
    ];
    const hit = panelElemCache.current.get(tab.id);
    if (hit && hit.deps.length === deps.length && hit.deps.every((d, i) => d === deps[i])) {
      return hit.el;
    }
    const el = renderPanel(tab);
    panelElemCache.current.set(tab.id, { deps, el });
    // Closed tabs leave entries behind — prune occasionally.
    if (panelElemCache.current.size > tabs.length + 8) {
      const live = new Set(tabs.map(t => t.id));
      for (const id of [...panelElemCache.current.keys()]) {
        if (!live.has(id)) panelElemCache.current.delete(id);
      }
    }
    return el;
  }

  function renderPanel(tab: QueryTab) {
    const close = () => closeTabById(tab.id);
    const meta = tab.panel ? PANEL_META[tab.panel] : undefined;
    if (!meta) return <div className="mx-empty">Unknown panel “{tab.panel}”.</div>;
    const c: PanelCtx = {
      session, openSessions, currentDb, dbList, changeDb, tabs, tabsRef, activeIdRef, liveSql,
      handleHistorySelect, currentEditorSql, focusSqlTab, insertIntoEditor,
      routineTarget, clearRoutineTarget, designTarget,
      sequenceTarget, clearSequenceTarget, typeTarget, clearTypeTarget,
      viewTarget, clearViewTarget, dictionaryTarget, clearDictionaryTarget,
      findScope, clearFindScope, compareScope, clearCompareScope,
      watchTarget, clearWatchTarget,
    };
    return meta.render(c, close);
  }

  return (
    <div className="query-tabs-container">
      {/* Tab bar */}
      <div className="qtab-bar">
        {tabs.map(t => (
          <div
            key={t.id}
            className={`qtab ${t.id === activeId ? 'active' : ''} ${t.panel ? 'qtab-plugin' : ''}`
              + `${t.pinned ? ' qtab-pinned' : ''}${dragOverId === t.id ? ' qtab-dropzone' : ''}`}
            style={tabStyle({ color: t.color ?? null }, t.id === activeId)}
            // A pinned tab does not move, and nothing lands on it — pinning is
            // "keep this where it is" and reordering around it would undo that.
            draggable={!t.pinned}
            onDragStart={e => { dragTabRef.current = t.id; e.dataTransfer.effectAllowed = 'move'; }}
            onDragOver={e => {
              if (dragTabRef.current === null || t.pinned) return;
              e.preventDefault();
              setDragOverId(t.id);
            }}
            onDragLeave={() => setDragOverId(cur => (cur === t.id ? null : cur))}
            onDrop={e => {
              e.preventDefault();
              const from = dragTabRef.current;
              dragTabRef.current = null;
              setDragOverId(null);
              if (from !== null && from !== t.id) moveTab(from, t.id);
            }}
            onDragEnd={() => { dragTabRef.current = null; setDragOverId(null); }}
            onClick={() => setActiveId(t.id)}
            onDoubleClick={() => { setActiveId(t.id); setRenaming(t.id); }}
            onContextMenu={e => { e.preventDefault(); setTabMenu({ x: e.clientX, y: e.clientY, id: t.id }); }}
          >
            {renaming === t.id ? (
              <input
                className="qtab-rename"
                autoFocus
                defaultValue={t.label}
                onBlur={e => { patchTab(t.id, { label: e.target.value.trim() || t.label }); setRenaming(null); }}
                onKeyDown={e => {
                  if (e.key === 'Enter') { patchTab(t.id, { label: (e.target as HTMLInputElement).value.trim() || t.label }); setRenaming(null); }
                  if (e.key === 'Escape') setRenaming(null);
                }}
                onClick={e => e.stopPropagation()}
              />
            ) : (
              <span className="qtab-label" title={t.file?.path}>
                {t.panel && PANEL_META[t.panel] && (
                  <span className="icon-slot"><PanelIcon panel={t.panel} size={13} /></span>
                )}
                {/* A bound file is worth saying so: the tab is a document now,
                    not a scratch buffer, and ⌘S will write to a real path. */}
                {t.file && <span className="qtab-file" title={t.file.path}>📄</span>}
                {t.readOnly && <span className="qtab-ro" title="Read-only document">🔒</span>}
                {t.label}
                {/* Dirty means *differs from disk*, not *has text in it*. */}
                {t.dirty
                  && <span className="qtab-dirty" title="Unsaved changes">●</span>}
              </span>
            )}
            {(t.running || tabIsBusy(t)) && <span className="qtab-spinner">⟳</span>}
            <button
              className="qtab-close"
              title={t.panel === 'playground'
                ? 'Close this tab — spawned threads keep running'
                : 'Close tab'}
              onClick={e => closeTab(t.id, e)}
            >×</button>
          </div>
        ))}
        <button className="qtab-add" onClick={addTab} title="New tab">+</button>
        <div style={{ flex: 1 }} />
        {/*
          The plugin menu bar. Every panel, grouped (utils/pluginMenu.ts),
          icon + name per item — the row of bare glyphs this replaced needed
          a week of hover-to-learn. Engine gates hide an item the session
          cannot use (`menuItemVisible`); role gates grey it with the reason
          on hover (`panelBlocked`), never `disabled`, or the hover that
          carries the reason would not fire. An open panel's item is marked
          (● in front, ✓ behind), and the group title lights up while one of
          its panels is the tab in front.
        */}
        <div className="pmenu-bar" ref={menuBarRef}>
          {PLUGIN_MENU.map(g => {
            const items = g.items.filter(menuItemVisible);
            if (items.length === 0) return null;   // nothing this engine offers — no empty shell
            const isOpen = openMenu?.id === g.id;
            const hasActive = items.some(it => it.panel === activePanel);
            return (
              <div key={g.id} className={`pmenu${isOpen ? ' open' : ''}`}>
                <button
                  className={`pmenu-title${isOpen ? ' open' : ''}${hasActive ? ' active' : ''}`}
                  onClick={e => isOpen ? setOpenMenu(null) : openMenuAt(g.id, e.currentTarget)}
                  onMouseEnter={e => { if (openMenu && !isOpen) openMenuAt(g.id, e.currentTarget); }}
                >{g.label}<span className="pmenu-caret">▾</span></button>
                {isOpen && openMenu && (
                  <div className="pmenu-list" style={{ top: openMenu.top, left: openMenu.left, right: openMenu.right }}>
                    {items.map(it => {
                      const meta = PANEL_META[it.panel];
                      if (!meta) return null;
                      const blocked = panelBlocked(it.panel);
                      const tip = it.panel === 'dbaviews' && session.engine === 'redis'
                        ? 'DBA views (INFO / CLIENT LIST / SLOWLOG / MEMORY)' : it.tip;
                      const isOpenPanel = openPanels.has(it.panel);
                      return (
                        <button
                          key={it.panel}
                          className={`pmenu-item${isOpenPanel ? ' open' : ''}`
                            + `${activePanel === it.panel ? ' active' : ''}${blocked ? ' unavail' : ''}`}
                          data-tip={blocked ?? tip}
                          aria-disabled={blocked ? true : undefined}
                          onClick={() => { if (blocked) return; setOpenMenu(null); togglePanel(it.panel); }}
                        >
                          <span className="pmenu-item-icon"><PanelIcon panel={it.panel} size={14} /></span>
                          <span className="pmenu-item-label">{it.label}</span>
                          {isOpenPanel && (
                            <span className="pmenu-item-state">{activePanel === it.panel ? '●' : '✓'}</span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      <div className="qtab-body">


        {preflight && (
          <Suspense fallback={null}>
          <ScriptPreflight
            report={preflight.report}
            connectionName={session.connectionName}
            environment={session.environment}
            readOnly={session.readOnly}
            onCancel={() => setPreflight(null)}
            onRun={() => {
              const { sql, tabId, from, noResults } = preflight;
              setPreflight(null);
              // Straight to execution: the pre-flight *is* the confirmation,
              // and running it again would ask the same question twice.
              executeSql(sql, tabId, from, noResults);
            }}
          />
          </Suspense>
        )}

        {/* Variable prompt */}
        {varPrompt && (
          <Suspense fallback={null}>
          <VariablePrompt
            connectionId={session.connectionId}
            variables={varPrompt.vars}
            onRun={handleVarRun}
            onCancel={() => setVarPrompt(null)}
          />
          </Suspense>
        )}

        {/* Quick Definition: the DDL of the object under the caret (⌘Y). */}
        {peekDdl && (
          <DdlModal
            title={peekDdl.title}
            sql={peekDdl.sql}
            onClose={() => setPeekDdl(null)}
            onInsert={() => { insertIntoEditor(peekDdl.sql, focusSqlTab()); setPeekDdl(null); }}
          />
        )}

        {/* MySQL optimizer trace — the JSON "why this plan", read-only. */}
        {traceJson !== null && (
          <div className="modal-overlay" onMouseDown={() => setTraceJson(null)}>
            <div className="modal ai-modal" onMouseDown={e => e.stopPropagation()}>
              <div className="modal-header">
                <span className="modal-title">🔬 Optimizer trace</span>
                <div style={{ flex: 1 }} />
                <button className="toolbar-btn" onClick={() => navigator.clipboard.writeText(traceJson)}>Copy</button>
                <button className="icon-btn" onClick={() => setTraceJson(null)} title="Close">×</button>
              </div>
              <div className="ai-body">
                <pre className="ai-result">{traceJson}</pre>
              </div>
            </div>
          </div>
        )}

        {/* AI assistant — generate / explain / fix. Results are reviewable; the
            "Insert" drops the SQL into the editor, never auto-runs. */}
        {aiModal && (
          <Suspense fallback={null}>
          <AiAssistModal
            engine={session.engine}
            mode={aiModal.mode}
            sql={aiModal.sql}
            error={aiModal.error}
            onInsert={sql => insertIntoEditor(sql, focusSqlTab())}
            onClose={() => setAiModal(null)}
          />
          </Suspense>
        )}
















        {/* Every tab stays mounted, inactive ones hidden — CodeMirror state,
            panel state, grids and scroll positions all survive switching. */}
        {tabs.length === 0 && (
          /* Zero tabs is a calm, connected state — the bar above still carries
             "+" and the plugin menus; this is just the empty workspace. */
          <div className="qtab-empty">
            No tabs open — <b>+</b> or {SC.newTab} starts one. The connection stays up.
          </div>
        )}
        {tabs.map(tab => tab.panel ? (
          <div
            key={tab.id}
            className="qtab-panel-wrap"
            style={{ display: tab.id === activeId ? 'flex' : 'none' }}
          >
            {/* Mounted for its whole life (state survives switching), but a
                hidden panel must not poll the server — see store/tabVisibility. */}
            <TabVisibleProvider value={tab.id === activeId}>
              {/* Panels are React.lazy: the chunk fetches on first open, then
                  the module is cached — mounted-state behavior is unchanged. */}
              <Suspense fallback={null}>{panelFor(tab)}</Suspense>
            </TabVisibleProvider>
          </div>
        ) : (
          <div
            key={tab.id}
            className="qtab-editor-wrap"
            style={{ display: tab.id === activeId ? 'flex' : 'none' }}
            ref={tab.id === activeId ? splitWrapRef : undefined}
          >
            <div className="editor-toolbar">
              {supportsDbSelect && (
                /* In-DOM dropdown (MenuSelect), not a native select: the
                   native popup is an OS-toolkit menu — GTK-fonted and
                   unthemeable on Linux, subtly different on every desktop.
                   This one is the same pixels everywhere. */
                <MenuSelect
                  className="db-roulette"
                  title="Default database for editor queries (unqualified names resolve here)"
                  value={currentDb}
                  options={[{ value: '', label: '— no default DB —' },
                    ...dbList.map(d => ({ value: d, label: d }))]}
                  onChange={changeDb}
                />
              )}
              {/* Identity, then actions as icons. The old row spelled out
                  "⌘↵ run statement/selection · ⌘⇧↵ run all (script) · ⌘⇧F
                  format" on every tab forever — a keyboard reference that
                  stopped being news after the first day and pushed the actual
                  controls off the edge. The shortcuts now live in the tooltips,
                  where they are still one hover away. */}
              <span className="session-badge" title={`${session.connectionName} · ${session.engine}`}>
                <EngineLogo engine={session.engine} size={13} title={false} />
                {session.connectionName}
              </span>
              <button
                className={`toolbar-btn icon-only${editorWrap ? ' toolbar-btn-on' : ''}`}
                title={`Word wrap — ${editorWrap ? 'on' : 'off'} (${SC.wrap})`}
                aria-pressed={editorWrap}
                onClick={() => window.dispatchEvent(new CustomEvent('dbgui:toggle-wrap'))}
              >⏎</button>
              {session.engine !== 'redis' && (
                <button
                  className="toolbar-btn icon-only"
                  title={`Format SQL (${SC.format})`}
                  onClick={() => window.dispatchEvent(new CustomEvent('dbgui:format-sql', { detail: { tabId: activeId } }))}
                  disabled={!tab.sql.trim()}
                >{/* Was ⌘ — a glyph that names a key most of the world does
                     not have, on a button that formats SQL. The pilcrow reads
                     as "tidy the text" everywhere. */}¶</button>
              )}
              {session.engine !== 'redis' && (
                <button
                  className="toolbar-btn icon-only"
                  title={`Explain statement at cursor (${SC.explain})`}
                  onClick={() => explainTriggerRef.current?.()}
                  disabled={!tab.sql.trim() || tab.running}
                >🔬</button>
              )}
              {session.engine !== 'redis' && (
                <button
                  className={`toolbar-btn icon-only${outlineOpen ? ' active' : ''}`}
                  title="Outline — the statements in this script"
                  onClick={toggleOutline}
                >☰</button>
              )}
              <button
                className={`toolbar-btn icon-only${historyOpen ? ' active' : ''}`}
                title="Local history — earlier versions of this buffer"
                onClick={() => setHistoryOpen(v => !v)}
              >🕰</button>
              {tab.running ? (
                <>
                  {chProgress[tab.id] && (
                    // ClickHouse-only live read progress. Absent for other
                    // engines and for CH queries that finish before the first
                    // sample — the button alone then shows the running state.
                    <span
                      className="ch-progress"
                      style={{ marginRight: 8, fontVariantNumeric: 'tabular-nums', opacity: 0.85, fontSize: '0.85em' }}
                      title="ClickHouse live query progress — rows and bytes read (percent when the total is known)"
                    >
                      {formatChProgress(chProgress[tab.id])}
                    </span>
                  )}
                  <button className="cancel-btn" onClick={cancelQuery}>
                    ■ Cancel
                  </button>
                </>
              ) : (
                <span className="run-split">
                  <button
                    className={`run-btn run-btn-go${txOpen ? ' run-btn-tx' : ''}`}
                    onClick={() => (runTriggerRef.current ?? (() => runQuery(liveSql(tab))))()}
                    disabled={!tab.sql.trim()}
                    title={txOpen ? `Run (${SC.run}) — inside the open manual transaction` : `Run (${SC.run})`}
                  >
                    <span className="run-play">▶</span> Run{txOpen ? ' · tx' : ''}
                  </button>
                  <button
                    className="run-btn run-btn-caret"
                    title="More ways to run"
                    aria-haspopup="menu"
                    disabled={!tab.sql.trim()}
                    onClick={e => {
                      const r = e.currentTarget.getBoundingClientRect();
                      setRunMenu({ x: r.left, y: r.bottom + 4, tabId: tab.id });
                    }}
                  >▾</button>
                </span>
              )}
              {/* Commit and Rollback are always ON SCREEN, enabled only when a
                  connection is actually pinned — a button that appears the
                  moment it becomes usable is a button nobody finds, and one
                  that is clickable while nothing is held would settle whichever
                  pooled connection it reached. `@@autocommit` rides alongside
                  so the server's own view is never a guess. */}
              {session.engine !== 'redis' && (
                <span className={`tx-controls${txOpen ? ' tx-controls-open' : ''}`}>
                  <button
                    className={`toolbar-btn ${txOpen ? 'tx-open-btn' : 'tx-auto'}`}
                    disabled={!txCtl.canBegin && !txOpen}
                    title={txOpen
                      ? (manualCommit
                        ? 'This connection runs with autocommit OFF — a transaction is held open for the whole session. Nothing is durable until you Commit.'
                        : 'Manual transaction open — statements run on one held connection until COMMIT/ROLLBACK')
                      : 'Autocommit — each statement commits immediately. Click to open a manual transaction'}
                    onClick={txCtl.canBegin ? beginTx : undefined}
                  >{txBusy ? '…' : txOpen ? '● TX' : '⚡ AUTO'}</button>
                  <button className="toolbar-btn tx-commit"
                    title={txOpen ? 'COMMIT' : 'Nothing to commit — this connection autocommits every statement'}
                    disabled={!txCtl.canSettle}
                    onClick={() => endTx('commit_transaction')}>Commit</button>
                  <button className="toolbar-btn tx-rollback"
                    title={txOpen ? 'ROLLBACK' : 'Nothing to roll back — this connection autocommits every statement'}
                    disabled={!txCtl.canSettle}
                    onClick={() => endTx('rollback_transaction')}>Rollback</button>
                  {serverAutocommit !== null && (
                    // Compared against the CONNECTION's setting, not against
                    // whether a transaction is open: `@@autocommit` reports the
                    // connection's mode and stays 1 inside a plain BEGIN, so
                    // comparing it to the held state would flag every ordinary
                    // manual transaction as a fault.
                    <span
                      className={`tx-server${txCtl.mismatch ? ' tx-server-warn' : ''}`}
                      title={txCtl.mismatch
                        ? `This connection is set to autocommit ${manualCommit ? 'OFF' : 'ON'}, but the server reports ${serverAutocommit ? 'ON' : 'OFF'}. A SET autocommit run in the editor only reaches the one pooled connection it ran on — change it on the connection instead.`
                        : `The server reports autocommit ${serverAutocommit ? 'ON' : 'OFF'} — matching this connection's setting`}
                    >{txCtl.mismatch ? '⚠ ' : ''}@@autocommit={serverAutocommit ? 1 : 0}</span>
                  )}
                </span>
              )}
            </div>

            {/* Environment tint: the editor frame carries the session's
                environment colors (prod red, test amber — the .env-* chips'
                palette) so the danger signal is on the thing you type into,
                not only on the workspace chrome. Dev/unknown stay untinted. */}
            <div className={`cm-host cm-host-row${
              session.environment === 'prod' ? ' editor-env-prod'
                : session.environment === 'test' ? ' editor-env-test' : ''
            }`} style={{ flex: `0 0 ${effEditorH}px` }}>
              <Suspense fallback={null}>
              <SqlEditor
                tabId={tab.id}
                active={tab.id === activeId && !!isActive}
                engine={session.engine}
                flavor={editorFlavor}
                initialValue={tab.sql}
                initialHistory={getStoredHistory(undoHistRef.current, tab.bid)}
                onHistoryChange={h => rememberHistory(tab.bid, h)}
                schemaCompletions={completions}
                getColumns={getColumns}
                getFks={getFks}
                getServerVariables={getServerVariables}
                getSchemaTables={getSchemaTables}
                onRun={runQuery}
                onExplain={runExplain}
                onChange={sql => handleSqlChange(tab.id, sql)}
                onCursor={tab.id === activeId ? setCursor : undefined}
                insertTextRef={insertRefFor(tab.id)}
                explainNowRef={tab.id === activeId ? explainTriggerRef : undefined}
                runNowRef={tab.id === activeId ? runTriggerRef : undefined}
                runBareNowRef={tab.id === activeId ? runBareTriggerRef : undefined}
                onKillContext={tab.id === activeId && supportsProcesses ? handleKillContext : undefined}
                diagContext={session.engine === 'redis' ? undefined : buildDiagContext}
                onDiagnostics={tab.id === activeId ? setDiagCounts : undefined}
                statementRuns={statementRunsFor(tab)}
                showInvisibles={showInvisibles}
                readOnly={!!tab.readOnly}
                zoom={editorZoom}
                onZoom={bumpZoom}
                bookmarks={marksFor(tab.id).map(b => b.line)}
                getRoutineSignature={session.engine === 'redis' ? undefined : getRoutineSignature}
                onRenameReport={entries => entries.forEach(e => addLog(session.sessionId, {
                  level: e.level, action: 'RENAME', detail: e.line, line: e.line,
                }))}
                onOpenObject={name => window.dispatchEvent(new CustomEvent('dbgui:browse-table', {
                  detail: { table: name.replace(/[`"]/g, '') },
                }))}
                onPeekObject={name => {
                  const t = name.replace(/[`"]/g, '');
                  SchemaStore.getDdl(session.sessionId, t)
                    .then(sql => setPeekDdl({ title: t, sql }))
                    .catch(() => { /* object not resolvable — no peek */ });
                }}
                onAiAssist={(mode, sql) => setAiModal({ mode, sql })}
                onOptimizerTrace={sql => {
                  if (!sql.trim()) return;
                  invoke<string>('optimizer_trace', { sessionId: session.sessionId, sql, db: currentDb || null })
                    .then(t => { try { setTraceJson(JSON.stringify(JSON.parse(t), null, 2)); } catch { setTraceJson(t); } })
                    .catch(e => setTraceJson(`-- optimizer trace failed\n${errorDisplay(e)}`));
                }}
                killReplaceRef={tab.id === activeId ? killReplaceRef : undefined}
                placeholder={
                  session.engine === 'redis'
                    ? 'PING  /  GET key  /  HGETALL hash'
                    : `SELECT *  FROM  table  LIMIT 100;   — ${SC.run} to run, ${SC.format} to format`
                }
              />
              </Suspense>
              {historyOpen && (
                <Suspense fallback={null}>
                <BufferHistory
                  versions={historyRef.current.get(tab.id) ?? []}
                  current={tab.sql}
                  onRestore={text => {
                    // The buffer being replaced is itself worth a version —
                    // otherwise restoring loses whatever you were about to undo.
                    recordVersion(tab.id, tab.sql, 'manual');
                    patchTab(tab.id, { sql: text });
                    window.dispatchEvent(new CustomEvent('dbgui:replace-sql',
                      { detail: { sql: text, tabId: tab.id } }));
                    setHistoryOpen(false);
                  }}
                  onClose={() => setHistoryOpen(false)}
                />
                </Suspense>
              )}
              {outlineOpen && (
                <Suspense fallback={null}>
                <SqlOutline
                  sql={tab.sql}
                  caret={caretOffset(tab.sql, cursor)}
                  bookmarks={marksFor(tab.id).map(b => b.line)}
                  onGoto={(from, to) => window.dispatchEvent(
                    new CustomEvent('dbgui:goto-range', { detail: { from, to } }))}
                  onClose={toggleOutline}
                />
                </Suspense>
              )}
            </div>
            <div className="v-resizer" onMouseDown={dragEditor} title="Drag to resize editor" />

            {tab.error && (
              <div className="query-error">
                <span className="query-error-msg">{tab.error}</span>
                <button className="toolbar-btn query-error-fix"
                  title="Ask the AI assistant for a corrected statement"
                  onClick={() => setAiModal({ mode: 'fix', sql: currentEditorSql(), error: tab.error ?? '' })}>
                  ✦ Fix with AI
                </button>
              </div>
            )}

            {(tab.result || tab.scriptResults || tab.explain || tab.browsers.length > 0 || sessionLogNonEmpty) && (
              <div className="result-area">
                {/* ADS-style result tabs — Grid + Log always, others when present */}
                <ResultTabBar tab={tab} sid={sid} patchTab={patchTab} setTabs={setTabs} />

                {/* Views stay mounted while their tab exists — switching only
                    toggles visibility, so nothing reloads or loses state */}
                {tab.scriptResults && tab.scriptResultView != null && tab.scriptResults[tab.scriptResultView]?.result ? (
                  /* One script result, full area — picked by the Result N tabs. */
                  (() => {
                    const line = tab.scriptResults![tab.scriptResultView!];
                    const result = line.result!;
                    return (
                      <div className="result-keepalive" style={{ display: tab.view === 'grid' ? undefined : 'none' }}>
                        <div className="result-meta">
                          <span title={line.text}>{`statement ${tab.scriptResultView! + 1}`}</span>
                          {' · '}
                          {line.rows !== undefined && line.rows !== null ? `${line.rows} row(s)` : ''}
                          {line.ms !== undefined && ` · ${fmtDuration(line.ms)}`}
                          {result.rows.length < (line.rows ?? result.rows.length)
                            && ` · first ${result.rows.length.toLocaleString()} shown`}
                        </div>
                        <ResultGrid result={result} engine={session.engine} apiOutRef={gridApiRef} />
                      </div>
                    );
                  })()
                ) : tab.result && (
                  <div className="result-keepalive" style={{ display: tab.view === 'grid' ? undefined : 'none' }}>
                    <div className="result-meta">
                      {tab.result.rows_affected != null
                        ? `${tab.result.rows_affected} row(s) affected`
                        : `${tab.result.rows.length} row(s)`}
                      {' · '}
                      <span title={`execution: ${Math.round(tab.result.execution_ms)} ms · fetching: ${Math.round(tab.result.fetch_ms ?? 0)} ms`}>
                        {Math.round(tab.result.execution_ms + (tab.result.fetch_ms ?? 0))}ms
                      </span>
                      {tab.prodCap !== null && (
                        <span className="result-prodcap"
                          title="Prod row cap applied (Settings → Safety) — the status-bar Default LIMIT choice overrides it">
                          ⚠ prod cap {tab.prodCap.toLocaleString()}
                        </span>
                      )}
                      {tab.result.truncated && (
                        <span className="result-prodcap"
                          title="The backend row cap cut this result — the server had more rows than shown. Narrow the query or add a LIMIT.">
                          ⚠ truncated at {tab.result.rows.length.toLocaleString()} rows
                        </span>
                      )}
                      {charset && <span className="result-charset" title={`Server charset: ${charset} · cells decoded to Unicode (UTF-8) for display`}>🌐 {charset}</span>}
                    </div>
                    {/* A write/SET/DDL has no result set — say so out loud instead
                        of rendering an empty area (the "ran but nothing showed" bug). */}
                    {resultKind(tab.result, tab.resultSql ?? '') === 'rows'
                      ? <ResultGrid result={tab.result} engine={session.engine} apiOutRef={gridApiRef} />
                      : (
                        <div className="result-ok">
                          <span className="result-ok-icon">✓</span>
                          <span>{resultSummary(tab.result, tab.resultSql ?? '')}</span>
                        </div>
                      )}
                  </div>
                )}

                {/* Mounted only while selected: the canvas and its resize
                    observer cost nothing when the tab is not open, and the
                    picker state is cheap to rebuild. */}
                {tab.view === 'map' && tab.result && (
                  <Suspense fallback={null}>
                  <GraphicsView
                    columns={tab.result.columns}
                    rows={tab.result.rows}
                    initialMode={mappable(tab.result) ? 'map' : 'chart'}
                    onSelectRow={row => gridApiRef.current?.selectRow(row)}
                  />
                  </Suspense>
                )}

                {tab.view === 'plan' && tab.explain && (
                  <Suspense fallback={null}>
                  <ExplainView
                    data={tab.explain}
                    sessionId={session.sessionId}
                    // The plan history lives ON THE TAB (per-tab, in-memory):
                    // it survives the plan view unmounting, and comparing
                    // against another session's runs was never meaningful.
                    runs={tab.planRuns}
                    onRecordRuns={runs => patchTab(tab.id, { planRuns: runs })}
                    onAnalyze={async () => {
                      if (await confirmDialog('EXPLAIN ANALYZE executes the statement. Continue?')) {
                        runExplain(tab.explain!.sql, true);
                      }
                    }}
                    onMode={m => runExplain(tab.explain!.sql, false, m)}
                  />
                  </Suspense>
                )}

                {tab.browsers.map((bt, bi) => (
                  <div
                    key={`${session.sessionId}:${bt}`}
                    className="result-keepalive"
                    style={{ display: tab.view === 'browser' && tab.activeBrowser === bi ? undefined : 'none' }}
                  >
                    <Suspense fallback={null}>
                    <DataBrowser
                      sessionId={session.sessionId}
                      table={bt}
                      resultLabel={`Result ${bi + 1}`}
                      engine={session.engine}
                      connectionName={session.connectionName}
                      connectionId={session.connectionId}
                      dbUser={dbUserRef.current}
                      txOpen={txOpen}
                      onBeginTx={beginTx}
                      onEndTx={endTx}
                      onClose={() => setTabs(prev => prev.map(t => {
                        if (t.id !== tab.id) return t;
                        const browsers = t.browsers.filter((_, i) => i !== bi);
                        const activeBrowser = Math.max(0, Math.min(t.activeBrowser, browsers.length - 1));
                        return { ...t, browsers, activeBrowser, view: browsers.length ? t.view : 'grid' };
                      }))}
                      onFkNavigate={fkTable => {
                        // FK navigation opens a NEW result (keeps the current one)
                        setTabs(prev => prev.map(t => {
                          if (t.id !== tab.id) return t;
                          const idx = t.browsers.indexOf(fkTable);
                          const browsers = idx >= 0 ? t.browsers : [...t.browsers, fkTable];
                          return { ...t, browsers, activeBrowser: idx >= 0 ? idx : browsers.length - 1 };
                        }));
                      }}
                    />
                    </Suspense>
                  </div>
                ))}

                {tab.view === 'log' && (
                  <LogView
                    sid={sid}
                    connectionName={session.connectionName}
                    scope={logScope}
                    onScope={setLogScope}
                  />
                )}
              </div>
            )}

            {/* Bottom status bar: default row-limit control + cap indicator */}
            {session.engine !== 'redis' && (
            <div className="qtab-statusbar">
              <span className="qsb-label">Default LIMIT:</span>
              {LIMIT_CHOICES.map(n => (
                <button
                  key={n}
                  className={`qsb-btn ${defaultLimit === n ? 'active' : ''}`}
                  title={n === 0 ? 'No automatic limit — full result sets!' : `Cap SELECTs without LIMIT at ${n.toLocaleString()} rows`}
                  onClick={() => setDefaultLimit(n)}
                >{n === 0 ? '∞' : n >= 1000 ? `${n / 1000}k` : n}</button>
              ))}
              {tab.autoLimited !== null && (
                <span className="qsb-capped">
                  ⚠ result capped at {tab.autoLimited.toLocaleString()} (query had no LIMIT)
                </span>
              )}
              <div style={{ flex: 1 }} />
              {tab.id === activeId && cursor && (
                <span
                  className="qsb-cursor qsb-click"
                  title={`Go to line   ${SC.gotoLine}`}
                  onClick={() => window.dispatchEvent(new CustomEvent('dbgui:goto-line-dialog'))}
                >
                  Ln {cursor.line}, Col {cursor.col}
                  {cursor.selLen > 0 && ` · ${cursor.selLen} sel`}
                  {cursor.carets > 1 && ` · ${cursor.carets} carets`}
                </span>
              )}
              {/* Encoding and line endings belong to the *document*, and every
                  editor in this class shows them here. Click to convert. */}
              {tab.id === activeId && tab.file && (
                <>
                  <select
                    className="qsb-select"
                    value={tab.file.encoding}
                    title={`Encoding of ${tab.file.path} — changing this re-reads the file`}
                    onChange={e => void reopenWithEncoding(tab.id, e.target.value)}
                  >
                    {encodings.map(en => <option key={en} value={en}>{en}</option>)}
                  </select>
                  <select
                    className="qsb-select"
                    value={tab.file.eol}
                    title="Line endings written on save"
                    onChange={e => patchTab(tab.id, {
                      file: { ...tab.file!, eol: e.target.value as Eol },
                    })}
                  >
                    <option value="lf">LF</option>
                    <option value="crlf">CRLF</option>
                    <option value="cr">CR</option>
                    <option value="mixed">mixed</option>
                  </select>
                </>
              )}
              {(diagCounts.errors > 0 || diagCounts.warnings > 0 || diagCounts.infos > 0) && (
                <span className="qsb-diag" title="live analysis of this buffer — hover a squiggle for the detail">
                  {diagCounts.errors > 0 && <b className="qsb-diag-err">✖ {diagCounts.errors}</b>}
                  {diagCounts.warnings > 0 && <b className="qsb-diag-warn">⚠ {diagCounts.warnings}</b>}
                  {diagCounts.infos > 0 && <b className="qsb-diag-info">ℹ {diagCounts.infos}</b>}
                </span>
              )}
              <span className="qsb-hint">alias: save a query with :1 :2 → run “name val1 val2”</span>
            </div>
            )}
          </div>
        ))}


      </div>
      {/* Recovery list. Read by *when*, so the age leads and the label follows. */}
      {recoverOpen && (
        <div className="modal-overlay" onClick={() => setRecoverOpen(false)}>
          <div className="modal" style={{ maxWidth: 560 }} onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <span className="modal-title">Recover an earlier version</span>
              <button className="modal-close" onClick={() => setRecoverOpen(false)}>×</button>
            </div>
            <div className="recover-body">
              {snapshots.length === 0 && (
                <p className="dv-desc" style={{ padding: 16 }}>
                  No snapshots yet — one is taken every {Math.round(BACKUP_INTERVAL_MS / 60000)} minutes
                  while a buffer has unsaved text in it.
                </p>
              )}
              {snapshots.map((snap, i) => (
                <div key={`${snap.at}-${i}`} className="recover-row">
                  <span className="recover-age">{describeAge(snap.at, Date.now())}</span>
                  <span className="recover-label" title={snap.path}>{snap.label}</span>
                  <span className="recover-size">{snap.text.length.toLocaleString()} ch</span>
                  <button
                    className="toolbar-btn"
                    title="Open this version in a new tab — nothing you have now is replaced"
                    onClick={() => {
                      const t: QueryTab = {
                        ...newTab(`${snap.label} @${describeAge(snap.at, Date.now())}`),
                        sql: snap.text,
                      };
                      sqlRefs.current.set(t.id, snap.text);
                      commitTabs(prev => tabModel.addTab(prev, t).tabs, t.id);
                      setRecoverOpen(false);
                    }}
                  >Open in a new tab</button>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {runMenu && (
        <ContextMenu x={runMenu.x} y={runMenu.y} onClose={() => setRunMenu(null)}>
          <ContextMenuItem
            label={`Run script — no result tabs   ${SC.runAllBare}`}
            onClick={() => {
              const t = tabsRef.current.find(x => x.id === runMenu.tabId);
              setRunMenu(null);
              // Route through the active editor's F9 command so a selection
              // runs the selection, exactly like the key; the whole buffer is
              // only the fallback when no editor owns the trigger.
              if (t) (runBareTriggerRef.current
                ?? (() => runQuery(liveSql(t), undefined, { noResults: true })))();
            }}
          />
        </ContextMenu>
      )}

      {tabMenu && (
        <ContextMenu x={tabMenu.x} y={tabMenu.y} onClose={() => setTabMenu(null)}>
          <div className="qtab-menu-rename" onClick={() => { setRenaming(tabMenu.id); setTabMenu(null); }}>Rename</div>
          {/* Read-only is per document, not per connection: this is "let me
              read production DDL without being able to fat-finger it". */}
          <ContextMenuItem
            label={tabsRef.current.find(t => t.id === tabMenu.id)?.readOnly
              ? '✓ Read-only document' : 'Read-only document'}
            onClick={() => {
              const cur = tabsRef.current.find(t => t.id === tabMenu.id)?.readOnly;
              patchTab(tabMenu.id, { readOnly: !cur });
              setTabMenu(null);
            }}
          />
          <ContextMenuItem
            label={showInvisibles ? '✓ Show invisibles' : 'Show invisibles'}
            onClick={() => { setShowInvisibles(!showInvisibles); setTabMenu(null); }}
          />
          <ContextMenuItem
            label={`Reset zoom (${editorZoom}%)`}
            onClick={() => { setEditorZoom(100); setTabMenu(null); }}
          />
          {/* Ordinary tab-bar behaviour that was simply missing. */}
          <ContextMenuItem
            label={tabsRef.current.find(t => t.id === tabMenu.id)?.pinned ? '✓ Pinned' : 'Pin tab'}
            onClick={() => {
              const cur = tabsRef.current.find(t => t.id === tabMenu.id)?.pinned;
              patchTab(tabMenu.id, { pinned: !cur });
              // Re-sort so a newly pinned tab moves to the front immediately.
              setTabs(prev => [...prev.filter(t => t.pinned || t.id === tabMenu.id && !cur),
                               ...prev.filter(t => !(t.pinned || (t.id === tabMenu.id && !cur)))]);
              setTabMenu(null);
            }}
          />
          <ContextMenuItem
            label={`Recover an earlier version… (${snapshots.length})`}
            onClick={() => { setRecoverOpen(true); setTabMenu(null); }}
          />
          <ContextMenuItem
            label="Duplicate tab"
            onClick={() => {
              const src = tabsRef.current.find(t => t.id === tabMenu.id);
              if (!src) { setTabMenu(null); return; }
              const copy: QueryTab = {
                ...newTab(`${src.label} copy`),
                sql: sqlRefs.current.get(src.id) ?? src.sql ?? '',
                color: src.color,
                // Deliberately not the file binding: two tabs saving to one
                // path would race, and the copy is a scratch fork.
              };
              sqlRefs.current.set(copy.id, copy.sql);
              commitTabs(prev => tabModel.addTab(prev, copy).tabs, copy.id);
              setTabMenu(null);
            }}
          />
          <ContextMenuItem
            label="Close other tabs"
            onClick={() => { closeMany(t => t.id !== tabMenu.id); setTabMenu(null); }}
          />
          <ContextMenuItem
            label="Close tabs to the right"
            onClick={() => {
              const idx = tabsRef.current.findIndex(t => t.id === tabMenu.id);
              closeMany((_, i) => i <= idx);
              setTabMenu(null);
            }}
          />
          {/* The same 16 the connection form offers, so a query tab and its
              connection can be coloured from one vocabulary. */}
          <div className="qtab-menu-colors">
            <button
              className="qtab-swatch"
              title="no colour"
              style={{ background: 'transparent', borderColor: 'var(--border)' }}
              onClick={() => { patchTab(tabMenu.id, { color: '' }); setTabMenu(null); }}
            >✕</button>
            {PALETTE.map(c => (
              <button
                key={c}
                className="qtab-swatch"
                title={c}
                style={{ background: c, borderColor: c }}
                onClick={() => { patchTab(tabMenu.id, { color: c }); setTabMenu(null); }}
              />
            ))}
          </div>
        </ContextMenu>
      )}

      {/* `kill …` / `killall` — live process picker at the caret. Never shown
          behind a panel overlay (the editor isn't visible then). */}
      {writeAsk && (
        <Suspense fallback={null}>
        <WriteConfirm
          request={writeAsk}
          onCancel={() => setWriteAsk(null)}
          onRun={() => {
            const { sql, tabId, from, noResults } = writeAsk;
            setWriteAsk(null);
            // Past the guard: variables still get their prompt.
            const vars = can(session.engine, 'sqlVariables') ? findVariables(sql) : [];
            if (vars.length > 0) setVarPrompt({ vars, sql, tabId, from, noResults });
            else executeSql(sql, tabId, from, noResults);
          }}
        />
        </Suspense>
      )}

      {/* A script paused on a failed statement — the run is blocked on this
          answer, so it must be resolved exactly once whichever way it closes. */}
      {scriptAsk && (
        <Suspense fallback={null}>
        <ScriptErrorPrompt
          stmtNo={scriptAsk.stmtNo}
          total={scriptAsk.total}
          sql={scriptAsk.sql}
          error={scriptAsk.error}
          inTransaction={scriptAsk.inTransaction}
          savepointed={scriptAsk.savepointed}
          onChoose={choice => scriptAsk.resolve(choice)}
        />
        </Suspense>
      )}

      {closeAsk && (
        <CloseTabConfirm
          tabLabel={closeAsk.tab.label}
          activities={closeAskActivities}
          onCancel={() => setCloseAsk(null)}
          onCloseKeepRunning={() => {
            const { tab } = closeAsk;
            const left = closeAskActivities;
            addLog(session.sessionId, { level: 'info', action: 'TAB',
              detail: left.length === 0
                ? `closed “${tab.label}”`
                : `closed “${tab.label}” — ${left.length} activity(ies) left running: `
                  + left.map(a => a.label).join(', ') });
            setCloseAsk(null);
            forceCloseTab(tab.id);
          }}
          onKillAndClose={async () => {
            const { tab } = closeAsk;
            const doomed = closeAskActivities;
            setCloseAsk(null);
            for (const a of doomed) {
              try { await a.kill?.(); } catch { /* best-effort: closing anyway */ }
            }
            // Stopped for real → drop every activity this tab registered
            // (a panel's own id too, not just a SQL tab's 'query').
            clearTabActivities(activityKeyOf(tab));
            addLog(session.sessionId, { level: doomed.length ? 'warn' : 'info', action: 'TAB',
              detail: doomed.length === 0
                ? `closed “${tab.label}” — its work had already finished`
                : `closed “${tab.label}” and stopped: ${doomed.map(a => a.label
                  + (a.threads?.length ? ` (threads ${a.threads.map(t => `#${t}`).join(',')})` : '')).join(', ')}` });
            forceCloseTab(tab.id);
          }}
        />
      )}

      {killCtx && supportsProcesses && activePanel === null && (
        <Suspense fallback={null}>
        <KillPicker
          session={session}
          trigger={killCtx.trigger}
          anchor={killCtx.anchor}
          onInsertIds={text => { killReplaceRef.current?.(text); closeKillPicker(); }}
          onClose={closeKillPicker}
        />
        </Suspense>
      )}
    </div>
  );
}