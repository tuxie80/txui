/**
 * Classify a finished QueryResult for the result area:
 *   'rows'     → a real result set — render the grid
 *   'affected' → DML with a row count — "N rows affected in T"
 *   'ok'       → SET / DDL / admin — "completed in T"
 * The non-row phrasing reuses the CANONICAL session-log wording
 * (QueryTabs.executeOne) so the result banner never disagrees with the log.
 * Pure: no React/Tauri imports — unit-tested with node --test.
 */
import type { QueryResult } from '../types/index.ts';
import { isDmlStatement } from './sqlGuard.ts';
import { fmtDuration } from './fmtDuration.ts';

export type ResultKind = 'rows' | 'affected' | 'ok';

export function resultAffected(result: QueryResult): number | null {
  return result.rows_affected === null ? null : Number(result.rows_affected);
}

export function resultKind(result: QueryResult, sql: string): ResultKind {
  // A SELECT with 0 rows still carries its column metadata — it is a grid.
  if (result.columns.length > 0) return 'rows';
  const affected = resultAffected(result);
  // DML always reports its count, even 0 ("0 rows affected"); DDL/SET also
  // report 0 on MySQL, so the statement text decides which wording applies.
  if (affected !== null && (affected > 0 || isDmlStatement(sql))) return 'affected';
  return 'ok';
}

/** "3 rows affected in 12 ms" / "completed in 1 s 524 ms" — log-line wording. */
export function resultSummary(result: QueryResult, sql: string): string {
  const ms = Math.round(result.execution_ms + (result.fetch_ms ?? 0));
  const affected = resultAffected(result);
  if (resultKind(result, sql) === 'affected' && affected !== null) {
    return `${affected} row${affected === 1 ? '' : 's'} affected in ${fmtDuration(ms)}`;
  }
  return `completed in ${fmtDuration(ms)}`;
}
