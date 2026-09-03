/**
 * Google Sheets export — PURE payload shaping (no React/Tauri imports,
 * node-testable per the repo's utils contract). The modal (`GSheetsModal.tsx`)
 * holds the I/O; this module decides what a cell becomes and when a grid is
 * too big to send.
 *
 * Cell typing mirrors the backend (`commands/gsheets.rs::cell`): strings,
 * numbers and booleans pass through so Sheets types them; null becomes an
 * empty cell; arrays/objects (JSON columns) become their JSON text.
 */

export type SheetsScalar = string | number | boolean;

/** (rows + header) × columns ceiling — beyond this the request is either
 *  rejected by the API anyway or takes minutes; refuse early with a number. */
export const MAX_SHEETS_CELLS = 2_000_000;

/** What one grid cell becomes in the Sheets values payload. */
export function sheetsCell(v: unknown): SheetsScalar {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v;
  return JSON.stringify(v);
}

/** Header + rows as Sheets values. Throws when the grid exceeds MAX_SHEETS_CELLS. */
export function buildSheetValues(columns: string[], rows: unknown[][]): SheetsScalar[][] {
  const cells = (rows.length + 1) * Math.max(columns.length, 1);
  if (cells > MAX_SHEETS_CELLS) {
    throw new Error(
      `Too much data for one Sheets write: ${rows.length} rows × ${columns.length} columns ` +
      `is ${cells.toLocaleString()} cells (limit ${MAX_SHEETS_CELLS.toLocaleString()}). ` +
      'Export to CSV or Parquet instead, or narrow the result first.',
    );
  }
  return [columns.map(c => String(c)), ...rows.map(row => row.map(sheetsCell))];
}

/**
 * A tab name Sheets will accept: no [ ] : * ? / \\ anywhere, ≤ 100 chars,
 * never empty. Illegal characters are removed (not replaced) so
 * "orders[2026]" becomes "orders2026".
 */
export function sanitizeSheetName(raw: string): string {
  const cleaned = raw.replace(/[[\]:*?/\\]/g, '').trim().slice(0, 100);
  return cleaned || 'Sheet1';
}
