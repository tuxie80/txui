/**
 * Column profiling SQL (src/utils/columnProfile.ts).
 *
 * The distinction that justifies the module: the Maintenance panel's Analyze
 * op reports the optimiser's statistics — what the planner *believes*. This
 * reports what the data *says*.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyType, describeColumn, DEFAULT_SAMPLE, profileSql, rowEstimateSql,
  SAMPLE_THRESHOLD, selectivity, suggestSample, topValuesSql,
} from '../src/utils/columnProfile.ts';

const cols = [
  { name: 'id', dataType: 'int' },
  { name: 'email', dataType: 'varchar(255)' },
  { name: 'created', dataType: 'datetime' },
];

describe('classifyType', () => {
  test('numeric families', () => {
    for (const t of ['int', 'bigint unsigned', 'decimal(10,2)', 'numeric', 'double', 'serial', 'money']) {
      assert.equal(classifyType(t), 'numeric', t);
    }
  });
  test('temporal families', () => {
    for (const t of ['date', 'datetime', 'timestamp', 'timestamptz', 'time', 'year', 'interval']) {
      assert.equal(classifyType(t), 'temporal', t);
    }
  });
  test('text families', () => {
    for (const t of ['varchar(20)', 'text', 'char(3)', 'enum(\'a\')', 'uuid', 'jsonb']) {
      assert.equal(classifyType(t), 'text', t);
    }
  });
  test('booleans are their own class, not numeric', () => {
    for (const t of ['bool', 'boolean', 'tinyint(1)']) {
      assert.equal(classifyType(t), 'boolean', t);
    }
  });
  test('anything unrecognised falls back rather than guessing', () => {
    assert.equal(classifyType('geometry'), 'other');
    assert.equal(classifyType('bytea'), 'other');
  });
});

describe('profileSql', () => {
  /// Twenty columns must not become twenty scans of the same table.
  test('reads the table once per column but names it once per branch', () => {
    const sql = profileSql('mysql', 'shop', 'orders', cols, null);
    assert.equal(sql.split('UNION ALL').length, 3, 'one branch per column');
    assert.match(sql, /`shop`\.`orders`/);
  });

  /// A UNION whose branches disagree on column count fails at runtime, and the
  /// count cannot be measured by counting ` AS ` — `CAST(x AS CHAR)` has one
  /// too. Assert the output aliases by name instead.
  test('every branch reports the same columns, so the union is valid', () => {
    const aliases = [
      'column_name', 'data_type', 'rows_scanned', 'non_null', 'nulls',
      'distinct_vals', 'min_value', 'max_value', 'avg_value', 'min_len', 'max_len',
    ];
    for (const b of profileSql('mysql', 'shop', 'orders', cols, null).split('UNION ALL')) {
      for (const a of aliases) {
        assert.ok(b.includes(` AS ${a}`), `branch is missing ${a}: ${b.slice(0, 90)}…`);
      }
    }
  });

  /// MIN/MAX on a text column returns the alphabetically first string — a
  /// number that looks like a finding and is noise.
  test('extremes are only taken where they mean something', () => {
    const sql = profileSql('mysql', 'shop', 'orders', cols, null);
    const branches = sql.split('UNION ALL');
    const idBranch = branches.find(b => b.includes("'id'"))!;
    const emailBranch = branches.find(b => b.includes("'email'"))!;
    assert.match(idBranch, /MIN\(`id`\)/);
    assert.ok(!/MIN\(`email`\)/.test(emailBranch), 'text column got a MIN');
  });

  test('averages are numeric-only', () => {
    const branches = profileSql('mysql', 'shop', 'orders', cols, null).split('UNION ALL');
    assert.match(branches.find(b => b.includes("'id'"))!, /AVG\(`id`\)/);
    assert.ok(!/AVG\(/.test(branches.find(b => b.includes("'created'"))!), 'a datetime got an AVG');
  });

  test('length range is taken for text and nothing else', () => {
    const branches = profileSql('mysql', 'shop', 'orders', cols, null).split('UNION ALL');
    assert.match(branches.find(b => b.includes("'email'"))!, /CHAR_LENGTH\(`email`\)/);
    assert.ok(!/CHAR_LENGTH/.test(branches.find(b => b.includes("'id'"))!));
  });

  test('postgres quotes and casts its own way', () => {
    const sql = profileSql('postgres', 'public', 'orders', cols, null);
    assert.match(sql, /"public"\."orders"/);
    assert.match(sql, /::text/);
    assert.match(sql, /LENGTH\("email"\)/, 'postgres uses LENGTH, not CHAR_LENGTH');
  });

  /// A profile of 400 M rows must say it read a sample, and the sample has to
  /// actually bound the scan.
  test('a sample wraps the source in a bounded subquery', () => {
    const sql = profileSql('mysql', 'shop', 'orders', cols, 1000);
    assert.match(sql, /FROM \(SELECT \* FROM `shop`\.`orders` LIMIT 1000\) AS _s/);
  });

  test('no sample reads the table directly', () => {
    assert.ok(!profileSql('mysql', 'shop', 'orders', cols, null).includes('LIMIT'));
  });

  test('a fractional sample size cannot reach the SQL', () => {
    assert.match(profileSql('mysql', 's', 't', cols, 10.7), /LIMIT 10\)/);
  });

  /// Identifiers and literals both come from the catalog, so both are hostile
  /// input until quoted.
  test('a quote in a column name cannot break out', () => {
    const sql = profileSql('mysql', 'shop', 'orders', [{ name: "we'ird", dataType: 'int' }], null);
    assert.match(sql, /'we''ird' AS column_name/, 'the literal was not escaped');
  });

  test('nulls and distincts are always counted, whatever the type', () => {
    for (const b of profileSql('mysql', 's', 't', cols, null).split('UNION ALL')) {
      assert.match(b, /COUNT\(\*\) - COUNT\(/);
      assert.match(b, /COUNT\(DISTINCT /);
    }
  });
});

describe('topValuesSql', () => {
  test('groups and orders by frequency', () => {
    const sql = topValuesSql('mysql', 'shop', 'orders', 'status', 10, null);
    assert.match(sql, /GROUP BY `status`/);
    assert.match(sql, /ORDER BY n DESC LIMIT 10/);
  });

  /// "40 % of this column is NULL" is usually the finding — dropping the NULL
  /// bucket would hide it.
  test('NULL is not filtered out', () => {
    assert.ok(!/IS NOT NULL/.test(topValuesSql('mysql', 's', 't', 'c', 5, null)));
  });

  test('honours a sample', () => {
    assert.match(topValuesSql('postgres', 'p', 't', 'c', 5, 100), /LIMIT 100\) AS _s/);
  });
});

describe('rowEstimateSql', () => {
  test('uses the planner estimate on postgres and information_schema on mysql', () => {
    assert.match(rowEstimateSql('postgres', 'public', 'orders'), /reltuples/);
    assert.match(rowEstimateSql('mysql', 'shop', 'orders'), /information_schema\.TABLES/);
  });

  test('escapes the names it embeds as literals', () => {
    assert.match(rowEstimateSql('mysql', "sh'op", 't'), /'sh''op'/);
  });
});

describe('suggestSample', () => {
  test('a small table is read in full', () => {
    assert.equal(suggestSample(1000), null);
    assert.equal(suggestSample(SAMPLE_THRESHOLD), null);
  });

  test('a large table gets a sample', () => {
    assert.equal(suggestSample(SAMPLE_THRESHOLD + 1), DEFAULT_SAMPLE);
    assert.equal(suggestSample(400_000_000), DEFAULT_SAMPLE);
  });

  /// PostgreSQL returns -1 for a table that has never been analysed. Guessing
  /// from that would sample a table that might have four rows.
  test('an unknown estimate does not produce a guess', () => {
    assert.equal(suggestSample(null), null);
    assert.equal(suggestSample(-1), null);
  });
});

describe('selectivity and description', () => {
  test('selectivity is distinct over rows', () => {
    assert.equal(selectivity(50, 100), 0.5);
    assert.equal(selectivity(100, 100), 1);
  });

  test('an empty scan has no selectivity rather than dividing by zero', () => {
    assert.equal(selectivity(0, 0), null);
  });

  test('reads a key, a flag and a mostly-null column', () => {
    assert.equal(describeColumn({ rowsScanned: 100, nulls: 0, distinctVals: 100 }), 'unique');
    assert.equal(describeColumn({ rowsScanned: 100, nulls: 0, distinctVals: 1 }), 'single value');
    assert.match(describeColumn({ rowsScanned: 100, nulls: 90, distinctVals: 5 }), /90% NULL/);
  });

  test('an entirely NULL column says so plainly', () => {
    assert.equal(describeColumn({ rowsScanned: 100, nulls: 100, distinctVals: 0 }), 'entirely NULL');
  });

  test('an empty table is not described as anything else', () => {
    assert.equal(describeColumn({ rowsScanned: 0, nulls: 0, distinctVals: 0 }), 'empty table');
  });

  test('an ordinary column gets an ordinary reading', () => {
    assert.equal(describeColumn({ rowsScanned: 100, nulls: 0, distinctVals: 40 }), 'ordinary');
  });
});

// ── SQL Server ───────────────────────────────────────────────────────────────
//
// Every statement below was executed against SQL Server 2022 and the numbers
// checked against ground truth: 2000 customers, 1334 with an email, 4 distinct
// countries, email lengths 15–18.

test('T-SQL samples with TOP, because LIMIT is a syntax error there', () => {
  const cols = [{ name: 'id', dataType: 'int' }];
  const sql = profileSql('sqlserver', 'sales', 'customers', cols, 1000);
  assert.match(sql, /SELECT TOP \(1000\) \* FROM \[sales\]\.\[customers\]/);
  assert.ok(!/LIMIT/i.test(sql));
});

test('AVG casts first, or T-SQL does integer division', () => {
  // AVG(id) over 1,2 is 1 in T-SQL, not 1.5. Measured: without the cast the
  // profile reported 1000 for a column whose true mean is 1000.5.
  const sql = profileSql('sqlserver', 's', 't', [{ name: 'id', dataType: 'int' }], null);
  assert.match(sql, /AVG\(CAST\(\[id\] AS decimal\(38,6\)\)\)/);
});

test('LEN, not LENGTH or CHAR_LENGTH', () => {
  const sql = profileSql('sqlserver', 's', 't', [{ name: 'c', dataType: 'varchar' }], null);
  assert.match(sql, /MIN\(LEN\(\[c\]\)\)/);
  assert.ok(!/CHAR_LENGTH|LENGTH\(/.test(sql));
});

test('the text cast carries a length, or T-SQL truncates at 30', () => {
  // CAST(x AS nvarchar) with no length silently gives 30 characters.
  const sql = profileSql('sqlserver', 's', 't', [{ name: 'c', dataType: 'varchar' }], null);
  assert.match(sql, /AS nvarchar\(4000\)/);
});

test('top values uses TOP at the front, not LIMIT at the end', () => {
  const sql = topValuesSql('sqlserver', 's', 't', 'country', 10, null);
  assert.match(sql, /^SELECT TOP \(10\) /);
  assert.ok(!/LIMIT/i.test(sql));
});

test('the row estimate is free — a DMV, not COUNT(*)', () => {
  const sql = rowEstimateSql('sqlserver', 'sales', 'customers');
  assert.match(sql, /dm_db_partition_stats/);
  // row_count, not `rows` — that is sys.partitions' spelling, and getting it
  // wrong made the object tree empty against every real server once already.
  assert.match(sql, /p\.row_count/);
  assert.match(sql, /index_id IN \(0, 1\)/);
});
