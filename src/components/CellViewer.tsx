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
import { bbox, isLonLat, positions, toGeoJson, toWkt, vertexCount } from '../utils/wkb';
import type { Geometry, Position } from '../utils/wkb';
import { cellGeometry } from '../utils/geoDetect';
import { fitViewport, graticuleStep, toScreen } from '../utils/geoTrack';
import { loadBasemap } from '../utils/basemap';
import type { BasemapPolygon } from '../utils/basemap';
import { buildTree, isExpandable, jsonPath } from '../utils/jsonTree';
import type { JsonNode } from '../utils/jsonTree';

interface Props {
  column: string;
  value: unknown;
  onClose: () => void;
  /** Session engine — lets the projected-geometry note point at the map's
   *  "View in WGS 84" action when (and only when) it exists: PostgreSQL. */
  engine?: string;
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
 * Draw the geometry.
 *
 * Two honest modes, chosen by what the coordinates ARE:
 *
 *  - **Longitude/latitude** (`isLonLat`): a mini-map — Web Mercator, the
 *    bundled Natural Earth coastline and a faint graticule under the shape,
 *    so the cell is seen where it is in the world. The coastline is bundled
 *    (`src/assets/basemap.json`, public domain); the mini-map never touches
 *    the network. When the asset is absent, graticule alone is the fallback.
 *  - **Projected / unknown CRS**: the shape alone, unprojected, aspect
 *    preserved — a Mercator projection of a building footprint in a local
 *    CRS would only distort it, and placing it on a world map would put it
 *    somewhere it is not. The Units verdict below the canvas says so.
 */
function drawGeometry(canvas: HTMLCanvasElement, g: Geometry, land: BasemapPolygon[] | null): void {
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

  const lonlat = isLonLat(g.srid, box);
  const pad = 14;

  // pt maps a source position to canvas pixels — the one difference between
  // the two modes.
  let pt: (p: Position) => { x: number; y: number };
  if (lonlat) {
    const v = fitViewport(
      { minLat: box.minY, maxLat: box.maxY, minLon: box.minX, maxLon: box.maxX }, w, h, pad);
    pt = p => toScreen(v, p.x, p.y);

    // A surface first, so the landmasses read against something.
    ctx.fillStyle = css.getPropertyValue('--bg2').trim() || '#20232b';
    ctx.fillRect(0, 0, w, h);
    if (land) {
      ctx.fillStyle = 'rgba(255,255,255,0.07)';
      ctx.strokeStyle = 'rgba(255,255,255,0.25)';
      ctx.lineWidth = 0.75;
      ctx.beginPath();
      for (const poly of land) {
        for (const ringPts of poly.rings) {
          ringPts.forEach(([lon, lat], i) => {
            const s = toScreen(v, lon, lat);
            if (i === 0) ctx.moveTo(s.x, s.y); else ctx.lineTo(s.x, s.y);
          });
          ctx.closePath();
        }
      }
      ctx.fill('evenodd');
      ctx.globalAlpha = 0.6;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    // A faint graticule: the coordinate frame that needs no asset at all.
    const step = graticuleStep(Math.max(box.maxX - box.minX, box.maxY - box.minY));
    ctx.strokeStyle = 'rgba(255,255,255,0.13)';
    ctx.lineWidth = 1;
    for (let lat = Math.ceil(box.minY / step) * step; lat <= box.maxY; lat += step) {
      const y = toScreen(v, box.minX, lat).y;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
    }
    for (let lon = Math.ceil(box.minX / step) * step; lon <= box.maxX; lon += step) {
      const x = toScreen(v, lon, box.minY).x;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
    }
  } else {
    const spanX = Math.max(box.maxX - box.minX, 1e-9);
    const spanY = Math.max(box.maxY - box.minY, 1e-9);
    const scale = Math.min((w - pad * 2) / spanX, (h - pad * 2) / spanY);
    const ox = pad + ((w - pad * 2) - spanX * scale) / 2;
    const oy = pad + ((h - pad * 2) - spanY * scale) / 2;
    // Y is flipped: screen y grows downward, latitude grows upward.
    pt = p => ({ x: ox + (p.x - box.minX) * scale, y: h - (oy + (p.y - box.minY) * scale) });
  }

  ctx.lineWidth = 1.5;
  ctx.strokeStyle = accent;
  ctx.fillStyle = accent;

  const strokeRing = (ring: Position[], close: boolean) => {
    ctx.beginPath();
    ring.forEach((p, i) => {
      const s = pt(p);
      if (i === 0) ctx.moveTo(s.x, s.y); else ctx.lineTo(s.x, s.y);
    });
    if (close) ctx.closePath();
    ctx.stroke();
  };
  // On the mini-map a filled shape reads against the coastline; unprojected
  // mode keeps the bare outline it always had.
  const drawPolygon = (rings: Position[][]) => {
    if (!lonlat) { rings.forEach(r => strokeRing(r, true)); return; }
    ctx.beginPath();
    for (const r of rings) {
      r.forEach((p, i) => {
        const s = pt(p);
        if (i === 0) ctx.moveTo(s.x, s.y); else ctx.lineTo(s.x, s.y);
      });
      ctx.closePath();
    }
    ctx.fillStyle = accent;
    ctx.globalAlpha = 0.2;
    ctx.fill('evenodd');
    ctx.globalAlpha = 1;
    ctx.stroke();
  };

  const drawOne = (geom: Geometry) => {
    switch (geom.type) {
      case 'Point':
      case 'MultiPoint': {
        const pts = geom.type === 'Point' ? [geom.coordinates] : geom.coordinates;
        for (const p of pts) {
          const s = pt(p);
          ctx.beginPath();
          ctx.arc(s.x, s.y, 4, 0, Math.PI * 2);
          ctx.fill();
        }
        return;
      }
      case 'LineString': strokeRing(geom.coordinates, false); return;
      case 'MultiLineString': geom.coordinates.forEach(l => strokeRing(l, false)); return;
      case 'Polygon': drawPolygon(geom.coordinates); return;
      case 'MultiPolygon': geom.coordinates.forEach(drawPolygon); return;
      case 'GeometryCollection': geom.geometries.forEach(drawOne); return;
    }
  };
  drawOne(g);

  // A vertex count is a number; seeing the vertices is an inspection.
  if (vertexCount(g) <= 400) {
    ctx.fillStyle = ink;
    ctx.globalAlpha = 0.6;
    for (const p of positions(g)) {
      const s = pt(p);
      ctx.beginPath();
      ctx.arc(s.x, s.y, 1.6, 0, Math.PI * 2);
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

export function CellViewer({ column, value, onClose, engine }: Props) {
  const { text, isJson, parsed } = useMemo(() => render(value), [value]);
  const [copied, setCopied] = useState<string | null>(null);
  const [jsonView, setJsonView] = useState<'text' | 'tree'>('text');
  const tree = useMemo(
    () => (isJson ? buildTree(parsed) : null), [isJson, parsed]);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // The shared probe (utils/geoDetect): WKB/EWKB hex strings, and GeoJSON —
  // as a real object (a MongoDB sub-document) or a JSON string. Both return
  // null cheaply for ordinary cells, so this costs nothing on them. (The
  // ClickHouse array forms need the column's type name, which a bare cell
  // does not carry — the map, which has ColumnInfo, detects those.)
  const geom = useMemo(() => cellGeometry(value), [value]);
  // Which copy-the-source button applies: the hex wall for WKB, the JSON text
  // for GeoJSON.
  const wkbSource = geom !== null && typeof value === 'string' && !value.trim().startsWith('{');
  const box = useMemo(() => (geom ? bbox([geom]) : null), [geom]);
  const lonlat = geom !== null && isLonLat(geom.srid, box);

  // The mini-map's coastline: the bundled Natural Earth asset, loaded only
  // when a lon/lat geometry is actually being shown. null (absent asset) is
  // fine — the mini-map falls back to its graticule.
  const [land, setLand] = useState<BasemapPolygon[] | null>(null);
  useEffect(() => {
    if (!lonlat) return;
    let alive = true;
    void loadBasemap().then(p => { if (alive && p) setLand(p); });
    return () => { alive = false; };
  }, [lonlat]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    if (geom && canvasRef.current) drawGeometry(canvasRef.current, geom, lonlat ? land : null);
  }, [geom, lonlat, land]);

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
              <button className="toolbar-btn" onClick={() => copy(text, 'src')}>
                {copied === 'src' ? 'Copied ✓' : wkbSource ? 'Copy hex' : 'Copy JSON'}
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
                <b>Units</b> {lonlat
                  ? 'degrees (longitude / latitude)'
                  : 'projected — not longitude/latitude'}
              </span>
              {/* How the canvas above was drawn — the difference between "the
                  shape" and "the shape, where it is" matters. */}
              <span>
                <b>Map</b> {lonlat
                  ? 'Web Mercator over the bundled Natural Earth coastline'
                  : 'unprojected — shape only, no world position'}
              </span>
              {/* The single-cell twin of the map's "View in WGS 84" action:
                  a one-cell derived query would need the whole result's query
                  text, which this modal never sees — so it points at the map,
                  where that action lives. */}
              {!lonlat && engine === 'postgres' && (
                <span>
                  <b>WGS 84</b> to see this shape on a world map, open the result's
                  🗺 Map tab and use “View in WGS 84” — it runs a derived
                  ST_Transform query on the whole column
                </span>
              )}
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
