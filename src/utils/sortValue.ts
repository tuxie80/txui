/**
 * Parse a display string into a comparable magnitude so grids sort
 * human-formatted values correctly (e.g. `500.00 us` < `1.23 ms` < `2.1 s`),
 * instead of lexicographically by first character.
 *
 * Recognises MySQL sys-style time units (ps/ns/us/µs/ms/s/min/h) → picoseconds,
 * and byte units (B/KiB/MiB/GiB/TiB/PiB, decimal KB/MB/GB…) → bytes, plus plain
 * numbers with thousands separators. Returns null when it isn't a magnitude.
 */
const TIME_PS: Record<string, number> = {
  ps: 1, ns: 1e3, us: 1e6, 'µs': 1e6, ms: 1e9, s: 1e12, sec: 1e12,
  min: 6e13, h: 3.6e15, hr: 3.6e15,
};
const BYTES: Record<string, number> = {
  b: 1,
  kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3, tib: 1024 ** 4, pib: 1024 ** 5,
  kb: 1e3, mb: 1e6, gb: 1e9, tb: 1e12, pb: 1e15,
};

export function parseMagnitude(raw: string): number | null {
  const s = raw.trim();
  if (!s) return null;
  const m = /^(-?[\d,]*\.?\d+)\s*([a-zµ]+)?$/i.exec(s);
  if (!m) return null;
  const num = parseFloat(m[1].replace(/,/g, ''));
  if (!Number.isFinite(num)) return null;
  const unit = (m[2] ?? '').toLowerCase();
  if (!unit) return num;                       // plain number (possibly with commas)
  if (unit in TIME_PS) return num * TIME_PS[unit];
  if (unit in BYTES) return num * BYTES[unit];
  return null;                                 // unknown unit → fall back to text
}

/** Comparator helper: numeric when both parse as magnitudes, else locale text. */
export function compareCells(a: unknown, b: unknown): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  const sa = String(a), sb = String(b);
  const ma = parseMagnitude(sa), mb = parseMagnitude(sb);
  if (ma !== null && mb !== null) return ma - mb;
  return sa.localeCompare(sb, undefined, { numeric: true });
}

/**
 * Precomputed sort key for one cell. Sorting a million-row grid through
 * compareCells re-parses each cell O(log n) times inside the comparator;
 * computing the key once per cell up front (Schwartzian transform) keeps the
 * identical ordering for O(n) parses total. `null` marks NULL/undefined,
 * which the grid sorts last.
 */
export interface CellSortKey { mag: number | null; text: string }

export function cellSortKey(v: unknown): CellSortKey | null {
  if (v === null || v === undefined) return null;
  const text = String(v);
  if (typeof v === 'number') {
    return { mag: Number.isFinite(v) ? v : null, text };
  }
  return { mag: parseMagnitude(text), text };
}

/** Ordering equivalent of compareCells for keys built by cellSortKey. */
export function compareCellKeys(a: CellSortKey, b: CellSortKey): number {
  if (a.mag !== null && b.mag !== null) return a.mag - b.mag;
  return a.text.localeCompare(b.text, undefined, { numeric: true });
}
