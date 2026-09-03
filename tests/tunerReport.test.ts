import test from 'node:test';
import assert from 'node:assert/strict';
import {
  countsText, flavorLabel, fmtUptime, groupFindings, isProblem,
  reportFileName, reportToMarkdown, scoreColor,
} from '../src/utils/tunerReport.ts';
import type { TunerFinding, TunerReport } from '../src/utils/tunerReport.ts';

/** Fixture report — the ONLY mock; nothing like this ships in the invoke path. */
const FIXTURE: TunerReport = {
  generated_at: '2026-08-05T10:30:00Z',
  server: {
    version: '8.0.36',
    version_comment: 'MySQL Community Server - GPL',
    flavor: 'mysql',
    arch: 'x86_64',
    uptime_secs: 274_861, // 3 d 4 h 21 min 1 s
    cloud: 'AWS RDS',
  },
  eol: {
    product: 'mysql',
    cycle: '8.0',
    eol_date: '2026-04-30',
    status: 'eol',
    latest: '8.4 LTS',
    source: 'endoflife.date',
  },
  score: { total: 62, performance: 25, security: 21, resilience: 16 },
  findings: [
    {
      id: 'perf-buffer-pool', category: 'performance', severity: 'critical',
      title: 'InnoDB buffer pool too small',
      detail: 'innodb_buffer_pool_size is 128M but the dataset is 4.2G.',
      recommendation: 'Raise the buffer pool to ~60-70% of RAM.',
      fix_sql: ['SET GLOBAL innodb_buffer_pool_size = 4294967296'],
      fix_config: ['innodb_buffer_pool_size = 4G'],
      points_lost: 15,
    },
    {
      id: 'sec-anon-user', category: 'security', severity: 'warn',
      title: 'Anonymous users exist',
      detail: 'Found 1 anonymous account in mysql.user.',
      recommendation: 'Drop anonymous accounts.',
      fix_sql: ["DROP USER ''@'localhost'"],
      fix_config: [],
      points_lost: 6,
    },
    {
      id: 'perf-qc', category: 'performance', severity: 'ok',
      title: 'Query cache disabled (good on 8.0)',
      detail: 'Nothing to do.',
      recommendation: null,
      fix_sql: [],
      fix_config: [],
      points_lost: 0,
    },
    {
      id: 'res-binlog', category: 'resilience', severity: 'advice',
      title: 'sync_binlog = 0',
      detail: 'Binlog fsync is deferred; a crash can lose transactions.',
      recommendation: 'Set sync_binlog = 1 for full durability.',
      fix_sql: ['SET GLOBAL sync_binlog = 1'],
      fix_config: ['sync_binlog = 1'],
      points_lost: 4,
    },
  ],
};

test('scoreColor: red <50, amber 50-79, green 80+', () => {
  assert.equal(scoreColor(0), 'red');
  assert.equal(scoreColor(49), 'red');
  assert.equal(scoreColor(50), 'amber');
  assert.equal(scoreColor(79), 'amber');
  assert.equal(scoreColor(80), 'green');
  assert.equal(scoreColor(100), 'green');
});

test('isProblem = warn + critical + advice', () => {
  assert.equal(isProblem('critical'), true);
  assert.equal(isProblem('warn'), true);
  assert.equal(isProblem('advice'), true);
  assert.equal(isProblem('info'), false);
  assert.equal(isProblem('ok'), false);
});

test('groupFindings: category order, hottest first, counts + problems', () => {
  const groups = groupFindings(FIXTURE.findings);
  assert.deepEqual(groups.map(g => g.category), ['performance', 'security', 'resilience']);
  const perf = groups[0];
  assert.deepEqual(perf.findings.map(f => f.id), ['perf-buffer-pool', 'perf-qc']);
  assert.deepEqual(perf.counts, { critical: 1, ok: 1 });
  assert.equal(perf.problems, 1);
  assert.equal(groups[1].problems, 1);
  assert.equal(groups[2].problems, 1); // advice counts as a problem
});

