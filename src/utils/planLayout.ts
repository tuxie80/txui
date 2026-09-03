/**
 * Geometry for the two graphical plan views. No DOM, no React — just numbers,
 * so the hard part (do boxes overlap? is the layout stable?) is testable.
 *
 * **Tidy tree.** A naive layout that gives each subtree a fixed slice of width
 * wastes most of the canvas and still collides once one branch is deeper than
 * its sibling. This is the Reingold–Tilford algorithm: lay out each subtree
 * independently, then push siblings apart by the smallest amount that removes
 * every overlap between their *contours* — the left and right silhouettes of
 * the subtree, level by level. The result is compact and provably collision
 * free at every depth, which is what makes a forty-node plan readable.
 *
 * **Flow direction.** Leaves at the bottom, root at the top. A plan is read as
 * data moving upward — scans at the bottom feeding joins feeding the result —
 * and drawing it root-down inverts the thing every reference diagram shows.
 *
 * **Icicle.** Nested rectangles where width is proportional to cumulative cost.
 * A child can never be wider than its parent, so the picture cannot imply that
 * a subtree costs more than the node containing it.
 *
 * Pure and dependency-free — driven by `node --test`.
 */
import type { PlanNode } from './planParse.ts';
import type { PlanCostModel } from './planCost.ts';

export interface LayoutOptions {
  nodeWidth: number;
  nodeHeight: number;
  /** Minimum horizontal gap between two boxes on the same level. */
  hGap: number;
  /** Vertical distance between one level and the next. */
  vGap: number;
}

export const DEFAULT_LAYOUT: LayoutOptions = {
  nodeWidth: 188,
  nodeHeight: 62,
  hGap: 26,
  vGap: 52,
};

export interface LaidOutNode {
  path: string;
  node: PlanNode;
  depth: number;
  /** Centre of the box. */
  x: number;
  y: number;
  width: number;
  height: number;
  children: LaidOutNode[];
  parent: LaidOutNode | null;
}

export interface GraphLayout {
  nodes: LaidOutNode[];
  byPath: Map<string, LaidOutNode>;
  root: LaidOutNode | null;
  width: number;
  height: number;
  edges: GraphEdge[];
}

export interface GraphEdge {
  from: LaidOutNode;   // child (below)
  to: LaidOutNode;     // parent (above)
  /** 0..1 — share of the parent's inbound rows carried by this edge. */
  weight: number;
  /** SVG path, an S-curve between the two boxes. */
  d: string;
}

/** Internal working node for the contour algorithm. */
interface TreeNode {
  path: string;
  node: PlanNode;
  depth: number;
  children: TreeNode[];
  parent: TreeNode | null;
  /** Preliminary x, relative to the parent, before contour resolution. */
  prelim: number;
  /** Accumulated shift applied to this node's whole subtree. */
  mod: number;
  x: number;
  /** Index among siblings. */
  index: number;
}

function toTree(
  n: PlanNode, depth: number, path: string, parent: TreeNode | null, index: number,
  collapsed: Set<string>,
): TreeNode {
  const t: TreeNode = {
    path, node: n, depth, children: [], parent,
    prelim: 0, mod: 0, x: 0, index,
  };
  if (!collapsed.has(path)) {
    t.children = n.children.map((c, i) => toTree(c, depth + 1, `${path}.${i}`, t, i, collapsed));
  }
  return t;
}

/**
 * Reingold–Tilford, first walk: give every subtree a preliminary position and
 * record how far each one had to be pushed right to clear its left sibling.
 */
function firstWalk(t: TreeNode, spacing: number): void {
  if (t.children.length === 0) {
    t.prelim = t.index === 0 ? 0 : (t.parent!.children[t.index - 1].prelim + spacing);
    return;
  }
  for (const c of t.children) firstWalk(c, spacing);

  // Centre the parent over its children.
  const first = t.children[0];
  const last = t.children[t.children.length - 1];
  const mid = (first.prelim + last.prelim) / 2;

  if (t.index === 0) {
    t.prelim = mid;
  } else {
    const prev = t.parent!.children[t.index - 1];
    t.prelim = prev.prelim + spacing;
    t.mod = t.prelim - mid;
  }

  // Resolve overlaps against every earlier sibling's contour, not just the
  // immediately previous one — a deep subtree can reach under two siblings.
  if (t.index > 0) resolveOverlap(t, spacing);
}

