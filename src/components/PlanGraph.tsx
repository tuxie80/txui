/**
 * The execution plan as a picture.
 *
 * Two views over one layout:
 *   • **Graph** — operation boxes connected bottom-up, edge thickness carrying
 *     row volume, box colour carrying cost. Shows the *shape* of the plan:
 *     which side of a join is huge, where a subtree hangs off, what feeds what.
 *   • **Icicle** — nested bars, width proportional to cumulative cost. Shows
 *     *where the time went*, which the graph deliberately does not encode in
 *     size (a box sized by cost makes a cheap join unreadably small).
 *
 * Colour is severity from utils/planCost — always relative to the plan's own
 * hottest node, never an absolute millisecond scale. See that module for why.
 *
 * All geometry comes from utils/planLayout; this file only draws.
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PlanNode, ParsedPlan } from '../utils/planParse';
import type { PlanCostModel, NodeCost, Severity } from '../utils/planCost';
import { formatWeight, formatRows } from '../utils/planCost';
import { layoutGraph, layoutIcicle, DEFAULT_LAYOUT } from '../utils/planLayout';
import type { LaidOutNode } from '../utils/planLayout';
import { OP_GLOSSARY, findingsFor } from '../utils/planGlossary';
import type { Finding } from '../utils/planGlossary';

interface Props {
  plan: ParsedPlan;
  model: PlanCostModel;
  mode: 'graph' | 'icicle';
  /** Path of the selected node, or null. */
  selected: string | null;
  onSelect: (path: string | null) => void;
}

/** A glyph per operation class — shape carries meaning faster than a label. */
const KIND_GLYPH: Record<string, string> = {
  'scan-seq': '▤', 'scan-index': '⑂', 'scan-index-only': '⑂', 'scan-bitmap': '▦',
  'scan-const': '•', 'join-nested': '⟲', 'join-hash': '⋈', 'join-merge': '⋈',
  'sort': '↕', 'aggregate': 'Σ', 'group': '⊞', 'window': '◫', 'distinct': '≠',
  'limit': '⊤', 'union': '⊍', 'subquery': '⊂', 'materialize': '▣', 'cte': '⊙',
  'result': '⏹', 'other': '◇',
};

const SEVERITY_ORDER: Severity[] = ['none', 'mild', 'warm', 'hot', 'critical'];

/** Edge stroke width from its share of the rows — clamped so nothing vanishes. */
function edgeWidth(weight: number): number {
  return 1.2 + Math.sqrt(Math.max(0, Math.min(1, weight))) * 5.2;
}

