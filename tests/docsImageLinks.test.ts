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

const docs = [...markdownFiles('docs'), 'README.md', 'AGENTS.md', 'CHANGELOG.md'];

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

  test('every HTML screenshot opens full-size and has both Ayu theme variants', () => {
    const html = readFileSync('docs/index.html', 'utf8');
    const images = [...html.matchAll(/<a class="shot-link"[^>]*><img ([^>]+)><\/a>/g)];
    assert.ok(images.length >= 60, 'expected clickable screenshots throughout the help page');
    for (const match of images) {
      const attrs = match[1];
      const dark = /data-dark-src="([^"]+)"/.exec(attrs)?.[1];
      const light = /data-light-src="([^"]+)"/.exec(attrs)?.[1];
      assert.ok(dark && light, `screenshot lacks theme variants: ${match[0]}`);
      assert.ok(existsSync(`docs/${dark}`), `missing Ayu Dark image: docs/${dark}`);
      assert.ok(existsSync(`docs/${light}`), `missing Ayu Light image: docs/${light}`);
      assert.ok(match[0].includes('target="_blank"'), `screenshot does not open a new tab: ${match[0]}`);
    }
  });

  test('no referenced screenshot is a zero-byte placeholder', () => {
    const empty = readdirSync('docs/user-guide/screenshots')
      .filter(f => f.endsWith('.png'))
      .filter(f => statSync(join('docs/user-guide/screenshots', f)).size === 0);
    assert.deepEqual(empty, [], 'zero-byte screenshots — the capture wrote nothing');
  });
});
