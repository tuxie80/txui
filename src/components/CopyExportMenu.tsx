/**
 * Copy ▾ / Export ▾ dropdowns for any grid surface.
 * Operates on the current selection when one exists, else the full result —
 * and every format includes the column header (ASCII/Markdown tables get the
 * full ruled header even for a mid-result selection).
 */
import { errorDisplay } from '../utils/appError';
import { useEffect, useRef, useState } from 'react';
import { serialize, FORMAT_LABELS, COPY_CONFIRM_ROWS, copyConfirmMessage } from '../utils/exporters';
import { confirmDialog } from '../utils/appDialog';
import { exportAs, copyToClipboard, copyForExcel, exportXlsx, exportParquet, exportGeoParquetServer } from '../utils/exportersIo';
import type { ExportFormat } from '../utils/exporters';
import { basename } from '../utils/platform';
import { geoParquetVerdict } from '../utils/duckdbGeoExport';
import { useDuckdbSpatial } from '../store/duckdbSpatial';
import { addLog } from '../store/logStore';
import { redactSecrets } from '../utils/redactSecrets';
import { fmtBytes } from '../utils/syncLog';
import { GSheetsModal } from './GSheetsModal';

const FORMATS: ExportFormat[] = [
  'tsv', 'csv', 'json', 'ascii', 'markdown', 'insert', 'html', 'xml', 'latex',
];

interface Props {
  getData: () => { columns: string[]; rows: unknown[][] };
  /** Used for INSERT statements + export file name */
  tableName?: string;
  /** Dialect for the INSERT format (identifier quoting + literal escaping).
   *  Pass the active connection's engine; defaults to MySQL. */
  engine?: string;
  hasSelection?: boolean;
  onNote?: (msg: string) => void;
  /**
   * Server-side GeoParquet export (DuckDB + spatial only) needs three things
   * a bare grid does not have: the session, the statement that produced this
   * result (it is RE-RUN as `COPY (<sql>) TO …` — so the export is the full
   * result, not the row-capped preview), and the result's column type names
   * (to know a GEOMETRY column is present). Absent → the entry stays away.
   */
  sessionId?: string;
  sourceSql?: string;
  columnTypes?: string[];
}

