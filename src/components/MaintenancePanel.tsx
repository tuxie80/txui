/**
 * 🩹 Maintenance — table upkeep, and what a schema change quietly broke.
 *
 * Two halves that answer the same question: is this schema healthy?
 *
 * The design decision that matters is that the four maintenance operations are
 * **not equal buttons**. `ANALYZE` and `CHECK` are read-only. `OPTIMIZE` on
 * InnoDB rebuilds the table and holds a lock for the whole operation, and
 * `REPAIR` does nothing at all on InnoDB while being able to lose rows on
 * MyISAM. Presenting them as four identical buttons is how one of them gets
 * run on a production table by someone who assumed otherwise — so the
 * destructive ones are visually separate, carry their consequence inline, and
 * require a typed confirmation naming the tables.
 *
 * SQL building and the probes are in utils/tableMaintenance.
 */
import { errorDisplay } from '../utils/appError';
import { escapeLiteral } from '../utils/sqlIdent';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { QueryResult, Session } from '../types';
import { StatusIcon } from './StatusIcon';
import { isoNow, logAudit, newRunId } from '../utils/audit';
import {
  opsFor, findOp, maintenanceSql, invalidProbes, describeInvalid, invalidSummary,
  opSummary, opWarning, parseSamplePages, readOnlyProbeSql, readOnlyReason,
  statementSubject,
} from '../utils/tableMaintenance';
import type { AnalyzeOpts, MaintenanceOp, InvalidObject, TableRef } from '../utils/tableMaintenance';
import {
  analyzeDefinition, buildCatalog, catalogSql, reportSummary,
} from '../utils/brokenRefs';
import type { DefReport, RefCatalog } from '../utils/brokenRefs';
import { SchemaStore } from '../store/schema';
// The PostgreSQL vacuum advisor that used to live here (a tab of this panel)
// has moved: it is subsumed by the standalone 🧹 Vacuum & Bloat panel
// (components/VacuumBloatPanel.tsx), which is database-wide and executes.
import { sqliteMaintenanceActions, type SqliteMaintAction } from '../utils/sqliteMaintenance';
import { fmtDuration } from '../utils/fmtDuration';
import {
  fieldsFor, findField, planBulk, planWarning, suggestionsFor,
} from '../utils/bulkAlter';
import type { BulkField, BulkTable } from '../utils/bulkAlter';

interface Props {
  session: Session;
  schema: string | null;
  onClose: () => void;
}

interface OpResult {
  table: string;
  status: string;
  message: string;
  ok: boolean;
  /** Wall-clock stamp and duration, for the copyable run log. */
  ts?: string;
  ms?: number;
}

