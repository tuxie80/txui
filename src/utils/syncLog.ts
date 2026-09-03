/**
 * The run log — what a sync did, in a form you can read during and audit after.
 *
 * A copy of a large database runs for a long time with almost nothing visible
 * happening, and the two questions people actually ask are *"is it stuck?"* and
 * later *"what exactly did it do?"*. Those want different things from a log:
 * the first wants the last line, the second wants all of them, grep-able, with
 * every decision recorded rather than only every error.
 *
 * So each event carries **structure** (for filtering, counting and the report)
 * and **one canonical line** (for reading and exporting), in the same shape the
 * rest of the app already uses in `store/logStore`:
 *
 *   [2026-08-08 14:48:42] ▸ analyse  db.orders  sampled 1,000 rows: mean 80 B
 *   [2026-08-08 14:48:43] ✓ data     db.orders  50,000 rows in 1 s 204 ms
 *   [2026-08-08 14:48:51] ⚠ adapt    db.orders  rows averaged 4,102 B — lowering
 *
 * Two rules that are easy to get wrong and expensive to get wrong:
 *
 * **Decisions are logged, not just outcomes.** "chunk size lowered to 12,000
 * because rows averaged 4 KB" is the line that explains a slow run six months
 * later. Logging only errors produces a file that is empty exactly when
 * somebody needs to understand what happened.
 *
 * **Per-chunk noise is summarised, not emitted.** A 500-chunk table logging
 * every chunk buries the four lines that matter. Chunks are counted and
 * reported per table; only the ones that were slow or adapted get a line.
 *
 * Pure and dependency-free — driven by `node --test`.
 */

export type LogLevel = 'info' | 'ok' | 'warn' | 'error';

export type LogKind =
  | 'run'        // start / finish of the whole operation
  | 'analyse'    // sampling, sizing decisions
  | 'schema'     // DDL applied
  | 'data'       // a table's rows
  | 'adapt'      // chunk size changed
  | 'indexes'    // rebuild
  | 'verify'     // checks and their verdicts
  | 'position'   // replication coordinates captured
  | 'skip'       // something deliberately not done
  | 'error';

export interface SyncLogEvent {
  at: number;
  level: LogLevel;
  kind: LogKind;
  /** `schema.table`, or absent for run-wide events. */
  target?: string;
  /** The sentence. Written to be read on its own. */
  message: string;
  /** Structured extras — counted and filtered, never parsed back out of text. */
  rows?: number;
  bytes?: number;
  ms?: number;
}

const GLYPH: Record<LogLevel, string> = {
  info: '▸', ok: '✓', warn: '⚠', error: '✗',
};

const p = (n: number, w = 2) => String(n).padStart(w, '0');

/** Width of the target column. */
export const TARGET_WIDTH = 28;

/**
 * Pad or truncate to a fixed width, keeping the END of an over-long name.
 *
 * The tail is the informative part: `…orders_line_items_archive` identifies the
 * table, while `very_long_schema_name_prod…` identifies the schema everything
 * in the run already shares.
 */
export function fitColumn(text: string, width: number): string {
  if (text.length <= width) return text.padEnd(width);
  return '…' + text.slice(text.length - (width - 1));
}

/** `[YYYY-MM-DD HH:MM:SS]` — the prefix the rest of the app already uses. */
export function stamp(at: number): string {
  const d = new Date(at);
  return `[${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} `
    + `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}]`;
}

/** `1 s 204 ms` / `643 ms` / `2 min 3 s`. */
export function fmtMs(ms: number): string {
  const v = Math.max(0, Math.round(ms));
  if (v < 1000) return `${v} ms`;
  if (v < 60_000) {
    const s = Math.floor(v / 1000);
    const r = v % 1000;
    return r === 0 ? `${s} s` : `${s} s ${r} ms`;
  }
  const m = Math.floor(v / 60_000);
  const s = Math.round((v % 60_000) / 1000);
  return s === 0 ? `${m} min` : `${m} min ${s} s`;
}

/** `1.5 MB` / `812 KB` / `40 B`. */
export function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/**
 * One event as one line.
 *
 * Columns are padded so a file of these can be scanned down rather than read
 * across — the kind, then the target, then the sentence, always in the same
 * places.
 */
export function formatLine(e: SyncLogEvent): string {
  const meta: string[] = [];
  if (e.rows !== undefined) meta.push(`${e.rows.toLocaleString()} rows`);
  if (e.bytes !== undefined) meta.push(fmtBytes(e.bytes));
  if (e.ms !== undefined) meta.push(fmtMs(e.ms));
  const tail = meta.length > 0 ? ` (${meta.join(', ')})` : '';
  // Truncated, not just padded: a 64-character schema and table would push the
  // message out of its column and the file stops being scannable down.
  const target = e.target ? ` ${fitColumn(e.target, TARGET_WIDTH)}` : ' '.repeat(TARGET_WIDTH + 1);
  return `${stamp(e.at)} ${GLYPH[e.level]} ${e.kind.padEnd(8)}${target} ${e.message}${tail}`;
}

/** The whole log as text, oldest first — what Export writes. */
export function formatLog(events: SyncLogEvent[]): string {
  return events.map(formatLine).join('\n') + (events.length > 0 ? '\n' : '');
}

// ── accumulating a run ───────────────────────────────────────────────────────

/** How many chunks a table may log individually before they are summarised. */
export const CHUNK_LOG_LIMIT = 3;

export interface TableTally {
  target: string;
  chunks: number;
  rows: number;
  bytes: number;
  ms: number;
  adaptations: number;
  /** Chunks that took more than this multiple of the table's mean. */
  slowChunks: number;
}

