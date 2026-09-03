/**
 * Find usages — where is this table or column actually referenced?
 *
 * The question before a `DROP COLUMN` or a rename. An editor search answers
 * the part you can see; this answers the part you cannot — view definitions,
 * routine and trigger bodies, generated-column expressions, constraints and
 * indexes, all of which live in the server and break silently.
 *
 * Everything it runs is a catalog read, so it is safe to open against
 * production — which is the only place the question is ever urgent.
 *
 * The matching and the SQL are pure (`utils/findUsages.ts`,
 * `utils/usageSources.ts`); this is the screen.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { QueryResult, Session } from '../types';
import { errorDisplay } from '../utils/appError';
import { sqlLiteral } from '../utils/sqlIdent';
import {
  findUsages, summarise,
  type Confidence, type SourceKind, type UsageSource, type UsageReport,
} from '../utils/findUsages';
import { corpusSql } from '../utils/usageSources';

interface Props {
  session: Session;
  schema: string | null;
  /** Open buffers, so a script you have not saved is searched too. */
  buffers?: Array<{ id: string; label: string; sql: string }>;
  onClose: () => void;
}

const KIND_LABEL: Record<SourceKind, string> = {
  view: 'view', matview: 'materialized view', routine: 'routine',
  trigger: 'trigger', event: 'event', constraint: 'constraint',
  index: 'index', default: 'default / generated',
  computed: 'computed column',
  buffer: 'open script', saved: 'saved SQL',
};

/** Ordered, so the filter is "this confidence or better". */
const RANK: Record<Confidence, number> = { certain: 3, likely: 2, possible: 1 };

const CONF_LABEL: Record<Confidence, string> = {
  certain: 'certain', likely: 'likely', possible: 'possible',
};

