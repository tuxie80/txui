/**
 * Plan-stability analysis (src/utils/planStability.ts).
 *
 * This one has a different failure mode from the rest of the analysis in this
 * app. Everything else asks "is this slow?", which is checkable. This asks
 * "could this become slow?", which is a judgement — and a judgement that fires
 * on every query is one nobody reads.
 *
 * So the tests are as much about **silence** as about detection: a plain,
 * well-shaped query must produce nothing at all.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  analyseStability, scoreOf, verdictOf, rankRisks, JOIN_SEARCH_LIMIT,
} from '../src/utils/planStability.ts';

const ids = (sql: string) => analyseStability(sql).risks.map(r => r.id);
const has = (sql: string, id: string) => ids(sql).includes(id);

// ── silence on a clean query ────────────────────────────────────────────────

test('a plain, well-shaped query reports nothing', () => {
  // The most important test here. A checker that flags everything is muted,
  // and a muted checker is worse than none.
  assert.deepEqual(ids('SELECT id, email FROM customers WHERE id = 42'), []);
  assert.deepEqual(ids('SELECT c.id, o.total FROM customers c JOIN orders o ON o.customer_id = c.id'), []);
  assert.equal(analyseStability('SELECT 1').score, 100);
});

test('a clean query gets a verdict that says so plainly', () => {
  const r = analyseStability('SELECT id FROM t WHERE id = 1');
  assert.match(r.verdict, /Nothing here/);
});

// ── the catastrophic one ────────────────────────────────────────────────────

test('ORDER BY + LIMIT + WHERE is flagged high', () => {
  // The classic: the optimiser must choose between the filter index and the
  // sort index, and the losing plan scans the sort index to the end.
  const r = analyseStability(
    "SELECT * FROM orders WHERE status = 'new' ORDER BY created_at DESC LIMIT 20");
  const risk = r.risks.find(x => x.id === 'order-limit-filter');
  assert.ok(risk, ids("SELECT * FROM orders WHERE status = 'new' ORDER BY created_at DESC LIMIT 20").join(','));
  assert.equal(risk.level, 'high');
  assert.match(risk.action, /covering the filter columns AND the sort columns/);
});

test('ORDER BY + LIMIT without a filter is NOT flagged', () => {
  // With no WHERE there is no competing index, so there is no choice to flip.
  assert.ok(!has('SELECT * FROM orders ORDER BY created_at DESC LIMIT 20',
    'order-limit-filter'));
});

test('too many joins is flagged, because the plan stops being deterministic', () => {
  const many = 'SELECT * FROM a '
    + Array.from({ length: JOIN_SEARCH_LIMIT }, (_, i) => `JOIN t${i} ON t${i}.a = a.id`).join(' ');
  const risk = analyseStability(many).risks.find(r => r.id === 'join-search-limit');
  assert.ok(risk, ids(many).join(','));
  assert.equal(risk.level, 'high');
  assert.match(risk.why, /genetic algorithm|not deterministic/);
});

test('a normal number of joins is not flagged', () => {
  const few = 'SELECT * FROM a JOIN b ON b.a = a.id JOIN c ON c.b = b.id';
  assert.ok(!has(few, 'join-search-limit'));
});

// ── parameter sensitivity ───────────────────────────────────────────────────

test('a parameterised equality is flagged as bind-sensitive', () => {
  for (const sql of [
    'SELECT * FROM orders WHERE status = ?',
    'SELECT * FROM orders WHERE status = :status',
    'SELECT * FROM orders WHERE status = $1',
  ]) {
    assert.ok(has(sql, 'parameter-sensitive'), sql);
  }
});

test('a literal comparison is not bind-sensitive', () => {
  assert.ok(!has("SELECT * FROM orders WHERE status = 'new'", 'parameter-sensitive'));
});

// ── the rest of the rules ───────────────────────────────────────────────────

test('OR across DIFFERENT columns is flagged; the same column is not', () => {
  assert.ok(has("SELECT * FROM t WHERE a = 1 OR b = 2", 'or-across-columns'));
  // `a = 1 OR a = 2` is just an IN list and plans predictably.
  assert.ok(!has("SELECT * FROM t WHERE a = 1 OR a = 2", 'or-across-columns'));
});

test('a function wrapping a filtered column is flagged', () => {
  assert.ok(has("SELECT * FROM t WHERE DATE(created_at) = '2026-01-01'", 'non-sargable'));
  assert.ok(has('SELECT * FROM t WHERE LOWER(email) = ?', 'non-sargable'));
  // A function in the SELECT list is not a plan problem.
  assert.ok(!has('SELECT LOWER(email) FROM t WHERE id = 1', 'non-sargable'));
});

test('a leading-wildcard LIKE is flagged', () => {
  assert.ok(has("SELECT * FROM t WHERE name LIKE '%smith%'", 'leading-wildcard'));
  assert.ok(has('SELECT * FROM t WHERE name LIKE ?', 'leading-wildcard'),
    'a parameterised pattern cannot be known in advance');
  assert.ok(!has("SELECT * FROM t WHERE name LIKE 'smith%'", 'leading-wildcard'),
    'an anchored pattern can use an index');
});

test('a large IN list is flagged, a small one is not', () => {
  const big = `SELECT * FROM t WHERE id IN (${Array.from({ length: 250 }, (_, i) => i).join(',')})`;
  assert.ok(has(big, 'large-in-list'));
  assert.ok(!has('SELECT * FROM t WHERE id IN (1,2,3)', 'large-in-list'));
  // `IN (SELECT …)` is a subquery, not a value list.
  assert.ok(!has('SELECT * FROM t WHERE id IN (SELECT id FROM u)', 'large-in-list'));
});

test('LIMIT without ORDER BY is flagged as non-deterministic', () => {
  const r = analyseStability('SELECT * FROM orders LIMIT 10').risks
    .find(x => x.id === 'limit-without-order');
  assert.ok(r);
  assert.match(r.why, /silently returns different rows/);
  assert.ok(!has('SELECT * FROM orders ORDER BY id LIMIT 10', 'limit-without-order'));
});

test('NOT IN against a subquery is flagged for its NULL cliff', () => {
  const r = analyseStability('SELECT * FROM a WHERE id NOT IN (SELECT b_id FROM b)').risks
    .find(x => x.id === 'not-in-subquery');
  assert.ok(r);
  assert.match(r.why, /NULL/);
  assert.match(r.action, /NOT EXISTS/);
});

test('a correlated subquery is flagged as flatten-or-not', () => {
  assert.ok(has('SELECT * FROM a WHERE EXISTS (SELECT 1 FROM b WHERE b.a = a.id)',
    'correlated-subquery'));
});

test('several AND-ed equalities raise the independence assumption', () => {
  assert.ok(has("SELECT * FROM t WHERE city = 'x' AND country = 'y' AND kind = 'z'",
    'correlated-predicates'));
  assert.ok(!has("SELECT * FROM t WHERE city = 'x'", 'correlated-predicates'));
});

test('SELECT * is only a stability risk across a join', () => {
  assert.ok(has('SELECT * FROM a JOIN b ON b.a = a.id', 'select-star-join'));
  assert.ok(!has('SELECT * FROM a WHERE id = 1', 'select-star-join'));
});

// ── keywords in literals must not fire ──────────────────────────────────────

test('a keyword inside a string literal does not trigger a rule', () => {
  // "the plan analyser fired on a comment" is exactly the kind of noise that
  // gets a checker turned off.
  assert.deepEqual(ids("SELECT 'order by limit' AS note FROM t WHERE id = 1"), []);
  assert.deepEqual(ids('SELECT 1 -- ORDER BY x LIMIT 1 WHERE y\nFROM t WHERE id = 2'), []);
});

// ── scoring ─────────────────────────────────────────────────────────────────

test('the score falls with the severity of what was found', () => {
  assert.equal(scoreOf([]), 100);
  const high = scoreOf([{ id: 'a', level: 'high' } as never]);
  const medium = scoreOf([{ id: 'a', level: 'medium' } as never]);
  const low = scoreOf([{ id: 'a', level: 'low' } as never]);
  assert.ok(high < medium && medium < low && low < 100);
});

test('the score never goes negative', () => {
  const many = Array.from({ length: 20 }, () => ({ id: 'x', level: 'high' })) as never[];
  assert.equal(scoreOf(many), 0);
});

test('the verdict escalates with the worst finding, not the count', () => {
  assert.match(verdictOf([{ level: 'high' } as never]), /catastrophically/);
  assert.match(verdictOf([{ level: 'medium' } as never]), /statistics that change/);
  assert.match(verdictOf([{ level: 'low' } as never]), /Minor/);
  assert.match(verdictOf([]), /Nothing here/);
});

test('risks rank worst-first', () => {
  const ranked = rankRisks([
    { id: 'c', level: 'low', at: 1 } as never,
    { id: 'a', level: 'high', at: 9 } as never,
    { id: 'b', level: 'medium', at: 2 } as never,
  ]);
  assert.deepEqual(ranked.map(r => r.id), ['a', 'b', 'c']);
});

// ── every rule is usable ────────────────────────────────────────────────────

test('every risk explains itself and offers an action', () => {
  const sql = `SELECT * FROM orders o JOIN customers c ON c.id = o.customer_id
    WHERE DATE(o.created_at) = ? AND o.status = ? AND c.city = 'x'
      AND o.name LIKE '%z%' OR o.other = 1
    ORDER BY o.created_at DESC LIMIT 10`;
  const { risks } = analyseStability(sql);
  assert.ok(risks.length >= 4, `only found ${risks.map(r => r.id).join(', ')}`);
  for (const r of risks) {
    assert.ok(r.title.length > 8, r.id);
    assert.ok(r.observed.length > 10, `${r.id}: observed`);
    assert.ok(r.why.length > 60, `${r.id}: why must explain the flip`);
    assert.ok(r.action.length > 20, `${r.id}: action`);
    assert.ok(r.badge.length > 0 && r.badge.length <= 14, `${r.id}: badge "${r.badge}"`);
  }
});
