/**
 * Sequence DDL (src/utils/sequenceDdl.ts).
 *
 * A sequence is small enough to look harmless and is usually feeding a primary
 * key, so the failures here are not cosmetic: a rewound sequence produces
 * duplicate-key errors in the application, and a silently rounded bound
 * changes a sequence nobody asked to change.
 *
 * Both dialects were checked against live servers — PostgreSQL 17 and
 * MariaDB 11.8 — including which `ALTER` clauses each accepts.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  createSql, dropSql, alterSql, restartSql, listSql, readSql, worstRisk, toScript,
  type SequenceDef,
} from '../src/utils/sequenceDdl.ts';

const def = (over: Partial<SequenceDef> = {}): SequenceDef => ({
  schema: 'app', name: 's_order',
  start: '1', increment: '1',
  minValue: '1', maxValue: '9223372036854775807',
  cache: '1', cycle: false,
  ...over,
});

describe('bigint is never a number', () => {
  /**
   * The default maximum of a bigint sequence is 9223372036854775807, which as
   * a JavaScript number is 9223372036854776000. Round-tripping a sequence
   * through `number` therefore *changes* it — on a sequence the user only
   * opened to look at.
   */
  test('the bigint maximum survives a round trip intact', () => {
    const sql = createSql(def(), 'postgres');
    assert.match(sql, /MAXVALUE 9223372036854775807/);
    assert.doesNotMatch(sql, /9223372036854776000/, 'the bound was rounded through a float');
  });

  test('an unchanged bigint bound generates no ALTER', () => {
    const d = def();
    assert.deepEqual(alterSql(d, def(), 'postgres'), [],
      'a value that did not change was reported as changed');
  });

  /// Comparison has to be exact too — two bigints that differ only beyond
  /// 2^53 are equal as floats.
  test('bounds differing only past 2^53 still register as a change', () => {
    const before = def({ maxValue: '9223372036854775807' });
    const after = def({ maxValue: '9223372036854775806' });
    assert.equal(alterSql(before, after, 'postgres').length, 1);
  });
});

describe('creating', () => {
  test('PostgreSQL gets every clause it was given', () => {
    const sql = createSql(def({ start: '100', increment: '5', minValue: '1',
      maxValue: '9999', cache: '10', cycle: true, dataType: 'integer' }), 'postgres');
    assert.match(sql, /CREATE SEQUENCE "app"\."s_order"/);
    assert.match(sql, /AS integer/);
    assert.match(sql, /START WITH 100/);
    assert.match(sql, /INCREMENT BY 5/);
    assert.match(sql, /CACHE 10/);
    assert.match(sql, /\bCYCLE\b/);
  });

  test('MariaDB uses backticks and has no type clause', () => {
    const sql = createSql(def({ dataType: 'integer' }), 'mariadb');
    assert.match(sql, /CREATE SEQUENCE `app`\.`s_order`/);
    assert.doesNotMatch(sql, /AS integer/, 'MariaDB sequences are always bigint');
  });

  /// One space apart, and a syntax error on the other engine.
  test('NO CYCLE is spelled differently on each', () => {
    assert.match(createSql(def(), 'postgres'), /NO CYCLE/);
    assert.match(createSql(def(), 'mariadb'), /NOCYCLE/);
    assert.doesNotMatch(createSql(def(), 'mariadb'), /NO CYCLE/);
  });

  test('OWNED BY is PostgreSQL-only', () => {
    const d = def({ ownedBy: '"app"."orders"."id"' });
    assert.match(createSql(d, 'postgres'), /OWNED BY/);
    assert.doesNotMatch(createSql(d, 'mariadb'), /OWNED BY/);
  });

  /// Anything not an integer must not reach the statement — these fields are
  /// typed into a form.
  test('a non-numeric bound is dropped rather than interpolated', () => {
    const sql = createSql(def({ cache: '1; DROP TABLE users --' }), 'postgres');
    assert.doesNotMatch(sql, /DROP TABLE/);
    assert.doesNotMatch(sql, /CACHE/);
  });

  test('an empty bound simply omits its clause', () => {
    const sql = createSql(def({ maxValue: '', minValue: '' }), 'postgres');
    assert.doesNotMatch(sql, /MAXVALUE/);
    assert.doesNotMatch(sql, /MINVALUE/);
    assert.match(sql, /START WITH 1/);
  });
});