export function PlanGraph({ plan, model, mode, selected, onSelect }: Props) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [hover, setHover] = useState<string | null>(null);
  const viewportRef = useRef<HTMLDivElement>(null);

  const layout = useMemo(
    () => layoutGraph(plan.root, collapsed, DEFAULT_LAYOUT),
    [plan.root, collapsed],
  );
  const icicle = useMemo(() => layoutIcicle(plan.root, model), [plan.root, model]);

  const toggleCollapse = useCallback((path: string) => {
    setCollapsed(prev => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path); else next.add(path);
      return next;
    });
  }, []);

  /** Fit the whole plan into the viewport — the sane default for a big plan. */
  const fit = useCallback(() => {
    const vp = viewportRef.current;
    if (!vp || layout.width === 0) return;
    const pad = 24;
    const scale = Math.min(
      (vp.clientWidth - pad) / layout.width,
      (vp.clientHeight - pad) / layout.height,
      1,   // never zoom past 1:1 — a two-node plan filling the screen looks broken
    );
    setZoom(Math.max(0.15, scale));
    setPan({ x: 0, y: 0 });
  }, [layout.width, layout.height]);

  // Fit on first render and whenever the plan itself changes.
  useEffect(() => { fit(); }, [fit]);

  // Drag to pan — applied to the SVG's style DIRECTLY during the drag and
  // committed to state only on pointer-up (WP-14 14.5): a setState per
  // pointermove re-rendered the whole graph per mouse pixel.
  const drag = useRef<{ x: number; y: number; px: number; py: number } | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    drag.current = { x: e.clientX, y: e.clientY, px: pan.x, py: pan.y };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const x = d.px + (e.clientX - d.x);
    const y = d.py + (e.clientY - d.y);
    if (svgRef.current) svgRef.current.style.transform = `translate(${x}px, ${y}px)`;
  };
  const onPointerUp = (e: React.PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    setPan({ x: d.px + (e.clientX - d.x), y: d.py + (e.clientY - d.y) });
  };

  // Wheel zoom anchored at the cursor, so zooming keeps what you pointed at.
  const onWheel = (e: React.WheelEvent) => {
    if (mode !== 'graph') return;
    e.preventDefault();
    const vp = viewportRef.current;
    if (!vp) return;
    const rect = vp.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    const next = Math.max(0.15, Math.min(2.5, zoom * factor));
    const k = next / zoom;
    setPan(p => ({ x: cx - (cx - p.x) * k, y: cy - (cy - p.y) * k }));
    setZoom(next);
  };

  const entryFor = (path: string): NodeCost | undefined => model.byPath.get(path);

  // Findings computed ONCE per cost model (WP-14 14.5): PlanBox used to call
  // findingsFor in its body, so a 40+-node plan re-ran the full findings
  // analysis per node per hover/drag re-render.
  const findingsByPath = useMemo(() => {
    const m = new Map<string, Finding[]>();
    for (const [path, entry] of model.byPath) {
      m.set(path, findingsFor(entry, model));
    }
    return m;
  }, [model]);

  if (mode === 'icicle') {
    return (
      <div className="plan-icicle-wrap">
        <IcicleView
          cells={icicle}
          model={model}
          selected={selected}
          onSelect={onSelect}
        />
      </div>
    );
  }

  return (
    <div className="plan-graph">
      <div className="plan-graph-controls">
        <button className="toolbar-btn" onClick={() => setZoom(z => Math.max(0.15, z / 1.2))}
                title="Zoom out">−</button>
        <span className="plan-zoom-value">{Math.round(zoom * 100)}%</span>
        <button className="toolbar-btn" onClick={() => setZoom(z => Math.min(2.5, z * 1.2))}
                title="Zoom in">+</button>
        <button className="toolbar-btn" onClick={fit} title="Fit the whole plan">Fit</button>
        {collapsed.size > 0 && (
          <button className="toolbar-btn" onClick={() => setCollapsed(new Set())}
                  title="Expand every collapsed subtree">Expand all</button>
        )}
      </div>

      <div
        className="plan-graph-viewport"
        ref={viewportRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onWheel={onWheel}
        onClick={e => { if (e.target === e.currentTarget) onSelect(null); }}
      >
        <svg
          ref={svgRef}
          className="plan-svg"
          width={layout.width * zoom}
          height={layout.height * zoom}
          viewBox={`0 0 ${layout.width} ${layout.height}`}
          style={{ transform: `translate(${pan.x}px, ${pan.y}px)` }}
          role="img"
          aria-label="Query execution plan diagram"
        >
          {/* Edges first so boxes paint over their endpoints. */}
          <g className="plan-edges">
            {layout.edges.map(e => {
              const active = hover === e.from.path || hover === e.to.path
                || selected === e.from.path || selected === e.to.path;
              const rows = e.from.node.stats.rowsActual
                ?? e.from.node.stats.rowsOut ?? e.from.node.stats.rowsEst;
              return (
                <g key={`${e.from.path}->${e.to.path}`} className={active ? 'plan-edge on' : 'plan-edge'}>
                  <path d={e.d} strokeWidth={edgeWidth(e.weight)} fill="none" />
                  {/* Row volume, printed on the thicker half of the edges only —
                      labelling every edge on a 40-node plan is unreadable. */}
                  {(active || e.weight > 0.55) && rows !== undefined && (
                    <text
                      className="plan-edge-label"
                      x={(e.from.x + e.to.x) / 2}
                      y={(e.from.y - e.from.height / 2 + e.to.y + e.to.height / 2) / 2}
                    >{formatRows(rows)}</text>
                  )}
                </g>
              );
            })}
          </g>

          <g className="plan-nodes">
            {layout.nodes.map(n => (
              <PlanBox
                key={n.path}
                laid={n}
                entry={entryFor(n.path)}
                model={model}
                findings={findingsByPath.get(n.path) ?? NO_FINDINGS}
                collapsed={collapsed.has(n.path)}
                hasChildren={n.node.children.length > 0}
                selected={selected === n.path}
                onSelect={onSelect}
                onToggle={toggleCollapse}
                onHover={setHover}
              />
            ))}
          </g>
        </svg>
      </div>
    </div>
  );
}

// ── one operation box ────────────────────────────────────────────────────────

const NO_FINDINGS: Finding[] = [];

interface BoxProps {
  laid: LaidOutNode;
  entry?: NodeCost;
  model: PlanCostModel;
  findings: Finding[];
  collapsed: boolean;
  hasChildren: boolean;
  selected: boolean;
  onSelect: (path: string | null) => void;
  onToggle: (path: string) => void;
  onHover: (path: string | null) => void;
}

