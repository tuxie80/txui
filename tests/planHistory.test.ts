/**
 * Plan run history and diffing (src/utils/planHistory.ts).
 *
 * This answers "did my change help?", so the failure that matters is a
 * confident wrong answer. Two guard rails carry most of these tests:
 *   - runs are grouped by statement SHAPE, so changing a literal keeps the
 *     series and changing the query starts a new one;
 *   - an estimated plan is never compared against a measured one, because
 *     cost units and milliseconds are different quantities and dividing one by
 *     the other produces a percentage that means nothing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  shapeKey, makeRun, pushRun, seriesFor, diffRuns, verdict, summarise, RUNS_PER_KEY,
  detectInstability, planFingerprint,
} from '../src/utils/planHistory.ts';
import type { PlanRun, RunNode } from '../src/utils/planHistory.ts';
import { buildCostModel } from '../src/utils/planCost.ts';
import type { PlanNode, ParsedPlan } from '../src/utils/planParse.ts';

const node = (
  op: string, kind: string, stats: PlanNode['stats'] = {}, children: PlanNode[] = [],
): PlanNode => ({
  op, detail: '', metrics: {}, severity: 0,
  kind: kind as PlanNode['kind'], stats, children,
});

const plan = (root: PlanNode, measured = true, totalMs?: number): ParsedPlan => ({
  root, metricColumns: [], summary: '', measured, totalMs, engine: 'postgres',
});

const runOf = (sql: string, root: PlanNode, at = 1, measured = true): PlanRun => {
  const p = plan(root, measured, 100);
  return makeRun(sql, p, buildCostModel(p), at);
};

// ── grouping by shape ───────────────────────────────────────────────────────

test('changing a literal keeps the same series', () => {
  // Re-running the same query with a different parameter is the same query.
  assert.equal(
    shapeKey('SELECT * FROM orders WHERE id = 7'),
    shapeKey('SELECT * FROM orders WHERE id = 912'));
  assert.equal(
    shapeKey("SELECT * FROM t WHERE name = 'alice'"),
    shapeKey("SELECT * FROM t WHERE name = 'bob'"));
});

test('changing the query starts a new series', () => {
  assert.notEqual(
    shapeKey('SELECT * FROM orders WHERE id = 7'),
    shapeKey('SELECT * FROM orders WHERE customer_id = 7'));
});

test('formatting, case and comments do not split a series', () => {
  assert.equal(
    shapeKey('SELECT *\n  FROM orders'),
    shapeKey('select * from orders'));
  assert.equal(
    shapeKey('SELECT 1 -- note'),
    shapeKey('SELECT 1'));
  assert.equal(
    shapeKey('SELECT /* x */ 1'),
    shapeKey('SELECT 1'));
});

test('a semicolon inside a string does not confuse the key', () => {
  assert.equal(shapeKey("SELECT 'a;b'"), shapeKey("SELECT 'c;d'"));
});

// ── the series ──────────────────────────────────────────────────────────────

test('runs accumulate newest last and are capped', () => {
  let runs: PlanRun[] = [];
  for (let i = 0; i < RUNS_PER_KEY + 5; i++) {
    runs = pushRun(runs, runOf('SELECT 1', node('Result', 'result', { msSelf: i }), i));
  }
  assert.equal(runs.length, RUNS_PER_KEY);
  assert.equal(runs[runs.length - 1].at, RUNS_PER_KEY + 4, 'newest should be last');
});

