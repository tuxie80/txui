// A small, fast, dependency-free SVG line chart for the Replay dashboard.
//
// Why hand-rolled: txui ships no chart library, and a recording's series are
// pre-downsampled by the backend to a few hundred points, so an SVG polyline
// is both simpler and faster than pulling in a charting dependency. The chart
// is theme-aware (uses txui's CSS custom properties) and supports a movable
// cursor + click/drag-to-seek, which is the whole point in a replay.

import { useMemo, useRef, useState } from 'react';
import { metricLabel } from '../../lib/replay';

// A categorical palette anchored on txui theme vars, extended with a few fixed
// hues so a group with many metrics stays readable in both light and dark.
const PALETTE = [
  'var(--accent)', 'var(--green)', 'var(--yellow)', 'var(--red)',
  '#7aa2f7', '#bb9af7', '#2ac3de', '#e0af68', '#9ece6a', '#f7768e',
];

interface Props {
  timestamps: string[];
  series: Record<string, number[]>;
  height?: number;
  /** Index of the replay cursor within `timestamps` (draws a vertical line). */
  cursorIndex?: number;
  /** Click/drag on the plot seeks here (index into `timestamps`). */
  onSeek?: (index: number) => void;
  /** Hide the legend (used by the compact context chart). */
  hideLegend?: boolean;
  title?: string;
  unit?: string;
  /** Indices (into `timestamps`) to flag with a red tick — anomaly markers. */
  markers?: number[];
  /** Exact current-second value per series (from the snapshot). Shown in the
   *  readout when not hovering, so values change every second even though the
   *  plotted line is downsampled to a few hundred points. */
  currentValues?: Record<string, number>;
  /** Exact current-second timestamp, shown when not hovering. */
  currentTs?: string;
  /** Shared hover index (into `timestamps`). When provided, hover is controlled
   *  by the parent so hovering ONE chart moves the crosshair + readouts on ALL
   *  of them — a synchronized cross-metric overview. */
  hoverIndex?: number | null;
  onHoverIndex?: (i: number | null) => void;
}

const PAD = { top: 8, right: 8, bottom: 18, left: 46 };

