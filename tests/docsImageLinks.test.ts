/**
 * Every image a Markdown doc points at must exist.
 *
 * `docs/user-guide/*.md` linked 19 screenshots of which exactly one had ever
 * been captured, so the guides rendered 18 broken images for months. Nothing
 * caught it: a missing PNG is not a compile error, not a lint error, and not
 * visible to anyone reading the Markdown source rather than the rendered page.
 *
 * The shots are generated now (`dev/shoot_userguide.mjs`), so the failure this
 * guards against is different but just as quiet: a doc referencing a shot the
 * capture script does not produce, or a rename on one side only.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname, normalize } from 'node:path';

/** Every .md under a root, recursively. */
function markdownFiles(root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const p = join(root, entry.name);
    if (entry.isDirectory()) out.push(...markdownFiles(p));
    else if (entry.name.endsWith('.md')) out.push(p);
  }
  return out;
}

const docs = [...markdownFiles('docs'), 'README.md', 'AGENTS.md', 'CHANGELOG.md', 'HANDOVER.md'];

describe('documentation image links', () => {
  test('every referenced image file exists', () => {
    const missing: string[] = [];
    for (const doc of docs) {
      const text = readFileSync(doc, 'utf8');
      for (const m of text.matchAll(/!\[[^\]]*\]\(([^)\s]+)\)/g)) {
        const target = m[1];
        if (/^(https?:|data:)/.test(target)) continue;
        const resolved = normalize(join(dirname(doc), target));
        if (!existsSync(resolved)) missing.push(`${doc} → ${target}`);
      }
    }
    assert.deepEqual(missing, [],
      `${missing.length} broken image link(s). For user-guide shots, regenerate `
      + 'with dev/shoot_userguide.mjs (see docs/user-guide/SCREENSHOTS.md).');
  });

  test('no referenced screenshot is a zero-byte placeholder', () => {
    const empty = readdirSync('docs/user-guide/screenshots')
      .filter(f => f.endsWith('.png'))
      .filter(f => statSync(join('docs/user-guide/screenshots', f)).size === 0);
    assert.deepEqual(empty, [], 'zero-byte screenshots — the capture wrote nothing');
  });
});
