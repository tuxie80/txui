/**
 * Will this query's plan stay the same tomorrow?
 *
 * Every other analysis here asks whether a query is *fast*. This one asks
 * whether it is **predictable** — because the queries that page you at 3am are
 * rarely the ones that were always slow. They are the ones that were fast for
 * a year and then, after a parameter changed or a table grew past a threshold,
 * the optimiser picked a different plan and the same SQL became a table scan.
 *
 * That failure is invisible to a profiler: you profile the fast plan. It is
 * invisible to a plan viewer: the plan you are looking at is fine. It is a
 * property of the query's *shape* — how close it sits to a decision the
 * optimiser makes from statistics that change.
 *
 * Every rule below marks a place where a small change in data or parameters
 * flips a plan choice. None of them mean the query is wrong today.
 *
 * Pure and dependency-free — driven by `node --test`.
 */
import { blank } from './sqlAlias.ts';

export type StabilityLevel = 'high' | 'medium' | 'low';

export interface StabilityRisk {
  id: string;
  level: StabilityLevel;
  /** Short label for a badge. */
  badge: string;
  title: string;
  /** What in the query triggers it. */
  observed: string;
  /** The optimiser decision that can flip, and what flips it. */
  why: string;
  /** What to do — always something, even if it is "measure with both values". */
  action: string;
  /** Character offset of the trigger, when known. */
  at?: number;
}

export interface StabilityReport {
  risks: StabilityRisk[];
  /** 0–100; 100 is a plan that has nothing to flip. */
  score: number;
  verdict: string;
}

/**
 * PostgreSQL abandons exhaustive join-order search above this many relations
 * and switches to a genetic algorithm, which is **not deterministic**: the same
 * query against the same data can produce different plans on different runs.
 * MySQL has its own search-depth cut-off with the same consequence.
 */
export const JOIN_SEARCH_LIMIT = 8;

/** Beyond this many IN values, engines change strategy. */
const IN_LIST_LARGE = 200;

const rx = {
  join: /\bjoin\b/gi,
  limit: /\blimit\b/i,
  orderBy: /\border\s+by\b/i,
  groupBy: /\bgroup\s+by\b/i,
  where: /\bwhere\b/i,
  // A bind marker in any of the dialects the app speaks.
  param: /(\?|:[A-Za-z_]\w*|\$\d+|\$\{[^}]+\})/,
};

/** Quote/comment-blanked text, so keywords inside literals do not fire. */
function prep(sql: string): { b: string; lower: string } {
  const b = blank(sql);
  return { b, lower: b.toLowerCase() };
}

/**
 * Analyse a statement's shape for plan-flip risk.
 *
 * Text-only by design: this must work before a query has ever been run, which
 * is when the finding is cheapest to act on.
 */
