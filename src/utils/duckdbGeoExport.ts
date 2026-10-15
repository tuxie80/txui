/**
 * GeoParquet export availability — the single predicate behind the result
 * grid's "GeoParquet (server-side)…" menu entry.
 *
 * Server-side export exists because the client-side one cannot do the job:
 * `write_parquet_file` serializes the FETCHED grid rows, where a geometry
 * column is already hex text — the file ends up with an opaque string column
 * and no `geo` footer. `duckdb_export_geoparquet` instead re-runs the source
 * statement as `COPY (<sql>) TO '…' (FORMAT PARQUET)` on the session's own
 * connection, so the GEOMETRY type survives and the spatial extension writes
 * the GeoParquet 1.1 metadata.
 *
 * One predicate, two consumers — the menu greys the entry with the tip when
 * the verdict is blocked, and the handler re-checks the same verdict before
 * running (house rule: greyed, explained, never hidden, never `disabled`).
 *
 * Pure and dependency-free — driven by `node --test`. The spatial state type
 * is imported TYPE-ONLY so this module stays free of React/Tauri.
 */
import type { DuckdbSpatialState } from '../store/duckdbSpatial';
import { fmtBytes } from './syncLog.ts';

/**
 * Progress of a server-side GeoParquet export, streamed over the command's
 * channel (`duckdb_export_geoparquet`). Mirrors the Rust `GeoExportEvent` —
 * keep the two in sync. The engine exposes no row percentage, so `progress`
 * reports the output file's size: liveness, never a fake percent.
 */
export type GeoExportEvent =
  | { type: 'validating' }
  | { type: 'running' }
  | { type: 'progress'; bytes_written: number }
  | { type: 'done'; rows_written: number; bytes: number }
  | { type: 'error'; message: string };

/** The one-line running-tasks status for an export event. */
export function geoExportStatus(ev: GeoExportEvent): string {
  switch (ev.type) {
    case 'validating': return 'checking the statement';
    case 'running':    return 'COPY running on the engine';
    case 'progress':   return `COPY running — ${fmtBytes(ev.bytes_written)} written`;
    case 'done':       return `done — ${ev.rows_written.toLocaleString()} rows, ${fmtBytes(ev.bytes)}`;
    case 'error':      return `failed — ${ev.message}`;
  }
}

export type GeoParquetVerdict = { ok: true } | { ok: false; tip: string };

/** The column type label the DuckDB driver reports for geometry (Wave 3:
 *  the arrow carrier says Binary for both GEOMETRY and BLOB, so the label
 *  comes from the column's DuckDB logical type). */
export const GEOMETRY_TYPE = 'GEOMETRY';

export function hasGeometryColumn(columnTypes: string[]): boolean {
  return columnTypes.some(t => t === GEOMETRY_TYPE);
}

/**
 * Whether the entry can run, else why not — in the order a user would fix
 * the obstacles: wrong engine (the menu only shows the entry for DuckDB
 * query results at all), no source statement, no geometry in the result,
 * then the spatial states.
 */
export function geoParquetVerdict(opts: {
  engine?: string;
  /** The statement that produced the result (tab.resultSql / script line). */
  sourceSql?: string;
  columnTypes: string[];
  spatial: DuckdbSpatialState;
}): GeoParquetVerdict {
  if (opts.engine !== 'duckdb') {
    return { ok: false, tip: 'GeoParquet export is a DuckDB feature — it re-runs the query as COPY (SELECT …) TO (FORMAT PARQUET) on the session' };
  }
  if (!opts.sourceSql?.trim()) {
    return { ok: false, tip: 'No source statement for this result — run the query from the editor first' };
  }
  if (!hasGeometryColumn(opts.columnTypes)) {
    return { ok: false, tip: 'This result has no GEOMETRY column — the plain Parquet export above covers it' };
  }
  switch (opts.spatial.status) {
    case 'on':
      return { ok: true };
    case 'enabling':
      return { ok: false, tip: 'The spatial extension is still being enabled — try again in a moment' };
    case 'failed':
      return {
        ok: false,
        tip: `Needs DuckDB spatial, which failed to load: ${opts.spatial.reason}${opts.spatial.network ? ' (the one-time download needs the network)' : ''}. Reconnect to retry.`,
      };
    default:
      return { ok: false, tip: 'Needs DuckDB spatial — enable it with the 🌐 toolbar button (one-time download, afterwards offline)' };
  }
}
