import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bytesToBase64 } from '../src/utils/base64.ts';

test('empty input encodes to the empty string', () => {
  assert.equal(bytesToBase64(new Uint8Array(0)), '');
});

test('matches the reference encoder on text', () => {
  const bytes = new TextEncoder().encode('hello, TxUI — ünïcode');
  assert.equal(bytesToBase64(bytes), Buffer.from(bytes).toString('base64'));
});

test('round-trips every byte value', () => {
  const bytes = new Uint8Array(256).map((_, i) => i);
  assert.equal(bytesToBase64(bytes), Buffer.from(bytes).toString('base64'));
});

test('handles payloads larger than one chunk (spread-safe)', () => {
  // 200k bytes = several 32k chunks; a single fromCharCode(...bytes) spread
  // would overflow the call stack at this size.
  const bytes = new Uint8Array(200_000);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31) & 0xff;
  assert.equal(bytesToBase64(bytes), Buffer.from(bytes).toString('base64'));
});

test('length is not a multiple of 3 — padding is right', () => {
  for (const n of [1, 2, 3, 4, 5]) {
    const bytes = new Uint8Array(n).map((_, i) => i + 40);
    assert.equal(bytesToBase64(bytes), Buffer.from(bytes).toString('base64'));
  }
});
