/**
 * Result-set persistence — the save dialog, clipboard, xlsx/parquet writers.
 * Split out of `exporters.ts` (WP-08 8.9) so the serializers stay pure and
 * node-testable per the repo's utils contract; this is the half that is
 * allowed to import Tauri.
 */
import { basename, defaultEol } from './platform.ts';
import { bytesToBase64 } from './base64.ts';
import { getPref, PREFS } from '../store/preferences.ts';
import { invoke, Channel } from '@tauri-apps/api/core';
import { save } from '@tauri-apps/plugin-dialog';
import {
  FORMAT_EXT, FORMAT_LABELS, serialize, toTsv, withEol,
  type Cells, type ExportFormat,
} from './exporters.ts';
import { geoExportStatus, type GeoExportEvent } from './duckdbGeoExport.ts';
import { clearTabActivities, panelTabKey, setActivity } from '../store/tabActivity.ts';

/** Open native save dialog and write `contents`; returns saved path or null if cancelled. */
export async function saveTextAs(
  contents: string,
  defaultName: string,
  filterName: string,
  extensions: string[],
): Promise<string | null> {
  const path = await save({
    defaultPath: defaultName,
    filters: [{ name: filterName, extensions }],
  });
  if (!path) return null;
  const mode = getPref(PREFS.exportEol);
  const eol = mode === 'platform' ? defaultEol() : mode === 'crlf' ? '\r\n' : '\n';
  await invoke('write_text_file', { path, contents: withEol(contents, eol) });
  return path;
}


export async function exportAs(
  format: ExportFormat,
  columns: string[],
  rows: Cells,
  baseName = 'result',
  engine = 'mysql',
): Promise<string | null> {
  const ext = FORMAT_EXT[format];
  return saveTextAs(serialize(format, columns, rows, baseName, engine), `${baseName}.${ext}`, FORMAT_LABELS[format], [ext]);
}


export async function copyToClipboard(text: string): Promise<void> {
  await navigator.clipboard.writeText(text);
}


/** Save a real .xlsx via the native dialog. Lazy-loads the writer. */
export async function exportXlsx(
  columns: string[],
  rows: Cells,
  baseName = 'result',
): Promise<string | null> {
  const { toXlsx } = await import('./xlsx');
  const bytes = toXlsx(columns, rows, baseName);
  const path = await save({
    defaultPath: `${baseName}.xlsx`,
    filters: [{ name: 'Excel workbook', extensions: ['xlsx'] }],
  });
  if (!path) return null;
  await invoke('write_binary_file', { path, contentsBase64: bytesToBase64(bytes) });
  return path;
}


/** Copy with a text/html flavor so Excel / Numbers / Sheets paste real cells
 *  (plain-text flavor carries TSV for terminals and editors). */
export async function copyForExcel(columns: string[], rows: Cells): Promise<void> {
  const { toHtmlTable } = await import('./xlsx');
  const html = toHtmlTable(columns, rows);
  const tsv = toTsv(columns, rows);
  await navigator.clipboard.write([
    new ClipboardItem({
      'text/html': new Blob([html], { type: 'text/html' }),
      'text/plain': new Blob([tsv], { type: 'text/plain' }),
    }),
  ]);
}


/**
 * Write the grid to a NEW Parquet file via the native save dialog.
 *
 * This is how a Parquet file gets created: the format is immutable, so
 * "create" means "write once, completely" — and a result set is the thing
 * worth writing. Types are inferred column-wide in Rust (a column with one
 * string among its integers is a string column, not a truncated one).
 *
 * Returns the path written, or null if the dialog was cancelled.
 */
export async function exportParquet(
  columns: string[],
  rows: Cells,
  baseName = 'result',
): Promise<string | null> {
  const path = await save({
    defaultPath: `${baseName}.parquet`,
    filters: [{ name: 'Parquet', extensions: ['parquet'] }],
  });
  if (!path) return null;
  // Values go over as-is rather than as text: the writer needs the real JSON
  // types to pick Int64/Float64/Boolean/Utf8, and cellText() would make
  // everything a string.
  await invoke<number>('write_parquet_file', { path, columns, rows });
  return path;
}


/** What the backend reports after a server-side GeoParquet export. */
export interface GeoParquetExportOutcome {
  path: string;
  rowsWritten: number;
  bytes: number;
}

/**
 * GeoParquet via the engine, not the grid: `duckdb_export_geoparquet`
 * re-runs the result's source statement as `COPY (<sql>) TO '…' (FORMAT
 * PARQUET)` on the session's own DuckDB connection, so GEOMETRY columns keep
 * their type and the spatial extension writes the GeoParquet 1.1 `geo`
 * footer — where `exportParquet` above would persist the hex-text cells the
 * grid received. Re-running also exports the FULL result, not the row-capped
 * preview the grid holds. Availability is the caller's job — the predicate is
 * utils/duckdbGeoExport.geoParquetVerdict, and the backend re-checks it
 * (write rejection, one statement, spatial probed from the engine catalog).
 *
 * Returns the outcome, or null if the save dialog was cancelled.
 */
export async function exportGeoParquetServer(
  sessionId: string,
  sql: string,
  baseName = 'result',
): Promise<GeoParquetExportOutcome | null> {
  const path = await save({
    defaultPath: `${baseName}.parquet`,
    filters: [{ name: 'GeoParquet', extensions: ['parquet'] }],
  });
  if (!path) return null;
  // The COPY can run long and the engine reports no row percentage, so the
  // running-tasks indicator shows the phase and the output file's growth —
  // registered under the session (not one tab): the export outlives its tab.
  const activityKey = panelTabKey(sessionId, 'geoparquet-export');
  const chan = new Channel<GeoExportEvent>();
  chan.onmessage = ev => {
    setActivity(activityKey, {
      id: 'export',
      label: `GeoParquet export · ${basename(path)}`,
      detail: geoExportStatus(ev),
      survives: true,
    });
  };
  try {
    return await invoke<GeoParquetExportOutcome>('duckdb_export_geoparquet',
      { sessionId, sql, outPath: path, onEvent: chan });
  } finally {
    clearTabActivities(activityKey);
  }
}
