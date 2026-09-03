/**
 * 📊 Charts over the current result — dependency-free SVG.
 * - bar / pie: aggregate rows by the X column (sum of Y, or row count),
 *   top-30 categories, the rest folded into "(other)".
 * - line / area: Y series in row order (or against X), sampled to ≤2000 points.
 * Colors ride the theme's CSS variables, so charts follow every theme.
 * SeriesChart is exported for the Monitor panel's expanded metric view.
 */
import { useMemo, useRef, useState } from 'react';
import type { ColumnInfo } from '../types';
import { cellText } from '../utils/exporters';
import {
  downloadBlob, downloadSvg, liveSvgToString, svgToPng, themeFromDocument,
} from '../utils/erExport';

const PALETTE = [
  'var(--accent)', 'var(--green)', 'var(--yellow)', 'var(--red)',
  '#b06ce0', '#50c8c8', '#e07a9e', '#808a9a', '#e0894a', '#7aa0e0',
];
const COUNT = -1;               // pseudo Y column: count rows per category
const MAX_CATS = 30;
const MAX_POINTS = 2000;

type ChartType = 'bar' | 'line' | 'area' | 'pie';

const fmt = (n: number): string => {
  if (!Number.isFinite(n)) return '';
  const a = Math.abs(n);
  if (a >= 1e9) return `${(n / 1e9).toFixed(1)}G`;
  if (a >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (a >= 1e4) return `${(n / 1e3).toFixed(1)}k`;
  return Number.isInteger(n) ? n.toLocaleString() : n.toLocaleString(undefined, { maximumFractionDigits: 2 });
};

function toNum(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const n = Number(String(v));
  return Number.isFinite(n) && String(v).trim() !== '' ? n : null;
}

/** Columns where most non-null sampled values parse as numbers. */
function numericCols(columns: ColumnInfo[], rows: unknown[][]): boolean[] {
  const sample = rows.slice(0, 200);
  return columns.map((_, ci) => {
    let num = 0, seen = 0;
    for (const r of sample) {
      const v = r[ci];
      if (v === null || v === undefined) continue;
      seen++;
      if (toNum(v) !== null) num++;
    }
    return seen > 0 && num / seen > 0.7;
  });
}

// ── Shared series line/area chart (also used by MonitorPanel) ─────────────────

export interface Series { name: string; points: number[]; color?: string }

export function SeriesChart({ series, labels, area, height = 320 }: {
  series: Series[];
  /** optional x labels, same length as points */
  labels?: string[];
  area?: boolean;
  height?: number;
}) {
  const W = 860, H = height, padL = 56, padR = 12, padT = 12, padB = 26;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const all = series.flatMap(s => s.points).filter(Number.isFinite);
  if (all.length === 0) return <div className="chart-empty">No numeric data to plot.</div>;
  let min = Math.min(...all), max = Math.max(...all);
  if (min === max) { min -= 1; max += 1; }
  if (min > 0 && min / max < 0.35) min = 0; // anchor near-zero ranges at 0
  const n = Math.max(...series.map(s => s.points.length));
  const x = (i: number) => padL + (n <= 1 ? plotW / 2 : (i / (n - 1)) * plotW);
  const y = (v: number) => padT + plotH - ((v - min) / (max - min)) * plotH;

  const yTicks = [0, 0.25, 0.5, 0.75, 1].map(t => min + t * (max - min));
  const xTickIdx = labels
    ? [...new Set([0, ...Array.from({ length: 6 }, (_, k) => Math.round(((k + 1) / 7) * (n - 1))), n - 1])]
    : [];

  return (
    <svg className="chart-svg" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet">
      {yTicks.map((v, i) => (
        <g key={i}>
          <line x1={padL} x2={W - padR} y1={y(v)} y2={y(v)} className="chart-grid" />
          <text x={padL - 6} y={y(v) + 3} className="chart-tick" textAnchor="end">{fmt(v)}</text>
        </g>
      ))}
      {labels && xTickIdx.map(i => (
        <text key={i} x={x(i)} y={H - 8} className="chart-tick" textAnchor="middle">
          {String(labels[i] ?? '').slice(0, 12)}
        </text>
      ))}
      {series.map((s, si) => {
        const color = s.color ?? PALETTE[si % PALETTE.length];
        const pts = s.points.map((v, i) => `${x(i)},${y(v)}`).join(' ');
        return (
          <g key={s.name}>
            {area && s.points.length > 1 && (
              <polygon
                points={`${padL},${y(min)} ${pts} ${x(s.points.length - 1)},${y(min)}`}
                fill={color} opacity={0.18}
              />
            )}
            <polyline points={pts} fill="none" stroke={color} strokeWidth={1.8}>
              <title>{s.name}</title>
            </polyline>
          </g>
        );
      })}
    </svg>
  );
}

// ── Result chart panel ────────────────────────────────────────────────────────

interface Props {
  columns: ColumnInfo[];
  rows: unknown[][];
}

export function ResultChart({ columns, rows }: Props) {
  const numeric = useMemo(() => numericCols(columns, rows), [columns, rows]);
  const firstText = Math.max(0, columns.findIndex((_, i) => !numeric[i]));
  const firstNum = columns.findIndex((_, i) => numeric[i]);

  const [type, setType] = useState<ChartType>('bar');
  const [xCol, setXCol] = useState(firstText);
  const [yCol, setYCol] = useState(firstNum >= 0 ? firstNum : COUNT);

  // bar/pie: aggregate by category
  const cats = useMemo(() => {
    if (type !== 'bar' && type !== 'pie') return null;
    const agg = new Map<string, number>();
    for (const r of rows) {
      const k = cellText(r[xCol]);
      const v = yCol === COUNT ? 1 : (toNum(r[yCol]) ?? 0);
      agg.set(k, (agg.get(k) ?? 0) + v);
    }
    const sorted = [...agg.entries()].sort((a, b) => b[1] - a[1]);
    if (sorted.length > MAX_CATS) {
      const rest = sorted.slice(MAX_CATS - 1).reduce((s, [, v]) => s + v, 0);
      return [...sorted.slice(0, MAX_CATS - 1), ['(other)', rest] as [string, number]];
    }
    return sorted;
  }, [type, rows, xCol, yCol]);

  // line/area: sampled row-order series
  const lineData = useMemo(() => {
    if (type !== 'line' && type !== 'area') return null;
    const stride = Math.max(1, Math.ceil(rows.length / MAX_POINTS));
    const sampled = stride === 1 ? rows : rows.filter((_, i) => i % stride === 0);
    const points = sampled.map(r => (yCol === COUNT ? 1 : toNum(r[yCol]) ?? NaN)).filter(Number.isFinite);
    const labels = sampled.map(r => cellText(r[xCol]));
    return { points, labels, stride };
  }, [type, rows, xCol, yCol]);

  const yName = yCol === COUNT ? 'count(*)' : columns[yCol]?.name ?? '';

  // Export the chart that is currently on screen. The sub-charts each render
  // their own <svg>, so rather than plumb a ref through every one we read the
  // live node out of the chart body and bake its themed styles in (see
  // liveSvgToString) — the chart paints through CSS classes that do not exist
  // in a detached file.
  const bodyRef = useRef<HTMLDivElement>(null);
  const [exporting, setExporting] = useState(false);

  async function exportChart(kind: 'svg' | 'png' | 'clipboard') {
    const svgEl = bodyRef.current?.querySelector('svg');
    if (!svgEl) return;
    setExporting(true);
    try {
      const svg = liveSvgToString(svgEl as SVGSVGElement, {
        background: themeFromDocument(bodyRef.current).bg,
        title: `${yName} by ${columns[xCol]?.name ?? ''}`,
      });
      if (kind === 'svg') {
        downloadSvg(svg, 'chart.svg');
      } else {
        const png = await svgToPng(svg);
        if (kind === 'png') downloadBlob(png, 'chart.png');
        else await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
      }
    } catch { /* export unavailable (no clipboard permission, etc.) */ }
    finally { setExporting(false); }
  }

  return (
    <div className="chart-wrap">
      <div className="chart-toolbar">
        {(['bar', 'line', 'area', 'pie'] as ChartType[]).map(t => (
          <button key={t} className={`toolbar-btn ${type === t ? 'active' : ''}`} onClick={() => setType(t)}>
            {t === 'bar' ? '▮ bar' : t === 'line' ? '╱ line' : t === 'area' ? '◪ area' : '◔ pie'}
          </button>
        ))}
        <label className="chart-pick">
          <span>{type === 'line' || type === 'area' ? 'label' : 'category'}</span>
          <select value={xCol} onChange={e => setXCol(Number(e.target.value))}>
            {columns.map((c, i) => <option key={c.name} value={i}>{c.name}</option>)}
          </select>
        </label>
        <label className="chart-pick">
          <span>value</span>
          <select value={yCol} onChange={e => setYCol(Number(e.target.value))}>
            <option value={COUNT}>count(*)</option>
            {columns.map((c, i) => numeric[i] && <option key={c.name} value={i}>{c.name}</option>)}
          </select>
        </label>
        {lineData && lineData.stride > 1 && (
          <span className="chart-note">sampled 1:{lineData.stride}</span>
        )}
        <div style={{ flex: 1 }} />
        <button className="toolbar-btn" title="Download this chart as an SVG"
          onClick={() => void exportChart('svg')} disabled={exporting}>SVG</button>
        <button className="toolbar-btn" title="Download this chart as a PNG"
          onClick={() => void exportChart('png')} disabled={exporting}>PNG</button>
        <button className="toolbar-btn" title="Copy this chart as an image"
          onClick={() => void exportChart('clipboard')} disabled={exporting}>Copy</button>
      </div>

      <div className="chart-body" ref={bodyRef}>
        {type === 'bar' && cats && <BarChart cats={cats} yName={yName} />}
        {type === 'pie' && cats && <PieChart cats={cats} yName={yName} />}
        {(type === 'line' || type === 'area') && lineData && (
          <SeriesChart
            series={[{ name: yName, points: lineData.points }]}
            labels={lineData.labels}
            area={type === 'area'}
          />
        )}
      </div>
    </div>
  );
}

function BarChart({ cats, yName }: { cats: [string, number][]; yName: string }) {
  const W = 860, H = 360, padL = 56, padR = 12, padT = 12, padB = 72;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  if (cats.length === 0) return <div className="chart-empty">No data.</div>;
  const max = Math.max(...cats.map(([, v]) => v), 0);
  const min = Math.min(...cats.map(([, v]) => v), 0);
  const range = max - min || 1;
  const bw = plotW / cats.length;
  const zero = padT + plotH - ((0 - min) / range) * plotH;

  return (
    <svg className="chart-svg" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet">
      {[0, 0.5, 1].map(t => {
        const v = min + t * range;
        const y = padT + plotH - t * plotH;
        return (
          <g key={t}>
            <line x1={padL} x2={W - padR} y1={y} y2={y} className="chart-grid" />
            <text x={padL - 6} y={y + 3} className="chart-tick" textAnchor="end">{fmt(v)}</text>
          </g>
        );
      })}
      {cats.map(([k, v], i) => {
        const h = Math.abs((v / range) * plotH);
        const y = v >= 0 ? zero - h : zero;
        return (
          <g key={k}>
            <rect
              x={padL + i * bw + bw * 0.12} y={y}
              width={bw * 0.76} height={Math.max(1, h)}
              fill={PALETTE[i % PALETTE.length]} rx={2}
            >
              <title>{`${k}: ${fmt(v)} (${yName})`}</title>
            </rect>
            {cats.length <= 40 && (
              <text
                x={padL + i * bw + bw / 2} y={H - padB + 12}
                className="chart-tick"
                textAnchor="end"
                transform={`rotate(-38 ${padL + i * bw + bw / 2} ${H - padB + 12})`}
              >{k.slice(0, 14)}</text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

function PieChart({ cats, yName }: { cats: [string, number][]; yName: string }) {
  const W = 860, H = 360, cx = 250, cy = H / 2, R = 140;
  const total = cats.reduce((s, [, v]) => s + Math.max(0, v), 0);
  if (total <= 0) return <div className="chart-empty">No positive values to plot.</div>;
  // cumulative fraction before each slice (no in-render mutation)
  const fracs = cats.map(([, v]) => Math.max(0, v) / total);
  const cumBefore = fracs.map((_, i) => fracs.slice(0, i).reduce((s, f) => s + f, 0));
  const slices = cats.map(([k, v], i) => {
    const frac = fracs[i];
    const a0 = -Math.PI / 2 + cumBefore[i] * Math.PI * 2;
    const a1 = a0 + frac * Math.PI * 2;
    const large = a1 - a0 > Math.PI ? 1 : 0;
    const p0 = [cx + R * Math.cos(a0), cy + R * Math.sin(a0)];
    const p1 = [cx + R * Math.cos(a1), cy + R * Math.sin(a1)];
    const d = frac >= 0.999
      ? `M ${cx - R} ${cy} A ${R} ${R} 0 1 1 ${cx + R} ${cy} A ${R} ${R} 0 1 1 ${cx - R} ${cy}`
      : `M ${cx} ${cy} L ${p0[0]} ${p0[1]} A ${R} ${R} 0 ${large} 1 ${p1[0]} ${p1[1]} Z`;
    return { k, v, frac, d, color: PALETTE[i % PALETTE.length] };
  });

  return (
    <svg className="chart-svg" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet">
      {slices.map(s => (
        <path key={s.k} d={s.d} fill={s.color} stroke="var(--bg)" strokeWidth={1}>
          <title>{`${s.k}: ${fmt(s.v)} (${(s.frac * 100).toFixed(1)}%) — ${yName}`}</title>
        </path>
      ))}
      {slices.slice(0, 18).map((s, i) => (
        <g key={s.k}>
          <rect x={440} y={30 + i * 18} width={10} height={10} fill={s.color} rx={2} />
          <text x={456} y={39 + i * 18} className="chart-legend">
            {s.k.slice(0, 28)} — {fmt(s.v)} ({(s.frac * 100).toFixed(1)}%)
          </text>
        </g>
      ))}
      {slices.length > 18 && (
        <text x={456} y={39 + 18 * 18} className="chart-tick">…and {slices.length - 18} more</text>
      )}
    </svg>
  );
}
