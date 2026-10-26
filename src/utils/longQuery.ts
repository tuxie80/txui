/** Long-query helpers shared by Processes and the incident timeline. */

/** 'warn' at >= threshold, 'danger' at >= 2× threshold, '' below. */
export function longClass(timeSecs: number, thresholdSecs: number): '' | 'warn' | 'danger' {
  if (!Number.isFinite(timeSecs) || thresholdSecs <= 0 || timeSecs < thresholdSecs) return '';
  return timeSecs >= thresholdSecs * 2 ? 'danger' : 'warn';
}

/** One-line, whitespace-collapsed SQL capped at `max` chars (with an ellipsis). */
export function truncateSql(sql: string, max = 160): string {
  const one = sql.replace(/\s+/g, ' ').trim();
  return one.length > max ? one.slice(0, max - 1) + '…' : one;
}
