/**
 * Result streaming — the pure accumulation side of execute_query's Channel
 * (src-tauri/src/commands/query.rs, `ResultStreamEvent`).
 *
 * A result above the backend's STREAM_MIN_ROWS no longer crosses as one JSON
 * invoke payload; the backend sends a `header` (complete metadata, rows
 * drained, plus the total count) followed by `page` events, and the invoke's
 * return value then carries the same metadata with an empty `rows`. This
 * module reassembles that into the QueryResult the rest of the pipeline has
 * always consumed, so nothing downstream (session log, audit, script lines,
 * FastGrid) can tell the difference.
 *
 * Pure: no React/Tauri imports — unit-tested with node --test.
 */
import type { QueryResult } from '../types/index.ts';

/** Wire shape of one Channel message — mirrors the Rust enum verbatim. */
export type ResultStreamEvent =
  | { type: 'header'; result: QueryResult; total_rows: number }
  | { type: 'page'; set_index?: number; rows: unknown[][] };

export interface StreamAccum {
  /** True once a header arrived: rows come as pages, and the invoke's return
      value carries metadata with `rows` drained. */
  streamed: boolean;
  /** The header's metadata, or null before it / when never streamed. */
  header: QueryResult | null;
  /** Rows the header promised across all pages — completeness check. */
  totalRows: number;
  /** Every row so far, flat, in arrival order. */
  rows: unknown[][];
  /** Rows for result sets after the first, keyed by their zero-based set index. */
  setRows: Record<number, unknown[][]>;
}

export function newStreamAccum(): StreamAccum {
  return { streamed: false, header: null, totalRows: 0, rows: [], setRows: {} };
}

/**
 * Fold one event into the accumulator. Mutates `acc` deliberately: the
 * Channel's onmessage is an imperative slot, and a copying fold would
 * re-allocate 100k rows per page. A page arriving before its header is
 * kept — the header is sent first, but dropping rows on a transport quirk
 * would be data loss, while an orphaned row set is merely odd.
 */
export function applyStreamEvent(acc: StreamAccum, ev: ResultStreamEvent): void {
  if (ev.type === 'header') {
    acc.streamed = true;
    acc.header = ev.result;
    acc.totalRows = ev.total_rows;
  } else {
    const setIndex = ev.set_index ?? 0;
    if (setIndex === 0) acc.rows.push(...ev.rows);
    else (acc.setRows[setIndex] ??= []).push(...ev.rows);
  }
}

/**
 * A snapshot of what has arrived so far, for progressive rendering. Fresh
 * object + fresh rows array every call, because React keys change off
 * identity. Null before the header (there is nothing displayable without
 * columns).
 */
function setsFromAccum(acc: StreamAccum, returned: QueryResult): QueryResult['result_sets'] {
  return returned.result_sets?.map((set, index) => ({
    ...set, result_sets: [], rows: [...(acc.setRows[index + 1] ?? [])],
  }));
}

export function partialResult(acc: StreamAccum): QueryResult | null {
  if (!acc.header) return null;
  return { ...acc.header, rows: [...acc.rows], result_sets: setsFromAccum(acc, acc.header) };
}

export function streamArrivedCount(acc: StreamAccum): number {
  return acc.rows.length + Object.values(acc.setRows).reduce((sum, rows) => sum + rows.length, 0);
}

/** All promised rows arrived (or nothing was streamed at all). */
export function streamComplete(acc: StreamAccum): boolean {
  return !acc.streamed || streamArrivedCount(acc) === acc.totalRows;
}

/**
 * The run's final result: for a streamed run, the invoke's return value with
 * the accumulated rows put back; otherwise the return value untouched.
 */
export function finishStream(acc: StreamAccum, returned: QueryResult): QueryResult {
  if (!acc.streamed) return returned;
  return { ...returned, rows: acc.rows, result_sets: setsFromAccum(acc, returned) };
}
