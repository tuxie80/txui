/**
 * TS↔Rust drift guard for the write guard vocabularies — the same pattern as
 * the WRITE_STAGES drift test in tests/mongoPipeline.test.ts.
 *
 * sqlGuard.ts is the client-side pre-flight mirror of src-tauri/src/sqlguard.rs
 * (the server-side enforcement). The mirror only works while both sides name
 * the same keywords: a keyword added to one side only means the pre-flight
 * passes (or blocks) what the server then judges differently — which is how
 * `detach`/`attach`/`exchange`/`system`/`cleanup` were Rust-only until the
 * 2026-10 guard audit. These tests extract the Rust constants from source and
 * compare them with the TS lists as sorted sets.
 *
 * Extraction is a tolerant regex over the array literal; keep the Rust
 * declarations in their current shape (`const NAME: &[&str] = &[ "word", … ];`
 * with no double-quoted strings inside comments) or these tests fail loudly.
 * If a keyword ever legitimately exists on one side only, list it in
 * TS_ONLY / RUST_ONLY with the reason in a comment.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { WRITE_KEYWORDS, DANGEROUS_DDL_KEYWORDS } from '../src/utils/sqlGuard.ts';

const ROOT = new URL('..', import.meta.url).pathname;

function rustKeywords(constName: string): string[] {
  const src = readFileSync(join(ROOT, 'src-tauri/src/sqlguard.rs'), 'utf8');
  const re = new RegExp(constName + String.raw`:\s*&\[&str\]\s*=\s*&\[([\s\S]*?)\];`);
  const m = src.match(re);
  assert.ok(m, `${constName} literal not found in sqlguard.rs`);
  return [...m[1].matchAll(/"([a-z_]+)"/g)].map(g => g[1]);
}

/** Documented one-sided exceptions — empty today; add with a reason or the
 *  comparison below fails on the difference it was written to catch. */
const TS_ONLY: string[] = [];
const RUST_ONLY: string[] = [];

function diff(a: string[], b: string[]): string[] {
  const bs = new Set(b);
  return a.filter(x => !bs.has(x));
}

test('WRITE_KEYWORDS matches the Rust literal (drift guard)', () => {
  const rust = rustKeywords('WRITE_KEYWORDS');
  assert.deepEqual(
    diff([...WRITE_KEYWORDS], rust).filter(k => !TS_ONLY.includes(k)),
    [],
    'TS-only write keywords (add to TS_ONLY with a reason, or sync Rust)',
  );
  assert.deepEqual(
    diff(rust, [...WRITE_KEYWORDS]).filter(k => !RUST_ONLY.includes(k)),
    [],
    'Rust-only write keywords (add to RUST_ONLY with a reason, or sync TS)',
  );
});

test('DANGEROUS_DDL_KEYWORDS matches the Rust literal (drift guard)', () => {
  const rust = rustKeywords('DANGEROUS_DDL_KEYWORDS');
  const ts = [...DANGEROUS_DDL_KEYWORDS];
  assert.deepEqual(
    diff(ts, rust).filter(k => !TS_ONLY.includes(k)),
    [],
    'TS-only dangerous-DDL keywords (add to TS_ONLY with a reason, or sync Rust)',
  );
  assert.deepEqual(
    diff(rust, ts).filter(k => !RUST_ONLY.includes(k)),
    [],
    'Rust-only dangerous-DDL keywords (add to RUST_ONLY with a reason, or sync TS)',
  );
});
