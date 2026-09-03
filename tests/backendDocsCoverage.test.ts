/**
 * docs/BACKEND.md must document every Tauri command the app registers.
 *
 * This drifted badly once: the file said "Commands (151)" while ~50 of them —
 * the newest surfaces, exactly the ones a reader would need the doc for — had
 * no entry at all. The count was maintained and the content was not, which is
 * the worst of both, because the header made the gap invisible.
 *
 * `lib.rs`'s `generate_handler!` block is the only complete list, so it is the
 * fixture here. Add a command, add its row.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const LIB = 'src-tauri/src/lib.rs';
const DOC = 'docs/BACKEND.md';

/** The command names inside `generate_handler![ … ]`. */
function registeredCommands(): string[] {
  const src = readFileSync(LIB, 'utf8');
  const at = src.indexOf('generate_handler!');
  assert.ok(at > 0, `no generate_handler! in ${LIB}`);
  const open = src.indexOf('[', at);
  let depth = 0, close = -1;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '[') depth++;
    else if (src[i] === ']' && --depth === 0) { close = i; break; }
  }
  assert.ok(close > open, 'unbalanced generate_handler! brackets');
  return src.slice(open + 1, close)
    .replace(/\/\/.*/g, '')
    .split(',')
    .map(s => s.trim().split('::').pop() ?? '')
    .filter(Boolean);
}

/**
 * Every command name the doc mentions. BACKEND.md legitimately collapses
 * families as `` `save_`/`list_`/`get_digest_snapshot` ``, so those are
 * expanded rather than counted as misses.
 */
function documentedNames(): Set<string> {
  const doc = readFileSync(DOC, 'utf8');
  const names = new Set<string>();
  for (const m of doc.matchAll(/`([a-z_][a-z0-9_]*)`/g)) names.add(m[1]);
  for (const m of doc.matchAll(/((?:`[a-z_]+_`\/)+)`([a-z_]+)`/g)) {
    const full = m[2];
    const tail = full.includes('_') ? full.slice(full.indexOf('_') + 1) : full;
    for (const p of m[1].matchAll(/`([a-z_]+_)`/g)) {
      names.add(p[1] + tail);
      names.add(p[1] + tail + 's');
    }
  }
  return names;
}

describe('docs/BACKEND.md command coverage', () => {
  const commands = registeredCommands();

  test('every registered command appears in the doc', () => {
    const known = documentedNames();
    const missing = commands.filter(c => !known.has(c));
    assert.deepEqual(missing, [],
      `${missing.length} command(s) registered in lib.rs but absent from ${DOC}. ` +
      'Add a row for each — the header count alone hides the gap.');
  });

  test('the header count matches the number actually registered', () => {
    const doc = readFileSync(DOC, 'utf8');
    const m = doc.match(/^## Commands \((\d+)\)/m);
    assert.ok(m, `${DOC} has no "## Commands (N)" header`);
    assert.equal(Number(m[1]), commands.length,
      `${DOC} says ${m[1]} commands; lib.rs registers ${commands.length}`);
  });
});
