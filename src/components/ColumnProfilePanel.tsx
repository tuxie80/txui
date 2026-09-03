/**
 * Column profiling — what is actually in each column of a table.
 *
 * The first thing anyone does with an unfamiliar table, and until now the
 * answer was "write the SQL yourself". Deliberately *not* the same question as
 * the Analyze panel, which reports the optimiser's statistics: that is what the
 * planner believes, this is what the data says.
 *
 * The SQL lives in `utils/columnProfile.ts` and is pure; this is the screen.
 * One query profiles every column, so a wide table costs one scan rather than
 * one per column, and a large table is sampled with the sample stated on
 * screen — numbers from a sample presented as a census would be a lie told
 * confidently.
 */
import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { QueryResult, Session } from '../types';
import { errorDisplay } from '../utils/appError';
import { sqlLiteral } from '../utils/sqlIdent';
import {
  describeColumn, profileSql, rowEstimateSql, selectivity,
  suggestSample, topValuesSql, type ProfileColumn,
} from '../utils/columnProfile';

interface Props {
  session: Session;
  schema: string | null;
  onClose: () => void;
}

interface Row {
  column: string;
  type: string;
  scanned: number;
  nonNull: number;
  nulls: number;
  distinct: number;
  min: string | null;
  max: string | null;
  avg: string | null;
  minLen: string | null;
  maxLen: string | null;
}

const num = (v: unknown): number => {
  const n = typeof v === 'number' ? v : Number(String(v ?? '').trim());
  return Number.isFinite(n) ? n : 0;
};
const text = (v: unknown): string | null =>
  v === null || v === undefined || v === '' ? null : String(v);

