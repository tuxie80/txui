/**
 * View editor — create, replace, refresh and drop views and materialized
 * views.
 *
 * The sibling of the routine, sequence and type editors, for the last relation
 * kind that had only a read-only DDL box: a view was a thing you inspected
 * under "View DDL" and then hand-wrote `CREATE OR REPLACE VIEW` for. This is
 * the editor that closes that gap.
 *
 * Same two rules as its siblings. **Show exactly what will run before it
 * runs** — the statements are on screen, never behind a silent Save — and the
 * generated SQL is **review-only**: it is inserted / copied / applied through
 * the same reviewed path, and every identifier the editor inserts is quoted
 * through `utils/sqlIdent`.
 *
 * An existing view's definition is read back through the very command the
 * schema tree's "View DDL" uses — the backend `get_ddl` — and its `SELECT`
 * parsed out of the returned DDL, so nothing new is asked of the backend.
 *
 * Materialized views cover PostgreSQL and ClickHouse — different objects built
 * by the same drop-and-recreate path; the CH form picks a `TO` target table or
 * an inline `ENGINE`. SQL is in `utils/viewDdl.ts` and pure; this is the
 * screen.
 */
import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { QueryResult, Session } from '../types';
import { errorDisplay } from '../utils/appError';
import { copyToClipboard } from '../utils/exportersIo';
import {
  schemaListSql, listSql, parseBody, parseClickhouseMatview, dropSql, refreshSql, changesFor,
  toScript, worstRisk,
  type ViewDef, type ViewKind, type ViewChange, type Engine as ViewEngine,
} from '../utils/viewDdl';

const SqlEditor = lazy(() => import('./SqlEditor').then(m => ({ default: m.SqlEditor })));

interface Props {
  session: Session;
  schema: string | null;
  /** A view to jump straight into editing (from the schema tree). */
  target?: { schema: string; name: string; kind: string } | null;
  /** Called once the target has been consumed, so it does not re-open on a
      later plain (toolbar) open of this panel. */
  onTargetConsumed?: () => void;
  onClose: () => void;
}

/** Normalise a tree-supplied kind string onto a ViewKind. */
function asKind(kind: string | undefined): ViewKind {
  return kind === 'matview' || kind === 'mat_view' ? 'matview' : 'view';
}

const BLANK = (kind: ViewKind, schema: string, engine: ViewEngine): ViewDef => ({
  schema, name: '', kind, body: 'SELECT ', withData: true,
  // A fresh ClickHouse matview starts on the self-contained engine form so its
  // DDL is valid before the target table is named.
  ...(kind === 'matview' && engine === 'clickhouse'
    ? {
      chTarget: 'engine' as const, chEngine: 'MergeTree()',
      chOrderBy: '', chPartitionBy: '', chTo: '', populate: false,
    }
    : {}),
});

