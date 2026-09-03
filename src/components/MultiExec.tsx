/**
 * Multi-server execution workbench ("fleet exec").
 * Pick servers → one statement → parallel ephemeral execution with live
 * per-server progress, per-server grids, a merged grid (server column),
 * an error log, and a persistent run log.
 */
import { errorDisplay } from '../utils/appError';
import { alertDialog, confirmDialog } from '../utils/appDialog';
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke, Channel } from '@tauri-apps/api/core';
import { audited } from '../utils/panelAudit';
import type { ConnectionConfig, QueryResult } from '../types';
import { ConnectionsStore } from '../store/connections';
import { FastGrid } from './FastGrid';
import { CopyExportMenu } from './CopyExportMenu';
import { GridSettingsPopover } from './GridSettingsPopover';
import { isWriteStatement } from '../utils/sqlGuard';
import { shortcuts } from '../utils/platform';

/** Shortcut labels for this platform — see utils/platform. */
const SC = shortcuts();

const SqlEditor = lazy(() =>
  import('./SqlEditor').then(m => ({ default: m.SqlEditor })));

const ENGINE_ICON: Record<string, string> = {
  mysql: '🐬', postgres: '🐘', redis: '⚡', mongodb: '🍃',
};

type Status = 'pending' | 'running' | 'ok' | 'error';

interface ServerRun {
  id: string;
  name: string;
  status: Status;
  ms?: number;
  rowsReturned?: number;
  truncated?: boolean;
  error?: string;
  result?: QueryResult | null;
}

type ExecEvent =
  | { type: 'started'; connection_id: string; name: string }
  | { type: 'finished'; connection_id: string; name: string; ok: boolean;
      result: QueryResult | null; truncated: boolean; error: string | null; execution_ms: number }
  | { type: 'done'; run_id: number; ok_count: number; err_count: number; total_ms: number };

interface RunSummary {
  id: number; sql: string; total: number; ok_count: number;
  err_count: number; total_ms: number; created_at: string;
}
interface RunDetail {
  connection_name: string; ok: boolean; rows_returned: number;
  rows_affected: number | null; execution_ms: number; error: string | null;
}

type ResultTab = 'results' | 'merged' | 'errors' | 'log';

interface Props { onClose?: () => void }

