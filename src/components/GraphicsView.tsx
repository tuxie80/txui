/**
 * Graphics — one surface for turning a result set into a picture, with a
 * picker for which kind: a 🗺 Map (OSM basemap + track playback) or a 📊 Chart
 * (bar / line / pie / scatter, with its own type picker inside).
 *
 * It exists so "visualise this result" is one tab with a choice, rather than a
 * Map tab and a separate Chart toggle a user has to know are different things.
 */
import { useState } from 'react';
import type { ColumnInfo } from '../types';
import { MapView } from './MapView';
import { ResultChart } from './ResultChart';

interface Props {
  columns: ColumnInfo[];
  rows: unknown[][];
  /** Selecting a map point selects the row in the grid. */
  onSelectRow?: (rowIndex: number) => void;
  /** Which picture to open on first show. */
  initialMode?: 'map' | 'chart';
  /** GeoParquet footer bbox [west, south, east, north] — the map's first-fit
   *  hint (QueryResult.geo_bbox). Absent on every non-Parquet engine. */
  initialBbox?: [number, number, number, number] | null;
  /** Session engine + the query that produced the rows — the map's "View in
   *  WGS 84" action needs both (PostgreSQL only); without them it stays hidden. */
  engine?: string;
  sourceSql?: string | null;
  /** Runs a derived query (a new tab, through the normal execute path). */
  onRunDerived?: (sql: string, label: string) => void;
}

export function GraphicsView({ columns, rows, onSelectRow, initialMode = 'map',
  initialBbox, engine, sourceSql, onRunDerived }: Props) {
  const [mode, setMode] = useState<'map' | 'chart'>(initialMode);
  return (
    <div className="graphics-view">
      <div className="graphics-bar">
        <label className="map-pick">
          <span>Show</span>
          <select value={mode} onChange={e => setMode(e.target.value as 'map' | 'chart')}>
            <option value="map">🗺 Map</option>
            <option value="chart">📊 Chart / graph</option>
          </select>
        </label>
        <span className="dv-desc">
          {mode === 'map'
            ? 'Plot coordinates on a real map — drag to pan, scroll to zoom.'
            : 'Pick a chart type and columns below.'}
        </span>
      </div>
      {mode === 'map'
        ? (
          <MapView
            columns={columns.map(c => c.name)}
            columnTypes={columns.map(c => c.type_name)}
            rows={rows}
            onSelectRow={onSelectRow}
            initialBbox={initialBbox}
            engine={engine}
            sourceSql={sourceSql}
            onRunDerived={onRunDerived}
          />
        )
        : (
          <div className="graphics-chart-wrap">
            <ResultChart columns={columns} rows={rows} />
          </div>
        )}
    </div>
  );
}
