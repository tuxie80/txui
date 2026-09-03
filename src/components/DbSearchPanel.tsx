/**
 * 🔎 Find in database — search every table in a schema for a value.
 *
 * The incident question: *where does this order id appear?* Until now the only
 * way to answer it was a query per table, written by hand.
 *
 * Two things make this trustworthy rather than merely fast:
 *
 *   - **It says what it did not search.** Binary columns cannot be LIKE-d and
 *     numbers are opt-in; a search that skipped them silently would let you
 *     conclude a value is absent when it is not. The skipped count is on
 *     screen, with the reasons a click away.
 *   - **It streams.** Tables are searched smallest-first and hits appear as
 *     they arrive, so a hundred-table schema shows its first answer in a
 *     moment rather than after the largest table finishes. Cancel stops it.
 *
 * Planning is in utils/dbSearch; this runs the plan and shows it.
 */
import { errorDisplay } from '../utils/appError';
import { sqlLiteral } from '../utils/sqlIdent';
import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { QueryResult, Session } from '../types';
import { StatusIcon } from './StatusIcon';
import { planSearch, planSummary, DEFAULT_LIMIT } from '../utils/dbSearch';
import type { SearchMode, SearchPlan, SearchTable } from '../utils/dbSearch';
import { fmtDuration } from '../utils/fmtDuration';

interface Props {
  session: Session;
  /** Current default schema — what gets searched. */
  schema: string | null;
  onClose: () => void;
}

interface Hit {
  table: string;
  column: string;
  /** The whole matching row, for context. */
  row: Record<string, unknown>;
  columns: string[];
}

const MODES: Array<{ id: SearchMode; label: string }> = [
  { id: 'contains', label: 'contains' },
  { id: 'exact', label: 'exact' },
  { id: 'starts', label: 'starts with' },
];

