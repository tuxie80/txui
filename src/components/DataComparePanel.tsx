/**
 * Data compare — the contents of one table against another, on this connection
 * or a different one.
 *
 * Schema compare answers "do these two schemas match". This answers "do these
 * two tables hold the same rows", and it is the more dangerous of the pair
 * because the output is `INSERT`, `UPDATE` and `DELETE` against a live table.
 *
 * Everything about the screen is arranged so the direction is unmistakable:
 * the source is read, the **target** is written, they are labelled that way
 * throughout, and the generated script is shown before anything can run.
 * Deletes are off by default, prod requires a typed word, and the run goes
 * through the same server-side guards as any other write.
 *
 * The comparison itself is in `utils/dataCompare.ts` and is pure.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { QueryResult, Session } from '../types';
import { errorDisplay } from '../utils/appError';
import { sqlLiteral } from '../utils/sqlIdent';
import {
  compareRows, fetchSql, MAX_COMPARE_ROWS, reconcileSql, summariseReconcile,
  type CompareResult, type Engine,
} from '../utils/dataCompare';

interface Props {
  session: Session;
  /** Every open session, so a comparison can cross servers. */
  openSessions: Session[];
  schema: string | null;
  onClose: () => void;
}

interface Side { sessionId: string; label: string; schema: string; table: string }

