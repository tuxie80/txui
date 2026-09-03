/**
 * Dictionary editor — create, replace and drop ClickHouse dictionaries.
 *
 * The sibling of the view and type editors, for the last ClickHouse object that
 * had only a read-only DDL box: a dictionary was a thing you inspected under
 * "View DDL" and then hand-wrote `CREATE DICTIONARY` for. This is the editor
 * that closes that gap.
 *
 * Same two rules as its siblings. **Show exactly what will run before it
 * runs** — the statement is on screen, never behind a silent Save — and the
 * generated SQL is **review-only**: it is inserted / copied / applied through
 * the same reviewed path, and every identifier the editor inserts is quoted
 * through `utils/sqlIdent`.
 *
 * A dictionary's SOURCE and LAYOUT have many forms; the common ones are fields,
 * and everything else is reachable through a free-text SOURCE and a
 * whole-statement raw override — so an exotic dictionary is never blocked. An
 * existing one's definition is read back through the same `get_ddl` the schema
 * tree's "View DDL" uses, so nothing new is asked of the backend.
 *
 * SQL is in `utils/dictionaryDdl.ts` and pure; this is the screen.
 */
import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { QueryResult, Session } from '../types';
import { errorDisplay } from '../utils/appError';
import { copyToClipboard } from '../utils/exportersIo';
import {
  schemaListSql, listSql, parseDictionary, createSql, dropSql, changesFor,
  toScript, worstRisk, isBuildable, blankDict,
  type DictDef, type DictChange, type DictAttr, type DictSource, type DictSourceKind,
  type DictLayoutKind,
} from '../utils/dictionaryDdl';

const SqlEditor = lazy(() => import('./SqlEditor').then(m => ({ default: m.SqlEditor })));

interface Props {
  session: Session;
  schema: string | null;
  /** A dictionary to jump straight into editing (from the schema tree). */
  target?: { schema: string; name: string } | null;
  /** Called once the target has been consumed, so it does not re-open on a
      later plain (toolbar) open of this panel. */
  onTargetConsumed?: () => void;
  onClose: () => void;
}

const SOURCE_KINDS: DictSourceKind[] = ['CLICKHOUSE', 'HTTP', 'FILE', 'CUSTOM'];
const LAYOUT_KINDS: DictLayoutKind[] = ['FLAT', 'HASHED', 'COMPLEX_KEY_HASHED', 'CACHE'];