export function DbSearchPanel({ session, schema, onClose }: Props) {
  const [needle, setNeedle] = useState('');
  const [mode, setMode] = useState<SearchMode>('contains');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [includeNonText, setIncludeNonText] = useState(false);
  const [limit, setLimit] = useState(DEFAULT_LIMIT);

  const [tables, setTables] = useState<SearchTable[] | null>(null);
  const [loadingMeta, setLoadingMeta] = useState(false);
  const [plan, setPlan] = useState<SearchPlan | null>(null);
  const [hits, setHits] = useState<Hit[]>([]);
  const [done, setDone] = useState(0);
  const [running, setRunning] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [elapsed, setElapsed] = useState(0);
  const [showSkipped, setShowSkipped] = useState(false);
  const cancelled = useRef(false);

  // ── catalog ────────────────────────────────────────────────────────────────

  const loadTables = useCallback(async () => {
    if (!schema) return;
    setLoadingMeta(true);
    setErrors([]);
    try {
      const sql = session.engine === 'sqlserver'
        // sys.* rather than information_schema: the row estimate comes from a
        // DMV (free and exact for a base table), and the type carries its
        // length, which is what decides whether a column is worth searching.
        ? `SELECT o.name AS table_name, c.name AS column_name,
             t.name AS data_type,
             ISNULL((SELECT SUM(p.row_count) FROM sys.dm_db_partition_stats p
                     WHERE p.object_id = o.object_id AND p.index_id IN (0,1)), 0) AS rows
           FROM sys.columns c
           JOIN sys.objects o ON o.object_id = c.object_id AND o.type = 'U'
           JOIN sys.schemas s ON s.schema_id = o.schema_id
           JOIN sys.types t ON t.user_type_id = c.user_type_id
           WHERE s.name = ${sqlLiteral(schema, 'sqlserver')}
           ORDER BY o.name, c.column_id`
        : session.engine === 'postgres'
        ? `SELECT c.table_name, c.column_name, c.data_type,
             COALESCE(s.n_live_tup, 0) AS rows
           FROM information_schema.columns c
           JOIN information_schema.tables t
             ON t.table_schema = c.table_schema AND t.table_name = c.table_name
            AND t.table_type = 'BASE TABLE'
           LEFT JOIN pg_stat_user_tables s
             ON s.schemaname = c.table_schema AND s.relname = c.table_name
           WHERE c.table_schema = ${sqlLiteral(schema, 'postgres')}
           ORDER BY c.table_name, c.ordinal_position`
        : `SELECT c.TABLE_NAME, c.COLUMN_NAME, c.COLUMN_TYPE,
             COALESCE(t.TABLE_ROWS, 0) AS rows
           FROM information_schema.COLUMNS c
           JOIN information_schema.TABLES t
             ON t.TABLE_SCHEMA = c.TABLE_SCHEMA AND t.TABLE_NAME = c.TABLE_NAME
            AND t.TABLE_TYPE = 'BASE TABLE'
           WHERE c.TABLE_SCHEMA = ${sqlLiteral(schema, 'mysql')}
           ORDER BY c.TABLE_NAME, c.ORDINAL_POSITION`;
      const res = await invoke<QueryResult>('monitor_query', {
        sessionId: session.sessionId, sql,
      });
      const byTable = new Map<string, SearchTable>();
      for (const r of res.rows) {
        const [tname, cname, ctype, rows] = r as [string, string, string, number];
        let t = byTable.get(tname);
        if (!t) {
          t = { schema, name: tname, columns: [], estimatedRows: Number(rows) || 0 };
          byTable.set(tname, t);
        }
        t.columns.push({ name: cname, typeName: ctype });
      }
      setTables([...byTable.values()]);
    } catch (e) {
      setErrors([errorDisplay(e)]);
      setTables([]);
    } finally {
      setLoadingMeta(false);
    }
  }, [schema, session.sessionId, session.engine]);

  useEffect(() => { void loadTables(); }, [loadTables]);

  // Keep the plan in step with the options, so the summary is always honest
  // about what pressing Search will actually do.
  useEffect(() => {
    if (!tables || !needle.trim()) { setPlan(null); return; }
    setPlan(planSearch(tables, {
      engine: session.engine, needle, mode, caseSensitive, includeNonText, limit,
    }));
  }, [tables, needle, mode, caseSensitive, includeNonText, limit, session.engine]);

  // ── running ────────────────────────────────────────────────────────────────

  const run = useCallback(async () => {
    if (!plan || plan.tables.length === 0) return;
    cancelled.current = false;
    setRunning(true);
    setHits([]);
    setDone(0);
    setErrors([]);
    const t0 = performance.now();

    for (const t of plan.tables) {
      if (cancelled.current) break;
      try {
        const res = await invoke<QueryResult>('monitor_query', {
          sessionId: session.sessionId, sql: t.sql,
        });
        const names = res.columns.map(c => c.name);
        const found: Hit[] = res.rows.map(r => {
          const row: Record<string, unknown> = {};
          names.forEach((n, i) => { row[n] = r[i]; });
          return {
            table: String(row.__table ?? t.name),
            column: String(row.__column ?? ''),
            row,
            columns: names.filter(n => n !== '__table' && n !== '__column'),
          };
        });
        // Appended per table rather than at the end: the first hits should be
        // readable while the rest is still running.
        if (found.length) setHits(prev => [...prev, ...found]);
      } catch (e) {
        // One unreadable table must not abandon the other ninety-nine.
        setErrors(prev => [...prev, `${t.name}: ${errorDisplay(e)}`]);
      } finally {
        setDone(n => n + 1);
        setElapsed(Math.round(performance.now() - t0));
      }
    }
    setRunning(false);
  }, [plan, session.sessionId]);

  const stop = () => { cancelled.current = true; };

  const total = plan?.tables.length ?? 0;
  const pct = total ? Math.round((done / total) * 100) : 0;
  const skippedCount = plan?.tables.reduce((n, t) => n + t.skipped.length, 0) ?? 0;

  return (
    <div className="dbs">
      <div className="panel-header">
        <span className="panel-title">🔎 Find in database</span>
        {schema && <span className="dbs-schema">{schema}</span>}
        <div style={{ flex: 1 }} />
        <button className="toolbar-btn" onClick={loadTables} disabled={loadingMeta || running}>
          Reload tables
        </button>
        <button className="icon-btn" onClick={onClose} title="Close">×</button>
      </div>

      {!schema && (
        <div className="dbs-note">Select a database first — there is nothing to search yet.</div>
      )}

      <div className="dbs-controls">
        <input
          className="dbs-needle"
          placeholder="Value to find…"
          value={needle}
          spellCheck={false}
          onChange={e => setNeedle(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !running) void run(); }}
        />
        <select value={mode} onChange={e => setMode(e.target.value as SearchMode)}>
          {MODES.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
        </select>
        <label className="dbs-check">
          <input type="checkbox" checked={caseSensitive}
                 onChange={e => setCaseSensitive(e.target.checked)} />
          <span>Case sensitive</span>
        </label>
        <label className="dbs-check">
          <input type="checkbox" checked={includeNonText}
                 onChange={e => setIncludeNonText(e.target.checked)} />
          <span>Numbers &amp; dates</span>
        </label>
        <label className="dbs-check">
          <span>Rows/table</span>
          <select value={limit} onChange={e => setLimit(Number(e.target.value))}>
            {[20, 100, 500].map(n => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
        <div style={{ flex: 1 }} />
        {running
          ? <button className="toolbar-btn dbs-stop" onClick={stop}>Stop</button>
          : <button className="primary" onClick={run}
                    disabled={!plan || plan.tables.length === 0}>Search</button>}
      </div>

      {plan && (
        <div className="dbs-plan">
          <span>{planSummary(plan)}</span>
          {skippedCount > 0 && (
            <button className="dbs-link" onClick={() => setShowSkipped(v => !v)}>
              {showSkipped ? 'hide' : 'show'} {skippedCount} skipped column
              {skippedCount === 1 ? '' : 's'}
            </button>
          )}
          {loadingMeta && <span className="dbs-muted">reading catalog…</span>}
        </div>
      )}

      {showSkipped && plan && (
        <div className="dbs-skipped">
          {plan.tables.filter(t => t.skipped.length).map(t => (
            <div key={t.name} className="dbs-skip-row">
              <b>{t.name}</b>
              {t.skipped.map(s => (
                <span key={s.name} className="dbs-skip-col" title={s.reason}>
                  {s.name} <em>{s.reason}</em>
                </span>
              ))}
            </div>
          ))}
          {plan.emptyTables.map(t => (
            <div key={t.name} className="dbs-skip-row">
              <b>{t.name}</b><span className="dbs-skip-col"><em>{t.reason}</em></span>
            </div>
          ))}
        </div>
      )}

      {(running || done > 0) && (
        <div className="dbs-progress">
          <div className="dbs-bar"><span style={{ width: `${pct}%` }} /></div>
          <span className="dbs-muted">
            {done} / {total} tables · {hits.length} hit{hits.length === 1 ? '' : 's'}
            {elapsed > 0 && ` · ${fmtDuration(elapsed)}`}
          </span>
        </div>
      )}

      {errors.length > 0 && (
        <div className="dbs-errors">
          {errors.slice(0, 5).map((e, i) => (
            <div key={i}><StatusIcon kind="error" /> {e}</div>
          ))}
          {errors.length > 5 && <div className="dbs-muted">…and {errors.length - 5} more</div>}
        </div>
      )}

      <div className="dbs-results">
        {!running && done > 0 && hits.length === 0 && (
          <div className="dbs-empty">
            <StatusIcon kind="ok" /> Searched {done} table{done === 1 ? '' : 's'} — no match.
            {skippedCount > 0 && (
              <> {skippedCount} column{skippedCount === 1 ? '' : 's'} could not be searched;
              check the list above before concluding the value is absent.</>
            )}
          </div>
        )}
        {hits.map((h, i) => (
          <div key={i} className="dbs-hit">
            <div className="dbs-hit-head">
              <span className="dbs-hit-table">{h.table}</span>
              <span className="dbs-hit-col">{h.column}</span>
              <button
                className="dbs-link"
                onClick={() => window.dispatchEvent(new CustomEvent('dbgui:browse-table',
                  { detail: { table: h.table } }))}
              >open table</button>
            </div>
            <div className="dbs-hit-row">
              {h.columns.map(c => (
                <span key={c} className={`dbs-cell${c === h.column ? ' match' : ''}`}>
                  <em>{c}</em>{fmtCell(h.row[c])}
                </span>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Short, honest cell text — NULL is not an empty string. */
function fmtCell(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return s.length > 120 ? s.slice(0, 119) + '…' : s;
}
