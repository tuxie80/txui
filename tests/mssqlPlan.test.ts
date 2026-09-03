/**
 * SHOWPLAN_XML → the shared plan model.
 *
 * Both fixtures are real documents captured from SQL Server 2022 against
 * `dev/mssql_fixture.sql`: one estimated (`SET SHOWPLAN_XML ON`) and one
 * measured (`SET STATISTICS XML ON`). The point of using captured XML rather
 * than hand-written snippets is that SHOWPLAN's nesting — operators inside
 * operator-specific wrappers, several statements per batch — is exactly what a
 * naive parser gets wrong, and only a real plan has it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  parseMssqlPlan, mssqlKind, childElements,
  MSSQL_PLAN_ON, MSSQL_PLAN_OFF, MSSQL_STATS_ON, MSSQL_STATS_OFF,
} from '../src/utils/mssqlPlan.ts';
import { parsePlan } from '../src/utils/planParse.ts';
import type { PlanNode } from '../src/utils/planParse.ts';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (n: string) => readFileSync(join(here, 'fixtures', n), 'utf8');
const ESTIMATED = fixture('mssql-showplan.xml');
const MEASURED = fixture('mssql-statistics-xml.xml');

function flatten(n: PlanNode): PlanNode[] {
  return [n, ...n.children.flatMap(flatten)];
}

test('nested operators survive — the tree is not truncated at the first branch', () => {
  const p = parseMssqlPlan(ESTIMATED);
  const all = flatten(p.root);
  // A regex matching <RelOp>…</RelOp> non-greedily pairs the outer start tag
  // with the first INNER end tag and returns a one-node "tree".
  assert.ok(all.length >= 6, `only ${all.length} nodes`);
  const join = all.find(n => n.kind === 'join-hash');
  assert.ok(join, 'the hash join is missing');
  assert.equal(join!.children.length, 2, 'a join with fewer than two inputs is not a join');
});

test('an operator is not labelled with its child\'s table', () => {
  // A Sort has no <Object> of its own; scanning the whole subtree finds the
  // scan underneath it and labels the sort with a table it never touches.
  const p = parseMssqlPlan(ESTIMATED);
  assert.equal(p.root.op, 'Sort');
  assert.ok(!/sales\./.test(p.root.detail), `sort claims a table: ${p.root.detail}`);
  const scan = flatten(p.root).find(n => n.op === 'Clustered Index Scan');
  assert.match(scan!.detail, /sales\.orders/);
});

test('a Clustered Index Scan is classified as a table scan, because it is one', () => {
  // The clustered index IS the table. Calling this an index access paints the
  // single most common SQL Server performance problem green.
  assert.equal(mssqlKind('Clustered Index Scan', 'Clustered Index Scan'), 'scan-seq');
  assert.equal(mssqlKind('Table Scan', 'Table Scan'), 'scan-seq');
  assert.equal(mssqlKind('Index Seek', 'Index Seek'), 'scan-index');
  assert.equal(mssqlKind('Clustered Index Seek', 'Clustered Index Seek'), 'scan-index');
});

test('Hash Match is three operators wearing one name', () => {
  assert.equal(mssqlKind('Hash Match', 'Inner Join'), 'join-hash');
  assert.equal(mssqlKind('Hash Match', 'Aggregate'), 'aggregate');
  assert.equal(mssqlKind('Hash Match', 'Distinct'), 'distinct');
  // And the fixture proves the aggregate case is real, not hypothetical.
  const p = parseMssqlPlan(ESTIMATED);
  const agg = flatten(p.root).find(n => n.op === 'Hash Match' && n.kind === 'aggregate');
  assert.ok(agg, 'the aggregating Hash Match was classified as a join');
});

test('costs are self-costs — a subtree cost is not a node cost', () => {
  const p = parseMssqlPlan(ESTIMATED);
  // SHOWPLAN reports EstimatedTotalSubtreeCost, which is cumulative; the root
  // would otherwise be 100% of everything and every tint useless.
  assert.ok(p.root.stats.costTotal! > p.root.stats.costSelf!);
  for (const n of flatten(p.root)) {
    assert.ok((n.stats.costSelf ?? 0) >= 0, `${n.op} has a negative self cost`);
  }
  // The costliest operator in this plan is the scan of orders, not the root.
  const worst = flatten(p.root).sort((a, b) => b.severity - a.severity)[0];
  assert.equal(worst.op, 'Clustered Index Scan');
});

test('an estimated plan is never presented as a measurement', () => {
  const est = parseMssqlPlan(ESTIMATED);
  assert.equal(est.measured, false);
  assert.equal(est.totalMs, undefined);
  assert.ok(!est.metricColumns.includes('rows actual'));
  assert.ok(flatten(est.root).every(n => n.stats.rowsActual === undefined));

  const act = parseMssqlPlan(MEASURED);
  assert.equal(act.measured, true);
  assert.ok(act.totalMs !== undefined);
  assert.ok(act.metricColumns.includes('rows actual'));
  assert.ok(act.metricColumns.includes('ms'));
});

test('measured rows come from the runtime counters, summed across threads', () => {
  const p = parseMssqlPlan(MEASURED);
  const scan = flatten(p.root).find(n => n.op === 'Index Scan');
  assert.ok(scan, 'no index scan in the measured plan');
  // 33,334 rows is the fixture's order count after its deliberate DELETE.
  assert.equal(scan!.stats.rowsActual, 33334);
  assert.equal(scan!.stats.rowsEst, 33334);
});

test('a missing-index suggestion is surfaced, not buried in the XML', () => {
  const p = parseMssqlPlan(ESTIMATED);
  assert.match(p.summary, /missing index/i);
  assert.ok(p.root.stats.flags?.includes('missing index suggested'));
});

test('the summary says which numbers these are', () => {
  assert.match(parseMssqlPlan(ESTIMATED).summary, /Estimated subtree cost/);
  assert.match(parseMssqlPlan(MEASURED).summary, /Execution \d+ ms/);
});

test('parsePlan routes SQL Server without the caller naming a format', () => {
  const p = parsePlan('sqlserver', MEASURED);
  assert.equal(p.engine, 'sqlserver');
  assert.equal(p.measured, true);
});

test('non-plan content throws rather than rendering an empty diagram', () => {
  assert.throws(() => parseMssqlPlan('not xml at all'), /not a SHOWPLAN_XML/);
  // A DDL statement gets a document with no operator tree in it.
  assert.throws(
    () => parseMssqlPlan('<ShowPlanXML><BatchSequence><Batch><Statements>'
      + '<StmtSimple StatementText="CREATE TABLE t (id int)" StatementType="CREATE TABLE"/>'
      + '</Statements></Batch></BatchSequence></ShowPlanXML>'),
    /no query plan/);
});

test('childElements counts depth — a nested element does not close its parent', () => {
  const xml = '<A id="1"><A id="2"><A id="3"/></A></A><A id="4"/>';
  const top = childElements(xml, 'A');
  assert.deepEqual(top.map(e => e.attrs.id), ['1', '4']);
  assert.deepEqual(childElements(top[0].inner, 'A').map(e => e.attrs.id), ['2']);
});

test('XML entities in the statement text are decoded once, not twice', () => {
  const p = parseMssqlPlan(ESTIMATED);
  // The summary is capped at 120 characters, so the fixture's &apos; falls off
  // the end — decoding is checked on a document that keeps it in range, and the
  // real plan is checked for the absence of any leftover entity.
  assert.ok(!/&(?:apos|quot|lt|gt|amp|#\d+);/.test(p.summary), p.summary);
  const q = parseMssqlPlan(
    '<ShowPlanXML><BatchSequence><Batch><Statements>'
    + '<StmtSimple StatementText="SELECT * FROM t WHERE a=&apos;x&apos; AND b&lt;1 AND c=&amp;amp;">'
    + '<QueryPlan><RelOp PhysicalOp="Table Scan" LogicalOp="Table Scan" '
    + 'EstimateRows="1" EstimatedTotalSubtreeCost="0.1"/></QueryPlan>'
    + '</StmtSimple></Statements></Batch></BatchSequence></ShowPlanXML>');
  assert.match(q.summary, /a='x' AND b<1/);
  // &amp;amp; is an escaped &amp; — decoding & first would turn it into <, >…
  assert.match(q.summary, /c=&amp;$/);
});

test('the SET statements are exported, because the caller must turn them off', () => {
  // A connection left in SHOWPLAN mode silently stops executing anything.
  assert.equal(MSSQL_PLAN_ON, 'SET SHOWPLAN_XML ON');
  assert.equal(MSSQL_PLAN_OFF, 'SET SHOWPLAN_XML OFF');
  assert.equal(MSSQL_STATS_ON, 'SET STATISTICS XML ON');
  assert.equal(MSSQL_STATS_OFF, 'SET STATISTICS XML OFF');
});
