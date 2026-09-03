/**
 * ClickHouse EXPLAIN → the shared plan model.
 *
 * ClickHouse has no cost model and no JSON plan format: every EXPLAIN kind
 * answers plain text, and the honest rendering is the structure the text
 * already carries rather than invented numbers. Three shapes arrive here:
 *
 *   • `EXPLAIN indexes = 1` — the plan tree with an `Indexes:` section under
 *     each MergeTree read, listing MinMax / Partition / PrimaryKey / Skip
 *     ranges with the parts and granules each still has to read. Those counts
 *     are REAL (what the scan will touch), which is as close to evidence as a
 *     non-executing EXPLAIN gets — they are shown verbatim.
 *   • `EXPLAIN PIPELINE` — the processor graph: scope headers in parentheses
 *     ("(Aggregating)") with transform lines beneath, `× N` marking a
 *     transform replicated per thread.
 *   • `EXPLAIN ESTIMATE` — a tab-separated table of (database, table, parts,
 *     rows, marks), one row per table read. This one IS numbers, so it gets
 *     metric columns instead of a tree.
 *
 * Two deliberate omissions from the tree:
 *   • `Header: ...` lines (the per-step row signature newer servers print)
 *     are dropped — they describe the columns flowing between steps, not the
 *     steps, and the Raw view keeps them for anyone who needs them.
 *   • No severity colouring: with no costs there is no honest weight, so
 *     every node is severity 0 and the icicle falls back to uniform widths
 *     (utils/planLayout.ts).
 *
 * Pure and dependency-free — driven by `node --test`.
 */
import type { ParsedPlan, PlanNode, PlanNodeKind } from './planParse.ts';

/** Classify a ClickHouse plan/pipeline step onto the shared normalised kinds. */
export function chKind(label: string): PlanNodeKind {
  const t = label.toLowerCase();
  // ReadFromMergeTree / ReadFromRemote / MergeTreeSelect — the table read.
  if (t.startsWith('readfrom') || t.includes('mergetree')) return 'scan-seq';
  if (t.includes('aggregat')) return 'aggregate';
  if (t.includes('join')) return 'join-hash';
  if (t.includes('sort')) return 'sort';
  if (t.includes('window')) return 'window';
  if (t.includes('distinct')) return 'distinct';
  if (t.includes('limit')) return 'limit';
  if (t.includes('union') || t.includes('concat')) return 'union';
  if (t.includes('creatingsets')) return 'materialize';
  if (t.startsWith('expression')) return 'result';
  return 'other';
}

const num = (s: string): number | undefined => {
  const v = Number(s.trim());
  return Number.isFinite(v) ? v : undefined;
};

const fmtInt = (n: number | undefined): string =>
  n === undefined ? '' : n.toLocaleString();

function leaf(op: string, detail: string, kind: PlanNodeKind): PlanNode {
  return { op, detail, metrics: {}, severity: 0, kind, stats: {}, children: [] };
}

/** Turn one text line into a node, unwrapping the CH-specific decorations. */
function chNode(text: string): PlanNode {
  // Pipeline scope header: "(Aggregating)" groups the transforms beneath it.
  const header = /^\((.+)\)$/.exec(text);
  if (header) return leaf(header[1], '', chKind(header[1]));

  // Thread replication: "AggregatingTransform × 3". The count is the number of
  // parallel copies, so it belongs beside the label, not inside it.
  const mult = /^(.*?)\s*×\s*(\d+)$/.exec(text);
  if (mult) return leaf(mult[1], `× ${mult[2]}`, chKind(mult[1]));

  // Index-section entries: "Condition: (user_id in 2-element set)",
  // "Parts: 1/3". Restricted to the known labels — a generic colon split would
  // mangle "MergeTreeSelect(pool: PrefetchedReadPool, algorithm: Thread)".
  const kv = /^(Indexes|Keys|Condition|Parts|Granules|Name|Description|Actions|Replicas):\s*(.*)$/
    .exec(text);
  if (kv) return leaf(kv[1], kv[2], 'other');

  return leaf(text, '', chKind(text));
}

