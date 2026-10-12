/**
 * tests for src/utils/galeraSstLog.ts — the SST/IST error-log line parser.
 * Every line class is exercised against the LIVE capture
 * (tests/fixtures/galera-sst-log-mariadb118.txt, MariaDB 11.8.8 rsync SST,
 * joiner + donor + a failed mariabackup SST), plus synthetic lines for the
 * two documented-but-not-captured classes (mariabackup [01] Copying, PXC
 * [sst] progress=1 pv lines) and a garbage-tolerance sweep.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseSstLogLine, summarizeSstLog } from '../src/utils/galeraSstLog.ts';

const here = dirname(fileURLToPath(import.meta.url));
const fixtureLines = readFileSync(join(here, 'fixtures', 'galera-sst-log-mariadb118.txt'), 'utf8')
  .split('\n').filter(l => l && !l.startsWith('#'));

describe('parseSstLogLine — real captured lines (MariaDB 11.8.8, rsync SST)', () => {
  test('SST start on joiner and donor', () => {
    const j = parseSstLogLine("WSREP_SST: [INFO] rsync SST started on joiner (20261002 13:36:49.000)");
    assert.equal(j?.phase, 'sst-start');
    assert.equal(j?.pct, null);
    assert.equal(j?.detail, 'rsync SST started on joiner');
    const d = parseSstLogLine("WSREP_SST: [INFO] rsync SST started on donor (20261002 13:36:49.000)");
    assert.equal(d?.phase, 'sst-start');
    const mb = parseSstLogLine("WSREP_SST: [INFO] mariabackup SST started on joiner (20261002 10:14:14.000)");
    assert.equal(mb?.phase, 'sst-start');
  });

  test('SST completion on both sides', () => {
    const j = parseSstLogLine("WSREP_SST: [INFO] rsync SST completed on joiner (20261002 13:36:50.000)");
    assert.equal(j?.phase, 'sst-done');
    assert.equal(j?.pct, 1);
    const d = parseSstLogLine("WSREP_SST: [INFO] rsync SST completed on donor (20261002 13:36:50.000)");
    assert.equal(d?.phase, 'sst-done');
  });

  test('donor phase lines map to sst-progress with the line\'s own words', () => {
    for (const [line, detail] of [
      ["WSREP_SST: [INFO] Tables flushed (20261002 13:36:49.000)", 'Tables flushed'],
      ["WSREP_SST: [INFO] Transfer of InnoDB data files done (20261002 13:36:50.000)", 'Transfer of InnoDB data files done'],
      ["WSREP_SST: [INFO] Transfer of data done (20261002 13:36:50.000)", 'Transfer of data done'],
      ["WSREP_SST: [INFO] Streaming the backup to joiner at 127.0.0.1:4442 (20261002 10:14:14.000)", 'Streaming the backup to joiner at 127.0.0.1:4442'],
      ["WSREP_SST: [INFO] Proceeding with SST (20261002 10:14:14.000)", 'Proceeding with SST'],
    ] as const) {
      const s = parseSstLogLine(line);
      assert.equal(s?.phase, 'sst-progress', line);
      assert.equal(s?.pct, null, line);
      assert.equal(s?.detail, detail, line);
    }
  });

  test('WSREP_SST [ERROR] lines are failures, not terminal', () => {
    const e = parseSstLogLine("WSREP_SST: [ERROR] Error while getting data from donor node: exit codes: 1 0 (20261002 10:14:24.000)");
    assert.equal(e?.phase, 'sst-failed');
    assert.equal(e?.detail, 'Error while getting data from donor node: exit codes: 1 0');
    const socat = parseSstLogLine("WSREP_SST: [ERROR] 'socat' not found in path (20261002 09:52:45.000)");
    assert.equal(socat?.phase, 'sst-failed');
  });

  test('IST percentage lines — the only real Galera percentage', () => {
    const a = parseSstLogLine("2026-10-02 13:36:51 0 [Note] WSREP: Receiving IST... 0.0% (0/7 events) complete.");
    assert.equal(a?.phase, 'ist-progress');
    assert.equal(a?.pct, 0);
    assert.equal(a?.eventsDone, 0);
    assert.equal(a?.eventsTotal, 7);
    const b = parseSstLogLine("2026-10-02 13:36:51 0 [Note] WSREP: Receiving IST... 100.0% (7/7 events) complete.");
    assert.equal(b?.pct, 1);
    // The documented mid-transfer shape (MariaDB Jira / Percona docs):
    const mid = parseSstLogLine("2026-10-02 12:00:00 0 [Note] WSREP: Receiving IST... 64.0% (12345/19200 events) complete.");
    assert.equal(mid?.phase, 'ist-progress');
    assert.ok(Math.abs((mid?.pct ?? 0) - 0.64) < 1e-9);
    assert.equal(mid?.detail, 'IST 64.0% — 12,345/19,200 events');
  });

  test('WSREP state transitions are role signals', () => {
    const joiner = parseSstLogLine("2026-10-02 13:36:49 0 [Note] WSREP: Shifting PRIMARY -> JOINER (TO: 383)");
    assert.equal(joiner?.phase, 'role');
    assert.equal(joiner?.detail, 'PRIMARY → JOINER');
    const donor = parseSstLogLine("2026-10-02 13:36:49 0 [Note] WSREP: Shifting SYNCED -> DONOR/DESYNCED (TO: 383)");
    assert.equal(donor?.detail, 'SYNCED → DONOR/DESYNCED');
    const sc = parseSstLogLine("2026-10-02 13:36:51 2 [Note] WSREP: Server status change joiner -> initializing");
    assert.equal(sc?.phase, 'role');
  });

  test('core completion lines (SST received/succeeded/sent, state transfer complete, monitor time)', () => {
    for (const line of [
      "2026-10-02 13:36:51 0 [Note] WSREP: SST received",
      "2026-10-02 13:36:51 0 [Note] WSREP: SST succeeded for position b110b4c2-be33-11f1-bc82-9e6500f05053:383",
      "2026-10-02 13:36:50 0 [Note] WSREP: SST sent: b110b4c2-be33-11f1-bc82-9e6500f05053:383",
      "2026-10-02 13:36:51 0 [Note] WSREP: 0.0 (galera3): State transfer from 1.0 (galera1) complete.",
      "2026-10-02 13:36:50 0 [Note] WSREP: 1.0 (galera1): State transfer to 0.0 (galera3) complete.",
      "2026-10-02 13:36:51 0 [Note] WSREP: Joiner monitor thread ended with total time 2 sec",
    ]) {
      const s = parseSstLogLine(line);
      assert.equal(s?.phase, 'sst-done', line);
      assert.equal(s?.pct, 1, line);
    }
  });
});

describe('parseSstLogLine — documented but not captured live', () => {
  test('mariabackup per-file Copying lines (docs format)', () => {
    const s = parseSstLogLine("[01] 2026-10-02 10:15:01 Copying ./ibdata1 to /var/lib/mysql/./ibdata1");
    assert.equal(s?.phase, 'sst-progress');
    assert.equal(s?.detail, 'Copying ibdata1');
  });

  test('PXC [sst] progress=1 pv-style lines carry a percentage', () => {
    const s = parseSstLogLine("1.23GiB 0:00:12 [ 100MiB/s] [=====>            ] 45% ETA 0:00:15");
    assert.equal(s?.phase, 'sst-progress');
    assert.ok(Math.abs((s?.pct ?? 0) - 0.45) < 1e-9);
  });

  test('a bare percentage in prose is NOT progress', () => {
    assert.equal(parseSstLogLine("WSREP_SST: [INFO] Disabling all progress/rate-limiting (20261002 09:52:45.000)"), null);
  });
});

describe('parseSstLogLine — garbage tolerance', () => {
  test('noise lines parse to null', () => {
    for (const line of [
      '',
      '   ',
      "WSREP_SST: [INFO] 'lsof' is selected as a socket information utility. (20261002 13:36:49.000)",
      "WSREP_SST: [INFO] Joiner cleanup: rsync PID=59743, stunnel PID=0 (20261002 13:36:50.000)",
      "2026-10-02 13:36:51 0 [Note] InnoDB: Completed initialization of buffer pool",
      "2026-10-02 13:36:49 2 [Note] WSREP: GCache DEBUG: RingBuffer::seqno_reset(): discarded 65072568 bytes",
      "2026-10-02 13:36:51 0 [Note] WSREP: Processing event queue:... nan% (0/0 events) complete.",
      "2026-10-02 13:36:51 0 [Note] /opt/homebrew/opt/mariadb@11.8/bin/mariadbd: ready for connections.",
      'garbage not a log line at all',
      '\tGroup state: b110b4c2-be33-11f1-bc82-9e6500f05053:383',
    ]) {
      assert.equal(parseSstLogLine(line), null, JSON.stringify(line));
    }
  });

  test('the whole live fixture parses without throwing and yields a sane timeline', () => {
    const signals = fixtureLines.map(parseSstLogLine);
    const kinds = new Set(signals.filter(s => s !== null).map(s => s!.phase));
    // The capture covers every class the parser knows from real lines.
    for (const k of ['sst-start', 'sst-progress', 'ist-progress', 'sst-done', 'sst-failed', 'role'] as const) {
      assert.ok(kinds.has(k), `fixture produced no ${k} signal`);
    }
  });
});

describe('summarizeSstLog', () => {
  test('empty stream stays indeterminate', () => {
    assert.equal(summarizeSstLog([]), null);
    // A stream whose every line was noise filters to the same empty stream.
    const noiseOnly = ['garbage', '', 'tail: cannot open x'].map(parseSstLogLine)
      .filter((s): s is NonNullable<typeof s> => s !== null);
    assert.equal(summarizeSstLog(noiseOnly), null);
  });

  test('a percentage survives later pct-less phase lines', () => {
    const sum = summarizeSstLog([
      { phase: 'ist-progress', pct: 0.64, detail: 'IST 64.0%', eventsDone: 12345, eventsTotal: 19200 },
      { phase: 'sst-progress', pct: null, detail: 'Transfer of data done' },
    ]);
    assert.equal(sum?.pct, 0.64);
    assert.equal(sum?.detail, 'Transfer of data done');
    assert.equal(sum?.eventsTotal, 19200);
  });

  test('done and failed latch', () => {
    const sum = summarizeSstLog([
      { phase: 'sst-failed', pct: null, detail: 'boom' },
      { phase: 'sst-progress', pct: null, detail: 'retrying' },
      { phase: 'sst-done', pct: 1, detail: 'rsync SST completed on joiner' },
    ]);
    assert.equal(sum?.failed, true);
    assert.equal(sum?.done, true);
  });

  test('the real joiner fixture block ends done with 100% IST', () => {
    const end = fixtureLines.findIndex(l => l.includes('Server galera3 synced with group'));
    const joiner = fixtureLines.slice(0, end + 1);
    const sum = summarizeSstLog(joiner.map(l => parseSstLogLine(l)).filter(s => s !== null));
    assert.equal(sum?.done, true);
    assert.equal(sum?.pct, 1);
    assert.equal(sum?.failed, false);
  });
});
