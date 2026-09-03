/**
 * T-SQL (SQL Server) dialect pieces: the keyword/function catalog
 * (src/utils/sqlKeywords.ts) and identifier / literal quoting
 * (src/utils/sqlIdent.ts), both addressed by the engine name 'sqlserver'.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { keywordCatalog } from '../src/utils/sqlKeywords.ts';
import {
  escapeLiteral, isQuoted, needsQuote, quoteIdent, safeIdent, safePath,
  sqlLiteral, unquoteIdent,
} from '../src/utils/sqlIdent.ts';

describe('the T-SQL keyword catalog', () => {
  const items = keywordCatalog('sqlserver');
  const labels = new Set(items.map(i => i.label));

  test('the statements that only exist in T-SQL complete', () => {
    for (const kw of [
      'TOP', 'CROSS APPLY', 'OUTER APPLY', 'MERGE INTO', 'OUTPUT INSERTED.*',
      'IDENTITY(1,1)', 'BEGIN TRY', 'END CATCH', 'BULK INSERT',
      'CREATE OR ALTER PROCEDURE', 'DROP TABLE IF EXISTS', 'SET NOCOUNT ON',
      'WITH (NOLOCK)', 'NEXT VALUE FOR', 'THROW', 'EXEC sp_executesql',
    ]) {
      assert.ok(labels.has(kw), `missing keyword: ${kw}`);
    }
  });

  test('the everyday T-SQL functions complete, with signatures', () => {
    const byName = new Map(items.map(i => [i.label, i]));
    for (const fn of [
      'GETDATE', 'DATEADD', 'DATEDIFF', 'DATEPART', 'ISNULL', 'STRING_AGG',
      'IIF', 'FORMAT', 'CONVERT', 'TRY_CONVERT', 'NEWID', 'SCOPE_IDENTITY',
      'JSON_VALUE', 'OPENJSON', 'EOMONTH', 'CHARINDEX', 'QUOTENAME',
    ]) {
      const item = byName.get(fn);
      assert.ok(item, `missing function: ${fn}`);
      assert.equal(item.type, 'function');
      assert.ok(item.detail, `${fn} carries no signature`);
    }
  });

  test('ISNULL and COALESCE both complete — the difference is in the detail', () => {
    const byName = new Map(items.map(i => [i.label, i]));
    assert.match(byName.get('ISNULL')!.detail!, /FIRST argument wins/);
    assert.ok(byName.has('COALESCE'), 'COALESCE comes from the core catalog');
  });

  test('no function appears twice in the dropdown', () => {
    const seen = new Set<string>();
    for (const i of items.filter(i => i.type === 'function')) {
      assert.ok(!seen.has(i.label), `${i.label} is listed twice`);
      seen.add(i.label);
    }
  });

  test('other engines do not suddenly speak T-SQL', () => {
    for (const engine of ['mysql', 'postgres', 'clickhouse', 'duckdb']) {
      const theirs = new Set(keywordCatalog(engine).map(i => i.label));
      for (const kw of ['MERGE INTO', 'CROSS APPLY', 'IDENTITY(1,1)']) {
        assert.ok(!theirs.has(kw), `${engine} offers ${kw}`);
      }
    }
  });

  test('no-argument functions complete with the caret after the parens', () => {
    const byName = new Map(items.map(i => [i.label, i]));
    assert.equal(byName.get('GETDATE')!.snippet, 'GETDATE()');
    assert.equal(byName.get('NEWID')!.snippet, 'NEWID()');
    assert.equal(byName.get('DATEADD')!.snippet, 'DATEADD(${})');
  });
});

describe('bracket quoting (sqlIdent)', () => {
  test('quoteIdent brackets, escaping ] as ]]', () => {
    assert.equal(quoteIdent('orders', 'sqlserver'), '[orders]');
    assert.equal(quoteIdent('a]b', 'sqlserver'), '[a]]b]');
    assert.equal(quoteIdent('x].[y', 'sqlserver'), '[x]].[y]');
  });

  test('safeIdent leaves plain names bare and brackets the rest', () => {
    assert.equal(safeIdent('orders', 'sqlserver'), 'orders');
    assert.equal(safeIdent('OrderItems', 'sqlserver'), 'OrderItems'); // no case folding
    assert.equal(safeIdent('order', 'sqlserver'), '[order]');          // reserved union
    assert.equal(safeIdent('my table', 'sqlserver'), '[my table]');
    assert.equal(safeIdent('1st', 'sqlserver'), '[1st]');
  });

  test('T-SQL-only reserved words are quoted only for sqlserver', () => {
    for (const w of ['merge', 'top', 'output', 'pivot', 'identity', 'bulk']) {
      assert.equal(safeIdent(w, 'sqlserver'), `[${w}]`, `${w} must quote on sqlserver`);
      // …and MySQL/PG quoting decisions did not move.
      assert.equal(needsQuote(w, 'mysql'), false, `${w} must stay bare on mysql`);
      assert.equal(needsQuote(w, 'postgres'), false, `${w} must stay bare on postgres`);
    }
  });

  test('safePath quotes each part and passes bracketed parts through', () => {
    assert.equal(safePath(['dbo', 'order'], 'sqlserver'), 'dbo.[order]');
    assert.equal(safePath(['[dbo]', 'order details'], 'sqlserver'), '[dbo].[order details]');
  });

  test('isQuoted / unquoteIdent understand brackets', () => {
    assert.ok(isQuoted('[orders]'));
    assert.equal(unquoteIdent('[a]]b]'), 'a]b');
    assert.equal(unquoteIdent('[orders]'), 'orders');
  });

  test('a backslash is data in a T-SQL literal; quotes double', () => {
    assert.equal(escapeLiteral("o'brien", 'sqlserver'), "o''brien");
    assert.equal(escapeLiteral('C:\\data', 'sqlserver'), 'C:\\data');
    assert.equal(sqlLiteral("it's C:\\x", 'sqlserver'), "'it''s C:\\x'");
  });
});