test('the cap is per key — a burst of one query does not evict another', () => {
  // Tune query A over a full cap's worth of runs, then run B once. B must not
  // cost A a single run of history, or instability detection sees a series of
  // one and can never report a flip.
  let runs: PlanRun[] = [];
  for (let i = 0; i < RUNS_PER_KEY; i++) {
    runs = pushRun(runs, runOf('SELECT * FROM a', node('Seq Scan', 'scan-seq', { msSelf: i }), i));
  }
  runs = pushRun(runs, runOf('SELECT * FROM b', node('Seq Scan', 'scan-seq', { msSelf: 1 }), 999));
  assert.equal(seriesFor(runs, shapeKey('SELECT * FROM a')).length, RUNS_PER_KEY,
    "A's full history survives B");
  assert.equal(seriesFor(runs, shapeKey('SELECT * FROM b')).length, 1);

  // One more A evicts only A's oldest, never B.
  runs = pushRun(runs, runOf('SELECT * FROM a', node('Seq Scan', 'scan-seq', { msSelf: 100 }), 1000));
  const aRuns = seriesFor(runs, shapeKey('SELECT * FROM a'));
  assert.equal(aRuns.length, RUNS_PER_KEY, "A stays capped");
  assert.equal(aRuns[0].at, 1, "A's oldest (at=0) was the one evicted");
  assert.equal(seriesFor(runs, shapeKey('SELECT * FROM b')).length, 1, 'B untouched');
});

test('a series only contains comparable runs', () => {
  let runs: PlanRun[] = [];
  runs = pushRun(runs, runOf('SELECT * FROM a', node('Seq Scan', 'scan-seq', { msSelf: 5 })));
  runs = pushRun(runs, runOf('SELECT * FROM b', node('Seq Scan', 'scan-seq', { msSelf: 5 })));
  runs = pushRun(runs, runOf('SELECT * FROM a', node('Seq Scan', 'scan-seq', { msSelf: 3 })));
  assert.equal(seriesFor(runs, shapeKey('SELECT * FROM a')).length, 2);
});

test('a run captures the numbers a diff needs', () => {
  const r = runOf('SELECT 1', node('Sort', 'sort', { msSelf: 10 }, [
    node('Seq Scan', 'scan-seq', { msSelf: 40, relation: 'orders', rowsActual: 1000 }),
  ]));
  assert.equal(r.basis, 'time');
  assert.equal(r.measured, true);
  assert.equal(r.totalWeight, 50);
  const scan = r.nodes.find(n => n.op === 'Seq Scan')!;
  assert.equal(scan.relation, 'orders');
  assert.equal(scan.weight, 40);
  assert.equal(scan.rowsActual, 1000);
});

// ── the diff ────────────────────────────────────────────────────────────────

const BEFORE = node('Sort', 'sort', { msSelf: 5 }, [
  node('Seq Scan', 'scan-seq', { msSelf: 95, relation: 'orders', rowsActual: 1_000_000 }),
]);
const AFTER = node('Sort', 'sort', { msSelf: 5 }, [
  node('Index Scan', 'scan-index', { msSelf: 5, relation: 'orders', rowsActual: 40 }),
]);

test('an improvement is reported as one, with the node responsible first', () => {
  const d = diffRuns(runOf('q', BEFORE), runOf('q', AFTER));
  assert.ok(d.comparable);
  assert.equal(d.totalDelta, -90);
  assert.ok(d.totalRatio < 0);
  assert.ok(d.shapeChanged, 'a seq scan became an index scan');
  // The biggest mover leads — that is the thing that changed.
  assert.ok(/Seq Scan|Index Scan/.test(d.nodes[0].op), d.nodes[0].op);
  assert.match(verdict(d), /Improved — 90%/);
});

test('a regression is reported as one', () => {
  const d = diffRuns(runOf('q', AFTER), runOf('q', BEFORE));
  assert.ok(d.totalRatio > 0);
  assert.match(verdict(d), /Regressed/);
});

test('noise is not reported as a change', () => {
  // Two runs of an unchanged query differ by a fraction of a millisecond.
  const a = runOf('q', node('Seq Scan', 'scan-seq', { msSelf: 100, relation: 't' }));
  const b = runOf('q', node('Seq Scan', 'scan-seq', { msSelf: 100.4, relation: 't' }));
  const d = diffRuns(a, b);
  assert.equal(d.nodes[0].change, 'same');
  assert.match(verdict(d), /No meaningful change/);
});

