/**
 * Sequence editor — create, alter, restart and drop sequences.
 *
 * The sibling of the routine editor, for the one schema object that had no
 * editor: procedures, functions, triggers and events all got one, while a
 * sequence stayed a thing you hand-write `ALTER SEQUENCE` for, having first
 * hand-written the `SELECT` that tells you what it is currently set to.
 *
 * Same two rules as the routine editor. **Show exactly what will run before it
 * runs** — the statements are on screen, not behind a Save button. And **do
 * not lose anything**: both engines support a full `ALTER`, so this never
 * drops and recreates, which is how a sequence's position gets silently reset.
 *
 * Moving the position is deliberately a separate control from editing the
 * definition. Everything else changes how the sequence behaves; a restart
 * changes what it hands out next, and handing out a value that already exists
 * fails in the application rather than here.
 *
 * SQL is in `utils/sequenceDdl.ts` and pure; this is the screen.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { QueryResult, Session } from '../types';
import { errorDisplay } from '../utils/appError';
import { copyToClipboard } from '../utils/exportersIo';
import { useServerFlavor } from '../store/serverFlavors';
import {
  listSql, readSql, createSql, alterSql, restartSql, dropSql, toScript, worstRisk,
  type SequenceDef, type SequenceChange, type Engine as SeqEngine,
} from '../utils/sequenceDdl';

interface Props {
  session: Session;
  schema: string | null;
  /** A sequence to jump straight into editing (from the schema tree). */
  target?: { schema: string; name: string } | null;
  /** Called once the target has been consumed, so it does not re-open on a
      later plain (toolbar) open of this panel. */
  onTargetConsumed?: () => void;
  onClose: () => void;
}

const BLANK = (schema: string): SequenceDef => ({
  schema, name: '', start: '1', increment: '1',
  minValue: '1', maxValue: '', cache: '1', cycle: false,
});

/** PostgreSQL can narrow the type; MariaDB sequences are always bigint. */
const PG_TYPES = ['bigint', 'integer', 'smallint'];