describe('altering', () => {
  test('only what changed is emitted', () => {
    const changes = alterSql(def(), def({ increment: '5' }), 'postgres');
    assert.equal(changes.length, 1);
    assert.match(changes[0].sql, /INCREMENT BY 5/);
  });

  test('several changes become several statements against the same sequence', () => {
    const changes = alterSql(def(), def({ increment: '5', cache: '20', cycle: true }), 'postgres');
    assert.equal(changes.length, 3);
    assert.ok(changes.every(c => c.sql.includes('"app"."s_order"')));
  });

  /// Lowering the ceiling is not a formatting change — the sequence stops
  /// working when it arrives there.
  test('lowering the maximum is flagged, raising it is not', () => {
    const down = alterSql(def(), def({ maxValue: '100' }), 'postgres')[0];
    assert.equal(down.risk, 'lossy');
    assert.match(down.warning!, /every further request fails/);

    const up = alterSql(def({ maxValue: '100' }), def(), 'postgres')[0];
    assert.equal(up.risk, 'safe');
  });

  test('turning CYCLE on says values will be reissued', () => {
    const c = alterSql(def(), def({ cycle: true }), 'postgres')[0];
    assert.equal(c.risk, 'lossy');
    assert.match(c.warning!, /already given out/);
  });

  test('turning CYCLE off is safe and uses the engine spelling', () => {
    const pg = alterSql(def({ cycle: true }), def(), 'postgres')[0];
    assert.equal(pg.risk, 'safe');
    assert.match(pg.sql, /NO CYCLE/);
    assert.match(alterSql(def({ cycle: true }), def(), 'mariadb')[0].sql, /NOCYCLE/);
  });

  test('narrowing the type is flagged on PostgreSQL and absent on MariaDB', () => {
    const pg = alterSql(def({ dataType: 'bigint' }), def({ dataType: 'integer' }), 'postgres');
    assert.equal(pg[0].risk, 'lossy');
    assert.equal(
      alterSql(def({ dataType: 'bigint' }), def({ dataType: 'integer' }), 'mariadb').length, 0);
  });

  /**
   * The important omission. `lastValue` advances by itself every time the
   * sequence is used, so a diff that included it would generate a RESTART from
   * whatever the value happened to be when the form was opened — quietly
   * rewinding a live sequence.
   */
  test('a moved position never becomes an ALTER', () => {
    const before = def({ lastValue: '100' });
    const after = def({ lastValue: '5000' });
    assert.deepEqual(alterSql(before, after, 'postgres'), []);
  });
});

describe('restarting', () => {
  test('it is its own act and is marked destructive', () => {
    const c = restartSql(def(), '500', 'postgres');
    assert.equal(c.kind, 'restart');
    assert.equal(c.risk, 'destructive');
    assert.match(c.sql, /RESTART WITH 500/);
  });

  /// The warning has to name the consequence, which happens somewhere else.
  test('the warning says where the failure will appear', () => {
    const c = restartSql(def(), '1', 'postgres');
    assert.match(c.warning!, /collides with an existing row/);
    assert.match(c.warning!, /application/);
  });

  test('a non-numeric restart falls back to 1 rather than injecting', () => {
    const c = restartSql(def(), 'DROP TABLE users', 'postgres');
    assert.match(c.sql, /RESTART WITH 1$/);
    assert.doesNotMatch(c.sql, /DROP TABLE/);
  });
});

describe('dropping', () => {
  test('CASCADE is offered on PostgreSQL only', () => {
    assert.match(dropSql(def(), 'postgres', true), /CASCADE$/);
    assert.doesNotMatch(dropSql(def(), 'mariadb', true), /CASCADE/);
  });

  test('without cascade it is a plain drop', () => {
    assert.equal(dropSql(def(), 'postgres'), 'DROP SEQUENCE "app"."s_order"');
  });
});

describe('reading', () => {
  /// Sequences arrived in MariaDB 10.3 and information_schema.SEQUENCES only
  /// in 11.0, so listing from the view would report none on 10.6 — which has
  /// them.
  test('MariaDB lists from TABLES, not from the 11.0-only view', () => {
    const sql = listSql('app', 'mariadb');
    assert.match(sql, /TABLE_TYPE = 'SEQUENCE'/);
    assert.doesNotMatch(sql, /information_schema\.SEQUENCES/i);
  });

  test('PostgreSQL lists from pg_sequences', () => {
    assert.match(listSql('app', 'postgres'), /FROM pg_sequences/);
  });

  /// Casting in the query, not the client: a bigint that arrives as a JSON
  /// number has already lost precision.
  test('both read every value as text', () => {
    assert.match(readSql('app', 's', 'postgres'), /max_value::text/);
    assert.match(readSql('app', 's', 'mariadb'), /CAST\(maximum_value AS CHAR\)/);
  });

  test('a quote in a schema name cannot break the literal', () => {
    const sql = listSql("it's", 'postgres');
    assert.match(sql, /'it''s'/);
  });
});