test('nodes are matched by operation and relation, not by path', () => {
  // Inserting a node shifts every path below it; matching on path would report
  // the entire plan as rewritten.
  const before = node('Result', 'result', { msSelf: 1 }, [
    node('Seq Scan', 'scan-seq', { msSelf: 50, relation: 'orders' }),
  ]);
  const after = node('Result', 'result', { msSelf: 1 }, [
    node('Sort', 'sort', { msSelf: 2 }, [
      node('Seq Scan', 'scan-seq', { msSelf: 50, relation: 'orders' }),
    ]),
  ]);
  const d = diffRuns(runOf('q', before), runOf('q', after));
  const scan = d.nodes.find(n => n.op === 'Seq Scan')!;
  assert.equal(scan.change, 'same', 'the scan did not change, only its depth');
  assert.ok(d.nodes.some(n => n.op === 'Sort' && n.change === 'added'));
});

test('an added and a removed node are both reported', () => {
  const d = diffRuns(runOf('q', BEFORE), runOf('q', AFTER));
  assert.ok(d.nodes.some(n => n.op === 'Index Scan' && n.change === 'added'));
  assert.ok(d.nodes.some(n => n.op === 'Seq Scan' && n.change === 'removed'));
});

// ── the guard that matters most ─────────────────────────────────────────────

test('a measured run is NEVER compared with an estimate', () => {
  // Milliseconds divided by cost units is a percentage that means nothing.
  const measured = runOf('q', node('Seq Scan', 'scan-seq', { msSelf: 100 }), 1, true);
  const estimated = runOf('q', node('Seq Scan', 'scan-seq', { costSelf: 4000 }), 2, false);
  const d = diffRuns(measured, estimated);
  assert.equal(d.comparable, false);
  assert.match(d.incomparable!, /measured.*estimate/s);
  assert.match(d.incomparable!, /Re-run both the same way/);
  assert.equal(verdict(d), 'Not comparable.');
});

test('two estimated runs compare on cost, and say so', () => {
  const a = runOf('q', node('Seq Scan', 'scan-seq', { costSelf: 1000 }), 1, false);
  const b = runOf('q', node('Seq Scan', 'scan-seq', { costSelf: 100 }), 2, false);
  const d = diffRuns(a, b);
  assert.ok(d.comparable);
  assert.equal(d.after.basis, 'cost');
  assert.match(verdict(d), /cheaper/);
});

test('a zero-weight baseline does not produce Infinity', () => {
  const a = runOf('q', node('Result', 'result', {}), 1, true);
  const b = runOf('q', node('Result', 'result', { msSelf: 10 }), 2, true);
  const d = diffRuns(a, b);
  assert.ok(Number.isFinite(d.totalRatio), `got ${d.totalRatio}`);
});

test('summarise walks the whole tree', () => {
  const root = node('A', 'other', { msSelf: 1 }, [
    node('B', 'other', { msSelf: 1 }),
    node('C', 'other', { msSelf: 1 }, [node('D', 'other', { msSelf: 1 })]),
  ]);
  const p = plan(root);
  const nodes: RunNode[] = summarise(p, buildCostModel(p));
  assert.deepEqual(nodes.map(n => n.op), ['A', 'B', 'C', 'D']);
  assert.deepEqual(nodes.map(n => n.path), ['0', '0.0', '0.1', '0.1.0']);
});

// ── plan instability ────────────────────────────────────────────────────────
//
// One statement producing more than one plan is the failure people describe as
// "it was fast yesterday" — the query did not change, the optimiser's mind did.
// The trap is the opposite error: reporting instability on every run because
// the fingerprint included a number that always moves.

const scan = (relation: string, index?: string, ms?: number): PlanNode =>
  node('Scan', 'scan', { relation, ...(index ? { index } : {}), ...(ms !== undefined ? { msTotal: ms } : {}) });