export function ViewPanel({ session, schema, target, onTargetConsumed, onClose }: Props) {
  const engine: ViewEngine | null =
    session.engine === 'postgres' ? 'postgres'
      : session.engine === 'mysql' ? 'mysql'
        : session.engine === 'clickhouse' ? 'clickhouse'
          : session.engine === 'sqlite' ? 'sqlite'
            : session.engine === 'sqlserver' ? 'sqlserver'
            : null;
  /** PostgreSQL and ClickHouse both have editable materialized views here —
      different objects, built by the same drop-and-recreate path. */
  const canMatview = engine === 'postgres' || engine === 'clickhouse';
  /** Only PostgreSQL's matview is refreshed in place; ClickHouse's is not. */
  const canRefresh = engine === 'postgres';

  const [schemas, setSchemas] = useState<string[]>([]);
  const [db, setDb] = useState(schema ?? '');
  const [items, setItems] = useState<{ name: string; kind: ViewKind }[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [current, setCurrent] = useState<ViewDef | null>(null);
  const [draft, setDraft] = useState<ViewDef | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [concurrently, setConcurrently] = useState(false);
  // SqlEditor takes an INITIAL value, so replacing the body wholesale (loading
  // a different view) needs a remount — but not on every keystroke in the name
  // field, which would throw away the caret.
  const [editorKey, setEditorKey] = useState(0);
  /** A view requested by the tree, held until `db` has caught up to its schema
      so `open` reads from the right one. */
  const [pendingTarget, setPendingTarget] =
    useState<{ schema: string; name: string; kind: string } | null>(null);

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
    run(schemaListSql(engine))
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
      setItems(r.rows.map(x => ({ name: String(x[0]), kind: asKind(String(x[1])) })));
    } catch (e) { setError(errorDisplay(e)); }
  }, [run, db, engine]);

  useEffect(() => { void refreshList(); }, [refreshList]);

  /** Load one view. `null` starts a new one of `kind`. */
  const open = useCallback(async (name: string | null, wantKind?: string) => {
    setSelected(name);
    setError(null);
    setNote(null);
    setConcurrently(false);
    if (!engine) return;
    if (name === null) {
      const blank = BLANK(canMatview ? asKind(wantKind) : 'view', db, engine);
      setCurrent(null);
      setDraft(blank);
      setEditorKey(k => k + 1);
      return;
    }
    const kind = asKind(wantKind) === 'matview'
      ? 'matview'
      : items.find(i => i.name === name)?.kind ?? 'view';
    try {
      // The same command the schema tree's "View DDL" uses — no new backend.
      const ddl = await invoke<string>('get_ddl', {
        sessionId: session.sessionId, parent: `${db}.${name}`,
      });
      // A ClickHouse matview's storage clauses (TO / ENGINE / ORDER BY …) are
      // best-effort parsed back so re-applying preserves them.
      const chParts = kind === 'matview' && engine === 'clickhouse'
        ? parseClickhouseMatview(ddl) : {};
      const def: ViewDef = {
        schema: db, name, kind, body: parseBody(ddl), withData: true, ...chParts,
      };
      setCurrent(def);
      setDraft(structuredClone(def));
      setEditorKey(k => k + 1);
    } catch (e) {
      setError(errorDisplay(e));
      setCurrent(null); setDraft(null);
    }
  }, [db, engine, items, canMatview, session.sessionId]);

  // When the schema tree asks to edit a specific view, switch to its schema
  // first, then open it once `db` (which `open` closes over) has caught up —
  // otherwise `get_ddl` would query the previously selected schema.
  useEffect(() => {
    if (!engine || !target) return;
    setDb(target.schema);
    setPendingTarget(target);
    onTargetConsumed?.();
  }, [target, engine, onTargetConsumed]);
  useEffect(() => {
    if (pendingTarget && db === pendingTarget.schema) {
      void open(pendingTarget.name, pendingTarget.kind);
      setPendingTarget(null);
    }
  }, [pendingTarget, db, open]);

  const changes: ViewChange[] = useMemo(() => {
    if (!engine || !draft) return [];
    return changesFor(current, draft, engine);
  }, [current, draft, engine]);

  const apply = useCallback(async (list: ViewChange[]) => {
    if (!list.length) return;
    setBusy(true); setError(null); setNote(null);
    try {
      for (const c of list) await exec(c.sql);
      setNote(`${list.length} statement${list.length === 1 ? '' : 's'} applied.`);
      await refreshList();
      if (draft) await open(draft.name);
    } catch (e) {
      setError(errorDisplay(e));
    } finally { setBusy(false); }
  }, [exec, refreshList, open, draft]);

  const patch = (over: Partial<ViewDef>) => setDraft(d => (d ? { ...d, ...over } : d));

  if (!engine) {
    return (
      <div className="proc-panel">
        <div className="proc-toolbar">
          <span className="proc-title">👁 Views</span>
          <div style={{ flex: 1 }} />
          <button className="icon-btn" onClick={onClose} title="Close">×</button>
        </div>
        <div className="db-error">
          {session.engine === 'duckdb'
            ? <>The view editor has no DuckDB dialect yet — its catalog addressing is
                two-level and DuckDB is three (<code>db.schema.view</code>).{' '}
                <code>CREATE OR REPLACE VIEW</code> works from the SQL editor.</>
            : <>Views are a SQL object. This connection has none to edit — Redis is not SQL,
                and a Parquet file is read-only.</>}
        </div>
      </div>
    );
  }

  const risk = worstRisk(changes);
  const script = toScript(changes);

  return (
    <div className="proc-panel">
      <div className="proc-toolbar">
        <span className="proc-title">👁 Views</span>
        <select value={db} onChange={e => { setDb(e.target.value); setDraft(null); setCurrent(null); setSelected(null); }}>
          {schemas.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        <select value={selected ?? ''} onChange={e => void open(e.target.value || null)}>
          <option value="">— view —</option>
          {items.map(i => (
            <option key={i.name} value={i.name}>{i.name}{i.kind === 'matview' ? ' (mat)' : ''}</option>
          ))}
        </select>
        <span className="rt-new">
          <button className="toolbar-btn" onClick={() => void open(null, 'view')} title="New view">+ View</button>
          {canMatview && (
            <button className="toolbar-btn" onClick={() => void open(null, 'matview')}
              title="New materialized view">+ Matview</button>
          )}
        </span>
        <div style={{ flex: 1 }} />
        <span className="dv-desc">{items.length} in {db}</span>
        <button className="icon-btn" onClick={onClose} title="Close">×</button>
      </div>

      {error && <div className="proc-error-bar">{error}</div>}
      {note && <div className="seq-note">{note}</div>}

      {!draft && (
        <div className="db-error">
          Pick a view to edit, or start a new one above. The SQL is shown before anything
          runs — nothing here executes on its own.
        </div>
      )}

      {draft && (
        <div className="seq-body">
          <div className="seq-form">
            <label>Name
              <input value={draft.name} disabled={!!current} spellCheck={false}
                onChange={e => patch({ name: e.target.value })} />
            </label>
            <label>Kind
              <input value={draft.kind === 'matview' ? 'Materialized view' : 'View'} disabled />
            </label>
            {draft.kind === 'matview' && engine === 'postgres' && !current && (
              <label className="seq-check">
                <input type="checkbox" checked={draft.withData !== false}
                  onChange={e => patch({ withData: e.target.checked })} />
                Populate now (WITH DATA) — otherwise it is created empty
              </label>
            )}
          </div>

          {draft.kind === 'matview' && engine === 'clickhouse' && (
            <ChMatviewForm def={draft} onChange={patch} />
          )}

          <div className="rt-body-editor">
            <Suspense fallback={<div className="rt-hint">Loading editor…</div>}>
              <SqlEditor
                key={editorKey}
                engine={session.engine}
                initialValue={draft.body}
                schemaCompletions={[]}
                onRun={() => { /* the view body is saved, not run piecemeal */ }}
                onChange={body => setDraft(d => (d ? { ...d, body } : d))}
              />
            </Suspense>
          </div>

          {current && current.kind === 'matview' && canRefresh && (
            <div className="seq-position">
              <div className="seq-restart">
                <label className="seq-check">
                  <input type="checkbox" checked={concurrently}
                    onChange={e => setConcurrently(e.target.checked)} />
                  CONCURRENTLY
                </label>
                <button className="toolbar-btn" disabled={busy}
                  onClick={() => void apply([refreshSql(current, concurrently)])}>Refresh</button>
              </div>
              <div className="seq-warn">{refreshSql(current, concurrently).warning}</div>
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
                  <button className="toolbar-btn" onClick={() =>
                    window.dispatchEvent(new CustomEvent('dbgui:insert-sql', { detail: { sql: `\n${script}\n` } }))
                  }>Insert into editor</button>
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

// ── ClickHouse materialized-view storage sub-form ─────────────────────────────

/**
 * The storage half of a ClickHouse matview: it writes either to a separate
 * `TO` target table, or to its own inline `ENGINE`. The two are mutually
 * exclusive — a radio picks the form, and each shows only its own fields.
 */
function ChMatviewForm(
  { def, onChange }: { def: ViewDef; onChange: (o: Partial<ViewDef>) => void },
) {
  const toForm = def.chTarget === 'to';
  return (
    <div className="seq-form">
      <label className="seq-check">
        <input type="radio" name="ch-mv-target" checked={toForm}
          onChange={() => onChange({ chTarget: 'to' })} />
        To an existing target table
      </label>
      <label className="seq-check">
        <input type="radio" name="ch-mv-target" checked={!toForm}
          onChange={() => onChange({ chTarget: 'engine' })} />
        Own storage (inline ENGINE)
      </label>

      {toForm ? (
        <label>Target table
          <input value={def.chTo ?? ''} placeholder="db.target or target" spellCheck={false}
            onChange={e => onChange({ chTo: e.target.value })} />
        </label>
      ) : (
        <>
          <label>Engine
            <input value={def.chEngine ?? ''} placeholder="MergeTree()" spellCheck={false}
              onChange={e => onChange({ chEngine: e.target.value })} />
          </label>
          <label>Order by
            <input value={def.chOrderBy ?? ''} placeholder="(id)" spellCheck={false}
              onChange={e => onChange({ chOrderBy: e.target.value })} />
          </label>
          <label>Partition by
            <input value={def.chPartitionBy ?? ''} placeholder="toYYYYMM(day) — optional"
              spellCheck={false}
              onChange={e => onChange({ chPartitionBy: e.target.value })} />
          </label>
          <label className="seq-check">
            <input type="checkbox" checked={!!def.populate}
              onChange={e => onChange({ populate: e.target.checked })} />
            POPULATE — backfill once at creation
          </label>
        </>
      )}
    </div>
  );
}
