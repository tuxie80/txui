/**
 * Plan findings (src/utils/planGlossary.ts).
 *
 * The rules matter more than the prose. A plan viewer that flags every
 * sequential scan gets muted within a day — and a muted warning is worse than
 * none, because the one time it is right nobody is reading it. These tests pin
 * the gates: findings fire on magnitude and context, never on the operation
 * name alone.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OP_GLOSSARY, findingsFor, allFindings } from '../src/utils/planGlossary.ts';
import { buildCostModel } from '../src/utils/planCost.ts';
import type { PlanNode, ParsedPlan, PlanNodeKind } from '../src/utils/planParse.ts';

function node(
  op: string, kind: PlanNodeKind = 'other',
  stats: PlanNode['stats'] = {}, children: PlanNode[] = [],
): PlanNode {
  return { op, detail: '', metrics: {}, severity: 0, kind, stats, children };
}
const plan = (root: PlanNode, measured = true): ParsedPlan => ({
  root, metricColumns: [], summary: '', measured, engine: 'postgres',
});
const findings = (root: PlanNode, measured = true) => {
  const model = buildCostModel(plan(root, measured));
  return findingsFor(model.byPath.get('0')!, model);
};
const badges = (root: PlanNode, measured = true) => findings(root, measured).map(f => f.badge);

// ── the glossary itself ─────────────────────────────────────────────────────

test('every operation kind has a complete explanation', () => {
  const kinds: PlanNodeKind[] = [
    'scan-seq', 'scan-index', 'scan-index-only', 'scan-bitmap', 'scan-const',
    'join-nested', 'join-hash', 'join-merge', 'sort', 'aggregate', 'group',
    'window', 'distinct', 'limit', 'union', 'subquery', 'materialize', 'cte',
    'result', 'other',
  ];
  for (const k of kinds) {
    const g = OP_GLOSSARY[k];
    assert.ok(g, `${k} has no glossary entry`);
    // A title is a short label — "CTE" is legitimately three characters.
    // what/when carry the actual explanation and must be real sentences.
    assert.ok(g.title.trim().length >= 3, `${k}.title is missing`);
    for (const field of ['what', 'when'] as const) {
      assert.ok(g[field] && g[field].length > 30, `${k}.${field} is missing or too short`);
    }
  }
});

test('every finding says what, why and what to do', () => {
  // A finding without an action is just an accusation.
  const f = findings(node('Seq Scan', 'scan-seq',
    { rowsActual: 2_000_000, msSelf: 900, relation: 'orders', flags: ['full-scan'] }));
  assert.ok(f.length > 0);
  for (const x of f) {
    assert.ok(x.observed.length > 20, 'observed is too thin');
    assert.ok(x.why.length > 20, 'why is too thin');
    assert.ok(x.action.length > 20, 'action is too thin');
    assert.ok(x.badge.length > 0 && x.badge.length <= 14, `badge "${x.badge}" is unusable`);
  }
});

// ── magnitude gating ────────────────────────────────────────────────────────

test('a full scan over a small table is NOT a finding', () => {
  // Scanning 200 rows is the correct plan and must stay silent.
  assert.deepEqual(
    badges(node('Seq Scan', 'scan-seq', { rowsActual: 200, relation: 'countries', flags: ['full-scan'] })),
    [],
  );
});

test('a full scan over a large table IS a finding', () => {
  const b = badges(node('Seq Scan', 'scan-seq',
    { rowsActual: 1_200_000, relation: 'orders', flags: ['full-scan'] }));
  assert.ok(b.includes('full scan'), `got ${JSON.stringify(b)}`);
});

test('the full-scan finding escalates when the node is also the hottest', () => {
  const hot = node('Seq Scan', 'scan-seq',
    { rowsActual: 1_200_000, msSelf: 500, relation: 'orders', flags: ['full-scan'] });
  const model = buildCostModel(plan(hot));
  const f = findingsFor(model.byPath.get('0')!, model);
  assert.equal(f.find(x => x.badge === 'full scan')!.level, 'critical');
});

test('mis-estimation is only reported on measured plans', () => {
  const n = node('Hash Join', 'join-hash', { rowsEst: 4_200, rowsActual: 1_180_000 });
  assert.ok(badges(n, true).some(b => b.includes('off')), 'measured plan should report the miss');
  // On an estimated plan there is no "actual" to compare with, so claiming a
  // mis-estimate would be inventing a measurement.
  assert.deepEqual(badges(n, false).filter(b => b.includes('off')), []);
});

test('a small cardinality miss is noise and stays quiet', () => {
  assert.deepEqual(
    badges(node('Index Scan', 'scan-index', { rowsEst: 800, rowsActual: 812 })),
    [],
  );
});

test('a large cardinality miss is reported with its factor', () => {
  const f = findings(node('Hash Join', 'join-hash', { rowsEst: 4_200, rowsActual: 1_180_000 }));
  const miss = f.find(x => x.badge.includes('off'));
  assert.ok(miss, 'no mis-estimate finding');
  assert.match(miss.badge, /^\d+× off$/);
  assert.match(miss.observed, /under-estimated/);
});

test('an over-estimate is described as an over-estimate', () => {
  const f = findings(node('Seq Scan', 'scan-seq', { rowsEst: 900_000, rowsActual: 40 }));
  const miss = f.find(x => x.badge.includes('off'));
  assert.match(miss!.observed, /over-estimated/);
});

// ── flag-driven findings ────────────────────────────────────────────────────

test('a spilled sort is always worth reporting', () => {
  const b = badges(node('Sort', 'sort', { flags: ['sort-spilled'] }));
  assert.ok(b.includes('sort spilled'));
});

test('MySQL filesort and temp table each produce their own finding', () => {
  const b = badges(node('Sort', 'sort', { flags: ['filesort', 'temp-table'] }), false);
  assert.ok(b.includes('filesort'), `got ${JSON.stringify(b)}`);
  assert.ok(b.includes('temp table'), `got ${JSON.stringify(b)}`);
});

test('a nested loop over a small outer input is fine', () => {
  const n = node('Nested Loop', 'join-nested', {}, [
    node('Index Scan', 'scan-index', { rowsActual: 30 }),
    node('Index Scan', 'scan-index', { rowsActual: 1 }),
  ]);
  assert.deepEqual(badges(n).filter(b => b === 'loop × rows'), []);
});

test('a nested loop over a large outer input is flagged', () => {
  const n = node('Nested Loop', 'join-nested', {}, [
    node('Seq Scan', 'scan-seq', { rowsActual: 900_000 }),
    node('Index Scan', 'scan-index', { rowsActual: 1 }),
  ]);
  assert.ok(badges(n).includes('loop × rows'));
});

// ── aggregation ─────────────────────────────────────────────────────────────

test('allFindings gathers the whole plan with criticals first', () => {
  const root = node('Sort', 'sort', { msSelf: 5, flags: ['sort-spilled'] }, [
    node('Seq Scan', 'scan-seq',
      { msSelf: 500, rowsActual: 3_000_000, rowsEst: 100, relation: 'orders', flags: ['full-scan'] }),
  ]);
  const all = allFindings(buildCostModel(plan(root)));
  assert.ok(all.length >= 3, `expected several findings, got ${all.length}`);
  assert.equal(all[0].finding.level, 'critical', 'criticals must sort first');
  // Each finding knows which node it came from, so the UI can select it.
  for (const { entry } of all) assert.ok(entry.path.length > 0);
});

test('a clean plan produces no findings at all', () => {
  const root = node('Index Only Scan', 'scan-index-only',
    { msSelf: 2, rowsEst: 800, rowsActual: 812, relation: 'customers', index: 'customers_pkey' });
  assert.deepEqual(allFindings(buildCostModel(plan(root))), []);
});
