/**
 * `SHOW PROFILE` — where the time went *inside* one statement.
 *
 * An execution plan says which operations ran. It does not say that 80% of the
 * wall time was `Sending data` (which on MySQL means reading rows, not network),
 * or that the statement spent longer waiting for a table lock than executing.
 * Those are different problems with different fixes, and the plan cannot tell
 * them apart.
 *
 * MySQL's profiler is deprecated in favour of performance_schema and still the
 * fastest way to answer this, because it needs no instrumentation setup — one
 * session variable and the numbers are there.
 *
 * The interpretation is the value. `Sending data` is the single most
 * misread state in MySQL: it is not the network, and people spend afternoons
 * tuning connections because of the name. Every state below carries what it
 * actually means.
 *
 * Pure and dependency-free — driven by `node --test`.
 */

export interface ProfileStage {
  /** State name exactly as MySQL reported it. */
  state: string;
  seconds: number;
  /** 0..1 share of the statement's total. */
  share: number;
}

export interface StageMeaning {
  /** Plain-English gloss. */
  what: string;
  /** Set when this state being dominant is itself a finding. */
  concern?: string;
}

/**
 * What each state actually means.
 *
 * Names chosen by MySQL for its own reasons, several of them actively
 * misleading. This table is the point of the feature.
 */
export const STATE_MEANINGS: Record<string, StageMeaning> = {
  'sending data': {
    what: 'Reading rows and sending them — mostly READING. Despite the name this '
      + 'is not the network; it is the server walking the result set.',
    concern: 'Dominant here almost always means too many rows are being examined. '
      + 'Look at the plan, not at the connection.',
  },
  'statistics': {
    what: 'The optimiser deciding on a plan.',
    concern: 'Dominant here means planning costs more than execution — usually a '
      + 'query with many joins, or stale statistics making the search expensive.',
  },
  'creating tmp table': {
    what: 'Building a temporary table to hold intermediate rows.',
    concern: 'Often from GROUP BY, DISTINCT or UNION. If it spills to disk it gets '
      + 'far slower; an index on the grouping columns usually removes it.',
  },
  'copying to tmp table on disk': {
    what: 'The temporary table outgrew memory and moved to disk.',
    concern: 'The expensive version of the above. Raise tmp_table_size, or reduce '
      + 'the rows reaching it.',
  },
  'sorting result': {
    what: 'Ordering the rows.',
    concern: 'An index in the ORDER BY order removes this entirely.',
  },
  'sorting for group': { what: 'Sorting so that rows can be grouped together.' },
  'waiting for table level lock': {
    what: 'Blocked on another session holding a table lock.',
    concern: 'Not a query problem — a concurrency one. Check ⚡ Processes for who '
      + 'is holding it.',
  },
  'waiting for table metadata lock': {
    what: 'Blocked by a DDL statement, or by a transaction holding one open.',
    concern: 'A long-running transaction elsewhere can block every statement '
      + 'touching the table. Find it before tuning anything here.',
  },
  'opening tables': {
    what: 'Opening table definitions.',
    concern: 'Dominant here suggests table_open_cache is too small for the number '
      + 'of tables being touched.',
  },
  'system lock': { what: 'Internal storage-engine locking, normally brief.' },
  'init': { what: 'Statement setup — parsing and initialising structures.' },
  'checking permissions': { what: 'Verifying grants on every object touched.' },
  'preparing': { what: 'Building the structures execution will run against.' },
  'executing': { what: 'The execution step itself — usually near-zero.' },
  'end': { what: 'Execution finished; results have already been sent.' },
  'query end': { what: 'Committing the statement and cleaning up after it.' },
  'closing tables': { what: 'Releasing the table handles the statement opened.' },
  'freeing items': { what: 'Releasing memory held during execution.' },
  'cleaning up': { what: 'Final teardown of the statement.' },
  'removing tmp table': { what: 'Dropping the temporary table it created.' },
  'starting': { what: 'The statement begins — parsing and initial setup.' },
};

export function meaningOf(state: string): StageMeaning | undefined {
  return STATE_MEANINGS[state.trim().toLowerCase()];
}

/** Statements that turn profiling on for a session. */
export const ENABLE_SQL = 'SET profiling = 1';
export const DISABLE_SQL = 'SET profiling = 0';

/**
 * Read the profile of the LAST statement run on this session.
 *
 * Profiling is per-session and per-statement, so the profile only exists on the
 * same connection that ran the query, immediately afterwards.
 */
export const PROFILE_SQL = 'SHOW PROFILE';

/** Whether an engine can do this at all. */
export function supportsProfiling(engine: string): boolean {
  return engine === 'mysql';
}

/**
 * Fold raw `SHOW PROFILE` rows into stages.
 *
 * MySQL reports the same state several times in one statement — `Sending data`
 * can appear once per table. Summing them is the only reading that answers
 * "where did the time go"; listing them separately makes the biggest cost look
 * like several small ones.
 */
export function parseProfile(rows: unknown[][]): ProfileStage[] {
  const totals = new Map<string, number>();
  for (const r of rows) {
    const state = String(r[0] ?? '').trim();
    const secs = Number(r[1]);
    if (!state || !Number.isFinite(secs)) continue;
    totals.set(state, (totals.get(state) ?? 0) + secs);
  }
  const total = [...totals.values()].reduce((a, b) => a + b, 0);
  return [...totals.entries()]
    .map(([state, seconds]) => ({
      state,
      seconds,
      share: total > 0 ? seconds / total : 0,
    }))
    .sort((a, b) => b.seconds - a.seconds);
}

/** Total wall time the profile accounts for, in seconds. */
export function profileTotal(stages: ProfileStage[]): number {
  return stages.reduce((n, s) => n + s.seconds, 0);
}

export interface ProfileFinding {
  state: string;
  share: number;
  what: string;
  concern: string;
}

/** A state must own at least this much of the statement to be worth calling out. */
export const DOMINANT_SHARE = 0.3;

/**
 * The states worth acting on.
 *
 * Only states that both dominate the statement AND have a known concern. A
 * profile where `executing` is 95% of a 2 ms query is not a finding, it is a
 * fast query.
 */
export function profileFindings(stages: ProfileStage[]): ProfileFinding[] {
  const out: ProfileFinding[] = [];
  for (const s of stages) {
    if (s.share < DOMINANT_SHARE) continue;
    const m = meaningOf(s.state);
    if (!m?.concern) continue;
    out.push({ state: s.state, share: s.share, what: m.what, concern: m.concern });
  }
  return out;
}

/** Human seconds — profiles are sub-millisecond often enough to need care. */
export function formatSeconds(secs: number): string {
  if (secs >= 1) return `${secs.toFixed(3)} s`;
  if (secs >= 0.001) return `${(secs * 1000).toFixed(2)} ms`;
  return `${(secs * 1_000_000).toFixed(0)} µs`;
}
