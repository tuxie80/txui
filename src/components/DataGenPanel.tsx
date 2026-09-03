/**
 * Data generator wizard — 3 steps, no surprises:
 *   1. Target   — a WHOLE database from a schema kit (tables + FKs + indexes
 *                 + referential data, scale knob), an existing table
 *                 (columns loaded + generators auto-suggested), or a new
 *                 table designed inline
 *   2. Generators / kit sizing — per-column generator+params, or per-table
 *                 row counts for a kit
 *   3. Preview & Run — sample rows / full DDL + exact SQL, then chunked
 *                 streamed execution with a progress bar
 */
import { errorDisplay } from '../utils/appError';
import { confirmDialog } from '../utils/appDialog';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke, Channel } from '@tauri-apps/api/core';
import type { TableMeta } from '../types/browser';
import type { QueryResult } from '../types';
import {
  GENERATORS, GENERATOR_MAP, DEFAULT_PARAMS, suggestGenerator,
  buildInserts, buildCreateTable, quoteIdent,
} from '../utils/datagen';
import { CHART_PRESETS, presetParams } from '../utils/chartPresets';
import type { ColumnSpec } from '../utils/datagen';
import { LOCALES } from '../data/dictionaries';
import {
  SCHEMA_KITS, resolveRowCounts, totalRows,
  buildKitPreDdl, buildKitTableDdl, kitTableSpecs,
} from '../utils/schemaKits';
import { isoNow, logAudit } from '../utils/audit';
import {
  SIZINGS, buildServerPlan, estimateBytes, formatBytes, shouldUseServer,
} from '../utils/datagenSql';
import { clearTabActivities, panelTabKey, setActivity } from '../store/tabActivity';
import { FastGrid } from './FastGrid';

/**
 * The generator picker, grouped.
 *
 * Built once at module load: the catalogue is static, and rebuilding it per
 * render of a panel that can list dozens of columns is pure work.
 */
const GENERATOR_GROUPS: [string, typeof GENERATORS][] = (() => {
  const by = new Map<string, typeof GENERATORS>();
  for (const g of GENERATORS) {
    const list = by.get(g.group) ?? [];
    list.push(g);
    by.set(g.group, list);
  }
  return [...by.entries()];
})();

type GenEvent =
  | { type: 'progress'; rows_done: number; rows_total: number; rows_per_sec: number }
  | { type: 'done'; rows: number; ms: number; cancelled: boolean };

type DbGenEvent =
  | { type: 'table'; index: number; count: number; label: string }
  | { type: 'progress'; label: string; rows_done: number; rows_total: number;
      total_done: number; total_rows: number; rows_per_sec: number }
  | { type: 'done'; rows: number; tables: number; ms: number; cancelled: boolean };

const SCALES = [
  { label: '0.1×', value: 0.1 },
  { label: '0.5×', value: 0.5 },
  { label: '1×', value: 1 },
  { label: '5×', value: 5 },
  { label: '10×', value: 10 },
  { label: '50×', value: 50 },
];

interface Props {
  sessionId: string;
  engine: string;
  environment?: string | null;
  readOnly?: boolean;
  connectionName?: string;        // audit-log attribution
  /** The database/schema the editor is currently in — the default target. */
  schema?: string | null;
  onClose: () => void;
  onSchemaChanged?: () => void;   // refresh schema tree after CREATE TABLE
}

interface NewCol { name: string; typeName: string; pk: boolean; nullable: boolean }

const TYPE_OPTIONS = [
  'INT', 'BIGINT', 'VARCHAR(100)', 'VARCHAR(255)', 'TEXT',
  'DECIMAL(10,2)', 'DATE', 'TIMESTAMP', 'BOOLEAN', 'CHAR(36)', 'JSON',
];

const DEFAULT_NEW_COLS: NewCol[] = [
  { name: 'id',         typeName: 'INT',          pk: true,  nullable: false },
  { name: 'name',       typeName: 'VARCHAR(100)', pk: false, nullable: false },
  { name: 'email',      typeName: 'VARCHAR(255)', pk: false, nullable: true },
  { name: 'created_at', typeName: 'TIMESTAMP',    pk: false, nullable: false },
];

// Generation is a chunked Rust stream (commands/datagen.rs) — the UI never
// holds rows, so the cap is about DB patience, not browser memory.
/**
 * The ceiling for the row-by-row path, which builds and binds every value.
 * Ten million is minutes; a hundred million would be an hour of the wrong
 * algorithm.
 */
const MAX_ROWS_ROW_BY_ROW = 10_000_000;
/** The ceiling overall — the server path reaches the top of the ladder. */
const MAX_ROWS = 1_000_000_000;