/** Left/right silhouette of a subtree: the extreme x at each depth. */
function contour(t: TreeNode, side: 'left' | 'right'): Map<number, number> {
  const out = new Map<number, number>();
  const walk = (n: TreeNode, mod: number): void => {
    const x = n.prelim + mod;
    const cur = out.get(n.depth);
    if (cur === undefined) out.set(n.depth, x);
    else out.set(n.depth, side === 'left' ? Math.min(cur, x) : Math.max(cur, x));
    for (const c of n.children) walk(c, mod + n.mod);
  };
  walk(t, 0);
  return out;
}

/**
 * Push `t` right until its left contour clears the right contour of every
 * sibling before it, at every shared depth.
 */
function resolveOverlap(t: TreeNode, spacing: number): void {
  const mine = contour(t, 'left');
  let shift = 0;
  for (let i = 0; i < t.index; i++) {
    const theirs = contour(t.parent!.children[i], 'right');
    for (const [depth, theirX] of theirs) {
      const myX = mine.get(depth);
      if (myX === undefined) continue;
      // Measure against the UNSHIFTED contour and take the maximum once.
      // Folding the running shift into each comparison makes every subsequent
      // sibling demand less than it needs, and deep trees still collide.
      const needed = theirX + spacing - myX;
      if (needed > shift) shift = needed;
    }
  }
  if (shift > 0) {
    t.prelim += shift;
    t.mod += shift;
  }
}

/** Second walk: fold the accumulated mods into absolute positions. */
function secondWalk(t: TreeNode, mod: number): void {
  t.x = t.prelim + mod;
  for (const c of t.children) secondWalk(c, mod + t.mod);
}

/**
 * Lay out the plan as a bottom-up node graph.
 *
 * `collapsed` holds the paths whose children are hidden; a collapsed node is
 * laid out as a leaf, so collapsing a wide subtree genuinely reclaims the
 * space rather than leaving a hole.
 */
export function layoutGraph(
  root: PlanNode,
  collapsed: Set<string> = new Set(),
  opts: LayoutOptions = DEFAULT_LAYOUT,
): GraphLayout {
  const empty: GraphLayout = {
    nodes: [], byPath: new Map(), root: null, width: 0, height: 0, edges: [],
  };
  if (!root) return empty;

  const spacing = opts.nodeWidth + opts.hGap;
  const tree = toTree(root, 0, '0', null, 0, collapsed);
  firstWalk(tree, spacing);
  secondWalk(tree, 0);

  // Depth of the deepest node decides which y is the bottom.
  let maxDepth = 0;
  const depths: TreeNode[] = [];
  (function collect(t: TreeNode) {
    depths.push(t);
    maxDepth = Math.max(maxDepth, t.depth);
    t.children.forEach(collect);
  })(tree);

  const minX = Math.min(...depths.map(t => t.x));
  const pad = opts.nodeWidth / 2 + 8;
  // Depth 0 (the result) sits at the top and the deepest scans at the bottom,
  // so the picture is read upward the way a plan actually executes.
  const rowY = (depth: number) =>
    depth * (opts.nodeHeight + opts.vGap) + opts.nodeHeight / 2 + 8;

  const byPath = new Map<string, LaidOutNode>();
  const nodes: LaidOutNode[] = [];

  const build = (t: TreeNode, parent: LaidOutNode | null): LaidOutNode => {
    const laid: LaidOutNode = {
      path: t.path, node: t.node, depth: t.depth,
      x: t.x - minX + pad,
      y: rowY(t.depth),
      width: opts.nodeWidth, height: opts.nodeHeight,
      children: [], parent,
    };
    byPath.set(t.path, laid);
    nodes.push(laid);
    laid.children = t.children.map(c => build(c, laid));
    return laid;
  };
  const laidRoot = build(tree, null);

  const width = Math.max(...nodes.map(n => n.x)) + pad;
  const height = rowY(maxDepth) + opts.nodeHeight / 2 + 8;

  return { nodes, byPath, root: laidRoot, width, height, edges: buildEdges(nodes) };
}

