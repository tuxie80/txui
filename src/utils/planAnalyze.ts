/**
 * EXPLAIN ANALYZE (TREE) interpreter — implements the systematic method:
 * read bottom-up, compute actual/estimated ratio per node, trace loop
 * multiplication, spot useless filters and expensive sorts, find the
 * wall-time bottleneck. Severity ladder for estimation ratios:
 *   0.9–1.1 excellent · 0.5–2 good · 0.2–5 moderate · 0.1–10 significant
 *   · beyond severe · >50 critical.
 */
import type { Finding, Severity } from './sqlLint.ts';
import { mdTable } from './qualityReport.ts';

export interface PlanNode {
  depth: number;
  label: string;          // operation text up to the parens
  estRows: number | null;
  cost: number | null;
  timeFirst: number | null;  // ms to first row
  timeTotal: number | null;  // ms per loop
  actRows: number | null;    // rows per loop
  loops: number | null;
  neverExecuted: boolean;
  children: PlanNode[];
}

const num = (s: string | undefined): number | null => {
  if (s === undefined) return null;
  const v = Number(s);
  return Number.isFinite(v) ? v : null;
};

export function parseAnalyzeTree(text: string): PlanNode[] {
  // tolerate literal "\n" from captured logs
  const clean = text.replace(/\\n/g, '\n');
  const lines = clean.split('\n').filter(l => l.includes('->'));
  const roots: PlanNode[] = [];
  const stack: PlanNode[] = [];

  for (const line of lines) {
    const arrow = line.indexOf('->');
    if (arrow < 0) continue;
    const depth = Math.floor(arrow / 4);
    const body = line.slice(arrow + 2).trim();

    const label = body.replace(/\s*\((cost|actual|never)[^)]*\)/g, '').trim();
    const costM = /\(cost=([\d.e+]+)(?:\.\.[\d.e+]+)?\s+rows=([\d.e+]+)\)/.exec(body);
    const actM = /\(actual time=([\d.e+]+)\.\.([\d.e+]+)\s+rows=([\d.e+]+)\s+loops=([\d.e+]+)\)/.exec(body);
    // "actual time" without cost happens on temp-table lines
    const actOnly = !actM ? /\(actual time=([\d.e+]+)\.\.([\d.e+]+)\s+rows=([\d.e+]+)\s+loops=([\d.e+]+)\)/.exec(body) : null;
    const act = actM ?? actOnly;

    const node: PlanNode = {
      depth,
      label,
      cost: num(costM?.[1]),
      estRows: num(costM?.[2]),
      timeFirst: num(act?.[1]),
      timeTotal: num(act?.[2]),
      actRows: num(act?.[3]),
      loops: num(act?.[4]),
      neverExecuted: /\(never executed\)/.test(body),
      children: [],
    };

    while (stack.length > 0 && stack[stack.length - 1].depth >= depth) stack.pop();
    if (stack.length === 0) roots.push(node);
    else stack[stack.length - 1].children.push(node);
    stack.push(node);
  }
  return roots;
}

function walk(nodes: PlanNode[], fn: (n: PlanNode) => void) {
  for (const n of nodes) { fn(n); walk(n.children, fn); }
}

/** total actual rows produced by a node across all loops */
const totalRows = (n: PlanNode): number | null =>
  n.actRows !== null && n.loops !== null ? n.actRows * n.loops : null;

/** wall-clock attributable to the node itself (children subtracted, loop-aware) */
function exclusiveMs(n: PlanNode): number | null {
  if (n.timeTotal === null || n.loops === null) return null;
  const own = n.timeTotal * n.loops;
  let kids = 0;
  for (const c of n.children) {
    if (c.timeTotal !== null && c.loops !== null) kids += c.timeTotal * c.loops;
  }
  return Math.max(0, own - kids);
}

function ratioSeverity(ratio: number): { sev: Severity; label: string } | null {
  const r = ratio >= 1 ? ratio : 1 / ratio;
  if (r <= 2) return null;                                     // fine
  if (r <= 5) return { sev: 'yellow', label: 'moderate' };
  if (r <= 10) return { sev: 'orange', label: 'significant' };
  if (r <= 50) return { sev: 'red', label: 'severe' };
  return { sev: 'red', label: 'CRITICAL' };
}

export interface AnalyzeInsights {
  findings: Finding[];
  /** markdown: estimation-ratio table + bottleneck summary */
  md: string;
}

