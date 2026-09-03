/**
 * Chart-shaped dataset presets (src/utils/chartPresets.ts).
 *
 * A preset's whole job is that the data it produces **actually plots**. So the
 * tests generate the rows and check the resulting shape, rather than checking
 * that the preset says the right things about itself:
 *
 *  - a pie preset must yield few enough slices to read;
 *  - a line preset must yield an ordered, evenly spaced x axis;
 *  - a series must have a visible trend or cycle, or the chart is static.
 *
 * Each of those is a way a generated dataset looks fine in a grid and is
 * useless the moment it reaches a renderer.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CHART_PRESETS, PRESET_MAP, presetParams } from '../src/utils/chartPresets.ts';
import type { ChartPreset } from '../src/utils/chartPresets.ts';
import { GENERATOR_MAP, generateRows } from '../src/utils/datagen.ts';

/** Materialise a preset into rows, as the panel would. */
function rowsOf(p: ChartPreset, count = p.rows) {
  return generateRows(
    p.columns.map(c => ({
      name: c.name, typeName: c.typeName, generator: c.generator, params: presetParams(c),
    })),
    count, 1234,
  );
}

const col = (p: ChartPreset, name: string) => p.columns.findIndex(c => c.name === name);

// ── integrity ───────────────────────────────────────────────────────────────

test('every preset has a unique id and at least two columns of shape', () => {
  const ids = new Set<string>();
  for (const p of CHART_PRESETS) {
    assert.ok(!ids.has(p.id), `duplicate preset id ${p.id}`);
    ids.add(p.id);
    assert.ok(p.columns.length >= 1, `${p.id} has no columns`);
    assert.ok(p.rows > 0, `${p.id} generates no rows`);
    assert.ok(p.description.length > 20, `${p.id} does not explain its shape`);
  }
});

test('every preset column names a generator that exists', () => {
  // A typo here produces a column of nulls, which plots as a flat line rather
  // than as an error.
  for (const p of CHART_PRESETS) {
    for (const c of p.columns) {
      assert.ok(GENERATOR_MAP.has(c.generator),
        `${p.id}.${c.name} → unknown generator ${c.generator}`);
    }
  }
});

test('every preset generates without throwing, and fills every cell', () => {
  for (const p of CHART_PRESETS) {
    const rows = rowsOf(p, Math.min(p.rows, 50));
    assert.equal(rows.length, Math.min(p.rows, 50), `${p.id} produced the wrong row count`);
    for (const r of rows) {
      assert.equal(r.length, p.columns.length, `${p.id} row width mismatch`);
      for (const v of r) assert.notEqual(v, undefined, `${p.id} produced undefined`);
    }
  }
});

// ── the shapes that make each chart work ────────────────────────────────────

test('circular charts stay readable — few slices, not hundreds', () => {
  for (const p of CHART_PRESETS.filter(x => x.chart === 'pie')) {
    assert.ok(p.rows <= 12, `${p.id} makes a pie of ${p.rows} slices, which is a ring`);
  }
});

test('time-series presets produce a sorted, evenly spaced x axis', () => {
  // Randomly drawn timestamps sort into clustered gaps; a line chart over them
  // says nothing about intervals. Both time presets step instead.
  for (const id of ['timeseries-hourly', 'timeseries-daily']) {
    const p = PRESET_MAP.get(id)!;
    const xi = p.columns.findIndex(c => /TIMESTAMP|DATE/.test(c.typeName));
    assert.ok(xi >= 0, `${id} has no time column`);

    const xs = (rowsOf(p, 40).map(r => r[xi]) as string[])
      .map(v => new Date(v.replace(' ', 'T') + (v.includes(' ') ? 'Z' : 'T00:00:00Z')).getTime());

    const gap = xs[1] - xs[0];
    assert.ok(gap > 0, `${id} does not advance`);
    for (let i = 1; i < xs.length; i++) {
      assert.equal(xs[i] - xs[i - 1], gap, `${id} is not evenly spaced at row ${i}`);
    }
  }
});

test('a time-series measure has a visible shape, not static', () => {
  // The failure: independent random numbers, which plot as a band of noise
  // with no trend to see and no cycle to spot.
  const p = PRESET_MAP.get('timeseries-hourly')!;
  const vi = col(p, 'requests');
  const vs = rowsOf(p, 240).map(r => r[vi]) as number[];

  const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
  const first = mean(vs.slice(0, 24));
  const last = mean(vs.slice(-24));
  assert.ok(last > first * 1.05, `no trend across the series (${first.toFixed(0)} → ${last.toFixed(0)})`);

  // And a 24-row cycle: hour 6 and hour 18 of the same day differ.
  const day = vs.slice(0, 24);
  assert.ok(Math.max(...day) > Math.min(...day) * 1.3, 'no daily cycle');
});

test('the map preset gives a timestamp and two coordinates around one place', () => {
  // The map view asks the user to pick a timestamp and two coordinate columns;
  // this preset exists so there is something to pick.
  const p = PRESET_MAP.get('map-points')!;
  assert.ok(col(p, 'lat') >= 0 && col(p, 'lon') >= 0 && col(p, 'seen_at') >= 0);

  const rows = rowsOf(p, 300);
  const lats = rows.map(r => r[col(p, 'lat')]) as number[];
  const lons = rows.map(r => r[col(p, 'lon')]) as number[];
  assert.ok(Math.max(...lats) - Math.min(...lats) < 1, 'latitudes are scattered worldwide');
  assert.ok(Math.max(...lons) - Math.min(...lons) < 1.5, 'longitudes are scattered worldwide');
  for (const lat of lats) assert.ok(lat >= -90 && lat <= 90, `impossible latitude ${lat}`);
  for (const lon of lons) assert.ok(lon >= -180 && lon <= 180, `impossible longitude ${lon}`);
});

test('the histogram preset is not uniform — a flat histogram tests nothing', () => {
  const p = PRESET_MAP.get('histogram-normal')!;
  const vs = rowsOf(p, 3000).map(r => r[0]) as number[];
  const inMiddle = vs.filter(v => v >= 200 && v <= 300).length / vs.length;
  // A uniform draw over 5…500 would put ~20% in that 100-wide band.
  assert.ok(inMiddle > 0.3, `distribution looks flat (${(inMiddle * 100).toFixed(0)}% in the centre)`);
});

test('the category presets produce more than one distinct category', () => {
  // One repeated label is a single bar, which is not a bar chart.
  for (const id of ['category-bar', 'pie-shares', 'stacked-bar']) {
    const p = PRESET_MAP.get(id)!;
    const vs = rowsOf(p, Math.min(p.rows, 48)).map(r => r[0]);
    assert.ok(new Set(vs).size > 1, `${id} produced a single category`);
  }
});

test('presetParams fills in the defaults the preset does not override', () => {
  const p = PRESET_MAP.get('timeseries-hourly')!;
  const params = presetParams(p.columns[0]);
  assert.equal(params.stepUnit, 'hour', 'the override survived');
  assert.equal(params.nullPct, 0, 'the default was filled in');
  assert.ok(params.dateTo, 'every parameter is present, not just the overridden ones');
});
