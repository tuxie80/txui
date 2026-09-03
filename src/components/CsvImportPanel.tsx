/**
 * CSV import wizard — 3 steps:
 *   1. File & target — pick CSV (delimiter/header auto-detected, re-detectable),
 *      import into an existing table or create a new one
 *   2. Columns — per-CSV-column mapping (existing: match by name; new: edit
 *      name/type, inferred from data), skip toggles
 *   3. Run — options + live progress (bytes-based %), transactional
 */
import { errorDisplay } from '../utils/appError';
import { confirmDialog } from '../utils/appDialog';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke, Channel } from '@tauri-apps/api/core';
import { clearTabActivities, panelTabKey, setActivity } from '../store/tabActivity';
import { open } from '@tauri-apps/plugin-dialog';
import type { TableMeta } from '../types/browser';
import { quoteIdent } from '../utils/sqlIdent';
import { FastGrid } from './FastGrid';
import { basename } from '../utils/platform';
import { audited } from '../utils/panelAudit';

interface Props {
  sessionId: string;
  engine: string;
  environment?: string | null;
  readOnly?: boolean;
  onClose: () => void;
  onSchemaChanged?: () => void;
}

interface CsvColumnInfo { name: string; inferred_type: string }
interface CsvPreview {
  delimiter: string;
  has_header: boolean;
  columns: CsvColumnInfo[];
  rows: string[][];
  file_bytes: number;
}

interface ColMap {
  csvName: string;
  inferredType: string;
  /** target column name ('' = skip) */
  target: string;
  /** type for new-table mode */
  typeName: string;
  skip: boolean;
}

type ImportEvent = { type: 'progress'; rows: number; bytes: number; total_bytes: number };

const DELIMS = [
  { label: 'comma ,', value: ',' },
  { label: 'semicolon ;', value: ';' },
  { label: 'tab ⇥', value: '\t' },
  { label: 'pipe |', value: '|' },
];