test('the same plan run twice is one variant', () => {
  const s = [runOf('SELECT 1', scan('t', 'ix')), runOf('SELECT 1', scan('t', 'ix'))];
  const i = detectInstability(s);
  assert.equal(i.unstable, false);
  assert.equal(i.variants.length, 1);
  assert.deepEqual(i.variants[0].runs, [0, 1]);
});

/// The whole point of excluding numbers: timings differ on every run whether
/// or not the plan changed. A fingerprint carrying them would cry wolf always.
test('different timings alone are not a different plan', () => {
  const s = [runOf('SELECT 1', scan('t', 'ix', 10)), runOf('SELECT 1', scan('t', 'ix', 9000))];
  assert.equal(detectInstability(s).unstable, false);
});

test('the same query on a different index is a second variant', () => {
  const s = [
    runOf('SELECT 1', scan('t', 'ix_a')),
    runOf('SELECT 1', scan('t', 'ix_b')),
    runOf('SELECT 1', scan('t', 'ix_a')),
  ];
  const i = detectInstability(s);
  assert.equal(i.unstable, true);
  assert.equal(i.variants.length, 2);
  // Most-run first, so the common plan leads and the outlier is visible as one.
  assert.deepEqual(i.variants[0].runs, [0, 2]);
  assert.deepEqual(i.variants[1].runs, [1]);
});

test('losing an index entirely is a different plan', () => {
  const s = [runOf('SELECT 1', scan('t', 'ix')), runOf('SELECT 1', scan('t'))];
  assert.equal(detectInstability(s).unstable, true);
});

/// A join with its inputs swapped is a different plan, not the same one
/// written differently — build side and probe side are not interchangeable.
test('reordered join inputs are a different plan', () => {
  const j = (a: string, b: string) => node('Join', 'join', {}, [scan(a), scan(b)]);
  const s = [runOf('SELECT 1', j('a', 'b')), runOf('SELECT 1', j('b', 'a'))];
  assert.equal(detectInstability(s).unstable, true);
});

/// Two plans is a curiosity until one is far slower. That ratio is the number
/// worth putting on screen.
test('the spread between the slowest and fastest variant is reported', () => {
  const s = [
    runOf('SELECT 1', scan('t', 'ix_a', 10)),
    runOf('SELECT 1', scan('t', 'ix_b', 200)),
  ];
  const i = detectInstability(s);
  assert.ok(i.spread !== undefined);
  assert.ok(i.spread! >= 19 && i.spread! <= 21, `spread was ${i.spread}`);
});

/// Milliseconds against cost units is not a ratio, it is a category error.
test('no spread is reported across a measured and an estimated run', () => {
  const s = [
    runOf('SELECT 1', scan('t', 'ix_a', 10), 1, true),
    runOf('SELECT 1', scan('t', 'ix_b', 200), 2, false),
  ];
  assert.equal(detectInstability(s).spread, undefined);
});

test('a single run is not evidence of anything', () => {
  const i = detectInstability([runOf('SELECT 1', scan('t', 'ix'))]);
  assert.equal(i.unstable, false);
  assert.equal(i.spread, undefined);
});

test('an empty series does not throw', () => {
  const i = detectInstability([]);
  assert.equal(i.unstable, false);
  assert.deepEqual(i.variants, []);
});

test('the fingerprint carries structure, not numbers', () => {
  const withNums = plan(node('Join', 'join', { msTotal: 5, rowsActual: 900 },
    [scan('a', 'ix', 3), scan('b')]));
  const without = plan(node('Join', 'join', {}, [scan('a', 'ix'), scan('b')]));
  assert.equal(planFingerprint(withNums), planFingerprint(without));
  // …but the structure itself must survive, or everything looks identical.
  assert.notEqual(planFingerprint(without), planFingerprint(plan(scan('a', 'ix'))));
});
