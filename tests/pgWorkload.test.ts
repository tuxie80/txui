import { test } from 'node:test';
import assert from 'node:assert/strict';
import { correlatePgWorkload, inWorkloadWindow } from '../src/utils/pgWorkload.ts';
import type { PgssSnapshot, PgssStat } from '../src/utils/pgssDiff.ts';
import type { Snapshot, WaitBackend } from '../src/utils/waitAgg.ts';
import type { TimelineEvent, TimelineKind } from '../src/utils/incidentTimeline.ts';
import { enginesWith } from '../src/utils/engineCaps.ts';

function snapshot(capturedAt: number, stats: PgssStat[]): PgssSnapshot {
  return { capturedAt, stats: new Map(stats.map(s => [s.queryid, s])) };
}

function stat(queryid: string, calls: number, totalExecTime: number): PgssStat {
  return {
    queryid, query: `SELECT ${queryid}`, calls, totalExecTime,
    meanExecTime: calls ? totalExecTime / calls : 0, rows: calls * 2,
    sharedBlksHit: 0, sharedBlksRead: 0,
  };
}

function waitSample(atMs: number, type: string | null, event: string | null): Snapshot {
  const backend: WaitBackend = {
    pid: 1, waitEventType: type, waitEvent: event,
    state: type ? 'active' : 'idle', query: null,
  };
  return { atMs, backends: [backend] };
}

function incident(id: string, at_ms: number, kind: TimelineKind = 'long_query'): TimelineEvent {
  return { id, kind, at_ms, title: id, detail: '', ok: true, duration_ms: 10, ref_id: 1 };
}

test('one report ranks statement deltas and correlates all sources to inclusive endpoints', () => {
  const before = snapshot(1_000, [stat('a', 10, 100), stat('b', 5, 500), stat('idle', 2, 20)]);
  const after = snapshot(2_000, [stat('a', 15, 400), stat('b', 6, 550), stat('idle', 2, 20)]);
  const report = correlatePgWorkload(before, after, [
    waitSample(999, 'IO', 'OutsideBefore'),
    waitSample(1_000, 'IO', 'DataFileRead'),
    waitSample(1_500, 'Lock', 'relation'),
    waitSample(2_000, 'IO', 'DataFileRead'),
    waitSample(2_001, 'IO', 'OutsideAfter'),
  ], [
    incident('before', 999), incident('first', 1_000),
    incident('last', 2_000, 'deadlock'), incident('after', 2_001),
  ]);

  assert.ok(report);
  assert.deepEqual(report.window, { startMs: 1_000, endMs: 2_000 });
  assert.deepEqual(report.statements.map(s => [s.queryid, s.deltaTotalTime]), [['a', 300], ['b', 50]]);
  assert.equal(report.resetDetected, false);
  assert.equal(report.waits.samples, 3);
  assert.equal(report.waits.observations, 3);
  assert.deepEqual(report.waits.byType.map(w => [w.type, w.count]), [['IO', 2], ['Lock', 1]]);
  assert.deepEqual(report.waitCoverage, { samples: 3, firstMs: 1_000, lastMs: 2_000 });
  assert.deepEqual(report.incidents.map(e => e.id), ['last', 'first']);
});

test('a decreasing matched counter marks reset-tainted deltas', () => {
  const report = correlatePgWorkload(
    snapshot(100, [stat('a', 50, 5_000)]),
    snapshot(200, [stat('a', 2, 40)]),
    [], [],
  );
  assert.ok(report);
  assert.equal(report.resetDetected, true);
  assert.equal(report.statements[0].deltaCalls, -48);
  assert.equal(report.statements[0].deltaTotalTime, -4_960);
});

test('empty in-memory waits and incidents stay empty rather than implying server history', () => {
  const report = correlatePgWorkload(snapshot(100, []), snapshot(200, []), [], []);
  assert.ok(report);
  assert.deepEqual(report.waits.byType, []);
  assert.deepEqual(report.waits.byEvent, []);
  assert.deepEqual(report.waitCoverage, { samples: 0, firstMs: null, lastMs: null });
  assert.deepEqual(report.incidents, []);
});

test('reversed and non-finite capture windows produce no report', () => {
  assert.equal(correlatePgWorkload(snapshot(200, []), snapshot(100, []), [], []), null);
  assert.equal(correlatePgWorkload(snapshot(Number.NaN, []), snapshot(100, []), [], []), null);
});

test('window membership rejects non-finite timestamps', () => {
  const window = { startMs: 100, endMs: 200 };
  assert.equal(inWorkloadWindow(100, window), true);
  assert.equal(inWorkloadWindow(200, window), true);
  assert.equal(inWorkloadWindow(Number.NaN, window), false);
  assert.equal(inWorkloadWindow(Infinity, window), false);
});

test('the workload capability is PostgreSQL-only', () => {
  assert.deepEqual(enginesWith('pgWorkload'), ['postgres']);
});
