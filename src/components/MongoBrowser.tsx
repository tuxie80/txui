/**
 * MongoDB workspace: the find editor + JSON grid.
 *
 * A MongoDB session mounts this instead of QueryTabs (the same routing
 * RedisBrowser established): MongoDB is not SQL, so there is no SQL editor to
 * grey out — the query surface IS this panel. The SchemaTree stays visible
 * (databases → collections/views → sampled keys); double-clicking a
 * collection dispatches `dbgui:browse-table` and this listens for it.
 *
 * Shape:
 * - an address bar naming the collection being queried (db.collection),
 * - one CodeMirror document for the FILTER (extended JSON accepted:
 *   {"_id": {"$oid": "…"}} works), plus plain inputs for projection / sort /
 *   limit / skip,
 * - Run → `mongo_find`; results render in the shared ResultGrid (JSON grid:
 *   union of the page's top-level keys, nested values as JSON text),
 * - Explain → `mongo_explain` (queryPlanner; executionStats is opt-in because
 *   it executes the query) shown as pretty JSON.
 *
 * DBA panels (Processes / Server) open as extra tabs via the Tools menu's
 * `dbgui:toggle-panel` events — the listener has to live here for the same
 * reason it lives in RedisBrowser.
 *
 * Read-only: the MongoDB driver has no write path at all (v1, by design) —
 * the hint line says so where a user would otherwise look for one.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
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
import { PanelIcon } from './panelIcons';
import { ProcessListPanel } from './ProcessListPanel';
import { ServerInfoPanel } from './ServerInfoPanel';
import { ResultGrid } from './ResultGrid';

interface Props { session: Session; isActive?: boolean }

/** The collection being queried. null = nothing chosen yet. */
interface Address { db: string; coll: string }

const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 10_000; // mirrors MAX_FIND_LIMIT in src-tauri/src/db/mongodb.rs

/**
 * The filter document editor: CodeMirror with no language mode (lang-json is
 * deliberately not a dependency — the value here is editing comfort, not
 * highlighting: brackets close, history works, errors come from the server
 * side parse with the field named).
 */
function FilterEditor({ value, onChange, onRun }: {
  value: string;
  onChange: (v: string) => void;
  onRun: () => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
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
            // Mod-Enter runs the find — the muscle memory from the SQL editor.
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
            '.cm-scroller': { fontFamily: 'var(--mono, monospace)', minHeight: '72px' },
            '.cm-gutters': { background: 'var(--bg)', color: 'var(--muted)', border: 'none' },
            '&.cm-focused': { outline: 'none', borderColor: 'var(--accent)' },
          }),
        ],
      }),
    });
    viewRef.current = view;
    return () => { view.destroy(); viewRef.current = null; };
    // Mount once; the component owns the doc afterwards (onChange is the only
    // way back out — the address bar never rewrites the filter).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <div ref={hostRef} className="mb-filter" />;
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

  return (
    <div className="redis-browser">
      <div className="rb-tab-bar">
        <button
          className={`rb-tab ${tab === 'find' ? 'active' : ''}`}
          onClick={() => setTab('find')}
        >Find</button>
        {activePanel && (
          <button
            className="rb-tab active"
            onClick={() => setTab('find')}
            title="Close panel"
          ><span className="icon-slot"><PanelIcon panel={activePanel.id} size={13} /></span>{activePanel.label} ×</button>
        )}
      </div>

      {tab === 'processes' && (
        <ProcessListPanel sessionId={sessionId} connectionName={session.connectionName}
          engine={session.engine} onClose={() => setTab('find')} />
      )}
      {tab === 'serverinfo' && (
        <ServerInfoPanel sessionId={sessionId} engine={session.engine} onClose={() => setTab('find')} />
      )}

      {tab === 'find' && (
        <div className="mb-find-pane">
          <div className="mb-addr-bar">
            <span className="form-hint">collection</span>
            <code className="mb-addr">{addr ? `${addr.db}.${addr.coll}` : '(pick a collection in the tree)'}</code>
            <span className="form-hint mb-ro-hint"
              title="MongoDB v1 is read-only by design — the driver has no write path at all.">
              read-only
            </span>
          </div>

          {addr && (
            <>
              <div className="mb-editor-block">
                <div className="form-hint mb-label">filter (JSON document; extended JSON like {'{"$oid": "…"}'} works)</div>
                <FilterEditor value={filter} onChange={setFilter} onRun={() => void run(addr)} />
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
              </div>
            </>
          )}

          {err && <div className="rb-err">{err}</div>}

          {plan !== null && (
            <pre className="mb-plan">{plan}</pre>
          )}

          {plan === null && result && (
            <div className="mb-grid">
              <ResultGrid result={result} />
            </div>
          )}

          {!addr && (
            <div className="rb-empty" style={{ padding: 24 }}>
              Open a database in the object explorer and double-click a collection
              to query it here. The filter is a MongoDB query document —
              <code>{' {"parity": "even", "n": {"$gte": 100}} '}</code> — not SQL.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
