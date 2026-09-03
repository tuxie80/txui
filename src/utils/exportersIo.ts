/**
 * Result-set persistence — the save dialog, clipboard, xlsx/parquet writers.
 * Split out of `exporters.ts` (WP-08 8.9) so the serializers stay pure and
 * node-testable per the repo's utils contract; this is the half that is
 * allowed to import Tauri.
 */
import { defaultEol } from './platform.ts';
import { getPref, PREFS } from '../store/preferences.ts';
import { invoke } from '@tauri-apps/api/core';
import { save } from '@tauri-apps/plugin-dialog';
import {
  FORMAT_EXT, FORMAT_LABELS, serialize, toTsv, withEol,
  type Cells, type ExportFormat,
} from './exporters.ts';

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
  await invoke('write_binary_file', { path, contents: Array.from(bytes) });
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
