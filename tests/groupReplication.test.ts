/**
 * tests for src/utils/groupReplication.ts — parsing the performance_schema
 * member/stats/clone rows, the three-way plugin detection, every health rule
 * firing and not firing, and tolerance for the column sets of different
 * MySQL versions (8.4 prefixes both tables with CHANNEL_NAME; early 8.0/5.7
 * lack MEMBER_ROLE / MEMBER_VERSION; older stats tables lack the applier
 * counters). Missing columns must degrade rules, never crash them.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  grPluginState, parseGrMembers, parseGrStats, parseGrIdentity, parseGrSnapshot,
  grStatsFor, grGroupNotStarted, grFindings, grStateHealth,
  parseCloneProgress, GR_QUEUE_WARN, GR_IDENTITY_SQL,
  type GrSnapshot,
} from '../src/utils/groupReplication.ts';

type Cell = string | number | null;
type Row = Cell[];

/** The 8.4 column sets, exactly as SELECT * returns them (captured live). */
const MEMBER_COLS_84 = [
  'CHANNEL_NAME', 'MEMBER_ID', 'MEMBER_HOST', 'MEMBER_PORT',
  'MEMBER_STATE', 'MEMBER_ROLE', 'MEMBER_VERSION', 'MEMBER_COMMUNICATION_STACK',
];
const STATS_COLS_84 = [
  'CHANNEL_NAME', 'VIEW_ID', 'MEMBER_ID',
  'COUNT_TRANSACTIONS_IN_QUEUE', 'COUNT_TRANSACTIONS_CHECKED', 'COUNT_CONFLICTS_DETECTED',
  'COUNT_TRANSACTIONS_ROWS_VALIDATING', 'TRANSACTIONS_COMMITTED_ALL_MEMBERS',
  'LAST_CONFLICT_FREE_TRANSACTION', 'COUNT_TRANSACTIONS_REMOTE_IN_APPLIER_QUEUE',
  'COUNT_TRANSACTIONS_REMOTE_APPLIED', 'COUNT_TRANSACTIONS_LOCAL_PROPOSED',
  'COUNT_TRANSACTIONS_LOCAL_ROLLBACK',
];

const member84 = (over: Partial<Record<'id' | 'host' | 'port' | 'state' | 'role' | 'version', Cell>> = {}): Row => [
  'group_replication_applier',
  over.id ?? 'aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb',
  over.host ?? 'db1', over.port ?? '3306',
  over.state ?? 'ONLINE', over.role ?? 'PRIMARY', over.version ?? '8.4.10',
  'XCom',
];

const stats84 = (over: Partial<Record<'id' | 'certQ' | 'checked' | 'conflicts' | 'applierQ' | 'applied' | 'proposed', Cell>> = {}): Row => [
  'group_replication_applier', '17909695345858925:1',
  over.id ?? 'aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb',
  over.certQ ?? '0', over.checked ?? '3', over.conflicts ?? '0',
  '0', '3f8a1c4e-9d2b-4c7a-8e5f-1a2b3c4d5e6f:1-5', '',
  over.applierQ ?? '0', over.applied ?? '0', over.proposed ?? '3', '0',
];

const identityRow: Row = [
  '3f8a1c4e-9d2b-4c7a-8e5f-1a2b3c4d5e6f', '1', '127.0.0.1:33061', '127.0.0.1:33061',
  'aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb',
];

const snap = (members: Row[], stats: Row[], identity: Row | undefined = identityRow): GrSnapshot =>
  parseGrSnapshot(MEMBER_COLS_84, members, STATS_COLS_84, stats, identity);

describe('grPluginState', () => {
  test('no group_replication row → absent (plain MySQL, every MariaDB)', () => {
    assert.equal(grPluginState([]), 'absent');
    assert.equal(grPluginState([['clone', 'ACTIVE']]), 'absent');
  });
  test('ACTIVE → active', () => {
    assert.equal(grPluginState([['group_replication', 'ACTIVE']]), 'active');
  });
  test('DISABLED / DELETED → inactive (installed, not usable)', () => {
    assert.equal(grPluginState([['group_replication', 'DISABLED']]), 'inactive');
    assert.equal(grPluginState([['group_replication', 'DELETED']]), 'inactive');
  });
});

