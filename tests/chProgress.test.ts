import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatCount,
  formatBytes,
  progressPercent,
  formatChProgress,
} from '../src/utils/chProgress.ts';

test('formatCount scales to K/M/B with three significant figures', () => {
  assert.equal(formatCount(0), '0');
  assert.equal(formatCount(999), '999');
  assert.equal(formatCount(1000), '1K');
  assert.equal(formatCount(12_345), '12.3K');
  assert.equal(formatCount(67_371_270), '67.4M');
  assert.equal(formatCount(1_400_000_000), '1.4B');
  assert.equal(formatCount(2_000_000_000), '2B');
  assert.equal(formatCount(150_000_000), '150M');
});

test('formatCount is defensive about junk input', () => {
  assert.equal(formatCount(-5), '0');
  assert.equal(formatCount(NaN), '0');
});

test('formatBytes uses binary units', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(1024), '1 KB');
  assert.equal(formatBytes(538_970_160), '514 MB');
  assert.equal(formatBytes(16_000_000_000), '14.9 GB');
});

test('progressPercent clamps and reports null without a total', () => {
  assert.equal(progressPercent(50, 100), 50);
  assert.equal(progressPercent(2_000_000_000, 2_000_000_000), 100);
  // Late over-estimate never exceeds 100.
  assert.equal(progressPercent(120, 100), 100);
  // No usable total → no percentage.
  assert.equal(progressPercent(10, 0), null);
  assert.equal(progressPercent(10, -1), null);
});

test('formatChProgress joins the parts and drops an unknown percent', () => {
  assert.equal(
    formatChProgress({ readRows: 1_400_000_000, readBytes: 12_200_000_000, totalRows: 2_000_000_000 }),
    '1.4B rows · 11.4 GB · 70%',
  );
  // total_rows == 0 → rows + bytes only, no misleading 0%.
  assert.equal(
    formatChProgress({ readRows: 10, readBytes: 80, totalRows: 0 }),
    '10 rows · 80 B',
  );
});
