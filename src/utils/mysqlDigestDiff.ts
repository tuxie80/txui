/**
 * MySQL statement-digest snapshots → diff, the MySQL twin of pgssDiff.
 *
 * `performance_schema.events_statements_summary_by_digest` is cumulative: it
 * ranks what has been expensive since the counters were last reset, but never
 * answers "which statements got slower since this morning". Capturing
 * timestamped snapshots and diffing two of them by DIGEST turns it into a
 * per-window "what changed" list.
 *
 * Pure and dependency-free — driven by node --test. The panel does the capture
 * and rendering; the arithmetic lives here.
 */

export interface DigestRow {
  digest: string;
  text: string;
  count: number;
  /** Total latency in ms (SUM_TIMER_WAIT is picoseconds; the SQL divides by 1e9). */
  totalMs: number;
  rowsExamined: number;
}

export interface DigestSnapshot {
  at: number; // ms epoch, stamped by the caller
  rows: DigestRow[];
}

export interface DigestDelta {
  digest: string;
  text: string;
  dCount: number;
  dTotalMs: number;
  dRows: number;
  /** Average ms per execution over the window. */
  avgMs: number;
}

/** The read-only capture query. Ordered/limited by the panel as needed. */
export const DIGEST_SNAPSHOT_SQL =
  'SELECT DIGEST, DIGEST_TEXT, COUNT_STAR, ROUND(SUM_TIMER_WAIT/1e9, 3) AS total_ms, SUM_ROWS_EXAMINED'
  + ' FROM performance_schema.events_statements_summary_by_digest'
  + ' WHERE DIGEST IS NOT NULL';

/** Parse the raw grid rows the capture query returns into typed DigestRows. */
export function parseDigestRows(rows: unknown[][]): DigestRow[] {
  return rows.map(r => ({
    digest: String(r[0] ?? ''),
    text: String(r[1] ?? ''),
    count: Number(r[2] ?? 0),
    totalMs: Number(r[3] ?? 0),
    rowsExamined: Number(r[4] ?? 0),
  })).filter(r => r.digest);
}

/**
 * Diff two snapshots by DIGEST. Only digests whose counters advanced appear;
 * a negative delta (counters reset, or the digest aged out and came back) is
 * treated as "no change" rather than a misleading spike. Sorted by the time
 * the window spent in each — the incident question.
 */
export function diffDigests(before: DigestSnapshot, after: DigestSnapshot): DigestDelta[] {
  const prev = new Map(before.rows.map(r => [r.digest, r]));
  const out: DigestDelta[] = [];
  for (const a of after.rows) {
    const b = prev.get(a.digest);
    const dCount = a.count - (b?.count ?? 0);
    const dTotalMs = a.totalMs - (b?.totalMs ?? 0);
    const dRows = a.rowsExamined - (b?.rowsExamined ?? 0);
    if (dCount <= 0 && dTotalMs <= 0) continue;
    out.push({
      digest: a.digest,
      text: a.text,
      dCount: Math.max(0, dCount),
      dTotalMs: Math.max(0, dTotalMs),
      dRows: Math.max(0, dRows),
      avgMs: dCount > 0 ? dTotalMs / dCount : 0,
    });
  }
  out.sort((x, y) => y.dTotalMs - x.dTotalMs);
  return out;
}