describe('parseGrMembers', () => {
  test('8.4 row with CHANNEL_NAME prefix and MEMBER_COMMUNICATION_STACK', () => {
    const [m] = parseGrMembers(MEMBER_COLS_84, [member84()]);
    assert.deepEqual(m, {
      id: 'aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb', host: 'db1', port: 3306,
      state: 'ONLINE', role: 'PRIMARY', version: '8.4.10',
    });
  });

  test('5.7-shaped table (no MEMBER_ROLE / MEMBER_VERSION) → nulls, never throws', () => {
    const cols = ['MEMBER_ID', 'MEMBER_HOST', 'MEMBER_PORT', 'MEMBER_STATE'];
    const [m] = parseGrMembers(cols, [['id-1', 'db2', '3307', 'RECOVERING']]);
    assert.deepEqual(m, { id: 'id-1', host: 'db2', port: 3307, state: 'RECOVERING', role: null, version: null });
  });

  test('NULL cells and numeric ports survive', () => {
    const [m] = parseGrMembers(MEMBER_COLS_84, [
      ['group_replication_applier', 'id-2', null, 3307, 'ONLINE', null, null, null],
    ]);
    assert.equal(m.host, null);
    assert.equal(m.port, 3307);
    assert.equal(m.role, null);
  });

  test('empty result → empty member list (group not started signal)', () => {
    assert.deepEqual(parseGrMembers(MEMBER_COLS_84, []), []);
  });
});

describe('parseGrStats', () => {
  test('full 8.4 row, empty GTID text → null', () => {
    const [s] = parseGrStats(STATS_COLS_84, [stats84()]);
    assert.equal(s.memberId, 'aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb');
    assert.equal(s.txChecked, 3);
    assert.equal(s.conflicts, 0);
    assert.equal(s.applierQueue, 0);
    assert.equal(s.committedAllMembers, '3f8a1c4e-9d2b-4c7a-8e5f-1a2b3c4d5e6f:1-5');
    assert.equal(s.lastConflictFree, null);  // '' on a group that never conflicted
  });

  test('older table without the applier counters → those fields null', () => {
    const cols = [
      'VIEW_ID', 'MEMBER_ID', 'COUNT_TRANSACTIONS_IN_QUEUE', 'COUNT_TRANSACTIONS_CHECKED',
      'COUNT_CONFLICTS_DETECTED', 'COUNT_TRANSACTIONS_ROWS_VALIDATING',
      'TRANSACTIONS_COMMITTED_ALL_MEMBERS', 'LAST_CONFLICT_FREE_TRANSACTION',
    ];
    const [s] = parseGrStats(cols, [['v:1', 'id-1', '2', '10', '1', '0', 'g:1-9', 'g:9']]);
    assert.equal(s.certQueue, 2);
    assert.equal(s.conflicts, 1);
    assert.equal(s.applierQueue, null);
    assert.equal(s.remoteApplied, null);
    assert.equal(s.localProposed, null);
  });

  test('non-numeric garbage in a counter → null, not NaN', () => {
    const [s] = parseGrStats(STATS_COLS_84, [stats84({ conflicts: 'oops' })]);
    assert.equal(s.conflicts, null);
  });
});

describe('parseGrIdentity', () => {
  test('the positional identity row parses', () => {
    const id = parseGrIdentity(identityRow);
    assert.deepEqual(id, {
      groupName: '3f8a1c4e-9d2b-4c7a-8e5f-1a2b3c4d5e6f', singlePrimary: true,
      localAddress: '127.0.0.1:33061', seeds: '127.0.0.1:33061',
      serverUuid: 'aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb',
    });
  });
  test('single_primary 0 → false (multi-primary)', () => {
    assert.equal(parseGrIdentity(['g', '0', 'a', 's', 'u']).singlePrimary, false);
  });
  test('missing row → all null', () => {
    const id = parseGrIdentity(undefined);
    assert.equal(id.groupName, null);
    assert.equal(id.singlePrimary, null);
  });
  test('identity SQL names the five expected variables', () => {
    for (const v of ['group_replication_group_name', 'group_replication_single_primary_mode',
      'group_replication_local_address', 'group_replication_group_seeds', 'server_uuid']) {
      assert.ok(GR_IDENTITY_SQL.includes(v), v);
    }
  });
});

