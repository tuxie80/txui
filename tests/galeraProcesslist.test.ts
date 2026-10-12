/**
 * tests for src/utils/galeraProcesslist.ts — column-by-name parsing across
 * version shapes, the wsrep thread taxonomy (grounded on the live MariaDB
 * 11.8 processlist), merge/sort, per-node summaries, cross-node query
 * grouping, and the PROCESS-privilege heuristic in BOTH directions.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  mergeProcesslists, classifyThread, summarizeNode, groupQueries,
  ownThreadOnly, buildProcessTable, normalizeInfo, groupHeader,
  killableRow,
  PROCESS_GRANT_HINT,
  type NodeProcessResult,
} from '../src/utils/galeraProcesslist.ts';

/** MariaDB 11.8 column order (adds Progress). */
const COLS_MARIADB = ['Id', 'User', 'Host', 'db', 'Command', 'Time', 'State', 'Info', 'Progress'];
/** MySQL 8 column order. */
const COLS_MYSQL8 = ['Id', 'User', 'Host', 'db', 'Command', 'Time', 'State', 'Info'];
/** A reordered variant — name lookup must survive it. */
const COLS_ODD = ['Info', 'Time', 'Command', 'db', 'Host', 'User', 'Id', 'State'];

function node(id: string, columns: string[], rows: string[][], over: Partial<NodeProcessResult> = {}): NodeProcessResult {
  return {
    connectionId: id,
    connectionName: over.connectionName ?? id,
    ok: over.ok ?? true,
    error: over.error ?? null,
    columns,
    rows,
  };
}

/** The live-captured idle-node shape: applier + aborter + the probe itself. */
const IDLE_ROWS = [
  ['1', 'system user', '', '', 'Sleep', '1445', 'wsrep aborter idle', '', '0.000'],
  ['2', 'system user', '', '', 'Sleep', '1445', '', '', '0.000'],
  ['11', 'root', 'localhost:54688', '', 'Query', '0', 'starting', 'SHOW FULL PROCESSLIST', '0.000'],
];

describe('classifyThread', () => {
  test('the live MariaDB 11.8 rows classify as expected', () => {
    assert.equal(classifyThread({ user: 'system user', command: 'Sleep', state: 'wsrep aborter idle' }), 'rollbacker');
    assert.equal(classifyThread({ user: 'system user', command: 'Sleep', state: '' }), 'applier');
    assert.equal(classifyThread({ user: 'root', command: 'Query', state: 'starting' }), 'user');
  });

  test('system housekeeping vs user threads', () => {
    assert.equal(classifyThread({ user: 'event_scheduler', command: 'Daemon', state: '' }), 'system');
    assert.equal(classifyThread({ user: 'root', command: 'Daemon', state: '' }), 'system');
    assert.equal(classifyThread({ user: 'app', command: 'Sleep', state: '' }), 'user');
    assert.equal(classifyThread({ user: 'system user', command: 'Query', state: 'wsrep: applying' }), 'applier');
  });
});

describe('mergeProcesslists', () => {
  test('parses by column NAME across version shapes; tags rows with the node', () => {
    const a = node('a', COLS_MARIADB, IDLE_ROWS);
    // Same logical rows, reordered columns.
    const bRows = IDLE_ROWS.map(r => [r[7], r[5], r[4], r[3], r[2], r[1], r[0], r[6]]);
    const b = node('b', COLS_ODD, bRows);
    const rows = mergeProcesslists([a, b]);
    assert.equal(rows.length, 6);
    const probe = rows.find(r => r.nodeName === 'b' && r.user === 'root')!;
    assert.equal(probe.info, 'SHOW FULL PROCESSLIST');
    assert.equal(probe.timeS, 0);
    const aborter = rows.find(r => r.nodeName === 'a' && r.state === 'wsrep aborter idle')!;
    assert.equal(aborter.kind, 'rollbacker');
    assert.equal(aborter.timeS, 1445);
  });

  test('failed nodes contribute nothing; NULL-ish cells degrade; sorted longest first', () => {
    const rows = mergeProcesslists([
      node('dead', COLS_MYSQL8, [], { ok: false, error: 'connection refused' }),
      node('m8', COLS_MYSQL8, [
        ['5', 'app', 'web:1', 'shop', 'Query', '42', 'executing', 'UPDATE t SET x=1'],
        ['6', 'app', 'web:2', 'shop', 'Query', '3', 'executing', 'SELECT 1'],
      ]),
    ]);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].timeS, 42, 'longest-running first');
    assert.equal(rows[0].nodeName, 'm8');
    assert.equal(rows[0].kind, 'user');
  });
});

describe('killableRow', () => {
  test('only user threads with a numeric id qualify', () => {
    const rows = mergeProcesslists([node('a', COLS_MARIADB, IDLE_ROWS)]);
    const byId = new Map(rows.map(r => [r.id, r]));
    assert.equal(killableRow(byId.get('11')!), true, 'the root user thread');
    assert.equal(killableRow(byId.get('1')!), false, 'the rollbacker');
    assert.equal(killableRow(byId.get('2')!), false, 'the applier');
  });

  test('a non-numeric or empty id is never killable', () => {
    const user = mergeProcesslists([node('a', COLS_MYSQL8, [
      ['11', 'root', 'localhost:1', '', 'Query', '0', 'starting', 'SELECT 1'],
    ])])[0];
    assert.equal(killableRow(user), true);
    assert.equal(killableRow({ ...user, id: '' }), false);
    assert.equal(killableRow({ ...user, id: '12abc' }), false);
    assert.equal(killableRow({ ...user, id: ' 12' }), false);
    assert.equal(killableRow({ ...user, id: '12 ' }), false);
  });

  test('system housekeeping is refused even with a numeric id', () => {
    const sys = mergeProcesslists([node('a', COLS_MYSQL8, [
      ['7', 'event_scheduler', '', '', 'Daemon', '100', '', ''],
    ])])[0];
    assert.equal(sys.kind, 'system');
    assert.equal(killableRow(sys), false);
  });
});

