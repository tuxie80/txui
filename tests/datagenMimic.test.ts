/**
 * The profile → generator mapping for "Mimic existing data"
 * (src/utils/datagenMimic.ts).
 *
 * The point of this suite is the PRIVACY CONTRACT and the thresholds: observed
 * values may only ever land in a spec as the weighted categories of a
 * low-cardinality column — free text, emails and dates must come out as
 * generators and ranges, never as copied content. A regression that carries
 * real values into generated output is exactly the failure this module exists
 * to prevent, so the fixtures assert on the list/params directly.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  mimicColumn, mimicLogLine, CATEGORICAL_MAX_DISTINCT,
} from '../src/utils/datagenMimic.ts';
import type { ColumnProfile } from '../src/utils/datagenMimic.ts';

/** A profile fixture with everything zeroed; each test overrides its slice. */
function prof(over: Partial<ColumnProfile>): ColumnProfile {
  return {
    column: 'c', family: 'numeric', sampledRows: 1000, nullPct: 0,
    distinct: null, min: null, max: null, avgLen: null, maxLen: null,
    topValues: [], error: null, ...over,
  };
}

const top = (value: unknown, count: number) => ({ value, count });

// ── numeric ─────────────────────────────────────────────────────────────────

describe('numeric columns', () => {
  test('a PK-like all-distinct integer keeps the sequence the loader picked', () => {
    const s = mimicColumn(
      { name: 'id', typeName: 'INT', generator: 'sequence', unique: true },
      prof({ distinct: 1000, min: 1, max: 1000 }),
    );
    assert.equal(s.generator, 'sequence');
    assert.equal(s.unique, true);
    assert.equal(s.params.min, undefined, 'a sequence takes no range');
    assert.match(s.reason, /distinct/);
  });

  test('an all-distinct non-PK integer becomes a unique int over the observed range', () => {
    const s = mimicColumn(
      { name: 'ticket_no', typeName: 'INT', generator: 'int' },
      prof({ distinct: 995, min: 100, max: 40_000 }),
    );
    assert.equal(s.generator, 'int');
    assert.equal(s.unique, true);
    assert.equal(s.params.min, 100);
    assert.equal(s.params.max, 40_000);
  });

  test('a plain integer gets its observed min/max, no uniqueness', () => {
    const s = mimicColumn(
      { name: 'qty', typeName: 'INT', generator: 'int' },
      prof({ distinct: 900, min: 1.2, max: 50.7 }),
    );
    assert.equal(s.generator, 'int');
    assert.equal(s.unique, undefined);
    assert.equal(s.params.min, 1, 'integer mins floor');
    assert.equal(s.params.max, 51, 'integer maxes ceil');
  });

  test('a decimal column keeps decimals from the type and min/max as-is', () => {
    const s = mimicColumn(
      { name: 'price', typeName: 'DECIMAL(10,2)', generator: 'decimal' },
      // DECIMAL decodes as a STRING (never f64) — the fixture must too.
      prof({ distinct: 800, min: '3.50', max: '999.99' }),
    );
    assert.equal(s.generator, 'decimal');
    assert.equal(s.params.min, 3.5);
    assert.equal(s.params.max, 999.99);
    assert.equal(s.params.decimals, 2);
  });

  test('a low-cardinality numeric becomes a weighted choice of observed categories', () => {
    const s = mimicColumn(
      { name: 'rating', typeName: 'INT', generator: 'int' },
      prof({ distinct: 5, min: 1, max: 5, topValues: [top(5, 400), top(4, 300), top(3, 200), top(2, 80), top(1, 20)] }),
    );
    assert.equal(s.generator, 'choice');
    assert.equal(s.unique, false);
    assert.equal(s.params.list, '5:40,4:30,3:20,2:8,1:2');
  });

  test('a single observed value is a one-point range, flagged in the reason', () => {
    const s = mimicColumn(
      { name: 'version', typeName: 'INT', generator: 'int' },
      prof({ distinct: 1, min: 7, max: 7 }),
    );
    assert.equal(s.generator, 'int');
    assert.deepEqual([s.params.min, s.params.max], [7, 7]);
    assert.match(s.reason, /one observed value/);
  });

  test('no min/max (all-null stats) falls back to the name-based suggestion', () => {
    const s = mimicColumn(
      { name: 'amount', typeName: 'DECIMAL(12,2)', generator: 'decimal' },
      prof({ sampledRows: 10, nullPct: 0, min: null, max: null }),
    );
    assert.equal(s.generator, 'decimal');
    assert.equal(s.params.min, undefined);
    assert.match(s.reason, /no min\/max/);
  });
});

