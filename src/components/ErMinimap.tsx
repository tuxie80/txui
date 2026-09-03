/**
 * Whole-diagram thumbnail with a viewport box, drawn on a canvas.
 *
 * Canvas rather than SVG or divs: this redraws on every pan and zoom, and a
 * few hundred `<rect>` elements reconciled at that rate is exactly the cost
 * the main canvas was just taught to avoid. One `fillRect` per table is
 * cheaper than one DOM node per table by a wide margin.
 *
 * Click or drag to move the viewport. The point of it is orientation: at a
 * zoom where a large schema fits on screen you cannot read anything, and at a
 * readable zoom you cannot see where you are.
 */
import { useCallback, useEffect, useRef } from 'react';
import { erNodeHAt, ER_NODE_W } from '../utils/erLayout';
import type { ErPos, ErTable, Rect } from '../utils/erLayout';
import type { Density } from '../utils/diagramModel';

const W = 168;
const H = 116;
const PAD = 6;

interface Props {
  tables: ErTable[];
  pos: Map<string, ErPos>;
  density: Density;
  bounds: { w: number; h: number };
  view: Rect;
  selected: string | null;
  /** Centre the viewport on this diagram-space point. */
  onJump: (x: number, y: number) => void;
}

export function ErMinimap({ tables, pos, density, bounds, view, selected, onJump }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);
  const dragging = useRef(false);

  // Diagram space → thumbnail space, preserving aspect.
  const scale = Math.min((W - PAD * 2) / Math.max(1, bounds.w), (H - PAD * 2) / Math.max(1, bounds.h));

  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const dpr = window.devicePixelRatio || 1;
    cv.width = W * dpr;
    cv.height = H * dpr;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    const css = getComputedStyle(cv);
    const fg = css.getPropertyValue('--text2').trim() || '#888';
    const accent = css.getPropertyValue('--accent').trim() || '#3b82f6';

    ctx.fillStyle = fg;
    ctx.globalAlpha = 0.55;
    for (const t of tables) {
      const p = pos.get(t.name);
      if (!p) continue;
      const isSel = selected === t.name;
      if (isSel) { ctx.globalAlpha = 1; ctx.fillStyle = accent; }
      ctx.fillRect(
        PAD + p.x * scale, PAD + p.y * scale,
        Math.max(1.5, ER_NODE_W * scale), Math.max(1.5, erNodeHAt(t, density) * scale),
      );
      if (isSel) { ctx.globalAlpha = 0.55; ctx.fillStyle = fg; }
    }

    // Viewport box, clamped so it stays visible when zoomed out past the
    // content — otherwise it silently leaves the thumbnail entirely.
    ctx.globalAlpha = 1;
    ctx.strokeStyle = accent;
    ctx.lineWidth = 1.5;
    const vx = PAD + view.x * scale, vy = PAD + view.y * scale;
    const vw = view.w * scale, vh = view.h * scale;
    const cx = Math.max(0, Math.min(W - 2, vx));
    const cy = Math.max(0, Math.min(H - 2, vy));
    ctx.strokeRect(cx, cy, Math.min(vw, W - cx), Math.min(vh, H - cy));
  }, [tables, pos, density, bounds.w, bounds.h, view, selected, scale]);

  const jumpTo = useCallback((e: { clientX: number; clientY: number }) => {
    const cv = ref.current;
    if (!cv) return;
    const r = cv.getBoundingClientRect();
    onJump((e.clientX - r.left - PAD) / scale, (e.clientY - r.top - PAD) / scale);
  }, [onJump, scale]);

  useEffect(() => {
    const move = (e: MouseEvent) => { if (dragging.current) jumpTo(e); };
    const up = () => { dragging.current = false; };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
  }, [jumpTo]);

  return (
    <canvas
      ref={ref}
      className="er-minimap"
      style={{ width: W, height: H }}
      title="Diagram overview — click or drag to move"
      onMouseDown={e => { e.stopPropagation(); dragging.current = true; jumpTo(e); }}
    />
  );
}