describe('grFindings', () => {
  test('healthy single-primary single-node group → no findings', () => {
    assert.deepEqual(grFindings(snap([member84()], [stats84()])), []);
  });

  test('not detected → no findings', () => {
    const s = snap([member84()], [stats84()]);
    s.detected = false;
    assert.deepEqual(grFindings(s), []);
  });

  test('ERROR member → crit; UNREACHABLE member → crit', () => {
    const f = grFindings(snap(
      [member84({ state: 'ERROR' }), member84({ id: 'm2', host: 'db2', state: 'UNREACHABLE', role: 'SECONDARY' })],
      [stats84()],
    ));
    assert.equal(f.filter(x => x.level === 'crit').length, 2);
    assert.ok(f.some(x => x.title.includes('ERROR')));
    assert.ok(f.some(x => x.title.includes('UNREACHABLE')));
  });

  test('OFFLINE member → warn naming START GROUP_REPLICATION', () => {
    const f = grFindings(snap([member84({ state: 'OFFLINE', role: null })], [stats84()]));
    assert.equal(f.length, 1);
    assert.equal(f[0].level, 'warn');
    assert.ok(f[0].detail.includes('START GROUP_REPLICATION'));
  });

  test('RECOVERING member → info pointing at provisioning/clone', () => {
    const f = grFindings(snap(
      [member84(), member84({ id: 'm2', host: 'db2', state: 'RECOVERING', role: 'SECONDARY' })],
      [stats84()],
    ));
    const r = f.find(x => x.title.includes('RECOVERING'));
    assert.equal(r?.level, 'info');
    assert.ok(r?.detail.includes('clone'));
  });

  test('single-primary with ONLINE members but no PRIMARY → crit', () => {
    const f = grFindings(snap([member84({ role: 'SECONDARY' })], [stats84()]));
    assert.ok(f.some(x => x.level === 'crit' && x.title.includes('no PRIMARY')));
  });

  test('single-primary no-PRIMARY rule does not fire when a PRIMARY exists', () => {
    const f = grFindings(snap([member84({ role: 'PRIMARY' })], [stats84()]));
    assert.ok(!f.some(x => x.title.includes('no PRIMARY')));
  });

  test('single-primary unknown (older row set) → no-PRIMARY rule skipped', () => {
    const s = snap([member84({ role: null })], [stats84()], ['g', null, null, null, null]);
    assert.ok(!grFindings(s).some(x => x.title.includes('no PRIMARY')));
  });

  test('multi-primary → info note', () => {
    const f = grFindings(snap([member84()], [stats84()], ['g', '0', 'a', 's', 'u']));
    assert.ok(f.some(x => x.level === 'info' && x.title === 'Multi-primary mode'));
  });

  test('conflicts > 0 → warn; new conflicts since prev mentioned', () => {
    const cur = snap([member84()], [stats84({ conflicts: '4' })]);
    const prev = snap([member84()], [stats84({ conflicts: '1' })]);
    const withPrev = grFindings(cur, prev);
    assert.ok(withPrev.some(x => x.level === 'warn' && x.title.includes('conflicts') && x.detail.includes('3 new')));
    const first = grFindings(cur);
    assert.ok(first.some(x => x.level === 'warn' && x.title.includes('conflicts')));
    assert.ok(!first.find(x => x.title.includes('conflicts'))?.detail.includes('new since'));
  });

  test('conflicts 0 → no conflict finding', () => {
    assert.ok(!grFindings(snap([member84()], [stats84({ conflicts: '0' })]))
      .some(x => x.title.includes('conflicts')));
  });

  test('applier queue growing → warn (needs prev)', () => {
    const cur = snap([member84()], [stats84({ applierQ: '4' })]);
    const prev = snap([member84()], [stats84({ applierQ: '1' })]);
    const f = grFindings(cur, prev);
    assert.ok(f.some(x => x.level === 'warn' && x.title.includes('Apply backlog')));
    // Same depth, no growth, below the absolute threshold → silent.
    assert.ok(!grFindings(cur, snap([member84()], [stats84({ applierQ: '4' })]))
      .some(x => x.title.includes('Apply backlog')));
  });

  test('applier queue above GR_QUEUE_WARN → warn even without growth', () => {
    const cur = snap([member84()], [stats84({ applierQ: String(GR_QUEUE_WARN + 1) })]);
    const same = snap([member84()], [stats84({ applierQ: String(GR_QUEUE_WARN + 1) })]);
    assert.ok(grFindings(cur, same).some(x => x.title.includes('Apply backlog')));
    assert.ok(grFindings(cur).some(x => x.title.includes('Apply backlog')));
  });

  test('stats without applier column → queue rule skipped, no crash', () => {
    const cols = ['MEMBER_ID', 'COUNT_TRANSACTIONS_CHECKED', 'COUNT_CONFLICTS_DETECTED'];
    const s = parseGrSnapshot(MEMBER_COLS_84, [member84()], cols, [['m1', '5', '0']], identityRow);
    assert.deepEqual(grFindings(s), []);
  });
});