export function MultiExec({ onClose }: Props) {
  const [conns, setConns] = useState<ConnectionConfig[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [connFilter, setConnFilter] = useState('');
  const [sql, setSql] = useState('');
  const [running, setRunning] = useState(false);
  const [runs, setRuns] = useState<Map<string, ServerRun>>(new Map());
  const [doneInfo, setDoneInfo] = useState<{ ok: number; err: number; ms: number } | null>(null);
  const [tab, setTab] = useState<ResultTab>('results');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [log, setLog] = useState<RunSummary[]>([]);
  const [logDetail, setLogDetail] = useState<{ run: RunSummary; details: RunDetail[] } | null>(null);
  // The fleet run streams events via a Channel that outlives an unmount —
  // guard state updates so a closed panel doesn't setState after unmount.
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);

  useEffect(() => {
    ConnectionsStore.list().then(setConns).catch(() => {});
  }, []);

  const loadLog = useCallback(() => {
    invoke<RunSummary[]>('list_multi_runs', { limit: 100 })
      .then(setLog)
      .catch(() => {});
  }, []);
  useEffect(() => { if (tab === 'log') loadLog(); }, [tab, loadLog]);

  // ── Server picker ──────────────────────────────────────────────────────────

  const groups = useMemo(() => {
    const q = connFilter.trim().toLowerCase();
    const list = q
      ? conns.filter(c => c.name.toLowerCase().includes(q) || (c.group ?? '').toLowerCase().includes(q))
      : conns;
    const map = new Map<string, ConnectionConfig[]>();
    for (const c of list) {
      const g = c.group ?? '';
      if (!map.has(g)) map.set(g, []);
      map.get(g)!.push(c);
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [conns, connFilter]);

  function toggle(id: string) {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function toggleGroup(items: ConnectionConfig[]) {
    setSelected(prev => {
      const next = new Set(prev);
      const allIn = items.every(c => next.has(c.id));
      for (const c of items) {
        if (allIn) next.delete(c.id); else next.add(c.id);
      }
      return next;
    });
  }

  // ── Execution ──────────────────────────────────────────────────────────────

  const run = useCallback(async (statement?: string) => {
    const text = (statement ?? sql).trim();
    if (!text || selected.size === 0 || running) return;

    const ids = [...selected];

    // Safety: read-only servers are excluded from writes; prod requires confirmation
    if (isWriteStatement(text)) {
      const targets = conns.filter(c => selected.has(c.id));
      const readOnlyNames = targets.filter(c => c.read_only).map(c => c.name);
      if (readOnlyNames.length > 0) {
        await alertDialog(`Blocked: write statement, but these servers are read-only:\n${readOnlyNames.join(', ')}\n\nDeselect them or clear their read-only flag.`);
        return;
      }
      const prodNames = targets.filter(c => c.environment === 'prod').map(c => c.name);
      if (prodNames.length > 0 && !await confirmDialog(
        `⚠ PRODUCTION\n\nThis write statement will run on ${prodNames.length} PROD server${prodNames.length === 1 ? '' : 's'}:\n${prodNames.join(', ')}\n\nContinue?`,
        { danger: true },
      )) return;
    }
    const initial = new Map<string, ServerRun>();
    for (const id of ids) {
      const c = conns.find(c => c.id === id);
      initial.set(id, { id, name: c?.name ?? id, status: 'pending' });
    }
    setRuns(initial);
    setDoneInfo(null);
    setRunning(true);
    setTab('results');
    setExpanded(new Set());

    const chan = new Channel<ExecEvent>();
    chan.onmessage = (ev) => {
      if (!mountedRef.current) return; // panel closed mid-run — ignore
      if (ev.type === 'started') {
        setRuns(prev => {
          const next = new Map(prev);
          const s = next.get(ev.connection_id);
          if (s) next.set(ev.connection_id, { ...s, status: 'running' });
          return next;
        });
      } else if (ev.type === 'finished') {
        setRuns(prev => {
          const next = new Map(prev);
          next.set(ev.connection_id, {
            id: ev.connection_id,
            name: ev.name,
            status: ev.ok ? 'ok' : 'error',
            ms: ev.execution_ms,
            rowsReturned: ev.result?.rows.length ?? 0,
            truncated: ev.truncated,
            error: ev.error ?? undefined,
            result: ev.result,
          });
          return next;
        });
      } else if (ev.type === 'done') {
        setDoneInfo({ ok: ev.ok_count, err: ev.err_count, ms: ev.total_ms });
        setRunning(false);
      }
    };

    try {
      // One row for the run, not one per server: the decision was "run this
      // everywhere", and that is the thing an auditor is looking for. The
      // per-server outcomes are kept by the backend in `multi_runs`.
      // `sessionId` is empty on purpose — a fleet run belongs to no single
      // session, so it lands in the 📜 Audit log and in no session's 📓 Log.
      await audited({
        sessionId: '',
        connectionName: `${ids.length} server${ids.length === 1 ? '' : 's'}`,
        engine: 'multi', tab: '⚟ Multi-exec', source: 'fleet',
        statement: `-- across ${ids.length} server${ids.length === 1 ? '' : 's'}: `
          + `${ids.map(id => conns.find(c => c.id === id)?.name ?? id).join(', ')}\n${text}`,
        run: () => invoke('multi_execute', { connectionIds: ids, sql: text, onEvent: chan }),
      });
    } catch (e) {
      if (!mountedRef.current) return;
      setDoneInfo(null);
      setRunning(false);
      await alertDialog(`Run failed: ${errorDisplay(e)}`);
    }
  }, [selected, running, conns, sql]);

  // ── Derived views ──────────────────────────────────────────────────────────

  const serverList = useMemo(() => [...runs.values()], [runs]);
  const failures = useMemo(() => serverList.filter(s => s.status === 'error'), [serverList]);

  const merged = useMemo(() => {
    const ok = serverList.filter(s => s.status === 'ok' && s.result && s.result.columns.length > 0);
    if (ok.length === 0) return null;
    // Majority column signature wins; mismatching servers are listed as excluded
    const sig = (r: QueryResult) => r.columns.map(c => c.name).join(' ');
    const counts = new Map<string, number>();
    for (const s of ok) counts.set(sig(s.result!), (counts.get(sig(s.result!)) ?? 0) + 1);
    const bestSig = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
    const included = ok.filter(s => sig(s.result!) === bestSig);
    const excluded = ok.filter(s => sig(s.result!) !== bestSig).map(s => s.name);
    const base = included[0].result!;
    const columns = [{ name: 'server', type_name: 'TEXT', nullable: false }, ...base.columns];
    const rows: unknown[][] = [];
    for (const s of included) {
      for (const row of s.result!.rows) rows.push([s.name, ...row]);
    }
    return { columns, rows, excluded };
  }, [serverList]);

  function toggleExpand(id: string) {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  async function copyErrors() {
    const text = failures.map(f => `${f.name}: ${f.error}`).join('\n');
    try { await navigator.clipboard.writeText(text); } catch { /* unavailable */ }
  }

  async function openLogRun(r: RunSummary) {
    try {
      const details = await invoke<RunDetail[]>('get_multi_run', { runId: r.id });
      setLogDetail({ run: r, details });
    } catch { /* ignore */ }
  }

  const statusIcon: Record<Status, string> = {
    pending: '○', running: '◌', ok: '●', error: '✕',
  };

  return (
    <div className="mx-root">
      {/* ── Server picker ── */}
      <aside className="mx-servers">
        <div className="mx-servers-head">
          <span>Servers</span>
          <span className="mx-count">{selected.size} selected</span>
        </div>
        <input
          className="mx-filter"
          placeholder="Filter servers…"
          value={connFilter}
          onChange={e => setConnFilter(e.target.value)}
        />
        <div className="mx-server-list">
          {groups.map(([group, items]) => (
            <div key={group || '(no group)'}>
              <div className="mx-group" onClick={() => toggleGroup(items)}>
                <input
                  type="checkbox"
                  readOnly
                  checked={items.every(c => selected.has(c.id))}
                />
                <span>{group || 'Ungrouped'}</span>
                <span className="mx-group-n">{items.length}</span>
              </div>
              {items.map(c => (
                <label key={c.id} className="mx-server">
                  <input
                    type="checkbox"
                    checked={selected.has(c.id)}
                    onChange={() => toggle(c.id)}
                  />
                  <span className="mx-engine">{ENGINE_ICON[c.engine]}</span>
                  <span className="mx-name">{c.name}</span>
                  {c.read_only && <span title="Read-only">🔒</span>}
                  {c.environment && (
                    <span className={`env-chip env-${c.environment}`}>{c.environment.toUpperCase()}</span>
                  )}
                </label>
              ))}
            </div>
          ))}
          {conns.length === 0 && <div className="mx-empty">No saved connections.</div>}
        </div>
      </aside>

      {/* ── Editor + results ── */}
      <div className="mx-main">
        <div className="mx-editor-bar">
          <span className="mx-title">Multi-server execution</span>
          <span className="mx-hint">runs on {selected.size} server{selected.size === 1 ? '' : 's'} · {SC.run}</span>
          <div style={{ flex: 1 }} />
          {doneInfo && (
            <span className="mx-done">
              <span className="mx-ok">{doneInfo.ok} ok</span>
              {doneInfo.err > 0 && <span className="mx-err"> · {doneInfo.err} failed</span>}
              {' · '}{(doneInfo.ms / 1000).toFixed(1)}s
            </span>
          )}
          <button
            className="primary run-btn"
            disabled={running || !sql.trim() || selected.size === 0}
            onClick={() => run()}
          >{running ? 'Running…' : '▶ Run on all'}</button>
          {onClose && (
            <button
              className="icon-btn"
              title="Close"
              onClick={async () => {
                if (running && !await confirmDialog('A run is still in progress (it will finish in the background, results discarded). Close anyway?')) return;
                onClose();
              }}
            >×</button>
          )}
        </div>

        <div className="mx-editor">
          <Suspense fallback={null}>
            <SqlEditor
              engine="mysql"
              schemaCompletions={[]}
              onRun={s => run(s)}
              onChange={setSql}
              placeholder="SELECT @@hostname, @@version;   — runs on every selected server"
            />
          </Suspense>
        </div>

        {/* Result tabs */}
        <div className="rtab-bar">
          {(['results', 'merged', 'errors', 'log'] as ResultTab[]).map(t => (
            <button
              key={t}
              className={`rtab ${tab === t ? 'active' : ''}`}
              onClick={() => setTab(t)}
            >
              {t === 'results' && `Results${serverList.length ? ` (${serverList.length})` : ''}`}
              {t === 'merged' && 'Merged'}
              {t === 'errors' && `Errors${failures.length ? ` (${failures.length})` : ''}`}
              {t === 'log' && 'Log'}
            </button>
          ))}
          <div style={{ flex: 1 }} />
          <GridSettingsPopover />
        </div>

        <div className="mx-results">
          {/* Per-server results */}
          {tab === 'results' && (
            <div className="mx-result-list">
              {serverList.length === 0 && (
                <div className="mx-empty">Select servers, write a statement, hit Run.</div>
              )}
              {serverList.map(s => (
                <div key={s.id} className="mx-server-result">
                  <div
                    className={`mx-sr-head mx-st-${s.status}`}
                    onClick={() => s.result && toggleExpand(s.id)}
                  >
                    <span className={`mx-status mx-st-${s.status}`}>{statusIcon[s.status]}</span>
                    <span className="mx-sr-name">{s.name}</span>
                    {s.status === 'ok' && (
                      <span className="mx-sr-meta">
                        {s.result?.rows_affected != null
                          ? `${s.result.rows_affected} affected`
                          : `${(s.rowsReturned ?? 0).toLocaleString()} rows`}
                        {s.truncated && ' (truncated)'}
                        {' · '}{s.ms}ms
                      </span>
                    )}
                    {s.status === 'error' && <span className="mx-sr-err">{s.error}</span>}
                    {s.status === 'running' && <span className="mx-sr-meta">running…</span>}
                    {s.result && s.result.columns.length > 0 && (
                      <span className="mx-expand">{expanded.has(s.id) ? '▾' : '▸'}</span>
                    )}
                  </div>
                  {expanded.has(s.id) && s.result && s.result.columns.length > 0 && (
                    <div className="mx-sr-grid">
                      <FastGrid columns={s.result.columns} rows={s.result.rows} />
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Merged grid */}
          {tab === 'merged' && (
            merged ? (
              <div className="mx-merged">
                <div className="mx-merged-bar">
                  <span className="result-count">{merged.rows.length.toLocaleString()} rows from {serverList.filter(s => s.status === 'ok').length - merged.excluded.length} servers</span>
                  <CopyExportMenu
                    getData={() => ({ columns: merged.columns.map(c => c.name), rows: merged.rows })}
                    tableName="fleet_result"
                  />
                  {merged.excluded.length > 0 && (
                    <span className="mx-excluded">excluded (different columns): {merged.excluded.join(', ')}</span>
                  )}
                </div>
                <FastGrid columns={merged.columns} rows={merged.rows} />
              </div>
            ) : <div className="mx-empty">No mergeable results yet.</div>
          )}

          {/* Error log */}
          {tab === 'errors' && (
            <div className="mx-errors">
              {failures.length === 0 && <div className="mx-empty">No errors. 🎉</div>}
              {failures.length > 0 && (
                <>
                  <div className="mx-merged-bar">
                    <span className="result-count">{failures.length} failed</span>
                    <button className="toolbar-btn" onClick={copyErrors}>Copy all</button>
                  </div>
                  {failures.map(f => (
                    <div key={f.id} className="mx-error-row">
                      <span className="mx-sr-name">{f.name}</span>
                      <pre className="mx-error-text">{f.error}</pre>
                    </div>
                  ))}
                </>
              )}
            </div>
          )}

          {/* Persistent run log */}
          {tab === 'log' && (
            <div className="mx-log">
              {logDetail ? (
                <div>
                  <div className="mx-merged-bar">
                    <button className="toolbar-btn" onClick={() => setLogDetail(null)}>← Back</button>
                    <span className="result-count">
                      Run #{logDetail.run.id} · {logDetail.run.created_at} · {logDetail.run.ok_count}/{logDetail.run.total} ok
                    </span>
                  </div>
                  <pre className="mx-log-sql">{logDetail.run.sql}</pre>
                  <table className="mx-log-table">
                    <thead>
                      <tr><th>Server</th><th>Status</th><th>Rows</th><th>ms</th><th>Error</th></tr>
                    </thead>
                    <tbody>
                      {logDetail.details.map((d, i) => (
                        <tr key={i} className={d.ok ? '' : 'mx-log-err'}>
                          <td>{d.connection_name}</td>
                          <td>{d.ok ? 'ok' : 'FAILED'}</td>
                          <td>{d.rows_affected ?? d.rows_returned}</td>
                          <td>{d.execution_ms}</td>
                          <td className="mx-log-errtext">{d.error ?? ''}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <table className="mx-log-table">
                  <thead>
                    <tr><th>#</th><th>When</th><th>SQL</th><th>Servers</th><th>OK</th><th>Failed</th><th>Total ms</th></tr>
                  </thead>
                  <tbody>
                    {log.map(r => (
                      <tr key={r.id} onClick={() => openLogRun(r)} className="mx-log-row">
                        <td>{r.id}</td>
                        <td>{r.created_at}</td>
                        <td className="mx-log-sqlcell">{r.sql.slice(0, 80)}{r.sql.length > 80 ? '…' : ''}</td>
                        <td>{r.total}</td>
                        <td>{r.ok_count}</td>
                        <td className={r.err_count > 0 ? 'mx-log-errtext' : ''}>{r.err_count}</td>
                        <td>{r.total_ms}</td>
                      </tr>
                    ))}
                    {log.length === 0 && (
                      <tr><td colSpan={7} className="mx-empty">No runs yet.</td></tr>
                    )}
                  </tbody>
                </table>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
