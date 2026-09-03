/**
 * Alias resolution + the shared blank() scanner (src/utils/sqlAlias.ts) —
 * WP-08 8.7/8.8 regressions.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blank, findAliases } from '../src/utils/sqlAlias.ts';

// ── WP-08 8.8: the FROM segment stops at the statement boundary ─────────────

test('aliases do not leak across statement boundaries', () => {
  // Before the `;` terminator, each FROM's segment scan ran to end-of-doc —
  // O(#FROMs × docLength) per keystroke — and tokens from the NEXT statement
  // leaked into this FROM's entries.
  const m = findAliases('SELECT * FROM orders o;\nSELECT 1;\nSELECT * FROM users u;');
  assert.equal(m.get('o'), 'orders');
  assert.equal(m.get('u'), 'users');
  // the segment for `FROM orders o` must NOT have swallowed `SELECT 1` — a
  // token like `1` or `select` never becomes an alias/table
  assert.ok(!m.has('select'));
  assert.ok(![...m.values()].some(v => v.includes(';')), 'segment crossed a statement boundary');
});

test('blank is engine-aware about backslashes', () => {
  // PG: backslash is data — the literal closes at the quote.
  const pg = blank(String.raw`SELECT 'C:\' , x FROM t`, 'postgres');
  assert.match(pg, /FROM t/);
  // MySQL: the backslash escapes the quote — the literal runs on.
  const my = blank(String.raw`SELECT 'C:\' , x FROM t`, 'mysql');
  assert.ok(!/FROM t$/.test(my.trimEnd()) || !my.includes('x'), 'MySQL literal should swallow the rest');
});