// ── temporal ────────────────────────────────────────────────────────────────

describe('temporal columns', () => {
  test('a DATE range becomes a date generator between the observed bounds', () => {
    const s = mimicColumn(
      { name: 'born_on', typeName: 'DATE', generator: 'date' },
      prof({ family: 'temporal', distinct: 900, min: '1958-03-04', max: '2001-11-30' }),
    );
    assert.equal(s.generator, 'date');
    assert.equal(s.params.dateFrom, '1958-03-04');
    assert.equal(s.params.dateTo, '2001-11-30');
    assert.equal(s.unique, undefined, 'uniqueness tags would corrupt date values');
  });

  test('a TIMESTAMP keeps the time component generator, dates from strings with times', () => {
    const s = mimicColumn(
      { name: 'created_at', typeName: 'TIMESTAMP', generator: 'timestamp' },
      prof({ family: 'temporal', distinct: 999, min: '2024-01-02 08:15:00.000000', max: '2026-09-30 23:59:59' }),
    );
    assert.equal(s.generator, 'timestamp');
    assert.equal(s.params.dateFrom, '2024-01-02');
    assert.equal(s.params.dateTo, '2026-09-30');
  });

  test('a bare TIME column maps to timeOfDay, not a date range', () => {
    const s = mimicColumn(
      { name: 'opens_at', typeName: 'TIME', generator: 'timeOfDay' },
      prof({ family: 'temporal', distinct: 60, min: '06:00:00', max: '22:00:00' }),
    );
    assert.equal(s.generator, 'timeOfDay');
    assert.equal(s.params.dateFrom, undefined);
  });

  test('unparseable bounds fall back without a range', () => {
    const s = mimicColumn(
      { name: 'd', typeName: 'DATE', generator: 'date' },
      prof({ family: 'temporal', min: 42, max: null }),
    );
    assert.equal(s.generator, 'date');
    assert.equal(s.params.dateFrom, undefined);
    assert.match(s.reason, /no min\/max/);
  });
});

// ── text ────────────────────────────────────────────────────────────────────

describe('text columns', () => {
  test('a categorical text column becomes a weighted choice of its observed labels', () => {
    const s = mimicColumn(
      { name: 'status', typeName: 'VARCHAR(20)', generator: 'choice' },
      prof({ family: 'text', distinct: 3, avgLen: 7, maxLen: 9,
        topValues: [top('active', 700), top('disabled', 250), top('banned', 50)] }),
    );
    assert.equal(s.generator, 'choice');
    assert.equal(s.params.list, 'active:70,disabled:25,banned:5');
    // Categories are the ONLY observed values a spec may carry — assert the
    // list holds labels with weights, nothing else.
    for (const item of s.params.list!.split(',')) assert.match(item, /^[a-z]+:\d+(\.\d+)?$/);
  });

  test('a comma or colon inside a value breaks the list grammar — no choice is built', () => {
    const s = mimicColumn(
      { name: 'note', typeName: 'VARCHAR(100)', generator: 'words' },
      prof({ family: 'text', distinct: 4, avgLen: 12,
        topValues: [top('a, b', 500), top('c', 500)] }),
    );
    assert.notEqual(s.generator, 'choice', 'an unencodable value must not produce a corrupt list');
  });

  test('a semantic name match (email) beats the length histogram — and carries no values', () => {
    const s = mimicColumn(
      { name: 'email', typeName: 'VARCHAR(255)', generator: 'email' },
      prof({ family: 'text', distinct: 990, avgLen: 22, maxLen: 41,
        topValues: [top('real.person@example.com', 3)] }),
    );
    assert.equal(s.generator, 'email');
    assert.equal(s.params.list, undefined, 'free text values never cross into the spec');
    assert.match(s.reason, /not carried over/);
  });

  test('free text buckets by average length: words / sentence / paragraph', () => {
    const mk = (avgLen: number) => mimicColumn(
      { name: 'blob_of_words', typeName: 'TEXT', generator: 'sentence' },
      prof({ family: 'text', distinct: 500, avgLen, maxLen: avgLen * 3 }),
    );
    assert.equal(mk(9).generator, 'words');
    assert.equal(mk(60).generator, 'sentence');
    assert.equal(mk(500).generator, 'paragraph');
  });

  test('an all-distinct short code the name heuristic missed goes unique', () => {
    const s = mimicColumn(
      { name: 'xref', typeName: 'VARCHAR(30)', generator: 'words' },
      prof({ family: 'text', distinct: 1000, avgLen: 12, maxLen: 12 }),
    );
    assert.equal(s.unique, true);
    assert.match(s.reason, /distinct/);
  });

  test('a skewed categorical under the ratio threshold also counts as categorical', () => {
    // 20 distinct > CATEGORICAL_MAX_DISTINCT, but 20/100_000 ≪ 5%.
    const s = mimicColumn(
      { name: 'colour', typeName: 'VARCHAR(20)', generator: 'choice' },
      prof({ family: 'text', sampledRows: 100_000, distinct: CATEGORICAL_MAX_DISTINCT + 4,
        topValues: [top('red', 90_000), top('blue', 9_000), top('green', 950)] }),
    );
    assert.equal(s.generator, 'choice');
    assert.equal(s.params.list, 'red:90,blue:9,green:1');
  });
});

