/**
 * ClickHouse EXPLAIN parsing (src/utils/planClickhouse.ts).
 *
 * ClickHouse has no JSON plan and no cost model — every EXPLAIN kind answers
 * plain text. These cover the three shapes the backend sends (indexes=1,
 * PIPELINE, ESTIMATE) plus the cases that must fall back to the raw view.
 * Fixtures are trimmed from real server output (25.x/26.x text format).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseClickhousePlan, chKind } from '../src/utils/planClickhouse.ts';
import { parsePlan } from '../src/utils/planParse.ts';
import type { PlanNode } from '../src/utils/planParse.ts';

const flatten = (n: PlanNode): PlanNode[] =>
  [n, ...n.children.flatMap(flatten)];

describe('EXPLAIN indexes = 1', () => {
  const content = [
    'Expression ((Projection + Before ORDER BY [lifted up]))',
    '  ReadFromMergeTree (default.hits)',
    '  Indexes:',
    '    MinMax',
    '      Keys: ',
    '        event_date',
    '      Condition: (event_date in [18278, +Inf))',
    '      Parts: 3/3',
    '      Granules: 366/366',
    '    PrimaryKey',
    '      Keys: ',
    '        user_id',
    '      Condition: (user_id in 2-element set)',
    '      Parts: 1/3',
    '      Granules: 12/366',
  ].join('\n');

  test('the plan tree keeps its indentation structure', () => {
    const p = parseClickhousePlan(content);
    assert.equal(p.root.op, 'Expression ((Projection + Before ORDER BY [lifted up]))');
    assert.equal(p.root.children.length, 2);
    const [scan, indexes] = p.root.children;
    assert.equal(scan.op, 'ReadFromMergeTree (default.hits)');
    assert.equal(scan.kind, 'scan-seq');
    assert.equal(indexes.op, 'Indexes');
    assert.deepEqual(indexes.children.map(c => c.op), ['MinMax', 'PrimaryKey']);
  });

  test('index range details stay verbatim', () => {
    const p = parseClickhousePlan(content);
    const nodes = flatten(p.root);
    const cond = nodes.find(n => n.op === 'Condition' && n.detail.includes('user_id'))!;
    assert.equal(cond.detail, '(user_id in 2-element set)');
    const granules = nodes.filter(n => n.op === 'Granules');
    assert.deepEqual(granules.map(g => g.detail), ['366/366', '12/366']);
  });

  test('parses through the engine router', () => {
    const p = parsePlan('clickhouse', content);
    assert.equal(p.engine, 'clickhouse');
    assert.equal(p.measured, false);
    assert.deepEqual(p.metricColumns, []);
  });
});

describe('EXPLAIN PIPELINE', () => {
  const content = [
    '(Expression)',
    'ExpressionTransform × 2',
    '  (Aggregating)',
    '  AggregatingTransform',
    '    (Expression)',
    '    ExpressionTransform',
    '      (ReadFromMergeTree)',
    '      MergeTreeSelect(pool: PrefetchedReadPool, algorithm: Thread) 0 → 1',
  ].join('\n');

  test('scope headers unwrap and group their transforms', () => {
    const p = parseClickhousePlan(content);
    assert.equal(p.root.op, 'Expression');
    assert.equal(p.root.children[0].op, 'ExpressionTransform');
    // The × N multiplier rides as detail, not inside the label.
    assert.equal(p.root.children[0].detail, '× 2');
    const agg = p.root.children[0].children[0];
    assert.equal(agg.op, 'Aggregating');
    assert.equal(agg.kind, 'aggregate');
    assert.equal(agg.children[0].op, 'AggregatingTransform');
  });

  test('a transform naming its thread pool keeps the whole label', () => {
    const p = parseClickhousePlan(content);
    const nodes = flatten(p.root);
    const sel = nodes.find(n => n.op.startsWith('MergeTreeSelect'))!;
    // The colon-split must not fire here — only the known index labels split.
    assert.equal(sel.op,
      'MergeTreeSelect(pool: PrefetchedReadPool, algorithm: Thread) 0 → 1');
    assert.equal(sel.kind, 'scan-seq');
  });
});

describe('EXPLAIN PLAN', () => {
  test('Header lines are dropped, steps keep their nesting', () => {
    const content = [
      'Expression ((Projection + Before ORDER BY))',
      'Header: x UInt8',
      '  Aggregating',
      '  Header: x UInt8',
      '    Expression (Before GROUP BY)',
      '    Header: x UInt8',
      '      ReadFromMergeTree (default.t)',
    ].join('\n');
    const p = parseClickhousePlan(content);
    assert.equal(p.root.op, 'Expression ((Projection + Before ORDER BY))');
    assert.equal(p.root.children.length, 1);
    assert.equal(p.root.children[0].op, 'Aggregating');
    assert.equal(p.root.children[0].children[0].op, 'Expression (Before GROUP BY)');
    assert.equal(p.root.children[0].children[0].children[0].kind, 'scan-seq');
    assert.ok(!flatten(p.root).some(n => n.op.startsWith('Header')));
  });
});

describe('EXPLAIN ESTIMATE', () => {
  const content = 'default\thits\t3\t366\t3000000\ndefault\tevents\t8\t1024\t75000000';

  test('rows become metric columns, not a tree', () => {
    const p = parseClickhousePlan(content);
    assert.deepEqual(p.metricColumns, ['Parts', 'Rows', 'Marks']);
    assert.equal(p.root.children.length, 2);
    const [hits, events] = p.root.children;
    assert.equal(hits.op, 'default.hits');
    assert.equal(hits.metrics['Parts'], '3');
    assert.equal(hits.metrics['Rows'], '366');
    assert.equal(events.metrics['Marks'], (75000000).toLocaleString());
  });

  test('severity is each table\'s share of rows to be read', () => {
    const p = parseClickhousePlan(content);
    const [hits, events] = p.root.children;
    // Rows column (not marks) drives the share: 366 / (366 + 1024).
    assert.ok(Math.abs(events.severity - 1024 / 1390) < 1e-9, `events ${events.severity}`);
    assert.ok(Math.abs(hits.severity - 366 / 1390) < 1e-9, `hits ${hits.severity}`);
  });
});

describe('fallbacks', () => {
  test('empty and single-line answers throw so the raw view takes over', () => {
    assert.throws(() => parseClickhousePlan(''));
    assert.throws(() => parseClickhousePlan('   \n  '));
    assert.throws(() => parseClickhousePlan('Expression (Projection)'));
  });

  test('literal \\n from captured logs is tolerated', () => {
    const p = parseClickhousePlan('Expression (Projection)\\n  ReadFromMergeTree (d.t)');
    assert.equal(p.root.children[0].op, 'ReadFromMergeTree (d.t)');
  });
});

describe('chKind', () => {
  test('maps CH vocabulary onto the shared kinds', () => {
    assert.equal(chKind('ReadFromMergeTree (default.hits)'), 'scan-seq');
    assert.equal(chKind('AggregatingTransform'), 'aggregate');
    assert.equal(chKind('MergingSortedTransform'), 'sort');
    assert.equal(chKind('JoinTransform'), 'join-hash');
    assert.equal(chKind('LimitTransform'), 'limit');
    assert.equal(chKind('DistinctTransform'), 'distinct');
    assert.equal(chKind('WindowTransform'), 'window');
    assert.equal(chKind('CreatingSetsTransform'), 'materialize');
    assert.equal(chKind('Expression (Projection)'), 'result');
    assert.equal(chKind('ResizeTransform'), 'other');
  });
});
