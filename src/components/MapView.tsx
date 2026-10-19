/**
 * 🗺 Map — a result set with coordinates, drawn and played back.
 *
 * The user names three columns: a timestamp and two coordinates. Nothing is
 * auto-detected. A guess at which column is latitude is right often enough to
 * be trusted and wrong often enough to mislead — `lat`/`lon` are swapped
 * constantly, an `id` parses as an epoch, and half the schemas that have a
 * column called `lat` are storing projected metres in it. A map drawn from a
 * wrong guess is confidently wrong, which is worse than no map. So the picker
 * *is* the feature, and each option carries the facts about that column
 * (`142/200 numeric · 49.9 … 50.2`) so the choice takes one glance.
 *
 * ## No tiles by default — online basemaps are an explicit, disclosed opt-in.
 *
 * TxUI's promise is that nothing leaves the machine. A tile basemap is an HTTP
 * request per tile to a third party, carrying — tile by tile — exactly where
 * your data is. For a DBA looking at customer addresses that is a data-egress
 * event, and it must never happen because someone opened a tab.
 *
 * So the default background is drawn locally — a **bundled Natural Earth
 * coastline** (`src/assets/basemap.json`, public domain, fetched once at
 * development time by `dev/fetch_basemap.mjs`), plus a **graticule and a
 * scale bar** — enough to answer "where is this", "how big is this" and
 * "which way is north", which is what a track needs. The tile basemaps
 * (Wikimedia-OSM / OSM / Esri) exist but are
 * gated: the first time a user selects one, a dialog names the host and says
 * plainly that the viewport's coordinates leave the machine; only after that
 * one-time acknowledgment (persisted as `dbgui.mapTilesAck`) do tiles load,
 * and only for the basemap the user picked.
 *
 * ## Playback
 *
 * The track is the whole result; the marker is one row. ◀ ▶ step, Space
 * plays, and the scrubber is draggable — dragging it moves the marker along
 * the timeline, and the grid selection follows. Clicking a point does the
 * reverse. That two-way link is the point of the view: the map answers
 * "where", the grid answers "what", and they are the same row.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  buildTrack, columnFacts, factsLabel, fitViewport, graticuleStep, hitTest, indexAtTime,
  step as stepIndex, toScreen, trackLength, tilesInView, zoomViewport,
} from '../utils/geoTrack';
import type { Track, Viewport } from '../utils/geoTrack';
import { bbox as geomBbox, isLonLat } from '../utils/wkb';
import type { Geometry, Position } from '../utils/wkb';
import { cellGeometry, detectGeoColumns } from '../utils/geoDetect';
import { wireBboxToBounds } from '../utils/geoParquet';
import { buildTransformQuery } from '../utils/geoTransform';
import { loadBasemap } from '../utils/basemap';
import type { BasemapPolygon } from '../utils/basemap';
import { hitTestGeometry } from '../utils/geoHit';
import { fmtDuration } from '../utils/fmtDuration';
import { downloadBlob } from '../utils/erExport';
import { PREFS, usePreference } from '../store/preferences';
import { confirmDialog } from '../utils/appDialog';

interface Props {
  columns: string[];
  rows: unknown[][];
  /** Server-reported column types, aligned with `columns` — ClickHouse geo
   *  columns (Point/Ring/Polygon) are detected ONLY through this. */
  columnTypes?: string[];
  /** Selecting a point selects the row in the grid. */
  onSelectRow?: (rowIndex: number) => void;
  /** GeoParquet footer bbox [west, south, east, north] — the file's whole
   *  extent. Used for the FIRST fit when a geometry column is drawn, so a
   *  paged view does not zoom into the page that happened to load. Pan/zoom
   *  afterwards is untouched; with no hint the decoded rows' bbox fits, as
   *  before. */
  initialBbox?: [number, number, number, number] | null;
  /** Session engine — the "View in WGS 84" action exists on PostgreSQL only. */
  engine?: string;
  /** The query text that produced this result — what the derived
   *  ST_Transform query wraps. Absent → the action is not offered. */
  sourceSql?: string | null;
  /** Runs a derived query (a new tab, through the normal execute path). */
  onRunDerived?: (sql: string, label: string) => void;
}

/** Milliseconds between frames at each speed. */
const SPEEDS = [1, 2, 5, 10, 25] as const;

/**
 * Colours for grouped tracks — one per car_id, cycled past the end.
 *
 * Deliberately **muted** mid-tones, not neon: over a real basemap the data has
 * to be read *against* the map, and saturated colours fight it for attention.
 * These stay legible on both the light and the dark basemap. Drawn with
 * explicit hex because a `<canvas>` cannot read CSS custom properties per shape.
 */
const TRACK_COLORS = [
  '#3b6fb0', '#b05a5a', '#4a8a6a', '#b08a3a', '#6a5a9a', '#a06a8a',
  '#4a7a9a', '#a0703a', '#5a8a5a', '#9a5a8a', '#3a8a9a', '#9a8a3a',
];

/**
 * Free, no-API-key basemaps. Muted styles first, because a light or dark
 * low-contrast basemap is what lets the track read cleanly — the bright default
 * OSM street map is offered but not the default.
 *
 * Light/Dark used to be CARTO tiles, but CARTO started requiring an API key
 * and now stamps "API KEY REQUIRED" across every tile served without one.
 * Light is now Wikimedia's OSM rendering — keyless and muted. Dark is the same
 * tile with its lightness inverted client-side (`invertTile`); there is no
 * credible key-free dark raster endpoint left to point at instead.
 */
type BaseMapId = 'light' | 'dark' | 'osm' | 'satellite' | 'none';
const BASEMAPS: Record<BaseMapId, {
  label: string; dark: boolean; attr: string; invert?: boolean;
  url: ((z: number, x: number, y: number) => string) | null;
}> = {
  light: { label: 'Light', dark: false, attr: '© OpenStreetMap contributors · Wikimedia',
    url: (z, x, y) => `https://maps.wikimedia.org/osm-intl/${z}/${x}/${y}.png` },
  dark: { label: 'Dark', dark: true, invert: true, attr: '© OpenStreetMap contributors · Wikimedia',
    url: (z, x, y) => `https://maps.wikimedia.org/osm-intl/${z}/${x}/${y}.png` },
  osm: { label: 'Street', dark: false, attr: '© OpenStreetMap contributors',
    url: (z, x, y) => `https://tile.openstreetmap.org/${z}/${x}/${y}.png` },
  satellite: { label: 'Satellite', dark: true, attr: '© Esri',
    url: (z, x, y) => `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}` },
  none: { label: 'Offline', dark: false, attr: '', url: null },
};

/**
 * Turn a light tile into a dark one: invert each pixel's lightness in HSL
 * space, so water stays blue and labels stay legible. Runs once per tile at
 * load; the processed canvas replaces the source image in the tile cache.
 * Returns null when pixel access is denied (tainted canvas) — the caller then
 * keeps the original tile, which the opacity slider can still dim.
 */
