/**
 * Checksum expression building (src/utils/syncChecksum.ts).
 *
 * This module is what turns "the copy finished" into "the copy is correct", so
 * the tests are about the ways a checksum can agree while the data differs.
 * Every rule was established by measurement against MySQL 8.0.46 and verified
 * end-to-end against an 8.4.10 target, not read from documentation.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isGenerated, columnExpression, skipReason, rangePredicate, checksumSql,
  compareChecksums, summariseTable,
} from '../src/utils/syncChecksum.ts';
import type { ColumnMeta } from '../src/utils/syncChecksum.ts';

const col = (name: string, dataType: string, extra = ''): ColumnMeta =>
  ({ name, dataType, extra });

// ── the DEFAULT_GENERATED trap ──────────────────────────────────────────────

test('DEFAULT_GENERATED is NOT a generated column', () => {
  // Caught against two live servers: a TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  // column carries EXTRA='DEFAULT_GENERATED'. Matching on /GENERATED/ alone
  // silently dropped it from verification — exactly the gap this module exists
  // to close.
  assert.equal(isGenerated(col('issued_at', 'timestamp', 'DEFAULT_GENERATED')), false);
  assert.equal(skipReason(col('issued_at', 'timestamp', 'DEFAULT_GENERATED')), null);
});

test('STORED and VIRTUAL generated columns ARE excluded', () => {
  assert.ok(isGenerated(col('doubled', 'decimal', 'STORED GENERATED')));
  assert.ok(isGenerated(col('lower_email', 'varchar', 'VIRTUAL GENERATED')));
});

test('DEFAULT_GENERATED with an on-update clause is still ordinary data', () => {
  assert.equal(
    isGenerated(col('t', 'timestamp', 'DEFAULT_GENERATED on update CURRENT_TIMESTAMP')),
    false);
});

test('auto_increment is ordinary data', () => {
  assert.equal(isGenerated(col('id', 'bigint', 'auto_increment')), false);
});

// ── exclusions, and their reasons ───────────────────────────────────────────

test('floats are excluded — they are not byte-stable', () => {
  for (const t of ['float', 'double', 'real']) {
    const s = skipReason(col('x', t));
    assert.equal(s?.reason, 'float', t);
    assert.match(s!.note, /byte-stable/);
  }
});

test('DECIMAL is NOT excluded — it is exact', () => {
  // The common mistake: treating DECIMAL as a float. It is exact and must be
  // verified, or money columns go unchecked.
  assert.equal(skipReason(col('amount', 'decimal')), null);
});

test('every exclusion carries a reason a report can print', () => {
  for (const c of [col('x', 'double'), col('y', 'int', 'STORED GENERATED')]) {
    const s = skipReason(c)!;
    assert.ok(s.note.length > 40, s.note);
  }
});

// ── rendering ───────────────────────────────────────────────────────────────

test('binary types are hexed', () => {
  // A BLOB holding 0x00010203FF cannot survive a charset-tagged comparison —
  // measured as a hard failure when copying 8.0 → 8.4.
  for (const t of ['blob', 'longblob', 'binary', 'varbinary', 'bit', 'geometry']) {
    assert.equal(columnExpression(col('b', t)), 'HEX(`b`)', t);
  }
});

test('text types are hexed too — trailing whitespace must stay visible', () => {
  for (const t of ['char', 'varchar', 'text', 'json', 'enum', 'set']) {
    assert.equal(columnExpression(col('s', t)), 'HEX(`s`)', t);
  }
});

test('numbers and dates compare directly', () => {
  for (const t of ['int', 'bigint', 'decimal', 'date', 'datetime', 'timestamp']) {
    assert.equal(columnExpression(col('n', t)), '`n`', t);
  }
});

test('a backtick in a column name is escaped', () => {
  assert.equal(columnExpression(col('we`ird', 'int')), '`we``ird`');
});

// ── the generated statement ─────────────────────────────────────────────────

const COLS = [
  col('id', 'int'), col('name', 'varchar'), col('amount', 'decimal'),
  col('ratio', 'double'), col('gen', 'int', 'STORED GENERATED'),
];

test('count and checksum come back from ONE pass', () => {
  // Two statements would read the table twice, and on a live source could read
  // it at two different instants.
  const s = checksumSql('db', 't', COLS);
  assert.equal(s.sql.match(/FROM/g)?.length, 1);
  assert.match(s.sql, /COUNT\(\*\) AS n/);
  assert.match(s.sql, /BIT_XOR/);
});

test('the NULL bitmap is present — CONCAT_WS elides NULLs without it', () => {
  // Measured: CRC32(CONCAT_WS('#','a',NULL,'b')) == CRC32(CONCAT_WS('#','a','b')).
  const s = checksumSql('db', 't', COLS);
  assert.match(s.sql, /CONCAT\(ISNULL\(`id`\), ISNULL\(`name`\), ISNULL\(`amount`\)\)/);
});

test('the bitmap covers exactly the columns being hashed', () => {
  const s = checksumSql('db', 't', COLS);
  const isnulls = [...s.sql.matchAll(/ISNULL\(`([^`]+)`\)/g)].map(m => m[1]);
  assert.deepEqual(isnulls, s.columns);
});

test('excluded columns appear in neither the hash nor the bitmap', () => {
  const s = checksumSql('db', 't', COLS);
  assert.ok(!s.sql.includes('`ratio`'), s.sql);
  assert.ok(!s.sql.includes('`gen`'), s.sql);
  assert.deepEqual(s.skipped.map(x => x.column), ['ratio', 'gen']);
});

test('a table with no comparable column returns the count, not a fake checksum', () => {
  // Returning a checksum over nothing would read as agreement.
  const s = checksumSql('db', 't', [col('r', 'double')]);
  assert.match(s.sql, /NULL AS ck/);
  assert.deepEqual(s.columns, []);
  assert.equal(s.skipped.length, 1);
});

test('schema and table are escaped', () => {
  assert.match(checksumSql('we`ird', 'ta`ble', COLS).sql, /`we``ird`\.`ta``ble`/);
});

// ── chunk ranges ────────────────────────────────────────────────────────────

test('a single-column range uses row-value syntax', () => {
  assert.equal(
    rangePredicate({ keyColumns: ['id'], after: [100], upTo: [200] }),
    '(`id`) > (100) AND (`id`) <= (200)');
});

test('a composite key compares as a tuple', () => {
  // MySQL uses the PK index for row-value comparison; expanding it by hand
  // into OR/AND does not use it as reliably.
  assert.equal(
    rangePredicate({ keyColumns: ['a', 'b'], after: [1, 'x'], upTo: null }),
    "(`a`, `b`) > (1, 'x')");
});

test('an open range covers everything', () => {
  assert.equal(rangePredicate({ keyColumns: ['id'], after: null, upTo: null }), '1 = 1');
});

test('a quote in a key value cannot break out of the literal', () => {
  assert.match(
    rangePredicate({ keyColumns: ['k'], after: ["it's"], upTo: null }),
    /\('it''s'\)/);
});

test('the range lands in a WHERE clause', () => {
  const s = checksumSql('db', 't', COLS, { keyColumns: ['id'], after: [0], upTo: [50] });
  assert.match(s.sql, /WHERE \(`id`\) > \(0\) AND \(`id`\) <= \(50\)/);
});

// ── comparing ───────────────────────────────────────────────────────────────

test('identical count and checksum is a match', () => {
  const c = compareChecksums({ n: 100, ck: 42 }, { n: 100, ck: 42 });
  assert.equal(c.verdict, 'match');
});

test('a row-count difference is reported ahead of content', () => {
  // Rows missing is a bigger fact than rows differing; a reader who sees
  // "content differs" first goes looking for the wrong thing.
  const c = compareChecksums({ n: 100, ck: 1 }, { n: 99, ck: 2 });
  assert.equal(c.verdict, 'row-count');
  assert.match(c.summary, /-1/);
});

test('equal counts with unequal checksums names the likely cause', () => {
  // This is the case measured live: 5 = 5 rows, every NULL destroyed.
  const c = compareChecksums({ n: 5, ck: 2401757858 }, { n: 5, ck: 3591772800 });
  assert.equal(c.verdict, 'content');
  assert.match(c.summary, /NULLs turned into zeros/);
});

test('no comparable column is its own verdict, not a match', () => {
  // Reporting "match" when nothing was compared is the overclaim this avoids.
  const c = compareChecksums({ n: 10, ck: null }, { n: 10, ck: null });
  assert.equal(c.verdict, 'not-comparable');
  assert.match(c.summary, /row count is the only assurance/);
});

// ── the table summary ───────────────────────────────────────────────────────

test('a clean table reports its row total and any exclusions', () => {
  const chunks = [
    compareChecksums({ n: 50, ck: 1 }, { n: 50, ck: 1 }),
    compareChecksums({ n: 50, ck: 2 }, { n: 50, ck: 2 }),
  ];
  const s = summariseTable('db.t', chunks,
    [{ column: 'ratio', reason: 'float', note: 'x' }]);
  assert.ok(s.ok);
  assert.match(s.summary, /100 rows verified identical across 2 chunks/);
  assert.match(s.summary, /1 column excluded: ratio/);
});

test('a failure names the FIRST differing chunk, not just a count', () => {
  // "3 chunks differ" without saying which has not helped anyone; the next
  // action is a query against a key range.
  const chunks = [
    compareChecksums({ n: 50, ck: 1 }, { n: 50, ck: 1 }, 'chunk 1'),
    compareChecksums({ n: 50, ck: 2 }, { n: 49, ck: 9 }, 'chunk 2'),
    compareChecksums({ n: 50, ck: 3 }, { n: 50, ck: 8 }, 'chunk 3'),
  ];
  const s = summariseTable('db.t', chunks);
  assert.ok(!s.ok);
  assert.match(s.summary, /2 of 3 chunks differ/);
  assert.match(s.summary, /chunk 2/);
});

test('exclusions are reported even when everything matched', () => {
  // A silent exclusion is how "verified" comes to mean less than it says.
  const s = summariseTable('db.t',
    [compareChecksums({ n: 1, ck: 1 }, { n: 1, ck: 1 })],
    [{ column: 'a', reason: 'float', note: 'x' }, { column: 'b', reason: 'generated', note: 'y' }]);
  assert.match(s.summary, /2 columns excluded: a, b/);
});
