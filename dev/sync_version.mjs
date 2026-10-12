// Single-source version sync — package.json's `version` is the ONE place a
// human edits. Everything else is written by this script:
//
//   node dev/sync_version.mjs            check mode: every consumer must match
//                                        package.json (drift → exit 1, named)
//   node dev/sync_version.mjs X.Y.Z      bump mode: write X.Y.Z everywhere,
//                                        rename CHANGELOG's [Unreleased]
//                                        section to [X.Y.Z] - <today>,
//                                        regenerate docs/inventory.json
//
// Consumers: src-tauri/Cargo.toml, src-tauri/tauri.conf.json (the DMG version
// comes from it), src-tauri/Cargo.lock (the local `app` package block only),
// README.md's badge, AGENTS.md's "Current version" line, CHANGELOG.md.
// tests/versionSync.test.ts runs the check mode's assertions on every
// `npm test`, so drift fails loudly even without running this script.

import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const SEMVER = /^\d+\.\d+\.\d+$/;
const today = new Date().toISOString().slice(0, 10);

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const current = pkg.version;

/** Every consumer: how to read its version, how to write a new one. */
const CONSUMERS = [
  {
    file: 'src-tauri/Cargo.toml',
    read: t => t.match(/^version = "([^"]+)"/m)?.[1] ?? null,
    write: (t, v) => t.replace(/^version = "[^"]+"/m, `version = "${v}"`),
  },
  {
    file: 'src-tauri/tauri.conf.json',
    read: t => t.match(/"version": "([^"]+)"/)?.[1] ?? null,
    write: (t, v) => t.replace(/"version": "[^"]+"/, `"version": "${v}"`),
  },
  {
    file: 'src-tauri/Cargo.lock',
    // Only the local crate's own block — never a dependency's version.
    read: t => t.match(/^name = "app"\nversion = "([^"]+)"/m)?.[1] ?? null,
    write: (t, v) => t.replace(/^(name = "app"\n)version = "[^"]+"/m, `$1version = "${v}"`),
  },
  {
    file: 'README.md',
    read: t => t.match(/version-(\d+\.\d+\.\d+)-blue/)?.[1] ?? null,
    write: (t, v) => t.replace(/version-\d+\.\d+\.\d+-blue/, `version-${v}-blue`),
  },
  {
    file: 'AGENTS.md',
    read: t => t.match(/^Current version: \*\*([^*]+)\*\*/m)?.[1] ?? null,
    write: (t, v) => t.replace(/^Current version: \*\*[^*]+\*\*/m, `Current version: **${v}**`),
  },
  {
    file: 'CHANGELOG.md',
    // The newest VERSIONED entry; [Unreleased] is working state, not a release.
    read: t => t.match(/^## \[(\d+\.\d+\.\d+)\]/m)?.[1] ?? null,
    write: (t, v) => t, // changelog is only renamed in bump mode, below
  },
];

const arg = process.argv[2];

if (!arg) {
  // ── check mode ────────────────────────────────────────────────────────────
  let drift = 0;
  for (const c of CONSUMERS) {
    const v = c.read(readFileSync(c.file, 'utf8'));
    if (v !== current) {
      console.error(`DRIFT: ${c.file} says ${v ?? '(unreadable)'}, package.json says ${current}`);
      drift = 1;
    }
  }
  if (drift) {
    console.error('Run: npm run version:sync -- <version>  (or fix the files above)');
    process.exit(1);
  }
  console.log(`version ${current} — all ${CONSUMERS.length} consumers in sync`);
  process.exit(0);
}

// ── bump mode ───────────────────────────────────────────────────────────────
if (!SEMVER.test(arg)) {
  console.error(`usage: node dev/sync_version.mjs [X.Y.Z] — got "${arg}"`);
  process.exit(1);
}
if (arg === current) {
  console.log(`already at ${arg} — nothing to do`);
  process.exit(0);
}

for (const c of CONSUMERS) {
  const t = readFileSync(c.file, 'utf8');
  if (c.read(t) === null) {
    console.error(`cannot locate a version in ${c.file} — refusing to guess`);
    process.exit(1);
  }
}

writeFileSync('package.json',
  readFileSync('package.json', 'utf8').replace(/"version": "[^"]+"/, `"version": "${arg}"`));
for (const c of CONSUMERS) {
  writeFileSync(c.file, c.write(readFileSync(c.file, 'utf8'), arg));
}

// CHANGELOG: the Unreleased working section becomes the release, dated today.
const cl = readFileSync('CHANGELOG.md', 'utf8');
if (/^## \[Unreleased\]$/m.test(cl)) {
  writeFileSync('CHANGELOG.md',
    cl.replace(/^## \[Unreleased\]$/m, `## [${arg}] - ${today}`));
  console.log(`CHANGELOG.md: [Unreleased] → [${arg}] - ${today}`);
} else {
  console.log('CHANGELOG.md: no [Unreleased] section — header left as-is');
}

// The generated inventory stamps the version; regenerate so docs gates stay green.
const inv = spawnSync('node', ['dev/gen_docs_inventory.mjs'], { stdio: 'inherit' });
if (inv.status !== 0) {
  console.error('gen_docs_inventory.mjs failed — docs/inventory.json not regenerated');
  process.exit(1);
}

console.log(`bumped ${current} → ${arg} (package.json, Cargo.toml, tauri.conf.json, Cargo.lock, README.md, AGENTS.md, inventory.json)`);
console.log('next: npm test && cargo check  — then commit + tag v' + arg);