function invertTile(img: HTMLImageElement): HTMLCanvasElement | null {
  try {
    const c = document.createElement('canvas');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0);
    const data = ctx.getImageData(0, 0, c.width, c.height);
    const px = data.data;
    for (let i = 0; i < px.length; i += 4) {
      const r = px[i] / 255, g = px[i + 1] / 255, b = px[i + 2] / 255;
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      const l2 = (1 - (mx + mn) / 2) * 0.85;   // inverted lightness, slightly darker
      if (mx === mn) {
        px[i] = px[i + 1] = px[i + 2] = l2 * 255;
        continue;
      }
      const d = mx - mn;
      const l = (mx + mn) / 2;
      const s = l < 0.5 ? d / (mx + mn) : d / (2 - mx - mn);
      let h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
      h /= 6;
      if (h < 0) h += 1;
      const q = l2 < 0.5 ? l2 * (1 + s) : l2 + s - l2 * s;
      const p = 2 * l2 - q;
      const hue = (t: number) => {
        t = ((t % 1) + 1) % 1;
        if (t < 1 / 6) return p + (q - p) * 6 * t;
        if (t < 1 / 2) return q;
        if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
        return p;
      };
      px[i] = hue(h + 1 / 3) * 255;
      px[i + 1] = hue(h) * 255;
      px[i + 2] = hue(h - 1 / 3) * 255;
    }
    ctx.putImageData(data, 0, 0);
    return c;
  } catch {
    return null;
  }
}

/**
 * How many geometries are drawn.
 *
 * A million-row geometry table cannot be rendered and should not be attempted.
 * The cap is stated on screen whenever it bites — a map that silently shows a
 * tenth of the data is the failure this whole view exists to avoid.
 */
const GEOMETRY_CAP = 5000;

/**
 * Per-point dot markers are skipped above this many track points (the
 * polyline alone carries the track) — same idea as GEOMETRY_CAP: pans and
 * playback must not jank on a 100k-row result.
 */
const POINT_DOT_CAP = GEOMETRY_CAP;

/**
 * Trace one geometry onto a canvas in Web Mercator screen space.
 *
 * Shared by the static layer (every shape), the per-frame hover highlight
 * (one shape) and geometry-first mode — one tracing implementation, so a
 * polygon reads the same whether it is context under a track or the subject
 * of the map. Fills use even-odd across all of a polygon's rings at once, so
 * holes (a lake in a district) stay holes.
 */
function paintGeometry(
  ctx: CanvasRenderingContext2D, v: Viewport, g: Geometry,
  style: { stroke?: string; fill?: string; width?: number; dotRadius?: number },
): void {
  if (style.stroke) { ctx.strokeStyle = style.stroke; ctx.lineWidth = style.width ?? 1; }
  const ring = (pts: Position[], close: boolean) => {
    ctx.beginPath();
    pts.forEach((p, i) => {
      const s = toScreen(v, p.x, p.y);
      if (i === 0) ctx.moveTo(s.x, s.y); else ctx.lineTo(s.x, s.y);
    });
    if (close) ctx.closePath();
    if (style.stroke) ctx.stroke();
  };
  const polygon = (rings: Position[][]) => {
    ctx.beginPath();
    for (const r of rings) {
      r.forEach((p, i) => {
        const s = toScreen(v, p.x, p.y);
        if (i === 0) ctx.moveTo(s.x, s.y); else ctx.lineTo(s.x, s.y);
      });
      ctx.closePath();
    }
    if (style.fill) { ctx.fillStyle = style.fill; ctx.fill('evenodd'); }
    if (style.stroke) ctx.stroke();
  };
  const draw = (geom: Geometry): void => {
    switch (geom.type) {
      case 'Point':
      case 'MultiPoint': {
        const pts = geom.type === 'Point' ? [geom.coordinates] : geom.coordinates;
        ctx.fillStyle = style.fill ?? style.stroke ?? '#2b6cb0';
        for (const p of pts) {
          const s = toScreen(v, p.x, p.y);
          ctx.beginPath();
          ctx.arc(s.x, s.y, style.dotRadius ?? 3, 0, Math.PI * 2);
          ctx.fill();
        }
        return;
      }
      case 'LineString': ring(geom.coordinates, false); return;
      case 'MultiLineString': geom.coordinates.forEach(l => ring(l, false)); return;
      case 'Polygon': polygon(geom.coordinates); return;
      case 'MultiPolygon': geom.coordinates.forEach(polygon); return;
      case 'GeometryCollection': geom.geometries.forEach(draw); return;
    }
  };
  draw(g);
}

