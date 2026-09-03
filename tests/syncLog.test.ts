/**
 * The run log (src/utils/syncLog.ts).
 *
 * Two failure modes are being guarded against, and they pull in opposite
 * directions: a log so quiet that a running copy is indistinguishable from a
 * hung one, and a log so noisy that the four lines which matter are buried
 * under five hundred chunk records.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  stamp, fmtMs, fmtBytes, formatLine, formatLog,
  emptyTally, recordChunk, tableSummary, summariseRun, fitColumn,
  CHUNK_LOG_LIMIT, SLOW_CHUNK_FACTOR,
} from '../src/utils/syncLog.ts';
import type { SyncLogEvent } from '../src/utils/syncLog.ts';

const AT = new Date('2026-08-08T14:48:42').getTime();
const ev = (over: Partial<SyncLogEvent> = {}): SyncLogEvent => ({
  at: AT, level: 'info', kind: 'data', message: 'something', ...over,
});

// ── formatting ──────────────────────────────────────────────────────────────

test('the stamp matches the shape the rest of the app uses', () => {
  assert.match(stamp(AT), /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\]$/);
});

test('durations read the way a person says them', () => {
  assert.equal(fmtMs(643), '643 ms');
  assert.equal(fmtMs(1204), '1 s 204 ms');
  assert.equal(fmtMs(2000), '2 s');
  assert.equal(fmtMs(123_000), '2 min 3 s');
  assert.equal(fmtMs(-1), '0 ms');
});

test('byte sizes step through the units', () => {
  assert.equal(fmtBytes(40), '40 B');
  assert.equal(fmtBytes(812 * 1024), '812 KB');
  assert.equal(fmtBytes(1.5 * 1024 * 1024), '1.5 MB');
  assert.equal(fmtBytes(2.25 * 1024 ** 3), '2.25 GB');
});

test('a line puts kind, target and message in fixed columns', () => {
  // So a file of these can be scanned down rather than read across.
  const a = formatLine(ev({ kind: 'data', target: 'db.orders', message: 'x' }));
  const b = formatLine(ev({ kind: 'verify', target: 'db.a', message: 'y' }));
  assert.equal(a.indexOf('db.orders'), b.indexOf('db.a'));
});

test('structured extras render into the tail, not the message', () => {
  const line = formatLine(ev({ rows: 50_000, bytes: 1024 * 1024, ms: 1204, message: 'copied' }));
  assert.match(line, /copied \(50,000 rows, 1\.0 MB, 1 s 204 ms\)/);
});

test('an event with no extras has no empty parentheses', () => {
  assert.ok(!formatLine(ev({ message: 'plain' })).includes('()'));
});

test('each level has its own glyph', () => {
  const glyphs = (['info', 'ok', 'warn', 'error'] as const)
    .map(level => formatLine(ev({ level })).split(' ')[2]);
  assert.equal(new Set(glyphs).size, 4, glyphs.join(''));
});

test('a run-wide event still aligns with targeted ones', () => {
  const withTarget = formatLine(ev({ target: 'db.t', message: 'M' }));
  const without = formatLine(ev({ message: 'M' }));
  assert.equal(withTarget.indexOf('M'), without.indexOf('M'));
});

test('an empty log exports as empty, not a bare newline', () => {
  assert.equal(formatLog([]), '');
  assert.ok(formatLog([ev()]).endsWith('\n'));
});

// ── chunk noise control ─────────────────────────────────────────────────────

test('the first few chunks are logged so the run shows movement', () => {
  // A log silent for the first minute looks exactly like one that has hung.
  let tally = emptyTally('db.t');
  for (let i = 0; i < CHUNK_LOG_LIMIT; i++) {
    const r = recordChunk(tally, { rows: 1000, bytes: 1000, ms: 100 });
    assert.ok(r.logIt, `chunk ${i} should be logged`);
    tally = r.tally;
  }
});

test('routine chunks after that are counted, not logged', () => {
  // 500 chunks each producing a line buries the ones that matter.
  let tally = emptyTally('db.t');
  for (let i = 0; i < CHUNK_LOG_LIMIT; i++) {
    tally = recordChunk(tally, { rows: 1000, bytes: 1000, ms: 100 }).tally;
  }
  const r = recordChunk(tally, { rows: 1000, bytes: 1000, ms: 100 });
  assert.equal(r.logIt, false);
  assert.equal(r.tally.chunks, CHUNK_LOG_LIMIT + 1);
});

test('a chunk that changed the size always earns a line', () => {
  // The decision is what explains a slow run six months later.
  let tally = emptyTally('db.t');
  for (let i = 0; i < CHUNK_LOG_LIMIT; i++) {
    tally = recordChunk(tally, { rows: 1000, bytes: 1000, ms: 100 }).tally;
  }
  const r = recordChunk(tally, { rows: 1000, bytes: 1000, ms: 100, adapted: true });
  assert.ok(r.logIt);
  assert.match(r.reason!, /chunk size changed/);
  assert.equal(r.tally.adaptations, 1);
});

test('a chunk far slower than the table mean earns a line, with both numbers', () => {
  let tally = emptyTally('db.t');
  for (let i = 0; i < CHUNK_LOG_LIMIT; i++) {
    tally = recordChunk(tally, { rows: 1000, bytes: 1000, ms: 100 }).tally;
  }
  const r = recordChunk(tally, { rows: 1000, bytes: 1000, ms: 100 * SLOW_CHUNK_FACTOR + 50 });
  assert.ok(r.logIt);
  assert.match(r.reason!, /against a .* mean/);
  assert.equal(r.tally.slowChunks, 1);
});

test('the first chunk cannot be slow — there is no mean yet', () => {
  const r = recordChunk(emptyTally('db.t'), { rows: 1, bytes: 1, ms: 99_999 });
  assert.equal(r.tally.slowChunks, 0);
});

test('the tally accumulates everything even when nothing is logged', () => {
  let tally = emptyTally('db.t');
  for (let i = 0; i < 10; i++) {
    tally = recordChunk(tally, { rows: 100, bytes: 200, ms: 10 }).tally;
  }
  assert.equal(tally.chunks, 10);
  assert.equal(tally.rows, 1000);
  assert.equal(tally.bytes, 2000);
});

// ── the per-table summary ───────────────────────────────────────────────────

test('the summary is stamped with the time it is GIVEN, not the clock', () => {
  // Reading Date.now() here put the line out of order in the log — the one
  // place ordering matters most.
  const t = { ...emptyTally('db.t'), chunks: 1, rows: 1, bytes: 1, ms: 1 };
  assert.equal(tableSummary(t, AT).at, AT);
});

test('a table summary carries throughput, which is what runs are compared by', () => {
  const t = { ...emptyTally('db.orders'), chunks: 12, rows: 600_000, bytes: 1e7, ms: 2000 };
  const e = tableSummary(t, AT);
  assert.match(e.message, /12 chunks/);
  assert.match(e.message, /300,000 rows\/s/);
  assert.equal(e.level, 'ok');
});

test('adaptations and slow chunks are named, not swallowed', () => {
  // An unexplained slow table is the commonest thing people come back to ask
  // about.
  const t = { ...emptyTally('db.t'), chunks: 5, rows: 100, bytes: 1, ms: 100, adaptations: 2, slowChunks: 1 };
  const e = tableSummary(t, AT);
  assert.match(e.message, /2 chunk-size changes/);
  assert.match(e.message, /1 slow/);
  assert.equal(e.level, 'warn');
});

// ── the closing report ──────────────────────────────────────────────────────

test('a clean run leads with verified', () => {
  const s = summariseRun([
    ev({ level: 'ok', kind: 'data', target: 'db.a', rows: 100, bytes: 10 }),
    ev({ level: 'ok', kind: 'verify', target: 'db.a' }),
  ]);
  assert.ok(s.ok);
  assert.match(s.headline, /Finished — verified/);
  assert.match(s.detail.join(' '), /100 rows across 1 table/);
});

test('a failed verification leads the headline, not the row count', () => {
  // A summary that opens with "12 tables, 4.2M rows" and mentions the failure
  // third gets read as success.
  const s = summariseRun([
    ev({ level: 'ok', kind: 'data', target: 'db.a', rows: 4_200_000, bytes: 1e9 }),
    ev({ level: 'error', kind: 'verify', target: 'db.a', message: 'content differs' }),
  ]);
  assert.ok(!s.ok);
  assert.match(s.headline, /^VERIFICATION FAILED/);
  assert.match(s.detail[0], /does not match the source/);
});

test('skips are surfaced — they are the silent part of a run', () => {
  const s = summariseRun([
    ev({ level: 'warn', kind: 'skip', target: 'db.heap', message: 'no primary key' }),
    ev({ level: 'ok', kind: 'data', target: 'db.a', rows: 1 }),
  ]);
  assert.ok(s.detail.some(d => /deliberately skipped/.test(d)));
});

test('errors outside verification are counted separately', () => {
  const s = summariseRun([
    ev({ level: 'error', kind: 'verify', message: 'v' }),
    ev({ level: 'error', kind: 'error', message: 'e' }),
  ]);
  assert.match(s.detail.join(' '), /1 table failed verification/);
  assert.match(s.detail.join(' '), /1 error during the run/);
});

test('warnings alone do not read as success', () => {
  const s = summariseRun([
    ev({ level: 'warn', kind: 'data', target: 'db.a', rows: 1 }),
  ]);
  assert.ok(s.ok, 'warnings are not failures');
  assert.match(s.headline, /with warnings/);
});

test('an empty run does not claim to have copied anything', () => {
  const s = summariseRun([]);
  assert.match(s.detail.join(' '), /0 rows across 0 tables/);
});

test('an over-long target is truncated, not allowed to shift the column', () => {
  // Schema and table can each be 64 characters; padEnd alone pushed the message
  // out of its column and the file stopped being scannable down.
  const short = formatLine(ev({ target: 'db.t', message: 'M' }));
  const long = formatLine(ev({
    target: 'very_long_schema_name.a_really_long_table_name_here', message: 'M' }));
  assert.equal(long.indexOf('M'), short.indexOf('M'));
});

test('truncation keeps the END — that is the identifying part', () => {
  // `…orders_line_items_archive` names the table; the schema prefix is shared
  // by everything else in the run.
  // Width 5 means the whole field is 5 characters: the ellipsis plus four.
  assert.equal(fitColumn('abcdefghij', 5), '…ghij');
  assert.equal(fitColumn('abcdefghij', 5).length, 5);
  assert.equal(fitColumn('abc', 5), 'abc  ');
});