export function DictionaryPanel({ session, schema, target, onTargetConsumed, onClose }: Props) {
  const isCh = session.engine === 'clickhouse';

  const [schemas, setSchemas] = useState<string[]>([]);
  const [db, setDb] = useState(schema ?? '');
  const [items, setItems] = useState<string[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [current, setCurrent] = useState<DictDef | null>(null);
  const [draft, setDraft] = useState<DictDef | null>(null);
  /** The DDL as fetched, kept as the seed for raw editing an existing one. */
  const [loadedDdl, setLoadedDdl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  // SqlEditor takes an INITIAL value, so entering/leaving raw mode needs a
  // remount to swap the document.
  const [editorKey, setEditorKey] = useState(0);
  const [pendingTarget, setPendingTarget] =
    useState<{ schema: string; name: string } | null>(null);

  const run = useCallback(
    (sql: string) => invoke<QueryResult>('monitor_query', { sessionId: session.sessionId, sql }),
    [session.sessionId]);
  const exec = useCallback(
    (sql: string) => invoke<QueryResult>('execute_query', {
      sessionId: session.sessionId, sql, tabId: 0,
    }),
    [session.sessionId]);

  useEffect(() => {
    if (!isCh) return;
    run(schemaListSql())
      .then(r => {
        const l = r.rows.map(x => String(x[0]));
        setSchemas(l);
        setDb(d => d || l[0] || '');
      })
      .catch(e => setError(errorDisplay(e)));
  }, [run, isCh]);

  const refreshList = useCallback(async () => {
    if (!isCh || !db) return;
    try {
      const r = await run(listSql(db));
      setItems(r.rows.map(x => String(x[0])));
    } catch (e) { setError(errorDisplay(e)); }
  }, [run, db, isCh]);

  useEffect(() => { void refreshList(); }, [refreshList]);

  /** Load one dictionary. `null` starts a new one. */
  const open = useCallback(async (name: string | null) => {
    setSelected(name);
    setError(null);
    setNote(null);
    setLoadedDdl('');
    if (!isCh) return;
    if (name === null) {
      setCurrent(null);
      setDraft(blankDict(db));
      setEditorKey(k => k + 1);
      return;
    }
    try {
      // The same command the schema tree's "View DDL" uses — no new backend.
      const ddl = await invoke<string>('get_ddl', {
        sessionId: session.sessionId, parent: `${db}.${name}`,
      });
      setLoadedDdl(ddl);
      const parsed = parseDictionary(ddl);
      const base = blankDict(db);
      const def: DictDef = {
        ...base,
        ...parsed,
        schema: db,
        name,
        attrs: parsed.attrs && parsed.attrs.length ? parsed.attrs : base.attrs,
        primaryKey: parsed.primaryKey ?? base.primaryKey,
        source: parsed.source ?? base.source,
        layout: parsed.layout ?? base.layout,
        lifetime: parsed.lifetime ?? base.lifetime,
      };
      setCurrent(def);
      setDraft(structuredClone(def));
      setEditorKey(k => k + 1);
    } catch (e) {
      setError(errorDisplay(e));
      setCurrent(null); setDraft(null);
    }
  }, [db, isCh, session.sessionId]);

  // When the schema tree asks to edit a specific dictionary, switch to its
  // schema first, then open it once `db` has caught up.
  useEffect(() => {
    if (!isCh || !target) return;
    setDb(target.schema);
    setPendingTarget(target);
    onTargetConsumed?.();
  }, [target, isCh, onTargetConsumed]);
  useEffect(() => {
    if (pendingTarget && db === pendingTarget.schema) {
      void open(pendingTarget.name);
      setPendingTarget(null);
    }
  }, [pendingTarget, db, open]);

  const changes: DictChange[] = useMemo(() => {
    if (!draft) return [];
    return changesFor(current, draft);
  }, [current, draft]);

  const apply = useCallback(async (list: DictChange[]) => {
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

  const patch = (over: Partial<DictDef>) => setDraft(d => (d ? { ...d, ...over } : d));

  const rawMode = !!draft?.raw;
  const toggleRaw = (on: boolean) => {
    setDraft(d => {
      if (!d) return d;
      if (on) {
        const seed = (current && loadedDdl.trim()) || createSql(d);
        return { ...d, raw: seed };
      }
      return { ...d, raw: undefined };
    });
    setEditorKey(k => k + 1);
  };

  if (!isCh) {
    return (
      <div className="proc-panel">
        <div className="proc-toolbar">
          <span className="proc-title">📖 Dictionaries</span>
          <div style={{ flex: 1 }} />
          <button className="icon-btn" onClick={onClose} title="Close">×</button>
        </div>
        <div className="db-error">
          A dictionary is a ClickHouse object — an in-memory key/value table loaded from a
          source and refreshed on a lifetime. This connection is not ClickHouse, so it has
          none to edit.
        </div>
      </div>
    );
  }

  const risk = worstRisk(changes);
  const script = toScript(changes);

  return (
    <div className="proc-panel">
      <div className="proc-toolbar">
        <span className="proc-title">📖 Dictionaries</span>
        <select value={db} onChange={e => { setDb(e.target.value); setDraft(null); setCurrent(null); setSelected(null); }}>
          {schemas.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        <select value={selected ?? ''} onChange={e => void open(e.target.value || null)}>
          <option value="">— dictionary —</option>
          {items.map(i => <option key={i} value={i}>{i}</option>)}
        </select>
        <span className="rt-new">
          <button className="toolbar-btn" onClick={() => void open(null)}
            title="New dictionary">+ Dictionary</button>
        </span>
        <div style={{ flex: 1 }} />
        <span className="dv-desc">{items.length} in {db}</span>
        <button className="icon-btn" onClick={onClose} title="Close">×</button>
      </div>

      {error && <div className="proc-error-bar">{error}</div>}
      {note && <div className="seq-note">{note}</div>}

      {!draft && (
        <div className="db-error">
          Pick a dictionary to edit, or start a new one above. The SQL is shown before
          anything runs — nothing here executes on its own.
        </div>
      )}

      {draft && (
        <div className="seq-body">
          <div className="seq-form">
            <label>Name
              <input value={draft.name} disabled={!!current} spellCheck={false}
                onChange={e => patch({ name: e.target.value })} />
            </label>
            <label className="seq-check">
              <input type="checkbox" checked={rawMode}
                onChange={e => toggleRaw(e.target.checked)} />
              Edit as raw SQL — the whole CREATE DICTIONARY statement
            </label>
          </div>

          {rawMode ? (
            <div className="rt-body-editor">
              <Suspense fallback={<div className="rt-hint">Loading editor…</div>}>
                <SqlEditor
                  key={editorKey}
                  engine={session.engine}
                  initialValue={draft.raw ?? ''}
                  schemaCompletions={[]}
                  onRun={() => { /* review-only — never run piecemeal */ }}
                  onChange={raw => setDraft(d => (d ? { ...d, raw } : d))}
                />
              </Suspense>
            </div>
          ) : (
            <>
              <AttrEditor def={draft} onChange={patch} />
              <div className="seq-form">
                <label>Primary key
                  <input value={draft.primaryKey} placeholder="id" spellCheck={false}
                    onChange={e => patch({ primaryKey: e.target.value })} />
                </label>
              </div>
              <SourceEditor source={draft.source} onChange={s => patch({ source: s })} />
              <LayoutEditor def={draft} onChange={patch} />
              <div className="seq-form">
                <label>Lifetime MIN (s)
                  <input value={draft.lifetime.min} spellCheck={false}
                    onChange={e => patch({ lifetime: { ...draft.lifetime, min: e.target.value } })} />
                </label>
                <label>Lifetime MAX (s)
                  <input value={draft.lifetime.max} spellCheck={false}
                    onChange={e => patch({ lifetime: { ...draft.lifetime, max: e.target.value } })} />
                </label>
              </div>
            </>
          )}

          <div className="seq-script">
            <div className="seq-script-head">
              <span>{changes.length === 0 ? 'Nothing to run yet' : `${changes.length} statement${changes.length === 1 ? '' : 's'}`}</span>
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
                    sql: dropSql(current),
                  }]).then(() => { setDraft(null); setCurrent(null); setSelected(null); })}
                >Drop</button>
              )}
            </div>
            {changes.length > 0 && <pre className="seq-sql">{script}</pre>}
            {changes.length === 0 && !isBuildable(draft) && (
              <div className="rt-hint">
                A dictionary needs a name, at least one attribute, and a primary key before it
                can be built. Fill those in, or switch to raw SQL.
              </div>
            )}
            {changes.filter(c => c.warning).map((c, i) => (
              <div key={i} className="seq-warn">{c.warning}</div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── sub-forms ─────────────────────────────────────────────────────────────────

function AttrEditor({ def, onChange }: { def: DictDef; onChange: (o: Partial<DictDef>) => void }) {
  const attrs = def.attrs;
  const set = (next: DictAttr[]) => onChange({ attrs: next });
  return (
    <div className="rt-params">
      <div className="rt-params-head">
        <span>Attributes</span>
        <button className="toolbar-btn" onClick={() => set([...attrs, { name: '', type: '' }])}>+ Add</button>
      </div>
      {attrs.length === 0 && <div className="dv-desc">No attributes yet.</div>}
      {attrs.map((a, i) => (
        <div key={i} className="rt-param">
          <input className="fif-input" placeholder="name" value={a.name} spellCheck={false}
            onChange={e => set(attrs.map((x, j) => j === i ? { ...x, name: e.target.value } : x))} />
          <input className="fif-input" placeholder="type (UInt64, String…)" value={a.type} spellCheck={false}
            onChange={e => set(attrs.map((x, j) => j === i ? { ...x, type: e.target.value } : x))} />
          <input className="fif-input" placeholder="DEFAULT (optional)" value={a.default ?? ''} spellCheck={false}
            onChange={e => set(attrs.map((x, j) => j === i ? { ...x, default: e.target.value } : x))} />
          <button className="icon-btn" title="Remove"
            onClick={() => set(attrs.filter((_, j) => j !== i))}>×</button>
        </div>
      ))}
    </div>
  );
}

function SourceEditor(
  { source, onChange }: { source: DictSource; onChange: (s: DictSource) => void },
) {
  const set = (over: Partial<DictSource>) => onChange({ ...source, ...over });
  return (
    <div className="seq-form">
      <label>Source
        <select value={source.kind}
          onChange={e => set({ kind: e.target.value as DictSourceKind })}>
          {SOURCE_KINDS.map(k => <option key={k} value={k}>{k}</option>)}
        </select>
      </label>
      {source.kind === 'CLICKHOUSE' && (
        <>
          <label>Host<input value={source.host ?? ''} spellCheck={false}
            onChange={e => set({ host: e.target.value })} /></label>
          <label>Port<input value={source.port ?? ''} spellCheck={false}
            onChange={e => set({ port: e.target.value })} /></label>
          <label>User<input value={source.user ?? ''} spellCheck={false}
            onChange={e => set({ user: e.target.value })} /></label>
          <label>Password<input value={source.password ?? ''} spellCheck={false}
            onChange={e => set({ password: e.target.value })} /></label>
          <label>DB<input value={source.db ?? ''} spellCheck={false}
            onChange={e => set({ db: e.target.value })} /></label>
          <label>Table<input value={source.table ?? ''} spellCheck={false}
            onChange={e => set({ table: e.target.value })} /></label>
        </>
      )}
      {source.kind === 'HTTP' && (
        <>
          <label>URL<input value={source.url ?? ''} placeholder="http://…" spellCheck={false}
            onChange={e => set({ url: e.target.value })} /></label>
          <label>Format<input value={source.format ?? ''} placeholder="CSV, TSV, JSONEachRow…"
            spellCheck={false} onChange={e => set({ format: e.target.value })} /></label>
        </>
      )}
      {source.kind === 'FILE' && (
        <>
          <label>Path<input value={source.path ?? ''} placeholder="/var/lib/…" spellCheck={false}
            onChange={e => set({ path: e.target.value })} /></label>
          <label>Format<input value={source.format ?? ''} placeholder="CSV, TSV, JSONEachRow…"
            spellCheck={false} onChange={e => set({ format: e.target.value })} /></label>
        </>
      )}
      {source.kind === 'CUSTOM' && (
        <label style={{ flexBasis: '100%' }}>Source body (inside SOURCE(…))
          <input value={source.raw ?? ''} placeholder="MYSQL(host 'h' port 3306 user 'u' db 'd' table 't')"
            spellCheck={false} onChange={e => set({ raw: e.target.value })} /></label>
      )}
      {source.kind === 'CUSTOM' && (
        <div className="seq-warn">
          Other sources (MySQL, PostgreSQL, MongoDB, executable, …) are best-effort free text:
          type the whole inside of SOURCE(…) and it is passed through unchanged.
        </div>
      )}
    </div>
  );
}

function LayoutEditor({ def, onChange }: { def: DictDef; onChange: (o: Partial<DictDef>) => void }) {
  const layout = def.layout;
  return (
    <div className="seq-form">
      <label>Layout
        <select value={layout.kind}
          onChange={e => onChange({ layout: { ...layout, kind: e.target.value as DictLayoutKind } })}>
          {LAYOUT_KINDS.map(k => <option key={k} value={k}>{k}</option>)}
        </select>
      </label>
      {layout.kind === 'CACHE' && (
        <label>Size (cells)
          <input value={layout.size ?? ''} placeholder="1000" spellCheck={false}
            onChange={e => onChange({ layout: { ...layout, size: e.target.value } })} />
        </label>
      )}
    </div>
  );
}