export function analyzePlanText(text: string): AnalyzeInsights {
  const roots = parseAnalyzeTree(text);
  const findings: Finding[] = [];
  let n = 1;
  const push = (severity: Severity, title: string, detail: string) =>
    findings.push({ id: `P${n++}`, severity, title, detail });

  if (roots.length === 0) {
    return { findings, md: '_Could not parse the plan tree._\n' };
  }

  interface Row { node: PlanNode; ratio: number | null; excl: number | null }
  const rows: Row[] = [];
  walk(roots, node => {
    // TREE output: both estimated and actual rows are PER LOOP — compare
    // per-loop. Zero actual rows (early termination / timeout) is not an
    // estimation error, skip it.
    const ratio = node.estRows !== null && node.estRows > 0
      && node.actRows !== null && node.actRows > 0
      ? node.actRows / node.estRows : null;
    rows.push({ node, ratio, excl: exclusiveMs(node) });
  });

  // ── estimation errors (worst first; root-most deepest error matters most) ──
  const offenders = rows
    .filter(r => r.ratio !== null && !r.node.neverExecuted && ratioSeverity(r.ratio!) !== null)
    .sort((a, b) => {
      const ra = a.ratio! >= 1 ? a.ratio! : 1 / a.ratio!;
      const rb = b.ratio! >= 1 ? b.ratio! : 1 / b.ratio!;
      return rb - ra;
    });
  for (const o of offenders.slice(0, 5)) {
    const s = ratioSeverity(o.ratio!)!;
    const dir = o.ratio! > 1 ? 'underestimated' : 'overestimated';
    push(s.sev,
      `Estimation ${s.label}: ${o.ratio! >= 1 ? o.ratio!.toFixed(0) : (1 / o.ratio!).toFixed(0)}× ${dir} — ${o.node.label.slice(0, 80)}`,
      `Estimated ${o.node.estRows!.toLocaleString()} rows/loop, actual ${o.node.actRows!.toLocaleString()}/loop. Estimation errors cascade upward — fix the deepest wrong node first (ANALYZE TABLE / histogram / better index).`);
  }

  // ── bottleneck: largest exclusive time ──
  const byExcl = rows.filter(r => r.excl !== null).sort((a, b) => b.excl! - a.excl!);
  const rootTime = roots[0].timeTotal !== null && roots[0].loops !== null
    ? roots[0].timeTotal * roots[0].loops : null;
  if (byExcl.length > 0 && rootTime && rootTime > 0) {
    const top = byExcl[0];
    const share = (top.excl! / rootTime) * 100;
    if (share >= 40 && top.excl! > 100) {
      push('orange',
        `Bottleneck: ${share.toFixed(0)}% of wall time in one operation`,
        `"${top.node.label.slice(0, 100)}" spends ${(top.excl! / 1000).toFixed(1)}s of ${(rootTime / 1000).toFixed(1)}s total (children excluded). Optimize this node first.`);
    }
  }

  // ── loop multiplication ──
  for (const r of rows) {
    const nde = r.node;
    if (nde.loops !== null && nde.loops > 1000 && nde.timeTotal !== null
        && nde.timeTotal * nde.loops > 1000) {
      push('orange',
        `Loop multiplication: ${nde.loops.toLocaleString()} executions — ${nde.label.slice(0, 80)}`,
        `${nde.timeTotal.toFixed(2)} ms × ${nde.loops.toLocaleString()} loops ≈ ${((nde.timeTotal * nde.loops) / 1000).toFixed(1)}s total. A per-row lookup executed for every outer row — consider a hash join, pre-aggregation, or driving from the other side.`);
      break; // one representative finding
    }
  }

  // ── filter that doesn't filter ──
  walk(roots, nde => {
    if (!/^Filter:/i.test(nde.label) || nde.children.length !== 1) return;
    const child = nde.children[0];
    const out = totalRows(nde);
    const inn = totalRows(child);
    if (out !== null && inn !== null && inn > 10000 && out / inn > 0.95) {
      push('yellow',
        `Filter passes ${((out / inn) * 100).toFixed(1)}% of rows — nearly useless`,
        `"${nde.label.slice(0, 90)}" removes almost nothing (${inn.toLocaleString()} → ${out.toLocaleString()}). Either the predicate belongs in an index, or the query should target the rare complement instead.`);
    }
  });

  // ── expensive sort ──
  walk(roots, nde => {
    if (!/^Sort/i.test(nde.label)) return;
    const excl = exclusiveMs(nde);
    if (excl !== null && excl > 1000) {
      push('orange',
        `Expensive sort: ${(excl / 1000).toFixed(1)}s — ${nde.label.slice(0, 80)}`,
        'A covering/ordering index on the sort key would eliminate this entirely.');
    }
  });

  // ── table scans + slow single ops ──
  walk(roots, nde => {
    if (/^Table scan on (?!<)/i.test(nde.label)) {
      const tr = totalRows(nde);
      if (tr !== null && tr > 100000) {
        push('orange', `Table scan: ${nde.label.slice(0, 80)}`,
          `${tr.toLocaleString()} rows read without an index. Check whether a usable index exists or should.`);
      }
    }
  });

  // ── never executed (info) ──
  const never = rows.filter(r => r.node.neverExecuted).length;
  if (never > 0) {
    push('info', `${never} plan node${never === 1 ? '' : 's'} never executed`,
      'Upstream produced zero rows before reaching them (or a guard short-circuited) — usually fine, but confirm it matches expectations for these parameters.');
  }

  // ── estimation-ratio table (top 12 by |log ratio|) ──
  const tableRows = rows
    .filter(r => r.ratio !== null && !r.node.neverExecuted)
    .sort((a, b) => Math.abs(Math.log(b.ratio!)) - Math.abs(Math.log(a.ratio!)))
    .slice(0, 12)
    .map(r => {
      const sev = ratioSeverity(r.ratio!);
      return [
        r.node.label.slice(0, 60),
        r.node.estRows!.toLocaleString(),
        `${r.node.actRows!.toLocaleString()}${r.node.loops !== null && r.node.loops > 1 ? ` ×${r.node.loops.toLocaleString()}` : ''}`,
        r.ratio! >= 1 ? `${r.ratio!.toFixed(1)}×` : `1/${(1 / r.ratio!).toFixed(1)}×`,
        sev ? `${sev.sev === 'red' ? '❌' : sev.sev === 'orange' ? '⚠️⚠️' : '⚠️'} ${sev.label}` : '✓',
      ];
    });

  const md = [
    rootTime !== null ? `Total measured time: **${(rootTime / 1000).toFixed(2)}s**\n` : '',
    '### Estimation ratios (worst first)\n',
    tableRows.length
      ? mdTable(['Operation', 'Est rows', 'Actual rows', 'Ratio', 'Verdict'], tableRows)
      : '_No measurable nodes._\n',
  ].join('\n');

  return { findings, md };
}
