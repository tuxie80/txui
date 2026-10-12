/**
 * Version single-source guard — package.json's `version` is the one place a
 * human edits; dev/sync_version.mjs writes the rest. This test is the
 * enforcement: any consumer that disagrees fails `npm test`, so a hand-edit
 * or a forgotten sync cannot ship quietly.
 *
 * Keep the readers here in lockstep with the CONSUMERS table in
 * dev/sync_version.mjs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const root = new URL('../', import.meta.url);
const read = f => readFileSync(new URL(f, root), 'utf8');

const CONSUMERS = [
  ['src-tauri/Cargo.toml', t => t.match(/^version = "([^"]+)"/m)?.[1] ?? null],
  ['src-tauri/tauri.conf.json', t => t.match(/"version": "([^"]+)"/)?.[1] ?? null],
  // Only the local crate's own block — never a dependency's version.
  ['src-tauri/Cargo.lock', t => t.match(/^name = "app"\nversion = "([^"]+)"/m)?.[1] ?? null],
  ['README.md', t => t.match(/version-(\d+\.\d+\.\d+)-blue/)?.[1] ?? null],
  ['AGENTS.md', t => t.match(/^Current version: \*\*([^*]+)\*\*/m)?.[1] ?? null],
  // The newest VERSIONED entry; [Unreleased] is working state, not a release.
  ['CHANGELOG.md', t => t.match(/^## \[(\d+\.\d+\.\d+)\]/m)?.[1] ?? null],
];

test('package.json version is valid semver', () => {
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
});

for (const [file, reader] of CONSUMERS) {
  test(`${file} carries the package.json version`, () => {
    const v = reader(read(file));
    assert.equal(v, pkg.version,
      `${file} says ${v ?? '(unreadable)'} — run: npm run version:sync -- ${pkg.version}`);
  });
}

test('the sync script check mode agrees (dev/sync_version.mjs, no args)', async () => {
  const { spawnSync } = await import('node:child_process');
  const r = spawnSync('node', ['dev/sync_version.mjs'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr || r.stdout);
});