describe('grStatsFor / grGroupNotStarted / grStateHealth', () => {
  test('grStatsFor finds by member id, null when absent', () => {
    const s = snap([member84()], [stats84()]);
    assert.equal(grStatsFor(s, 'aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb')?.txChecked, 3);
    assert.equal(grStatsFor(s, 'nope'), null);
    assert.equal(grStatsFor(s, null), null);
  });

  test('grGroupNotStarted is the empty-members signal', () => {
    assert.equal(grGroupNotStarted(0), true);
    assert.equal(grGroupNotStarted(1), false);
  });

  test('grStateHealth maps the documented states', () => {
    assert.equal(grStateHealth('ONLINE'), 'good');
    assert.equal(grStateHealth('RECOVERING'), 'warn');
    assert.equal(grStateHealth('OFFLINE'), 'bad');
    assert.equal(grStateHealth('ERROR'), 'bad');
    assert.equal(grStateHealth('UNREACHABLE'), 'bad');
    assert.equal(grStateHealth('SOMETHING_NEW'), null);
    assert.equal(grStateHealth(null), null);
  });
});

describe('parseCloneProgress', () => {
  const STATUS_COLS = ['ID', 'PID', 'STATE', 'BEGIN_TIME', 'END_TIME', 'SOURCE', 'DESTINATION', 'ERROR_NO', 'ERROR_MESSAGE', 'BINLOG_FILE', 'BINLOG_POSITION', 'GTID_EXECUTED'];
  const PROGRESS_COLS = ['ID', 'STAGE', 'STATE', 'BEGIN_TIME', 'END_TIME', 'THREADS', 'ESTIMATE', 'DATA', 'NETWORK', 'DATA_SPEED', 'NETWORK_SPEED'];
  const stageRow = (stage: string, state: string, estimate: Cell = '0', data: Cell = '0'): Row =>
    ['1', stage, state, '2026-10-02 10:00:00.000', null, '1', estimate, data, data, '0', '0'];

  test('both tables empty (clone plugin idle) → null, nothing renders', () => {
    assert.equal(parseCloneProgress(STATUS_COLS, [], PROGRESS_COLS, []), null);
  });

  test('in-progress clone: done stages + current byte ratio → overall pct', () => {
    const p = parseCloneProgress(
      STATUS_COLS,
      [['1', '100', 'In Progress', '2026-10-02 10:00:00', null, 'donor:3306', 'LOCAL INSTANCE', '0', null, null, null, '']],
      PROGRESS_COLS,
      [
        stageRow('DROP DATA', 'Completed'),
        stageRow('FILE COPY', 'Completed'),
        stageRow('PAGE COPY', 'In Progress', '1000', '250'),
        stageRow('REDO COPY', 'Not Started'),
        stageRow('FILE SYNC', 'Not Started'),
        stageRow('RESTART', 'Not Started'),
        stageRow('RECOVERY', 'Not Started'),
      ],
    );
    assert.ok(p);
    assert.equal(p.state, 'In Progress');
    assert.equal(p.source, 'donor:3306');
    assert.equal(p.currentStage, 'PAGE COPY');
    // (2 done + 0.25 of the third) / 7 stages
    assert.equal(p.overallPct, 2.25 / 7);
  });

  test('byteless in-progress stage counts as half a stage', () => {
    const p = parseCloneProgress(
      STATUS_COLS, [['1', null, 'In Progress', null, null, 'donor:3306', 'LOCAL', '0', null, null, null, null]],
      PROGRESS_COLS, [stageRow('FILE COPY', 'In Progress', '0', '0')],
    );
    assert.equal(p?.overallPct, 0.5 / 7);
  });

  test('completed clone → pct 1; failed clone carries the error', () => {
    const done = parseCloneProgress(
      STATUS_COLS, [['1', null, 'Completed', null, null, 'donor:3306', 'LOCAL', '0', null, null, null, null]],
      PROGRESS_COLS, [],
    );
    assert.equal(done?.overallPct, 1);
    const failed = parseCloneProgress(
      STATUS_COLS, [['1', null, 'Failed', null, null, 'donor:3306', 'LOCAL', '3862', 'Clone Donor Error: 3862', null, null, null]],
      PROGRESS_COLS, [],
    );
    assert.equal(failed?.errorNo, 3862);
    assert.equal(failed?.errorMessage, 'Clone Donor Error: 3862');
  });

  test('unknown extra stages widen the denominator instead of overflowing pct', () => {
    const rows = [
      ...(['DROP DATA', 'FILE COPY', 'PAGE COPY', 'REDO COPY', 'FILE SYNC', 'RESTART', 'RECOVERY'] as const)
        .map(s => stageRow(s, 'Completed')),
      stageRow('BRAND NEW STAGE', 'In Progress'),
    ];
    const p = parseCloneProgress(STATUS_COLS, [], PROGRESS_COLS, rows);
    assert.ok(p!.overallPct! <= 1);
    assert.equal(p?.overallPct, 7.5 / 8);
  });
});

