/**
 * Find-in-results (⌘F in FastGrid) — the cell scan behind the match list.
 *
 * Pure and dependency-free so it is unit-testable without a DOM. Two honest
 * caps, both reported rather than silent:
 *  - MATCH_CAP bounds matches FOUND (the scroll rail and the n/N counter).
 *  - CELL_CAP bounds cells SCANNED — a no-match query on a 100k×20 result
 *    otherwise walks 2M cells per debounced keystroke. When it trips, the
 *    grid says "first N cells scanned" next to the count.
 *
 * Object cells (JSON columns) are searched as their JSON.stringify text —
 * the same serialization the grid displays (utils/exporters cellText) — so a
 * JSON cell is findable instead of matching nothing but "[object Object]".
 */

export interface FindMatch { r: number; c: number }

export interface FindScan {
  matches: FindMatch[];
  /** cells actually examined before stopping (a cap hit or grid exhausted) */
  scanned: number;
  /** true when a cap stopped the scan before the whole grid was covered */
  capped: boolean;
  /** true when MATCH_CAP stopped the collection early */
  matchesCapped: boolean;
}

export const FIND_MATCH_CAP = 5000;
export const FIND_CELL_CAP = 250_000;

/** The text a cell is searched as — null cells are skipped by the scan. */
function cellSearchText(v: unknown): string {
  return typeof v === 'object' ? JSON.stringify(v) : String(v);
}

/**
 * Case-insensitive substring scan of rows × columns, row-major. An empty
 * (or whitespace) query scans nothing and matches nothing.
 */
export function scanCells(
  rows: unknown[][],
  nCols: number,
  query: string,
  matchCap: number = FIND_MATCH_CAP,
  cellCap: number = FIND_CELL_CAP,
): FindScan {
  const q = query.trim().toLowerCase();
  const out: FindMatch[] = [];
  if (!q) return { matches: out, scanned: 0, capped: false, matchesCapped: false };
  let scanned = 0;
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    for (let c = 0; c < nCols; c++) {
      if (scanned >= cellCap) {
        return { matches: out, scanned, capped: true, matchesCapped: out.length >= matchCap };
      }
      scanned++;
      const v = row[c];
      if (v === null || v === undefined) continue;
      if (cellSearchText(v).toLowerCase().includes(q)) {
        out.push({ r, c });
        if (out.length >= matchCap) {
          return { matches: out, scanned, capped: true, matchesCapped: true };
        }
      }
    }
  }
  return { matches: out, scanned, capped: false, matchesCapped: out.length >= matchCap };
}
