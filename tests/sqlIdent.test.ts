/**
 * Identifier quoting for text the editor inserts (src/utils/sqlIdent.ts).
 * The bug this prevents: a camelCase table on PostgreSQL, or anything called
 * `order`, completed as bare text and resolving to something else — or nothing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  needsQuote, quoteIdent, safeIdent, safePath, isQuoted, unquoteIdent, sqlLiteral, escapeLiteral,
  RESERVED_WORDS, MYSQL_RESERVED_WINDOWS, PG_RESERVED_WORDS } from '../src/utils/sqlIdent.ts';

test('plain lower-case names are left alone on both engines', () => {
  for (const engine of ['mysql', 'postgres'] as const) {
    assert.equal(needsQuote('orders', engine), false);
    assert.equal(safeIdent('orders', engine), 'orders');
    assert.equal(safeIdent('order_items_2', engine), 'order_items_2');
  }
});

test('PostgreSQL: ANY upper-case character must be quoted (it folds otherwise)', () => {
  assert.equal(needsQuote('OrderItems', 'postgres'), true);
  assert.equal(safeIdent('OrderItems', 'postgres'), '"OrderItems"');
  assert.equal(safeIdent('createdAt', 'postgres'), '"createdAt"');
  // MySQL is case-preserving, so mixed case alone is not a reason to quote
  assert.equal(needsQuote('OrderItems', 'mysql'), false);
});

test('reserved words are quoted on both engines', () => {
  for (const engine of ['mysql', 'postgres'] as const) {
    for (const word of ['order', 'select', 'from', 'group', 'table', 'key', 'index', 'user']) {
      assert.equal(needsQuote(word, engine), true, `${word} must be quoted on ${engine}`);
    }
  }
  assert.equal(safeIdent('order', 'mysql'), '`order`');
  assert.equal(safeIdent('order', 'postgres'), '"order"');
});

test('illegal bare forms are quoted', () => {
  for (const engine of ['mysql', 'postgres'] as const) {
    for (const name of ['my-table', 'my table', '2fast', 'a.b', 'weird!', '']) {
      if (name === '') { assert.equal(needsQuote(name, engine), false); continue; }
      assert.equal(needsQuote(name, engine), true, `${name} on ${engine}`);
    }
  }
});

test('embedded quote characters are escaped by doubling', () => {
  assert.equal(quoteIdent('we`ird', 'mysql'), '`we``ird`');
  assert.equal(quoteIdent('we"ird', 'postgres'), '"we""ird"');
  assert.equal(unquoteIdent(quoteIdent('we`ird', 'mysql')), 'we`ird');
  assert.equal(unquoteIdent(quoteIdent('we"ird', 'postgres')), 'we"ird');
});

test('paths quote each part independently and pass quoted parts through', () => {
  assert.equal(safePath(['shop', 'orders'], 'mysql'), 'shop.orders');
  assert.equal(safePath(['shop', 'order'], 'mysql'), 'shop.`order`');
  assert.equal(safePath(['Shop', 'OrderItems'], 'postgres'), '"Shop"."OrderItems"');
  assert.equal(safePath(['public', '"OrderItems"'], 'postgres'), 'public."OrderItems"');
  assert.equal(safePath(['', 'orders'], 'mysql'), 'orders', 'empty parts are dropped');
});

test('isQuoted recognises both quoting styles', () => {
  assert.ok(isQuoted('`order`'));
  assert.ok(isQuoted('"Order"'));
  assert.ok(!isQuoted('order'));
  assert.ok(!isQuoted('`'));
  assert.equal(unquoteIdent('order'), 'order');
});

test('sqlite quotes with double quotes but does not fold case', () => {
  // Double quotes are SQLite's documented form (backticks are only a MySQL
  // compatibility extension), so that is what the editor inserts.
  assert.equal(quoteIdent('order', 'sqlite'), '"order"');
  assert.equal(quoteIdent('we"ird', 'sqlite'), '"we""ird"');

  // …but unlike PostgreSQL it preserves case, so a mixed-case name is
  // bare-legal and must NOT be quoted just for having a capital letter.
  assert.equal(needsQuote('Orders', 'sqlite'), false);
  assert.equal(needsQuote('Orders', 'postgres'), true);

  // Reserved words still need quoting everywhere.
  assert.equal(needsQuote('order', 'sqlite'), true);
  assert.equal(safeIdent('order', 'sqlite'), '"order"');
  assert.equal(safeIdent('orders', 'sqlite'), 'orders');
  assert.equal(safePath(['main', 'order'], 'sqlite'), 'main."order"');
});

// ── string literals ─────────────────────────────────────────────────────────

test('a backslash and a quote together survive on MySQL', () => {
  assert.equal(sqlLiteral("a\\'b"), "'a\\\\''b'");
});

test('on ClickHouse the backslash must be escaped BEFORE the quote', () => {
  // The quote is written \\' there, so doing quotes first would leave a
  // backslash for the backslash step to double into \\\\' — which ends the
  // literal. On MySQL either order agrees, which is what hides the bug.
  assert.equal(sqlLiteral("it's", 'clickhouse'), "'it\\'s'");
  const quotesFirst = "it's".replace(/'/g, "\\'").replace(/\\/g, '\\\\');
  assert.notEqual(`'${quotesFirst}'`, sqlLiteral("it's", 'clickhouse'));
});

test('the doubling-only escape that panels used is NOT sufficient on MySQL', () => {
  // Verified against MySQL 8.0.46: this exact input, escaped by doubling
  // quotes alone, reached the server as parsed SQL and executed the UNION —
  // it returned ERROR 1222 (wrong column count), not a syntax error.
  const attack = "x\\' UNION SELECT 1,2,3,4,5,6,7 -- ";
  const doublingOnly = `'${attack.replace(/'/g, "''")}'`;
  // The broken form leaves a lone backslash immediately before the pair.
  assert.match(doublingOnly, /\\''/);
  // The correct form doubles it, so the quote pair survives as data.
  assert.match(sqlLiteral(attack), /\\\\''/);
});

test('PostgreSQL keeps the backslash literal', () => {
  // Standard-conforming strings treat it as data; doubling would corrupt it.
  assert.equal(sqlLiteral('a\\b', 'postgres'), "'a\\b'");
  assert.equal(sqlLiteral("it's", 'postgres'), "'it''s'");
});

test('ordinary values are unharmed', () => {
  assert.equal(sqlLiteral('shop'), "'shop'");
  assert.equal(sqlLiteral(''), "''");
});

test('escapeLiteral is the same rules without the quotes', () => {
  assert.equal(escapeLiteral("it's"), "it''s");
  assert.equal(escapeLiteral("a\\b"), "a\\\\b");
});

test('ClickHouse escapes the quote with a backslash, not by doubling', () => {
  // Doubling is a MySQL/PG spelling; ClickHouse reads \' and would see a
  // doubled pair as two separate quotes, ending the literal early.
  assert.equal(sqlLiteral("it's", 'clickhouse'), "'it\\'s'");
  assert.equal(sqlLiteral('a\\b', 'clickhouse'), "'a\\\\b'");
});

test('SQLite follows the standard, like PostgreSQL', () => {
  assert.equal(sqlLiteral('a\\b', 'sqlite'), "'a\\b'");
  assert.equal(sqlLiteral("it's", 'sqlite'), "'it''s'");
});

test('DuckDB quotes like PostgreSQL and never with backticks', () => {
  // DuckDB is Postgres-flavoured and REJECTS backticks outright (Parser Error
  // at "`"), so anything the editor inserts must be double-quoted.
  assert.equal(quoteIdent('order', 'duckdb'), '"order"');
  assert.equal(quoteIdent('we"ird', 'duckdb'), '"we""ird"');
  assert.equal(safePath(['main', 'order'], 'duckdb'), 'main."order"');
  // It preserves case and compares case-insensitively (like SQLite), so a
  // mixed-case name is bare-legal and must NOT be quoted for the capital.
  assert.equal(needsQuote('Orders', 'duckdb'), false);
  assert.equal(needsQuote('order', 'duckdb'), true);
  // String literals: a backslash is data, the quote doubles.
  assert.equal(sqlLiteral('a\\b', 'duckdb'), "'a\\b'");
  assert.equal(sqlLiteral("it's", 'duckdb'), "'it''s'");
});

test('an unknown engine gets the strictest escaping, not the loosest', () => {
  // Defaulting to quote-doubling alone would silently reintroduce the MySQL
  // break-out for any engine added later.
  assert.equal(sqlLiteral('a\\b', 'mariadb'), "'a\\\\b'");
});

test('the MySQL 8.0/8.4/9.x reserved additions need quoting too', () => {
  // A column named `lead` or `groups` is legal on 5.7 / MariaDB and a syntax
  // error bare on MySQL 8 — the completer must quote it.
  for (const word of ['rank', 'groups', 'lead', 'lag', 'cube', 'empty', 'member',
    'recursive', 'row_number', 'first_value', 'manual', 'parallel', 'qualify', 'tablesample',
    'library', 'external', 'sets']) {
    assert.equal(needsQuote(word, 'mysql'), true, `${word} must be quoted`);
  }
});

test('every MYSQL_RESERVED_WINDOWS key is in the reserved set', () => {
  for (const word of Object.keys(MYSQL_RESERVED_WINDOWS)) {
    assert.ok(RESERVED_WORDS.has(word), `${word} is labelled but not reserved`);
  }
});

test('the reservation windows match the manual (8.0 → 26.7)', () => {
  // Spot-checks against the per-version keyword tables in the MySQL manual.
  assert.deepEqual(MYSQL_RESERVED_WINDOWS['manual'], { since: '8.4', until: '9.7.2' });
  assert.deepEqual(MYSQL_RESERVED_WINDOWS['parallel'], { since: '8.4', until: '9.7.2' });
  assert.deepEqual(MYSQL_RESERVED_WINDOWS['qualify'], { since: '8.4' });
  assert.deepEqual(MYSQL_RESERVED_WINDOWS['library'], { since: '9.2' });
  assert.deepEqual(MYSQL_RESERVED_WINDOWS['external'], { since: '9.4' });
  assert.deepEqual(MYSQL_RESERVED_WINDOWS['sets'], { since: '9.6' });
});

// ── the PostgreSQL "reserved" category ──────────────────────────────────────

test('PG_RESERVED_WORDS is PostgreSQL\'s fully-reserved set, spot-checked', () => {
  // The words a PG schema can only contain because the DDL quoted them.
  for (const word of ['select', 'table', 'where', 'order', 'group', 'user',
    'primary', 'references', 'default', 'check', 'union', 'with', 'limit',
    'offset', 'returning', 'lateral', 'window']) {
    assert.ok(PG_RESERVED_WORDS.has(word), `${word} must grade as reserved on PG`);
  }
  // Words the union reserves but PG does not (fully): `rank`, `lead`, `groups`
  // are plain function names in PG — legal bare identifiers there.
  for (const word of ['rank', 'lead', 'groups', 'zerofill', 'high_priority']) {
    assert.ok(!PG_RESERVED_WORDS.has(word), `${word} is not PG-reserved`);
    assert.ok(RESERVED_WORDS.has(word), `${word} is still in the union`);
  }
  // And PG-reserved words absent from the quoting union (quoting rarely meets
  // them; the severity grading always might).
  for (const word of ['analyse', 'asymmetric', 'variadic']) {
    assert.ok(PG_RESERVED_WORDS.has(word), `${word} is PG-reserved`);
    assert.ok(!RESERVED_WORDS.has(word), `${word} is outside the quoting union`);
  }
});
