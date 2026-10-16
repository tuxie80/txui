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

// ── Engine-blindness probes (2026-10 audit) at the scanner level ───────────

test('blank nests block comments only where the engine does', () => {
  const sql = '/* a /* b */ c */ SELECT 1';
  // PG / T-SQL: the whole thing is one comment
  for (const engine of ['postgres', 'sqlserver']) {
    const b = blank(sql, engine);
    assert.ok(!b.includes('c'), engine);
    assert.ok(b.includes('SELECT'), engine);
  }
  // MySQL / engine-less: the comment ends at the first `*/`
  for (const engine of ['mysql', undefined]) {
    const b = blank(sql, engine);
    assert.ok(b.includes('c */'), engine);
  }
});

test('blank treats # as a comment only on MySQL-family engines', () => {
  const sql = 'SELECT 1 # 2';
  assert.ok(!blank(sql, 'mysql').includes('#'));
  assert.ok(!blank(sql, 'mariadb').includes('#'));
  for (const engine of ['postgres', 'sqlserver', 'sqlite']) {
    assert.ok(blank(sql, engine).includes('# 2'), engine);
  }
  // engine-less keeps the historical MySQL behavior
  assert.ok(!blank(sql).includes('#'));
});

test('blank blanks dollar-quoted bodies only where the engine has them', () => {
  const sql = 'SELECT $$ body $$ FROM t';
  const pg = blank(sql, 'postgres');
  assert.ok(!pg.includes('body'));
  assert.ok(pg.includes('FROM t'));
  const my = blank(sql, 'mysql');
  assert.ok(my.includes('body'));
  // a $1-style parameter is not a dollar-quote tag
  assert.ok(blank('SELECT * FROM t WHERE id = $1', 'postgres').includes('$1'));
});

test('blank keeps doubled quotes inside the string', () => {
  // PG: 'it''; DROP…' is the string `it'; DROP…` — the tail must NOT be SQL
  const b = blank(String.raw`SELECT 'it''; DROP TABLE t; --'`, 'postgres');
  assert.ok(!b.includes('DROP'), 'doubled quote must stay inside the literal');
});
