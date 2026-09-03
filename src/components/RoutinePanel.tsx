/**
 * Routine editor — create and edit procedures, functions, triggers and events.
 *
 * The tool this replaces is "copy SHOW CREATE out of a DDL box, paste it into
 * the SQL editor, hand-write the DROP, hope". So the two things it has to get
 * right are showing you *exactly* what will run before it runs, and never
 * losing a routine when a save fails.
 *
 * That second one is a real hazard on MySQL. There is no `CREATE OR REPLACE`
 * for routines, and DDL implicitly commits, so the only way to change one is
 * DROP then CREATE with no transaction to roll back. A syntax error between
 * those two statements deletes your procedure. The backend keeps the original
 * in hand and puts it back (see commands/routines.rs); this panel makes that
 * visible rather than silent, and shows the recovered DDL if even the restore
 * failed.
 *
 * Backend: `list_routines` / `get_routine` / `save_routine` / `drop_routine`.
 */
import { errorDisplay } from '../utils/appError';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { SqlEditor } from './SqlEditor';
import { StatusIcon } from './StatusIcon';
import { RoutineDebugger } from './RoutineDebugger';
import {
  parseRoutine, buildRoutineDdl, dropRoutineDdl, routineSignature, renderParam,
} from '../utils/routineDdl';
import type { RoutineDef, RoutineKind, RoutineParam, ParamMode } from '../utils/routineDdl';
import { buildRoutineCall } from '../utils/routineCall';
import { copyToClipboard } from '../utils/exportersIo';
import type { Engine } from '../types';

interface RoutineInfo {
  kind: string;
  schema: string;
  name: string;
  returns: string;
  language: string;
  comment: string;
}

interface SaveOutcome {
  ok: boolean;
  executed: string[];
  restored: boolean;
  error: string | null;
}

interface Props {
  sessionId: string;
  /** Keys the debugger's per-connection scratch-schema memory. */
  connectionId?: string;
  engine: Engine;
  /** Current default schema — what the list is populated from. */
  schema: string | null;
  environment?: string | null;
  readOnly?: boolean;
  /** A routine to jump straight into editing (from the schema tree).
      `table` is carried for PostgreSQL triggers, which are named per-table. */
  target?: { schema: string; name: string; kind: string; table?: string } | null;
  /** Called once the target has been consumed, so it does not re-open on a
      later plain (toolbar) open of this panel. */
  onTargetConsumed?: () => void;
  onClose: () => void;
}

const KIND_ICON: Record<string, string> = {
  procedure: '⚙', function: 'ƒ', trigger: '⚡', event: '📅',
};
const KIND_ORDER: RoutineKind[] = ['procedure', 'function', 'trigger', 'event'];
const MODES: ParamMode[] = ['IN', 'OUT', 'INOUT'];

/** A blank routine of the given kind, ready to edit. */
function blankRoutine(kind: RoutineKind, schema: string | null, engine: Engine): RoutineDef {
  const body = kind === 'function'
    ? (engine === 'postgres' ? 'BEGIN\n  RETURN 0;\nEND;' : 'BEGIN\n  RETURN 0;\nEND')
    : (engine === 'postgres' ? 'BEGIN\n  \nEND;' : 'BEGIN\n  \nEND');
  return {
    kind, schema, name: `new_${kind}`,
    params: [],
    returns: kind === 'function'
      ? (engine === 'postgres' ? 'integer' : engine === 'sqlserver' ? 'int' : 'INT')
      : null,
    language: engine === 'postgres' ? 'plpgsql' : 'SQL',
    body,
    characteristics: [],
    trigger: kind === 'trigger'
      ? (engine === 'postgres'
          // A PostgreSQL trigger calls an existing function and has no body; it
          // can fire on several events and choose a row/statement level.
          ? { timing: 'BEFORE', event: 'INSERT', table: '', events: ['INSERT'],
              level: 'ROW' as const, when: '', function: '', functionArgs: '' }
          // A T-SQL trigger holds its body inline like MySQL's, but the
          // timing words are different (there is no BEFORE) and one trigger can
          // fire on several events.
          : engine === 'sqlserver'
          ? { timing: 'AFTER', event: 'INSERT', table: '', events: ['INSERT'] }
          : { timing: 'BEFORE', event: 'INSERT', table: '' })
      : undefined,
    event: kind === 'event'
      ? { schedule: 'EVERY 1 DAY', enabled: 'ENABLE' } : undefined,
    bodyOffset: 0,
  };
}