export function DataComparePanel({ session, openSessions, schema, onClose }: Props) {
  const engine: Engine = session.engine === 'postgres' ? 'postgres'
    : session.engine === 'sqlserver' ? 'sqlserver' : 'mysql';
  const [sessions, setSessions] = useState<Array<{ sessionId: string; label: string }>>([]);
  const [source, setSource] = useState<Side>(
    { sessionId: session.sessionId, label: session.connectionName, schema: schema ?? '', table: '' });
  const [target, setTarget] = useState<Side>(
    { sessionId: session.sessionId, label: session.connectionName, schema: schema ?? '', table: '' });
  const [tables, setTables] = useState<string[]>([]);
  const [columns, setColumns] = useState<string[]>([]);
  const [keyColumns, setKeyColumns] = useState<string[]>([]);
  const [diff, setDiff] = useState<CompareResult | null>(null);
  const [doInsert, setDoInsert] = useState(true);
  const [doUpdate, setDoUpdate] = useState(true);
  const [doDelete, setDoDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const [applying, setApplying] = useState(false);

  const runOn = useCallback(
    (sessionId: string, sql: string) => invoke<QueryResult>('monitor_query', { sessionId, sql }),
    []);

  /**
   * Every open session of a comparable engine.
   *
   * Cross-server is the case that matters — "staging and prod disagree about
   * this lookup table" is rarely two schemas on one host. Sessions of a
   * *different* engine are excluded rather than offered and then failing at
   * compare time: the generated SQL is quoted for one dialect, and the
   * information_schema queries differ.
   */
  useEffect(() => {
    const same = openSessions.filter(s =>
      (s.engine === 'postgres' ? 'postgres'
        : s.engine === 'sqlserver' ? 'sqlserver' : 'mysql') === engine
      && (s.engine === 'postgres' || s.engine === 'mysql' || s.engine === 'sqlserver'));
    const list = same.length ? same : [session];
    setSessions(list.map(s => ({
      sessionId: s.sessionId,
      // Two connections to the same server are common; the name alone would
      // make the picker ambiguous at exactly the moment it matters.
      label: s.environment === 'prod' ? `${s.connectionName} ⚠ prod` : s.connectionName,
    })));
  }, [openSessions, session, engine]);

  // Tables come from the source; the target is expected to have the same one.
  useEffect(() => {
    if (!source.schema) return;
    runOn(source.sessionId,
      // information_schema.tables works on all three; SQL Server needs the
      // BASE TABLE filter as much as the others (its view lists views too).
      `SELECT table_name FROM information_schema.tables WHERE table_schema = ${sqlLiteral(source.schema, engine)}`
      + ` AND table_type = 'BASE TABLE' ORDER BY table_name`)
      .then(r => setTables(r.rows.map(x => String(x[0]))))
      .catch(e => setError(errorDisplay(e)));
  }, [source.schema, source.sessionId, runOn, engine]);

  useEffect(() => {
    if (!source.schema || !source.table) { setColumns([]); setKeyColumns([]); return; }
    Promise.all([
      runOn(source.sessionId,
        `SELECT column_name FROM information_schema.columns WHERE table_schema = ${sqlLiteral(source.schema, engine)}`
        + ` AND table_name = ${sqlLiteral(source.table, engine)} ORDER BY ordinal_position`),
      runOn(source.sessionId,
        `SELECT kcu.column_name FROM information_schema.table_constraints tc`
        + ` JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name`
        + ` AND tc.table_schema = kcu.table_schema WHERE tc.constraint_type = 'PRIMARY KEY'`
        + ` AND tc.table_schema = ${sqlLiteral(source.schema, engine)}`
        + ` AND tc.table_name = ${sqlLiteral(source.table, engine)} ORDER BY kcu.ordinal_position`),
    ]).then(([c, k]) => {
      setColumns(c.rows.map(x => String(x[0])));
      // The primary key is the right default and usually the only sane choice.
      setKeyColumns(k.rows.map(x => String(x[0])));
      setDiff(null);
    }).catch(e => setError(errorDisplay(e)));
  }, [source.schema, source.table, source.sessionId, runOn, engine]);

  const compare = useCallback(async () => {
    if (!columns.length || !keyColumns.length) return;
    setBusy(true);
    setError(null);
    setTruncated(false);
    try {
      const sql = (s: Side) =>
        fetchSql(s.schema, s.table, columns, keyColumns, MAX_COMPARE_ROWS, engine);
      const [a, b] = await Promise.all([
        runOn(source.sessionId, sql(source)),
        runOn(target.sessionId, sql(target)),
      ]);
      // The fetch reads one past the cap so this is distinguishable from
      // "exactly at the cap" — a truncated comparison would generate deletes
      // for every row past the limit, which is the worst possible outcome.
      const over = a.rows.length > MAX_COMPARE_ROWS || b.rows.length > MAX_COMPARE_ROWS;
      setTruncated(over);
      if (over) {
        setDiff(null);
        setError(`One side has more than ${MAX_COMPARE_ROWS.toLocaleString()} rows. `
          + 'Comparing a truncated read would propose deleting everything past the limit, '
          + 'so the comparison is refused rather than shown.');
        return;
      }
      setDiff(compareRows({
        columns, keyColumns,
        sourceRows: a.rows as unknown[][],
        targetRows: b.rows as unknown[][],
      }));
    } catch (e) {
      setError(errorDisplay(e));
      setDiff(null);
    } finally {
      setBusy(false);
    }
  }, [columns, keyColumns, source, target, runOn, engine]);

  const reconcileOpts = useMemo(() => ({
    schema: target.schema, table: target.table, columns, keyColumns, engine,
    insert: doInsert, update: doUpdate, delete: doDelete,
  }), [target, columns, keyColumns, engine, doInsert, doUpdate, doDelete]);

  const script = useMemo(
    () => (diff ? reconcileSql(diff, reconcileOpts) : []), [diff, reconcileOpts]);
  const summary = useMemo(
    () => (diff ? summariseReconcile(diff, reconcileOpts) : null), [diff, reconcileOpts]);

  /**
   * Is the *target* production?
   *
   * Looked up from the target's own session, not the panel's. Getting this
   * from the panel's session was wrong the moment cross-server compare
   * existed: writing from a dev connection into prod would have asked for the
   * weaker confirmation word.
   */
  const targetSession = openSessions.find(s => s.sessionId === target.sessionId) ?? session;
  const targetIsProd = targetSession.environment === 'prod';
  const required = targetIsProd ? 'PRODUCTION' : 'APPLY';
  const armed = !!summary && summary.total > 0 && !summary.blockers.length
    && confirmText === required;

  const apply = useCallback(async () => {
    setApplying(true);
    setError(null);
    try {
      for (const stmt of script) {
        await invoke('monitor_query', { sessionId: target.sessionId, sql: stmt });
      }
      await compare();          // re-read, so the screen shows the new truth
      setConfirmText('');
    } catch (e) {
      setError(errorDisplay(e));
    } finally {
      setApplying(false);
    }
  }, [script, target.sessionId, compare]);

  const sideEditor = (s: Side, set: (v: Side) => void, role: 'source' | 'target') => (
    <div className={`dc-side dc-${role}`}>
      <div className="dc-role">
        {role === 'source' ? 'Source — read only' : 'Target — will be written'}
        {role === 'target' && targetIsProd && <span className="dc-prod"> · PRODUCTION</span>}
      </div>
      <label className="dg-field-inline">
        <span>Connection</span>
        <select value={s.sessionId} onChange={e => set({ ...s, sessionId: e.target.value })}>
          {sessions.map(x => <option key={x.sessionId} value={x.sessionId}>{x.label}</option>)}
        </select>
      </label>
      <label className="dg-field-inline">
        <span>Schema</span>
        <input value={s.schema} onChange={e => set({ ...s, schema: e.target.value })} />
      </label>
      <label className="dg-field-inline">
        <span>Table</span>
        {role === 'source' ? (
          <select value={s.table} onChange={e => set({ ...s, table: e.target.value })}>
            <option value="">Choose…</option>
            {tables.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
        ) : (
          <input value={s.table} onChange={e => set({ ...s, table: e.target.value })}
            placeholder={source.table || 'table'} />
        )}
      </label>
    </div>
  );

  return (
    <div className="proc-panel">
      <div className="proc-toolbar">
        <span className="proc-title">⇄ Data compare</span>
        <button className="toolbar-btn" disabled={busy || !source.table || !target.table || !keyColumns.length}
          onClick={() => void compare()}>
          {busy ? 'Reading both sides…' : 'Compare'}
        </button>
        <span className="dv-desc" style={{ marginLeft: 8 }}>
          {diff && `${diff.same} same · ${diff.different.length} differ · `
            + `${diff.onlyInSource.length} only in source · ${diff.onlyInTarget.length} only in target`}
        </span>
        <div style={{ flex: 1 }} />
        <button className="icon-btn" onClick={onClose} title="Close">×</button>
      </div>

      {error && <div className="proc-error-bar">{error}</div>}
      {truncated && <div className="td-prod-bar">Comparison refused — see above.</div>}

      <div className="dc-sides">
        {sideEditor(source, setSource, 'source')}
        <div className="dc-arrow" title="Only the target is ever written">→</div>
        {sideEditor(target, setTarget, 'target')}
      </div>

      {columns.length > 0 && (
        <div className="dc-keys">
          <span className="dc-keys-label">Match rows by</span>
          {columns.map(c => (
            <label key={c} className="form-check">
              <input type="checkbox" checked={keyColumns.includes(c)}
                onChange={e => setKeyColumns(k => e.target.checked ? [...k, c] : k.filter(x => x !== c))} />
              {c}
            </label>
          ))}
          {!keyColumns.length && <span className="dc-warn">Pick at least one — without a key there is no way to say which row is which.</span>}
        </div>
      )}

      {diff && summary && (
        <div className="dc-result">
          <div className="dc-actions">
            <label className="form-check">
              <input type="checkbox" checked={doInsert} onChange={e => setDoInsert(e.target.checked)} />
              Insert {diff.onlyInSource.length} missing
            </label>
            <label className="form-check">
              <input type="checkbox" checked={doUpdate} onChange={e => setDoUpdate(e.target.checked)} />
              Update {diff.different.length} differing
            </label>
            {/* Off by default and visually separated: a row missing from the
                source is usually an incomplete extract, not a row that should
                cease to exist. */}
            <label className="form-check dc-danger-check">
              <input type="checkbox" checked={doDelete} onChange={e => setDoDelete(e.target.checked)} />
              Delete {diff.onlyInTarget.length} extra rows from the target
            </label>
          </div>

          {summary.blockers.map((b, i) => (
            <div key={i} className="td-headline td-risk-destructive">{b}</div>
          ))}

          {summary.headline && !summary.blockers.length && (
            <div className={`td-headline ${doDelete ? 'td-risk-destructive' : 'td-risk-lossy'}`}>
              {summary.headline}
              {doDelete && ' — including deletes, which cannot be undone.'}
            </div>
          )}

          <div className="dc-script">
            {script.slice(0, 300).map((s, i) => <code key={i} className="td-sql">{s}</code>)}
            {script.length > 300 && (
              <div className="dv-desc" style={{ padding: 8 }}>
                …and {script.length - 300} more. Copy to the editor to see all of them.
              </div>
            )}
          </div>

          {summary.total > 0 && (
            <div className="td-apply">
              <label className="td-confirm">
                <span>Type <code>{required}</code> to enable — this writes to {target.schema}.{target.table}</span>
                <input value={confirmText} onChange={e => setConfirmText(e.target.value)} placeholder={required} />
              </label>
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="toolbar-btn"
                  onClick={() => window.dispatchEvent(new CustomEvent('dbgui:insert-sql', {
                    detail: { sql: script.join('\n') },
                  }))}>
                  Copy to editor
                </button>
                <button className={`toolbar-btn${armed ? ' td-danger' : ''}`}
                  disabled={!armed || applying} onClick={() => void apply()}>
                  {applying ? 'Applying…' : `Apply ${summary.total} statement${summary.total === 1 ? '' : 's'}`}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