export function LineChart({
  timestamps, series, height = 140, cursorIndex, onSeek, hideLegend, title, unit, markers,
  currentValues, currentTs, hoverIndex, onHoverIndex,
}: Props) {
  const ref = useRef<SVGSVGElement>(null);
  const [w, setW] = useState(600);
  const [localHover, setLocalHover] = useState<number | null>(null);
  // Controlled hover when the parent wires it up (synchronized crosshair);
  // otherwise the chart tracks its own.
  const hover = onHoverIndex ? (hoverIndex ?? null) : localHover;
  const setHover = (i: number | null) => (onHoverIndex ? onHoverIndex(i) : setLocalHover(i));

  // Track width via ResizeObserver so the chart fills its container.
  const setRef = (el: SVGSVGElement | null) => {
    ref.current = el;
    if (el && !(el as unknown as { _ro?: ResizeObserver })._ro) {
      const ro = new ResizeObserver(entries => {
        const cw = entries[0]?.contentRect.width;
        if (cw) setW(Math.max(120, cw));
      });
      ro.observe(el);
      (el as unknown as { _ro?: ResizeObserver })._ro = ro;
    }
  };

  const names = useMemo(() => Object.keys(series), [series]);
  const n = timestamps.length;

  const { min, max } = useMemo(() => {
    let lo = Infinity, hi = -Infinity;
    for (const name of names) {
      for (const v of series[name]) {
        if (Number.isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; }
      }
    }
    if (!Number.isFinite(lo)) { lo = 0; hi = 1; }
    if (lo === hi) { hi = lo + 1; }
    return { min: lo, max: hi };
  }, [names, series]);

  const plotW = Math.max(1, w - PAD.left - PAD.right);
  const plotH = Math.max(1, height - PAD.top - PAD.bottom);
  const xAt = (i: number) => PAD.left + (n <= 1 ? 0 : (i / (n - 1)) * plotW);
  const yAt = (v: number) => PAD.top + plotH - ((v - min) / (max - min)) * plotH;

  // Plain computation — the React Compiler memoizes this; a manual useMemo here
  // trips its preserve-manual-memoization rule because xAt/yAt are closures.
  const paths = names.map((name, gi) => {
    let d = '';
    let pen = false;
    series[name].forEach((v, i) => {
      if (!Number.isFinite(v)) { pen = false; return; }
      d += `${pen ? 'L' : 'M'}${xAt(i).toFixed(1)},${yAt(v).toFixed(1)}`;
      pen = true;
    });
    return { name, d, color: PALETTE[gi % PALETTE.length] };
  });

  const indexFromEvent = (e: React.MouseEvent) => {
    const rect = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
    const x = e.clientX - rect.left - PAD.left;
    const i = Math.round((x / plotW) * (n - 1));
    return Math.max(0, Math.min(n - 1, i));
  };

  const fmt = (v: number) =>
    Math.abs(v) >= 1e9 ? (v / 1e9).toFixed(1) + 'G'
      : Math.abs(v) >= 1e6 ? (v / 1e6).toFixed(1) + 'M'
      : Math.abs(v) >= 1e3 ? (v / 1e3).toFixed(1) + 'k'
      : Number.isInteger(v) ? String(v) : v.toFixed(2);

  const hi = hover ?? cursorIndex;
  // Time to show: the hovered point when hovering, else the exact current
  // second — so a datetime is ALWAYS present.
  const readoutTs = hover != null
    ? timestamps[hover]
    : (currentTs ?? (cursorIndex != null && cursorIndex >= 0 && cursorIndex < n ? timestamps[cursorIndex] : undefined));

  return (
    <div className="rp-chart">
      {(title || readoutTs) && (
        <div className="rp-chart-head">
          {title && <span className="rp-chart-title">{title}{unit ? ` (${unit})` : ''}</span>}
          {readoutTs && <span className="rp-chart-ts">{readoutTs.slice(11)}</span>}
        </div>
      )}
      <svg
        ref={setRef}
        width="100%"
        height={height}
        style={{ display: 'block', cursor: onSeek ? 'crosshair' : 'default' }}
        onMouseMove={e => setHover(indexFromEvent(e))}
        onMouseLeave={() => setHover(null)}
        onMouseDown={e => onSeek?.(indexFromEvent(e))}
      >
        {/* y grid + labels */}
        {[0, 0.5, 1].map(t => {
          const v = min + (max - min) * (1 - t);
          const y = PAD.top + plotH * t;
          return (
            <g key={t}>
              <line x1={PAD.left} y1={y} x2={w - PAD.right} y2={y}
                stroke="var(--border-soft, var(--border))" strokeWidth={0.5} />
              <text x={PAD.left - 6} y={y + 3} textAnchor="end"
                fontSize={9} fill="var(--text-dim)">{fmt(v)}</text>
            </g>
          );
        })}

        {/* series */}
        {paths.map(p => (
          <path key={p.name} d={p.d} fill="none" stroke={p.color} strokeWidth={1.3} />
        ))}

        {/* anomaly markers along the top edge */}
        {markers?.map((mi, k) => (
          mi >= 0 && mi < n
            ? <line key={k} x1={xAt(mi)} y1={PAD.top} x2={xAt(mi)} y2={PAD.top + 5}
                stroke="var(--red)" strokeWidth={1.5} opacity={0.85} />
            : null
        ))}

        {/* cursor / hover line */}
        {hi != null && hi >= 0 && hi < n && (
          <line x1={xAt(hi)} y1={PAD.top} x2={xAt(hi)} y2={PAD.top + plotH}
            stroke="var(--accent)" strokeWidth={1} strokeDasharray="3 2" opacity={0.8} />
        )}

        {/* datetime at the cursor — ALWAYS shown, follows hover */}
        {hi != null && hi >= 0 && hi < n && readoutTs && (
          <text x={Math.min(w - PAD.right, Math.max(PAD.left + 18, xAt(hi)))} y={PAD.top + 8}
            textAnchor="middle" fontSize={10} fontWeight={700} fill="var(--accent)">
            {readoutTs.slice(11)}
          </text>
        )}

        {/* x labels: first / mid / last */}
        {n > 0 && [0, Math.floor(n / 2), n - 1].map((i, k) => (
          <text key={k} x={xAt(i)} y={height - 5}
            textAnchor={k === 0 ? 'start' : k === 2 ? 'end' : 'middle'}
            fontSize={9} fill="var(--text-dim)">
            {(timestamps[i] ?? '').slice(11)}
          </text>
        ))}
      </svg>

      {/* Value readout at the cursor — big and clear, the point of a replay.
          Shown for every chart (context included) so graph values are always
          perfectly visible and update instantly on step / drag. */}
      {names.length > 0 && (
        <div className={`rp-values ${hideLegend ? 'rp-values-compact' : ''}`}>
          {paths.map(p => {
            // Hovering inspects history (downsampled point); otherwise show the
            // EXACT current-second value so stepping seconds updates the number.
            const v = hover != null
              ? series[p.name]?.[hover]
              : (currentValues?.[p.name] ?? (cursorIndex != null ? series[p.name]?.[cursorIndex] : undefined));
            return (
              <span key={p.name} className="rp-value-item">
                <i style={{ background: p.color }} />
                <span className="rp-value-label">{metricLabel(p.name)}</span>
                <b className="rp-value-num">{v != null && Number.isFinite(v) ? fmt(v) : '—'}</b>
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}
