/**
 * Plan comparison (src/utils/planDiff.ts).
 *
 * The question `ExplainView` cannot answer on its own: *did the index help?*
 * Most of the risk is in node matching — a diff that reports every node after
 * an insertion as changed says everything and means nothing.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { diffPlans, flattenDiff, primaryMetric } from '../src/utils/planDiff.ts';
import type { ParsedPlan, PlanNode } from '../src/utils/planParse.ts';

const node = (
  op: string,
  stats: Partial<PlanNode['stats']> = {},
  children: PlanNode[] = [],
): PlanNode => ({
  op, detail: '', metrics: {}, severity: 0, kind: 'other' as PlanNode['kind'],
  stats: stats as PlanNode['stats'], children,
});

const plan = (root: PlanNode, measured = true): ParsedPlan => ({
  root, metricColumns: [], summary: '', measured, engine: 'mysql',
} as ParsedPlan);

describe('comparability', () => {
  /// Estimated costs and measured timings are different quantities. A diff
  /// putting them in one column is a category error with a number attached.
  test('an EXPLAIN against an EXPLAIN ANALYZE is refused', () => {
    const d = diffPlans(plan(node('Scan'), false), plan(node('Scan'), true));
    assert.equal(d.comparable, false);
    assert.equal(d.root, null);
    assert.match(d.incomparableReason!, /different quantities/);
    assert.match(d.incomparableReason!, /Capture both the same way/);
  });

  test('two of the same kind compare', () => {
    assert.equal(diffPlans(plan(node('Scan')), plan(node('Scan'))).comparable, true);
  });
});

describe('node matching', () => {
  /// Matching by position alone reports everything after an insertion as
  /// changed, which is the failure that makes a diff useless.
  test('an inserted node does not make its siblings look changed', () => {
    const before = node('Join', {}, [
      node('Scan', { relation: 'a', rowsActual: 10 }),
      node('Scan', { relation: 'b', rowsActual: 20 }),
    ]);
    const after = node('Join', {}, [
      node('Scan', { relation: 'a', rowsActual: 10 }),
      node('Sort', { relation: 'x' }),
      node('Scan', { relation: 'b', rowsActual: 20 }),
    ]);
    const d = diffPlans(plan(before), plan(after));
    assert.equal(d.added, 1);
    assert.equal(d.changed, 0, 'a sibling was reported as changed by an insertion');
  });

  test('a removed node is reported as removed', () => {
    const before = node('Join', {}, [node('Scan', { relation: 'a' }), node('Sort', { relation: 'x' })]);
    const after = node('Join', {}, [node('Scan', { relation: 'a' })]);
    const d = diffPlans(plan(before), plan(after));
    assert.equal(d.removed, 1);
  });

  /// The change actually being looked for: same table, different index. It
  /// must pair up rather than reading as one removal plus one addition.
  test('a node whose index changed still pairs with its predecessor', () => {
    const before = node('Scan', { relation: 'orders', index: 'ix_old', rowsActual: 1000 });
    const after = node('Scan', { relation: 'orders', index: 'ix_new', rowsActual: 10 });
    const d = diffPlans(plan(before), plan(after));
    assert.equal(d.added, 0);
    assert.equal(d.removed, 0);
    assert.equal(d.changed, 1);
    assert.match(d.root!.accessChange!, /index ix_old → ix_new/);
  });
});

describe('access path', () => {
  test('gaining an index is spelled out', () => {
    const d = diffPlans(
      plan(node('Scan', { relation: 't' })),
      plan(node('Scan', { relation: 't', index: 'ix' })));
    assert.match(d.root!.accessChange!, /now uses index ix/);
  });

  test('losing an index is spelled out', () => {
    const d = diffPlans(
      plan(node('Scan', { relation: 't', index: 'ix' })),
      plan(node('Scan', { relation: 't' })));
    assert.match(d.root!.accessChange!, /no longer uses index ix/);
  });

  test('a changed operation is reported', () => {
    const d = diffPlans(plan(node('Seq Scan')), plan(node('Index Scan')));
    assert.match(d.root!.accessChange!, /Seq Scan → Index Scan/);
  });
});

describe('metric deltas', () => {
  test('a large drop in rows is reported as better', () => {
    const d = diffPlans(
      plan(node('Scan', { relation: 't', rowsActual: 100000 })),
      plan(node('Scan', { relation: 't', rowsActual: 100 })));
    const m = d.root!.metrics.find(x => x.name === 'rows')!;
    assert.equal(m.better, true);
    assert.ok(m.ratio! < 0.01);
  });

  /// Two runs of the same plan differ by cache state alone; reporting a 5 %
  /// wobble as a regression trains people to ignore the diff.
  test('timing noise below the floor is not reported', () => {
    const d = diffPlans(
      plan(node('Scan', { relation: 't', msTotal: 100 })),
      plan(node('Scan', { relation: 't', msTotal: 110 })));
    assert.equal(d.root!.metrics.find(x => x.name === 'time'), undefined);
  });

  test('a real timing change is reported', () => {
    const d = diffPlans(
      plan(node('Scan', { relation: 't', msTotal: 100 })),
      plan(node('Scan', { relation: 't', msTotal: 20 })));
    assert.equal(d.root!.metrics.find(x => x.name === 'time')!.better, true);
  });

  /// 1 → 2 rows is a doubling and is noise; the absolute guard stops it.
  test('a tiny absolute change is not a doubling worth reading', () => {
    const d = diffPlans(
      plan(node('Scan', { relation: 't', rowsActual: 1 })),
      plan(node('Scan', { relation: 't', rowsActual: 1 })));
    assert.equal(d.root!.metrics.length, 0);
  });

  test('a metric present on one side only is reported without a ratio', () => {
    const d = diffPlans(
      plan(node('Scan', { relation: 't' })),
      plan(node('Scan', { relation: 't', rowsActual: 50 })));
    const m = d.root!.metrics.find(x => x.name === 'rows')!;
    assert.equal(m.before, undefined);
    assert.equal(m.after, 50);
    assert.equal(m.ratio, undefined);
  });

  test('zero before does not produce an infinite ratio', () => {
    const d = diffPlans(
      plan(node('Scan', { relation: 't', rowsActual: 0 })),
      plan(node('Scan', { relation: 't', rowsActual: 500 })));
    const m = d.root!.metrics.find(x => x.name === 'rows')!;
    assert.equal(m.ratio, undefined);
    assert.equal(m.delta, 500);
  });
});

describe('headline', () => {
  test('identical plans say so', () => {
    const p = () => plan(node('Scan', { relation: 't', rowsActual: 5 }));
    assert.match(diffPlans(p(), p()).headline, /identical/);
  });

  test('a faster plan reports the factor', () => {
    const d = diffPlans(
      plan(node('Scan', { relation: 't', msTotal: 100, index: 'a' })),
      plan(node('Scan', { relation: 't', msTotal: 10, index: 'b' })));
    assert.match(d.headline, /10\.0× faster/);
  });

  test('a slower plan says slower', () => {
    const d = diffPlans(
      plan(node('Scan', { relation: 't', msTotal: 10, index: 'a' })),
      plan(node('Scan', { relation: 't', msTotal: 40, index: 'b' })));
    assert.match(d.headline, /4\.0× slower/);
  });

  /// The interesting middle case — same speed, different plan. Reporting only
  /// the time would hide that anything happened.
  test('same time but a changed plan says both', () => {
    const d = diffPlans(
      plan(node('Scan', { relation: 't', msTotal: 100, index: 'a' })),
      plan(node('Scan', { relation: 't', msTotal: 100, index: 'b' })));
    assert.match(d.headline, /About the same time/);
    assert.match(d.headline, /the plan changed/);
  });

  test('with no timings it falls back to rows', () => {
    const d = diffPlans(
      plan(node('Scan', { relation: 't', rowsEst: 1000, index: 'a' })),
      plan(node('Scan', { relation: 't', rowsEst: 100, index: 'b' })));
    assert.match(d.headline, /10\.0× fewer rows/);
  });
});

/**
 * A node can move on several metrics at once, and the comparison has one set
 * of numeric columns. Which metric wins decides what the row appears to say.
 */
