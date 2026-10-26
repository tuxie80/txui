/**
 * MongoDB workspace: the find editor + JSON grid.
 *
 * A MongoDB session mounts this instead of QueryTabs (the same routing
 * RedisBrowser established): MongoDB is not SQL, so there is no SQL editor to
 * grey out — the query surface IS this panel. The SchemaTree stays visible
 * (databases → collections/views → sampled keys); double-clicking a
 * collection dispatches `dbgui:browse-table` and this listens for it.
 *
 * Shape (three permanent tabs plus the DBA panels):
 * - **Find**: an address bar naming the collection being queried
 *   (db.collection), one CodeMirror document for the FILTER (extended JSON
 *   accepted: {"_id": {"$oid": "…"}} works), plus plain inputs for
 *   projection / sort / limit / skip. Run → `mongo_find`; results render in
 *   the shared ResultGrid (JSON grid: union of the page's top-level keys,
 *   nested values as JSON text). Explain → `mongo_explain` (queryPlanner;
 *   executionStats is opt-in because it executes the query) shown as pretty
 *   JSON.
 * - **Aggregate**: one CodeMirror document for the PIPELINE (a JSON array of
 *   stage documents) plus a stage-snippet dropdown and a limit input. Run
 *   pre-flights utils/mongoPipeline.validatePipeline() (client-side, no
 *   invoke) and then calls `mongo_aggregate`; the Rust side rejects
 *   $out/$merge again before anything reaches the server. No skip-paging in
 *   v1 — a pipeline is not a stable ordered scan.
 * - **Stats**: `mongo_coll_stats` ($collStats: storageStats + count +
 *   latencyStats) flattened to the (section, name, value) grid. Loads on tab
 *   entry and on explicit Refresh only — no polling. A view's server-side
 *   refusal is shown readably, not pre-hidden.
 *
 * Both result grids carry a 📈 Graphics toggle — the same GraphicsView the
 * SQL engines get (QueryTabs / DataBrowser): GeoJSON sub-documents draw on
 * the map, numeric columns chart. Detection is utils/geoDetect; MongoDB
 * sub-documents arrive as real objects, which its GeoJSON probe reads.
 *
 * DBA panels (Processes / Server) open as extra tabs via the Tools menu's
 * `dbgui:toggle-panel` events — the listener has to live here for the same
 * reason it lives in RedisBrowser.
 *
 * Read-only: the MongoDB driver has no write path at all (v1, by design) —
 * the hint line says so where a user would otherwise look for one.
 */
import { useCallback, useEffect, useRef, useState, lazy, Suspense } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { EditorView, keymap, highlightActiveLine, highlightActiveLineGutter,
  lineNumbers } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { bracketMatching } from '@codemirror/language';
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import type { QueryResult, Session } from '../types';
import { errorDisplay } from '../utils/appError';
import { mongoPanel, mongoPanelAllowed } from '../utils/mongoPanels';
import { DEFAULT_PIPELINE, STAGE_SNIPPETS, appendSnippet, validatePipeline } from '../utils/mongoPipeline';
import { PanelIcon } from './panelIcons';
import { ProcessListPanel } from './ProcessListPanel';
import { ServerInfoPanel } from './ServerInfoPanel';
import { ResultGrid } from './ResultGrid';
import { mappableResult } from '../utils/geoDetect';

// The map/chart surface is heavy (canvas, track playback) and most sessions
// never open it — lazy per the panel contract, same as QueryTabs does.
const GraphicsView = lazy(() => import('./GraphicsView').then(m => ({ default: m.GraphicsView })));

interface Props { session: Session; isActive?: boolean }

/** The collection being queried. null = nothing chosen yet. */
interface Address { db: string; coll: string }

const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 10_000; // mirrors MAX_FIND_LIMIT in src-tauri/src/db/mongodb.rs

/**
 * One JSON document editor: CodeMirror with no language mode (lang-json is
 * deliberately not a dependency — the value here is editing comfort, not
 * highlighting: brackets close, history works, errors come from the server
 * side parse with the field named). Shared by the Find filter and the
 * Aggregate pipeline; `viewRef` hands the EditorView back so a caller (the
 * snippet dropdown) can replace the whole document.
 */
