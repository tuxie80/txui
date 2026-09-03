/**
 * SQL Server SHOWPLAN_XML → the plan model PostgreSQL and MySQL already feed.
 *
 * ## How SQL Server hands over a plan, and why it needs its own batch
 *
 * There is no `EXPLAIN` keyword. `SET SHOWPLAN_XML ON` puts the *session* into
 * a mode where the next statements are compiled and returned as an XML document
 * instead of being executed, and `SET STATISTICS XML ON` is the measured
 * counterpart: the query really runs, and the plan comes back with actual row
 * counts and per-operator timings beside the estimates.
 *
 * Two consequences shape the caller:
 *
 * 1. **The SET must be alone in its batch** — `SET SHOWPLAN_XML ON` next to
 *    anything else is Msg 1067, *"The SET SHOWPLAN statements must be the only
 *    statements in the batch"*. So it is sent, the statement is sent, and the
 *    SET is turned off again: three round trips on one pinned connection.
 * 2. **It is session state**, so it must be turned back off. A connection left
 *    in SHOWPLAN mode silently stops executing anything — every subsequent
 *    query returns a plan and changes nothing, which looks like the server
 *    ignoring the user.
 *
 * ## Estimated and actual are different documents
 *
 * `SHOWPLAN_XML` has `EstimateRows` and no `RunTimeInformation`.
 * `STATISTICS XML` adds `<RunTimeInformation>` with per-thread counters that
 * have to be summed. `measured` says which one arrived, because presenting an
 * estimate as a measurement is how someone ends up tuning the cost model rather
 * than the query.
 *
 * ## Why regex and not DOMParser
 *
 * Same reason as `mssqlDeadlock.ts`: `DOMParser` does not exist under
 * `node --test`, and this is machine-generated XML with a rigid schema, so
 * targeted scanning is sound here in a way it would not be for hand-written
 * markup. The nesting is handled by a real depth-counting scanner, not by a
 * regex pretending to match balanced tags.
 *
 * Pure: no server, no DOM. Driven by `node --test` against a captured plan.
 */
import type { ParsedPlan, PlanNode, PlanNodeKind, PlanStats } from './planParse.ts';

/** Statements that put a session into plan mode, and take it back out. */
export const MSSQL_PLAN_ON = 'SET SHOWPLAN_XML ON';
export const MSSQL_PLAN_OFF = 'SET SHOWPLAN_XML OFF';
export const MSSQL_STATS_ON = 'SET STATISTICS XML ON';
export const MSSQL_STATS_OFF = 'SET STATISTICS XML OFF';

/** Attributes of one start tag, as a map. */
function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([\w:.-]+)="([^"]*)"/g)) out[m[1]] = unescapeXml(m[2]);
  return out;
}

function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#x0?D;/gi, '\r').replace(/&#x0?A;/gi, '\n')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, '&');   // last, or an escaped &amp;lt; decodes twice
}

interface Element {
  attrs: Record<string, string>;
  /** Everything between the start and end tag; '' for a self-closing element. */
  inner: string;
}

/**
 * Elements named `name` at the TOP level of `xml` — not inside a nested one.
 *
 * The depth counting is the whole point. A `<RelOp>` contains other `<RelOp>`s,
 * so `/<RelOp[\s\S]*?<\/RelOp>/` matches the first start tag against the first
 * *inner* end tag and truncates the tree at the first branch.
 */
export function childElements(xml: string, name: string): Element[] {
  const out: Element[] = [];
  const open = new RegExp(`<${name}(\\s[^>]*?)?(/?)>`, 'g');
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = matchFrom(open, xml, i)) !== null) {
    const attrText = m[1] ?? '';
    if (m[2] === '/') {
      out.push({ attrs: attrs(attrText), inner: '' });
      i = m.index + m[0].length;
      continue;
    }
    const bodyStart = m.index + m[0].length;
    const end = matchingEnd(xml, name, bodyStart);
    out.push({ attrs: attrs(attrText), inner: xml.slice(bodyStart, end) });
    i = end + name.length + 3;   // past `</name>`
  }
  return out;
}