export function analyseStability(sql: string): StabilityReport {
  const { b, lower } = prep(sql);
  const risks: StabilityRisk[] = [];
  const add = (r: StabilityRisk) => risks.push(r);

  const hasParam = rx.param.test(b);
  const isSelect = /^\s*(select|with)\b/i.test(b);

  // ── 1. ORDER BY + LIMIT with a filter — the classic catastrophic flip ──
  if (rx.orderBy.test(lower) && rx.limit.test(lower) && rx.where.test(lower)) {
    add({
      id: 'order-limit-filter',
      level: 'high',
      badge: 'order+limit',
      title: 'ORDER BY … LIMIT with a WHERE clause',
      observed: 'The query filters, sorts and takes the first few rows.',
      why: 'The optimiser must choose between an index that satisfies the WHERE and one '
        + 'that satisfies the ORDER BY. It picks by guessing how far it must scan the '
        + 'sort index before finding enough matching rows — and that guess depends on '
        + 'how common the filtered value is. When the data shifts, the choice flips, and '
        + 'the losing plan is not slightly slower: it scans the sort index to the end.',
      action: 'Add one index covering the filter columns AND the sort columns in that '
        + 'order, so there is nothing to choose between.',
      at: lower.search(rx.orderBy),
    });
  }

  // ── 2. Too many joins for a deterministic search ──
  const joins = (lower.match(rx.join) ?? []).length;
  if (joins >= JOIN_SEARCH_LIMIT) {
    add({
      id: 'join-search-limit',
      level: 'high',
      badge: `${joins} joins`,
      title: `${joins} joins — past the optimiser's exhaustive search limit`,
      observed: `This statement joins ${joins} times.`,
      why: `Above roughly ${JOIN_SEARCH_LIMIT} relations PostgreSQL stops searching join `
        + 'orders exhaustively and switches to a genetic algorithm, which is not '
        + 'deterministic — the same query on the same data can produce a different plan '
        + 'on different runs. MySQL has an equivalent search-depth cut-off. Past that '
        + 'point the plan is a heuristic, not a decision.',
      action: 'Split the query, materialise part of it, or raise join_collapse_limit / '
        + 'geqo_threshold (PostgreSQL) knowing that planning time grows fast.',
      at: lower.search(/\bjoin\b/),
    });
  }

  // ── 3. Parameterised equality — bind peeking / parameter sniffing ──
  if (hasParam && /[=<>]\s*(\?|:[A-Za-z_]\w*|\$\d+)/.test(b)) {
    add({
      id: 'parameter-sensitive',
      level: 'medium',
      badge: 'bind-sensitive',
      title: 'Plan chosen from one parameter value, reused for all of them',
      observed: 'A predicate compares a column with a bind parameter.',
      why: 'Both engines can plan using the FIRST value they see and cache that plan for '
        + 'later executions. If the column is skewed — a status that is 99% one value — '
        + 'the plan that suits the common value is catastrophic for the rare one, and '
        + 'which one you get depends on whichever ran first after a restart.',
      action: 'Check the column’s distribution. If it is skewed, either force a '
        + 're-plan per execution or split into separate queries for the common and rare '
        + 'cases.',
      at: b.search(/[=<>]\s*(\?|:[A-Za-z_]\w*|\$\d+)/),
    });
  }

  // ── 4. OR across different columns ──
  const orCols = /\b(\w+)\s*=\s*[^\s]+\s+or\s+(\w+)\s*=/i.exec(b);
  if (orCols && orCols[1].toLowerCase() !== orCols[2].toLowerCase()) {
    add({
      id: 'or-across-columns',
      level: 'medium',
      badge: 'OR',
      title: 'OR across different columns',
      observed: `\`${orCols[1]}\` OR \`${orCols[2]}\` — two different columns.`,
      why: 'The optimiser chooses between merging two index scans and giving up on '
        + 'indexes entirely. The choice turns on estimated selectivity of both sides, so '
        + 'it can flip when either column’s distribution changes.',
      action: 'Rewrite as a UNION ALL of two indexed queries, which removes the choice.',
      at: orCols.index,
    });
  }

  // ── 5. A function or arithmetic wrapping a filtered column ──
  const wrapped = /\bwhere\b[\s\S]{0,400}?\b(date|year|month|lower|upper|trim|coalesce|cast|substr|substring|concat|round|floor|abs)\s*\(\s*(\w+)/i.exec(b);
  if (wrapped) {
    add({
      id: 'non-sargable',
      level: 'medium',
      badge: 'wrapped column',
      title: `${wrapped[1].toUpperCase()}() around a filtered column`,
      observed: `\`${wrapped[1]}(${wrapped[2]}…)\` appears in the WHERE clause.`,
      why: 'A column inside a function cannot use a plain index on that column, and the '
        + 'optimiser has no statistics for the function’s result — so it falls back to '
        + 'a fixed guess. A fixed guess is stable until the real selectivity drifts away '
        + 'from it, at which point every downstream join order is wrong.',
      action: 'Rewrite the predicate to leave the column bare (a range instead of '
        + 'DATE(x) = …), or add an expression index matching the function exactly.',
      at: wrapped.index,
    });
  }

  // ── 6. Leading-wildcard LIKE ──
  // Read from the ORIGINAL text: `blank()` masks a literal's contents, which is
  // exactly where the wildcard lives. Only the pattern is inspected, and only
  // at a position the blanked text already confirmed is a real LIKE.
  const likeAt = lower.search(/\blike\b/);
  const likeLead = likeAt >= 0
    ? /\blike\s+('%|\?|:[A-Za-z_]|\$\d)/i.exec(sql.slice(likeAt))
    : null;
  if (likeLead) {
    add({
      id: 'leading-wildcard',
      level: 'low',
      badge: 'LIKE %…',
      title: 'LIKE with a leading wildcard or a parameterised pattern',
      observed: 'The pattern can begin with a wildcard.',
      why: 'A leading wildcard cannot use a B-tree index at all. When the pattern is a '
        + 'parameter the optimiser cannot even tell in advance, so it plans for one shape '
        + 'and may execute another.',
      action: 'Use a full-text or trigram index, or anchor the pattern.',
      at: likeAt,
    });
  }

  // ── 7. Large or variable IN list ──
  const inList = /\bin\s*\(([^)]{0,20000})\)/i.exec(b);
  if (inList && !/\bselect\b/i.test(inList[1])) {
    const count = inList[1].split(',').length;
    if (count >= IN_LIST_LARGE) {
      add({
        id: 'large-in-list',
        level: 'medium',
        badge: `IN(${count})`,
        title: `IN list of ${count} values`,
        observed: `An IN predicate with ${count} entries.`,
        why: 'Engines switch strategy as the list grows — from repeated index lookups to '
          + 'a scan — and the threshold is a cost comparison, not a fixed number. A list '
          + 'whose length varies per call therefore has no single plan.',
        action: 'Join against a temporary table or a VALUES list instead, which plans the '
          + 'same way whatever the size.',
        at: inList.index,
      });
    }
  }

  // ── 8. LIMIT with no ORDER BY ──
  if (rx.limit.test(lower) && !rx.orderBy.test(lower) && isSelect) {
    add({
      id: 'limit-without-order',
      level: 'medium',
      badge: 'unordered LIMIT',
      title: 'LIMIT without ORDER BY',
      observed: 'Rows are capped but not ordered.',
      why: 'Which rows come back is decided by whatever plan the optimiser picked. Change '
        + 'the plan — a new index, a grown table — and the same query silently returns '
        + 'different rows. There is no error and no warning.',
      action: 'Add an ORDER BY on a unique or tie-broken key. If the rows genuinely do not '
        + 'matter, say so in a comment so the next reader knows it is deliberate.',
      at: lower.search(rx.limit),
    });
  }

  // ── 9. Correlated subquery ──
  const corr = /\b(exists|not\s+exists|in)\s*\(\s*select\b/i.exec(b);
  if (corr) {
    add({
      id: 'correlated-subquery',
      level: 'low',
      badge: 'subquery',
      title: `${corr[1].toUpperCase().replace(/\s+/g, ' ')} (SELECT …)`,
      observed: 'A subquery appears in a predicate.',
      why: 'The optimiser decides whether to flatten this into a join or run it per outer '
        + 'row. The decision is cost-based, so it can change with the data, and the two '
        + 'plans differ by orders of magnitude on a large outer input.',
      action: 'Write the join explicitly if you want the flattened form guaranteed.',
      at: corr.index,
    });
  }

  // ── 10. NOT IN against a nullable subquery ──
  if (/\bnot\s+in\s*\(\s*select\b/i.test(b)) {
    add({
      id: 'not-in-subquery',
      level: 'medium',
      badge: 'NOT IN',
      title: 'NOT IN (SELECT …)',
      observed: 'A NOT IN against a subquery.',
      why: 'If the subquery ever returns a NULL the whole predicate becomes UNKNOWN and '
        + 'the query returns nothing — a correctness cliff that depends on data, not on '
        + 'the query. It also blocks the anti-join rewrite, so the plan is worse and less '
        + 'predictable.',
      action: 'Use NOT EXISTS, which is NULL-safe and reliably becomes an anti-join.',
      at: b.toLowerCase().indexOf('not in'),
    });
  }

  // ── 11. Multi-column equality — the independence assumption ──
  // Count equality predicates joined by AND inside the WHERE clause. Matching
  // the VALUE is hopeless once literals are blanked (they become spaces), so
  // this counts the shape `col = …` and the ANDs between them instead.
  const whereAt = lower.search(/\bwhere\b/);
  const whereBody = whereAt >= 0
    ? b.slice(whereAt).split(/\b(?:group|order|limit|having)\b/i)[0]
    : '';
  const eqCount = (whereBody.match(/\b\w+\s*=/g) ?? []).length;
  const andCount = (whereBody.match(/\band\b/gi) ?? []).length;
  if (eqCount >= 3 && andCount >= 2) {
    const ands = new Array(eqCount - 1);
    add({
      id: 'correlated-predicates',
      level: 'low',
      badge: 'multi-column',
      title: 'Several equality predicates AND-ed together',
      observed: `${ands.length + 1} columns compared for equality in one predicate.`,
      why: 'Optimisers assume columns are independent and multiply their selectivities. '
        + 'Real columns are usually correlated — city and country, status and type — so '
        + 'the estimate can be wrong by orders of magnitude, and every join order chosen '
        + 'from it is wrong with it.',
      action: 'On PostgreSQL, CREATE STATISTICS on the correlated columns. Elsewhere, '
        + 'check the estimate against reality with EXPLAIN ANALYZE.',
    });
  }

  // ── 12. SELECT * ──
  if (/\bselect\s+\*/i.test(b) && /\bjoin\b/i.test(lower)) {
    add({
      id: 'select-star-join',
      level: 'low',
      badge: 'SELECT *',
      title: 'SELECT * across a join',
      observed: 'Every column of every joined table is returned.',
      why: 'A covering index can never satisfy the query, so the plan always includes a '
        + 'table fetch — and the set of columns changes whenever anyone alters a table, '
        + 'silently changing the query’s cost.',
      action: 'Name the columns. It also makes the query survive a schema change.',
    });
  }

  return { risks, score: scoreOf(risks), verdict: verdictOf(risks) };
}

const WEIGHT: Record<StabilityLevel, number> = { high: 30, medium: 15, low: 6 };

/** 100 is a plan with nothing to flip. */
export function scoreOf(risks: StabilityRisk[]): number {
  const penalty = risks.reduce((n, r) => n + WEIGHT[r.level], 0);
  return Math.max(0, 100 - penalty);
}

/** One sentence, stating what the score means rather than just naming it. */
export function verdictOf(risks: StabilityRisk[]): string {
  if (risks.length === 0) {
    return 'Nothing here that would make the optimiser change its mind.';
  }
  const high = risks.filter(r => r.level === 'high').length;
  if (high > 0) {
    return `${high} high risk${high === 1 ? '' : 's'} — this plan can change `
      + 'catastrophically on a data or parameter shift, not gradually.';
  }
  const medium = risks.filter(r => r.level === 'medium').length;
  if (medium > 0) {
    return `${medium} decision${medium === 1 ? '' : 's'} the optimiser makes from `
      + 'statistics that change. Worth pinning down before this matters.';
  }
  return 'Minor sensitivities only — the plan should hold.';
}

/** Sort for display: worst first, then by position in the statement. */
export function rankRisks(risks: StabilityRisk[]): StabilityRisk[] {
  const order: Record<StabilityLevel, number> = { high: 0, medium: 1, low: 2 };
  return [...risks].sort((a, b) =>
    order[a.level] - order[b.level] || (a.at ?? 0) - (b.at ?? 0));
}
