/**
 * Result-stream accumulation (src/utils/resultStream.ts) — the frontend half
 * of execute_query's paged Channel transport.
 *
 * The failure mode being pinned is silent row loss or reordering: the backend
 * drains `rows` into page events, so if the accumulation drops or reorders
 * pages, the grid and the session log quietly disagree with the server.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  newStreamAccum, applyStreamEvent, partialResult, finishStream, streamComplete,
} from '../src/utils/resultStream.ts';
import type { ResultStreamEvent } from '../src/utils/resultStream.ts';
import type { QueryResult } from '../src/types/index.ts';

const meta = (over: Partial<QueryResult> = {}): QueryResult => ({
  columns: [{ name: 'id', type_name: 'INT', nullable: false }],
  rows: [],
  rows_affected: null,
  execution_ms: 12,
  fetch_ms: 34,
  warnings: [],
  truncated: false,
  ...over,
});

const header = (totalRows: number): ResultStreamEvent =>
  ({ type: 'header', result: meta(), total_rows: totalRows });
const page = (from: number, n: number): ResultStreamEvent =>
  ({ type: 'page', rows: Array.from({ length: n }, (_, i) => [from + i]) });

// ── the assembly contract ──────────────────────────────────────────────────

test('a streamed run reassembles to the full result, in order', () => {
  const acc = newStreamAccum();
  applyStreamEvent(acc, header(7));
  applyStreamEvent(acc, page(0, 5));
  applyStreamEvent(acc, page(5, 2));
  assert.equal(streamComplete(acc), true);

  // The invoke returns metadata with rows drained; finishStream puts the
  // accumulated rows back and keeps the RETURNED metadata (warnings and all).
  const returned = meta({ warnings: ['Note: something'], truncated: true });
  const result = finishStream(acc, returned);
  assert.equal(result.rows.length, 7);
  assert.deepEqual(result.rows.map(r => r[0]), [0, 1, 2, 3, 4, 5, 6]);
  assert.deepEqual(result.warnings, ['Note: something']);
  assert.equal(result.truncated, true);
});

test('no events at all means the old single-payload path — returned untouched', () => {
  const acc = newStreamAccum();
  const returned = meta({ rows: [[1], [2]] });
  assert.equal(streamComplete(acc), true);
  const result = finishStream(acc, returned);
  assert.equal(result, returned, 'non-streamed results must pass through by identity');
  assert.deepEqual(result.rows, [[1], [2]]);
});

test('a partial snapshot grows with the pages and never aliases the accum', () => {
  const acc = newStreamAccum();
  assert.equal(partialResult(acc), null, 'nothing displayable before the header');
  applyStreamEvent(acc, header(4));
  const p0 = partialResult(acc)!;
  assert.equal(p0.rows.length, 0);
  assert.equal(p0.columns.length, 1, 'the grid can render columns from page zero');
  applyStreamEvent(acc, page(0, 3));
  const p1 = partialResult(acc)!;
  assert.equal(p1.rows.length, 3);
  applyStreamEvent(acc, page(3, 1));
  assert.equal(p1.rows.length, 3, 'a later page must not mutate an earlier snapshot');
  assert.equal(partialResult(acc)!.rows.length, 4);
});

test('incompleteness is detectable rather than silent', () => {
  const acc = newStreamAccum();
  applyStreamEvent(acc, header(10));
  applyStreamEvent(acc, page(0, 10));
  assert.equal(streamComplete(acc), true);

  const short = newStreamAccum();
  applyStreamEvent(short, header(10));
  applyStreamEvent(short, page(0, 9));
  assert.equal(streamComplete(short), false, 'one lost page must be visible');
  // …and what did arrive is still assembled, honestly partial.
  assert.equal(finishStream(short, meta()).rows.length, 9);
});

test('a page before its header is kept, not dropped', () => {
  const acc = newStreamAccum();
  applyStreamEvent(acc, page(0, 2));
  applyStreamEvent(acc, header(2));
  assert.equal(streamComplete(acc), true);
  assert.equal(finishStream(acc, meta()).rows.length, 2);
});
