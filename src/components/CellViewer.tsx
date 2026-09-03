/**
 * Cell viewer modal — full cell content with pretty-printed JSON when the
 * value parses, a drawn shape when it is geometry, monospace wrap otherwise.
 * Copy button. Esc / backdrop closes.
 *
 * The geometry case is why this file is not two lines shorter. A PostGIS or
 * MySQL spatial column arrives as hex EWKB — `0101000020E6100000…` — and
 * showing that string is not wrong so much as useless: a user who sees it
 * concludes the app does not support PostGIS. Here it becomes the shape, its
 * type, its SRID, its extent and its vertex count, with WKT and GeoJSON one
 * click away.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { copyToClipboard } from '../utils/exportersIo';
import { bbox, isLonLat, parseWkbHex, positions, toGeoJson, toWkt, vertexCount } from '../utils/wkb';
import type { Geometry } from '../utils/wkb';
import { buildTree, isExpandable, jsonPath } from '../utils/jsonTree';
import type { JsonNode } from '../utils/jsonTree';

interface Props {
  column: string;
  value: unknown;
  onClose: () => void;
}

function render(value: unknown): { text: string; isJson: boolean; parsed?: unknown } {
  if (value === null || value === undefined) return { text: 'NULL', isJson: false };
  if (typeof value === 'object') {
    return { text: JSON.stringify(value, null, 2), isJson: true, parsed: value };
  }
  const s = String(value);
  const t = s.trim();
  if ((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))) {
    try {
      const parsed = JSON.parse(t);
      return { text: JSON.stringify(parsed, null, 2), isJson: true, parsed };
    } catch { /* not JSON — fall through */ }
  }
  return { text: s, isJson: false };
}

/**
 * Draw the geometry to fill the canvas.
 *
 * Deliberately *not* projected: a single geometry is being examined, not
 * placed on a map, and a Mercator projection of a building footprint in a
 * local CRS would only distort it. The aspect ratio is preserved so shapes
 * stay shapes.
 */