export function emptyTally(target: string): TableTally {
  return { target, chunks: 0, rows: 0, bytes: 0, ms: 0, adaptations: 0, slowChunks: 0 };
}

/** A chunk is "slow" at this multiple of the running mean. */
export const SLOW_CHUNK_FACTOR = 3;

export interface ChunkOutcome {
  rows: number;
  bytes: number;
  ms: number;
  adapted?: boolean;
}

/**
 * Fold one chunk into a table's tally, and decide whether it earns a line.
 *
 * The first few chunks are logged so a run shows movement immediately — a log
 * that stays silent for the first minute looks identical to one that has hung.
 * After that only the exceptional ones appear: an adaptation, or a chunk far
 * slower than the table's own mean.
 */
export function recordChunk(
  tally: TableTally,
  outcome: ChunkOutcome,
): { tally: TableTally; logIt: boolean; reason: string | null } {
  const meanBefore = tally.chunks > 0 ? tally.ms / tally.chunks : null;
  const slow = meanBefore !== null && outcome.ms > meanBefore * SLOW_CHUNK_FACTOR;

  const next: TableTally = {
    ...tally,
    chunks: tally.chunks + 1,
    rows: tally.rows + outcome.rows,
    bytes: tally.bytes + outcome.bytes,
    ms: tally.ms + outcome.ms,
    adaptations: tally.adaptations + (outcome.adapted ? 1 : 0),
    slowChunks: tally.slowChunks + (slow ? 1 : 0),
  };

  if (tally.chunks < CHUNK_LOG_LIMIT) {
    return { tally: next, logIt: true, reason: 'first chunks' };
  }
  if (outcome.adapted) return { tally: next, logIt: true, reason: 'chunk size changed' };
  if (slow) {
    return {
      tally: next, logIt: true,
      reason: `${fmtMs(outcome.ms)} against a ${fmtMs(meanBefore!)} mean`,
    };
  }
  return { tally: next, logIt: false, reason: null };
}

/**
 * The one line a finished table contributes.
 *
 * Carries the throughput because that is what a person compares between runs,
 * and names the adaptations because an unexplained slow table is the commonest
 * thing anyone comes back to ask about.
 */
export function tableSummary(tally: TableTally, at: number): SyncLogEvent {
  const rate = tally.ms > 0 ? Math.round(tally.rows / (tally.ms / 1000)) : null;
  const bits = [
    `${tally.chunks.toLocaleString()} chunk${tally.chunks === 1 ? '' : 's'}`,
    rate !== null ? `${rate.toLocaleString()} rows/s` : null,
    tally.adaptations > 0
      ? `${tally.adaptations} chunk-size change${tally.adaptations === 1 ? '' : 's'}`
      : null,
    tally.slowChunks > 0 ? `${tally.slowChunks} slow` : null,
  ].filter(Boolean);
  return {
    // Passed in, never read from the clock: a summary stamped with "now"
    // instead of the moment the table finished lands out of order in the log,
    // which is exactly where ordering matters most.
    at,
    level: tally.slowChunks > 0 ? 'warn' : 'ok',
    kind: 'data',
    target: tally.target,
    message: bits.join(' · '),
    rows: tally.rows,
    bytes: tally.bytes,
    ms: tally.ms,
  };
}

// ── the closing report ───────────────────────────────────────────────────────

export interface RunSummary {
  ok: boolean;
  headline: string;
  detail: string[];
}

/**
 * What the run says when it stops.
 *
 * Durability and correctness come first, counts second. A summary that leads
 * with "12 tables, 4.2 M rows" and mentions a failed verification third is one
 * that gets read as success.
 */
export function summariseRun(events: SyncLogEvent[]): RunSummary {
  const errors = events.filter(e => e.level === 'error');
  const warns = events.filter(e => e.level === 'warn');
  const verifyFails = events.filter(e => e.kind === 'verify' && e.level === 'error');
  const skips = events.filter(e => e.kind === 'skip');
  const data = events.filter(e => e.kind === 'data' && e.rows !== undefined);

  const rows = data.reduce((n, e) => n + (e.rows ?? 0), 0);
  const bytes = data.reduce((n, e) => n + (e.bytes ?? 0), 0);
  const tables = new Set(data.map(e => e.target)).size;

  const detail: string[] = [];
  if (verifyFails.length > 0) {
    detail.push(`${verifyFails.length} table${verifyFails.length === 1 ? '' : 's'} failed verification — `
      + 'the data on the target does not match the source.');
  }
  if (errors.length > verifyFails.length) {
    detail.push(`${errors.length - verifyFails.length} error${errors.length - verifyFails.length === 1 ? '' : 's'} during the run.`);
  }
  if (skips.length > 0) {
    detail.push(`${skips.length} object${skips.length === 1 ? '' : 's'} deliberately skipped — see the lines marked "skip".`);
  }
  if (warns.length > 0) {
    detail.push(`${warns.length} warning${warns.length === 1 ? '' : 's'}.`);
  }
  detail.push(`${rows.toLocaleString()} rows across ${tables} table${tables === 1 ? '' : 's'}`
    + (bytes > 0 ? `, ${fmtBytes(bytes)}` : '') + '.');

  const ok = errors.length === 0;
  return {
    ok,
    headline: verifyFails.length > 0
      ? 'VERIFICATION FAILED — the copy is not proven correct'
      : errors.length > 0
        ? 'Finished with errors'
        : warns.length > 0
          ? 'Finished, with warnings'
          : 'Finished — verified',
    detail,
  };
}