/** `EXPLAIN ESTIMATE`: one tab-separated row per table read. */
function parseEstimate(lines: string[]): ParsedPlan {
  const children: PlanNode[] = lines.map(line => {
    const [db, table, parts, rows, marks] = line.split('\t');
    const rowsN = num(rows ?? '');
    return {
      op: db ? `${db}.${table}` : (table ?? line),
      detail: '',
      metrics: {
        'Parts': fmtInt(num(parts ?? '')),
        'Rows':  fmtInt(rowsN),
        'Marks': fmtInt(num(marks ?? '')),
      },
      // Parts/rows/marks are real counts of what the scan will read — the one
      // CH EXPLAIN kind with honest numbers, so they drive the row tint and
      // the graph's row label.
      severity: 0,
      kind: 'scan-seq',
      stats: { rowsEst: rowsN },
      children: [],
    };
  });
  const totalRows = children.reduce((s, c) => s + (c.stats.rowsEst ?? 0), 0);
  for (const c of children) {
    c.severity = totalRows > 0 ? (c.stats.rowsEst ?? 0) / totalRows : 0;
  }
  return {
    root: {
      op: 'EXPLAIN ESTIMATE', detail: '', metrics: {}, severity: 0,
      kind: 'result', stats: {}, children,
    },
    metricColumns: ['Parts', 'Rows', 'Marks'],
    summary: `${children.length} table${children.length === 1 ? '' : 's'} read`,
    // Not executed — the counts are the server's own metadata, not a sample.
    measured: false,
    engine: 'clickhouse',
  };
}

/** Every line of an ESTIMATE answer is `db⇥table⇥parts⇥rows⇥marks`. */
function looksLikeEstimate(lines: string[]): boolean {
  return lines.every(line => {
    const f = line.split('\t');
    return f.length === 5 && num(f[2]) !== undefined
      && num(f[3]) !== undefined && num(f[4]) !== undefined;
  });
}

/**
 * Parse ClickHouse EXPLAIN output.
 *
 * Throws when there is no structure to draw (an empty or single-line answer),
 * so the caller falls back to the raw text view rather than a one-box graph.
 */
export function parseClickhousePlan(content: string): ParsedPlan {
  const text = content.replace(/\\n/g, '\n').trim();
  const lines = text.split('\n').filter(l => l.trim() !== '');
  if (lines.length === 0) throw new Error('empty ClickHouse plan');

  if (looksLikeEstimate(lines)) return parseEstimate(lines);

  // Build the tree from indentation, the same convention every CH EXPLAIN
  // kind prints (two spaces per level — but derived from the actual indent,
  // never assumed). One exception: a pipeline scope header ("(Aggregating)")
  // sits at the SAME indent as the transforms it scopes, so a header owns the
  // same-indent line that follows it.
  const stack: Array<{ indent: number; node: PlanNode; header: boolean }> = [];
  const roots: PlanNode[] = [];
  for (const raw of lines) {
    const trimmed = raw.trim();
    // `Header: <columns>` describes the row shape flowing into a step, not a
    // step — it is per-step noise between operations. Raw view keeps it.
    if (trimmed.startsWith('Header:')) continue;
    const indent = raw.length - raw.trimStart().length;
    const header = /^\(.+\)$/.test(trimmed);
    const node = chNode(trimmed);
    const top = stack[stack.length - 1];
    const effective = !header && top?.header && top.indent === indent
      ? indent + 1 : indent;
    while (stack.length > 0 && stack[stack.length - 1].indent >= effective) stack.pop();
    if (stack.length === 0) roots.push(node);
    else stack[stack.length - 1].node.children.push(node);
    stack.push({ indent: effective, node, header });
  }

  if (roots.length === 0) throw new Error('no ClickHouse plan structure');
  const root = roots.length === 1 ? roots[0] : {
    op: 'EXPLAIN', detail: '', metrics: {}, severity: 0,
    kind: 'other' as PlanNodeKind, stats: {}, children: roots,
  };
  // A lone node is a flat line of text, not a plan — the raw view is the
  // honest rendering of it.
  if (root.children.length === 0) throw new Error('flat ClickHouse plan');

  return {
    root,
    metricColumns: [],
    summary: '',
    measured: false,
    engine: 'clickhouse',
  };
}
