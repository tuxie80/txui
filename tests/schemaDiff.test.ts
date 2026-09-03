/**
 * MySQL schema comparison / migration generation (src/utils/schemaDiff.ts) —
 * WP-08 regressions:
 *  8.2: information_schema stores plain string defaults UNQUOTED, so a
 *       letter-leading default like `active` must be emitted as a literal
 *       (`DEFAULT 'active'`), never raw; only CURRENT_TIMESTAMP/NULL and
 *       extra=DEFAULT_GENERATED expressions pass through raw.
 *  8.5: index fingerprints keep prefix lengths / functional parts, the
 *       rebuilt ADD INDEX quotes every column, and identical prefixed
 *       indexes do not false-diff.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffSnapshots, generateMigration } from '../src/utils/schemaDiff.ts';
import type { Snapshot, TableInfo, ColumnInfo } from '../src/utils/schemaDiff.ts';

function col(over: Partial<ColumnInfo> = {}): ColumnInfo {
  return { pos: 1, type: 'varchar(20)', nullable: 'YES', dflt: '', charset: '', collation: '', extra: '', ...over };
}

function table(over: Partial<TableInfo> = {}): TableInfo {
  return {
    engine: 'InnoDB', rowFormat: '', collation: '', comment: '', partitionBy: '',
    columns: new Map(), indexes: new Map(), indexDdl: new Map(),
    constraints: new Map(), constraintDdl: new Map(),
    ...over,
  };
}

function snap(schema: string, over: Partial<Snapshot> = {}): Snapshot {
  return {
    engine: 'mysql', schema, charset: 'utf8mb4', collation: 'utf8mb4_general_ci',
    tables: new Map(), views: new Map(), routines: new Map(), triggers: new Map(),
    events: new Map(), matviews: new Map(), sequences: new Map(), types: new Map(),
    viewDdl: new Map(), viewDeps: new Map(),
    ...over,
  };
}

const noDdl = async () => { throw new Error('no ddl'); };

/** Migration where the LEFT table has `columns`/`indexes` the RIGHT lacks. */
async function migrationForAdds(
  columns: [string, ColumnInfo][],
  indexes: [string, string][] = [],
): Promise<string> {
  const base: [string, ColumnInfo][] = [['id', col({ type: 'int' })]];
  const l = snap('a');
  l.tables.set('t', table({ columns: new Map([...base, ...columns]), indexes: new Map(indexes) }));
  const r = snap('b');
  r.tables.set('t', table({ columns: new Map(base) }));
  return generateMigration(diffSnapshots(l, r), l, r, noDdl);
}

// ── 8.2: string defaults are literals, expressions stay raw ────────────────

test('a letter-leading string default is quoted, not emitted raw', async () => {
  const out = await migrationForAdds([['status', col({ dflt: 'active' })]]);
  assert.match(out, /ADD COLUMN `status` varchar\(20\) NULL DEFAULT 'active'/);
  assert.ok(!/DEFAULT active\b/.test(out), 'raw unquoted default leaked into DDL');
});

test('CURRENT_TIMESTAMP stays a raw expression', async () => {
  const out = await migrationForAdds([
    ['at', col({ type: 'datetime', dflt: 'CURRENT_TIMESTAMP' })],
    ['at6', col({ type: 'datetime(6)', dflt: 'CURRENT_TIMESTAMP(6)' })],
  ]);
  assert.match(out, /`at` datetime NULL DEFAULT CURRENT_TIMESTAMP\b/);
  assert.match(out, /`at6` datetime\(6\) NULL DEFAULT CURRENT_TIMESTAMP\(6\)/);
});

test('a DEFAULT_GENERATED expression default is emitted raw, parenthesized', async () => {
  const out = await migrationForAdds([
    ['uid', col({ type: 'char(36)', dflt: 'uuid()', extra: 'DEFAULT_GENERATED' })],
  ]);
  assert.match(out, /`uid` char\(36\) NULL DEFAULT \(uuid\(\)\)/);
  // the metadata marker itself must not be re-emitted as DDL
  assert.ok(!/DEFAULT_GENERATED/.test(out), 'DEFAULT_GENERATED leaked into DDL');
});

// ── 8.5: index fidelity + quoting ───────────────────────────────────────────

test('identical prefixed indexes do not false-diff', () => {
  const mk = () => {
    const s = snap('x');
    s.tables.set('t', table({
      columns: new Map([['name', col()]]),
      indexes: new Map([['idx_name', '(name(10))']]),
    }));
    return s;
  };
  const d = diffSnapshots(mk(), mk()).filter(e => e.status !== 'same');
  assert.equal(d.length, 0, `unexpected diff: ${JSON.stringify(d)}`);
});

test('a rebuilt index keeps its prefix length and quotes the column', async () => {
  const out = await migrationForAdds(
    [['name', col()], ['order', col()]],
    [['idx_pref', '(name(10),order)']],
  );
  assert.match(out, /ADD INDEX `idx_pref` \(`name`\(10\), `order`\)/);
});

test('a functional key part is re-emitted verbatim, never as (null)', async () => {
  const out = await migrationForAdds(
    [['doc', col({ type: 'json' })]],
    [['idx_fn', "((lower(`doc`)),doc(5))"]],
  );
  assert.match(out, /ADD INDEX `idx_fn` \(\(lower\(`doc`\)\), `doc`\(5\)\)/);
  assert.ok(!out.includes('(null)'), 'functional part rendered as (null)');
});