// ── Live fixture from my84 (single-node group, MySQL 8.4.10) ─────────────

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Parse the captured `#`-comment + tab-separated dump: sections MEMBERS,
 * STATS, IDENTITY; first non-comment line of MEMBERS/STATS is the header.
 */
function mgrFixture(name: string): {
  memberCols: string[]; memberRows: string[][];
  statsCols: string[]; statsRows: string[][];
  identity: string[] | undefined;
} {
  const text = readFileSync(join(here, 'fixtures', name), 'utf8');
  let section = '';
  const out = { memberCols: [] as string[], memberRows: [] as string[][],
    statsCols: [] as string[], statsRows: [] as string[][],
    identity: undefined as string[] | undefined };
  for (const line of text.split('\n')) {
    if (line.startsWith('#')) {
      if (line.includes('MEMBERS')) section = 'members-head';
      else if (line.includes('STATS')) section = 'stats-head';
      else if (line.includes('IDENTITY')) section = 'identity';
      continue;
    }
    if (!line.trim()) continue;
    const cells = line.split('\t');
    if (section === 'members-head') { out.memberCols = cells; section = 'members'; }
    else if (section === 'members') out.memberRows.push(cells);
    else if (section === 'stats-head') { out.statsCols = cells; section = 'stats'; }
    else if (section === 'stats') out.statsRows.push(cells);
    else if (section === 'identity') out.identity = cells;
  }
  return out;
}

describe('live fixture: my84 single-node group (MySQL 8.4.10)', () => {
  const f = mgrFixture('mgr-members-single.txt');
  const s = parseGrSnapshot(f.memberCols, f.memberRows, f.statsCols, f.statsRows, f.identity);

  test('one member, ONLINE, PRIMARY, versioned', () => {
    assert.equal(s.members.length, 1);
    assert.equal(s.members[0].state, 'ONLINE');
    assert.equal(s.members[0].role, 'PRIMARY');
    assert.match(s.members[0].version ?? '', /^8\.4\./);
    assert.equal(s.members[0].port, 3307);
  });

  test('identity row: single-primary, the fixture group UUID, server matches member', () => {
    assert.equal(s.singlePrimary, true);
    assert.equal(s.groupName, '3f8a1c4e-9d2b-4c7a-8e5f-1a2b3c4d5e6f');
    assert.equal(s.serverUuid, s.members[0].id);
  });

  test('stats parsed and a healthy fixture produces zero findings', () => {
    assert.equal(s.stats.length, 1);
    assert.equal(s.stats[0].conflicts, 0);
    assert.equal(s.stats[0].applierQueue, 0);
    assert.deepEqual(grFindings(s), []);
  });
});