describe('primaryMetric', () => {
  const between = (b: Partial<PlanNode['stats']>, a: Partial<PlanNode['stats']>) =>
    primaryMetric(diffPlans(plan(node('Scan', b)), plan(node('Scan', a))).root!);

  /// Measured time is the only metric that is not a model's opinion.
  test('measured time outranks cost and rows', () => {
    const m = between(
      { relation: 't', msTotal: 100, costTotal: 500, rowsActual: 1000 },
      { relation: 't', msTotal: 10, costTotal: 50, rowsActual: 10 });
    assert.equal(m!.name, 'time');
  });

  test('cost stands in when nothing was measured', () => {
    const m = between(
      { relation: 't', costTotal: 500, rowsActual: 1000 },
      { relation: 't', costTotal: 50, rowsActual: 10 });
    assert.equal(m!.name, 'cost');
  });

  test('rows are used when neither is present', () => {
    const m = between({ relation: 't', rowsActual: 1000 }, { relation: 't', rowsActual: 10 });
    assert.equal(m!.name, 'rows');
  });

  /// A node whose access path changed without any metric moving — an index
  /// swap on a cached table. There is nothing to put in the columns, and
  /// inventing a number would be worse than a dash.
  test('a node with no moved metric has none', () => {
    const d = diffPlans(
      plan(node('Scan', { relation: 't', index: 'a' })),
      plan(node('Scan', { relation: 't', index: 'b' })));
    assert.equal(d.root!.accessChange !== undefined, true);
    assert.equal(primaryMetric(d.root!), undefined);
  });
});

describe('flattenDiff', () => {
  const tree = node('Join', { relation: 'j' }, [
    node('Scan', { relation: 'a' }),
    node('Scan', { relation: 'b', rowsActual: 10 }),
  ]);
  const changedTree = node('Join', { relation: 'j' }, [
    node('Scan', { relation: 'a' }),
    node('Scan', { relation: 'b', rowsActual: 5000 }),
  ]);

  test('everything is returned when not filtering', () => {
    const d = diffPlans(plan(tree), plan(changedTree));
    assert.equal(flattenDiff(d.root, false).length, 3);
  });

  /// Dropping unchanged ancestors would leave the interesting nodes in a flat
  /// list with no indication of where in the plan they sit.
  test('filtering keeps the changed node and its ancestors', () => {
    const d = diffPlans(plan(tree), plan(changedTree));
    const kept = flattenDiff(d.root, true);
    assert.equal(kept.length, 2, kept.map(k => k.op).join(','));
    assert.deepEqual(kept.map(k => k.op), ['Join', 'Scan']);
    assert.equal(kept[1].status, 'changed');
  });

  test('an unchanged tree filters to nothing', () => {
    const d = diffPlans(plan(tree), plan(tree));
    assert.deepEqual(flattenDiff(d.root, true), []);
  });

  test('a null root flattens to nothing', () => {
    assert.deepEqual(flattenDiff(null, true), []);
  });
});
