/**
 * Running many statements at once — the rules, and why they are these rules.
 *
 * Three things make a multi-statement run either trustworthy or quietly
 * dangerous, and all three are decided here rather than inline in the runner,
 * because getting any of them wrong is *silent*.
 *
 * **1. A cancel is not a failure.** Pressing ■ Cancel makes the running
 * statement reject, and a runner that cannot tell the two apart will stop and
 * ask "statement 3 failed — ignore, ignore all, or stop?" about a statement the
 * user just deliberately stopped.
 *
 * **2. On PostgreSQL, "ignore" does not work inside a transaction.** After any
 * error, a PG transaction is poisoned: every later statement fails with
 * `25P02 current transaction is aborted`, and the final `COMMIT` is silently
 * downgraded to `ROLLBACK`. So a run that reports "finished with 1 failed
 * statement (ignored)" has in fact committed **nothing** — the most dangerous
 * possible reading, because it looks like success. The fix is a savepoint per
 * statement, so a failure rolls back to just before it and the rest of the
 * transaction survives. (Verified against PostgreSQL 16.10 both ways.)
 *
 * **3. What committed must be stated, not implied.** A summary that counts
 * statements but never mentions the open transaction lets someone walk away
 * believing their work is durable when it is one disconnect from being gone.
 *
 * Pure and dependency-free — driven by `node --test`.
 */

import { errorDisplay } from './appError.ts';
import { isCancelled } from './appError.ts';
import { resultKind } from './resultKind.ts';
import type { QueryResult } from '../types/index.ts';

export type Engine = string;

/** The text the backend rejects a cancelled statement with. */
export const CANCEL_MESSAGE = 'Query cancelled';

/**
 * Was this rejection a cancel rather than a failure?
 *
 * Delegates to `utils/appError`, which reads the backend's **typed** error code
 * where the command has been converted and falls back to its exact wording
 * where it has not. Previously this matched the message text directly, which
 * meant the sentence was load-bearing: PostgreSQL reports a timeout as
 * `canceling statement due to statement timeout`, so a looser match would have
 * swallowed a real failure. Now the code decides, and the string is only a
 * bridge while the conversion finishes.
 */
export function isCancellation(err: unknown): boolean {
  return isCancelled(err);
}

/** PostgreSQL's "this transaction is already dead" state. */
export function isAbortedTransaction(err: unknown): boolean {
  const s = errorDisplay(err);
  return s.includes('25P02') || /current transaction is aborted/i.test(s);
}

// ── result tabs ──────────────────────────────────────────────────────────────

/**
 * The result payload for a finished script statement — or its suppression.
 *
 * "Run script — no result tabs" (F9) runs for side effects and timings: the
 * row COUNT still shows in the overview, but the rows themselves are dropped —
 * no Result N tab earns anything (scriptResultTabs finds no line with a
 * result), and a 100-statement run does not hold 100 row sets in memory.
 * `discarded` tells the overview to say so where the Result opener would be.
 * A statement that never produces a tab (writes, DDL, ANALYZE) gets no note —
 * nothing was withheld from it.
 *
 * This is the ONE decision point: the script loop spreads its return into the
 * statement's line, so a no-results run cannot leak a row set into the tab
 * strip, the overview opener, the full-area view, or the completion auto-land.
 */
export function scriptResultFor(
  result: QueryResult,
  text: string,
  noResults: boolean,
  keepRows: number,
): { result?: QueryResult; discarded?: boolean } {
  if (noResults) {
    return { result: undefined, discarded: resultKind(result, text) === 'rows' ? true : undefined };
  }
  return {
    result: result.rows.length > keepRows
      ? { ...result, rows: result.rows.slice(0, keepRows) }
      : result,
  };
}