export function MapView({ columns, rows, columnTypes, onSelectRow, initialBbox, engine, sourceSql, onRunDerived }: Props) {
  // `-1` is "none": a timestamp is optional (a track with no time is still a
  // path), the two coordinates are not.
  const [timeCol, setTimeCol] = useState(-1);
  const [latCol, setLatCol] = useState(-1);
  const [lonCol, setLonCol] = useState(-1);
  // Split the result into one track per value of this column (e.g. car_id), so
  // a fleet reads as one coloured path per vehicle rather than one zigzag.
  const [groupCol, setGroupCol] = useState(-1);
  const [geoCol, setGeoCol] = useState(-1);
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<number>(5);
  const [size, setSize] = useState({ w: 640, h: 420 });

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);

  const facts = useMemo(() => columnFacts(columns, rows), [columns, rows]);

  /**
   * Columns that decode as geometry.
   *
   * Unlike the coordinate columns, this one *is* detected rather than picked —
   * because it is not a guess: a cell either decodes as valid geometry or it
   * does not. Three wire forms decode (utils/geoDetect): WKB/EWKB hex strings
   * (PostGIS, MySQL, GeoParquet), GeoJSON objects and JSON strings (MongoDB),
   * and ClickHouse Point/Ring/Polygon arrays — the last gated on the column's
   * declared type, because a bare `[x, y]` array proves nothing. The user
   * still chooses which of them to draw.
   */
  const geoColumns = useMemo(() => detectGeoColumns(
    columns.map((name, i) => ({ name, typeName: columnTypes?.[i] })),
    rows,
  ), [columns, columnTypes, rows]);

  // Auto-pick columns by name so a coordinate table draws on open instead of a
  // blank canvas that reads as "no map". Adjusted during render (React's
  // endorsed pattern) whenever the result's columns change; only unambiguous
  // names are taken, and every choice stays overridable in the pickers above.
  // (This replaces the earlier "nothing is auto-detected" stance: requiring a
  // manual pick first made the whole view look broken on a plain lat/lon table.)
  //
  // Geometry-first: a result with a geometry column but no recognizable
  // latitude/longitude pair opens directly on the shapes — a spatial table IS
  // the map, not a context layer under a track that does not exist.
  const colSig = JSON.stringify(columns);
  const [autoSig, setAutoSig] = useState('');
  if (autoSig !== colSig) {
    setAutoSig(colSig);
    const byName = (re: RegExp) => facts.find(f => re.test(f.name.trim().toLowerCase()))?.index ?? -1;
    const lat = byName(/^(lat|latitude|lat_deg)$/);
    const lon = byName(/^(lon|lng|long|longitude|lon_deg)$/);
    setLatCol(lat);
    setLonCol(lon);
    setGeoCol(lat < 0 || lon < 0 ? (geoColumns[0]?.index ?? -1) : -1);
    setTimeCol(facts.find(f =>
      f.timeLike >= Math.max(1, f.sampled * 0.6)
      && /(_at$|_ts$|time|date|timestamp|captured|recorded)/.test(f.name.trim().toLowerCase()))?.index ?? -1);
    setGroupCol(facts.find(f => {
      const n = f.name.trim().toLowerCase();
      return n.endsWith('id') && n !== 'id' && /car|vehicle|device|driver|trip|track|unit|asset|taxi|ride/.test(n);
    })?.index ?? -1);
  }

  /** The decoded geometries of the chosen column, each with its row index so a
   *  click or hover on a shape can find the row in the grid. Capped so a large
   *  result cannot lock the canvas. The cap is stated, never silent. */
  const geometries = useMemo(() => {
    if (geoCol < 0) return { shapes: [] as { g: Geometry; row: number }[], shown: 0, total: 0 };
    const typeName = columnTypes?.[geoCol];
    const out: { g: Geometry; row: number }[] = [];
    let total = 0;
    rows.forEach((r, row) => {
      const g = cellGeometry(r[geoCol], typeName);
      if (!g) return;
      total += 1;
      if (out.length < GEOMETRY_CAP) out.push({ g, row });
    });
    return { shapes: out, shown: out.length, total };
  }, [rows, geoCol, columnTypes]);

  /** Geometry only joins the viewport when it is actually longitude/latitude —
   *  projected metres drawn as degrees would put Prague off the coast of
   *  Africa and take the whole view with it. */
  const geoDrawable = useMemo(() => {
    if (geometries.shapes.length === 0) return false;
    const box = geomBbox(geometries.shapes.map(s => s.g));
    return isLonLat(geometries.shapes[0].g.srid, box);
  }, [geometries]);

  /**
   * The escape hatch for the refusal below, PostgreSQL only: a derived query
   * that wraps the CURRENT query text and transforms just the detected
   * geometry column to WGS 84 (utils/geoTransform). Explicitly a user action —
   * the user's SQL is never silently rewritten; the derived query opens as a
   * new tab where it can be read, and it is labelled in the log as derived.
   * A geography column never reaches this path (PostGIS stores it lon/lat).
   */
  const transform = useMemo(() => {
    if (geoDrawable || geometries.total === 0 || geoCol < 0) return null;
    if (engine !== 'postgres' || !sourceSql || !onRunDerived) return null;
    return buildTransformQuery(sourceSql, columns, columns[geoCol]);
  }, [geoDrawable, geometries.total, geoCol, engine, sourceSql, onRunDerived, columns]);

  /** Geometry-first mode: the shapes are the subject, not context under a
   *  track. On when a geometry column is drawn and no lat/lon pair is picked. */
  const geometryFirst = geoCol >= 0 && geoDrawable && (latCol < 0 || lonCol < 0);

  const track: Track | null = useMemo(() => {
    if (latCol < 0 || lonCol < 0) return null;
    return buildTrack(rows, {
      timeIndex: timeCol < 0 ? null : timeCol, latIndex: latCol, lonIndex: lonCol,
      groupIndex: groupCol < 0 ? null : groupCol,
    });
  }, [rows, timeCol, latCol, lonCol, groupCol]);
  const grouped = (track?.groups.length ?? 0) > 1;

  // "Watch one car": focus a single group (click its legend swatch). When set,
  // playback, the scrubber, the readout and the drawing all narrow to that
  // car's pings — the in-app equivalent of a WHERE car_id = N.
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const focusGroup = focusKey != null ? (track?.groups.find(g => g.key === focusKey) ?? null) : null;

  // Memoised because it is a dependency of the playback effect and the step
  // callback: a fresh `[]` on every render would restart the interval.
  const points = useMemo(
    () => (focusGroup ? focusGroup.points : (track?.points ?? [])),
    [track, focusGroup]);
  const current = points[Math.min(index, points.length - 1)];

  // Keep the marker inside the track when the columns change under it; a new
  // grouping invalidates any focused car.
  useEffect(() => { setIndex(0); setPlaying(false); setFocusKey(null); }, [timeCol, latCol, lonCol, groupCol]);
  useEffect(() => { setIndex(0); setPlaying(false); }, [focusKey]);

  // ── size ──
  useEffect(() => {
    const el = boxRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      setSize({ w: Math.max(120, el.clientWidth), h: Math.max(120, el.clientHeight) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Bounds over everything drawn, so a track and its geometry share one view.
  // When one car is being watched, fit to just its ride so it fills the map.
  const boundsForFit = useMemo(() => {
    let b: { minLat: number; maxLat: number; minLon: number; maxLon: number } | null =
      focusGroup
        ? focusGroup.points.reduce(
          (acc, p) => ({
            minLat: Math.min(acc.minLat, p.lat), maxLat: Math.max(acc.maxLat, p.lat),
            minLon: Math.min(acc.minLon, p.lon), maxLon: Math.max(acc.maxLon, p.lon),
          }),
          { minLat: 90, maxLat: -90, minLon: 180, maxLon: -180 })
        : (track?.bounds ?? null);
    if (geoDrawable) {
      // The GeoParquet footer hint, when present, is the FILE's whole extent —
      // the decoded rows are one page of it, so the hint wins the first fit.
      // (Pan/zoom lives in manualView and is untouched by this; the Fit button
      // returns here, to the full-file extent — which is the honest fit.)
      const hint = wireBboxToBounds(initialBbox);
      const gb = hint ?? (() => {
        const dec = geomBbox(geometries.shapes.map(s => s.g));
        return dec
          ? { minLat: dec.minY, maxLat: dec.maxY, minLon: dec.minX, maxLon: dec.maxX }
          : null;
      })();
      if (gb) {
        b = b
          ? {
            minLat: Math.min(b.minLat, gb.minLat), maxLat: Math.max(b.maxLat, gb.maxLat),
            minLon: Math.min(b.minLon, gb.minLon), maxLon: Math.max(b.maxLon, gb.maxLon),
          }
          : gb;
      }
    }
    return b;
  }, [track, focusGroup, geoDrawable, geometries, initialBbox]);

  const fitView = useMemo(
    () => (boundsForFit ? fitViewport(boundsForFit, size.w, size.h) : null),
    [boundsForFit, size]);

  // Pan/zoom overrides the auto-fit until Fit is pressed or the data changes.
  const [manualView, setManualView] = useState<Viewport | null>(null);
  // Viewport commits are rAF-coalesced (the FastGrid scroll handler's
  // pattern): raw mousemoves and wheel ticks arrive faster than frames, and
  // every commit repaints the whole static layer — basemap, up to 5000
  // geometries, track, graticule. One commit per frame, holding the LATEST
  // viewport, keeps the two-layer architecture but spends it once per frame.
  const viewRafRef = useRef(0);
  const pendingViewRef = useRef<Viewport | null>(null);
  const commitView = useCallback((v: Viewport) => {
    pendingViewRef.current = v;
    if (viewRafRef.current) return;
    viewRafRef.current = requestAnimationFrame(() => {
      viewRafRef.current = 0;
      const pending = pendingViewRef.current;
      pendingViewRef.current = null;
      if (pending) setManualView(pending);
    });
  }, []);
  /** Back to auto-fit — drops any coalesced commit still waiting for a frame. */
  const resetView = useCallback(() => {
    if (viewRafRef.current) { cancelAnimationFrame(viewRafRef.current); viewRafRef.current = 0; }
    pendingViewRef.current = null;
    setManualView(null);
  }, []);
  useEffect(() => () => cancelAnimationFrame(viewRafRef.current), []);
  const boundsSig = boundsForFit
    ? `${boundsForFit.minLat},${boundsForFit.maxLat},${boundsForFit.minLon},${boundsForFit.maxLon}` : '';
  const [fitSig, setFitSig] = useState('');
  if (fitSig !== boundsSig) { setFitSig(boundsSig); if (manualView) resetView(); }

  const viewport = manualView ?? fitView;
  const viewportRef = useRef(viewport);
  viewportRef.current = viewport;

  // Tile-free by default: the header's privacy contract. Tile basemaps are a
  // per-user opt-in behind a one-time disclosure dialog (see pickBasemap).
  const [basemap, setBasemap] = useState<BaseMapId>('none');
  const [tilesAck, setTilesAck] = usePreference(PREFS.mapTilesAck);
  const [tileOpacity, setTileOpacity] = useState(0.85);   // dim the map so data pops
  const showTiles = basemap !== 'none';
  const base = BASEMAPS[basemap];

  // The bundled Natural Earth coastline — the offline basemap. null while
  // loading or when the asset is absent (the graticule-only map of old is the
  // graceful fallback, not an error).
  const [land, setLand] = useState<BasemapPolygon[] | null>(null);
  useEffect(() => {
    let alive = true;
    void loadBasemap().then(polys => { if (alive && polys) setLand(polys); });
    return () => { alive = false; };
  }, []);

  // Geometry-first interaction state: which shape is under the cursor, and
  // which was clicked (its row selected in the grid). Refs feed the canvas
  // frame so hover never re-allocates composeFrame; state feeds the tooltip.
  const [hoverRow, setHoverRow] = useState<number | null>(null);
  const [hoverPos, setHoverPos] = useState<{ x: number; y: number } | null>(null);
  const [selectedRow, setSelectedRow] = useState<number | null>(null);
  const hoverRowRef = useRef<number | null>(null);
  hoverRowRef.current = hoverRow;
  const selectedRowRef = useRef<number | null>(null);
  selectedRowRef.current = selectedRow;

  /** Switch basemaps; the first-ever switch to an online basemap discloses
   *  the egress (naming the host) and requires an explicit confirm, persisted
   *  via PREFS.mapTilesAck so the question is asked once, not per tab. */
  const pickBasemap = useCallback(async (id: BaseMapId) => {
    const url = BASEMAPS[id].url;
    if (url && !tilesAck) {
      const host = new URL(url(1, 0, 0)).host;
      const ok = await confirmDialog(
        `Tiles are fetched from ${host} — your viewport coordinates leave this machine, tile by tile.\n\nEnable online basemaps?`,
        { danger: true },
      );
      if (!ok) return;
      setTilesAck(true);
    }
    setBasemap(id);
  }, [tilesAck, setTilesAck]);

  const tileCache = useRef<Map<string, HTMLImageElement | HTMLCanvasElement>>(new Map());
  const [tileTick, setTileTick] = useState(0);
  // Decoded 256px tiles are big; unbounded caching across a long pan/zoom
  // session costs hundreds of MB. LRU via Map insertion order: re-insert on
  // hit, evict from the front past the cap.
  const TILE_CACHE_CAP = 300;
  // Tiles of a basemap the user switched away from are dead weight — drop them.
  useEffect(() => {
    const cache = tileCache.current;
    for (const key of [...cache.keys()]) {
      if (!key.startsWith(`${basemap}/`)) cache.delete(key);
    }
  }, [basemap]);
  const getTile = useCallback((z: number, x: number, y: number): HTMLImageElement | HTMLCanvasElement | null => {
    const src = BASEMAPS[basemap].url;
    if (!src) return null;
    const key = `${basemap}/${z}/${x}/${y}`;
    const cache = tileCache.current;
    const have = cache.get(key);
    if (have) {
      cache.delete(key); cache.set(key, have);   // refresh LRU position
      if (have instanceof HTMLCanvasElement) return have;
      return have.complete && have.naturalWidth > 0 ? have : null;
    }
    const img = new Image();
    // CORS-clean loads so an inverted (Dark) tile can be pixel-processed
    // without tainting the canvas. Both tile hosts send ACAO:*.
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      if (BASEMAPS[basemap].invert) {
        const inv = invertTile(img);
        if (inv) cache.set(key, inv);
      }
      setTileTick(t => t + 1);
    };
    img.onerror = () => {};
    img.src = src(z, x, y);
    cache.set(key, img);
    while (cache.size > TILE_CACHE_CAP) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
    return null;
  }, [basemap]);

  // ── playback ──
  useEffect(() => {
    if (!playing || points.length === 0) return;
    const id = window.setInterval(() => {
      setIndex(i => {
        if (i >= points.length - 1) { setPlaying(false); return i; }
        return i + 1;
      });
    }, Math.max(16, 200 / speed));
    return () => window.clearInterval(id);
  }, [playing, speed, points.length]);

  const move = useCallback((delta: number) => {
    setPlaying(false);
    setIndex(i => {
      const next = stepIndex(points, i, delta);
      if (next >= 0 && points[next]) onSelectRow?.(points[next].row);
      return next;
    });
  }, [points, onSelectRow]);

  // ── drawing ──
  //
  // Two layers so playback stays cheap: everything that does not move per
  // frame — background, tiles, graticule, geometry, the full track polylines,
  // the per-point dots, scale bar, attribution — renders once per
  // data/viewport change into an offscreen static layer; each playback frame
  // blits it and draws only the progress path (kept incrementally on a second
  // offscreen layer) and the moving marker(s).
  const staticLayer = useRef<HTMLCanvasElement | null>(null);
  const progressLayer = useRef<HTMLCanvasElement | null>(null);
  const progressUpTo = useRef(-1);          // last point index on progressLayer
  const indexRef = useRef(index); indexRef.current = index;
  const currentRef = useRef(current); currentRef.current = current;

  /** Blit the static layer to the visible canvas, then draw the per-frame
   *  bits: the accent progress path (incremental) and the moving marker(s).
   *  Reads index/current through refs so its identity — and therefore the
   *  static layer — does not churn on every playback frame. */
  const composeFrame = useCallback(() => {
    const canvas = canvasRef.current;
    const layer = staticLayer.current;
    if (!canvas || !layer) return;
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== layer.width || canvas.height !== layer.height) {
      canvas.width = layer.width;
      canvas.height = layer.height;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(layer, 0, 0);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (!viewport) return;

    // Geometry-first: the hovered and grid-selected shapes are re-painted in
    // accent on top of the blitted static layer — one shape per frame, so a
    // hover never repaints the world.
    if (geometryFirst) {
      const hot: number[] = [];
      if (selectedRowRef.current !== null) hot.push(selectedRowRef.current);
      if (hoverRowRef.current !== null && hoverRowRef.current !== selectedRowRef.current) {
        hot.push(hoverRowRef.current);
      }
      for (const row of hot) {
        const shape = geometries.shapes.find(s => s.row === row);
        if (!shape) continue;
        ctx.globalAlpha = row === selectedRowRef.current ? 0.95 : 0.8;
        paintGeometry(ctx, viewport, shape.g, {
          stroke: '#7aa7e8', width: 2, dotRadius: 4.5,
          fill: row === selectedRowRef.current
            ? 'rgba(122,167,232,0.32)' : 'rgba(122,167,232,0.20)',
        });
        ctx.globalAlpha = 1;
      }
    }

    const mapDark = showTiles ? base.dark : true;
    const ink = mapDark ? '#e8e8ec' : '#1c1c22';
    const accent = '#2b6cb0';
    const drawGroups = focusGroup ? [focusGroup] : (track?.groups ?? []);
    const cur = currentRef.current;
    const idx = indexRef.current;

    if (drawGroups.length > 1) {
      // One marker per car at the shared time cursor; the coloured polylines
      // live on the static layer.
      const cursorT = cur ? cur.t : (points.length ? points[points.length - 1].t : 0);
      drawGroups.forEach((g, gi) => {
        const color = TRACK_COLORS[gi % TRACK_COLORS.length];
        const mi = timeCol >= 0 ? indexAtTime(g.points, cursorT)
          : Math.min(idx, g.points.length - 1);
        const mp = g.points[mi];
        if (mp) {
          const s = toScreen(viewport, mp.lon, mp.lat);
          ctx.fillStyle = color;
          ctx.beginPath(); ctx.arc(s.x, s.y, 5, 0, Math.PI * 2); ctx.fill();
          ctx.strokeStyle = ink;
          ctx.lineWidth = 1.5;
          ctx.beginPath(); ctx.arc(s.x, s.y, 7.5, 0, Math.PI * 2); ctx.stroke();
        }
      });
      return;
    }

    // Single track: the accent "path so far", drawn incrementally — a frame
    // during playback appends only the new segment(s); a backwards scrub
    // clears the layer and redraws once.
    const prog = progressLayer.current ?? (progressLayer.current = document.createElement('canvas'));
    if (prog.width !== layer.width || prog.height !== layer.height) {
      prog.width = layer.width;
      prog.height = layer.height;
      progressUpTo.current = -1;
    }
    const pctx = prog.getContext('2d');
    if (pctx) {
      if (progressUpTo.current < 0 || idx < progressUpTo.current) {
        pctx.setTransform(1, 0, 0, 1, 0, 0);
        pctx.clearRect(0, 0, prog.width, prog.height);
        progressUpTo.current = 0;
      }
      const from = progressUpTo.current;
      const to = Math.min(idx, points.length - 1);
      if (to > from && points[from]) {
        pctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        pctx.strokeStyle = accent;
        pctx.lineWidth = 1.5;
        pctx.beginPath();
        const s0 = toScreen(viewport, points[from].lon, points[from].lat);
        pctx.moveTo(s0.x, s0.y);
        for (let i = from + 1; i <= to; i++) {
          const s = toScreen(viewport, points[i].lon, points[i].lat);
          pctx.lineTo(s.x, s.y);
        }
        pctx.stroke();
        progressUpTo.current = to;
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(prog, 0, 0);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    if (cur) {
      const s = toScreen(viewport, cur.lon, cur.lat);
      ctx.fillStyle = accent;
      ctx.beginPath(); ctx.arc(s.x, s.y, 6, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = ink;
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(s.x, s.y, 9, 0, Math.PI * 2); ctx.stroke();
    }
  }, [viewport, points, track, timeCol, focusGroup, showTiles, base, geometryFirst, geometries]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const layer = staticLayer.current ?? (staticLayer.current = document.createElement('canvas'));
    layer.width = size.w * dpr;
    layer.height = size.h * dpr;
    const ctx = layer.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const css = getComputedStyle(canvas);
    // Drawing colours are chosen against the BASEMAP, not the app theme — the
    // track has to read over whichever map the user picked, light or dark.
    const mapDark = showTiles ? base.dark : true;   // the offline map sits on the app's dark panel
    const ink = mapDark ? '#e8e8ec' : '#1c1c22';
    const faint = mapDark ? 'rgba(255,255,255,0.28)' : 'rgba(0,0,0,0.22)';
    const accent = '#2b6cb0';                         // muted blue, not neon
    const muted = mapDark ? 'rgba(255,255,255,0.6)' : 'rgba(0,0,0,0.55)';

    ctx.clearRect(0, 0, size.w, size.h);
    // A neutral surface under the tiles so loading gaps match the basemap.
    ctx.fillStyle = showTiles ? (base.dark ? '#181a1c' : '#e9eaec')
      : (css.getPropertyValue('--bg2').trim() || '#20232b');
    ctx.globalAlpha = showTiles ? 1 : 0.6;
    ctx.fillRect(0, 0, size.w, size.h);
    ctx.globalAlpha = 1;

    // ── Offline basemap ──
    // The bundled Natural Earth landmasses, drawn under everything else. This
    // is the default map: real geography with zero network. Online tiles
    // (opt-in) replace it rather than stack on it.
    if (!showTiles && land && viewport) {
      ctx.fillStyle = mapDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.08)';
      ctx.strokeStyle = faint;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (const poly of land) {
        for (const ringPts of poly.rings) {
          ringPts.forEach(([lon, lat], i) => {
            const s = toScreen(viewport, lon, lat);
            if (i === 0) ctx.moveTo(s.x, s.y); else ctx.lineTo(s.x, s.y);
          });
          ctx.closePath();
        }
      }
      ctx.fill('evenodd');
      ctx.globalAlpha = 0.55;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    if (!viewport) {
      ctx.fillStyle = muted;
      ctx.font = '12px -apple-system, sans-serif';
      ctx.fillText(geoColumns.length > 0
        ? 'Pick a geometry column, or a latitude and a longitude, above.'
        : 'Pick a latitude and a longitude column above.', 16, 24);
      progressUpTo.current = -1;
      composeFrame();
      return;
    }

    // ── Basemap ──
    // Real streets under the track, dragged and zoomed, dimmed to `tileOpacity`
    // so the data pops. A still-loading tile leaves the neutral surface showing.
    if (showTiles) {
      ctx.globalAlpha = tileOpacity;
      for (const t of tilesInView(viewport, size.w, size.h)) {
        const img = getTile(t.z, t.x, t.y);
        if (img) {
          try { ctx.drawImage(img, t.sx, t.sy, t.size + 0.5, t.size + 0.5); } catch { /* not decodable yet */ }
        }
      }
      ctx.globalAlpha = 1;
    }

    // Graticule: whole degrees while they are far enough apart, then tenths.
    // A map with no reference lines gives no sense of scale at all, and this
    // is the reference that needs no network.
    const grid = showTiles ? null : (track?.bounds ?? (() => {
      const gb = geomBbox(geometries.shapes.map(s => s.g));
      return gb ? { minLat: gb.minY, maxLat: gb.maxY, minLon: gb.minX, maxLon: gb.maxX } : null;
    })());
    if (grid) {
      // Labelled graticule: parallels and meridians drawn edge to edge with
      // their degree value, so the grid reads as a coordinate frame instead of
      // a few faint lines. Mercator maps lon→x and lat→y independently, so a
      // parallel is a horizontal line and a meridian a vertical one.
      const stepDeg = pickGraticule(grid);
      const dec = stepDeg >= 1 ? 0 : stepDeg >= 0.1 ? 1 : stepDeg >= 0.01 ? 2 : 3;
      ctx.lineWidth = 1;
      ctx.font = '10px -apple-system, sans-serif';
      for (let lat = Math.ceil(grid.minLat / stepDeg) * stepDeg; lat <= grid.maxLat; lat += stepDeg) {
        const y = toScreen(viewport, grid.minLon, lat).y;
        ctx.strokeStyle = faint; ctx.globalAlpha = 0.6;
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(size.w, y); ctx.stroke();
        ctx.globalAlpha = 0.85; ctx.fillStyle = muted;
        ctx.fillText(`${lat.toFixed(dec)}°`, 3, y - 2);
      }
      for (let lon = Math.ceil(grid.minLon / stepDeg) * stepDeg; lon <= grid.maxLon; lon += stepDeg) {
        const x = toScreen(viewport, lon, grid.minLat).x;
        ctx.strokeStyle = faint; ctx.globalAlpha = 0.6;
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, size.h); ctx.stroke();
        ctx.globalAlpha = 0.85; ctx.fillStyle = muted;
        ctx.fillText(`${lon.toFixed(dec)}°`, x + 2, size.h - 20);
      }
    }
    ctx.globalAlpha = 1;

    // Geometry. In track mode it is context underneath — a district, a route,
    // a service area — and the track is the thing being read. In
    // geometry-first mode the shapes ARE the subject: filled, brighter, and
    // the hover/click layer (composeFrame) accentuates individual ones.
    if (geoDrawable) {
      if (geometryFirst) {
        for (const s of geometries.shapes) {
          paintGeometry(ctx, viewport, s.g,
            { stroke: accent, fill: 'rgba(43,108,176,0.16)', width: 1.5 });
        }
      } else {
        ctx.globalAlpha = 0.55;
        for (const s of geometries.shapes) {
          paintGeometry(ctx, viewport, s.g, { stroke: accent, width: 1 });
        }
        ctx.globalAlpha = 1;
      }
    }

    const drawGroups = focusGroup ? [focusGroup] : (track?.groups ?? []);
    if (drawGroups.length > 1) {
      // A fleet: one coloured polyline per car. The per-car markers move with
      // the time cursor, so they are drawn per frame in composeFrame.
      drawGroups.forEach((g, gi) => {
        const color = TRACK_COLORS[gi % TRACK_COLORS.length];
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.75;
        ctx.globalAlpha = 0.9;
        ctx.beginPath();
        g.points.forEach((p, i) => {
          const s = toScreen(viewport, p.lon, p.lat);
          if (i === 0) ctx.moveTo(s.x, s.y); else ctx.lineTo(s.x, s.y);
        });
        ctx.stroke();
      });
      ctx.globalAlpha = 1;
    } else {
      // Single track: the full path, faint. The accent "path so far" and the
      // current marker move per frame — composeFrame draws those.
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = faint;
      ctx.beginPath();
      points.forEach((p, i) => {
        const s = toScreen(viewport, p.lon, p.lat);
        if (i === 0) ctx.moveTo(s.x, s.y); else ctx.lineTo(s.x, s.y);
      });
      ctx.stroke();

      // Every point, small — capped like GEOMETRY_CAP: past the cap the
      // polyline alone carries the track, or a 100k-row result janks the UI.
      if (points.length <= POINT_DOT_CAP) {
        ctx.fillStyle = ink;
        ctx.globalAlpha = 0.55;
        for (const p of points) {
          const s = toScreen(viewport, p.lon, p.lat);
          ctx.beginPath(); ctx.arc(s.x, s.y, 2, 0, Math.PI * 2); ctx.fill();
        }
        ctx.globalAlpha = 1;
      }
    }

    // Scale bar: without one, a canvas with no basemap says nothing about size.
    drawScaleBar(ctx, viewport, size, ink);

    // Tile providers require attribution whenever their tiles are shown.
    if (showTiles && base.attr) {
      ctx.font = '10px -apple-system, sans-serif';
      const w = ctx.measureText(base.attr).width;
      ctx.fillStyle = 'rgba(255,255,255,0.72)';
      ctx.fillRect(size.w - w - 10, size.h - 15, w + 8, 13);
      ctx.fillStyle = '#333';
      ctx.fillText(base.attr, size.w - w - 6, size.h - 5);
    }
    // The world under the track changed — the progress layer is stale.
    progressUpTo.current = -1;
    composeFrame();
  }, [viewport, points, size, track, timeCol, focusGroup, geoDrawable, geometries,
    geometryFirst, land, geoColumns.length, showTiles, base, tileOpacity, tileTick, getTile, composeFrame]);

  // Playback / scrub frames: blit the static layer and move the marker(s).
  // Hover/selection in geometry-first mode rides the same frame path.
  useEffect(() => { composeFrame(); }, [index, current, hoverRow, selectedRow, composeFrame]);

  // ── interaction: drag to pan, wheel to zoom, click to select a point ──
  const drag = useRef<{ sx: number; sy: number; ox: number; oy: number; moved: boolean } | null>(null);

  const onMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!viewport) return;
    drag.current = { sx: e.clientX, sy: e.clientY, ox: viewport.offsetX, oy: viewport.offsetY, moved: false };
  };
  const onMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const d = drag.current;
    if (d && viewport) {
      const dx = e.clientX - d.sx, dy = e.clientY - d.sy;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) d.moved = true;
      // Absolute from the drag start, so it never drifts as the view re-renders.
      commitView({ scale: viewport.scale, offsetX: d.ox + dx, offsetY: d.oy + dy });
      return;
    }
    // Geometry-first hover: which shape is under the cursor. Bbox-gated
    // (utils/geoHit), so even the 5000-shape cap costs a few cheap rejects per
    // mousemove; the highlight itself rides the per-frame canvas layer.
    if (!geometryFirst || !viewport) return;
    const r = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - r.left, py = e.clientY - r.top;
    let hit: number | null = null;
    // Reverse order: shapes drawn later sit on top, so they answer first.
    for (let i = geometries.shapes.length - 1; i >= 0; i--) {
      if (hitTestGeometry(geometries.shapes[i].g, viewport, px, py)) {
        hit = geometries.shapes[i].row;
        break;
      }
    }
    if (hit !== hoverRowRef.current) setHoverRow(hit);
    if (hit !== null) setHoverPos({ x: px, y: py });
  };
  const onMouseUp = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const d = drag.current;
    drag.current = null;
    // A real drag pans; only a click (no movement) selects the point under it.
    if (!d || d.moved || !viewport) return;
    const r = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - r.left, py = e.clientY - r.top;
    // Geometry-first: a click selects the shape's row in the grid — the same
    // two-way link a track point has.
    if (geometryFirst) {
      for (let i = geometries.shapes.length - 1; i >= 0; i--) {
        if (hitTestGeometry(geometries.shapes[i].g, viewport, px, py)) {
          const row = geometries.shapes[i].row;
          setSelectedRow(row);
          onSelectRow?.(row);
          return;
        }
      }
      setSelectedRow(null);
      return;
    }
    const hit = hitTest(points, viewport, px, py);
    if (hit !== null) {
      setPlaying(false);
      setIndex(hit);
      onSelectRow?.(points[hit].row);
    }
  };

  // Wheel-zoom via a non-passive native listener (React's onWheel is passive,
  // so it cannot preventDefault the page scroll). Reads the live viewport ref.
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const v = viewportRef.current;
      if (!v) return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
      commitView(zoomViewport(v, factor, e.clientX - r.left, e.clientY - r.top));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [commitView]);

  const zoomBy = (factor: number) => {
    const v = viewportRef.current;
    if (v) commitView(zoomViewport(v, factor, size.w / 2, size.h / 2));
  };

  // The map is already drawn to a <canvas> at device resolution, so a PNG is
  // just what is on screen — no re-serialisation needed, unlike the SVG surfaces.
  const exportPng = () => {
    canvasRef.current?.toBlob(b => { if (b) downloadBlob(b, 'map.png'); }, 'image/png');
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowRight') { move(e.shiftKey ? 10 : 1); e.preventDefault(); }
    else if (e.key === 'ArrowLeft') { move(e.shiftKey ? -10 : -1); e.preventDefault(); }
    else if (e.key === 'Home') { move(-points.length); e.preventDefault(); }
    else if (e.key === 'End') { move(points.length); e.preventDefault(); }
    else if (e.key === ' ') { setPlaying(p => !p); e.preventDefault(); }
  };

  const picker = (
    label: string, value: number, set: (v: number) => void, optional: boolean,
    noneLabel?: string,
  ) => (
    <label className="map-pick">
      <span>{label}</span>
      <select value={value} onChange={e => set(Number(e.target.value))}>
        <option value={-1}>{noneLabel ?? (optional ? '— none (row order) —' : '— choose —')}</option>
        {facts.map(f => (
          <option key={f.index} value={f.index}>{f.name} — {factsLabel(f)}</option>
        ))}
      </select>
    </label>
  );

  const span = points.length > 1 && timeCol >= 0
    ? fmtDuration(points[points.length - 1].t - points[0].t)
    : null;

  return (
    <div className="map-root" tabIndex={0} onKeyDown={onKey}>
      <div className="map-bar">
        {picker('Timestamp', timeCol, setTimeCol, true)}
        {picker('Latitude', latCol, setLatCol, false)}
        {picker('Longitude', lonCol, setLonCol, false)}
        <button
          className="toolbar-btn"
          data-tip="Swap the two coordinate columns — the commonest mistake, and one click to undo"
          onClick={() => { const a = latCol; setLatCol(lonCol); setLonCol(a); }}
        >⇄ Swap</button>
        {picker('Colour by', groupCol, setGroupCol, true, '— none (one track) —')}
        {/* Offered only when a column actually decodes as geometry — unlike
            the coordinates, that is a fact rather than a guess. */}
        {geoColumns.length > 0 && (
          <label className="map-pick">
            <span>Geometry</span>
            <select value={geoCol} onChange={e => setGeoCol(Number(e.target.value))}>
              <option value={-1}>— none —</option>
              {geoColumns.map(c => (
                <option key={c.index} value={c.index}>{c.name}</option>
              ))}
            </select>
          </label>
        )}
        <div style={{ flex: 1 }} />
        <label className="map-pick" data-tip="Basemap — free, no API key. Light/Dark are muted so the data reads clearly.">
          <span>Base</span>
          <select value={basemap} onChange={e => void pickBasemap(e.target.value as BaseMapId)}>
            {(Object.keys(BASEMAPS) as BaseMapId[]).map(id =>
              <option key={id} value={id}>{BASEMAPS[id].label}</option>)}
          </select>
        </label>
        {showTiles && (
          <label className="map-pick" data-tip="Basemap brightness — dim it so the data stands out, or fade it away.">
            <span>Dim</span>
            <input type="range" min={0} max={1} step={0.05} value={tileOpacity}
              style={{ width: 70 }}
              onChange={e => setTileOpacity(Number(e.target.value))} />
          </label>
        )}
        <button className="toolbar-btn" data-tip="Zoom in (or scroll)" onClick={() => zoomBy(1.3)}>＋</button>
        <button className="toolbar-btn" data-tip="Zoom out (or scroll)" onClick={() => zoomBy(1 / 1.3)}>－</button>
        <button className="toolbar-btn" data-tip="Fit the data to the view"
          onClick={resetView}>⤢ Fit</button>
        <button className="toolbar-btn" data-tip="Download the map as a PNG"
          onClick={exportPng}>PNG</button>
      </div>

      {geoCol >= 0 && (
        <div className="map-status">
          <span>{geometries.total.toLocaleString()} geometries</span>
          {geometryFirst && (
            <span>· hover a shape for its row, click to select it in the grid</span>
          )}
          {geometries.shown < geometries.total && (
            <span className="map-warn">
              · showing the first {geometries.shown.toLocaleString()} — the rest are not drawn
            </span>
          )}
          {!geoDrawable && geometries.total > 0 && (
            <span className="map-warn">
              · not longitude/latitude (SRID {geometries.shapes[0]?.g.srid ?? 'none'}) — not drawn,
              because projected coordinates plotted as degrees would put this somewhere it is not
              {transform?.ok && (
                <button
                  className="toolbar-btn"
                  data-tip={`View transformed to WGS 84 — runs a derived query in a new tab: the current query wrapped as a subselect, ${columns[geoCol]} replaced by ST_AsEWKB(ST_Transform(${columns[geoCol]}, 4326)). Your SQL is not changed.`}
                  onClick={() => { if (transform.ok) onRunDerived?.(transform.sql, 'WGS 84'); }}
                >🌐 View in WGS 84</button>
              )}
              {transform && !transform.ok && <span> · {transform.reason}</span>}
            </span>
          )}
        </div>
      )}

      {track && (
        <div className="map-status">
          <span>{points.length.toLocaleString()} points</span>
          {span && <span>· {span} span</span>}
          {/* Sum each car's own path — never the jumps between interleaved
              cars, which is how a fleet reads as thousands of phantom km. */}
          {points.length > 1 && (
            <span>· {((focusGroup ? trackLength(focusGroup.points)
              : track.groups.reduce((s, g) => s + trackLength(g.points), 0)) / 1000).toFixed(1)} km</span>
          )}
          {track.reordered && <span className="map-warn">· re-sorted by time</span>}
          {(track.skipped.noCoords + track.skipped.noTime + track.skipped.outOfRange) > 0 && (
            <span className="map-warn">
              · skipped {track.skipped.noCoords + track.skipped.noTime + track.skipped.outOfRange}
              {' '}({track.skipped.noCoords} without coordinates, {track.skipped.noTime} without a time,
              {' '}{track.skipped.outOfRange} out of range)
            </span>
          )}
        </div>
      )}

      {grouped && track && (
        <div className="map-legend">
          <span className="map-legend-label">
            {focusKey != null
              ? <>watching {columns[groupCol]} = <b>{focusKey}</b></>
              : <>{track.groups.length.toLocaleString()} tracks by {columns[groupCol]} — click one to watch it:</>}
          </span>
          {track.groups.slice(0, TRACK_COLORS.length).map((g, gi) => (
            <button key={g.key}
              className={`map-legend-item ${focusKey === g.key ? 'active' : ''}`}
              data-tip={focusKey === g.key ? 'Click to show all cars again' : `Watch only ${g.key}`}
              onClick={() => setFocusKey(k => (k === g.key ? null : g.key))}>
              <span className="map-legend-swatch"
                style={{ background: TRACK_COLORS[gi % TRACK_COLORS.length] }} />
              {g.key || '(blank)'}
            </button>
          ))}
          {track.groups.length > TRACK_COLORS.length && (
            <span className="map-legend-more">
              +{(track.groups.length - TRACK_COLORS.length).toLocaleString()} more (colours reused)
            </span>
          )}
          {focusKey != null && (
            <button className="toolbar-btn" onClick={() => setFocusKey(null)}>× show all</button>
          )}
        </div>
      )}

      <div className="map-canvas-box" ref={boxRef}>
        <canvas
          ref={canvasRef}
          style={{
            width: size.w, height: size.h,
            cursor: drag.current ? 'grabbing'
              : geometryFirst && hoverRow !== null ? 'pointer' : 'grab',
          }}
          onMouseDown={onMouseDown}
          onMouseMove={onMouseMove}
          onMouseUp={onMouseUp}
          onMouseLeave={() => { drag.current = null; setHoverRow(null); }}
        />
        {/* Geometry-first hover card: the shape's row, minus the geometry
            itself (its hex wall is what the badge and this map replace). */}
        {geometryFirst && hoverRow !== null && hoverPos && rows[hoverRow] && (
          <div
            className="map-geo-tip"
            style={{
              left: Math.min(hoverPos.x + 14, Math.max(0, size.w - 240)),
              top: Math.min(hoverPos.y + 14, Math.max(0, size.h - 120)),
            }}
          >
            <div className="map-geo-tip-head">row {hoverRow + 1}</div>
            {columns.map((name, ci) => {
              if (ci === geoCol) return null;
              const v = rows[hoverRow][ci];
              const s = v === null || v === undefined ? 'NULL' : String(v);
              return (
                <div key={ci} className="map-geo-tip-row">
                  <span className="map-geo-tip-key">{name}</span>
                  <span className="map-geo-tip-val">
                    {s.length > 80 ? `${s.slice(0, 80)}…` : s}
                  </span>
                </div>
              );
            }).slice(0, 8)}
          </div>
        )}
      </div>

      {points.length > 0 && (
        <div className="map-transport">
          <button className="toolbar-btn" data-tip="First (Home)" onClick={() => move(-points.length)}>⏮</button>
          <button className="toolbar-btn" data-tip="Back (←, ⇧← for 10)" onClick={() => move(-1)}>◀</button>
          <button
            className={`toolbar-btn${playing ? ' toolbar-btn-on' : ''}`}
            data-tip="Play / pause (Space)"
            onClick={() => setPlaying(p => !p)}
          >{playing ? '⏸' : '▶'}</button>
          <button className="toolbar-btn" data-tip="Forward (→, ⇧→ for 10)" onClick={() => move(1)}>▶</button>
          <button className="toolbar-btn" data-tip="Last (End)" onClick={() => move(points.length)}>⏭</button>

          {/* The ball. Dragging it moves the marker; with a timestamp column
              it scrubs *time*, so gaps in the data are gaps in the drag —
              which is the honest behaviour, and how you see a vehicle that
              stopped reporting for an hour. */}
          <input
            className="map-scrub"
            type="range"
            min={0}
            max={timeCol >= 0 && points.length > 1 ? points[points.length - 1].t - points[0].t : Math.max(0, points.length - 1)}
            value={timeCol >= 0 && points.length > 1 ? (current ? current.t - points[0].t : 0) : index}
            onChange={e => {
              const v = Number(e.target.value);
              setPlaying(false);
              const next = timeCol >= 0 && points.length > 1
                ? indexAtTime(points, points[0].t + v)
                : v;
              setIndex(next);
              if (points[next]) onSelectRow?.(points[next].row);
            }}
          />

          <select
            className="toolbar-select"
            value={speed}
            data-tip="Playback speed"
            onChange={e => setSpeed(Number(e.target.value))}
          >
            {SPEEDS.map(s => <option key={s} value={s}>{s}×</option>)}
          </select>

          {current && (
            <span className="map-readout">
              #{index + 1}/{points.length} · {current.lat.toFixed(5)}, {current.lon.toFixed(5)}
              {timeCol >= 0 && ` · ${new Date(current.t).toLocaleString()}`}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

/** Graticule spacing that puts roughly 4–10 lines across the view. */
function pickGraticule(b: { minLat: number; maxLat: number; minLon: number; maxLon: number }): number {
  return graticuleStep(Math.max(b.maxLat - b.minLat, b.maxLon - b.minLon));
}

/**
 * A bar of a round number of kilometres.
 *
 * Without a basemap there is nothing else on the canvas to give scale, and a
 * track without scale can be a city block or a continent.
 */
function drawScaleBar(
  ctx: CanvasRenderingContext2D, v: Viewport,
  size: { w: number; h: number }, ink: string,
): void {
  // Metres per pixel at the centre of the view, from the Mercator scale.
  const metresPerUnit = 40_075_016.686;
  const metresPerPx = metresPerUnit / v.scale;
  const targetPx = Math.min(160, size.w / 4);
  const roundMetres = [1, 2, 5, 10, 20, 50, 100, 200, 500,
    1e3, 2e3, 5e3, 1e4, 2e4, 5e4, 1e5, 2e5, 5e5, 1e6, 2e6, 5e6];
  const metres = roundMetres.find(m => m / metresPerPx >= targetPx * 0.6) ?? 5e6;
  const px = metres / metresPerPx;
  const x = 12, y = size.h - 16;

  ctx.strokeStyle = ink;
  ctx.fillStyle = ink;
  ctx.lineWidth = 1.5;
  ctx.globalAlpha = 0.8;
  ctx.beginPath();
  ctx.moveTo(x, y - 4); ctx.lineTo(x, y); ctx.lineTo(x + px, y); ctx.lineTo(x + px, y - 4);
  ctx.stroke();
  ctx.font = '10px -apple-system, sans-serif';
  ctx.fillText(metres >= 1000 ? `${metres / 1000} km` : `${metres} m`, x + px + 6, y);
  ctx.globalAlpha = 1;
}
