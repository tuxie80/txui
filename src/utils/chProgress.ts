// Live ClickHouse query progress — the payload of the backend's
// `dbgui:ch-progress` event, plus the pure formatters the running-query
// indicator uses to render it. ClickHouse is the only engine that streams a
// running query's read counters (via `X-ClickHouse-Progress` HTTP headers /
// `system.processes`), so this is deliberately CH-specific.
//
// Everything here is pure and dependency-free so it can be unit-tested without
// a DOM or a backend.

/** One `dbgui:ch-progress` event, tagged with the tab that started the run. */
export interface ChProgressEvent {
  sessionId: string;
  tabId: number;
  /** Rows read so far. */
  readRows: number;
  /** Uncompressed bytes read so far. */
  readBytes: number;
  /** Estimated total rows to read; 0 when the server cannot estimate it. */
  totalRows: number;
  /** Nanoseconds elapsed on the server. */
  elapsedNs: number;
}

/**
 * Compact count, e.g. `999`, `12.3K`, `67.4M`, `2B`. Keeps three significant
 * figures without a trailing `.0`, so a running count reads at a glance.
 */
export function formatCount(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0';
  if (n < 1000) return String(Math.round(n));
  const units = [
    { v: 1e9, s: 'B' },
    { v: 1e6, s: 'M' },
    { v: 1e3, s: 'K' },
  ];
  for (const { v, s } of units) {
    if (n >= v) {
      const scaled = n / v;
      const text = scaled >= 100 ? Math.round(scaled).toString() : trimZeros(scaled.toFixed(1));
      return `${text}${s}`;
    }
  }
  return String(Math.round(n));
}

/** Human byte size, binary units (KB/MB/GB/TB), one decimal below 100. */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  const text = i === 0 ? String(Math.round(v)) : v >= 100 ? Math.round(v).toString() : trimZeros(v.toFixed(1));
  return `${text} ${units[i]}`;
}

/**
 * Percent read, `0`–`100`, or `null` when there is no usable total (older
 * ClickHouse, or a query whose scan the server cannot estimate). Clamped so a
 * late-arriving over-estimate never shows 103%.
 */
export function progressPercent(read: number, total: number): number | null {
  if (!Number.isFinite(read) || !Number.isFinite(total) || total <= 0 || read < 0) return null;
  return Math.min(100, Math.max(0, Math.round((read / total) * 100)));
}

/**
 * One-line indicator text, e.g. `1.4B rows · 11.4 GB · 71%`. The percent is
 * dropped when unavailable, so the string degrades to rows + bytes rather than
 * showing a misleading `0%`.
 */
export function formatChProgress(p: Pick<ChProgressEvent, 'readRows' | 'readBytes' | 'totalRows'>): string {
  const parts = [`${formatCount(p.readRows)} rows`, formatBytes(p.readBytes)];
  const pct = progressPercent(p.readRows, p.totalRows);
  if (pct !== null) parts.push(`${pct}%`);
  return parts.join(' · ');
}

function trimZeros(s: string): string {
  return s.replace(/\.0$/, '');
}