export function FindUsagesPanel({ session, schema, buffers = [], onClose }: Props) {
  const engine: 'postgres' | 'mysql' | 'sqlserver' =
    session.engine === 'postgres' ? 'postgres'
      : session.engine === 'sqlserver' ? 'sqlserver' : 'mysql';
  const [schemas, setSchemas] = useState<string[]>([]);
  const [db, setDb] = useState(schema ?? '');
  const [tables, setTables] = useState<string[]>([]);
  const [table, setTable] = useState('');
  const [columns, setColumns] = useState<string[]>([]);
  const [column, setColumn] = useState('');
  const [sources, setSources] = useState<UsageSource[] | null>(null);
  const [report, setReport] = useState<UsageReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [minConfidence, setMinConfidence] = useState<Confidence>('possible');

  const run = useCallback(
    (sql: string) => invoke<QueryResult>('monitor_query', { sessionId: session.sessionId, sql }),
    [session.sessionId]);

  useEffect(() => {
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
    setTable(''); setColumn(''); setReport(null); setSources(null);
    run(`SELECT table_name FROM information_schema.tables WHERE table_schema = ${sqlLiteral(db, engine)} ORDER BY table_name`)
      .then(r => setTables(r.rows.map(x => String(x[0]))))
      .catch(e => setError(errorDisplay(e)));
  }, [db, run, engine]);

  useEffect(() => {
    if (!db || !table) { setColumns([]); return; }
    setColumn('');
    run(`SELECT column_name FROM information_schema.columns WHERE table_schema = ${sqlLiteral(db, engine)}`
      + ` AND table_name = ${sqlLiteral(table, engine)} ORDER BY ordinal_position`)
      .then(r => setColumns(r.rows.map(x => String(x[0]))))
      .catch(e => setError(errorDisplay(e)));
  }, [db, table, run, engine]);

  const search = useCallback(async () => {
    if (!db || !table) return;
    setBusy(true);
    setError(null);
    try {
      const r = await run(corpusSql(db, engine));
      const fromServer: UsageSource[] = r.rows.map((row, i) => ({
        id: `db-${i}`,
        kind: String(row[0]) as SourceKind,
        schema: row[1] === null ? undefined : String(row[1]),
        label: String(row[2] ?? ''),
        sql: row[3] === null ? '' : String(row[3]),
        ownerTable: row[4] === null || row[4] === undefined ? undefined : String(row[4]),
      }));
      // Open buffers last: they are the part you can already see, and the
      // server's own definitions are the reason to run this.
      const all = [...fromServer, ...buffers.map(b => ({
        id: `buf-${b.id}`, kind: 'buffer' as SourceKind, label: b.label, sql: b.sql,
      }))];
      setSources(all);
      setReport(findUsages(all, { table, column: column || undefined }, engine));
    } catch (e) {
      setError(errorDisplay(e));
      setReport(null);
    } finally {
      setBusy(false);
    }
  }, [db, table, column, run, engine, buffers]);

  const byId = useMemo(
    () => new Map((sources ?? []).map(s => [s.id, s])), [sources]);

  const shown = useMemo(
    () => (report?.usages ?? []).filter(u => RANK[u.confidence] >= RANK[minConfidence]),
    [report, minConfidence]);

  const what = column ? `${table}.${column}` : table;

  return (
    <div className="proc-panel">
      <div className="proc-toolbar">
        <span className="proc-title">🔗 Find usages</span>
        <select value={db} onChange={e => setDb(e.target.value)}>
          {schemas.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        <select value={table} onChange={e => setTable(e.target.value)}>
          <option value="">— table —</option>
          {tables.map(t => <option key={t} value={t}>{t}</option>)}
        </select>
        <select value={column} onChange={e => setColumn(e.target.value)} disabled={!table}>
          <option value="">whole table</option>
          {columns.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
        <button className="toolbar-btn" onClick={() => void search()} disabled={!table || busy}>
          {busy ? 'Searching…' : 'Find'}
        </button>
        <div style={{ flex: 1 }} />
        {report && (
          <>
            <span className="dv-desc">show</span>
            <select value={minConfidence} onChange={e => setMinConfidence(e.target.value as Confidence)}>
              <option value="possible">everything</option>
              <option value="likely">likely and certain</option>
              <option value="certain">certain only</option>
            </select>
          </>
        )}
        <button className="icon-btn" onClick={onClose} title="Close">×</button>
      </div>

      {error && <div className="proc-error-bar">{error}</div>}

      {!report && !error && (
        <div className="db-error">
          Pick a table — and a column, if you are asking about one — then press Find.
          <br /><br />
          This reads the definitions the server holds: views, routines, triggers,
          {engine === 'mysql' ? ' events,' : ' indexes,'} constraints, and generated-column
          and default expressions. Everything it runs is a catalog read, so it is safe
          against production.
        </div>
      )}

      {report && (
        <>
          <div className="fu-summary">{summarise(report, what)}</div>

          {shown.length === 0 && report.usages.length > 0 && (
            <div className="db-error">
              Nothing at this confidence. {report.usages.length} weaker match
              {report.usages.length === 1 ? '' : 'es'} {report.usages.length === 1 ? 'is' : 'are'} hidden.
            </div>
          )}

          <div className="fif-results">
            {shown.map((u, i) => {
              const s = byId.get(u.sourceId);
              return (
                <div key={i} className={`fu-row fu-${u.confidence}`}>
                  <div className="fu-head">
                    <span className={`fu-badge fu-badge-${u.confidence}`}>
                      {CONF_LABEL[u.confidence]}
                    </span>
                    <span className="fu-kind">{s ? KIND_LABEL[s.kind] : ''}</span>
                    <span className="fu-label">{s?.label}</span>
                    <span className="dv-desc">line {u.line}</span>
                  </div>
                  <pre className="fu-line">{u.lineText || '(empty)'}</pre>
                  {u.note && <div className="fu-note">{u.note}</div>}
                </div>
              );
            })}
          </div>

          {/* The denominator, again, at the bottom. Someone who scrolled a list
              of hits to the end is about to conclude something from it. */}
          <div className="fu-footer">
            Searched {report.searched} definition{report.searched === 1 ? '' : 's'} in
            {' '}<b>{db}</b>{buffers.length ? ` and ${buffers.length} open script(s)` : ''}.
            Nothing here has seen your application code, another schema, or a
            {' '}database on another server.
          </div>
        </>
      )}
    </div>
  );
}
