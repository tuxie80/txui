/**
 * Result-set serializers (src/utils/exporters.ts) — dialect correctness of
 * the INSERT export (WP-08 8.1). The module must stay pure (no React/Tauri
 * imports) so this file can drive it under node --test.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
// ── WP-08 8.1: INSERT export is dialect-correct ─────────────────────────────
// A PG/SQLite INSERT export must not emit backtick identifiers (syntax error)
// or backslash-doubled strings (silent data corruption — PG treats \ as a
// literal by default). MySQL output stays byte-identical to the old behavior.

test('toInserts quotes identifiers and escapes literals per engine', async () => {
  const { toInserts } = await import('../src/utils/exporters.ts');
  const cols = ['id', 'note'];
  const rows: unknown[][] = [[1, String.raw`C:\path 'quoted'`]];

  const pg = toInserts('order', cols, rows, 'postgres');
  assert.match(pg, /INSERT INTO "order" \("id", "note"\)/);
  assert.match(pg, /'C:\\path ''quoted'''/);        // backslash literal, quote doubled
  assert.ok(!pg.includes('`'), 'no backticks on PG');
  assert.ok(!pg.includes('\\\\'), 'no backslash doubling on PG');

  const my = toInserts('order', cols, rows, 'mysql');
  assert.match(my, /INSERT INTO `order` \(`id`, `note`\)/);
  assert.match(my, /'C:\\\\path ''quoted'''/);          // backslash doubled, quote doubled

  const dflt = toInserts('order', cols, rows);       // default stays MySQL
  assert.equal(dflt, my);

  const ms = toInserts('order', cols, rows, 'sqlserver');
  assert.match(ms, /INSERT INTO \[order\] \(\[id\], \[note\]\)/);
  assert.match(ms, /'C:\\path ''quoted'''/);
});

test('serialize threads the engine through the insert format', async () => {
  const { serialize } = await import('../src/utils/exporters.ts');
  const out = serialize('insert', ['a'], [['x']], 't', 'postgres');
  assert.match(out, /INSERT INTO "t" \("a"\) VALUES \('x'\);/);
});
