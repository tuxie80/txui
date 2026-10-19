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
 * The toolbar also carries the server-side half of rename refactoring
 * (utils/renameScript.ts): it builds a MIGRATION SCRIPT — drop dependents →
 * rename → recreate — rewrites only `certain` occurrences, and hands the
 * script to an editor buffer via `dbgui:insert-sql`. Nothing here executes
 * it; running it goes through the normal write path (sqlguard, prod
 * confirmations), exactly as if the user had typed it.
 *
 * The matching and the SQL are pure (`utils/findUsages.ts`,
 * `utils/usageSources.ts`, `utils/renameScript.ts`); this is the screen.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { QueryResult, Session } from '../types';
import { errorDisplay } from '../utils/appError';
import { safePath, sqlLiteral } from '../utils/sqlIdent';
import {
  findUsages, summarise,
  type Confidence, type SourceKind, type UsageSource, type UsageReport,
} from '../utils/findUsages';
import { corpusSql } from '../utils/usageSources';
import {
  buildRenameScript, invalidNewName, needsCreateSql, parseCorpusLabel,
  type RenameEngine, type RenameObject, type RenameScript,
} from '../utils/renameScript';

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
  // The rename-script dialects are written for MySQL/MariaDB and PostgreSQL —
  // the engines the corpus search covers end to end. SQL Server can search
  // but not rename; every other engine can do neither here.
  const canRename = session.engine === 'mysql' || session.engine === 'postgres';
  const renameBlocked = canRename ? null
    : 'Rename scripts are built for MySQL/MariaDB and PostgreSQL — '
      + `the rename dialects this panel knows. ${session.engine} can be searched but not renamed.`;
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
  const [renameOpen, setRenameOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [renameBusy, setRenameBusy] = useState(false);
  const [rename, setRename] = useState<RenameScript | null>(null);
  const [copied, setCopied] = useState(false);

  const run = useCallback(
    (sql: string) => invoke<QueryResult>('monitor_query', { sessionId: session.sessionId, sql }),
    [session.sessionId]);

  useEffect(() => {
    const sql = engine === 'sqlserver'
      ? "SELECT name FROM sys.schemas WHERE schema_id < 16384 AND name NOT IN ('sys','INFORMATION_SCHEMA','guest') ORDER BY name"
      : engine === 'mysql'
      ? "SELECT schema_name FROM information_schema.schemata WHERE schema_name NOT IN ('information_schema','performance_schema','mysql','sys') ORDER BY schema_name"
      : "SELECT schema_name FROM information_schema.schemata WHERE schema_name NOT IN ('pg_catalog','information_schema') ORDER BY schema_name";
    let alive = true;
    run(sql)
      .then(r => {
        if (!alive) return;
        const l = r.rows.map(x => String(x[0]));
        setSchemas(l);
        setDb(d => d || l[0] || '');
      })
      .catch(e => { if (alive) setError(errorDisplay(e)); });
    return () => { alive = false; };
  }, [run, engine]);

  useEffect(() => {
    if (!db) return;
    let alive = true;
    setTable(''); setColumn(''); setReport(null); setSources(null);
    run(`SELECT table_name FROM information_schema.tables WHERE table_schema = ${sqlLiteral(db, engine)} ORDER BY table_name`)
      .then(r => { if (alive) setTables(r.rows.map(x => String(x[0]))); })
      .catch(e => { if (alive) setError(errorDisplay(e)); });
    return () => { alive = false; };
  }, [db, run, engine]);

  useEffect(() => {
    if (!db || !table) { setColumns([]); return; }
    let alive = true;
    setColumn('');
    run(`SELECT column_name FROM information_schema.columns WHERE table_schema = ${sqlLiteral(db, engine)}`
      + ` AND table_name = ${sqlLiteral(table, engine)} ORDER BY ordinal_position`)
      .then(r => { if (alive) setColumns(r.rows.map(x => String(x[0]))); })
      .catch(e => { if (alive) setError(errorDisplay(e)); });
    return () => { alive = false; };
  }, [db, table, run, engine]);

  const fetchCorpus = useCallback(async (schemaName: string): Promise<UsageSource[]> => {
    const r = await run(corpusSql(schemaName, engine));
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
    return [...fromServer, ...buffers.map(b => ({
      id: `buf-${b.id}`, kind: 'buffer' as SourceKind, label: b.label, sql: b.sql,
    }))];
  }, [run, engine, buffers]);

  const search = useCallback(async () => {
    if (!db || !table) return;
    setBusy(true);
    setError(null);
    try {
      const all = await fetchCorpus(db);
      setSources(all);
      setReport(findUsages(all, { table, column: column || undefined }, engine));
    } catch (e) {
      setError(errorDisplay(e));
      setReport(null);
    } finally {
      setBusy(false);
    }
  }, [db, table, column, fetchCorpus, engine]);

  // ── rename refactoring ─────────────────────────────────────────────────────
  //
  // Generating the script is read-only throughout: a fresh corpus read, one
  // SHOW CREATE / pg_get_functiondef per object being recreated, and a pure
  // builder. The script itself is delivered to an editor buffer; the user
  // reviews it and runs it through the normal execute path.

  /** The server's own full CREATE text for one dependent, or undefined. */
  const fetchCreateSql = useCallback(async (
    o: UsageSource, re: RenameEngine,
  ): Promise<string | undefined> => {
    const parsed = parseCorpusLabel(o.kind, o.label, o.ownerTable);
    if (!parsed) return undefined;
    try {
      if (re === 'postgres') {
        // The label's args come from pg_get_function_identity_arguments, which
        // includes argument NAMES — `f(amt numeric)` — and that string is not
        // castable to regprocedure (types only). Match the function by all
        // three parts instead.
        const args = parsed.args?.slice(1, -1) ?? '';
        const r = await run(
          `SELECT pg_get_functiondef(p.oid) FROM pg_proc p`
          + ` JOIN pg_namespace n ON n.oid = p.pronamespace`
          + ` WHERE n.nspname = ${sqlLiteral(parsed.schema!, 'postgres')}`
          + ` AND p.proname = ${sqlLiteral(parsed.name, 'postgres')}`
          + ` AND pg_get_function_identity_arguments(p.oid) = ${sqlLiteral(args, 'postgres')}`);
        return r.rows[0]?.[0] == null ? undefined : String(r.rows[0][0]);
      }
      const path = safePath([parsed.schema!, parsed.name], 'mysql');
      const show = o.kind === 'view' ? `SHOW CREATE VIEW ${path}`
        : o.kind === 'trigger' ? `SHOW CREATE TRIGGER ${path}`
        : o.kind === 'event' ? `SHOW CREATE EVENT ${path}`
        : `SHOW CREATE ${parsed.routineType === 'procedure' ? 'PROCEDURE' : 'FUNCTION'} ${path}`;
      const r = await run(show);
      // SHOW CREATE result sets put the statement in a column named
      // "Create …" — except SHOW CREATE TRIGGER, where it is "SQL Original
      // Statement". Position varies by kind and server version, so identify
      // by header, falling back to the one cell that starts with CREATE.
      const ci = r.columns.findIndex(c => /create|original statement/i.test(c.name));
      const row = r.rows[0];
      if (!row) return undefined;
      if (ci >= 0) return row[ci] == null ? undefined : String(row[ci]);
      const cell = row.find(v => v != null && /^\s*create\b/i.test(String(v)));
      return cell == null ? undefined : String(cell);
    } catch {
      // A definition that cannot be read is not dropped — the builder lists
      // the object as "recreate by hand" instead.
      return undefined;
    }
  }, [run]);

  const buildScript = useCallback(async () => {
    if (!canRename || !db || !table) return;
    const name = newName.trim();
    if (invalidNewName(name, column || table)) return;
    const re: RenameEngine = session.engine === 'postgres' ? 'postgres' : 'mysql';
    setRenameBusy(true);
    setError(null);
    try {
      const all = await fetchCorpus(db);
      const rep = findUsages(all, { table, column: column || undefined }, engine);
      setSources(all);
      setReport(rep);
      const certainById = new Map<string, number>();
      for (const u of rep.usages) {
        if (u.confidence === 'certain') {
          certainById.set(u.sourceId, (certainById.get(u.sourceId) ?? 0) + 1);
        }
      }
      const objects: RenameObject[] = await Promise.all(rep.hitSources.map(async (s) => ({
        ...s,
        createSql: certainById.has(s.id) && needsCreateSql(re, s.kind)
          ? await fetchCreateSql(s, re)
          : undefined,
      })));
      let serverVersion: string | undefined;
      if (re === 'mysql' && column) {
        // Gates RENAME COLUMN (MySQL 8.0 / MariaDB 10.5) — unknown means
        // supported, so a failed probe changes nothing.
        try {
          const v = await run('SELECT VERSION()');
          serverVersion = v.rows[0]?.[0] == null ? undefined : String(v.rows[0][0]);
        } catch { serverVersion = undefined; }
      }
      const built = buildRenameScript({
        engine: re, schema: db, table, column: column || undefined, newName: name,
        objects, searched: all.length, serverVersion,
      });
      if (!built) setError('That name cannot be used.');
      setRename(built);
      setCopied(false);
    } catch (e) {
      setError(errorDisplay(e));
      setRename(null);
    } finally {
      setRenameBusy(false);
    }
  }, [canRename, db, table, column, newName, session.engine, engine, fetchCorpus, fetchCreateSql, run]);

  const byId = useMemo(
    () => new Map((sources ?? []).map(s => [s.id, s])), [sources]);

  const shown = useMemo(
    () => (report?.usages ?? []).filter(u => RANK[u.confidence] >= RANK[minConfidence]),
    [report, minConfidence]);

  const what = column ? `${table}.${column}` : table;
  const nameIssue = invalidNewName(newName.trim(), column || table);

  return (
    <div className="proc-panel">
      <div className="proc-toolbar">
        <span className="proc-title">🔗 Find usages</span>
        <select value={db} onChange={e => { setDb(e.target.value); setRename(null); }}>
          {schemas.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        <select value={table} onChange={e => { setTable(e.target.value); setRename(null); }}>
          <option value="">— table —</option>
          {tables.map(t => <option key={t} value={t}>{t}</option>)}
        </select>
        <select value={column} disabled={!table}
          onChange={e => { setColumn(e.target.value); setRename(null); }}>
          <option value="">whole table</option>
          {columns.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
        <button className="toolbar-btn" onClick={() => void search()} disabled={!table || busy}>
          {busy ? 'Searching…' : 'Find'}
        </button>
        <button
          className={`toolbar-btn${renameBlocked ? ' unavail' : ''}${renameOpen ? ' toolbar-btn-on' : ''}`}
          aria-disabled={renameBlocked ? true : undefined}
          data-tip={renameBlocked ?? undefined}
          title={renameBlocked
            ?? 'Build a rename migration script for this table (or column) — reviewed in the editor, never run here'}
          onClick={() => {
            if (renameBlocked) return;
            setRenameOpen(o => !o);
          }}
        >✏ Rename…</button>
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

      {renameOpen && (
        <div className="fu-rename">
          <span className="fu-rename-what">rename <b>{what}</b> to</span>
          <input
            value={newName}
            placeholder="new name"
            onChange={e => { setNewName(e.target.value); setRename(null); }}
            onKeyDown={e => { if (e.key === 'Enter' && !nameIssue && !renameBusy) void buildScript(); }}
          />
          <button className="toolbar-btn" disabled={!table || !!nameIssue || renameBusy}
            onClick={() => void buildScript()}>
            {renameBusy ? 'Building…' : 'Build script'}
          </button>
          {newName && nameIssue && <span className="proc-err">{nameIssue}</span>}
          <span className="dv-desc">
            rewrites only certain references; likely/possible are listed, never touched
          </span>
        </div>
      )}

      {rename && (
        <div className="fu-rename-script">
          <div className="fu-rename-head">
            <span>
              {rename.recreated.length > 0
                ? `${rename.recreated.length} object${rename.recreated.length === 1 ? '' : 's'} dropped and recreated, `
                  + `${rename.review.length} left for review`
                : rename.review.length > 0
                ? `nothing recreated automatically — ${rename.review.length} item${rename.review.length === 1 ? '' : 's'} to review`
                : 'no dependents found — the rename stands alone'}
            </span>
            <div style={{ flex: 1 }} />
            <button className="toolbar-btn"
              onClick={() => window.dispatchEvent(new CustomEvent('dbgui:insert-sql', {
                detail: { sql: `\n${rename.script}\n` },
              }))}
              title="Open the script in an editor tab — review it, then run it there. Write guards and prod confirmations apply as usual."
            >Open in editor</button>
            <button className="toolbar-btn"
              onClick={() => {
                void navigator.clipboard.writeText(rename.script)
                  .then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); })
                  .catch(() => setError('Could not copy to the clipboard.'));
              }}
            >{copied ? 'Copied ✓' : 'Copy'}</button>
          </div>
          {rename.warnings.map((w, i) => (
            <div key={i} className="fu-rename-warning">⚠ {w}</div>
          ))}
          <pre className="seq-sql">{rename.script}</pre>
          {rename.review.length > 0 && (
            <div className="fu-rename-review">
              <div className="dv-desc">Not touched — review by hand:</div>
              {rename.review.map((r, i) => (
                <div key={i} className="fu-row">
                  <div className="fu-head">
                    {r.confidence && (
                      <span className={`fu-badge fu-badge-${r.confidence}`}>{r.confidence}</span>
                    )}
                    <span className="fu-kind">{KIND_LABEL[r.kind]}</span>
                    <span className="fu-label">{r.label}</span>
                    {r.line !== undefined && <span className="dv-desc">line {r.line}</span>}
                  </div>
                  {r.lineText && <pre className="fu-line">{r.lineText}</pre>}
                  <div className="fu-note">{r.message}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

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