export function CopyExportMenu({ getData, tableName = 'result', engine = 'mysql', hasSelection, onNote,
  sessionId, sourceSql, columnTypes }: Props) {
  const [open, setOpen] = useState<'copy' | 'export' | null>(null);
  const [gsheetsOpen, setGsheetsOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const duckdbSpatial = useDuckdbSpatial(sessionId ?? '');

  /**
   * Copy serialization is synchronous main-thread work; above the threshold
   * the menu asks before freezing the UI on a full-result copy.
   */
  async function confirmLargeCopy(rows: number): Promise<boolean> {
    return rows <= COPY_CONFIRM_ROWS
      || confirmDialog(copyConfirmMessage(rows), { title: 'Copy' });
  }

  /**
   * File → Export Results… opens this dropdown rather than exporting.
   *
   * The format is the user's choice, and the menu deliberately does not make
   * it for them: an "Export" that silently picks CSV is a different feature
   * from the button next to the grid, and two ways to export that disagree is
   * how one of them ends up wrong.
   *
   * Several grids can be mounted at once (a browser tab per table, panels
   * behind the active one). `offsetParent === null` is true for anything not
   * being displayed, so only the visible one answers — without this every
   * hidden grid would open its dropdown too.
   */
  useEffect(() => {
    const onExport = () => {
      if (rootRef.current?.offsetParent == null) return;
      setOpen('export');
    };
    window.addEventListener('dbgui:grid-export', onExport);
    return () => window.removeEventListener('dbgui:grid-export', onExport);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(null);
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [open]);

  async function handleCopy(format: ExportFormat) {
    setOpen(null);
    try {
      const { columns, rows } = getData();
      if (!await confirmLargeCopy(rows.length)) return;
      await copyToClipboard(serialize(format, columns, rows, tableName, engine));
      onNote?.(`Copied ${rows.length} row${rows.length === 1 ? '' : 's'} as ${FORMAT_LABELS[format]}`);
    } catch (e) {
      onNote?.(`Copy failed: ${errorDisplay(e)}`);
    }
  }

  async function handleExport(format: ExportFormat) {
    setOpen(null);
    try {
      const { columns, rows } = getData();
      const path = await exportAs(format, columns, rows, tableName, engine);
      if (path) onNote?.(`Saved ${basename(path)}`);
    } catch (e) {
      onNote?.(`Export failed: ${errorDisplay(e)}`);
    }
  }

  /**
   * The one predicate both the rendering and the handler use — the house rule
   * (greyed + explained, handler guarded by the same check, never `disabled`).
   */
  const geoVerdict = geoParquetVerdict({
    engine, sourceSql, columnTypes: columnTypes ?? [], spatial: duckdbSpatial,
  });

  /**
   * GeoParquet via the engine: the source statement is re-run server-side as
   * COPY (<sql>) TO …, so GEOMETRY columns keep their type and the file gets
   * the GeoParquet 1.1 `geo` footer — the client-side Parquet export above
   * can only persist the hex-text cells the grid received.
   */
  async function handleGeoParquet() {
    if (!geoVerdict.ok) { onNote?.(geoVerdict.tip); return; }
    if (!sessionId || !sourceSql) return; // the verdict's ok implies both
    setOpen(null);
    // Redacted copy for LOG output only — the executed SQL is the original.
    const oneLine = redactSecrets(sourceSql).replace(/\s+/g, ' ').trim();
    const t0 = performance.now();
    try {
      const r = await exportGeoParquetServer(sessionId, sourceSql, tableName);
      if (!r) return; // save dialog cancelled — nothing happened, nothing to say
      addLog(sessionId, {
        level: 'info', action: 'EXPORT', detail: oneLine,
        line: `> COPY (${oneLine}) TO '${r.path}' (FORMAT PARQUET) — GeoParquet export`,
      });
      addLog(sessionId, {
        level: 'ok', action: 'EXPORT', detail: r.path, rows: r.rowsWritten,
        ms: Math.round(performance.now() - t0),
        line: `${r.rowsWritten} row${r.rowsWritten === 1 ? '' : 's'} written to ${basename(r.path)} (${fmtBytes(r.bytes)}, GeoParquet)`,
      });
      onNote?.(`Wrote ${basename(r.path)} — ${r.rowsWritten} row${r.rowsWritten === 1 ? '' : 's'}, ${fmtBytes(r.bytes)}`);
    } catch (e) {
      const msg = errorDisplay(e);
      addLog(sessionId, { level: 'err', action: 'EXPORT', detail: msg, line: `! GeoParquet export failed: ${msg}` });
      onNote?.(`Export failed: ${msg}`);
    }
  }

  const scope = hasSelection ? 'selection' : 'all rows';

  return (
    <div className="cem-root" ref={rootRef}>
      <button
        className={`toolbar-btn ${open === 'copy' ? 'active' : ''}`}
        onClick={() => setOpen(open === 'copy' ? null : 'copy')}
        title={`Copy ${scope} to clipboard (header included)`}
      >Copy ▾</button>
      <button
        className={`toolbar-btn ${open === 'export' ? 'active' : ''}`}
        onClick={() => setOpen(open === 'export' ? null : 'export')}
        title={`Export ${scope} to a file`}
      >Export ▾</button>

      {open && (
        <div className="cem-menu">
          <div className="cem-scope">{open === 'copy' ? 'Copy' : 'Export'} {scope}</div>
          {FORMATS.map(f => (
            <button
              key={f}
              className="cem-item"
              onClick={() => (open === 'copy' ? handleCopy(f) : handleExport(f))}
            >{FORMAT_LABELS[f]}</button>
          ))}
          {open === 'copy' && (
            <button className="cem-item" onClick={async () => {
              setOpen(null);
              try {
                const { columns, rows } = getData();
                if (!await confirmLargeCopy(rows.length)) return;
                await copyForExcel(columns, rows);
                onNote?.(`Copied ${rows.length} row${rows.length === 1 ? '' : 's'} for Excel`);
              } catch (e) { onNote?.(`Copy failed: ${errorDisplay(e)}`); }
            }}>For Excel / Sheets</button>
          )}
          {open === 'export' && (
            <button className="cem-item" onClick={async () => {
              setOpen(null);
              try {
                const { columns, rows } = getData();
                const path = await exportXlsx(columns, rows, tableName);
                if (path) onNote?.(`Saved ${basename(path)}`);
              } catch (e) { onNote?.(`Export failed: ${errorDisplay(e)}`); }
            }}>Excel (.xlsx)</button>
          )}
          {open === 'export' && (
            <button className="cem-item" onClick={async () => {
              setOpen(null);
              try {
                const { columns, rows } = getData();
                const path = await exportParquet(columns, rows, tableName);
                if (path) onNote?.(`Wrote ${basename(path)} — ${rows.length} row${rows.length === 1 ? '' : 's'}`);
              } catch (e) { onNote?.(`Export failed: ${errorDisplay(e)}`); }
            }}>Parquet (.parquet)</button>
          )}
          {/* GeoParquet needs the engine, not the grid rows — DuckDB sessions
              only, and blocked states are shown greyed with the reason on
              hover (never hidden, never `disabled`). */}
          {open === 'export' && engine === 'duckdb' && sessionId && (
            geoVerdict.ok ? (
              <button
                className="cem-item"
                title="Re-runs this result's query server-side as COPY (<sql>) TO … (FORMAT PARQUET) — the file keeps the GEOMETRY type and the GeoParquet 1.1 footer, and holds the full result, not the row-capped preview"
                onClick={handleGeoParquet}
              >GeoParquet (server-side)…</button>
            ) : (
              <span className="unavail" style={{ display: 'contents' }} data-tip={geoVerdict.tip}>
                <button className="cem-item" tabIndex={-1} onClick={handleGeoParquet}>GeoParquet (server-side)…</button>
              </span>
            )
          )}
          {open === 'export' && (
            <button className="cem-item" onClick={() => {
              setOpen(null);
              setGsheetsOpen(true);
            }}>Google Sheets…</button>
          )}
        </div>
      )}
      {gsheetsOpen && (
        <GSheetsModal getData={getData} tableName={tableName} onClose={() => setGsheetsOpen(false)} />
      )}
    </div>
  );
}