// Memoized (WP-14 14.5): hover/drag re-renders of the graph re-render only
// the boxes whose props changed (selection, collapse), not all 40+.
const PlanBox = memo(function PlanBox({
  laid, entry, model, collapsed, hasChildren, selected, onSelect, onToggle, onHover,
  findings,
}: BoxProps) {
  const n = laid.node;
  const sev = entry?.severity ?? 'none';
  const x = laid.x - laid.width / 2;
  const y = laid.y - laid.height / 2;
  const worst: Finding | undefined =
    findings.find(f => f.level === 'critical') ?? findings[0];

  const rows = n.stats.rowsActual ?? n.stats.rowsOut ?? n.stats.rowsEst;
  // A plan with no weights at all (ClickHouse has no cost model) prints
  // nothing, rather than "cost 0.00" on every box.
  const weight = entry && model.total > 0 ? formatWeight(entry.weight, model.basis) : '';
  const pct = entry && entry.share > 0.005 ? `${Math.round(entry.share * 100)}%` : '';

  // The badge is right-aligned on the title line, so the operation label has to
  // be budgeted against it. Truncating to a fixed character count instead put
  // "Hash Join (Inner)" straight underneath a "281× off" pill.
  const OP_X = 32;
  const badgeSpan = worst ? badgeWidth(worst.badge) + 10 : 0;
  const opRoom = laid.width - OP_X - 12 - badgeSpan;
  const opLabel = fitText(n.op, opRoom, 6.7);
  const detailLabel = fitText(n.detail, laid.width - 15 - 12, 5.9);

  return (
    <g
      className={`plan-box sev-${sev}${selected ? ' selected' : ''}`}
      transform={`translate(${x}, ${y})`}
      onClick={e => { e.stopPropagation(); onSelect(selected ? null : laid.path); }}
      onMouseEnter={() => onHover(laid.path)}
      onMouseLeave={() => onHover(null)}
      tabIndex={0}
      role="button"
      aria-label={`${n.op}${n.detail ? `, ${n.detail}` : ''}${weight ? `, ${weight}` : ''}`}
      onKeyDown={e => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(laid.path); }
      }}
    >
      {/* Severity is carried by a left stripe as well as the fill, so the
          hottest node is findable without relying on colour discrimination. */}
      <rect className="plan-box-bg" width={laid.width} height={laid.height} rx="6" />
      <rect className="plan-box-stripe" width="4" height={laid.height} rx="2" />

      <text className="plan-box-glyph" x="15" y="22">{KIND_GLYPH[n.kind] ?? '◇'}</text>
      <text className="plan-box-op" x={OP_X} y="22">{opLabel}</text>

      {detailLabel && (
        <text className="plan-box-detail" x="15" y="38">{detailLabel}</text>
      )}

      <text className="plan-box-metric" x="15" y="54">
        {weight}{pct ? `  ·  ${pct}` : ''}
      </text>
      {rows !== undefined && (
        <text className="plan-box-rows" x={laid.width - 12} y="54" textAnchor="end">
          {formatRows(rows)} rows
        </text>
      )}

      {worst && (
        <g className={`plan-box-badge lvl-${worst.level}`}>
          <rect x={laid.width - 12 - badgeWidth(worst.badge)} y="8"
                width={badgeWidth(worst.badge)} height="15" rx="7.5" />
          <text x={laid.width - 12 - badgeWidth(worst.badge) / 2} y="19" textAnchor="middle">
            {worst.badge}
          </text>
        </g>
      )}

      {hasChildren && (
        <g
          className="plan-box-toggle"
          onClick={e => { e.stopPropagation(); onToggle(laid.path); }}
          role="button"
          aria-label={collapsed ? 'Expand subtree' : 'Collapse subtree'}
        >
          <circle cx={laid.width / 2} cy={laid.height} r="8" />
          <text x={laid.width / 2} y={laid.height + 4} textAnchor="middle">
            {collapsed ? '+' : '−'}
          </text>
        </g>
      )}
    </g>
  );
});

/** Rough text width for the badge pill — SVG has no layout pass to ask. */
function badgeWidth(label: string): number {
  return Math.max(34, label.length * 6.1 + 12);
}

/**
 * Clip a label to the pixels actually available.
 *
 * SVG `<text>` does not wrap or ellipsize, so anything too long simply paints
 * over its neighbours. `perChar` is an average advance for the font size in
 * use — approximate on purpose, since the alternative is a DOM measure pass
 * per node on every re-layout.
 */
function fitText(text: string, room: number, perChar: number): string {
  if (!text) return '';
  const max = Math.floor(room / perChar);
  if (max <= 1) return '';
  return text.length > max ? text.slice(0, max - 1) + '…' : text;
}