/**
 * Which script lines earn a "Result N" tab.
 *
 * A statement that produced a row set gets its own tab in the result strip
 * (Result 1, Result 2, … in run order), so ten SELECTs read as ten tabs
 * instead of one stacked wall of grids. A statement with no output — a write,
 * DDL, ANALYZE — keeps its one-line feedback in the script overview and never
 * becomes a tab: a ten-statement maintenance script would otherwise open ten
 * near-empty tabs.
 *
 * Returns LINE indices (not a dense range), so the tab ↔ line mapping survives
 * a resultless statement in the middle, and a line whose result was closed
 * simply drops out of the list.
 */
export function scriptResultTabs(
  lines: readonly { text: string; result?: QueryResult | null }[],
): number[] {
  const out: number[] = [];
  lines.forEach((l, i) => {
    if (l.result && resultKind(l.result, l.text) === 'rows') out.push(i);
  });
  return out;
}

// ── transaction tracking ─────────────────────────────────────────────────────

const BEGIN_RE = /^\s*(BEGIN|START\s+TRANSACTION)\b/i;
const END_RE = /^\s*(COMMIT|ROLLBACK|END)\b/i;

/**
 * Does this statement open or close a transaction?
 *
 * Tracked by reading the script, not only by asking the app's own transaction
 * toggle: a user who types `BEGIN;` at the top of their script is just as much
 * inside a transaction as one who clicked the button, and it is the *engine*
 * that poisons on error either way.
 */
export function txEffect(sql: string): 'begin' | 'end' | null {
  if (BEGIN_RE.test(sql)) return 'begin';
  if (END_RE.test(sql)) return 'end';
  return null;
}

/**
 * Should this statement be wrapped in a savepoint?
 *
 * Only PostgreSQL, and only inside a transaction — the one case where a failure
 * would otherwise poison everything after it. MySQL needs none: an error there
 * leaves the transaction usable and `COMMIT` still commits.
 *
 * Restricting it this way is not just tidiness. A savepoint per statement is two
 * extra round-trips, and a five-hundred-statement migration outside a
 * transaction should not pay for a hazard it does not have.
 */
export function needsSavepoint(engine: Engine, inTransaction: boolean): boolean {
  return engine === 'postgres' && inTransaction;
}

/** Savepoint name — fixed, since only one is ever live at a time. */
export const SAVEPOINT = 'txui_stmt';
export const SAVEPOINT_SQL = `SAVEPOINT ${SAVEPOINT}`;
export const SAVEPOINT_RELEASE = `RELEASE SAVEPOINT ${SAVEPOINT}`;
export const SAVEPOINT_ROLLBACK = `ROLLBACK TO SAVEPOINT ${SAVEPOINT}`;

// ── the summary ──────────────────────────────────────────────────────────────

export interface RunOutcome {
  total: number;
  ok: number;
  failed: number;
  skipped: number;
  /** Sum of the statements' own times. */
  statementMs: number;
  /** Wall clock for the whole run, including the time spent asking. */
  wallMs: number;
  cancelled: boolean;
  /** A transaction was still open when the run ended. */
  transactionOpen: boolean;
  /** The engine refused later statements because the transaction was poisoned. */
  transactionPoisoned: boolean;
}

/**
 * The sentence shown when a run ends.
 *
 * The ordering is deliberate: whether the work is **durable** comes first, then
 * what failed, then timings. Someone who reads only the first clause should
 * still not be misled — which is exactly what the old summary got wrong, since
 * "finished with 1 failed statement (ignored)" reads as success even when the
 * transaction rolled everything back.
 */
export function summarise(o: RunOutcome): { text: string; level: 'ok' | 'warn' | 'error' } {
  const parts: string[] = [];
  let level: 'ok' | 'warn' | 'error' = 'ok';

  if (o.transactionPoisoned) {
    return {
      level: 'error',
      text: 'NOTHING WAS COMMITTED — the transaction was aborted by the failed '
        + `statement, so PostgreSQL refused the ${o.skipped + o.failed - 1} statement(s) after it `
        + 'and will roll the whole transaction back. Roll back and re-run.',
    };
  }

  if (o.cancelled) {
    level = 'warn';
    parts.push(`Cancelled after ${o.ok} of ${o.total} statement${o.total === 1 ? '' : 's'}`);
  } else if (o.failed > 0) {
    level = o.skipped > 0 ? 'error' : 'warn';
    parts.push(`${o.ok} of ${o.total} succeeded · ${o.failed} failed`);
    if (o.skipped > 0) parts.push(`${o.skipped} skipped`);
  } else {
    parts.push(`${o.total} statement${o.total === 1 ? '' : 's'} completed`);
  }

  if (o.transactionOpen) {
    // The one thing a reader must not miss.
    level = level === 'ok' ? 'warn' : level;
    parts.push('NOT COMMITTED — a transaction is still open');
  }

  parts.push(timing(o));
  return { text: parts.join(' · '), level };
}