export function ColumnProfilePanel({ session, schema, onClose }: Props) {
  const engine: 'postgres' | 'mysql' | 'sqlserver' =
    session.engine === 'postgres' ? 'postgres'
      : session.engine === 'sqlserver' ? 'sqlserver' : 'mysql';
  const [schemas, setSchemas] = useState<string[]>([]);
  const [db, setDb] = useState(schema ?? '');
  const [tables, setTables] = useState<string[]>([]);
  const [table, setTable] = useState('');
  const [rows, setRows] = useState<Row[] | null>(null);
  const [sample, setSample] = useState<number | null>(null);
  const [estimate, setEstimate] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [top, setTop] = useState<{ column: string; values: Array<[string, number]> } | null>(null);

  const run = useCallback(
    (sql: string) => invoke<QueryResult>('monitor_query', { sessionId: session.sessionId, sql }),
    [session.sessionId]);

  useEffect(() => {
    // sys.schemas on SQL Server: information_schema.schemata there lists a
    // schema for every fixed database role too, which is a dozen empty ones.
    const sql = engine === 'sqlserver'
      ? "SELECT name FROM sys.schemas WHERE schema_id < 16384 AND name NOT IN ('sys','INFORMATION_SCHEMA','guest') ORDER BY name"
      : engine === 'mysql'
      ? "SELECT schema_name FROM information_schema.schemata WHERE schema_name NOT IN ('information_schema','performance_schema','mysql','sys') ORDER BY schema_name"
      : "SELECT schema_name FROM information_schema.schemata WHERE schema_name NOT IN ('pg_catalog','information_schema') ORDER BY schema_name";
    run(sql)
      .then(r => {
        const l = r.rows.map(x => String(x[0]));
        setSchemas(l);
        setDb(d => d || l[0] || '');
      })
      .catch(e => setError(errorDisplay(e)));
  }, [run, engine]);

  useEffect(() => {
    if (!db) return;
    setTable('');
    setRows(null);
    run(`SELECT table_name FROM information_schema.tables WHERE table_schema = ${sqlLiteral(db, engine)} AND table_type = 'BASE TABLE' ORDER BY table_name`)
      .then(r => setTables(r.rows.map(x => String(x[0]))))
      .catch(e => setError(errorDisplay(e)));
  }, [db, run, engine]);

  const profile = useCallback(async (useSample: number | null) => {
    if (!db || !table) return;
    setBusy(true);
    setError(null);
    setTop(null);
    try {
      const colsR = await run(
        `SELECT column_name, ${engine === 'mysql' ? 'column_type' : 'data_type'} FROM information_schema.columns`
        + ` WHERE table_schema = ${sqlLiteral(db, engine)} AND table_name = ${sqlLiteral(table, engine)}`
        + ` ORDER BY ordinal_position`);
      const cols: ProfileColumn[] = colsR.rows.map(r => ({
        name: String(r[0]), dataType: String(r[1]),
      }));
      if (!cols.length) { setRows([]); return; }

      const r = await run(profileSql(engine, db, table, cols, useSample));
      setRows(r.rows.map(x => ({
        column: String(x[0]), type: String(x[1]),
        scanned: num(x[2]), nonNull: num(x[3]), nulls: num(x[4]), distinct: num(x[5]),
        min: text(x[6]), max: text(x[7]), avg: text(x[8]),
        minLen: text(x[9]), maxLen: text(x[10]),
      })));
      setSample(useSample);
    } catch (e) {
      setError(errorDisplay(e));
      setRows(null);
    } finally {
      setBusy(false);
    }
  }, [db, table, run, engine]);

  /** Row estimate first, so a huge table is sampled rather than scanned blind. */
  const start = useCallback(async () => {
    if (!db || !table) return;
    let est: number | null = null;
    try {
      const r = await run(rowEstimateSql(engine, db, table));
      est = r.rows.length ? num(r.rows[0][0]) : null;
    } catch { /* an estimate is an optimisation, not a requirement */ }
    setEstimate(est);
    await profile(suggestSample(est));
  }, [db, table, run, engine, profile]);

  const showTop = useCallback(async (column: string) => {
    try {
      const r = await run(topValuesSql(engine, db, table, column, 12, sample));
      setTop({ column, values: r.rows.map(x => [x[0] === null ? '∅ NULL' : String(x[0]), num(x[1])]) });
    } catch (e) {
      setError(errorDisplay(e));
    }
  }, [run, engine, db, table, sample]);

  const pct = (n: number, of: number) => (of > 0 ? `${Math.round((n / of) * 100)}%` : '—');

  return (
    <div className="proc-panel">
      <div className="proc-toolbar">
        <span className="proc-title">📊 Column profile</span>
        <label className="dg-field-inline">
          <span>Schema</span>
          <select value={db} onChange={e => setDb(e.target.value)} disabled={busy}>
            {schemas.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>
        <label className="dg-field-inline">
          <span>Table</span>
          <select value={table} onChange={e => { setTable(e.target.value); setRows(null); }} disabled={busy || !tables.length}>
            <option value="">Choose…</option>
            {tables.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
        </label>
        <button className="toolbar-btn" onClick={() => void start()} disabled={busy || !table}>
          {busy ? 'Reading…' : 'Profile'}
        </button>
        {rows && sample !== null && (
          <button className="toolbar-btn" onClick={() => void profile(null)} disabled={busy}
            title="Read every row instead of a sample — may take a while on a large table">
            Read all rows
          </button>
        )}
        <span className="dv-desc" style={{ marginLeft: 8 }}>
          {rows && (sample !== null
            ? `sampled ${sample.toLocaleString()} rows${estimate ? ` of ~${estimate.toLocaleString()}` : ''}`
            : rows.length ? `full scan · ${rows[0].scanned.toLocaleString()} rows` : '')}
        </span>
        <div style={{ flex: 1 }} />
        <button className="icon-btn" onClick={onClose} title="Close">×</button>
      </div>

      {error && <div className="proc-error-bar">{error}</div>}

      {/* Say it plainly when the numbers are from a sample. A profile that
          silently sampled is a set of wrong numbers stated confidently. */}
      {rows && sample !== null && (
        <div className="er-hint-bar">
          <span>
            These figures come from the first <strong>{sample.toLocaleString()}</strong> rows, not the
            whole table. Distinct counts in particular will be low.
          </span>
        </div>
      )}

      {rows && rows.length > 0 && (
        <div className="fif-results">
          <table className="cp-table">
            <thead>
              <tr>
                <th>Column</th><th>Type</th><th>Reading</th>
                <th className="cp-n">Nulls</th><th className="cp-n">Distinct</th>
                <th className="cp-n">Selectivity</th>
                <th>Min</th><th>Max</th><th className="cp-n">Avg</th>
                <th className="cp-n">Len</th><th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => {
                const sel = selectivity(r.distinct, r.scanned);
                return (
                  <tr key={r.column}>
                    <td className="cp-col">{r.column}</td>
                    <td className="cp-type">{r.type}</td>
                    <td className="cp-read">{describeColumn({
                      rowsScanned: r.scanned, nulls: r.nulls, distinctVals: r.distinct,
                    })}</td>
                    <td className="cp-n">{r.nulls.toLocaleString()}<span className="cp-sub">{pct(r.nulls, r.scanned)}</span></td>
                    <td className="cp-n">{r.distinct.toLocaleString()}</td>
                    <td className="cp-n">{sel === null ? '—' : sel.toFixed(3)}</td>
                    <td className="cp-v">{r.min ?? '—'}</td>
                    <td className="cp-v">{r.max ?? '—'}</td>
                    <td className="cp-n">{r.avg ?? '—'}</td>
                    <td className="cp-n">{r.minLen !== null ? `${r.minLen}–${r.maxLen}` : '—'}</td>
                    <td>
                      <button className="toolbar-btn" onClick={() => void showTop(r.column)}
                        title="Most common values in this column">top</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {rows && rows.length === 0 && !busy && (
        <div className="db-error">That table has no columns to profile.</div>
      )}

      {top && (
        <div className="modal-overlay" onClick={() => setTop(null)}>
          <div className="modal" style={{ maxWidth: 460 }} onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <span className="modal-title">Most common — {top.column}</span>
              <button className="modal-close" onClick={() => setTop(null)}>×</button>
            </div>
            <div className="recover-body">
              {top.values.map(([v, n], i) => (
                <div key={i} className="recover-row">
                  <span className="cp-v" style={{ flex: 1 }}>{v}</span>
                  <span className="cp-n">{n.toLocaleString()}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