describe('summarizeNode', () => {
  test('user queries, applier active vs idle, longest query', () => {
    const s = summarizeNode(mergeProcesslists([node('a', COLS_MARIADB, IDLE_ROWS)]));
    assert.equal(s.userQueries, 1, 'the probe itself');
    assert.equal(s.appliersActive, 0);
    assert.equal(s.appliersIdle, 1);
    assert.equal(s.longestQueryS, 0);
  });
});

describe('groupQueries', () => {
  const apply = (id: string) =>
    [id, 'system user', '', '', 'Query', '4', 'applying', 'UPDATE   orders\nSET status = \'shipped\'  WHERE id = 9', '0.000'];
  test('identical normalized Info across nodes groups; single-node does not', () => {
    const rows = mergeProcesslists([
      node('a', COLS_MARIADB, [apply('2')]),
      node('b', COLS_MARIADB, [apply('2')]),
      node('c', COLS_MARIADB, [['7', 'app', 'h', 'db', 'Query', '9', 'executing', 'SELECT * FROM t', '0.000']]),
    ]);
    const groups = groupQueries(rows);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].perNode.length, 2);
    assert.equal(groups[0].totalCount, 2);
    assert.equal(groups[0].allAppliers, true);
    assert.equal(groupHeader(groups[0]), '×2 nodes — writeset apply');
    // The single-node SELECT never groups.
    assert.ok(!groups.some(g => g.info.includes('SELECT')));
  });

  test('whitespace differences still group; empty Info never does', () => {
    assert.equal(normalizeInfo('UPDATE   orders\nSET x=1'), 'UPDATE orders SET x=1');
    const rows = mergeProcesslists([
      node('a', COLS_MARIADB, [['1', 'app', 'h', 'd', 'Query', '1', 'e', 'SELECT  1', '0']]),
      node('b', COLS_MARIADB, [['1', 'app', 'h', 'd', 'Query', '1', 'e', 'SELECT 1', '0']]),
      node('c', COLS_MARIADB, [['1', 'app', 'h', 'd', 'Sleep', '1', '', '', '0']]),
      node('d', COLS_MARIADB, [['1', 'app', 'h', 'd', 'Sleep', '1', '', '', '0']]),
    ]);
    const groups = groupQueries(rows);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].info, 'SELECT 1');
    assert.equal(groups[0].allAppliers, false);
    assert.equal(groupHeader(groups[0]), '×2 nodes');
  });
});

describe('ownThreadOnly — the PROCESS-privilege heuristic', () => {
  test('unprivileged shape: own probe only, zero appliers on EVERY node → true', () => {
    const probeOnly = (id: string) => node(id, COLS_MYSQL8, [
      ['11', 'app', 'localhost:1', '', 'Query', '0', 'starting', 'SHOW FULL PROCESSLIST'],
    ]);
    assert.equal(ownThreadOnly([probeOnly('a'), probeOnly('b'), probeOnly('c')]), true);
  });

  test('idle cluster WITH appliers → false (the discriminating signal)', () => {
    assert.equal(ownThreadOnly([
      node('a', COLS_MARIADB, IDLE_ROWS),
      node('b', COLS_MARIADB, IDLE_ROWS),
    ]), false);
  });

  test('a dead node does not decide; NO answering node → false', () => {
    const probeOnly = node('a', COLS_MYSQL8, [
      ['11', 'app', 'localhost:1', '', 'Query', '0', 'starting', 'SHOW FULL PROCESSLIST'],
    ]);
    const dead = node('b', [], [], { ok: false, error: 'refused' });
    assert.equal(ownThreadOnly([probeOnly, dead]), true, 'the answering node still decides');
    assert.equal(ownThreadOnly([dead]), false, 'nothing answered — nothing to conclude');
  });
});

describe('buildProcessTable', () => {
  test('hint, groups, singles, system collapsible and unreachable in one pass', () => {
    const model = buildProcessTable([
      node('a', COLS_MARIADB, [
        ...IDLE_ROWS,
        ['12', 'app', 'web:1', 'shop', 'Query', '61', 'executing', 'UPDATE t SET x=1', '0.000'],
      ]),
      node('b', COLS_MARIADB, [
        ...IDLE_ROWS,
        ['12', 'app', 'web:1', 'shop', 'Query', '61', 'executing', 'UPDATE t SET x=1', '0.000'],
      ]),
      node('dead', [], [], { ok: false, error: 'timeout after 30s' }),
    ]);
    assert.equal(model.hint, null, 'appliers are visible — privileged shape');
    assert.equal(model.groups.length, 1, 'the UPDATE runs on both nodes');
    assert.equal(model.singles.length, 2, 'the two probe threads themselves');
    assert.equal(model.systemByNode.length, 2);
    assert.ok(model.systemByNode.every(s => s.rows.every(r => r.kind !== 'user')));
    assert.deepEqual(model.unreachable, [
      { connectionId: 'dead', nodeName: 'dead', error: 'timeout after 30s' },
    ]);
  });

  test('the unprivileged shape surfaces the grant hint', () => {
    const model = buildProcessTable([
      node('a', COLS_MYSQL8, [['1', 'app', 'h', '', 'Query', '0', 'starting', 'SHOW FULL PROCESSLIST']]),
    ]);
    assert.equal(model.hint, PROCESS_GRANT_HINT);
  });
});