function JsonEditor({ value, onChange, onRun, className, minHeight, viewRef }: {
  value: string;
  onChange: (v: string) => void;
  onRun: () => void;
  className: string;
  minHeight?: number;
  viewRef?: React.MutableRefObject<EditorView | null>;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const runRef = useRef(onRun);
  runRef.current = onRun;

  useEffect(() => {
    if (!hostRef.current) return;
    const view = new EditorView({
      parent: hostRef.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(),
          highlightActiveLine(),
          highlightActiveLineGutter(),
          bracketMatching(),
          closeBrackets(),
          history(),
          keymap.of([
            // Mod-Enter runs the query — the muscle memory from the SQL editor.
            { key: 'Mod-Enter', run: () => { runRef.current(); return true; } },
            ...closeBracketsKeymap,
            ...defaultKeymap,
            ...historyKeymap,
            indentWithTab,
          ]),
          EditorView.updateListener.of(u => { if (u.docChanged) onChange(u.state.doc.toString()); }),
          EditorView.theme({
            '&': {
              fontSize: 'calc(13px * var(--font-scale, 1))',
              border: '1px solid var(--border)',
              borderRadius: '4px',
              background: 'var(--bg)',
            },
            '.cm-scroller': { fontFamily: 'var(--mono, monospace)', minHeight: `${minHeight ?? 72}px` },
            '.cm-gutters': { background: 'var(--bg)', color: 'var(--muted)', border: 'none' },
            '&.cm-focused': { outline: 'none', borderColor: 'var(--accent)' },
          }),
        ],
      }),
    });
    if (viewRef) viewRef.current = view;
    return () => { view.destroy(); if (viewRef) viewRef.current = null; };
    // Mount once; the component owns the doc afterwards (onChange is the only
    // way back out — the address bar never rewrites the document).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <div ref={hostRef} className={className} />;
}