test('groupFindings: points_lost breaks ties, unknown category → config, empty dropped', () => {
  const fs: TunerFinding[] = [
    { id: 'a', category: 'schema', severity: 'warn', title: '', detail: '', recommendation: null, fix_sql: [], fix_config: [], points_lost: 1 },
    { id: 'b', category: 'schema', severity: 'warn', title: '', detail: '', recommendation: null, fix_sql: [], fix_config: [], points_lost: 9 },
    { id: 'c', category: 'weird' as TunerFinding['category'], severity: 'info', title: '', detail: '', recommendation: null, fix_sql: [], fix_config: [], points_lost: 0 },
  ];
  const groups = groupFindings(fs);
  assert.deepEqual(groups.map(g => g.category), ['schema', 'config']);
  assert.deepEqual(groups[0].findings.map(f => f.id), ['b', 'a']);
  assert.deepEqual(groups[1].findings.map(f => f.id), ['c']);
  assert.equal(groupFindings([]).length, 0);
});

test('countsText: hottest first, zero counts skipped', () => {
  assert.equal(countsText({ critical: 1, warn: 2, ok: 3 }), '1 critical · 2 warn · 3 ok');
  assert.equal(countsText({}), '');
});

test('fmtUptime', () => {
  assert.equal(fmtUptime(0), '0 s');
  assert.equal(fmtUptime(45), '45 s');
  assert.equal(fmtUptime(60), '1 min');
  assert.equal(fmtUptime(95), '1 min 35 s');
  assert.equal(fmtUptime(3600), '1 h');
  assert.equal(fmtUptime(8100), '2 h 15 min');
  assert.equal(fmtUptime(86400), '1 d');
  assert.equal(fmtUptime(274_861), '3 d 4 h');
  assert.equal(fmtUptime(-5), '0 s');
});

test('flavorLabel', () => {
  assert.equal(flavorLabel('mysql'), 'MySQL');
  assert.equal(flavorLabel('mariadb'), 'MariaDB');
  assert.equal(flavorLabel('percona'), 'Percona');
});

test('reportFileName from generated_at', () => {
  assert.equal(reportFileName(FIXTURE), 'tuner-report-2026-08-05-10-30-00.md');
  assert.equal(reportFileName({ ...FIXTURE, generated_at: '' }), 'tuner-report-snapshot.md');
});

test('reportToMarkdown: score, server, EOL, grouped findings with fixes', () => {
  const md = reportToMarkdown(FIXTURE);
  assert.match(md, /^# Server Tuner Report\n/);
  assert.match(md, /- \*\*Server:\*\* MySQL 8\.0\.36 \(MySQL Community Server - GPL\), x86_64, up 3 d 4 h/);
  assert.match(md, /- \*\*Cloud:\*\* AWS RDS/);
  assert.match(md, /## Health score: 62\/100/);
  assert.match(md, /- Performance: 25\/40/);
  assert.match(md, /\*\*mysql 8\.0:\*\* EOL on 2026-04-30/);
  assert.match(md, /Latest release: 8\.4 LTS/);
  assert.match(md, /### Performance \(1 critical · 1 ok\)/);
  assert.match(md, /#### \[CRITICAL\] InnoDB buffer pool too small \(−15 pts\)/);
  assert.match(md, /```sql\nSET GLOBAL innodb_buffer_pool_size = 4294967296\n```/);
  assert.match(md, /```ini\n\[mysqld\]\ninnodb_buffer_pool_size = 4G\n```/);
  assert.match(md, /\*\*Recommendation:\*\* Raise the buffer pool/);
  assert.ok(md.endsWith('\n'));
  assert.doesNotMatch(md, /\n{3,}/);
});

test('reportToMarkdown: offline EOL source gets a note; null eol omitted', () => {
  const offline = reportToMarkdown({
    ...FIXTURE,
    eol: { ...FIXTURE.eol!, status: 'eol-soon', source: 'builtin-fallback' },
  });
  assert.match(offline, /Offline data \(source: builtin-fallback\)/);
  const noEol = reportToMarkdown({ ...FIXTURE, eol: null, findings: [] });
  assert.doesNotMatch(noEol, /## End of life/);
  assert.match(noEol, /No findings\./);
});
