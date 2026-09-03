/**
 * Type editor — create and edit PostgreSQL composite types, enums and domains.
 *
 * The sibling of the routine and sequence editors, for the last schema objects
 * that had only a read-only DDL view: a composite type, an enum, and a domain
 * were things you inspected but then hand-wrote `CREATE TYPE` / `ALTER TYPE`
 * for. This is the editor that closes that gap.
 *
 * Same two rules as its siblings. **Show exactly what will run before it
 * runs** — the statements are on screen, never behind a silent Save — and the
 * generated SQL is **review-only**: it is inserted / copied / applied through
 * the same reviewed path, and every identifier and literal is quoted through
 * `utils/sqlIdent`.
 *
 * One PostgreSQL limitation is made visible rather than hidden: an enum value
 * **cannot be dropped**. Removing a row from the values list produces a
 * commented, non-executable marker and a warning, not a statement that
 * quietly does nothing.
 *
 * SQL is in `utils/typeDdl.ts` and pure; this is the screen.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { QueryResult, Session } from '../types';
import { errorDisplay } from '../utils/appError';
import { copyToClipboard } from '../utils/exportersIo';
import {
  listSql, readCompositeSql, readEnumSql, readDomainSql, readDomainChecksSql, stripCheck,
  createSql, alterSql, dropSql, toScript, worstRisk, typeSignature,
  type TypeDef, type TypeKind, type TypeChange, type CompositeAttr, type DomainCheck,
} from '../utils/typeDdl';

interface Props {
  session: Session;
  schema: string | null;
  /** A type to jump straight into editing (from the schema tree). */
  target?: { schema: string; name: string; kind: string } | null;
  /** Called once the target has been consumed, so it does not re-open on a
      later plain (toolbar) open of this panel. */
  onTargetConsumed?: () => void;
  onClose: () => void;
}

const KINDS: TypeKind[] = ['composite', 'enum', 'domain'];
const KIND_LABEL: Record<TypeKind, string> = {
  composite: 'Composite', enum: 'Enum', domain: 'Domain',
};

/** A blank type of the given kind, ready to edit. */
function blankType(kind: TypeKind, schema: string): TypeDef {
  switch (kind) {
    case 'composite':
      return { schema, name: '', kind, attrs: [{ name: '', type: 'text' }] };
    case 'enum':
      return { schema, name: '', kind, values: [''] };
    case 'domain':
      return { schema, name: '', kind, baseType: 'text', notNull: false, default: '', checks: [] };
  }
}

/** Normalise a tree-supplied kind string onto a TypeKind, or null when the
    tree only knew it was "some type" and the kind must be resolved by lookup. */
function asKind(kind: string): TypeKind | null {
  return kind === 'composite' || kind === 'enum' || kind === 'domain' ? kind : null;
}