describe('risk and script', () => {
  test('the worst risk wins', () => {
    assert.equal(worstRisk([]), 'safe');
    assert.equal(worstRisk(alterSql(def(), def({ cycle: true }), 'postgres')), 'lossy');
    assert.equal(worstRisk([restartSql(def(), '1', 'postgres')]), 'destructive');
  });

  test('the script is the statements, semicolon-terminated', () => {
    const s = toScript(alterSql(def(), def({ increment: '5', cache: '9' }), 'postgres'));
    assert.equal(s.split('\n').length, 2);
    assert.ok(s.split('\n').every(l => l.endsWith(';')));
  });
});

// ── SQL Server ───────────────────────────────────────────────────────────────
//
// SQL Server has real sequence objects (2012+), which MySQL proper does not —
// AUTO_INCREMENT is a column property, not an object. Every statement below was
// verified against SQL Server 2022 before being asserted here.

test('SQL Server quotes with brackets and qualifies with the schema', () => {
  const def = { schema: 'sales', name: 'invoice_seq', start: '1000', increment: '1',
                minValue: '1', maxValue: '9223372036854775807', cache: '50', cycle: false };
  assert.match(createSql(def, 'sqlserver'), /CREATE SEQUENCE \[sales\]\.\[invoice_seq\]/);
});

test('SQL Server says NO CYCLE with a space, like PostgreSQL and unlike MariaDB', () => {
  // One space, and the statement is a syntax error on the other engine.
  const def = { schema: 's', name: 'q', start: '1', increment: '1',
                minValue: '1', maxValue: '10', cache: '1', cycle: false };
  assert.match(createSql(def, 'sqlserver'), /NO CYCLE$/);
  assert.match(createSql(def, 'mariadb'), /NOCYCLE$/);
});

test('SQL Server can narrow the data type, as PostgreSQL can', () => {
  const def = { schema: 's', name: 'q', dataType: 'int', start: '1', increment: '1',
                minValue: '1', maxValue: '10', cache: '1', cycle: false };
  assert.match(createSql(def, 'sqlserver'), /AS int/);
  // MariaDB has only bigint, so the clause must not appear there.
  assert.ok(!/AS int/.test(createSql({ ...def }, 'mariadb')));
});

test('SQL Server reads the catalog, casting every number to text', () => {
  // start/min/max/current are sql_variant; the CAST is not cosmetic. A bigint
  // that reaches a JS number has already lost precision — the whole reason this
  // module carries values as strings.
  const sql = readSql('sales', 'invoice_seq', 'sqlserver');
  assert.match(sql, /sys\.sequences/);
  assert.match(sql, /CAST\(s\.start_value AS varchar/);
  assert.match(sql, /CAST\(s\.maximum_value AS varchar/);
  // current_value is NULL until first use; start_value is the honest answer.
  assert.match(sql, /ISNULL\(s\.current_value, s\.start_value\)/);
});

test('SQL Server lists sequences by schema from sys.sequences', () => {
  const sql = listSql('sales', 'sqlserver');
  assert.match(sql, /FROM sys\.sequences/);
  assert.match(sql, /sc\.name = 'sales'/);
});

test('a SQL Server drop takes no CASCADE, even when asked', () => {
  // Only PostgreSQL has it. Emitting it here would be a syntax error, and
  // silently accepting the flag would imply a guarantee that is not there.
  const def = { schema: 's', name: 'q', start: '1', increment: '1',
                minValue: '1', maxValue: '10', cache: '1', cycle: false };
  assert.equal(dropSql(def, 'sqlserver', true), 'DROP SEQUENCE [s].[q]');
});

test('SQL Server alters emit only what changed', () => {
  const cur = { schema: 's', name: 'q', start: '1', increment: '1',
                minValue: '1', maxValue: '100', cache: '10', cycle: false };
  const next = { ...cur, increment: '3', cycle: true };
  const sqls = alterSql(cur, next, 'sqlserver').map(c => c.sql);
  assert.deepEqual(sqls, [
    'ALTER SEQUENCE [s].[q] INCREMENT BY 3',
    'ALTER SEQUENCE [s].[q] CYCLE',
  ]);
});

test('a SQL Server restart is still flagged destructive', () => {
  const def = { schema: 's', name: 'q', start: '1', increment: '1',
                minValue: '1', maxValue: '100', cache: '10', cycle: false };
  const c = restartSql(def, '20', 'sqlserver');
  assert.equal(c.risk, 'destructive');
  assert.equal(c.sql, 'ALTER SEQUENCE [s].[q] RESTART WITH 20');
});