// ── icicle ───────────────────────────────────────────────────────────────────

interface IcicleProps {
  cells: ReturnType<typeof layoutIcicle>;
  model: PlanCostModel;
  selected: string | null;
  onSelect: (path: string | null) => void;
}

const ROW_H = 26;

function IcicleView({ cells, model, selected, onSelect }: IcicleProps) {
  if (cells.length === 0) {
    return (
      <div className="plan-empty">
        This plan carries no cost or timing information, so there is nothing to
        size the bars by. The <b>Graph</b> view still shows its structure.
      </div>
    );
  }
  const maxDepth = Math.max(...cells.map(c => c.depth));
  const height = (maxDepth + 1) * ROW_H;

  return (
    <div className="plan-icicle" style={{ height }}>
      {cells.map(c => {
        const entry = model.byPath.get(c.path);
        const widthPct = (c.x1 - c.x0) * 100;
        // Below about half a percent the cell is a sliver that cannot hold a
        // label and only adds visual noise; the graph view still shows it.
        if (widthPct < 0.4) return null;
        return (
          <div
            key={c.path}
            className={`plan-ice sev-${entry?.severity ?? 'none'}${selected === c.path ? ' selected' : ''}`}
            style={{
              left: `${c.x0 * 100}%`,
              width: `${widthPct}%`,
              top: c.depth * ROW_H,
              height: ROW_H - 2,
            }}
            title={`${c.node.op}${c.node.detail ? ` — ${c.node.detail}` : ''}\n`
              + `${formatWeight(entry?.weightTotal ?? 0, model.basis)} including children`}
            onClick={() => onSelect(selected === c.path ? null : c.path)}
            role="button"
            tabIndex={0}
            onKeyDown={e => { if (e.key === 'Enter') onSelect(c.path); }}
          >
            <span className="plan-ice-label">
              {c.node.op}
              {widthPct > 14 && entry && (
                <em> · {formatWeight(entry.weightTotal, model.basis)}</em>
              )}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ── the detail inspector ─────────────────────────────────────────────────────

export function PlanNodeDetail(
  { entry, model, onClose }: { entry: NodeCost; model: PlanCostModel; onClose: () => void },
) {
  const n: PlanNode = entry.node;
  const g = OP_GLOSSARY[n.kind] ?? OP_GLOSSARY.other;
  const findings = findingsFor(entry, model);
  const s = n.stats;

  return (
    <aside className="plan-inspector">
      <div className="plan-insp-head">
        <span className="plan-insp-glyph">{KIND_GLYPH[n.kind] ?? '◇'}</span>
        <div>
          <h4>{n.op}</h4>
          <p className="plan-insp-kind">{g.title}</p>
        </div>
        <button className="icon-btn" onClick={onClose} title="Close">×</button>
      </div>

      {n.detail && <code className="plan-insp-target">{n.detail}</code>}

      <dl className="plan-insp-stats">
        <Stat label={model.basis === 'time' ? 'Self time' : 'Self cost'}
              value={formatWeight(entry.weight, model.basis)} />
        <Stat label="Share of plan" value={`${(entry.share * 100).toFixed(1)}%`} />
        {s.msTotal !== undefined && <Stat label="Total time" value={formatWeight(s.msTotal, 'time')} />}
        {s.rowsEst !== undefined && <Stat label="Rows (est)" value={formatRows(s.rowsEst)} />}
        {s.rowsActual !== undefined && <Stat label="Rows (actual)" value={formatRows(s.rowsActual)} />}
        {s.loops !== undefined && s.loops > 1 && <Stat label="Loops" value={String(s.loops)} />}
        {s.index && <Stat label="Index" value={s.index} />}
      </dl>

      <section className="plan-insp-explain">
        <h5>What this does</h5>
        <p>{g.what}</p>
        <h5>When it is the right plan</h5>
        <p>{g.when}</p>
      </section>

      {findings.length > 0 && (
        <section className="plan-insp-findings">
          <h5>Findings</h5>
          {findings.map((f, i) => (
            <div key={i} className={`plan-finding lvl-${f.level}`}>
              <div className="plan-finding-badge">{f.badge}</div>
              <p className="plan-finding-observed">{f.observed}</p>
              <p className="plan-finding-why"><b>Why it matters.</b> {f.why}</p>
              <p className="plan-finding-action"><b>What to do.</b> {f.action}</p>
            </div>
          ))}
        </section>
      )}
    </aside>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (<><dt>{label}</dt><dd>{value}</dd></>);
}

export { SEVERITY_ORDER };
