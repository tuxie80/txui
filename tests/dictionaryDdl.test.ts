/**
 * ClickHouse dictionary DDL (src/utils/dictionaryDdl.ts).
 *
 * A dictionary's failure modes are structural: an unquoted reserved-word name,
 * a SOURCE or LAYOUT assembled into the wrong shape, or a LIFETIME that reads
 * back as one number when it meant a range. The builder is pure, so `node
 * --test` covers every branch without a ClickHouse server.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  createSql, dropSql, changesFor, parseDictionary, sourceSql, layoutSql, lifetimeSql,
  isBuildable, blankDict, listSql, schemaListSql, worstRisk, toScript,
  type DictDef,
} from '../src/utils/dictionaryDdl.ts';

const dict = (over: Partial<DictDef> = {}): DictDef => ({
  schema: 'app', name: 'geo',
  attrs: [{ name: 'id', type: 'UInt64' }, { name: 'city', type: 'String', default: "''" }],
  primaryKey: 'id',
  source: { kind: 'CLICKHOUSE', host: 'localhost', port: '9000', user: 'default', db: 'app', table: 'cities' },
  layout: { kind: 'FLAT' },
  lifetime: { min: '300', max: '600' },
  ...over,
});

describe('creating a dictionary', () => {
  test('a full CREATE DICTIONARY with backtick-quoted identifiers', () => {
    const sql = createSql(dict());
    assert.match(sql, /^CREATE DICTIONARY `app`\.`geo`/);
    assert.match(sql, /`id` UInt64/);
    assert.match(sql, /`city` String DEFAULT ''/);
    assert.match(sql, /PRIMARY KEY `id`/);
    assert.match(sql, /SOURCE\(CLICKHOUSE\(host 'localhost' port 9000 user 'default' db 'app' table 'cities'\)\)/);
    assert.match(sql, /LAYOUT\(FLAT\(\)\)/);
    assert.match(sql, /LIFETIME\(MIN 300 MAX 600\)/);
  });

  test('editing uses CREATE OR REPLACE', () => {
    const sql = createSql(dict(), true);
    assert.match(sql, /^CREATE OR REPLACE DICTIONARY `app`\.`geo`/);
  });

  test('a reserved-word name is quoted so it still resolves', () => {
    const sql = createSql(dict({ name: 'order' }));
    assert.match(sql, /DICTIONARY `app`\.`order`/);
  });

  test('an empty schema is not qualified', () => {
    const sql = createSql(dict({ schema: '' }));
    assert.match(sql, /CREATE DICTIONARY `geo`/);
  });

  test('a composite primary key quotes each part', () => {
    const sql = createSql(dict({ primaryKey: 'country, city' }));
    assert.match(sql, /PRIMARY KEY `country`, `city`/);
  });

  test('an attribute without a name or type is dropped', () => {
    const sql = createSql(dict({ attrs: [{ name: 'id', type: 'UInt64' }, { name: '', type: '' }] }));
    assert.match(sql, /\(\n\s*`id` UInt64\n\)/);
  });

  test('a raw override is emitted verbatim, semicolon trimmed', () => {
    const sql = createSql(dict({ raw: 'CREATE DICTIONARY exotic (...) ;' }));
    assert.equal(sql, 'CREATE DICTIONARY exotic (...)');
  });
});

describe('SOURCE clauses', () => {
  test('CLICKHOUSE omits empty fields', () => {
    assert.equal(
      sourceSql({ kind: 'CLICKHOUSE', host: 'h', port: '9000', table: 't' }),
      "SOURCE(CLICKHOUSE(host 'h' port 9000 table 't'))");
  });
  test('HTTP with url and format', () => {
    assert.equal(
      sourceSql({ kind: 'HTTP', url: 'http://x/d.csv', format: 'CSV' }),
      "SOURCE(HTTP(url 'http://x/d.csv' format 'CSV'))");
  });
  test('FILE with path and format', () => {
    assert.equal(
      sourceSql({ kind: 'FILE', path: '/tmp/d.tsv', format: 'TSV' }),
      "SOURCE(FILE(path '/tmp/d.tsv' format 'TSV'))");
  });
  test('CUSTOM passes the free-text body through', () => {
    assert.equal(
      sourceSql({ kind: 'CUSTOM', raw: "MYSQL(host 'h' db 'd' table 't')" }),
      "SOURCE(MYSQL(host 'h' db 'd' table 't'))");
  });
});

describe('LAYOUT and LIFETIME clauses', () => {
  test('the parameterless layouts', () => {
    assert.equal(layoutSql({ kind: 'FLAT' }), 'LAYOUT(FLAT())');
    assert.equal(layoutSql({ kind: 'HASHED' }), 'LAYOUT(HASHED())');
    assert.equal(layoutSql({ kind: 'COMPLEX_KEY_HASHED' }), 'LAYOUT(COMPLEX_KEY_HASHED())');
  });
  test('CACHE carries size_in_cells', () => {
    assert.equal(layoutSql({ kind: 'CACHE', size: '5000' }), 'LAYOUT(CACHE(size_in_cells 5000))');
  });
  test('a range LIFETIME uses MIN/MAX; equal bounds collapse to one value', () => {
    assert.equal(lifetimeSql({ min: '300', max: '600' }), 'LIFETIME(MIN 300 MAX 600)');
    assert.equal(lifetimeSql({ min: '300', max: '300' }), 'LIFETIME(300)');
  });
});

describe('changesFor and buildability', () => {
  test('a not-yet-buildable draft produces nothing', () => {
    assert.deepEqual(changesFor(null, dict({ name: '' })), []);
    assert.deepEqual(changesFor(null, dict({ primaryKey: '' })), []);
    assert.equal(isBuildable(dict({ attrs: [{ name: '', type: '' }] })), false);
  });

  test('a new dictionary is a single safe CREATE', () => {
    const cs = changesFor(null, dict());
    assert.equal(cs.length, 1);
    assert.equal(cs[0].kind, 'create');
    assert.doesNotMatch(cs[0].sql, /OR REPLACE/);
    assert.equal(worstRisk(cs), 'safe');
  });

  test('editing an existing dictionary is a single CREATE OR REPLACE', () => {
    const cs = changesFor(dict(), dict({ lifetime: { min: '0', max: '0' } }));
    assert.equal(cs.length, 1);
    assert.equal(cs[0].kind, 'replace');
    assert.match(cs[0].sql, /CREATE OR REPLACE DICTIONARY/);
    assert.match(toScript(cs), /;$/);
  });

  test('a raw override is buildable on name alone', () => {
    assert.equal(isBuildable(dict({ attrs: [], primaryKey: '', raw: 'CREATE DICTIONARY x' })), true);
  });
});

describe('dropping', () => {
  test('DROP DICTIONARY, and IF EXISTS when asked', () => {
    assert.equal(dropSql(dict()), 'DROP DICTIONARY `app`.`geo`');
    assert.equal(dropSql(dict(), { ifExists: true }), 'DROP DICTIONARY IF EXISTS `app`.`geo`');
  });
});

describe('parseDictionary: reading get_ddl output back', () => {
  test('round-trips a CLICKHOUSE-source dictionary through the form', () => {
    const ddl = createSql(dict());
    const p = parseDictionary(ddl);
    assert.deepEqual(p.attrs, [
      { name: 'id', type: 'UInt64' },
      { name: 'city', type: 'String', default: "''" },
    ]);
    assert.equal(p.primaryKey, 'id');
    assert.equal(p.source?.kind, 'CLICKHOUSE');
    assert.equal(p.source?.host, 'localhost');
    assert.equal(p.source?.table, 'cities');
    assert.equal(p.layout?.kind, 'FLAT');
    assert.deepEqual(p.lifetime, { min: '300', max: '600' });
  });

  test('reads a CACHE layout size and an HTTP source', () => {
    const ddl = createSql(dict({
      source: { kind: 'HTTP', url: 'http://x/d', format: 'CSV' },
      layout: { kind: 'CACHE', size: '2048' },
      lifetime: { min: '60', max: '60' },
    }));
    const p = parseDictionary(ddl);
    assert.equal(p.source?.kind, 'HTTP');
    assert.equal(p.source?.url, 'http://x/d');
    assert.equal(p.layout?.kind, 'CACHE');
    assert.equal(p.layout?.size, '2048');
    assert.deepEqual(p.lifetime, { min: '60', max: '60' });
  });
});

describe('reading helpers name the right catalogs', () => {
  test('schema list is system.databases', () => {
    assert.match(schemaListSql(), /system\.databases/);
  });
  test('dictionary list is system.dictionaries, filtered by database', () => {
    assert.match(listSql('app'), /system\.dictionaries/);
    assert.match(listSql('app'), /database = 'app'/);
  });
  test('blankDict starts buildable-ready with an id key', () => {
    const b = blankDict('app');
    assert.equal(b.primaryKey, 'id');
    assert.equal(b.layout.kind, 'FLAT');
  });
});
