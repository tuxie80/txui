/**
 * Human-friendly duration rendering for log lines (DataGrip style):
 *   < 1 s    → "118 ms"
 *   < 1 min  → "1 s 524 ms"   (ms part dropped when 0 → "2 s")
 *   ≥ 1 min  → "2 min 3 s"    (s part dropped when 0 → "2 min")
 * `fmtDurationCompact` is the gutter-sized sibling (run markers).
 * Pure: no React/Tauri imports — unit-tested with node --test.
 */
export function fmtDuration(ms: number): string {
  const v = Math.max(0, Math.round(ms));
  if (v < 1000) return `${v} ms`;
  if (v < 60_000) {
    const s = Math.floor(v / 1000);
    const rem = v % 1000;
    return rem === 0 ? `${s} s` : `${s} s ${rem} ms`;
  }
  const m = Math.floor(v / 60_000);
  const s = Math.round((v % 60_000) / 1000);
  return s === 0 ? `${m} min` : `${m} min ${s} s`;
}

/**
 * Gutter-sized duration rendering for the per-statement run markers — the full
 * "1 s 524 ms" would never fit beside a line number. FIXED precision, so the
 * ticking counter never jumps shape, only digits:
 *   < 1 s    → "412ms"    (integer ms)
 *   < 1 min  → "1.0s"     (always one decimal — "5.0s", never "5s" vs "1.5s")
 *   ≥ 1 min  → "2m03s"    (zero-padded seconds)
 */
export function fmtDurationCompact(ms: number): string {
  const v = Math.max(0, Math.round(ms));
  if (v < 1000) return `${v}ms`;
  const tenths = Math.round(v / 100);
  if (tenths < 600) return `${(tenths / 10).toFixed(1)}s`;
  let m = Math.floor(v / 60_000);
  let s = Math.round((v % 60_000) / 1000);
  if (s === 60) { m++; s = 0; }
  return `${m}m${String(s).padStart(2, '0')}s`;
}