// ── bool / other / degenerate ───────────────────────────────────────────────

describe('bool, other and degenerate columns', () => {
  test('a boolean maps to bool, quoting the observed split when skewed', () => {
    const s = mimicColumn(
      { name: 'active', typeName: 'TINYINT(1)', generator: 'bool' },
      prof({ family: 'bool', distinct: 2, topValues: [top(1, 920), top(0, 80)] }),
    );
    assert.equal(s.generator, 'bool');
    assert.match(s.reason, /92%/);
  });

  test('a JSON column takes the structure generator, values never carried', () => {
    const s = mimicColumn(
      { name: 'payload', typeName: 'JSONB', generator: 'json' },
      prof({ family: 'other', nullPct: 12 }),
    );
    assert.equal(s.generator, 'json');
    assert.equal(s.params.nullPct, 12);
    assert.equal(s.params.list, undefined);
  });

  test('a genuinely unprofilable type keeps the suggestion with only nullPct', () => {
    const s = mimicColumn(
      { name: 'geom', typeName: 'GEOMETRY', generator: 'words' },
      prof({ family: 'other', nullPct: 5 }),
    );
    assert.equal(s.generator, 'words');
    assert.equal(s.params.nullPct, 5);
    assert.match(s.reason, /null share/);
  });

  test('a failed column profile keeps the name-based suggestion untouched', () => {
    const s = mimicColumn(
      { name: 'email', typeName: 'VARCHAR(255)', generator: 'email' },
      prof({ family: 'text', sampledRows: 0, error: 'GROUP BY on text: unsupported' }),
    );
    assert.equal(s.generator, 'email');
    assert.deepEqual(s.params, {});
    assert.match(s.reason, /profiling failed/);
  });

  test('an empty table keeps the name-based suggestion untouched', () => {
    const s = mimicColumn(
      { name: 'status', typeName: 'VARCHAR(20)', generator: 'choice' },
      prof({ family: 'text', sampledRows: 0 }),
    );
    assert.equal(s.generator, 'choice');
    assert.deepEqual(s.params, {});
    assert.match(s.reason, /no rows/);
  });
});

// ── null share ──────────────────────────────────────────────────────────────

describe('null share', () => {
  test('the observed null % lands on every mapped column, rounded', () => {
    const s = mimicColumn(
      { name: 'qty', typeName: 'INT', generator: 'int' },
      prof({ distinct: 500, min: 0, max: 99, nullPct: 17.4 }),
    );
    assert.equal(s.params.nullPct, 17);
  });

  test('an all-NULL column pre-fills nullPct 100 regardless of generator', () => {
    const s = mimicColumn(
      { name: 'legacy_field', typeName: 'VARCHAR(50)', generator: 'words' },
      prof({ family: 'text', sampledRows: 5000, nullPct: 100 }),
    );
    assert.equal(s.params.nullPct, 100);
    assert.match(s.reason, /entirely NULL/);
  });
});

// ── the log line ────────────────────────────────────────────────────────────

describe('mimicLogLine', () => {
  const profiles = [
    prof({ column: 'a', sampledRows: 42 }),
    prof({ column: 'b', sampledRows: 42, error: 'nope' }),
  ];

  test('names the table, the scope and the no-values contract', () => {
    const line = mimicLogLine('`shop`.`t`', profiles, 1, 100_000);
    assert.match(line, /`shop`.`t`/);
    assert.match(line, /all 42 rows/);
    assert.match(line, /pre-filled 1 column/);
    assert.match(line, /1 kept name-based/);
    assert.match(line, /no values copied/);
  });

  test('a capped sample says it was a sample', () => {
    const line = mimicLogLine('t', [prof({ sampledRows: 100_000 })], 1, 100_000);
    assert.match(line, /sample of 100,000 rows/);
  });
});
