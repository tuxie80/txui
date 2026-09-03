import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffDigests, parseDigestRows, type DigestSnapshot } from '../src/utils/mysqlDigestDiff.ts';

const snap = (at: number, rows: [string, string, number, number, number][]): DigestSnapshot =>
  ({ at, rows: parseDigestRows(rows) });

test('diff reports only advanced digests, sorted by total time', () => {
  const before = snap(1, [['d1', 'SELECT a', 10, 100, 1000], ['d2', 'SELECT b', 5, 50, 500]]);
  const after = snap(2, [['d1', 'SELECT a', 20, 400, 3000], ['d2', 'SELECT b', 5, 50, 500]]);
  const d = diffDigests(before, after);
  assert.equal(d.length, 1);            // d2 unchanged, dropped
  assert.equal(d[0].digest, 'd1');
  assert.equal(d[0].dCount, 10);
  assert.equal(d[0].dTotalMs, 300);
  assert.equal(d[0].avgMs, 30);
});

test('a brand-new digest counts fully; a reset is ignored', () => {
  const before = snap(1, [['d1', 'SELECT a', 10, 100, 0]]);
  const after = snap(2, [['d1', 'SELECT a', 4, 40, 0], ['d3', 'SELECT c', 2, 20, 5]]);
  const d = diffDigests(before, after);
  // d1 went backwards (reset) → ignored; d3 is new → full delta
  assert.deepEqual(d.map(x => x.digest), ['d3']);
  assert.equal(d[0].dCount, 2);
});

test('parseDigestRows drops NULL digests and coerces types', () => {
  const rows = parseDigestRows([['', 'x', 1, 1, 1], ['d1', 'y', '3', '9', '2']] as unknown[][]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].count, 3);
  assert.equal(rows[0].totalMs, 9);
});