function matchFrom(re: RegExp, s: string, from: number): RegExpExecArray | null {
  re.lastIndex = from;
  return re.exec(s);
}

/** Index of the `</name>` that closes the element whose body starts at `from`. */
function matchingEnd(xml: string, name: string, from: number): number {
  const tag = new RegExp(`<(/?)${name}(\\s[^>]*?)?(/?)>`, 'g');
  let depth = 1;
  let m: RegExpExecArray | null;
  tag.lastIndex = from;
  while ((m = tag.exec(xml)) !== null) {
    if (m[1] === '/') {
      depth--;
      if (depth === 0) return m.index;
    } else if (m[3] !== '/') {
      depth++;
    }
  }
  return xml.length;
}

/**
 * A physical operator name onto the shared classifier.
 *
 * The mapping that matters most is the one people get wrong by eye: a
 * **Clustered Index Scan is a table scan**. The clustered index *is* the table,
 * so reading it end to end is exactly what `Seq Scan` means on PostgreSQL, and
 * classifying it as an index access would paint the single most common
 * performance problem in SQL Server green.
 */
export function mssqlKind(physicalOp: string, logicalOp: string): PlanNodeKind {
  const p = physicalOp;
  if (p === 'Table Scan' || p === 'Clustered Index Scan' || p === 'Remote Scan') return 'scan-seq';
  if (p === 'Index Scan' || p === 'Columnstore Index Scan') return 'scan-index-only';
  if (/Seek|Lookup/.test(p)) return 'scan-index';
  if (p === 'Constant Scan') return 'scan-const';
  if (p === 'Nested Loops') return 'join-nested';
  if (p === 'Merge Join') return 'join-merge';
  if (p === 'Hash Match') {
    // One physical operator, three jobs — only the logical op says which.
    if (/Join/i.test(logicalOp)) return 'join-hash';
    if (/Aggregate/i.test(logicalOp)) return 'aggregate';
    if (/Distinct|Union/i.test(logicalOp)) return 'distinct';
    return 'join-hash';
  }
  if (p === 'Sort') return /Distinct/i.test(logicalOp) ? 'distinct' : 'sort';
  if (p === 'Stream Aggregate') return 'aggregate';
  if (p === 'Top') return 'limit';
  if (p === 'Concatenation' || p === 'Merge Interval') return 'union';
  if (/Spool/.test(p)) return 'materialize';
  if (p === 'Segment' || p === 'Window Spool' || p === 'Window Aggregate') return 'window';
  if (p === 'Table-valued function' || p === 'UDX') return 'subquery';
  return 'other';
}