function drawGeometry(canvas: HTMLCanvasElement, g: Geometry): void {
  const box = bbox([g]);
  if (!box) return;
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 320;
  const h = canvas.clientHeight || 200;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const css = getComputedStyle(canvas);
  const accent = css.getPropertyValue('--accent').trim() || '#6cf';
  const ink = css.getPropertyValue('--text').trim() || '#ddd';

  const pad = 14;
  const spanX = Math.max(box.maxX - box.minX, 1e-9);
  const spanY = Math.max(box.maxY - box.minY, 1e-9);
  const scale = Math.min((w - pad * 2) / spanX, (h - pad * 2) / spanY);
  const ox = pad + ((w - pad * 2) - spanX * scale) / 2;
  const oy = pad + ((h - pad * 2) - spanY * scale) / 2;
  // Y is flipped: screen y grows downward, latitude grows upward.
  const sx = (x: number) => ox + (x - box.minX) * scale;
  const sy = (y: number) => h - (oy + (y - box.minY) * scale);

  ctx.lineWidth = 1.5;
  ctx.strokeStyle = accent;
  ctx.fillStyle = accent;

  const strokeRing = (ring: { x: number; y: number }[], close: boolean) => {
    ctx.beginPath();
    ring.forEach((p, i) => (i === 0 ? ctx.moveTo(sx(p.x), sy(p.y)) : ctx.lineTo(sx(p.x), sy(p.y))));
    if (close) ctx.closePath();
    ctx.stroke();
  };

  const drawOne = (geom: Geometry) => {
    switch (geom.type) {
      case 'Point':
      case 'MultiPoint': {
        const pts = geom.type === 'Point' ? [geom.coordinates] : geom.coordinates;
        for (const p of pts) {
          ctx.beginPath();
          ctx.arc(sx(p.x), sy(p.y), 4, 0, Math.PI * 2);
          ctx.fill();
        }
        return;
      }
      case 'LineString': strokeRing(geom.coordinates, false); return;
      case 'MultiLineString': geom.coordinates.forEach(l => strokeRing(l, false)); return;
      case 'Polygon': geom.coordinates.forEach(r => strokeRing(r, true)); return;
      case 'MultiPolygon':
        geom.coordinates.forEach(poly => poly.forEach(r => strokeRing(r, true)));
        return;
      case 'GeometryCollection': geom.geometries.forEach(drawOne); return;
    }
  };
  drawOne(g);

  // A vertex count is a number; seeing the vertices is an inspection.
  if (vertexCount(g) <= 400) {
    ctx.fillStyle = ink;
    ctx.globalAlpha = 0.6;
    for (const p of positions(g)) {
      ctx.beginPath();
      ctx.arc(sx(p.x), sy(p.y), 1.6, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }
}

/**
 * One row of the JSON tree, recursing into its own children. Each node keeps
 * its own open/closed state (rows below the first level start collapsed), and
 * offers `path` — a JSONPath you can paste into a query — and `value`, the
 * pretty-printed subtree, both routed through the viewer's `copy`.
 */
function TreeNode({ node, depth, copy, copied }: {
  node: JsonNode;
  depth: number;
  copy: (what: string, label: string) => void;
  copied: string | null;
}) {
  const expandable = isExpandable(node);
  const [open, setOpen] = useState(depth < 1);
  const path = jsonPath(node.path);
  const label = node.key === null ? '$' : String(node.key);

  return (
    <div className="cv-tnode">
      <div className="cv-trow" style={{ paddingLeft: `${depth * 14}px` }}>
        <span
          className={`cv-ttoggle${expandable ? ' cv-clickable' : ''}`}
          onClick={() => expandable && setOpen(o => !o)}
        >
          {expandable ? (open ? '▾' : '▸') : ''}
        </span>
        <span className={`cv-tkey cv-t-${node.type}`}>{label}</span>
        {(!expandable || !open) && <span className="cv-tprev">{node.preview}</span>}
        <span className="cv-tacts">
          <button className="cv-tbtn" title={`Copy path — ${path}`}
            onClick={() => copy(path, `path:${path}`)}>
            {copied === `path:${path}` ? 'copied ✓' : 'path'}
          </button>
          <button className="cv-tbtn" title="Copy value"
            onClick={() => copy(JSON.stringify(node.value, null, 2), `val:${path}`)}>
            {copied === `val:${path}` ? 'copied ✓' : 'value'}
          </button>
        </span>
      </div>
      {expandable && open && (
        <div className="cv-tchildren">
          {node.children!.map((c, i) => (
            <TreeNode key={i} node={c} depth={depth + 1} copy={copy} copied={copied} />
          ))}
          {node.truncated && (
            <div className="cv-trow cv-ttrunc" style={{ paddingLeft: `${(depth + 1) * 14}px` }}>
              … more items not shown
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function CellViewer({ column, value, onClose }: Props) {
  const { text, isJson, parsed } = useMemo(() => render(value), [value]);
  const [copied, setCopied] = useState<string | null>(null);
  const [jsonView, setJsonView] = useState<'text' | 'tree'>('text');
  const tree = useMemo(
    () => (isJson ? buildTree(parsed) : null), [isJson, parsed]);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // Only strings can be hex geometry, and `parseWkbHex` returns null cheaply
  // for everything that is not — so this costs nothing on ordinary cells.
  const geom = useMemo(
    () => (typeof value === 'string' ? parseWkbHex(value) : null), [value]);
  const box = useMemo(() => (geom ? bbox([geom]) : null), [geom]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    if (geom && canvasRef.current) drawGeometry(canvasRef.current, geom);
  }, [geom]);

  async function copy(what: string, label: string) {
    try {
      await copyToClipboard(what);
      setCopied(label);
      setTimeout(() => setCopied(null), 1500);
    } catch { /* clipboard unavailable */ }
  }

  return (
    <div className="cv-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="cv-modal">
        <div className="cv-header">
          <span className="cv-title">
            {column}{geom ? ` · ${geom.type}` : isJson ? ' · JSON' : ''}
          </span>
          <span className="cv-len">
            {geom
              ? `${vertexCount(geom).toLocaleString()} vertices`
              : `${text.length.toLocaleString()} chars`}
          </span>
          {geom ? (
            <>
              <button className="toolbar-btn" onClick={() => copy(toWkt(geom), 'WKT')}>
                {copied === 'WKT' ? 'Copied ✓' : 'Copy WKT'}
              </button>
              <button className="toolbar-btn"
                onClick={() => copy(JSON.stringify(toGeoJson(geom), null, 2), 'GeoJSON')}>
                {copied === 'GeoJSON' ? 'Copied ✓' : 'Copy GeoJSON'}
              </button>
              <button className="toolbar-btn" onClick={() => copy(text, 'hex')}>
                {copied === 'hex' ? 'Copied ✓' : 'Copy hex'}
              </button>
            </>
          ) : (
            <>
              {isJson && (
                <div className="cv-viewtoggle" role="group" aria-label="JSON view">
                  <button
                    className={`toolbar-btn${jsonView === 'text' ? ' active' : ''}`}
                    onClick={() => setJsonView('text')}>Text</button>
                  <button
                    className={`toolbar-btn${jsonView === 'tree' ? ' active' : ''}`}
                    onClick={() => setJsonView('tree')}>Tree</button>
                </div>
              )}
              <button className="toolbar-btn" onClick={() => copy(text, 'text')}>
                {copied === 'text' ? 'Copied ✓' : 'Copy'}
              </button>
            </>
          )}
          <button className="icon-btn" onClick={onClose} title="Close">×</button>
        </div>

        {geom ? (
          <div className="cv-geo">
            <canvas ref={canvasRef} className="cv-geo-canvas" />
            <div className="cv-geo-facts">
              <span><b>SRID</b> {geom.srid ?? 'none declared'}</span>
              {box && (
                <span>
                  <b>Extent</b> {box.minX.toFixed(6)}, {box.minY.toFixed(6)} →{' '}
                  {box.maxX.toFixed(6)}, {box.maxY.toFixed(6)}
                </span>
              )}
              {/* Said plainly, because it decides whether these numbers can be
                  put on a world map at all. */}
              <span>
                <b>Units</b> {isLonLat(geom.srid, box)
                  ? 'degrees (longitude / latitude)'
                  : 'projected — not longitude/latitude'}
              </span>
            </div>
          </div>
        ) : isJson && jsonView === 'tree' && tree ? (
          <div className="cv-body cv-json-tree">
            <TreeNode node={tree} depth={0} copy={copy} copied={copied} />
          </div>
        ) : (
          <pre className={`cv-body ${isJson ? 'cv-json' : ''}`}>{text}</pre>
        )}
      </div>
    </div>
  );
}