export function SequencePanel({ session, schema, target, onTargetConsumed, onClose }: Props) {
  const flavor = useServerFlavor(session.sessionId, session.engine);
  /**
   * PostgreSQL, MariaDB and SQL Server have sequences. MySQL proper has none —
   * AUTO_INCREMENT is a column property, not an object — so offering the panel
   * and then failing on the first query would be worse than saying so.
   */
  const engine: SeqEngine | null =
    session.engine === 'postgres' ? 'postgres'
      : session.engine === 'sqlserver' ? 'sqlserver'
      : session.engine === 'mysql' && flavor.flavor === 'mariadb' ? 'mariadb'
      : null;

  const [schemas, setSchemas] = useState<string[]>([]);
  const [db, setDb] = useState(schema ?? '');
  const [names, setNames] = useState<string[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [current, setCurrent] = useState<SequenceDef | null>(null);
  const [draft, setDraft] = useState<SequenceDef | null>(null);
  const [restartTo, setRestartTo] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  /** A sequence requested by the tree, held until `db` has caught up to its
      schema so `open` reads from the right one. */
  const [pendingTarget, setPendingTarget] = useState<{ schema: string; name: string } | null>(null);

  const run = useCallback(
    (sql: string) => invoke<QueryResult>('monitor_query', { sessionId: session.sessionId, sql }),
    [session.sessionId]);
  const exec = useCallback(
    (sql: string) => invoke<QueryResult>('execute_query', {
      sessionId: session.sessionId, sql, tabId: 0,
    }),
    [session.sessionId]);

  useEffect(() => {
    if (!engine) return;
    // SQL Server's information_schema.schemata lists every principal as a
    // schema owner, including the ~10 fixed database roles that own an
    // identically named empty schema. sys.schemas filtered by schema_id is the
    // list a user recognises.
    const sql = engine === 'postgres'
      ? "SELECT schema_name FROM information_schema.schemata WHERE schema_name NOT IN ('pg_catalog','information_schema') ORDER BY schema_name"
      : engine === 'sqlserver'
      ? "SELECT name FROM sys.schemas WHERE schema_id < 16384 AND name NOT IN ('sys','INFORMATION_SCHEMA','guest') ORDER BY name"
      : "SELECT schema_name FROM information_schema.schemata WHERE schema_name NOT IN ('information_schema','performance_schema','mysql','sys') ORDER BY schema_name";
    run(sql)
      .then(r => {
        const l = r.rows.map(x => String(x[0]));
        setSchemas(l);
        setDb(d => d || l[0] || '');
      })
      .catch(e => setError(errorDisplay(e)));
  }, [run, engine]);

  const refreshList = useCallback(async () => {
    if (!engine || !db) return;
    try {
      const r = await run(listSql(db, engine));
      setNames(r.rows.map(x => String(x[0])));
    } catch (e) { setError(errorDisplay(e)); }
  }, [run, db, engine]);

  useEffect(() => { void refreshList(); }, [refreshList]);

  /** Load one sequence. `null` starts a new one. */
  const open = useCallback(async (name: string | null) => {
    setSelected(name);
    setError(null);
    setNote(null);
    setRestartTo('');
    if (!engine) return;
    if (name === null) {
      const blank = BLANK(db);
      setCurrent(null);
      setDraft(blank);
      return;
    }
    try {
      const r = await run(readSql(db, name, engine));
      const row = r.rows[0] ?? [];
      const def: SequenceDef = {
        schema: db, name,
        start: String(row[0] ?? ''), increment: String(row[1] ?? ''),
        minValue: String(row[2] ?? ''), maxValue: String(row[3] ?? ''),
        cache: String(row[4] ?? ''),
        // PostgreSQL returns a boolean, MariaDB a 0/1.
        cycle: ['t', 'true', '1'].includes(String(row[5]).toLowerCase()),
        lastValue: row[6] === null || row[6] === undefined ? null : String(row[6]),
        dataType: row[7] ? String(row[7]) : undefined,
      };
      setCurrent(def);
      setDraft({ ...def });
    } catch (e) {
      setError(errorDisplay(e));
      setCurrent(null); setDraft(null);
    }
  }, [db, run, engine]);

  // When the schema tree asks to edit a specific sequence, switch to its
  // schema first, then open it once `db` (which `open` closes over) has caught
  // up — otherwise `readSql` would query the previously selected schema.
  useEffect(() => {
    if (!engine || !target) return;
    setDb(target.schema);
    setPendingTarget(target);
    onTargetConsumed?.();
  }, [target, engine, onTargetConsumed]);
  useEffect(() => {
    if (pendingTarget && db === pendingTarget.schema) {
      void open(pendingTarget.name);
      setPendingTarget(null);
    }
  }, [pendingTarget, db, open]);

  const changes: SequenceChange[] = useMemo(() => {
    if (!engine || !draft) return [];
    if (!current) {
      return draft.name.trim()
        ? [{ kind: 'create' as const, subject: draft.name, risk: 'safe' as const,
             sql: createSql(draft, engine) }]
        : [];
    }
    return alterSql(current, draft, engine);
  }, [current, draft, engine]);

  const apply = useCallback(async (list: SequenceChange[]) => {
    if (!list.length) return;
    setBusy(true); setError(null); setNote(null);
    try {
      for (const c of list) await exec(c.sql);
      setNote(`${list.length} statement${list.length === 1 ? '' : 's'} applied.`);
      await refreshList();
      // Re-read: the server is the authority on what it stored, and it does
      // not always store what it was given — MariaDB keeps the top bigint
      // value for itself, so a maximum comes back one lower than it went in.
      if (draft) await open(draft.name);
    } catch (e) {
      setError(errorDisplay(e));
    } finally { setBusy(false); }
  }, [exec, refreshList, open, draft]);

  const patch = (over: Partial<SequenceDef>) => setDraft(d => (d ? { ...d, ...over } : d));

  if (!engine) {
    return (
      <div className="proc-panel">
        <div className="proc-toolbar">
          <span className="proc-title">🔢 Sequences</span>
          <div style={{ flex: 1 }} />
          <button className="icon-btn" onClick={onClose} title="Close">×</button>
        </div>
        <div className="db-error">
          Sequences exist on PostgreSQL and on MariaDB 10.3+. MySQL has no sequence
          object — an <code>AUTO_INCREMENT</code> column is its nearest equivalent, and it
          belongs to one table rather than standing on its own.
        </div>
      </div>
    );
  }

  const risk = worstRisk(changes);
  const script = toScript(changes);

  return (
    <div className="proc-panel">
      <div className="proc-toolbar">
        <span className="proc-title">🔢 Sequences</span>
        <select value={db} onChange={e => { setDb(e.target.value); setDraft(null); setCurrent(null); setSelected(null); }}>
          {schemas.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        <select value={selected ?? ''} onChange={e => void open(e.target.value || null)}>
          <option value="">— sequence —</option>
          {names.map(n => <option key={n} value={n}>{n}</option>)}
        </select>
        <button className="toolbar-btn" onClick={() => void open(null)}>New</button>
        <div style={{ flex: 1 }} />
        <span className="dv-desc">{names.length} in {db}</span>
        <button className="icon-btn" onClick={onClose} title="Close">×</button>
      </div>

      {error && <div className="proc-error-bar">{error}</div>}
      {note && <div className="seq-note">{note}</div>}

      {!draft && (
        <div className="db-error">
          Pick a sequence to edit, or press New. Nothing here drops and recreates —
          both engines can alter every property in place, and a recreate would reset
          the position.
        </div>
      )}

      {draft && (
        <div className="seq-body">
          <div className="seq-form">
            <label>Name
              <input value={draft.name} disabled={!!current}
                onChange={e => patch({ name: e.target.value })} />
            </label>
            {engine === 'postgres' && (
              <label>Type
                <select value={draft.dataType ?? 'bigint'}
                  onChange={e => patch({ dataType: e.target.value })}>
                  {PG_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                </select>
              </label>
            )}
            {/* Text, not number: these are bigints, and an <input type=number>
                hands back a float that has already lost the top of the range. */}
            <label>Start with
              <input value={draft.start} inputMode="numeric"
                onChange={e => patch({ start: e.target.value })} />
            </label>
            <label>Increment by
              <input value={draft.increment} inputMode="numeric"
                onChange={e => patch({ increment: e.target.value })} />
            </label>
            <label>Minimum
              <input value={draft.minValue} inputMode="numeric"
                onChange={e => patch({ minValue: e.target.value })} />
            </label>
            <label>Maximum
              <input value={draft.maxValue} inputMode="numeric"
                onChange={e => patch({ maxValue: e.target.value })} />
            </label>
            <label>Cache
              <input value={draft.cache} inputMode="numeric"
                onChange={e => patch({ cache: e.target.value })} />
            </label>
            <label className="seq-check">
              <input type="checkbox" checked={draft.cycle}
                onChange={e => patch({ cycle: e.target.checked })} />
              Cycle — restart at the minimum instead of failing
            </label>
          </div>

          {current && (
            <div className="seq-position">
              <div>
                <span className="dv-desc">Currently at</span>{' '}
                <b>{current.lastValue ?? 'not yet used'}</b>
                {current.ownedBy && (
                  <span className="dv-desc"> · owned by {current.ownedBy}</span>
                )}
              </div>
              <div className="seq-restart">
                <input
                  className="fif-input" placeholder="restart at…" inputMode="numeric"
                  value={restartTo} onChange={e => setRestartTo(e.target.value)}
                />
                <button
                  className="toolbar-btn td-danger"
                  disabled={busy || !restartTo.trim()}
                  onClick={() => void apply([restartSql(current, restartTo, engine)])}
                >Restart</button>
              </div>
              <div className="seq-warn">
                {restartSql(current, restartTo || '1', engine).warning}
              </div>
            </div>
          )}

          <div className="seq-script">
            <div className="seq-script-head">
              <span>{changes.length === 0 ? 'No changes' : `${changes.length} statement${changes.length === 1 ? '' : 's'}`}</span>
              {changes.length > 0 && (
                <>
                  <span className={`seq-risk seq-risk-${risk}`}>{risk}</span>
                  <button className="toolbar-btn" onClick={() => {
                    void copyToClipboard(script); setCopied(true);
                    setTimeout(() => setCopied(false), 1200);
                  }}>{copied ? 'Copied' : 'Copy'}</button>
                  <button className={`toolbar-btn${risk === 'safe' ? '' : ' td-danger'}`}
                    disabled={busy} onClick={() => void apply(changes)}>
                    {busy ? 'Running…' : current ? 'Apply' : 'Create'}
                  </button>
                </>
              )}
              <div style={{ flex: 1 }} />
              {current && (
                <button className="toolbar-btn td-danger" disabled={busy}
                  onClick={() => void apply([{
                    kind: 'drop', subject: current.name, risk: 'destructive',
                    sql: dropSql(current, engine),
                  }]).then(() => { setDraft(null); setCurrent(null); setSelected(null); })}
                >Drop</button>
              )}
            </div>
            {changes.length > 0 && <pre className="seq-sql">{script}</pre>}
            {changes.filter(c => c.warning).map((c, i) => (
              <div key={i} className="seq-warn">{c.warning}</div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