const num = (v: string | undefined): number | undefined => {
  if (v === undefined || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

/** The `Database.Schema.Table.Index` an operator touches, as far as it names one. */
function objectOf(inner: string): { relation?: string; index?: string } {
  const obj = childElements(inner, 'Object')[0];
  if (!obj) return {};
  const bare = (s: string | undefined) => s?.replace(/^\[|\]$/g, '');
  const parts = [bare(obj.attrs.Schema), bare(obj.attrs.Table)].filter(Boolean);
  return { relation: parts.join('.') || undefined, index: bare(obj.attrs.Index) };
}

/**
 * Actual counters, summed across threads.
 *
 * `RunTimeCountersPerThread` is one row per thread on a parallel plan; the
 * rows are summed but the *elapsed* time is a maximum, because threads run at
 * the same time. Adding elapsed across eight threads reports eight times the
 * wall clock the query took, which is the kind of number that sends someone
 * optimising the wrong operator.
 */
function runtime(inner: string): { rows?: number; execs?: number; ms?: number } {
  const rt = childElements(inner, 'RunTimeInformation')[0];
  if (!rt) return {};
  const threads = childElements(rt.inner, 'RunTimeCountersPerThread');
  if (threads.length === 0) return {};
  let rows = 0;
  let execs = 0;
  let ms = 0;
  for (const t of threads) {
    rows += num(t.attrs.ActualRows) ?? 0;
    execs += num(t.attrs.ActualExecutions) ?? 0;
    ms = Math.max(ms, num(t.attrs.ActualElapsedms) ?? 0);
  }
  return { rows, execs, ms };
}

/** Warnings SQL Server attaches to an operator, as short flags. */
function warningFlags(inner: string): string[] {
  const w = childElements(inner, 'Warnings')[0];
  const flags: string[] = [];
  if (w) {
    if (w.attrs.NoJoinPredicate === 'true') flags.push('no join predicate');
    if (w.attrs.SpillToTempDb === 'true' || /<SpillToTempDb/.test(w.inner)) flags.push('spilled to tempdb');
    if (/<ColumnsWithNoStatistics/.test(w.inner)) flags.push('missing statistics');
    if (/<PlanAffectingConvert/.test(w.inner)) flags.push('implicit conversion');
    if (/<SortSpillDetails/.test(w.inner)) flags.push('sort spill');
    if (/<HashSpillDetails/.test(w.inner)) flags.push('hash spill');
    if (/<Wait /.test(w.inner)) flags.push('waited');
  }
  return flags;
}

/**
 * `inner` with every nested `<RelOp>` subtree removed.
 *
 * Without this, an operator inherits its child's table: a `Sort` has no
 * `<Object>` of its own, so a naive scan finds the one belonging to the scan
 * underneath it and labels the sort with a table it never touches. Every
 * per-operator lookup — object, warnings, runtime counters — has to run against
 * the operator's OWN body.
 */
function ownBody(inner: string): string {
  let out = '';
  let i = 0;
  const open = /<RelOp(\s[^>]*?)?(\/?)>/g;
  for (;;) {
    open.lastIndex = i;
    const m = open.exec(inner);
    if (!m) break;
    out += inner.slice(i, m.index);
    if (m[2] === '/') { i = m.index + m[0].length; continue; }
    const bodyStart = m.index + m[0].length;
    i = matchingEnd(inner, 'RelOp', bodyStart) + '</RelOp>'.length;
  }
  return out + inner.slice(i);
}

/** Build one node and, recursively, its children. */
function buildNode(el: Element, missingIndex: boolean): PlanNode {
  const a = el.attrs;
  const physicalOp = a.PhysicalOp ?? 'Unknown';
  const logicalOp = a.LogicalOp ?? '';
  const subtree = num(a.EstimatedTotalSubtreeCost);

  // Children are the RelOps directly inside this one — SQL Server nests them
  // under an operator-specific wrapper (`<Hash>`, `<NestedLoops>`, …), so the
  // scan looks through the whole body rather than at a fixed element name.
  const children = childElements(el.inner, 'RelOp').map(c => buildNode(c, false));

  const childCost = children.reduce((s, c) => s + (c.stats.costTotal ?? 0), 0);
  const own = ownBody(el.inner);
  const { relation, index } = objectOf(own);
  const rt = runtime(own);
  const flags = warningFlags(own);
  if (missingIndex) flags.push('missing index suggested');
  if (a.Parallel === 'true') flags.push('parallel');

  const stats: PlanStats = {
    costTotal: subtree,
    costSelf: subtree !== undefined ? Math.max(0, subtree - childCost) : undefined,
    rowsEst: num(a.EstimateRows),
    rowsOut: num(a.EstimateRows),
    rowsActual: rt.rows,
    loops: rt.execs,
    msTotal: rt.ms,
    relation,
    index,
    flags: flags.length ? flags : undefined,
  };

  const metrics: Record<string, string> = {};
  if (stats.rowsEst !== undefined) metrics['rows est'] = fmtNum(stats.rowsEst);
  if (stats.rowsActual !== undefined) metrics['rows actual'] = fmtNum(stats.rowsActual);
  if (subtree !== undefined) metrics.cost = subtree.toFixed(4);
  if (rt.ms !== undefined) metrics['ms'] = String(rt.ms);

  const detail = [
    relation ? (index && index !== relation ? `${relation} · ${index}` : relation) : '',
    logicalOp && logicalOp !== physicalOp ? logicalOp : '',
    ...flags,
  ].filter(Boolean).join(' · ');

  return {
    op: physicalOp,
    detail,
    metrics,
    severity: 0,   // filled once the plan total is known
    kind: mssqlKind(physicalOp, logicalOp),
    stats,
    children,
  };
}

function fmtNum(n: number): string {
  return n >= 1000 ? Math.round(n).toLocaleString('en-US') : String(Math.round(n * 100) / 100);
}

/** Assign each node its share of the plan's total self-cost. */
function tint(node: PlanNode, total: number): void {
  node.severity = total > 0 ? Math.min(1, (node.stats.costSelf ?? 0) / total) : 0;
  for (const c of node.children) tint(c, total);
}

function sumSelf(node: PlanNode): number {
  return (node.stats.costSelf ?? 0) + node.children.reduce((s, c) => s + sumSelf(c), 0);
}

/**
 * Parse a SHOWPLAN_XML / STATISTICS XML document.
 *
 * Throws when the content is not a plan, so the caller can fall back to showing
 * the raw output rather than rendering an empty diagram.
 */
export function parseMssqlPlan(content: string): ParsedPlan {
  const xml = content.trim();
  if (!xml.includes('ShowPlanXML') && !xml.includes('<StmtSimple')) {
    throw new Error('not a SHOWPLAN_XML document');
  }

  // A batch can hold several statements; each has its own plan. The one with
  // real work is the one worth showing, so pick the costliest rather than the
  // first — a batch whose first statement is a `SET` would otherwise render an
  // empty tree.
  const stmts = [
    ...childElements(xml, 'StmtSimple'),
    ...childElements(xml, 'StmtCond'),
  ];
  let best: Element | undefined;
  let bestCost = -1;
  let bestText = '';
  for (const st of stmts) {
    const qp = childElements(st.inner, 'QueryPlan')[0];
    if (!qp) continue;
    const root = childElements(qp.inner, 'RelOp')[0];
    if (!root) continue;
    const cost = num(root.attrs.EstimatedTotalSubtreeCost) ?? 0;
    if (cost > bestCost) {
      bestCost = cost;
      best = root;
      bestText = st.attrs.StatementText ?? '';
      // `MissingIndexes` hangs off the QueryPlan, not the operator — but it is
      // about the scan underneath it, so it is flagged on the root and named in
      // the summary where it will actually be read.
      best = { ...root, inner: root.inner + (/<MissingIndexes/.test(qp.inner) ? '<!--mi-->' : '') };
    }
  }
  if (!best) throw new Error('SHOWPLAN_XML document contains no query plan');

  const hasMissingIndex = best.inner.includes('<!--mi-->');
  const root = buildNode(best, hasMissingIndex);
  const totalSelf = sumSelf(root);
  tint(root, totalSelf);

  const measured = /<RunTimeInformation/.test(xml);
  const totalMs = measured ? root.stats.msTotal : undefined;

  const metricColumns = ['rows est'];
  if (measured) metricColumns.push('rows actual');
  metricColumns.push('cost');
  if (measured) metricColumns.push('ms');

  const bits: string[] = [];
  bits.push(`Estimated subtree cost ${(root.stats.costTotal ?? 0).toFixed(4)}`);
  if (measured && totalMs !== undefined) bits.push(`Execution ${totalMs} ms`);
  if (hasMissingIndex) bits.push('SQL Server suggests a missing index');
  if (bestText) bits.push(bestText.replace(/\s+/g, ' ').slice(0, 120));

  return {
    root,
    metricColumns,
    summary: bits.join(' · '),
    measured,
    totalMs,
    engine: 'sqlserver',
  };
}
