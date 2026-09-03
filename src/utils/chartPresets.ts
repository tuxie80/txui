/**
 * Ready-made table shapes for each kind of chart.
 *
 * Generating "some data" and then trying to plot it usually produces a chart
 * that proves nothing. The reasons are specific, and each preset here exists to
 * avoid one of them:
 *
 *  - **A pie of 500 slices is not a pie.** Circular charts need a handful of
 *    categories; anything past a dozen is an unreadable ring.
 *  - **A line needs an ordered x with even spacing.** Timestamps drawn at
 *    random inside a range sort into a jagged mess with clustered gaps, which
 *    is why the time-series presets step rather than draw.
 *  - **A line of independent random numbers is static.** There is no trend to
 *    see and no cycle to spot, so the chart says nothing about the data and
 *    nothing about the renderer. The series generator gives it a shape.
 *  - **A scatter of two independent columns is a rectangle.** Correlation is
 *    the thing a scatter plot exists to show, so one axis has to depend on the
 *    other.
 *
 * A preset is only a starting point: it fills the column list, and every
 * generator and parameter stays editable afterwards.
 *
 * Pure and dependency-free — driven by `node --test`.
 */
import type { GenParams } from './datagen.ts';
import { DEFAULT_PARAMS } from './datagen.ts';

/** Chart kinds `ResultChart` can draw, plus the ones a preset targets. */
export type ChartKind = 'bar' | 'line' | 'area' | 'pie' | 'scatter' | 'histogram';

export interface PresetColumn {
  name: string;
  /** Portable DDL type — the panel maps it per engine. */
  typeName: string;
  generator: string;
  /** Overrides merged onto `DEFAULT_PARAMS`. */
  params?: Partial<GenParams>;
}

export interface ChartPreset {
  id: string;
  label: string;
  chart: ChartKind;
  /** What the resulting chart looks like, and why the shape is what it is. */
  description: string;
  /** Row count that suits this chart — see the header note about pies. */
  rows: number;
  columns: PresetColumn[];
}