export function MongoBrowser({ session, isActive }: Props) {
  const sessionId = session.sessionId;
  const [tab, setTab] = useState('find');
  const [addr, setAddr] = useState<Address | null>(null);
  const [filter, setFilter] = useState('');
  const [projection, setProjection] = useState('');
  const [sort, setSort] = useState('');
  const [limit, setLimit] = useState(String(DEFAULT_LIMIT));
  const [skip, setSkip] = useState('0');
  const [running, setRunning] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<QueryResult | null>(null);
  const [plan, setPlan] = useState<string | null>(null);
  const [analyze, setAnalyze] = useState(false);
  // 📈 Graphics toggle over the Find / Aggregate result grids (GeoJSON → map).
  const [findGraphics, setFindGraphics] = useState(false);
  const [aggGraphics, setAggGraphics] = useState(false);
  // Aggregate tab.
  const [pipeline, setPipeline] = useState(DEFAULT_PIPELINE);
  const [aggLimit, setAggLimit] = useState(String(DEFAULT_LIMIT));
  const [aggRunning, setAggRunning] = useState(false);
  const [aggErr, setAggErr] = useState<string | null>(null);
  const [aggResult, setAggResult] = useState<QueryResult | null>(null);
  const pipelineViewRef = useRef<EditorView | null>(null);
  // Stats tab.
  const [statsRunning, setStatsRunning] = useState(false);
  const [statsErr, setStatsErr] = useState<string | null>(null);
  const [statsResult, setStatsResult] = useState<QueryResult | null>(null);

  const run = useCallback(async (a: Address, pageSkip?: number) => {
    const lim = Math.max(1, Math.min(MAX_LIMIT, Number(limit) || DEFAULT_LIMIT));
    const sk = Math.max(0, pageSkip ?? (Number(skip) || 0));
    setRunning(true);
    setErr(null);
    setPlan(null);
    try {
      const r = await invoke<QueryResult>('mongo_find', {
        sessionId, db: a.db, collection: a.coll,
        filter: filter.trim() || null,
        projection: projection.trim() || null,
        sort: sort.trim() || null,
        limit: lim,
        skip: sk,
      });
      setResult(r);
      setSkip(String(sk));
    } catch (e) {
      setErr(errorDisplay(e));
      setResult(null);
    } finally {
      setRunning(false);
    }
  }, [sessionId, filter, projection, sort, limit, skip]);

  const explain = useCallback(async (a: Address) => {
    setRunning(true);
    setErr(null);
    setPlan(null);
    try {
      const p = await invoke<string>('mongo_explain', {
        sessionId, db: a.db, collection: a.coll,
        filter: filter.trim() || null,
        analyze,
      });
      setPlan(p);
    } catch (e) {
      setErr(errorDisplay(e));
    } finally {
      setRunning(false);
    }
  }, [sessionId, filter, analyze]);

  // ── Aggregate tab ──────────────────────────────────────────────────────────

  const runAggregate = useCallback(async (a: Address) => {
    // Client-side pre-flight first: a bad pipeline never leaves the webview.
    // The Rust side enforces the same rules (and the $out/$merge rejection)
    // again before anything reaches the server.
    const v = validatePipeline(pipeline);
    if (!v.ok) {
      setAggErr(v.error);
      return;
    }
    const lim = Math.max(1, Math.min(MAX_LIMIT, Number(aggLimit) || DEFAULT_LIMIT));
    setAggRunning(true);
    setAggErr(null);
    try {
      const r = await invoke<QueryResult>('mongo_aggregate', {
        sessionId, db: a.db, collection: a.coll,
        pipeline,
        limit: lim,
      });
      setAggResult(r);
    } catch (e) {
      setAggErr(errorDisplay(e));
      setAggResult(null);
    } finally {
      setAggRunning(false);
    }
  }, [sessionId, pipeline, aggLimit]);

  const addSnippet = useCallback((name: string) => {
    const s = STAGE_SNIPPETS.find(x => x.name === name);
    if (!s) return;
    const r = appendSnippet(pipeline, s.snippet);
    if (!r.ok) {
      setAggErr(r.error);
      return;
    }
    setAggErr(null);
    setPipeline(r.text);
    // The editor owns its doc after mount — replace it wholesale.
    const view = pipelineViewRef.current;
    if (view) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: r.text } });
    }
  }, [pipeline]);

  // ── Stats tab ──────────────────────────────────────────────────────────────

  const loadStats = useCallback(async (a: Address) => {
    setStatsRunning(true);
    setStatsErr(null);
    try {
      const r = await invoke<QueryResult>('mongo_coll_stats', {
        sessionId, db: a.db, collection: a.coll,
      });
      setStatsResult(r);
    } catch (e) {
      setStatsErr(errorDisplay(e));
      setStatsResult(null);
    } finally {
      setStatsRunning(false);
    }
  }, [sessionId]);

  // Load on tab entry (and when the address changes while looking at Stats);
  // afterwards only the explicit Refresh button reloads — no polling.
  useEffect(() => {
    if (tab === 'stats' && addr) void loadStats(addr);
  }, [tab, addr, loadStats]);

  // The tree's double-click / "Browse table" lands here. Only the ACTIVE
  // session answers (every session workspace stays mounted).
  useEffect(() => {
    if (!isActive) return;
    const onBrowse = (e: Event) => {
      const detail = (e as CustomEvent<{ table: string }>).detail;
      if (!detail?.table) return;
      const dot = detail.table.indexOf('.');
      if (dot <= 0) return;
      const a = { db: detail.table.slice(0, dot), coll: detail.table.slice(dot + 1) };
      setAddr(a);
      setTab('find');
      setSkip('0');
      void run(a, 0);
    };
    window.addEventListener('dbgui:browse-table', onBrowse);
    return () => window.removeEventListener('dbgui:browse-table', onBrowse);
  }, [isActive, run]);

  // Tools-menu panels. Same semantics as QueryTabs.panelToggle: toggling the
  // panel you are looking at closes it; the engine gate is mongoPanelAllowed.
  useEffect(() => {
    if (!isActive) return;
    const onTogglePanel = (e: Event) => {
      const panel = (e as CustomEvent<{ panel: string }>).detail?.panel;
      if (!panel || !mongoPanelAllowed(session.engine, panel)) return;
      setTab(cur => (cur === panel ? 'find' : panel));
    };
    window.addEventListener('dbgui:toggle-panel', onTogglePanel);
    return () => window.removeEventListener('dbgui:toggle-panel', onTogglePanel);
  }, [isActive, session.engine]);

  const activePanel = mongoPanel(tab);
  const lim = Math.max(1, Math.min(MAX_LIMIT, Number(limit) || DEFAULT_LIMIT));
  const sk = Math.max(0, Number(skip) || 0);

  // The map/chart surface over a result — identical wiring to QueryTabs'
  // Graphics tab: geometry-first when the rows carry decodable geometry
  // (GeoJSON sub-documents decode via utils/geoDetect), a chart otherwise.
  const graphicsFor = (r: QueryResult) => (
    <Suspense fallback={null}>
      <GraphicsView
        columns={r.columns}
        rows={r.rows}
        initialMode={mappableResult(
          r.columns.map(c => ({ name: c.name, typeName: c.type_name })),
          r.rows,
        ) ? 'map' : 'chart'}
        engine={session.engine}
      />
    </Suspense>
  );

  // Shared by the three workspace tabs.
  const addrBar = (
    <div className="mb-addr-bar">
      <span className="form-hint">collection</span>
      <code className="mb-addr">{addr ? `${addr.db}.${addr.coll}` : '(pick a collection in the tree)'}</code>
      <span className="form-hint mb-ro-hint"
        title="MongoDB v1 is read-only by design — the driver has no write path at all.">
        read-only
      </span>
    </div>
  );
  const emptyHint = (
    <div className="rb-empty" style={{ padding: 24 }}>
      Open a database in the object explorer and double-click a collection
      to query it here. The filter is a MongoDB query document —
      <code>{' {"parity": "even", "n": {"$gte": 100}} '}</code> — not SQL.
    </div>
  );

  return (
    <div className="redis-browser">
      <div className="rb-tab-bar">
        <button
          className={`rb-tab ${tab === 'find' ? 'active' : ''}`}
          onClick={() => setTab('find')}
        >Find</button>
        <button
          className={`rb-tab ${tab === 'aggregate' ? 'active' : ''}`}
          onClick={() => setTab('aggregate')}
        >Aggregate</button>
        <button
          className={`rb-tab ${tab === 'stats' ? 'active' : ''}`}
          onClick={() => setTab('stats')}
        >Stats</button>
        {activePanel && (
          <button
            className="rb-tab active"
            onClick={() => setTab('find')}
            title="Close panel"
          ><span className="icon-slot"><PanelIcon panel={activePanel.id} size={13} /></span>{activePanel.label} ×</button>
        )}
      </div>

      {tab === 'processes' && (
        <ProcessListPanel session={session} onClose={() => setTab('find')} />
      )}
      {tab === 'serverinfo' && (
        <ServerInfoPanel sessionId={sessionId} engine={session.engine} onClose={() => setTab('find')} />
      )}

      {tab === 'find' && (
        <div className="mb-find-pane">
          {addrBar}

          {addr && (
            <>
              <div className="mb-editor-block">
                <div className="form-hint mb-label">filter (JSON document; extended JSON like {'{"$oid": "…"}'} works)</div>
                <JsonEditor value={filter} onChange={setFilter} onRun={() => void run(addr)} className="mb-filter" />
              </div>
              <div className="mb-fields">
                <label className="form-hint">projection
                  <input value={projection} onChange={e => setProjection(e.target.value)}
                    placeholder='{"name": 1}' spellCheck={false} />
                </label>
                <label className="form-hint">sort
                  <input value={sort} onChange={e => setSort(e.target.value)}
                    placeholder='{"n": -1}' spellCheck={false} />
                </label>
                <label className="form-hint">limit
                  <input type="number" min={1} max={MAX_LIMIT} value={limit}
                    onChange={e => setLimit(e.target.value)} style={{ width: 90 }} />
                </label>
                <label className="form-hint">skip
                  <input type="number" min={0} value={skip}
                    onChange={e => setSkip(e.target.value)} style={{ width: 90 }} />
                </label>
                <button className="primary" onClick={() => void run(addr)} disabled={running}>
                  {running ? 'Running…' : 'Run ⏎'}
                </button>
                <button className="toolbar-btn" onClick={() => void explain(addr)} disabled={running}
                  title="queryPlanner by default; tick executionStats to measure (executes the query)">
                  Explain
                </button>
                <label className="form-hint mb-analyze" title="executionStats EXECUTES the find — like EXPLAIN ANALYZE">
                  <input type="checkbox" checked={analyze} onChange={e => setAnalyze(e.target.checked)} />
                  executionStats
                </label>
                {result && sk >= lim && (
                  <button className="toolbar-btn" onClick={() => void run(addr, sk - lim)}>← Prev</button>
                )}
                {result && result.rows.length >= lim && (
                  <button className="toolbar-btn" onClick={() => void run(addr, sk + lim)}
                    title="A full page came back — there may be more">
                    Next →
                  </button>
                )}
                {result && result.rows.length > 0 && (
                  <button className={`toolbar-btn ${findGraphics ? 'active' : ''}`}
                    data-tip="Visualise these documents — a map (GeoJSON) or a chart"
                    onClick={() => setFindGraphics(v => !v)}>📈 Graphics</button>
                )}
              </div>
            </>
          )}

          {err && <div className="rb-err">{err}</div>}

          {plan !== null && (
            <pre className="mb-plan">{plan}</pre>
          )}

          {plan === null && result && (
            <>
              {findGraphics && (
                <div className="mb-grid">{graphicsFor(result)}</div>
              )}
              <div className="mb-grid" style={findGraphics ? { display: 'none' } : undefined}>
                <ResultGrid result={result} />
              </div>
            </>
          )}

          {!addr && emptyHint}
        </div>
      )}

      {tab === 'aggregate' && (
        <div className="mb-find-pane">
          {addrBar}

          {addr && (
            <>
              <div className="mb-editor-block">
                <div className="form-hint mb-label">
                  pipeline (JSON array of stages; extended JSON works — $out/$merge are rejected, read-only by design)
                </div>
                <JsonEditor value={pipeline} onChange={setPipeline} onRun={() => void runAggregate(addr)}
                  className="mb-pipeline" minHeight={140} viewRef={pipelineViewRef} />
              </div>
              <div className="mb-fields">
                <label className="form-hint">add stage
                  <select value="" onChange={e => { if (e.target.value) addSnippet(e.target.value); }}>
                    <option value="">snippet…</option>
                    {STAGE_SNIPPETS.map(s => <option key={s.name} value={s.name}>{s.name}</option>)}
                  </select>
                </label>
                <label className="form-hint">limit
                  <input type="number" min={1} max={MAX_LIMIT} value={aggLimit}
                    onChange={e => setAggLimit(e.target.value)} style={{ width: 90 }} />
                </label>
                <button className="primary" onClick={() => void runAggregate(addr)} disabled={aggRunning}>
                  {aggRunning ? 'Running…' : 'Run ⏎'}
                </button>
                <span className="form-hint"
                  title="A trailing $limit (this value, capped at 10 000) is appended server-side — an unbounded pipeline never streams a whole collection. allowDiskUse is on, so big $group/$sort stages spill instead of failing.">
                  trailing $limit guard · allowDiskUse on
                </span>
                {aggResult && aggResult.rows.length > 0 && (
                  <button className={`toolbar-btn ${aggGraphics ? 'active' : ''}`}
                    data-tip="Visualise these documents — a map (GeoJSON) or a chart"
                    onClick={() => setAggGraphics(v => !v)}>📈 Graphics</button>
                )}
              </div>
            </>
          )}

          {aggErr && <div className="rb-err">{aggErr}</div>}

          {aggResult && (
            <>
              {aggGraphics && (
                <div className="mb-grid">{graphicsFor(aggResult)}</div>
              )}
              <div className="mb-grid" style={aggGraphics ? { display: 'none' } : undefined}>
                <ResultGrid result={aggResult} />
              </div>
            </>
          )}

          {!addr && emptyHint}
        </div>
      )}

      {tab === 'stats' && (
        <div className="mb-find-pane">
          {addrBar}

          {addr && (
            <div className="mb-fields">
              <button className="toolbar-btn" onClick={() => void loadStats(addr)} disabled={statsRunning}>
                {statsRunning ? 'Loading…' : 'Refresh'}
              </button>
            </div>
          )}

          {statsErr && <div className="rb-err">{statsErr}</div>}

          {statsResult && (
            <div className="mb-grid">
              <ResultGrid result={statsResult} />
            </div>
          )}

          {addr && (
            <div className="mb-stats-foot">
              From the $collStats aggregation stage (storageStats + count + latencyStats).
              Views refuse server-side — the refusal is shown as-is above.
            </div>
          )}

          {!addr && emptyHint}
        </div>
      )}
    </div>
  );
}