export function RoutinePanel({
  sessionId, connectionId, engine, schema, environment, readOnly, target, onTargetConsumed, onClose,
}: Props) {
  const [list, setList] = useState<RoutineInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');

  /** The routine being edited, and the DDL it was loaded from. */
  const [def, setDef] = useState<RoutineDef | null>(null);
  const [originalDdl, setOriginalDdl] = useState('');
  const [isNew, setIsNew] = useState(false);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<SaveOutcome | null>(null);
  const [showDdl, setShowDdl] = useState(false);
  // SqlEditor takes an INITIAL value, so switching routines needs a remount.
  // The key is bumped only when the body is replaced wholesale — keying it on
  // the routine name would remount on every keystroke in the name field and
  // throw away the caret.
  const [editorKey, setEditorKey] = useState(0);
  const [debugging, setDebugging] = useState(false);
  // The execute-routine form: whether it is open, and the typed argument per
  // parameter name. Cleared whenever a different routine is loaded.
  const [executing, setExecuting] = useState(false);
  const [callValues, setCallValues] = useState<Record<string, string>>({});

  const isProd = environment === 'prod';
  const canWrite = !readOnly && !isProd;

  const refresh = useCallback(async () => {
    if (!schema) { setList([]); return; }
    setLoading(true);
    setListError(null);
    try {
      setList(await invoke<RoutineInfo[]>('list_routines', { sessionId, schema }));
    } catch (e) {
      setListError(errorDisplay(e));
      setList([]);
    } finally {
      setLoading(false);
    }
  }, [sessionId, schema]);

  useEffect(() => { void refresh(); }, [refresh]);

  const open = useCallback(async (info: RoutineInfo) => {
    setBusy(true);
    setOutcome(null);
    try {
      const src = await invoke<{ ddl: string }>('get_routine', {
        sessionId, schema: info.schema, name: info.name, kind: info.kind,
      });
      setDef(parseRoutine(engine, src.ddl, info.kind as RoutineKind));
      setOriginalDdl(src.ddl);
      setIsNew(false);
      setEditorKey(k => k + 1);
      setDebugging(false);
      setExecuting(false);
      setCallValues({});
    } catch (e) {
      setOutcome({ ok: false, executed: [], restored: false, error: errorDisplay(e) });
    } finally {
      setBusy(false);
    }
  }, [sessionId, engine]);

  /**
   * Open a PostgreSQL trigger by identity.
   *
   * `get_routine` reconstructs the trigger with `pg_get_triggerdef`,
   * disambiguated by its table (a trigger name is only unique per table). If
   * the fetch still misses, we prefill a blank trigger with the identity the
   * tree gave us so the form can recreate it; `DROP … IF EXISTS` in the pending
   * script makes that safe.
   */
  const openPgTrigger = useCallback(async (tSchema: string, name: string, table?: string) => {
    setBusy(true);
    setOutcome(null);
    try {
      const src = await invoke<{ ddl: string }>('get_routine', {
        sessionId, schema: tSchema, name, kind: 'trigger', table,
      });
      setDef(parseRoutine(engine, src.ddl, 'trigger'));
      setOriginalDdl(src.ddl);
      setIsNew(false);
    } catch {
      const blank = blankRoutine('trigger', tSchema, engine);
      setDef({ ...blank, schema: tSchema, name, trigger: { ...blank.trigger!, table: table ?? '' } });
      setOriginalDdl('');
      setIsNew(false);
      setOutcome({
        ok: false, executed: [], restored: false,
        error: `Could not fetch the definition of trigger “${name}” (it may have been `
          + 'dropped, or its table is ambiguous). Its timing, events, condition and '
          + 'function have been left blank — fill them in to recreate it.',
      });
    } finally {
      setEditorKey(k => k + 1);
      setDebugging(false);
      setExecuting(false);
      setCallValues({});
      setBusy(false);
    }
  }, [sessionId, engine]);

  // When the schema tree asks to edit a specific routine, load it directly.
  // `open` only reads schema/name/kind, so a minimal RoutineInfo is enough,
  // and it fetches by identity so the routine need not be in the current list.
  // A PostgreSQL trigger takes a separate path — it is not a pg_proc.
  useEffect(() => {
    if (!target) return;
    if (engine === 'postgres' && target.kind === 'trigger') {
      void openPgTrigger(target.schema, target.name, target.table);
    } else {
      void open({
        kind: target.kind, schema: target.schema, name: target.name,
        returns: '', language: '', comment: '',
      });
    }
    onTargetConsumed?.();
  }, [target, engine, open, openPgTrigger, onTargetConsumed]);

  const startNew = (kind: RoutineKind) => {
    setDef(blankRoutine(kind, schema, engine));
    setOriginalDdl('');
    setIsNew(true);
    setOutcome(null);
    setEditorKey(k => k + 1);
    setDebugging(false);
    setExecuting(false);
    setCallValues({});
  };

  /**
   * Build the CALL/SELECT for the current form and hand it to the SQL editor.
   * Review-only: it lands in the buffer for the DBA to run, nothing executes here.
   */
  const emitCall = useCallback(() => {
    if (!def) return;
    const sql = buildRoutineCall({
      kind: def.kind, schema: def.schema, name: def.name,
      params: def.params, values: callValues, engine, returns: def.returns,
    }).join('\n');
    window.dispatchEvent(new CustomEvent('dbgui:insert-sql', { detail: { sql: `\n${sql}\n` } }));
    setExecuting(false);
  }, [def, callValues, engine]);

  /** Exactly what will be sent, shown before it is sent. */
  const pending = useMemo(() => {
    if (!def) return { create: '', drop: '' };
    const create = buildRoutineDdl(engine, def, { orReplace: true });
    // PostgreSQL functions/procedures replace in place; MySQL has to drop
    // first, and a PostgreSQL *trigger* has no CREATE OR REPLACE (before 14),
    // so an edit re-creates it — DROP … IF EXISTS then CREATE. A brand-new
    // object needs no drop on either engine.
    // SQL Server's CREATE OR ALTER replaces every module kind in one
    // statement, triggers included — so nothing is ever dropped first.
    const pgTrigger = engine === 'postgres' && def.kind === 'trigger';
    const drop = isNew || engine === 'sqlserver' ? ''
      : engine === 'postgres' && !pgTrigger ? ''
      : dropRoutineDdl(engine, def);
    return { create, drop };
  }, [def, engine, isNew]);

  const save = useCallback(async () => {
    if (!def || !canWrite) return;
    setBusy(true);
    setOutcome(null);
    try {
      const res = await invoke<SaveOutcome>('save_routine', {
        sessionId,
        dropSql: pending.drop,
        createSql: pending.create,
        originalDdl,
      });
      setOutcome(res);
      if (res.ok) {
        setIsNew(false);
        setOriginalDdl(pending.create);
        await refresh();
      }
    } catch (e) {
      setOutcome({ ok: false, executed: [], restored: false, error: errorDisplay(e) });
    } finally {
      setBusy(false);
    }
  }, [def, canWrite, sessionId, pending, originalDdl, refresh]);

  const revert = useCallback(() => {
    if (!originalDdl || !def) return;
    setDef(parseRoutine(engine, originalDdl, def.kind));
    setOutcome(null);
    setEditorKey(k => k + 1);
  }, [originalDdl, def, engine]);

  const patch = (p: Partial<RoutineDef>) => setDef(d => (d ? { ...d, ...p } : d));
  const patchParam = (i: number, p: Partial<RoutineParam>) =>
    setDef(d => (d ? {
      ...d, params: d.params.map((x, j) => (j === i ? { ...x, ...p } : x)),
    } : d));

  const grouped = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const hits = q ? list.filter(r => r.name.toLowerCase().includes(q)) : list;
    return KIND_ORDER
      .map(k => ({ kind: k, items: hits.filter(r => r.kind === k) }))
      .filter(g => g.items.length > 0);
  }, [list, filter]);

  return (
    <div className="rt-panel">
      <div className="panel-header">
        <span className="panel-title">⚙ Routines</span>
        {schema && <span className="rt-schema">{schema}</span>}
        <div style={{ flex: 1 }} />
        {canWrite && (
          <span className="rt-new">
            {KIND_ORDER
              // Neither PostgreSQL nor SQL Server has a schema-level scheduled
              // event (SQL Server's nearest equivalent, a SQL Agent job, is a
              // server object and not a routine). PostgreSQL's triggers are
              // supported but take a different, function-calling form.
              .filter(k => k !== 'event' || (engine !== 'postgres' && engine !== 'sqlserver'))
              .map(k => (
                <button key={k} className="toolbar-btn" onClick={() => startNew(k)}
                        title={`New ${k}`}>+ {KIND_ICON[k]}</button>
              ))}
          </span>
        )}
        <button className="toolbar-btn" onClick={refresh} disabled={loading}>Refresh</button>
        <button className="icon-btn" onClick={onClose} title="Close">×</button>
      </div>

      {isProd && (
        <div className="rt-banner rt-banner-block">
          <b>Read-only on production.</b> Routine editing is disabled on connections
          tagged prod — a save here is a `DROP` followed by a `CREATE` with no
          transaction to roll back. Open this on a dev or test connection to edit.
        </div>
      )}
      {!isProd && readOnly && (
        <div className="rt-banner rt-banner-block">
          <b>Read-only connection.</b> You can read routines here but not save them.
        </div>
      )}

      <div className="rt-body">
        <aside className="rt-list">
          <input
            className="rt-filter"
            placeholder="Filter…"
            value={filter}
            onChange={e => setFilter(e.target.value)}
            spellCheck={false}
          />
          {loading && <div className="rt-hint">Loading…</div>}
          {listError && <div className="rt-hint rt-hint-err">{listError}</div>}
          {!loading && !listError && list.length === 0 && (
            <div className="rt-hint">
              {schema ? `No routines in ${schema}.` : 'Select a database first.'}
            </div>
          )}
          {grouped.map(g => (
            <div key={g.kind} className="rt-group">
              <div className="rt-group-head">{KIND_ICON[g.kind]} {g.kind}s <em>{g.items.length}</em></div>
              {g.items.map(r => (
                <button
                  key={`${r.kind}:${r.name}`}
                  className={`rt-item${def && !isNew && def.name === r.name && def.kind === r.kind ? ' active' : ''}`}
                  onClick={() => open(r)}
                  title={r.comment || r.name}
                >
                  <span className="rt-item-name">{r.name}</span>
                  {r.returns && <span className="rt-item-ret">{r.returns}</span>}
                </button>
              ))}
            </div>
          ))}
        </aside>

        <section className="rt-editor">
          {!def ? (
            <div className="rt-empty">
              Select a routine to edit{canWrite ? ', or create one with the + buttons above' : ''}.
            </div>
          ) : (<>
            <div className="rt-meta">
              <label className="rt-field">
                <span>Name</span>
                <input
                  value={def.name}
                  onChange={e => patch({ name: e.target.value })}
                  disabled={!canWrite}
                  spellCheck={false}
                />
              </label>
              {def.kind === 'function' && (
                <label className="rt-field">
                  <span>Returns</span>
                  <input
                    value={def.returns ?? ''}
                    onChange={e => patch({ returns: e.target.value })}
                    disabled={!canWrite}
                    spellCheck={false}
                  />
                </label>
              )}
              {def.kind === 'trigger' && def.trigger && engine === 'sqlserver' && (<>
                <label className="rt-field">
                  <span>Timing</span>
                  {/* T-SQL has no BEFORE trigger. `FOR` is a synonym for
                      AFTER and is normalised away by the parser, so there are
                      genuinely two choices here. */}
                  <select value={def.trigger.timing} disabled={!canWrite}
                          onChange={e => patch({ trigger: { ...def.trigger!, timing: e.target.value } })}>
                    <option>AFTER</option><option>INSTEAD OF</option>
                  </select>
                </label>
                <label className="rt-field">
                  <span>Events</span>
                  <span style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
                    {['INSERT', 'UPDATE', 'DELETE'].map(ev => {
                      const on = (def.trigger!.events ?? []).includes(ev);
                      return (
                        <label key={ev} style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                          <input type="checkbox" checked={on} disabled={!canWrite}
                            onChange={e => {
                              const cur = def.trigger!.events ?? [];
                              const next = e.target.checked
                                ? [...cur, ev].filter((v, i, a) => a.indexOf(v) === i)
                                : cur.filter(v => v !== ev);
                              patch({ trigger: { ...def.trigger!, events: next, event: next[0] ?? 'INSERT' } });
                            }} />
                          {ev}
                        </label>
                      );
                    })}
                  </span>
                </label>
                <label className="rt-field">
                  <span>Table</span>
                  <input value={def.trigger.table} disabled={!canWrite} spellCheck={false}
                         onChange={e => patch({ trigger: { ...def.trigger!, table: e.target.value } })} />
                </label>
              </>)}
              {def.kind === 'trigger' && def.trigger
                && engine !== 'postgres' && engine !== 'sqlserver' && (<>
                <label className="rt-field">
                  <span>Timing</span>
                  <select value={def.trigger.timing} disabled={!canWrite}
                          onChange={e => patch({ trigger: { ...def.trigger!, timing: e.target.value } })}>
                    <option>BEFORE</option><option>AFTER</option>
                  </select>
                </label>
                <label className="rt-field">
                  <span>Event</span>
                  <select value={def.trigger.event} disabled={!canWrite}
                          onChange={e => patch({ trigger: { ...def.trigger!, event: e.target.value } })}>
                    <option>INSERT</option><option>UPDATE</option><option>DELETE</option>
                  </select>
                </label>
                <label className="rt-field">
                  <span>Table</span>
                  <input value={def.trigger.table} disabled={!canWrite} spellCheck={false}
                         onChange={e => patch({ trigger: { ...def.trigger!, table: e.target.value } })} />
                </label>
              </>)}
              {def.kind === 'trigger' && def.trigger && engine === 'postgres' && (<>
                <label className="rt-field">
                  <span>Timing</span>
                  <select value={def.trigger.timing} disabled={!canWrite}
                          onChange={e => patch({ trigger: { ...def.trigger!, timing: e.target.value } })}>
                    <option>BEFORE</option><option>AFTER</option><option>INSTEAD OF</option>
                  </select>
                </label>
                <label className="rt-field">
                  <span>Events</span>
                  <span style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
                    {['INSERT', 'UPDATE', 'DELETE'].map(ev => {
                      const on = (def.trigger!.events ?? []).includes(ev);
                      return (
                        <label key={ev} style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                          <input type="checkbox" checked={on} disabled={!canWrite}
                            onChange={e => {
                              const cur = def.trigger!.events ?? [];
                              const next = e.target.checked
                                ? [...cur, ev].filter((v, i, a) => a.indexOf(v) === i)
                                : cur.filter(v => v !== ev);
                              patch({ trigger: { ...def.trigger!, events: next, event: next[0] ?? 'INSERT' } });
                            }} />
                          {ev}
                        </label>
                      );
                    })}
                  </span>
                </label>
                <label className="rt-field">
                  <span>Table</span>
                  <input value={def.trigger.table} disabled={!canWrite} spellCheck={false}
                         onChange={e => patch({ trigger: { ...def.trigger!, table: e.target.value } })} />
                </label>
                <label className="rt-field">
                  <span>Level</span>
                  <select value={def.trigger.level ?? 'ROW'} disabled={!canWrite}
                          onChange={e => patch({ trigger: { ...def.trigger!, level: e.target.value as 'ROW' | 'STATEMENT' } })}>
                    <option value="ROW">FOR EACH ROW</option>
                    <option value="STATEMENT">FOR EACH STATEMENT</option>
                  </select>
                </label>
                <label className="rt-field rt-field-wide">
                  <span>When (optional)</span>
                  <input value={def.trigger.when ?? ''} disabled={!canWrite} spellCheck={false}
                         placeholder="OLD.status IS DISTINCT FROM NEW.status"
                         onChange={e => patch({ trigger: { ...def.trigger!, when: e.target.value } })} />
                </label>
                <label className="rt-field">
                  <span>Function</span>
                  <input value={def.trigger.function ?? ''} disabled={!canWrite} spellCheck={false}
                         placeholder="fn_name or schema.fn"
                         onChange={e => patch({ trigger: { ...def.trigger!, function: e.target.value } })} />
                </label>
                <label className="rt-field">
                  <span>Function args</span>
                  <input value={def.trigger.functionArgs ?? ''} disabled={!canWrite} spellCheck={false}
                         placeholder="'arg1', 'arg2'"
                         onChange={e => patch({ trigger: { ...def.trigger!, functionArgs: e.target.value } })} />
                </label>
              </>)}
              {def.kind === 'event' && def.event && (
                <label className="rt-field rt-field-wide">
                  <span>Schedule</span>
                  <input value={def.event.schedule} disabled={!canWrite} spellCheck={false}
                         onChange={e => patch({ event: { ...def.event!, schedule: e.target.value } })} />
                </label>
              )}
              <span className="rt-sig" title={routineSignature(def)}>{routineSignature(def)}</span>
            </div>

            {(def.kind === 'procedure' || def.kind === 'function') && (
              <div className="rt-params">
                <div className="rt-params-head">
                  <span>Parameters</span>
                  {canWrite && (
                    <button className="toolbar-btn" onClick={() => patch({
                      params: [...def.params, { mode: 'IN', name: '', type: engine === 'postgres' ? 'integer' : 'INT' }],
                    })}>+ Add</button>
                  )}
                </div>
                {def.params.length === 0 && <div className="rt-hint">No parameters.</div>}
                {def.params.map((p, i) => (
                  <div key={i} className="rt-param">
                    <select value={p.mode} disabled={!canWrite}
                            onChange={e => patchParam(i, { mode: e.target.value as ParamMode })}>
                      {MODES.map(m => <option key={m} value={m}>{m}</option>)}
                    </select>
                    <input className="rt-param-name" value={p.name} placeholder="name"
                           disabled={!canWrite} spellCheck={false}
                           onChange={e => patchParam(i, { name: e.target.value })} />
                    <input className="rt-param-type" value={p.type} placeholder="type"
                           disabled={!canWrite} spellCheck={false}
                           onChange={e => patchParam(i, { type: e.target.value })} />
                    <code className="rt-param-preview">{renderParam(p, engine, def.kind)}</code>
                    {canWrite && (
                      <button className="icon-btn" title="Remove"
                              onClick={() => patch({ params: def.params.filter((_, j) => j !== i) })}>×</button>
                    )}
                  </div>
                ))}
              </div>
            )}

            {/* A PostgreSQL trigger has no body — it calls a function chosen in
                the form above — so its editor is the form, not a SQL buffer. */}
            {!(engine === 'postgres' && def.kind === 'trigger') ? (
              <div className="rt-body-editor">
                <SqlEditor
                  key={editorKey}
                  engine={engine}
                  initialValue={def.body}
                  schemaCompletions={[]}
                  onRun={() => { /* the routine body is saved, not run piecemeal */ }}
                  onChange={body => setDef(d => (d ? { ...d, body } : d))}
                />
              </div>
            ) : (
              <div className="rt-empty">
                A PostgreSQL trigger runs an existing function. Pick the timing,
                events, table, level and function above — the generated
                <code> CREATE TRIGGER … EXECUTE FUNCTION</code> is shown under “Show DDL”.
              </div>
            )}

            <div className="rt-actions">
              <button className="toolbar-btn" onClick={() => setShowDdl(v => !v)}>
                {showDdl ? 'Hide DDL' : 'Show DDL'}
              </button>
              {/* Stepping runs a rewritten copy of the SAVED routine, so an
                  unsaved new one has nothing to run yet. MySQL's copy is a
                  real scratch-schema object (no anonymous blocks, no
                  rollback); PostgreSQL's is an anonymous, rolled-back block. */}
              {(engine === 'postgres' || engine === 'mysql')
                && (def.kind === 'procedure' || def.kind === 'function') && (
                <button
                  className="toolbar-btn"
                  onClick={() => setDebugging(true)}
                  disabled={isNew}
                  title={isNew ? 'Create the routine first' : 'Step through this routine'}
                >🐞 Debug</button>
              )}
              {/* Execute builds a CALL/SELECT from a typed form. PostgreSQL
                  procedures have no session-var OUT convention, so only its
                  functions are offered; MySQL/MariaDB get both. A brand-new
                  routine has nothing to call yet. */}
              {(def.kind === 'procedure' || def.kind === 'function')
                && (engine !== 'postgres' || def.kind === 'function') && (
                <button
                  className="toolbar-btn"
                  onClick={() => { setCallValues({}); setExecuting(v => !v); }}
                  disabled={isNew}
                  title={isNew ? 'Create the routine first' : 'Build a CALL/SELECT to run this routine'}
                >▶ Execute…</button>
              )}
              <button className="toolbar-btn" onClick={() => void copyToClipboard(pending.create)}>
                Copy DDL
              </button>
              <div style={{ flex: 1 }} />
              {!isNew && originalDdl && canWrite && (
                <button className="toolbar-btn" onClick={revert} disabled={busy}>Revert</button>
              )}
              <button className="primary" onClick={save} disabled={!canWrite || busy || !def.name.trim()}>
                {busy ? 'Saving…' : isNew ? 'Create' : 'Save'}
              </button>
            </div>

            {showDdl && (
              <pre className="rt-ddl">
                {pending.drop ? `${pending.drop};\n\n` : ''}{pending.create}
              </pre>
            )}

            {executing && (def.kind === 'procedure' || def.kind === 'function') && (() => {
              // Only parameters that take a value get a box: IN/INOUT for a
              // procedure, every argument for a function. OUT is server-filled.
              const inputs = def.params.filter(p =>
                def.kind === 'function' ? p.mode !== 'OUT' : (p.mode === 'IN' || p.mode === 'INOUT'));
              return (
                <div className="rt-exec">
                  <div className="rt-exec-head">
                    <span>Execute {def.name}</span>
                    <span className="rt-hint">Builds the SQL for review — it is not run.</span>
                  </div>
                  {inputs.length === 0 && <div className="rt-hint">No input parameters.</div>}
                  {inputs.map((p, i) => (
                    <label key={p.name || i} className="rt-exec-arg">
                      <span>
                        {p.name || `arg${i + 1}`}
                        {p.type ? <em> {p.type}</em> : null}
                        {p.mode !== 'IN' ? ` (${p.mode})` : ''}
                      </span>
                      <input
                        value={callValues[p.name] ?? ''}
                        placeholder="NULL"
                        spellCheck={false}
                        onChange={e => setCallValues(v => ({ ...v, [p.name]: e.target.value }))}
                      />
                    </label>
                  ))}
                  <div className="rt-exec-actions">
                    <button className="toolbar-btn" onClick={() => setExecuting(false)}>Cancel</button>
                    <button className="primary" onClick={emitCall}>Insert SQL</button>
                  </div>
                </div>
              );
            })()}

            {debugging && (
              <RoutineDebugger
                sessionId={sessionId}
                connectionId={connectionId}
                engine={engine}
                def={def}
                blocked={isProd
                  ? 'Debugging is disabled on production connections — the run executes the routine body.'
                  : readOnly
                    ? engine === 'postgres'
                      ? 'This connection is read-only; the run executes the routine body, which needs write access even though it is rolled back.'
                      : 'This connection is read-only; debugging creates and runs an instrumented copy, which is a write.'
                    : undefined}
                onClose={() => setDebugging(false)}
              />
            )}

            {outcome && (
              <div className={`rt-outcome ${outcome.ok ? 'ok' : 'err'}`}>
                <div className="rt-outcome-head">
                  <StatusIcon kind={outcome.ok ? 'ok' : 'error'} />
                  {outcome.ok
                    ? `Saved — ${outcome.executed.length} statement${outcome.executed.length === 1 ? '' : 's'} executed.`
                    : outcome.restored
                      ? 'Save failed — the original routine was restored.'
                      : 'Save failed.'}
                </div>
                {outcome.error && <pre className="rt-outcome-err">{outcome.error}</pre>}
              </div>
            )}
          </>)}
        </section>
      </div>
    </div>
  );
}