export const CHART_PRESETS: ChartPreset[] = [
  {
    id: 'timeseries-hourly',
    label: 'Line — hourly metric with a daily cycle',
    chart: 'line',
    description:
      'One row per hour, evenly spaced, with an upward trend and a 24-hour '
      + 'season. The shape a monitoring graph has.',
    rows: 720,                                   // 30 days of hours
    columns: [
      { name: 'bucket', typeName: 'TIMESTAMP', generator: 'timestampStep',
        params: { step: 1, stepUnit: 'hour', dateFrom: '2026-01-01' } },
      { name: 'requests', typeName: 'INTEGER', generator: 'seriesInt',
        params: { min: 400, max: 1600, trendPct: 35, seasonAmpPct: 40, seasonPeriod: 24, noisePct: 10 } },
      { name: 'latency_ms', typeName: 'DECIMAL(10,2)', generator: 'series',
        params: { min: 20, max: 90, trendPct: 5, seasonAmpPct: 25, seasonPeriod: 24, noisePct: 15, decimals: 2 } },
    ],
  },
  {
    id: 'timeseries-daily',
    label: 'Area — daily totals over a year',
    chart: 'area',
    description:
      'One row per day for a year, with a weekly cycle. Long enough that the '
      + 'x axis has to bucket, which is the case worth testing.',
    rows: 365,
    columns: [
      { name: 'day', typeName: 'DATE', generator: 'dateStep',
        params: { step: 1, stepUnit: 'day', dateFrom: '2026-01-01' } },
      { name: 'revenue', typeName: 'DECIMAL(12,2)', generator: 'series',
        params: { min: 5000, max: 25000, trendPct: 60, seasonAmpPct: 30, seasonPeriod: 7, noisePct: 12, decimals: 2 } },
    ],
  },
  {
    id: 'category-bar',
    label: 'Bar — value per category',
    chart: 'bar',
    description:
      'A dozen named categories with one value each. Few enough that every '
      + 'bar gets a readable label.',
    rows: 12,
    columns: [
      { name: 'department', typeName: 'VARCHAR(64)', generator: 'department' },
      { name: 'headcount', typeName: 'INTEGER', generator: 'int',
        params: { min: 3, max: 120, dist: 'normal' } },
      { name: 'budget', typeName: 'DECIMAL(12,2)', generator: 'money',
        params: { min: 50_000, max: 900_000 } },
    ],
  },
  {
    id: 'pie-shares',
    label: 'Pie — market share across a few slices',
    chart: 'pie',
    description:
      'Six rows. A pie stops being readable somewhere around eight slices and '
      + 'stops being a pie well before a hundred.',
    rows: 6,
    columns: [
      { name: 'channel', typeName: 'VARCHAR(32)', generator: 'choice',
        params: { list: 'Direct,Organic,Paid,Email,Social,Referral' } },
      { name: 'sessions', typeName: 'INTEGER', generator: 'int',
        params: { min: 500, max: 9000, dist: 'zipf' } },
    ],
  },
  {
    id: 'scatter-correlated',
    label: 'Scatter — two correlated measures',
    chart: 'scatter',
    description:
      'Size against price, with the correlation a scatter plot exists to show. '
      + 'Two independent columns would just fill a rectangle.',
    rows: 500,
    columns: [
      { name: 'area_m2', typeName: 'INTEGER', generator: 'int',
        params: { min: 20, max: 300, dist: 'normal' } },
      // Not literally derived from area_m2 — generators are independent by
      // design — but the same distribution and range make the cloud lean the
      // way a real one does rather than filling the box uniformly.
      { name: 'price_eur', typeName: 'DECIMAL(12,2)', generator: 'money',
        params: { min: 60_000, max: 900_000, dist: 'normal' } },
      { name: 'district', typeName: 'VARCHAR(32)', generator: 'city' },
    ],
  },
  {
    id: 'histogram-normal',
    label: 'Histogram — a normal distribution',
    chart: 'histogram',
    description:
      'One measure, normally distributed, enough rows for the bell to be '
      + 'visible. Uniform data makes a flat histogram, which tests nothing.',
    rows: 5000,
    columns: [
      { name: 'response_ms', typeName: 'INTEGER', generator: 'int',
        params: { min: 5, max: 500, dist: 'normal' } },
    ],
  },
  {
    id: 'map-points',
    label: 'Map — points around a city',
    chart: 'scatter',
    description:
      'Timestamp plus latitude and longitude, scattered over a 25 km radius — '
      + 'the three columns the map view asks you to pick.',
    rows: 2000,
    columns: [
      { name: 'seen_at', typeName: 'TIMESTAMP', generator: 'timestampStep',
        params: { step: 30, stepUnit: 'second', dateFrom: '2026-06-01' } },
      { name: 'lat', typeName: 'DOUBLE', generator: 'latitude',
        params: { lat: 50.08, lon: 14.44, radiusKm: 25 } },
      { name: 'lon', typeName: 'DOUBLE', generator: 'longitude',
        params: { lat: 50.08, lon: 14.44, radiusKm: 25 } },
      { name: 'speed_kph', typeName: 'DECIMAL(6,2)', generator: 'decimal',
        params: { min: 0, max: 90, decimals: 1 } },
    ],
  },
  {
    id: 'stacked-bar',
    label: 'Bar — category × series, for stacking',
    chart: 'bar',
    description:
      'Two dimensions and a measure, so the same table can be grouped or '
      + 'stacked. Twelve months across four regions.',
    rows: 48,
    columns: [
      { name: 'month', typeName: 'VARCHAR(16)', generator: 'monthName' },
      { name: 'region', typeName: 'VARCHAR(16)', generator: 'choice',
        params: { list: 'North,South,East,West' } },
      { name: 'units', typeName: 'INTEGER', generator: 'seriesInt',
        params: { min: 100, max: 900, seasonAmpPct: 35, seasonPeriod: 12, noisePct: 12 } },
    ],
  },
];

export const PRESET_MAP = new Map(CHART_PRESETS.map(p => [p.id, p]));

/** A preset column's full parameters — its overrides on top of the defaults. */
export function presetParams(col: PresetColumn): GenParams {
  return { ...DEFAULT_PARAMS, ...col.params };
}