export function CsvImportPanel({ sessionId, engine, environment, readOnly, onClose, onSchemaChanged }: Props) {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [path, setPath] = useState('');
  const [preview, setPreview] = useState<CsvPreview | null>(null);
  const [mode, setMode] = useState<'existing' | 'new'>('existing');
  const [tableName, setTableName] = useState('');
  const [cols, setCols] = useState<ColMap[]>([]);
  const [existingCols, setExistingCols] = useState<string[]>([]);
  const [truncate, setTruncate] = useState(false);
  const [upsert, setUpsert] = useState(false);
  const [nullEmpty, setNullEmpty] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState<{ rows: number; pct: number } | null>(null);
  const [summary, setSummary] = useState<string | null>(null);
  /** Set when the picked file was converted — the banner and sheet picker. */
  const [source, setSource] = useState<
    { original: string; rows: number; sheets: string[]; sheet: string } | null>(null);
  // An import keeps inserting in the backend even with this panel closed —
  // the close-guard names it instead of letting it vanish from view, and the
  // kill closure is how the status-bar popover stops it.
  const activityKey = panelTabKey(sessionId, 'csvimport');
  const runKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!progress) { clearTabActivities(activityKey); return; }
    setActivity(activityKey, {
      id: 'import',
      label: 'CSV import running',
      detail: `${progress.rows.toLocaleString()} rows inserted (${progress.pct}%)`,
      survives: true,
      kill: () => {
        if (runKeyRef.current) invoke('cancel_import', { runKey: runKeyRef.current }).catch(() => {});
      },
    });
  }, [activityKey, progress]);

  const fileName = basename(path);

  const loadPreview = useCallback(async (p: string, delimiter?: string) => {
    setLoading(true);
    setError(null);
    try {
      const pv = await invoke<CsvPreview>('csv_preview', { path: p, delimiter: delimiter ?? null });
      setPreview(pv);
      setCols(pv.columns.map(c => ({
        csvName: c.name,
        inferredType: c.inferred_type,
        target: c.name,
        typeName: c.inferred_type,
        skip: false,
      })));
    } catch (e) {
      setError(errorDisplay(e));
      setPreview(null);
    } finally {
      setLoading(false);
    }
  }, []);

  async function pickFile() {
    const p = await open({
      filters: [
        { name: 'Table data', extensions: ['csv', 'tsv', 'txt', 'json', 'ndjson', 'jsonl', 'xlsx', 'xlsm', 'xls', 'ods'] },
        { name: 'CSV', extensions: ['csv', 'tsv', 'txt'] },
        { name: 'JSON', extensions: ['json', 'ndjson', 'jsonl'] },
        { name: 'Spreadsheet', extensions: ['xlsx', 'xlsm', 'xls', 'ods'] },
      ],
      multiple: false,
    });
    if (typeof p !== 'string') return;
    if (!tableName) {
      const base = (basename(p)).replace(/\.\w+$/, '')
        .replace(/[^A-Za-z0-9_]/g, '_').toLowerCase();
      setTableName(base);
    }
    await openSource(p);
  }

  /**
   * Load a file, converting it first when it is not already CSV.
   *
   * Everything downstream — preview, mapping, the streaming insert, the prod
   * guards, the audit trail — works on CSV, and rebuilding that per format
   * would be three copies of the dangerous half. JSON and spreadsheets are
   * converted to a temporary CSV and then follow exactly the same path.
   */
  async function openSource(p: string, sheet?: string) {
    const ext = (p.split('.').pop() ?? '').toLowerCase();
    if (['csv', 'tsv', 'txt'].includes(ext)) {
      setSource(null);
      setPath(p);
      loadPreview(p);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const c = await invoke<{
        csvPath: string; rows: number; columns: string[]; sheets: string[]; sheet: string;
      }>('import_convert', { path: p, sheet: sheet ?? null });
      setSource({ original: p, rows: c.rows, sheets: c.sheets, sheet: c.sheet });
      setPath(c.csvPath);
      loadPreview(c.csvPath);
    } catch (e) {
      setError(errorDisplay(e));
      setSource(null);
    } finally {
      setLoading(false);
    }
  }

  async function toMapping() {
    setError(null);
    if (!preview || !tableName.trim()) { setError('Pick a file and a table name.'); return; }
    if (mode === 'existing') {
      setLoading(true);
      try {
        const meta = await invoke<TableMeta>('get_table_meta', {
          sessionId, parent: tableName.trim(),
        });
        const names = meta.columns.map(c => c.name);
        setExistingCols(names);
        // auto-map by case-insensitive name
        setCols(prev => prev.map(c => {
          const hit = names.find(n => n.toLowerCase() === c.csvName.toLowerCase());
          return { ...c, target: hit ?? '', skip: !hit };
        }));
        setStep(2);
      } catch (e) {
        setError(`Could not load table: ${errorDisplay(e)}`);
      } finally {
        setLoading(false);
      }
    } else {
      setExistingCols([]);
      setStep(2);
    }
  }

  const quotedTable = useMemo(
    () => tableName.trim().split('.').map(p => quoteIdent(p, engine)).join('.'),
    [tableName, engine],
  );

  const activeCols = cols.filter(c => !c.skip && (mode === 'new' || c.target));

  const createSql = useMemo(() => {
    if (mode !== 'new') return null;
    const lines = activeCols.map(c =>
      `  ${quoteIdent(c.target || c.csvName, engine)} ${c.typeName}`);
    return `CREATE TABLE ${quotedTable} (\n${lines.join(',\n')}\n)`;
  }, [mode, activeCols, quotedTable, engine]);

  const run = useCallback(async () => {
    setError(null);
    setSummary(null);
    if (readOnly) { setError('Blocked: this connection is read-only.'); return; }
    if (environment === 'prod' && !await confirmDialog(
      `⚠ PRODUCTION\n\nImport ${fileName} into ${tableName.trim()}${truncate ? ' (existing rows DELETED first)' : ''}?`,
      { danger: true },
    )) return;

    const chan = new Channel<ImportEvent>();
    chan.onmessage = (ev) => {
      if (ev.type === 'progress') {
        setProgress({
          rows: ev.rows,
          pct: ev.total_bytes > 0 ? Math.min(100, (ev.bytes / ev.total_bytes) * 100) : 0,
        });
      }
    };
    setProgress({ rows: 0, pct: 0 });
    // The backend registers this key in ext_jobs (session-prefixed) so the
    // close sweep finds it too; cancel_import resolves the bare key.
    const runKey = crypto.randomUUID();
    runKeyRef.current = runKey;
    try {
      // Loading a file into a table is a write, and until now it was a write
      // that left no trace in either log. It is audited like any other.
      const res = await audited({
        sessionId, engine, tab: '📥 CSV import', source: 'import',
        statement: `-- CSV import: ${basename(path)} → ${quotedTable}`
          + `${mode === 'existing' && truncate ? ' (TRUNCATE first)' : ''}`
          + `${mode === 'existing' && upsert ? ' (upsert)' : ''}`,
        rowsAffected: r => r.rows,
        run: () => invoke<{ rows: number; ms: number; cancelled: boolean }>('csv_import', {
        sessionId,
        runKey,
        spec: {
          path,
          delimiter: preview?.delimiter ?? ',',
          has_header: preview?.has_header ?? true,
          table: quotedTable,
          columns: cols.map(c =>
            c.skip || (mode === 'existing' && !c.target)
              ? null
              : quoteIdent(c.target || c.csvName, engine)),
          create_sql: createSql,
          truncate: mode === 'existing' && truncate,
          upsert: mode === 'existing' && upsert,
          null_empty: nullEmpty,
        },
        onEvent: chan,
        }),
      });
      setSummary(res.cancelled
        ? `■ Import cancelled after ${res.rows.toLocaleString()} rows — those rows stay; the rest of the file was not imported`
        : `✓ Imported ${res.rows.toLocaleString()} rows into ${tableName.trim()} in ${(res.ms / 1000).toFixed(1)}s`);
      if (mode === 'new') onSchemaChanged?.();
    } catch (e) {
      setError(errorDisplay(e));
    } finally {
      runKeyRef.current = null;
      setProgress(null);
    }
  }, [readOnly, environment, fileName, tableName, truncate, upsert, sessionId, path, preview, quotedTable, cols, mode, engine, createSql, nullEmpty, onSchemaChanged]);

  const previewGrid = useMemo(() => {
    if (!preview) return null;
    return {
      columns: preview.columns.map(c => ({ name: c.name, type_name: c.inferred_type, nullable: true })),
      rows: preview.rows as unknown[][],
    };
  }, [preview]);

  return (
    <div className="proc-panel">
      <div className="proc-toolbar">
        <span className="proc-title">📥 CSV import</span>
        <div className="dg-steps">
          {[1, 2, 3].map(n => (
            <span key={n} className={`dg-step ${step === n ? 'active' : step > n ? 'done' : ''}`}>
              {n}. {n === 1 ? 'File & target' : n === 2 ? 'Columns' : 'Run'}
            </span>
          ))}
        </div>
        <div style={{ flex: 1 }} />
        <button className="icon-btn" onClick={onClose} title="Close">×</button>
      </div>

      {error && <div className="proc-error-bar">{error}</div>}

      <div className="dg-body">
        {/* ── Step 1 ── */}
        {step === 1 && (
          <div className="dg-target">
            <div className="dg-field">
              <span>File</span>
              <div style={{ display: 'flex', gap: 8 }}>
                <input
                  value={source ? source.original : path}
                  readOnly
                  placeholder="CSV, JSON or spreadsheet…"
                  style={{ flex: 1 }}
                />
                <button className="toolbar-btn" onClick={pickFile}>Browse…</button>
              </div>
            </div>

            {/* Say that a conversion happened. The delimiter and header
                controls below now describe the *converted* CSV, not the file
                the user picked, and that would be baffling unsaid. */}
            {source && (
              <div className="er-hint-bar" style={{ marginTop: 8 }}>
                <span>
                  Read <strong>{source.rows.toLocaleString()}</strong>{' '}
                  {source.rows === 1 ? 'record' : 'records'}
                  {source.sheet && <> from sheet <strong>{source.sheet}</strong></>}
                  {' '}and converted to CSV for import.
                </span>
                {source.sheets.length > 1 && (
                  <label className="dg-field-inline">
                    <span>Sheet</span>
                    <select
                      value={source.sheet}
                      disabled={loading}
                      onChange={e => void openSource(source.original, e.target.value)}
                    >
                      {source.sheets.map(sh => <option key={sh} value={sh}>{sh}</option>)}
                    </select>
                  </label>
                )}
              </div>
            )}

            {preview && (
              <div className="ci-opts">
                <label className="dg-field-inline">
                  <span>Delimiter</span>
                  <select
                    value={preview.delimiter}
                    onChange={e => loadPreview(path, e.target.value)}
                  >
                    {DELIMS.map(d => <option key={d.value} value={d.value}>{d.label}</option>)}
                    {!DELIMS.some(d => d.value === preview.delimiter) && (
                      <option value={preview.delimiter}>{preview.delimiter}</option>
                    )}
                  </select>
                </label>
                <label className="gsp-check">
                  <input
                    type="checkbox"
                    checked={preview.has_header}
                    onChange={e => setPreview({ ...preview, has_header: e.target.checked })}
                  /> first row is header
                </label>
                <span className="dv-desc">
                  {preview.columns.length} columns · {(preview.file_bytes / 1024).toFixed(0)} kB
                </span>
              </div>
            )}

            <div className="dg-mode-row">
              <label className={`dg-mode ${mode === 'existing' ? 'active' : ''}`}>
                <input type="radio" checked={mode === 'existing'} onChange={() => setMode('existing')} />
                <div>
                  <div className="dg-mode-title">Into an existing table</div>
                  <div className="dg-mode-sub">Columns matched by name, adjustable next step</div>
                </div>
              </label>
              <label className={`dg-mode ${mode === 'new' ? 'active' : ''}`}>
                <input type="radio" checked={mode === 'new'} onChange={() => setMode('new')} />
                <div>
                  <div className="dg-mode-title">Create a new table</div>
                  <div className="dg-mode-sub">Types inferred from the data, editable next step</div>
                </div>
              </label>
            </div>

            <label className="dg-field">
              <span>Table name {mode === 'existing' ? '(schema.table or table)' : ''}</span>
              <input value={tableName} onChange={e => setTableName(e.target.value)} placeholder="mydb.customers" />
            </label>

            <div className="row-actions">
              <button className="primary" disabled={!preview || !tableName.trim() || loading} onClick={toMapping}>
                {loading ? 'Loading…' : 'Next →'}
              </button>
            </div>
          </div>
        )}

        {/* ── Step 2 ── */}
        {step === 2 && preview && (
          <div className="dg-generators">
            <div className="dg-spec-list">
              {cols.map((c, i) => (
                <div key={i} className={`dg-spec ${c.skip ? 'ci-skipped' : ''}`}>
                  <label className="gsp-check" style={{ width: 60 }}>
                    <input
                      type="checkbox"
                      checked={!c.skip}
                      onChange={e => setCols(p => p.map((x, xi) => xi === i ? { ...x, skip: !e.target.checked } : x))}
                    /> use
                  </label>
                  <span className="dg-spec-name" title={c.inferredType}>
                    {c.csvName} <span className="col-type">{c.inferredType}</span>
                  </span>
                  <span className="dv-desc">→</span>
                  {mode === 'existing' ? (
                    <select
                      value={c.target}
                      disabled={c.skip}
                      onChange={e => setCols(p => p.map((x, xi) => xi === i ? { ...x, target: e.target.value } : x))}
                    >
                      <option value="">— skip —</option>
                      {existingCols.map(n => <option key={n} value={n}>{n}</option>)}
                    </select>
                  ) : (
                    <>
                      <input
                        className="dg-list-input"
                        style={{ maxWidth: 180 }}
                        value={c.target}
                        disabled={c.skip}
                        onChange={e => setCols(p => p.map((x, xi) => xi === i ? { ...x, target: e.target.value } : x))}
                        placeholder="column name"
                      />
                      <input
                        className="dg-list-input"
                        style={{ maxWidth: 150 }}
                        value={c.typeName}
                        disabled={c.skip}
                        onChange={e => setCols(p => p.map((x, xi) => xi === i ? { ...x, typeName: e.target.value } : x))}
                        placeholder="TYPE"
                      />
                    </>
                  )}
                </div>
              ))}
            </div>
            <div className="row-actions">
              <button className="toolbar-btn" onClick={() => setStep(1)}>← Back</button>
              <button className="primary" disabled={activeCols.length === 0} onClick={() => setStep(3)}>
                Next →
              </button>
            </div>
          </div>
        )}

        {/* ── Step 3 ── */}
        {step === 3 && preview && (
          <div className="dg-preview">
            <div className="dg-preview-grid">
              {previewGrid && <FastGrid columns={previewGrid.columns} rows={previewGrid.rows} />}
            </div>

            <div className="ci-opts" style={{ padding: '8px 20px' }}>
              {mode === 'existing' && (
                <label className="gsp-check">
                  <input type="checkbox" checked={truncate} onChange={e => setTruncate(e.target.checked)} />
                  delete existing rows first
                </label>
              )}
              {/* SQL Server has no INSERT-level conflict clause at all — its
                  upsert is MERGE, which needs the key columns to match on, and
                  the importer only knows the CSV's column list. Offering the
                  box and failing on Import would be worse than not offering it,
                  so the reason is stated where the box would have been. */}
              {mode === 'existing' && engine !== 'sqlserver' && (
                <label className="gsp-check" title={engine === 'mysql' ? 'ON DUPLICATE KEY UPDATE' : 'ON CONFLICT DO NOTHING (skip duplicates)'}>
                  <input type="checkbox" checked={upsert} onChange={e => setUpsert(e.target.checked)} disabled={truncate} />
                  upsert on duplicate key {engine === 'mysql' ? '(update)' : '(skip)'}
                </label>
              )}
              {mode === 'existing' && engine === 'sqlserver' && (
                <span className="dv-desc" title="MERGE needs the key columns; the importer knows the CSV's column list">
                  no upsert — T-SQL's is MERGE, which needs a key. Import into a staging table
                  and MERGE from it.
                </span>
              )}
              <label className="gsp-check">
                <input type="checkbox" checked={nullEmpty} onChange={e => setNullEmpty(e.target.checked)} />
                empty cells → NULL
              </label>
              <span className="dv-desc">
                {activeCols.length} column{activeCols.length === 1 ? '' : 's'} · transactional (rolls back on any error)
              </span>
            </div>

            {createSql && <pre className="dg-sql">{createSql};</pre>}

            {progress && (
              <div className="dg-progress">
                <div className="dg-progress-bar">
                  <div className="dg-progress-fill" style={{ width: `${progress.pct}%` }} />
                </div>
                <span>{progress.rows.toLocaleString()} rows</span>
              </div>
            )}
            {summary && <div className="dg-summary">{summary}</div>}

            <div className="row-actions">
              <button className="toolbar-btn" onClick={() => { setSummary(null); setStep(2); }} disabled={!!progress}>← Back</button>
              <button className="primary" onClick={run} disabled={!!progress}>
                {progress ? 'Importing…' : `▶ Import ${fileName || 'file'}`}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