/**
 * Edges, weighted by the share of rows each child contributes to its parent.
 *
 * The weight is what makes a graph more informative than a tree-table: a join
 * fed 1.2M rows from one side and 800 from the other should *look* lopsided,
 * because that asymmetry is usually the story.
 */
function buildEdges(nodes: LaidOutNode[]): GraphEdge[] {
  const edges: GraphEdge[] = [];
  for (const parent of nodes) {
    if (parent.children.length === 0) continue;
    const rowsOf = (n: LaidOutNode) =>
      n.node.stats.rowsActual ?? n.node.stats.rowsOut ?? n.node.stats.rowsEst ?? 0;
    const total = parent.children.reduce((s, c) => s + rowsOf(c), 0);
    for (const child of parent.children) {
      edges.push({
        from: child,
        to: parent,
        weight: total > 0 ? rowsOf(child) / total : 1 / parent.children.length,
        d: edgePath(child, parent),
      });
    }
  }
  return edges;
}

/**
 * An S-curve from the top of the child to the bottom of the parent.
 *
 * Vertical tangents at both ends: the curve leaves and arrives perpendicular
 * to the box edge, so a bundle of edges converging on one parent stays legible
 * instead of fanning into its corners.
 */
export function edgePath(child: LaidOutNode, parent: LaidOutNode): string {
  const x1 = child.x;
  const y1 = child.y - child.height / 2;      // top of child
  const x2 = parent.x;
  const y2 = parent.y + parent.height / 2;    // bottom of parent
  const dy = Math.abs(y1 - y2);
  const c = Math.max(18, dy * 0.42);
  return `M ${x1.toFixed(1)} ${y1.toFixed(1)} `
    + `C ${x1.toFixed(1)} ${(y1 - c).toFixed(1)}, `
    + `${x2.toFixed(1)} ${(y2 + c).toFixed(1)}, `
    + `${x2.toFixed(1)} ${y2.toFixed(1)}`;
}

// ── icicle ───────────────────────────────────────────────────────────────────

export interface IcicleCell {
  path: string;
  node: PlanNode;
  depth: number;
  /** Fractions of the full width, 0..1. */
  x0: number;
  x1: number;
  /** Cumulative weight this cell represents. */
  weight: number;
}

/**
 * Nested bars, width proportional to cumulative cost.
 *
 * Children are packed inside their parent's span in plan order. Because each
 * child's width comes from its share of the parent's *total* weight, the
 * parent's own self-work shows up as the gap the children do not fill — which
 * is exactly the "this node itself is the expensive part" signal.
 *
 * A plan with no weights at all (ClickHouse — no cost model, every node
 * weighs zero) gets uniform widths instead of an empty view: the icicle's
 * *shape* is still the plan's structure, only the sizing signal is absent.
 */
export function layoutIcicle(root: PlanNode, model: PlanCostModel): IcicleCell[] {
  const out: IcicleCell[] = [];
  const rootEntry = model.byPath.get('0');
  const rootWeight = rootEntry?.weightTotal ?? 0;
  const uniform = rootWeight <= 0;

  const walk = (n: PlanNode, path: string, depth: number, x0: number, x1: number): void => {
    const entry = model.byPath.get(path);
    const weight = entry?.weightTotal ?? 0;
    out.push({ path, node: n, depth, x0, x1, weight });

    const span = x1 - x0;
    if (span <= 0 || n.children.length === 0) return;

    // Lay children across the parent's span in proportion to their totals. Any
    // remainder is the parent's own self cost and is deliberately left empty.
    let cursor = x0;
    for (let i = 0; i < n.children.length; i++) {
      const childPath = `${path}.${i}`;
      const childWeight = model.byPath.get(childPath)?.weightTotal ?? 0;
      const frac = uniform ? 1 / n.children.length
        : weight > 0 ? childWeight / weight : 0;
      const childSpan = span * frac;
      walk(n.children[i], childPath, depth + 1, cursor, cursor + childSpan);
      cursor += childSpan;
    }
  };

  walk(root, '0', 0, 0, 1);
  return out;
}