/**
 * Statement time and wall time, and only both when they differ enough to mean
 * something — an "identical" pair of numbers side by side just reads as noise.
 * A gap between them is the time spent waiting on the error prompt, which is
 * worth seeing when a run took a while for reasons that were not the database.
 */
function timing(o: RunOutcome): string {
  const stmt = fmt(o.statementMs);
  if (o.wallMs > o.statementMs * 1.2 && o.wallMs - o.statementMs > 500) {
    return `${stmt} in statements, ${fmt(o.wallMs)} wall`;
  }
  return stmt;
}

/** `643 ms` · `14 s 253 ms` · `2 min 3 s` — the same shape as the log lines. */
export function fmt(ms: number): string {
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

// ── what to do when a statement fails ────────────────────────────────────────

export type ScriptErrorChoice = 'stop' | 'ignore' | 'ignore-all';
export type ScriptErrorMode = 'ask' | 'ignore' | 'stop';

/**
 * Does this failure need the user's decision, or is it already made?
 *
 * Kept separate from the prompt itself so the rule is testable without a
 * dialog. The ordering matters and is not obvious: **"ignore all" from an
 * earlier statement wins over the preference.** Someone who answered "ignore
 * all" at statement 3 has said what they want for the rest of the run, and
 * re-reading the preference afterwards would ask them again.
 */
export function needsDecision(mode: ScriptErrorMode, ignoreAll: boolean): boolean {
  return !ignoreAll && mode === 'ask';
}

/**
 * The standing choice when the user is not asked.
 *
 * `ask` only reaches here once `needsDecision` has said no — which means an
 * earlier "ignore all" is in force, so it continues.
 */
export function defaultChoice(mode: ScriptErrorMode, ignoreAll: boolean): ScriptErrorChoice {
  if (ignoreAll) return 'ignore';
  return mode === 'ignore' ? 'ignore' : 'stop';
}

/** What an answer means for the rest of the run. */
export function applyChoice(choice: ScriptErrorChoice): { keepGoing: boolean; ignoreRest: boolean } {
  return {
    keepGoing: choice === 'ignore' || choice === 'ignore-all',
    ignoreRest: choice === 'ignore-all',
  };
}

// ── the tally ────────────────────────────────────────────────────────────────

export interface RunLine {
  status: 'pending' | 'running' | 'ok' | 'error' | 'skipped';
  ms?: number;
}

/**
 * Count a finished run.
 *
 * Counted from the lines rather than from running totals kept alongside them,
 * because the two can disagree: a statement that failed and was then skipped
 * past, or a cancel that rewrites every later line to `skipped`, updates the
 * lines but not a separate counter. The lines are what the user is looking at,
 * so they are the truth the summary must match.
 */
export function tally(
  lines: RunLine[],
  ctx: { wallMs: number; cancelled: boolean; transactionOpen: boolean; transactionPoisoned: boolean },
): RunOutcome {
  return {
    total: lines.length,
    ok: lines.filter(l => l.status === 'ok').length,
    failed: lines.filter(l => l.status === 'error').length,
    skipped: lines.filter(l => l.status === 'skipped').length,
    statementMs: lines.reduce((n, l) => n + (l.ms ?? 0), 0),
    wallMs: ctx.wallMs,
    cancelled: ctx.cancelled,
    transactionOpen: ctx.transactionOpen,
    transactionPoisoned: ctx.transactionPoisoned,
  };
}