function stamp(): string {
  const d = new Date();
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

type MaintTab = 'upkeep' | 'bulk';

export function MaintenancePanel({ session, schema, onClose }: Props) {
  const [mode, setMode] = useState<MaintTab>('upkeep');
  const [meta, setMeta] = useState<BulkTable[]>([]);
  const [bulkField, setBulkField] = useState<BulkField>('comment');
  const [bulkValue, setBulkValue] = useState('');
  const [bulkConfirm, setBulkConfirm] = useState('');
  const [bulkResults, setBulkResults] = useState<OpResult[]>([]);
  const [bulkRunning, setBulkRunning] = useState(false);
  const [showSql, setShowSql] = useState(false);
  const [tables, setTables] = useState<string[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState('');
  const [op, setOp] = useState<MaintenanceOp>('analyze');
  const [results, setResults] = useState<OpResult[]>([]);
  const [running, setRunning] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [confirmText, setConfirmText] = useState('');
  // Live run progress: which statement of the queue is on the server right
  // now. Null when no run is in flight.
  const [progress, setProgress] = useState<{ done: number; total: number; subject: string } | null>(null);
  // The results list is pinned to its newest line while a run is in flight.
  const resultsListRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (running && resultsListRef.current) {
      resultsListRef.current.scrollTop = resultsListRef.current.scrollHeight;
    }
  }, [results.length, running]);
  // The Analyze op's dials (folded in from the standalone Analyze table
  // panel): LOCAL keeps the run out of the binlog, sample pages tune how much
  // of the table is read, FULLSCAN is SQL Server's "read every row".
  const [analyzeLocal, setAnalyzeLocal] = useState(true);
  const [samplePages, setSamplePages] = useState('');
  const [fullscan, setFullscan] = useState(false);
  const [copied, setCopied] = useState(false);
  const cancelledRef = useRef(false);
  const tokenRef = useRef(0);

  const [invalid, setInvalid] = useState<InvalidObject[] | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanErrors, setScanErrors] = useState<string[]>([]);

  // Per-finding drill-down: which table/column is gone and what it was
  // probably renamed to. The catalog sweeps (all schemas, two catalog reads)
  // are fetched once per session+schema and shared by every finding.
  const [diag, setDiag] = useState<Record<number, 'loading' | { error: string } | DefReport>>({});
  const catalogRef = useRef<{ key: string; catalog: RefCatalog } | null>(null);

  const ops = useMemo(() => opsFor(session.engine), [session.engine]);
  const bulkFields = useMemo(() => fieldsFor(session.engine), [session.engine]);
  const spec = findOp(op);
  const isProd = session.environment === 'prod';

  // A destructive operation on prod is exactly the case this panel exists to
  // make deliberate, so it is named and typed rather than clicked.
  const needsConfirm = !!spec?.destructive;
  const confirmWord = op.toUpperCase();
  const armed = !needsConfirm || confirmText.trim().toUpperCase() === confirmWord;

  useEffect(() => { setConfirmText(''); }, [op]);

  /**
   * Every statement this panel runs goes through here, so it reaches the audit
   * log.
   *
   * This panel is the one that rewrites tables — OPTIMIZE rebuilds and locks,
   * a bulk ALTER rewrites every row, and MySQL commits DDL implicitly so there
   * is nothing to undo. "Who ran OPTIMIZE on orders at 3am" is exactly the
   * question an audit log exists for, and until now it had no answer: panels
   * wrote to the session log only, which is memory and dies with the window.
   */
  const auditedRun = useCallback(async (
    sql: string, runId: string, index: number, total: number, token?: string,
  ): Promise<QueryResult> => {
    const startedAt = isoNow();
    const t0 = performance.now();
    const base = {
      run_id: runId,
      stmt_index: index, stmt_total: total,
      session_id: session.sessionId, tab_title: '🩹 Maintenance',
      database: schema ?? '', source: 'panel' as const,
      started_at: startedAt,
      connection_name: session.connectionName, db_user: '',
      engine: session.engine, sql,
    };
    try {
      // With a token the statement runs as a panel_query, which registers a
      // server-side kill handle — that is what the Cancel button kills.
      const res = token
        ? await invoke<QueryResult>('panel_query', { sessionId: session.sessionId, sql, token })
        : await invoke<QueryResult>('monitor_query', { sessionId: session.sessionId, sql });
      logAudit({ ...base, ended_at: isoNow(), duration_ms: Math.round(performance.now() - t0),
        ok: true, rows_out: res.rows.length,
        rows_affected: res.rows_affected === null ? null : Number(res.rows_affected),
        error: null });
      return res;
    } catch (e) {
      logAudit({ ...base, ended_at: isoNow(), duration_ms: Math.round(performance.now() - t0),
        ok: false, rows_out: 0, rows_affected: null, error: errorDisplay(e), raw_error: e });
      throw e;
    }
  }, [session.sessionId, session.connectionName, session.engine, schema]);

  const loadTables = useCallback(async () => {
    if (!schema) { setTables([]); return; }
    try {
      const lit = escapeLiteral(schema, session.engine);
      const sql = session.engine === 'sqlserver'
        // No comment, collation or row format to carry: the bulk editor has no
        // fields for SQL Server, so the list is the list. The row count comes
        // from partition stats, which is the same approximation MySQL's
        // TABLE_ROWS is and costs nothing.
        ? `SELECT t.name, '', '', '',
                  COALESCE((SELECT SUM(p.row_count) FROM sys.dm_db_partition_stats p
                            WHERE p.object_id = t.object_id AND p.index_id IN (0, 1)), 0), ''
           FROM sys.tables t
           JOIN sys.schemas s ON s.schema_id = t.schema_id
           WHERE s.name = '${lit}'
           ORDER BY 1`
        : session.engine === 'postgres'
        ? `SELECT tablename, '', '', '', 0 FROM pg_tables WHERE schemaname = '${lit}' ORDER BY 1`
        // Current values come with the list: the bulk plan needs them to skip
        // tables already at the target, and a no-op ALTER still rebuilds.
        : `SELECT TABLE_NAME, COALESCE(ENGINE,''), COALESCE(TABLE_COLLATION,''),
                  COALESCE(TABLE_COMMENT,''), COALESCE(TABLE_ROWS,0),
                  COALESCE(ROW_FORMAT,'')
           FROM information_schema.TABLES
           WHERE TABLE_SCHEMA = '${lit}' AND TABLE_TYPE = 'BASE TABLE'
           ORDER BY 1`;
      const res = await invoke<QueryResult>('monitor_query', {
        sessionId: session.sessionId, sql,
      });
      setTables(res.rows.map(r => String(r[0])));
      setMeta(res.rows.map(r => {
        const collation = String(r[2] ?? '');
        return {
          schema,
          name: String(r[0]),
          engine: String(r[1] ?? '') || undefined,
          collation: collation || undefined,
          // MySQL reports the collation, not the charset; the prefix is it.
          charset: collation ? collation.split('_')[0] : undefined,
          comment: String(r[3] ?? ''),
          rows: Number(r[4]) || 0,
          rowFormat: String(r[5] ?? '') || undefined,
        };
      }));
    } catch {
      setTables([]);
      setMeta([]);
    }
  }, [schema, session.sessionId, session.engine]);

  useEffect(() => { void loadTables(); }, [loadTables]);

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return q ? tables.filter(t => t.toLowerCase().includes(q)) : tables;
  }, [tables, filter]);

  /**
   * The Analyze op's options, fed to both the preview and the run so what is
   * shown is what executes. An invalid sample-pages field yields no pages
   * here — the run validates separately and refuses with the field named.
   */
  const analyzeOpts = useMemo<AnalyzeOpts | undefined>(() => {
    if (op !== 'analyze') return undefined;
    const pages = parseSamplePages(samplePages);
    return {
      local: analyzeLocal,
      samplePages: pages === 'invalid' ? undefined : pages,
      fullscan,
    };
  }, [op, analyzeLocal, samplePages, fullscan]);

  // Every maintenance statement is shown before it runs — the same review-first
  // rule the bulk editor follows. For prewarm this is the whole feature: the
  // exact read-only SQL is generated for the picked tables and put on screen so
  // it can be checked (and copied) before a single row is read.
  const previewSql = useMemo(() => {
    if (!schema || picked.size === 0) return [];
    const refs: TableRef[] = [...picked].map(name => ({ schema, name }));
    return maintenanceSql(op, refs, session.engine, analyzeOpts);
  }, [schema, picked, op, session.engine, analyzeOpts]);

  const run = useCallback(async () => {
    if (!schema || picked.size === 0 || !armed) return;
    if (op === 'analyze') {
      if (parseSamplePages(samplePages) === 'invalid') {
        setResults([{ table: '—', status: 'error', ok: false,
          message: 'Sample pages must be a positive integer.' }]);
        return;
      }
      // ANALYZE is not in the write guard's keyword list, so the connection's
      // read-only flag is checked here rather than left to the server.
      if (session.readOnly) {
        setResults([{ table: '—', status: 'blocked', ok: false,
          message: 'This connection is marked read-only — ANALYZE cannot run here.' }]);
        return;
      }
    }
    const refs: TableRef[] = [...picked].map(name => ({ schema, name }));
    const statements = maintenanceSql(op, refs, session.engine, analyzeOpts);
    if (statements.length === 0) return;

    setRunning(true);
    setResults([]);
    setCopied(false);
    cancelledRef.current = false;

    // Pre-flight: don't hammer a read-only replica with N doomed statements —
    // MySQL answers each with error 1290 and the log says nothing useful.
    if (op === 'analyze') {
      const probe = readOnlyProbeSql(session.engine);
      if (probe) {
        try {
          const res = await invoke<QueryResult>('monitor_query', { sessionId: session.sessionId, sql: probe });
          const reason = res.rows[0] ? readOnlyReason(session.engine, res.rows[0]) : null;
          if (reason) {
            setResults([{ table: '—', status: 'blocked', ok: false,
              message: `This server is read-only (${reason}); ANALYZE cannot run here. Point at the primary/writer.` }]);
            setRunning(false);
            return;
          }
        } catch {
          // If the probe itself fails we proceed and let ANALYZE surface the real error.
        }
      }
    }

    const t0 = performance.now();
    const runId = newRunId();
    for (const [i, sql] of statements.entries()) {
      if (cancelledRef.current) {
        setResults(prev => [...prev, {
          ts: stamp(), table: '—', status: 'cancelled', ok: false,
          message: `cancelled; ${statements.length - i} statement(s) skipped`,
        }]);
        break;
      }
      setProgress({ done: i, total: statements.length, subject: statementSubject(sql) });
      const token = String(++tokenRef.current);
      const s0 = performance.now();
      try {
        const res = await auditedRun(sql, runId, i + 1, statements.length, token);
        const ms = Math.round(performance.now() - s0);
        if (res.rows.length === 0) {
          // PostgreSQL's ANALYZE returns nothing; silence is success.
          setResults(prev => [...prev, {
            ts: stamp(), ms, table: sql.replace(/^\w+\s+/, ''), status: 'ok', message: 'done', ok: true,
          }]);
        }
        // MySQL returns Table / Op / Msg_type / Msg_text.
        for (const r of res.rows) {
          const [table, , msgType, msgText] = r.map(v => String(v ?? ''));
          const status = msgType || 'status';
          setResults(prev => [...prev, {
            ts: stamp(), ms, table, status, message: msgText || '',
            ok: !/error|corrupt/i.test(status) && !/error|corrupt/i.test(msgText ?? ''),
          }]);
        }
      } catch (e) {
        setResults(prev => [...prev, {
          ts: stamp(), table: '—', status: 'error', message: errorDisplay(e), ok: false,
        }]);
      }
      setElapsed(Math.round(performance.now() - t0));
    }
    setProgress(null);
    setRunning(false);
    setConfirmText('');
  }, [schema, picked, op, session, armed, auditedRun, analyzeOpts, samplePages]);

  /** Abort the in-flight statement (KILL QUERY / pg_cancel_backend) and stop the queue. */
  const cancel = useCallback(() => {
    cancelledRef.current = true;
    invoke('cancel_panel_query', { sessionId: session.sessionId, token: String(tokenRef.current) }).catch(() => {});
  }, [session.sessionId]);

  /** The run as a timestamped text log — the artefact that goes into a ticket. */
  function copyLog() {
    const head = `# ${spec?.label ?? op} — ${session.engine} · schema ${schema ?? ''}`;
    const lines = results.map(r =>
      `[${r.ts ?? ''}] ${r.ok ? 'OK ' : 'ERR'} ${r.table} · ${r.status}`
      + `${r.message ? ` · ${r.message.replace(/\s+/g, ' ').trim()}` : ''}`
      + `${r.ms != null ? ` · ${r.ms} ms` : ''}`);
    navigator.clipboard.writeText([head, ...lines].join('\n') + '\n').then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    }).catch(() => {});
  }

  const scan = useCallback(async () => {
    if (!schema) return;
    setScanning(true);
    setInvalid(null);
    setScanErrors([]);
    setDiag({});
    const found: InvalidObject[] = [];
    for (const probe of invalidProbes(session.engine, schema)) {
      try {
        const res = await invoke<QueryResult>('monitor_query', {
          sessionId: session.sessionId, sql: probe.sql,
        });
        for (const r of res.rows) {
          found.push(describeInvalid(probe, r.map(v => String(v ?? ''))));
        }
      } catch (e) {
        // A probe the server rejects (a version without that catalog view) must
        // not stop the others — but it also must not look like a clean result.
        setScanErrors(prev => [...prev, `${probe.label}: ${errorDisplay(e)}`]);
      }
    }
    setInvalid(found);
    setScanning(false);
  }, [schema, session]);

  /**
   * The drill-down behind a broken view: fetch its definition, extract every
   * table and column it references, and check each against the live catalog
   * (utils/brokenRefs). When nothing is missing the finding says so — the
   * remaining cause in the server's message is the definer's rights.
   */
  const diagnoseFinding = useCallback(async (index: number, o: InvalidObject) => {
    if (!schema) return;
    setDiag(prev => ({ ...prev, [index]: 'loading' }));
    try {
      const key = `${session.sessionId}|${schema}`;
      let catalog = catalogRef.current?.key === key ? catalogRef.current.catalog : null;
      if (!catalog) {
        const qs = catalogSql(session.engine);
        if (!qs) throw new Error('No catalog sweep for this engine.');
        const [objs, cols] = await Promise.all([
          invoke<QueryResult>('monitor_query', { sessionId: session.sessionId, sql: qs.objects }),
          invoke<QueryResult>('monitor_query', { sessionId: session.sessionId, sql: qs.columns }),
        ]);
        catalog = buildCatalog(objs.rows, cols.rows);
        catalogRef.current = { key, catalog };
      }

      // The definition: get_ddl everywhere except SQL Server, where
      // sys.sql_modules covers views AND the procedures/functions the probe
      // lumps under the same finding kind (get_ddl would name only views).
      let def: string;
      if (session.engine === 'sqlserver') {
        const sch = escapeLiteral(o.schema, session.engine);
        const nm = escapeLiteral(o.name, session.engine);
        const res = await invoke<QueryResult>('monitor_query', {
          sessionId: session.sessionId,
          sql: `SELECT m.definition FROM sys.sql_modules m
JOIN sys.objects o ON o.object_id = m.object_id
JOIN sys.schemas s ON s.schema_id = o.schema_id
WHERE s.name = '${sch}' AND o.name = '${nm}'`,
        });
        def = String(res.rows[0]?.[0] ?? '');
        if (!def) throw new Error('Definition unavailable — the object may be encrypted (WITH ENCRYPTION).');
      } else {
        def = await SchemaStore.getDdl(session.sessionId, `${o.schema}.${o.name}`);
      }
      setDiag(prev => ({ ...prev, [index]: analyzeDefinition(def, catalog!, session.engine) }));
    } catch (e) {
      setDiag(prev => ({ ...prev, [index]: { error: errorDisplay(e) } }));
    }
  }, [schema, session]);

  const bulkSpec = findField(bulkField);
  const bulkPlan = useMemo(
    () => planBulk(meta.filter(m => picked.has(m.name)), { field: bulkField, value: bulkValue }),
    [meta, picked, bulkField, bulkValue]);
  const bulkWarn = planWarning(bulkPlan, bulkSpec);
  const bulkArmed = bulkValue.trim().length > 0
    && bulkPlan.alters.length > 0
    && (!bulkPlan.rebuilds || bulkConfirm.trim().toUpperCase() === 'REBUILD');

  useEffect(() => { setBulkConfirm(''); }, [bulkField, bulkValue]);

  const runBulk = useCallback(async () => {
    if (!bulkArmed) return;
    setBulkRunning(true);
    setBulkResults([]);
    const runId = newRunId();
    for (const [i, a] of bulkPlan.alters.entries()) {
      try {
        await auditedRun(a.sql, runId, i + 1, bulkPlan.alters.length);
        setBulkResults(prev => [...prev, {
          table: a.name, status: 'ok', message: 'altered', ok: true,
        }]);
      } catch (e) {
        // Keep going: DDL already committed for the earlier tables, so stopping
        // here would leave the schema half-changed with no record of where.
        setBulkResults(prev => [...prev, {
          table: a.name, status: 'error', message: errorDisplay(e), ok: false,
        }]);
      }
    }
    setBulkRunning(false);
    setBulkConfirm('');
    await loadTables();
  }, [bulkArmed, bulkPlan, loadTables, auditedRun]);

  const toggle = (t: string) => setPicked(p => {
    const n = new Set(p);
    if (n.has(t)) n.delete(t); else n.add(t);
    return n;
  });

  // ── SQLite: database-level maintenance ──────────────────────────────────────
  // SQLite maintenance is whole-file (VACUUM, integrity), not per-table, so it
  // gets its own compact view rather than the table-selection UI above.
  const [sqliteResults, setSqliteResults] = useState<Record<string, { ok: boolean; text: string }>>({});
  const [sqliteRunning, setSqliteRunning] = useState<string | null>(null);
  const [autoVacIncr, setAutoVacIncr] = useState(false);

  useEffect(() => {
    if (session.engine !== 'sqlite') return;
    invoke<QueryResult>('monitor_query', { sessionId: session.sessionId, sql: 'PRAGMA auto_vacuum' })
      .then(r => setAutoVacIncr(Number(r.rows[0]?.[0]) === 2))
      .catch(() => {});
  }, [session.sessionId, session.engine]);

  const runSqliteAction = useCallback(async (act: SqliteMaintAction) => {
    setSqliteRunning(act.id);
    try {
      const res = await auditedRun(act.sql, newRunId(), 0, 1);
      const text = res.rows.length
        ? res.rows.slice(0, 50).map(r => r.map(c => (c === null ? '' : String(c))).join('  ')).join('\n')
        : 'done';
      setSqliteResults(m => ({ ...m, [act.id]: { ok: true, text } }));
    } catch (e) {
      setSqliteResults(m => ({ ...m, [act.id]: { ok: false, text: errorDisplay(e) } }));
    } finally {
      setSqliteRunning(null);
    }
  }, [auditedRun]);

  if (session.engine === 'sqlite') {
    const actions = sqliteMaintenanceActions({ hasWal: true, autoVacuumIncremental: autoVacIncr });
    return (
      <div className="mnt">
        <div className="panel-header">
          <span className="panel-title">🩹 Maintenance</span>
          <span className="mnt-schema">{session.filePath ?? 'SQLite'}</span>
          <div style={{ flex: 1 }} />
          <button className="icon-btn" onClick={onClose} title="Close">×</button>
        </div>
        <div className="mnt-note">
          Database-level maintenance for this SQLite file. Each action runs the exact statement
          shown; the checks are read-only.
        </div>
        <div className="sqlite-maint">
          {actions.map(act => {
            const r = sqliteResults[act.id];
            return (
              <div key={act.id} className="sqlite-maint-row">
                <div className="sm-head">
                  <span className="sm-label">{act.label}</span>
                  <span className={`sm-impact sm-impact-${act.impact}`}>{act.impactLabel}</span>
                  <div style={{ flex: 1 }} />
                  <button className={act.impact === 'rewrite' ? 'toolbar-btn mnt-danger' : 'primary'}
                    disabled={sqliteRunning === act.id}
                    onClick={() => runSqliteAction(act)}>
                    {sqliteRunning === act.id ? 'Running…' : 'Run'}
                  </button>
                </div>
                <div className="sm-detail">{act.detail}</div>
                <code className="sm-sql">{act.sql}</code>
                {r && <pre className={`sm-result ${r.ok ? 'ok' : 'err'}`}>{r.text}</pre>}
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <div className="mnt">
      <div className="panel-header">
        <span className="panel-title">🩹 Maintenance</span>
        {schema && <span className="mnt-schema">{schema}</span>}
        {isProd && <span className="mnt-prod">prod</span>}
        <div style={{ flex: 1 }} />
        <button className="icon-btn" onClick={onClose} title="Close">×</button>
      </div>

      {!schema && <div className="mnt-note">Select a database first.</div>}

      {/* The bulk editor is only as real as the fields it can offer; with none
          it is an empty tab that reads as a broken feature, and a lone tab is
          not a choice — so the whole bar goes with it. */}
      {bulkFields.length > 0 && (
        <div className="mnt-tabs" role="tablist">
          <button role="tab" aria-selected={mode === 'upkeep'}
                  className={`mnt-tab${mode === 'upkeep' ? ' active' : ''}`}
                  onClick={() => setMode('upkeep')}>Upkeep &amp; invalid objects</button>
          <button role="tab" aria-selected={mode === 'bulk'}
                  className={`mnt-tab${mode === 'bulk' ? ' active' : ''}`}
                  onClick={() => setMode('bulk')}>Bulk edit</button>
        </div>
      )}

      <div className="mnt-body">
        <aside className="mnt-tables">
          <div className="mnt-tables-head">
            <input className="mnt-filter" placeholder="Filter tables…" value={filter}
                   spellCheck={false} onChange={e => setFilter(e.target.value)} />
          </div>
          <div className="mnt-pickall">
            <button className="dbs-link" onClick={() => setPicked(new Set(shown))}>all</button>
            <button className="dbs-link" onClick={() => setPicked(new Set())}>none</button>
            <span className="mnt-count">{picked.size} selected</span>
          </div>
          <div className="mnt-list">
            {shown.map(t => (
              <label key={t} className="mnt-table">
                <input type="checkbox" checked={picked.has(t)} onChange={() => toggle(t)} />
                <span>{t}</span>
              </label>
            ))}
            {shown.length === 0 && <div className="mnt-empty">No tables.</div>}
          </div>
        </aside>

        <section className="mnt-main">
          {mode === 'bulk' && bulkFields.length > 0 ? (
            <BulkEditor
              engine={session.engine}
              field={bulkField} setField={setBulkField}
              value={bulkValue} setValue={setBulkValue}
              plan={bulkPlan} warn={bulkWarn} spec={bulkSpec}
              confirm={bulkConfirm} setConfirm={setBulkConfirm}
              armed={bulkArmed} running={bulkRunning} onRun={runBulk}
              results={bulkResults}
              showSql={showSql} setShowSql={setShowSql}
            />
          ) : (<>
          <div className="mnt-ops">
            {ops.map(o => (
              <button
                key={o.id}
                className={`mnt-op${op === o.id ? ' active' : ''}${o.destructive ? ' danger' : ''}`}
                onClick={() => setOp(o.id)}
              >
                {o.label}
                <em>{opSummary(o, session.engine)}</em>
              </button>
            ))}
            {ops.length === 0 && (
              <div className="mnt-empty">
                This engine has no table maintenance statements.
              </div>
            )}
          </div>

          {spec && opWarning(spec, session.engine) && (
            <div className="mnt-warn">
              <StatusIcon kind="error" /> <b>{spec.label}</b> {opWarning(spec, session.engine)}
            </div>
          )}

          {op === 'analyze' && session.engine === 'mysql' && (
            <div className="mnt-opts">
              <label className="gsp-check" title="ANALYZE LOCAL TABLE — no binary-logging (won't replicate)">
                <input type="checkbox" checked={analyzeLocal}
                       onChange={e => setAnalyzeLocal(e.target.checked)} disabled={running} />
                LOCAL (no binlog)
              </label>
              <label className="dg-field-inline" title="ALTER TABLE … STATS_SAMPLE_PAGES=N before ANALYZE (leave empty to keep current)">
                <span>Sample pages</span>
                <input
                  type="number" min={1} placeholder="default"
                  value={samplePages}
                  onChange={e => setSamplePages(e.target.value)}
                  disabled={running}
                  style={{ width: 90 }}
                />
              </label>
            </div>
          )}
          {op === 'analyze' && session.engine === 'sqlserver' && (
            <div className="mnt-opts">
              <label
                className="gsp-check"
                title="UPDATE STATISTICS … WITH FULLSCAN — read every row instead of sampling. Accurate, but a full scan of each table."
              >
                <input type="checkbox" checked={fullscan}
                       onChange={e => setFullscan(e.target.checked)} disabled={running} />
                FULLSCAN
              </label>
            </div>
          )}

          {previewSql.length > 0 && (
            <div className="mnt-bulk-plan">
              <b>{previewSql.length}</b> statement{previewSql.length === 1 ? '' : 's'}
              {' '}for <b>{picked.size}</b> table{picked.size === 1 ? '' : 's'}
              <div style={{ flex: 1 }} />
              <button className="dbs-link" onClick={() => setShowSql(!showSql)}>
                {showSql ? 'hide' : 'show'} SQL
              </button>
            </div>
          )}

          {showSql && previewSql.length > 0 && (
            <pre className="mnt-bulk-sql">
              {previewSql.map(s => s + ';').join('\n')}
            </pre>
          )}

          <div className="mnt-run">
            {needsConfirm && (
              <label className="mnt-confirm">
                <span>Type <b>{confirmWord}</b> to enable</span>
                <input value={confirmText} spellCheck={false}
                       onChange={e => setConfirmText(e.target.value)} />
              </label>
            )}
            <div style={{ flex: 1 }} />
            {running && (
              <button className="toolbar-btn mnt-danger" onClick={cancel}
                      title="Cancel the running statement and stop the queue">
                ■ Cancel
              </button>
            )}
            <button
              className={spec?.destructive ? 'toolbar-btn mnt-danger' : 'primary'}
              disabled={running || picked.size === 0 || !armed || ops.length === 0}
              onClick={run}
            >
              {running ? 'Running…'
                : `${spec?.label ?? 'Run'} ${picked.size} table${picked.size === 1 ? '' : 's'}`}
            </button>
          </div>

          {(results.length > 0 || progress) && (
            <div className="mnt-results">
              <div className="mnt-results-head">
                {results.filter(r => r.ok).length} ok
                {results.some(r => !r.ok) && ` · ${results.filter(r => !r.ok).length} problem`}
                {elapsed > 0 && ` · ${fmtDuration(elapsed)}`}
                <div style={{ flex: 1 }} />
                <button className="dbs-link" onClick={copyLog}
                        title="Copy the run as a timestamped log">
                  {copied ? '✓ copied' : 'copy log'}
                </button>
              </div>
              {progress && (
                <div className="mnt-progress">
                  <b>{progress.done + 1} / {progress.total}</b>
                  <span className="mnt-result-msg">{progress.subject}</span>
                  <span>running…</span>
                </div>
              )}
              <div className="mnt-results-list" ref={resultsListRef}>
                {results.map((r, i) => (
                  <div key={i} className={`mnt-result${r.ok ? '' : ' bad'}`}
                       title={r.ts ? `finished ${r.ts}` : undefined}>
                    <StatusIcon kind={r.ok ? 'ok' : 'error'} />
                    <span className="mnt-result-table">{r.table}</span>
                    <span className="mnt-result-status">{r.status}</span>
                    <span className="mnt-result-ms">{r.ms != null ? fmtDuration(r.ms) : ''}</span>
                    <span className="mnt-result-msg">{r.message}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="mnt-invalid">
            <div className="mnt-invalid-head">
              <b>Invalid objects</b>
              <span className="mnt-muted">
                what a DROP left behind — none of these fail until something runs them
              </span>
              <div style={{ flex: 1 }} />
              <button className="toolbar-btn" onClick={scan} disabled={scanning || !schema}>
                {scanning ? 'Scanning…' : 'Scan'}
              </button>
            </div>

            {scanErrors.length > 0 && (
              <div className="mnt-scan-err">
                {scanErrors.map((e, i) => (
                  <div key={i}><StatusIcon kind="error" /> {e}</div>
                ))}
                <div className="mnt-muted">
                  A probe that could not run is not a clean result — treat the scan
                  below as partial.
                </div>
              </div>
            )}

            {invalid && (
              <div className="mnt-invalid-list">
                <div className={`mnt-invalid-sum${invalid.length ? ' bad' : ''}`}>
                  <StatusIcon kind={invalid.length ? 'error' : 'ok'} />
                  {invalidSummary(invalid)}
                </div>
                {invalid.map((o, i) => (
                  <div key={i} className="mnt-bad-obj">
                    <div className="mnt-bad-head">
                      <span className="mnt-bad-kind">{o.kind}</span>
                      <span className="mnt-bad-name">{o.schema}.{o.name}</span>
                      {o.kind === 'view' && catalogSql(session.engine) && (
                        <>
                          <div style={{ flex: 1 }} />
                          <button className="dbs-link" disabled={diag[i] === 'loading'}
                                  onClick={() => void diagnoseFinding(i, o)}>
                            {diag[i] === 'loading' ? 'diagnosing…' : 'What broke?'}
                          </button>
                        </>
                      )}
                    </div>
                    <p>{o.problem}</p>
                    <p className="mnt-bad-action">{o.action}</p>
                    {diag[i] && diag[i] !== 'loading' && <BrokenRefs state={diag[i]} />}
                  </div>
                ))}
              </div>
            )}
          </div>
          </>)}
        </section>
      </div>
    </div>
  );
}

/**
 * The bulk editor.
 *
 * Every generated statement is shown before anything runs. That is the whole
 * safety story for an operation that rewrites tables and cannot be rolled
 * back: not a confirmation dialog, but the exact SQL, in order, with the
 * tables it will skip and why.
 */
function BulkEditor(props: {
  engine: string;
  field: BulkField; setField: (f: BulkField) => void;
  value: string; setValue: (v: string) => void;
  plan: ReturnType<typeof planBulk>;
  warn: string | null;
  spec: ReturnType<typeof findField>;
  confirm: string; setConfirm: (v: string) => void;
  armed: boolean; running: boolean; onRun: () => void;
  results: OpResult[];
  showSql: boolean; setShowSql: (v: boolean) => void;
}) {
  const {
    engine, field, setField, value, setValue, plan, warn, spec,
    confirm, setConfirm, armed, running, onRun, results, showSql, setShowSql,
  } = props;
  const fields = fieldsFor(engine);
  const suggestions = suggestionsFor(field);

  if (fields.length === 0) {
    return (
      <div className="mnt-empty">
        Bulk table properties are a MySQL concept — PostgreSQL has no per-table
        engine or collation to change this way.
      </div>
    );
  }

  return (
    <div className="mnt-bulk">
      <div className="mnt-bulk-row">
        <label className="mnt-bulk-field">
          <span>Change</span>
          <select value={field} onChange={e => setField(e.target.value as BulkField)}>
            {fields.map(f => <option key={f.id} value={f.id}>{f.label}</option>)}
          </select>
        </label>
        <label className="mnt-bulk-field mnt-bulk-value">
          <span>To</span>
          <input
            value={value}
            list={suggestions.length ? `bulk-${field}` : undefined}
            placeholder={field === 'comment' ? 'table comment…' : 'value…'}
            spellCheck={false}
            onChange={e => setValue(e.target.value)}
          />
          {suggestions.length > 0 && (
            <datalist id={`bulk-${field}`}>
              {suggestions.map(v => <option key={v} value={v} />)}
            </datalist>
          )}
        </label>
      </div>

      {spec && (
        <div className={`mnt-bulk-cost c-${spec.cost}`}>
          <StatusIcon kind={spec.cost === 'rebuild' ? 'error' : 'ok'} />
          <span>{spec.effect}</span>
        </div>
      )}

      <div className="mnt-bulk-plan">
        <b>{plan.alters.length}</b> table{plan.alters.length === 1 ? '' : 's'} will change
        {plan.skipped.length > 0 && (
          <span className="mnt-muted">
            {' · '}{plan.skipped.length} already at that value, skipped
            {' — a no-op ALTER still rebuilds, so they are left alone'}
          </span>
        )}
        <div style={{ flex: 1 }} />
        <button className="dbs-link" onClick={() => setShowSql(!showSql)}>
          {showSql ? 'hide' : 'show'} SQL
        </button>
      </div>

      {showSql && plan.alters.length > 0 && (
        <pre className="mnt-bulk-sql">
          {plan.alters.map(a => a.sql + ';').join('\n')}
        </pre>
      )}

      {warn && (
        <div className="mnt-warn">
          <StatusIcon kind="error" /> <span>{warn}</span>
        </div>
      )}

      <div className="mnt-run">
        {plan.rebuilds && plan.alters.length > 0 && (
          <label className="mnt-confirm">
            <span>Type <b>REBUILD</b> to enable</span>
            <input value={confirm} spellCheck={false}
                   onChange={e => setConfirm(e.target.value)} />
          </label>
        )}
        <div style={{ flex: 1 }} />
        <button
          className={plan.rebuilds ? 'toolbar-btn mnt-danger' : 'primary'}
          disabled={!armed || running}
          onClick={onRun}
        >
          {running ? 'Altering…' : `Alter ${plan.alters.length} table${plan.alters.length === 1 ? '' : 's'}`}
        </button>
      </div>

      {results.length > 0 && (
        <div className="mnt-results">
          <div className="mnt-results-head">
            {results.filter(r => r.ok).length} ok
            {results.some(r => !r.ok) && ` · ${results.filter(r => !r.ok).length} failed`}
          </div>
          {results.map((r, i) => (
            <div key={i} className={`mnt-result${r.ok ? '' : ' bad'}`}>
              <StatusIcon kind={r.ok ? 'ok' : 'error'} />
              <span className="mnt-result-table">{r.table}</span>
              <span className="mnt-result-msg">{r.message}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * The drill-down result under a broken view: exactly which references are
 * gone, each with what it was probably renamed to. An empty report is a
 * verdict too — the references all resolve, so the definer's rights are the
 * breakage (the other half of the server's message).
 */
function BrokenRefs({ state }: { state: { error: string } | DefReport }) {
  if ('error' in state) {
    return <p className="mnt-diag-err">Diagnosis failed: {state.error}</p>;
  }
  return (
    <div className="mnt-diag">
      <div className="mnt-diag-sum">{reportSummary(state)}</div>
      {state.broken.map((r, j) => (
        <div key={j} className="mnt-diag-ref">
          {r.kind === 'table'
            ? <>missing table <code>{r.name}</code></>
            : <>missing column <code>{r.table ? `${r.table}.` : ''}{r.name}</code></>}
          {r.suggestions.length > 0 && (
            <span className="mnt-diag-sug">
              {' '}— renamed to{' '}
              {r.suggestions.map((s, k) => (
                <span key={s}>{k > 0 && ' or '}<code>{s}</code></span>
              ))}?
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