export function TypePanel({ session, schema, target, onTargetConsumed, onClose }: Props) {
  const isPg = session.engine === 'postgres';

  const [schemas, setSchemas] = useState<string[]>([]);
  const [db, setDb] = useState(schema ?? '');
  const [items, setItems] = useState<{ name: string; kind: TypeKind }[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [current, setCurrent] = useState<TypeDef | null>(null);
  const [draft, setDraft] = useState<TypeDef | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  /** A type requested by the tree, held until `db` has caught up to its
      schema so `open` reads from the right one. */
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
    if (!isPg) return;
    run("SELECT schema_name FROM information_schema.schemata WHERE schema_name NOT IN ('pg_catalog','information_schema') ORDER BY schema_name")
      .then(r => {
        const l = r.rows.map(x => String(x[0]));
        setSchemas(l);
        setDb(d => d || l[0] || '');
      })
      .catch(e => setError(errorDisplay(e)));
  }, [run, isPg]);

  const refreshList = useCallback(async () => {
    if (!isPg || !db) return;
    try {
      const r = await run(listSql(db));
      setItems(r.rows
        .map(x => ({ name: String(x[0]), kind: asKind(String(x[1])) }))
        .filter((x): x is { name: string; kind: TypeKind } => x.kind !== null));
    } catch (e) { setError(errorDisplay(e)); }
  }, [run, db, isPg]);

  useEffect(() => { void refreshList(); }, [refreshList]);

  /** Load one type. `null` starts a new one of `kind`. */
  const open = useCallback(async (name: string | null, wantKind?: string) => {
    setSelected(name);
    setError(null);
    setNote(null);
    if (!isPg) return;
    if (name === null) {
      const blank = blankType(asKind(wantKind ?? '') ?? 'composite', db);
      setCurrent(null);
      setDraft(blank);
      return;
    }
    // Resolve the kind: the tree may only know it is "a type", so fall back to
    // whatever the list found for this name.
    const kind = asKind(wantKind ?? '') ?? items.find(i => i.name === name)?.kind ?? null;
    if (!kind) {
      setError(`Could not determine the kind of ${db}.${name}. Reload the list and try again.`);
      return;
    }
    try {
      let def: TypeDef;
      if (kind === 'composite') {
        const r = await run(readCompositeSql(db, name));
        const attrs: CompositeAttr[] = r.rows.map(x => ({ name: String(x[0]), type: String(x[1]) }));
        def = { schema: db, name, kind, attrs: attrs.length ? attrs : [{ name: '', type: 'text' }] };
      } else if (kind === 'enum') {
        const r = await run(readEnumSql(db, name));
        const values = r.rows.map(x => String(x[0]));
        def = { schema: db, name, kind, values: values.length ? values : [''] };
      } else {
        const r = await run(readDomainSql(db, name));
        const row = r.rows[0] ?? [];
        const cr = await run(readDomainChecksSql(db, name));
        const checks: DomainCheck[] = cr.rows.map(x => ({
          name: String(x[0]), expr: stripCheck(String(x[1] ?? '')),
        }));
        def = {
          schema: db, name, kind,
          baseType: String(row[0] ?? 'text'),
          notNull: ['t', 'true', '1'].includes(String(row[1]).toLowerCase()),
          default: row[2] === null || row[2] === undefined ? '' : String(row[2]),
          checks,
        };
      }
      setCurrent(def);
      setDraft(structuredClone(def));
    } catch (e) {
      setError(errorDisplay(e));
      setCurrent(null); setDraft(null);
    }
  }, [db, run, isPg, items]);

  // When the schema tree asks to edit a specific type, switch to its schema
  // first, then open it once `db` (which `open` closes over) has caught up.
  useEffect(() => {
    if (!isPg || !target) return;
    setDb(target.schema);
    setPendingTarget(target);
    onTargetConsumed?.();
  }, [target, isPg, onTargetConsumed]);
  useEffect(() => {
    if (pendingTarget && db === pendingTarget.schema) {
      void open(pendingTarget.name, pendingTarget.kind);
      setPendingTarget(null);
    }
  }, [pendingTarget, db, open]);

  const changes: TypeChange[] = useMemo(() => {
    if (!draft) return [];
    if (!current) {
      return draft.name.trim()
        ? [{ kind: 'create' as const, subject: draft.name, risk: 'safe' as const,
             sql: createSql(draft) }]
        : [];
    }
    return alterSql(current, draft);
  }, [current, draft]);

  const apply = useCallback(async (list: TypeChange[]) => {
    const runnable = list.filter(c => !c.sql.trim().startsWith('--'));
    if (!runnable.length) return;
    setBusy(true); setError(null); setNote(null);
    try {
      for (const c of runnable) await exec(c.sql);
      setNote(`${runnable.length} statement${runnable.length === 1 ? '' : 's'} applied.`);
      await refreshList();
      if (draft) await open(draft.name, draft.kind);
    } catch (e) {
      setError(errorDisplay(e));
    } finally { setBusy(false); }
  }, [exec, refreshList, open, draft]);

  const patch = (over: Partial<TypeDef>) => setDraft(d => (d ? { ...d, ...over } : d));

  if (!isPg) {
    return (
      <div className="proc-panel">
        <div className="proc-toolbar">
          <span className="proc-title">🧬 Types</span>
          <div style={{ flex: 1 }} />
          <button className="icon-btn" onClick={onClose} title="Close">×</button>
        </div>
        <div className="db-error">
          Composite types, enums and domains are PostgreSQL objects. MySQL has no
          standalone user-defined types — an <code>ENUM</code> there belongs to one
          column rather than standing on its own.
        </div>
      </div>
    );
  }

  const risk = worstRisk(changes);
  const script = toScript(changes);
  const hasRunnable = changes.some(c => !c.sql.trim().startsWith('--'));

  return (
    <div className="proc-panel">
      <div className="proc-toolbar">
        <span className="proc-title">🧬 Types</span>
        <select value={db} onChange={e => { setDb(e.target.value); setDraft(null); setCurrent(null); setSelected(null); }}>
          {schemas.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        <select value={selected ?? ''} onChange={e => void open(e.target.value || null)}>
          <option value="">— type —</option>
          {items.map(i => (
            <option key={i.name} value={i.name}>{i.name} ({i.kind})</option>
          ))}
        </select>
        <span className="rt-new">
          {KINDS.map(k => (
            <button key={k} className="toolbar-btn" onClick={() => void open(null, k)}
              title={`New ${KIND_LABEL[k].toLowerCase()} type`}>+ {KIND_LABEL[k]}</button>
          ))}
        </span>
        <div style={{ flex: 1 }} />
        <span className="dv-desc">{items.length} in {db}</span>
        <button className="icon-btn" onClick={onClose} title="Close">×</button>
      </div>

      {error && <div className="proc-error-bar">{error}</div>}
      {note && <div className="seq-note">{note}</div>}

      {!draft && (
        <div className="db-error">
          Pick a type to edit, or start a new composite, enum or domain above. The SQL
          is shown before anything runs — nothing here executes on its own.
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
              <input value={KIND_LABEL[draft.kind]} disabled />
            </label>
          </div>

          {draft.kind === 'composite' && (
            <CompositeEditor def={draft} onChange={patch} />
          )}
          {draft.kind === 'enum' && (
            <EnumEditor def={draft} isExisting={!!current} onChange={patch} />
          )}
          {draft.kind === 'domain' && (
            <DomainEditor def={draft} onChange={patch} />
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
                  {hasRunnable && (
                    <button className={`toolbar-btn${risk === 'safe' ? '' : ' td-danger'}`}
                      disabled={busy} onClick={() => void apply(changes)}>
                      {busy ? 'Running…' : current ? 'Apply' : 'Create'}
                    </button>
                  )}
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
            {changes.filter(c => c.warning).map((c, i) => (
              <div key={i} className="seq-warn">{c.warning}</div>
            ))}
          </div>

          <div className="seq-position">
            <span className="dv-desc">{typeSignature(draft)}</span>
          </div>
        </div>
      )}
    </div>
  );
}

// ── per-kind sub-forms ────────────────────────────────────────────────────────

function CompositeEditor({ def, onChange }: { def: TypeDef; onChange: (o: Partial<TypeDef>) => void }) {
  const attrs = def.attrs ?? [];
  const set = (next: CompositeAttr[]) => onChange({ attrs: next });
  return (
    <div className="rt-params">
      <div className="rt-params-head">
        <span>Attributes</span>
        <button className="toolbar-btn" onClick={() => set([...attrs, { name: '', type: 'text' }])}>+ Add</button>
      </div>
      {attrs.length === 0 && <div className="dv-desc">No attributes yet.</div>}
      {attrs.map((a, i) => (
        <div key={i} className="rt-param">
          <input className="fif-input" placeholder="name" value={a.name} spellCheck={false}
            onChange={e => set(attrs.map((x, j) => j === i ? { ...x, name: e.target.value } : x))} />
          <input className="fif-input" placeholder="type" value={a.type} spellCheck={false}
            onChange={e => set(attrs.map((x, j) => j === i ? { ...x, type: e.target.value } : x))} />
          <button className="icon-btn" title="Remove"
            onClick={() => set(attrs.filter((_, j) => j !== i))}>×</button>
        </div>
      ))}
    </div>
  );
}

function EnumEditor(
  { def, isExisting, onChange }:
  { def: TypeDef; isExisting: boolean; onChange: (o: Partial<TypeDef>) => void },
) {
  const values = def.values ?? [];
  const set = (next: string[]) => onChange({ values: next });
  return (
    <div className="rt-params">
      <div className="rt-params-head">
        <span>Values</span>
        <button className="toolbar-btn" onClick={() => set([...values, ''])}>+ Add</button>
      </div>
      {values.map((v, i) => (
        <div key={i} className="rt-param">
          <input className="fif-input" placeholder="value" value={v} spellCheck={false}
            onChange={e => set(values.map((x, j) => j === i ? e.target.value : x))} />
          <button className="icon-btn" title="Remove"
            onClick={() => set(values.filter((_, j) => j !== i))}>×</button>
        </div>
      ))}
      {isExisting && (
        <div className="seq-warn">
          PostgreSQL cannot drop an enum value: editing a value in place becomes a
          RENAME, a new one an ADD, and removing one is refused with an explanation
          rather than an executable statement.
        </div>
      )}
    </div>
  );
}

function DomainEditor({ def, onChange }: { def: TypeDef; onChange: (o: Partial<TypeDef>) => void }) {
  const checks = def.checks ?? [];
  const setChecks = (next: DomainCheck[]) => onChange({ checks: next });
  return (
    <>
      <div className="seq-form">
        <label>Base type
          <input value={def.baseType ?? ''} spellCheck={false}
            onChange={e => onChange({ baseType: e.target.value })} />
        </label>
        <label>Default
          <input value={def.default ?? ''} placeholder="(none)" spellCheck={false}
            onChange={e => onChange({ default: e.target.value })} />
        </label>
        <label className="seq-check">
          <input type="checkbox" checked={!!def.notNull}
            onChange={e => onChange({ notNull: e.target.checked })} />
          NOT NULL — reject a NULL value for this domain
        </label>
      </div>
      <div className="rt-params">
        <div className="rt-params-head">
          <span>Checks</span>
          <button className="toolbar-btn" onClick={() => setChecks([...checks, { expr: '' }])}>+ Add</button>
        </div>
        {checks.map((c, i) => (
          <div key={i} className="rt-param">
            <input className="fif-input" placeholder="constraint name (optional)" value={c.name ?? ''}
              spellCheck={false}
              onChange={e => setChecks(checks.map((x, j) => j === i ? { ...x, name: e.target.value } : x))} />
            <input className="fif-input" placeholder="VALUE > 0" value={c.expr} spellCheck={false}
              onChange={e => setChecks(checks.map((x, j) => j === i ? { ...x, expr: e.target.value } : x))} />
            <button className="icon-btn" title="Remove"
              onClick={() => setChecks(checks.filter((_, j) => j !== i))}>×</button>
          </div>
        ))}
      </div>
    </>
  );
}