export function DataGenPanel({ sessionId, engine, environment, readOnly, connectionName, schema, onClose, onSchemaChanged }: Props) {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [mode, setMode] = useState<'database' | 'existing' | 'new'>('database');
  const [tableName, setTableName] = useState('');
  // Target database/schema for the existing/new table modes. The generator
  // writes on its OWN pooled connection, which never ran the editor's `USE`,
  // so an unqualified table hits "1046 No database selected" (MySQL) or the
  // wrong search_path (PG). Qualifying the table with an explicitly chosen
  // database makes the run independent of whatever the rest of the tabs did.
  const [targetDb, setTargetDb] = useState(schema ?? '');
  const [availableDbs, setAvailableDbs] = useState<string[]>([]);
  // Whole-database (schema kit) mode
  const [kitId, setKitId] = useState(SCHEMA_KITS[0].id);
  const [dbName, setDbName] = useState(SCHEMA_KITS[0].defaultName);
  const [scale, setScale] = useState(1);
  const [kitCounts, setKitCounts] = useState<Record<string, number>>({});
  const [dbProgress, setDbProgress] = useState<{
    label: string; tableIdx: number; tableCount: number;
    done: number; total: number; totalDone: number; totalRows: number; rps: number;
  } | null>(null);
  const [newCols, setNewCols] = useState<NewCol[]>(DEFAULT_NEW_COLS);
  const [specs, setSpecs] = useState<ColumnSpec[]>([]);
  const [rowCount, setRowCount] = useState(1000);
  const [seed, setSeed] = useState(() => Math.floor(Math.random() * 1e9));
  // Global run locale: the dictionary pack every name/place/company column
  // draws from. `default` keeps the original mixed corpus (and byte-identical
  // output); the packs give a coherent Czech / British / Japanese dataset.
  const [locale, setLocale] = useState('default');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number; rps: number } | null>(null);
  const [summary, setSummary] = useState<string | null>(null);
  // Where sequences start: MAX(pk)+1 for existing tables (resolved on step 3)
  const [seqStart, setSeqStart] = useState(1);
  const [previewRows, setPreviewRows] = useState<unknown[][] | null>(null);
  // Generation runs in the backend and keeps going without this panel, so the
  // close-guard has to know about it (and how to cancel it).
  const activityKey = panelTabKey(sessionId, 'datagen');
  useEffect(() => {
    if (!loading) { clearTabActivities(activityKey); return; }
    setActivity(activityKey, {
      id: 'generate',
      label: 'Generating data',
      detail: progress
        ? `${progress.done.toLocaleString()} / ${progress.total.toLocaleString()} rows inserted`
        : 'insert stream running',
      survives: true,
      kill: () => { if (runKeyRef.current) invoke('cancel_datagen', { runKey: runKeyRef.current }).catch(() => {}); },
    });
  }, [activityKey, loading, progress]);
  // PostgreSQL COPY FROM STDIN fast path
  const [useCopy, setUseCopy] = useState(true);
  /** The server-side chunk currently in flight, so Cancel can kill it. */
  const chunkTokenRef = useRef<string | null>(null);
  const runKeyRef = useRef<string | null>(null);

  // The DB-qualified reference the generator needs, and a plain (unquoted)
  // "db.table" for `get_table_meta`, which parses the dotted form itself.
  const parentRef = useMemo(() => {
    const raw = tableName.trim();
    if (!raw || raw.includes('.')) return raw;         // already qualified — respect it
    return targetDb.trim() ? `${targetDb.trim()}.${raw}` : raw;
  }, [tableName, targetDb]);

  const qualifiedTable = useMemo(() => {
    if (!parentRef) return '';
    return parentRef.split('.').map(part => quoteIdent(part, engine)).join('.');
  }, [parentRef, engine]);

  // Populate the database/schema picker once — the same queries the
  // schema-compare panel uses, minus the system catalogs nobody generates into.
  useEffect(() => {
    const sql = engine === 'postgres'
      ? "SELECT nspname FROM pg_catalog.pg_namespace WHERE nspname NOT LIKE 'pg\\_%' AND nspname <> 'information_schema' AND has_schema_privilege(oid,'USAGE') ORDER BY nspname"
      // `information_schema.schemata` exists on SQL Server but lists the ten
      // empty schemas it creates for its fixed database roles — `db_owner`,
      // `db_datareader` and friends — which would be ten of the twelve entries
      // in this picker and none of them somewhere anyone generates into.
      // `schema_id < 16384` is what separates real schemas from those.
      : engine === 'sqlserver'
      ? "SELECT name FROM sys.schemas WHERE schema_id < 16384 "
        + "AND name NOT IN ('sys','INFORMATION_SCHEMA','guest') ORDER BY name"
      : "SELECT schema_name FROM information_schema.schemata WHERE schema_name NOT IN ('mysql','sys','performance_schema','information_schema') ORDER BY schema_name";
    invoke<QueryResult>('monitor_query', { sessionId, sql })
      .then(r => {
        const dbs = r.rows.map(row => String(row[0]));
        setAvailableDbs(dbs);
        // If the editor's DB wasn't passed (or isn't in the list), fall back to
        // the first real database so a table is never left unqualified.
        setTargetDb(cur => (cur && dbs.includes(cur)) ? cur : (dbs[0] ?? cur));
      })
      .catch(() => {/* leave the picker empty; manual schema.table still works */});
  }, [sessionId, engine]);

  const kit = useMemo(() => SCHEMA_KITS.find(k => k.id === kitId) ?? SCHEMA_KITS[0], [kitId]);

  // Kit or scale change → recompute per-table row counts (still editable)
  useEffect(() => {
    setKitCounts(Object.fromEntries(resolveRowCounts(kit, scale)));
  }, [kit, scale]);

  const kitTotal = useMemo(
    () => Object.values(kitCounts).reduce((s, n) => s + n, 0),
    [kitCounts]);

  const kitDdl = useMemo(() => {
    if (mode !== 'database') return '';
    const parts = [...buildKitPreDdl(dbName.trim() || kit.defaultName, engine)];
    for (const t of kit.tables) {
      parts.push(...buildKitTableDdl(dbName.trim() || kit.defaultName, t, engine));
    }
    return parts.map(s => s + ';').join('\n\n');
  }, [mode, kit, dbName, engine]);

  // ── Step 1 → 2 ─────────────────────────────────────────────────────────────

  const loadExisting = useCallback(async () => {
    setError(null);
    setLoading(true);
    try {
      const meta = await invoke<TableMeta>('get_table_meta', {
        sessionId, parent: parentRef,
      });
      if (meta.columns.length === 0) throw new Error('table has no columns');
      setSpecs(meta.columns.map(c => {
        const isPk = meta.pk_columns.includes(c.name);
        // ENUM/SET introspection: fill the choice list straight from the type
        const enumM = /^(?:enum|set)\((.*)\)$/i.exec(c.type_name.trim());
        if (enumM) {
          const list = enumM[1].split(',').map(v => v.trim().replace(/^'|'$/g, '')).join(',');
          return { name: c.name, typeName: c.type_name, generator: 'choice',
            params: { ...DEFAULT_PARAMS, list } };
        }
        return {
          name: c.name,
          typeName: c.type_name,
          generator: suggestGenerator(c.name, c.type_name, isPk),
          // a PK or a name with "email"/"uuid" → default to unique
          unique: isPk || /email|uuid|guid|^.*_?(code|sku)$/i.test(c.name),
          params: { ...DEFAULT_PARAMS },
        };
      }));
      setStep(2);
    } catch (e) {
      setError(errorDisplay(e));
    } finally {
      setLoading(false);
    }
  }, [sessionId, parentRef]);

  function nextFromNewTable() {
    setError(null);
    const cols = newCols.filter(c => c.name.trim());
    if (!tableName.trim()) { setError('Table name is required'); return; }
    if (cols.length === 0) { setError('At least one column is required'); return; }
    setSpecs(cols.map(c => ({
      name: c.name.trim(),
      typeName: c.typeName,
      generator: suggestGenerator(c.name, c.typeName, c.pk),
      params: { ...DEFAULT_PARAMS },
    })));
    setStep(2);
  }

  function updateSpec(i: number, patch: Partial<ColumnSpec>) {
    setSpecs(prev => prev.map((s, idx) => idx === i ? { ...s, ...patch } : s));
  }
  function updateParam(i: number, key: keyof ColumnSpec['params'], value: string | number | boolean) {
    setSpecs(prev => prev.map((s, idx) =>
      idx === i ? { ...s, params: { ...s.params, [key]: value } } : s));
  }

  // ── Preview & run ──────────────────────────────────────────────────────────

  // Preview comes from the SAME Rust engine as the run — these rows ARE the
  // first rows that will be inserted. Sequences resolve MAX(pk)+1 first so
  // the preview shows the real ids.
  useEffect(() => {
    if (step !== 3 || mode === 'database') { setPreviewRows(null); return; }
    let alive = true;
    (async () => {
      let start = 1;
      const seqCol = specs.find(s => s.generator === 'sequence');
      if (mode === 'existing' && seqCol) {
        try {
          start = await invoke<number>('resolve_sequence_start', {
            sessionId, table: qualifiedTable, column: seqCol.name,
          });
        } catch { /* empty/new table → 1 */ }
      }
      if (!alive) return;
      setSeqStart(start);
      try {
        const rows = await invoke<unknown[][]>('generate_preview', {
          specs, count: Math.min(15, rowCount), seed, seqStart: start, locale,
        });
        if (alive) setPreviewRows(rows);
      } catch (e) {
        if (alive) setError(errorDisplay(e));
      }
    })();
    return () => { alive = false; };
  }, [step, specs, rowCount, seed, locale, mode, qualifiedTable, sessionId]);

  const preview = useMemo(() => {
    if (step !== 3 || !previewRows) return null;
    return {
      columns: specs.map(s => ({ name: s.name, type_name: s.typeName, nullable: true })),
      rows: previewRows,
    };
  }, [step, specs, previewRows]);

  const sqlPreview = useMemo(() => {
    if (step !== 3 || !previewRows) return '';
    const parts: string[] = [];
    if (mode === 'new') {
      parts.push(buildCreateTable(
        qualifiedTable,
        newCols.filter(c => c.name.trim()),
        engine,
      ) + ';');
    }
    const sample = buildInserts(qualifiedTable, specs, previewRows.slice(0, 3), engine);
    parts.push(sample[0] + ';\n-- … streamed in adaptive transactional batches up to '
      + rowCount.toLocaleString() + ' rows'
      + (engine === 'postgres' && useCopy ? ' (COPY fast path)' : ''));
    return parts.join('\n\n');
  }, [step, mode, qualifiedTable, newCols, specs, engine, rowCount, previewRows, useCopy]);

  const run = useCallback(async () => {
    setError(null);
    setSummary(null);
    if (readOnly) {
      setError('Blocked: this connection is read-only.');
      return;
    }
    if (environment === 'prod' && !await confirmDialog(
      `⚠ PRODUCTION\n\nInsert ${rowCount.toLocaleString()} generated rows into ${tableName.trim()}?`,
      { danger: true },
    )) return;
    const startedAt = isoNow();
    const runKey = crypto.randomUUID();
    runKeyRef.current = runKey;
    setProgress({ done: 0, total: rowCount, rps: 0 });

    const finish = (rows: number, ms: number, cancelled: boolean, err?: string) => {
      setProgress(null);
      if (err) setError(err);
      else if (cancelled) setSummary(`■ Cancelled after ${rows.toLocaleString()} rows (rolled back to the last chunk boundary)`);
      else {
        const rps = ms > 0 ? Math.round(rows / (ms / 1000)) : rows;
        setSummary(`✓ Inserted ${rows.toLocaleString()} rows into ${tableName.trim()} in ${(ms / 1000).toFixed(1)}s (${rps.toLocaleString()} rows/s)`);
      }
      logAudit({
        started_at: startedAt, ended_at: isoNow(), duration_ms: ms,
        connection_name: connectionName ?? '', db_user: '', engine,
        ok: !err && !cancelled, rows_out: 0, rows_affected: rows,
        error: err ?? (cancelled ? 'cancelled' : null),
        sql: `-- data generator: ${rowCount.toLocaleString()} rows into ${qualifiedTable} (seed ${seed})`,
      });
    };

    /**
     * Past a few hundred thousand rows, generate on the server.
     *
     * The row-by-row path builds every value in the backend and binds it into
     * multi-row INSERTs — fine at small sizes, and the wrong shape for a
     * hundred million: every value is constructed, bound and pushed to the
     * server one row at a time. `INSERT … SELECT` over `generate_series` (or a
     * cross join of digit tables on MySQL) makes the server do all of it and
     * sends a few hundred bytes per chunk. Measured against the local
     * fixtures: 968k rows/s on PostgreSQL, 460k on MySQL.
     *
     * Falls back silently to the row-by-row path when any column's generator
     * has no faithful SQL form — the alternative is data that quietly differs
     * from what the same spec produces at smaller sizes.
     */
    // A volume only the server path can carry, on a path that cannot carry it,
    // is an hour of the wrong algorithm. Refuse with the reason rather than
    // starting it.
    if (rowCount > MAX_ROWS_ROW_BY_ROW && !shouldUseServer(engine, rowCount)) {
      setProgress(null);
      setError(`${rowCount.toLocaleString()} rows can only be generated on the server, and this `
        + `${mode === 'new' ? 'run creates the table first, which uses the row-by-row path' : `engine (${engine}) has no server-side row source`}. `
        + `Pick ${MAX_ROWS_ROW_BY_ROW.toLocaleString()} rows or fewer.`);
      return;
    }

    if (mode !== 'new' && shouldUseServer(engine, rowCount)) {
      const plan = buildServerPlan(engine, qualifiedTable, specs, rowCount, undefined, locale);
      if (plan.unsupported.length === 0) {
        // Chunk independence is the safety property here: each statement
        // commits on its own, so Cancel leaves a usable table instead of an
        // hour of rollback, and no single transaction grows without bound.
        //
        // An open manual transaction destroys exactly that — `panel_query`
        // routes to the pinned connection, every chunk joins one transaction,
        // and the undo log grows for the whole run. Refuse rather than quietly
        // do the opposite of what the chunking is for.
        try {
          const tx = await invoke<{ held: boolean }>('tx_status', { sessionId });
          if (tx?.held) {
            setProgress(null);
            setError('A manual transaction (⛁ TX) is open on this session. Server-side generation '
              + 'commits chunk by chunk, which an open transaction would collapse into one — '
              + 'growing the undo log for the whole run and making Cancel a full rollback. '
              + 'Commit or roll back first.');
            return;
          }
        } catch { /* engines without transactions answer nothing; carry on */ }

        const t0 = performance.now();
        let done = 0;
        // The token of the chunk in flight, so Cancel can reach it. Without
        // this, cancelling only stopped the *next* chunk from starting and the
        // running one carried on to the end.
        try {
          for (let c = 0; c < plan.statements.length; c++) {
            if (runKeyRef.current !== runKey) break;      // cancelled between chunks
            const token = `${runKey}:${c}`;
            chunkTokenRef.current = token;
            await invoke('panel_query', { sessionId, sql: plan.statements[c], token });
            done = Math.min(rowCount, (c + 1) * plan.chunkRows);
            const secs = (performance.now() - t0) / 1000;
            setProgress({ done, total: rowCount, rps: secs > 0 ? Math.round(done / secs) : 0 });
          }
          finish(done, Math.round(performance.now() - t0), runKeyRef.current !== runKey);
        } catch (e) {
          // A cancelled chunk arrives here as an error; report it as the
          // cancellation it was rather than a failure.
          const cancelled = runKeyRef.current !== runKey;
          finish(done, Math.round(performance.now() - t0), cancelled,
            cancelled ? undefined : errorDisplay(e));
        } finally {
          chunkTokenRef.current = null;
        }
        return;
      }
      setError(`Generating ${rowCount.toLocaleString()} rows on the server needs every column to `
        + `have a SQL form, and ${plan.unsupported.map(u => `${u.column} (${u.generator})`).join(', ')} `
        + 'does not. Falling back to row-by-row generation, which is slower at this size — '
        + 'or pick a different generator for that column.');
    }

    const chan = new Channel<GenEvent>();
    chan.onmessage = ev => {
      if (ev.type === 'progress') {
        setProgress({ done: ev.rows_done, total: ev.rows_total, rps: ev.rows_per_sec });
      } else {
        finish(ev.rows, ev.ms, ev.cancelled);
        if (mode === 'new') onSchemaChanged?.();
      }
    };
    try {
      await invoke('generate_data', {
        run: {
          sessionId,
          table: qualifiedTable,
          specs,
          rowCount,
          seed,
          seqStart,
          locale,
          createDdl: mode === 'new'
            ? buildCreateTable(qualifiedTable, newCols.filter(c => c.name.trim()), engine)
            : null,
          useCopy: engine === 'postgres' && useCopy,
          runKey,
        },
        onEvent: chan,
      });
    } catch (e) {
      finish(0, 0, false, errorDisplay(e));
    }
  }, [mode, qualifiedTable, newCols, engine, sessionId, specs, rowCount, seed, seqStart, locale, useCopy,
      tableName, connectionName, onSchemaChanged, environment, readOnly]);

  const runDatabase = useCallback(async () => {
    setError(null);
    setSummary(null);
    if (readOnly) {
      setError('Blocked: this connection is read-only.');
      return;
    }
    const name = dbName.trim() || kit.defaultName;
    if (environment === 'prod' && !await confirmDialog(
      `⚠ PRODUCTION\n\nCreate ${engine === 'mysql' ? 'database' : 'schema'} "${name}" with ${kit.tables.length} tables and ${kitTotal.toLocaleString()} generated rows?`,
      { danger: true },
    )) return;
    const startedAt = isoNow();
    const runKey = crypto.randomUUID();
    runKeyRef.current = runKey;
    setDbProgress({ label: kit.tables[0].name, tableIdx: 0, tableCount: kit.tables.length,
      done: 0, total: 0, totalDone: 0, totalRows: kitTotal, rps: 0 });

    const finish = (rows: number, tables: number, ms: number, cancelled: boolean, err?: string) => {
      setDbProgress(null);
      if (err) setError(err);
      else if (cancelled) setSummary(`■ Cancelled after ${rows.toLocaleString()} rows (rolled back to the last chunk boundary)`);
      else {
        const rps = ms > 0 ? Math.round(rows / (ms / 1000)) : rows;
        setSummary(`✓ Created ${name} — ${tables} tables, ${rows.toLocaleString()} rows in ${(ms / 1000).toFixed(1)}s (${rps.toLocaleString()} rows/s)`);
      }
      logAudit({
        started_at: startedAt, ended_at: isoNow(), duration_ms: ms,
        connection_name: connectionName ?? '', db_user: '', engine,
        ok: !err && !cancelled, rows_out: 0, rows_affected: rows,
        error: err ?? (cancelled ? 'cancelled' : null),
        sql: `-- data generator: schema kit "${kit.id}" → ${name}, ${kit.tables.length} tables, ${kitTotal.toLocaleString()} rows (seed ${seed}, scale ${scale})`,
      });
      onSchemaChanged?.();
    };

    const chan = new Channel<DbGenEvent>();
    chan.onmessage = ev => {
      if (ev.type === 'table') {
        setDbProgress(p => p && ({ ...p, label: ev.label, tableIdx: ev.index, tableCount: ev.count, done: 0, total: 0 }));
      } else if (ev.type === 'progress') {
        setDbProgress(p => p && ({ ...p, label: ev.label, done: ev.rows_done, total: ev.rows_total,
          totalDone: ev.total_done, totalRows: ev.total_rows, rps: ev.rows_per_sec }));
      } else {
        finish(ev.rows, ev.tables, ev.ms, ev.cancelled);
      }
    };
    try {
      await invoke('generate_database', {
        run: {
          sessionId,
          preDdl: buildKitPreDdl(name, engine),
          tables: kit.tables.map(t => ({
            table: `${quoteIdent(name, engine)}.${quoteIdent(t.name, engine)}`,
            label: t.name,
            specs: kitTableSpecs(name, t, engine),
            rowCount: Math.max(1, kitCounts[t.name] ?? 1),
            seqStart: 1,
            createDdl: buildKitTableDdl(name, t, engine),
          })),
          seed,
          locale,
          useCopy: engine === 'postgres' && useCopy,
          runKey,
        },
        onEvent: chan,
      });
    } catch (e) {
      finish(0, 0, 0, false, errorDisplay(e));
    }
  }, [kit, dbName, engine, sessionId, kitCounts, kitTotal, seed, scale, locale, useCopy,
      connectionName, onSchemaChanged, environment, readOnly]);

  const cancelRun = useCallback(() => {
    if (runKeyRef.current) {
      invoke('cancel_datagen', { runKey: runKeyRef.current }).catch(() => {});
      // The server-side path is not a `generate_data` run — its work is a
      // chunk statement, and cancelling has to reach that or the current chunk
      // runs to completion regardless.
      if (chunkTokenRef.current) {
        invoke('cancel_panel_query', { sessionId, token: chunkTokenRef.current }).catch(() => {});
      }
      runKeyRef.current = null;
    }
  }, [sessionId]);

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="proc-panel">
      <div className="proc-toolbar">
        <span className="proc-title">🎲 Data generator</span>
        <div className="dg-steps">
          {[1, 2, 3].map(n => (
            <span key={n} className={`dg-step ${step === n ? 'active' : step > n ? 'done' : ''}`}>
              {n}. {n === 1 ? 'Target' : n === 2 ? (mode === 'database' ? 'Tables & size' : 'Generators') : 'Preview & Run'}
            </span>
          ))}
        </div>
        {/* Step actions live in the toolbar, like every other panel — there is
            no bottom action bar. */}
        {step > 1 && (
          <button
            className="toolbar-btn"
            disabled={!!progress || !!dbProgress}
            onClick={() => { if (step === 3) setSummary(null); setStep(step === 3 ? 2 : 1); }}
          >← Back</button>
        )}
        {step === 3 && engine === 'postgres' && (
          <label className="dg-field-inline" title="COPY FROM STDIN — fastest bulk path; one atomic COPY per chunk">
            <input type="checkbox" checked={useCopy} onChange={e => setUseCopy(e.target.checked)} />
            <span>COPY fast path</span>
          </label>
        )}
        {step === 1 && (mode === 'database' ? (
          <button className="toolbar-btn dg-run" onClick={() => setStep(2)}>Next →</button>
        ) : mode === 'existing' ? (
          <button className="toolbar-btn dg-run" disabled={!tableName.trim() || loading} onClick={loadExisting}>
            {loading ? 'Loading columns…' : 'Load columns →'}
          </button>
        ) : (
          <button className="toolbar-btn dg-run" onClick={nextFromNewTable}>Next →</button>
        ))}
        {step === 2 && (
          <button className="toolbar-btn dg-run" onClick={() => setStep(3)}>Preview →</button>
        )}
        {step === 3 && (mode === 'database' ? (
          <button className="toolbar-btn dg-run" onClick={runDatabase} disabled={!!dbProgress}>
            {dbProgress ? 'Generating…' : `▶ Create ${engine === 'mysql' ? 'database' : 'schema'} & insert ${kitTotal.toLocaleString()} rows`}
          </button>
        ) : (
          <button className="toolbar-btn dg-run" onClick={run} disabled={!!progress || !previewRows}>
            {progress ? 'Inserting…' : `▶ ${mode === 'new' ? 'Create table & insert' : 'Insert'} ${rowCount.toLocaleString()} rows`}
          </button>
        ))}
        <div style={{ flex: 1 }} />
        <button className="icon-btn" onClick={onClose} title="Close">×</button>
      </div>

      {error && <div className="proc-error-bar">{error}</div>}

      <div className="dg-body">
        {/* ── Step 1: target ── */}
        {step === 1 && (
          <div className="dg-target">
            <div className="dg-mode-row">
              <label className={`dg-mode ${mode === 'database' ? 'active' : ''}`}>
                <input type="radio" checked={mode === 'database'} onChange={() => setMode('database')} />
                <div>
                  <div className="dg-mode-title">Generate a whole database</div>
                  <div className="dg-mode-sub">Tables + FKs + indexes + referential data from a schema kit — one run, any size</div>
                </div>
              </label>
              <label className={`dg-mode ${mode === 'existing' ? 'active' : ''}`}>
                <input type="radio" checked={mode === 'existing'} onChange={() => setMode('existing')} />
                <div>
                  <div className="dg-mode-title">Fill an existing table</div>
                  <div className="dg-mode-sub">Columns and types are loaded, generators auto-suggested</div>
                </div>
              </label>
              <label className={`dg-mode ${mode === 'new' ? 'active' : ''}`}>
                <input type="radio" checked={mode === 'new'} onChange={() => setMode('new')} />
                <div>
                  <div className="dg-mode-title">Create a new table</div>
                  <div className="dg-mode-sub">Design columns here, table is created before inserting</div>
                </div>
              </label>
            </div>

            {mode === 'database' && (
              <>
                <div className="dg-kits">
                  {SCHEMA_KITS.map(k => (
                    <button
                      key={k.id}
                      className={`dg-kit ${kitId === k.id ? 'active' : ''}`}
                      onClick={() => { setKitId(k.id); setDbName(k.defaultName); }}
                    >
                      <div className="dg-kit-title">{k.title}</div>
                      <div className="dg-kit-sub">{k.description}</div>
                      <div className="dg-kit-meta">
                        {k.tables.length} tables · ~{totalRows(k, 1).toLocaleString()} rows at 1×
                        <span className="dg-kit-tables">{k.tables.map(t => t.name).join(' → ')}</span>
                      </div>
                    </button>
                  ))}
                </div>
                <label className="dg-field">
                  <span>{engine === 'mysql' ? 'Database name (created if missing)' : 'Schema name (created if missing)'}</span>
                  <input
                    value={dbName}
                    onChange={e => setDbName(e.target.value)}
                    placeholder={kit.defaultName}
                    autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false}
                  />
                </label>
              </>
            )}

            {mode !== 'database' && (
            <>
            <label className="dg-field">
              <span>{engine === 'mysql' ? 'Database' : 'Schema'} — where the table lives</span>
              <select
                value={targetDb}
                onChange={e => setTargetDb(e.target.value)}
                disabled={tableName.includes('.')}
                title={tableName.includes('.')
                  ? 'The table name is already qualified, so this is ignored'
                  : 'The generator runs on its own connection — this qualifies the table so it never depends on the active tab'}
              >
                {availableDbs.length === 0 && <option value="">(loading…)</option>}
                {targetDb && !availableDbs.includes(targetDb) && <option value={targetDb}>{targetDb}</option>}
                {availableDbs.map(d => <option key={d} value={d}>{d}</option>)}
              </select>
            </label>
            <label className="dg-field">
              <span>Table name {mode === 'existing' ? '(schema.table or table)' : ''}</span>
              <input
                value={tableName}
                onChange={e => setTableName(e.target.value)}
                placeholder={mode === 'existing' ? 'customers' : 'demo_customers'}
                autoFocus
              />
              {qualifiedTable && (
                <span className="dg-field-hint">→ writes to <code>{qualifiedTable}</code></span>
              )}
            </label>
            </>
            )}

            {mode === 'new' && (
              <div className="dg-cols">
                {/* Chart presets.
                    Generating "some data" and plotting it usually produces a
                    chart that proves nothing — a pie of 500 slices, a line
                    over randomly-drawn timestamps, a scatter of two
                    independent columns. Each preset is a table shape that
                    plots, and everything it sets stays editable. */}
                <div className="dg-presets">
                  <span className="dg-presets-label">Start from a chart shape:</span>
                  <div className="dg-preset-row">
                    {CHART_PRESETS.map(p => (
                      <button
                        key={p.id}
                        className="toolbar-btn dg-preset"
                        title={p.description}
                        onClick={() => {
                          setNewCols(p.columns.map((c, i) => ({
                            name: c.name, typeName: c.typeName,
                            pk: false, nullable: i > 0,
                          })));
                          setSpecs(p.columns.map(c => ({
                            name: c.name, typeName: c.typeName,
                            generator: c.generator, params: presetParams(c),
                          })));
                          setRowCount(p.rows);
                          if (!tableName.trim()) setTableName(p.id.replace(/-/g, '_'));
                        }}
                      >{p.label}</button>
                    ))}
                  </div>
                </div>
                <div className="dg-cols-head">
                  <span>Columns</span>
                  <button
                    className="toolbar-btn"
                    onClick={() => setNewCols(p => [...p, { name: '', typeName: 'VARCHAR(100)', pk: false, nullable: true }])}
                  >+ Add column</button>
                </div>
                {newCols.map((c, i) => (
                  <div key={i} className="dg-col-row">
                    <input
                      value={c.name}
                      placeholder="column_name"
                      onChange={e => setNewCols(p => p.map((x, xi) => xi === i ? { ...x, name: e.target.value } : x))}
                    />
                    <select
                      value={c.typeName}
                      onChange={e => setNewCols(p => p.map((x, xi) => xi === i ? { ...x, typeName: e.target.value } : x))}
                    >
                      {TYPE_OPTIONS.map(t => <option key={t} value={t}>{t}</option>)}
                      {!TYPE_OPTIONS.includes(c.typeName) && <option value={c.typeName}>{c.typeName}</option>}
                    </select>
                    <label className="gsp-check">
                      <input type="checkbox" checked={c.pk}
                        onChange={e => setNewCols(p => p.map((x, xi) => xi === i ? { ...x, pk: e.target.checked } : x))} /> PK
                    </label>
                    <label className="gsp-check">
                      <input type="checkbox" checked={c.nullable}
                        onChange={e => setNewCols(p => p.map((x, xi) => xi === i ? { ...x, nullable: e.target.checked } : x))} /> NULL
                    </label>
                    <button className="filter-remove" onClick={() => setNewCols(p => p.filter((_, xi) => xi !== i))}>×</button>
                  </div>
                ))}
              </div>
            )}

            {/* Locale lives on step 1 for every mode: choosing Czech / British /
                Japanese up front makes it obvious the run is one coherent
                country, not the blended default corpus. */}
            <label className="dg-field" title="Names, cities, companies, phones and postcodes are drawn from this locale's dictionary — a Czech row is Czech throughout, never blended.">
              <span>Locale — names, cities, companies, phones</span>
              <select
                value={locale}
                onChange={e => setLocale(e.target.value)}
              >
                {LOCALES.map(l => <option key={l.id} value={l.id}>{l.label}</option>)}
              </select>
              <span className="dg-field-hint">One country per row — name, city, phone and postcode always agree. “Default” is the original blended corpus.</span>
            </label>
          </div>
        )}

        {/* ── Step 2 (kit): scale + per-table rows ── */}
        {step === 2 && mode === 'database' && (
          <div className="dg-generators">
            <div className="dg-genrow-head">
              <span className="dg-scale-label">Scale</span>
              {SCALES.map(s => (
                <button key={s.value} className={`toolbar-btn ${scale === s.value ? 'active' : ''}`}
                  onClick={() => setScale(s.value)}>{s.label}</button>
              ))}
              <label className="dg-field-inline" title="Same seed → the identical database, at any scale. Reroll for a different world.">
                <span>Seed</span>
                <input
                  type="number"
                  value={seed}
                  onChange={e => setSeed(Number(e.target.value) || 0)}
                  style={{ width: 110 }}
                />
              </label>
              <button className="toolbar-btn" onClick={() => setSeed(Math.floor(Math.random() * 1e9))}>🎲 Reroll</button>
              <span className="dg-kit-total">Σ {kitTotal.toLocaleString()} rows</span>
            </div>

            <div className="dg-spec-list">
              {kit.tables.map(t => (
                <div key={t.name} className="dg-spec">
                  <span className="dg-spec-name">
                    {t.name}
                    <span className="col-type">
                      {t.columns.length} cols
                      {t.columns.some(c => c.fk) &&
                        ` · FK → ${[...new Set(t.columns.filter(c => c.fk).map(c => c.fk!.table))].join(', ')}`}
                    </span>
                  </span>
                  <label className="dg-field-inline">
                    <span>rows</span>
                    <input
                      type="number" min={1} max={MAX_ROWS}
                      value={kitCounts[t.name] ?? 0}
                      onChange={e => setKitCounts(p => ({
                        ...p, [t.name]: Math.min(MAX_ROWS, Math.max(1, Number(e.target.value) || 1)),
                      }))}
                      style={{ width: 110 }}
                    />
                  </label>
                  {'per' in t.rows && (
                    <span className="dg-kit-ratio">~{t.rows.ratio} per {t.rows.per}</span>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── Step 2: generators ── */}
        {step === 2 && mode !== 'database' && (
          <div className="dg-generators">
            <div className="dg-genrow-head">
              <label className="dg-field-inline">
                <span>Rows</span>
                <input
                  type="number" min={1} max={MAX_ROWS}
                  value={rowCount}
                  onChange={e => setRowCount(Math.min(MAX_ROWS, Math.max(1, Number(e.target.value) || 1)))}
                />
              </label>
              {/* The ladder, with the size each rung produces for THESE columns
                  — "1 billion" means nothing until it says 34 GiB. */}
              <select
                className="toolbar-select"
                value={SIZINGS.find(s2 => s2.rows === rowCount)?.id ?? ''}
                data-tip="Row counts, with the table size they produce for the columns chosen"
                onChange={e => {
                  const s2 = SIZINGS.find(x => x.id === e.target.value);
                  if (s2) setRowCount(s2.rows);
                }}
              >
                <option value="">— size —</option>
                {SIZINGS.map(s2 => (
                  <option key={s2.id} value={s2.id}>
                    {s2.label} · ≈{formatBytes(estimateBytes(specs, s2.rows))}
                  </option>
                ))}
              </select>
              <label className="dg-field-inline" title="Same seed → same data. Reroll for a different dataset.">
                <span>Seed</span>
                <input
                  type="number"
                  value={seed}
                  onChange={e => setSeed(Number(e.target.value) || 0)}
                  style={{ width: 110 }}
                />
              </label>
              <button className="toolbar-btn" onClick={() => setSeed(Math.floor(Math.random() * 1e9))}>🎲 Reroll</button>
            </div>

            <div className="dg-spec-list">
              {specs.map((s, i) => {
                const g = GENERATOR_MAP.get(s.generator);
                return (
                  <div key={s.name} className="dg-spec">
                    <span className="dg-spec-name" title={s.typeName}>
                      {s.name} <span className="col-type">{s.typeName}</span>
                    </span>
                    {/* Grouped: the catalogue is past seventy entries and a
                        flat list of that length is a scroll, not a choice. */}
                    <select value={s.generator} onChange={e => updateSpec(i, { generator: e.target.value })}>
                      {GENERATOR_GROUPS.map(([group, gens]) => (
                        <optgroup key={group} label={group}>
                          {gens.map(gen => <option key={gen.id} value={gen.id}>{gen.label}</option>)}
                        </optgroup>
                      ))}
                    </select>
                    {g?.uses.includes('range') && (
                      <span className="dg-params">
                        <input type="number" value={s.params.min} onChange={e => updateParam(i, 'min', Number(e.target.value))} title="min" />
                        –
                        <input type="number" value={s.params.max} onChange={e => updateParam(i, 'max', Number(e.target.value))} title="max" />
                      </span>
                    )}
                    {g?.uses.includes('dates') && (
                      <span className="dg-params">
                        <input type="date" value={s.params.dateFrom} onChange={e => updateParam(i, 'dateFrom', e.target.value)} />
                        –
                        <input type="date" value={s.params.dateTo} onChange={e => updateParam(i, 'dateTo', e.target.value)} />
                      </span>
                    )}
                    {g?.uses.includes('list') && (
                      <input
                        className="dg-list-input"
                        value={s.params.list}
                        onChange={e => updateParam(i, 'list', e.target.value)}
                        placeholder={s.generator === 'regex' ? '[A-Z]{2}-\\d{4}' : s.generator === 'choice' ? 'active:70, disabled:25, banned:5' : 'comma,separated,values'}
                      />
                    )}
                    {s.generator === 'fk' && (
                      <span className="dg-params">
                        <input className="dg-list-input" value={s.params.fkTable ?? ''}
                          onChange={e => updateParam(i, 'fkTable', e.target.value)}
                          placeholder="parent table (e.g. `shop`.`customers`)" />
                        <input className="dg-list-input" value={s.params.fkColumn ?? ''}
                          onChange={e => updateParam(i, 'fkColumn', e.target.value)}
                          placeholder="parent col (e.g. `id`)" style={{ maxWidth: 90 }} />
                      </span>
                    )}
                    {g?.uses.includes('decimals') && (
                      <label className="dg-null" title="Decimal places">
                        <input type="number" min={0} max={12}
                          value={s.params.decimals ?? 2}
                          onChange={e => updateParam(i, 'decimals', Math.max(0, Math.min(12, Number(e.target.value) || 0)))}
                        /> dp
                      </label>
                    )}
                    {g?.uses.includes('step') && (
                      <span className="dg-params" title="Distance between consecutive rows">
                        step
                        <input type="number" min={1} style={{ maxWidth: 64 }}
                          value={s.params.step ?? 1}
                          onChange={e => updateParam(i, 'step', Math.max(1, Number(e.target.value) || 1))} />
                        {/* A sequence steps by a plain number; only the date
                            generators need a unit to step in. */}
                        {g.uses.includes('dates') && (
                          <select value={s.params.stepUnit ?? 'hour'}
                            onChange={e => updateParam(i, 'stepUnit', e.target.value)}>
                            {['second', 'minute', 'hour', 'day', 'week', 'month']
                              .map(u => <option key={u} value={u}>{u}</option>)}
                          </select>
                        )}
                        {g.uses.includes('dates') && (
                          <input type="number" min={0} max={100} style={{ maxWidth: 58 }}
                            title="± jitter, as a percentage of the step"
                            value={s.params.jitterPct ?? 0}
                            onChange={e => updateParam(i, 'jitterPct', Math.max(0, Math.min(100, Number(e.target.value) || 0)))} />
                        )}
                        {g.uses.includes('dates') && '% jitter'}
                      </span>
                    )}
                    {g?.uses.includes('geo') && (
                      <span className="dg-params" title="Centre point and spread — coordinates are only useful when they land somewhere">
                        lat
                        <input type="number" step="0.0001" style={{ maxWidth: 88 }}
                          value={s.params.lat ?? 0}
                          onChange={e => updateParam(i, 'lat', Number(e.target.value))} />
                        lon
                        <input type="number" step="0.0001" style={{ maxWidth: 88 }}
                          value={s.params.lon ?? 0}
                          onChange={e => updateParam(i, 'lon', Number(e.target.value))} />
                        ±
                        <input type="number" min={0} style={{ maxWidth: 64 }}
                          value={s.params.radiusKm ?? 25}
                          onChange={e => updateParam(i, 'radiusKm', Math.max(0, Number(e.target.value) || 0))} />
                        km
                      </span>
                    )}
                    {g?.uses.includes('series') && (
                      <span className="dg-params" title="Trend across the whole dataset, seasonal swing, cycle length in rows, and noise — all as percentages of the mid-range">
                        trend
                        <input type="number" style={{ maxWidth: 62 }}
                          value={s.params.trendPct ?? 0}
                          onChange={e => updateParam(i, 'trendPct', Number(e.target.value) || 0)} />%
                        season
                        <input type="number" style={{ maxWidth: 62 }}
                          value={s.params.seasonAmpPct ?? 0}
                          onChange={e => updateParam(i, 'seasonAmpPct', Number(e.target.value) || 0)} />%
                        every
                        <input type="number" min={1} style={{ maxWidth: 62 }}
                          value={s.params.seasonPeriod ?? 24}
                          onChange={e => updateParam(i, 'seasonPeriod', Math.max(1, Number(e.target.value) || 1))} />rows
                        noise
                        <input type="number" min={0} style={{ maxWidth: 62 }}
                          value={s.params.noisePct ?? 0}
                          onChange={e => updateParam(i, 'noisePct', Math.max(0, Number(e.target.value) || 0))} />%
                      </span>
                    )}
                    {g?.uses.includes('ride') && (
                      <span className="dg-params" title="One car_id drives one continuous ride down real New York streets; pings sampled at this interval. Keep these identical across a table's track columns.">
                        pings/ride
                        <input type="number" min={2} style={{ maxWidth: 66 }}
                          value={s.params.ridePings ?? 200}
                          onChange={e => updateParam(i, 'ridePings', Math.max(2, Number(e.target.value) || 2))} />
                        every
                        <input type="number" min={1} style={{ maxWidth: 56 }}
                          value={s.params.pingSec ?? 2}
                          onChange={e => updateParam(i, 'pingSec', Math.max(1, Number(e.target.value) || 1))} />s
                      </span>
                    )}
                    {g?.uses.includes('affix') && (
                      <span className="dg-params">
                        <input className="dg-list-input" style={{ maxWidth: 90 }}
                          placeholder="prefix" value={s.params.prefix ?? ''}
                          onChange={e => updateParam(i, 'prefix', e.target.value)} />
                        <input className="dg-list-input" style={{ maxWidth: 90 }}
                          placeholder="suffix" value={s.params.suffix ?? ''}
                          onChange={e => updateParam(i, 'suffix', e.target.value)} />
                      </span>
                    )}
                    {g?.uses.includes('cardBrand') && (
                      <select value={s.params.brand ?? ''} title="Card brand — correct IIN range and length"
                        onChange={e => updateParam(i, 'brand', e.target.value)}>
                        <option value="">test range</option>
                        <option value="visa">Visa</option>
                        <option value="mastercard">Mastercard</option>
                        <option value="amex">Amex</option>
                      </select>
                    )}
                    {g?.uses.includes('ibanCountry') && (
                      <select value={s.params.ibanCountry ?? ''} title="IBAN country (BBAN format)"
                        onChange={e => updateParam(i, 'ibanCountry', e.target.value)}>
                        <option value="">CZ</option>
                        <option value="GB">GB</option>
                        <option value="JP">JP (synthetic — no ISO IBAN)</option>
                      </select>
                    )}
                    {g?.uses.includes('validity') && (
                      <label className="dg-null" title="Emit a correct check digit, or a deliberately wrong one for negative testing">
                        <input type="checkbox" checked={s.params.valid !== false}
                          onChange={e => updateParam(i, 'valid', e.target.checked)} /> valid
                      </label>
                    )}
                    {(g?.uses.includes('range') || g?.uses.includes('dates')) && (
                      <select value={s.params.dist ?? 'uniform'} title="distribution"
                        onChange={e => updateParam(i, 'dist', e.target.value)}>
                        <option value="uniform">uniform</option>
                        <option value="normal">normal</option>
                        <option value="zipf">zipf (skew low)</option>
                      </select>
                    )}
                    <label className="dg-null" title="Percentage of NULLs">
                      <input
                        type="number" min={0} max={100}
                        value={s.params.nullPct}
                        onChange={e => updateParam(i, 'nullPct', Math.min(100, Math.max(0, Number(e.target.value) || 0)))}
                      />% null
                    </label>
                    <label className="dg-null" title="Enforce uniqueness (backend mixes in the row index)">
                      <input type="checkbox" checked={!!s.unique}
                        onChange={e => updateSpec(i, { unique: e.target.checked })} /> uniq
                    </label>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* ── Step 3 (kit): DDL preview & run ── */}
        {step === 3 && mode === 'database' && (
          <div className="dg-preview">
            <pre className="dg-sql dg-sql-tall">{
              `${kitDdl}\n\n-- … then ${kit.tables.length} tables filled parents-first (${kitTotal.toLocaleString()} rows total,\n`
              + `-- FK columns pull real parent values${engine === 'postgres' && useCopy ? ', COPY fast path' : ''}, seed ${seed})`
            }</pre>

            {dbProgress && (
              <div className="dg-progress">
                <div className="dg-progress-block">
                  <div className="dg-progress-bar">
                    <div className="dg-progress-fill" style={{ width: `${(dbProgress.totalDone / Math.max(1, dbProgress.totalRows)) * 100}%` }} />
                  </div>
                  <span>
                    table {dbProgress.tableIdx + 1}/{dbProgress.tableCount}: <b>{dbProgress.label}</b>
                    {' · '}{dbProgress.totalDone.toLocaleString()} / {dbProgress.totalRows.toLocaleString()} rows
                    {dbProgress.rps > 0 && <> · {dbProgress.rps.toLocaleString()} rows/s
                      · ETA {Math.max(0, Math.round((dbProgress.totalRows - dbProgress.totalDone) / dbProgress.rps))}s</>}
                  </span>
                </div>
                <button className="toolbar-btn dg-cancel" onClick={cancelRun}>■ Cancel</button>
              </div>
            )}
            {summary && <div className="dg-summary">{summary}</div>}
          </div>
        )}

        {/* ── Step 3: preview & run ── */}
        {step === 3 && mode !== 'database' && (
          <div className="dg-preview">
            <div className="dg-preview-grid">
              {preview && <FastGrid columns={preview.columns} rows={preview.rows} />}
            </div>
            <pre className="dg-sql">{sqlPreview}</pre>

            {progress && (
              <div className="dg-progress">
                <div className="dg-progress-bar">
                  <div className="dg-progress-fill" style={{ width: `${(progress.done / Math.max(1, progress.total)) * 100}%` }} />
                </div>
                <span>
                  {progress.done.toLocaleString()} / {progress.total.toLocaleString()} rows
                  {progress.rps > 0 && <> · {progress.rps.toLocaleString()} rows/s
                    · ETA {Math.max(0, Math.round((progress.total - progress.done) / progress.rps))}s</>}
                </span>
                <button className="toolbar-btn dg-cancel" onClick={cancelRun}>■ Cancel</button>
              </div>
            )}
            {summary && <div className="dg-summary">{summary}</div>}
          </div>
        )}
      </div>
    </div>
  );
}
