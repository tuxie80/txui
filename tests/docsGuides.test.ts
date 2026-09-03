/**
 * The user guides (docs/user-guide/*.md) must be part of the generated help
 * site (docs/index.html) — they were Markdown-only for a long time, so the
 * one page users actually open had no First steps, no per-engine guides, and
 * nothing noticed.
 *
 * This guards the pipeline (dev/md2html.mjs + the guides section of
 * dev/gen_docs_html.mjs) against the quiet failures: a guide missing from the
 * page or the nav, an image path that was never rewritten from guide-relative
 * to site-relative, a cross-guide link that did not become an in-page anchor,
 * and raw Markdown leaking through the constrained renderer.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';

const REBUILD = 'run dev/build_docs.sh';
const html = readFileSync('docs/index.html', 'utf8');

// The guides the site renders. README.md is the guide index (its prose
// duplicates the reference sections) and SCREENSHOTS.md is the capture
// runbook — neither is a guide. Keep in sync with GUIDE_SKIP in
// dev/gen_docs_html.mjs.
const SKIP = new Set(['README.md', 'SCREENSHOTS.md']);
const guides = readdirSync('docs/user-guide')
  .filter(f => f.endsWith('.md') && !SKIP.has(f))
  .map(f => f.replace(/\.md$/, ''));

const sectionStart = html.indexOf('<section id="guides"');
const sectionEnd = html.indexOf('</section>', sectionStart);
const section = sectionStart >= 0 ? html.slice(sectionStart, sectionEnd) : '';

describe('user guides in the generated help site', () => {
  test('the Guides section exists and every guide is in it and in the nav', () => {
    assert.ok(section, `no <section id="guides"> in docs/index.html — ${REBUILD}`);
    assert.ok(guides.includes('first-steps'), 'first-steps.md missing from docs/user-guide/');
    for (const id of guides) {
      assert.ok(section.includes(`id="guide-${id}"`), `guide "${id}" not rendered — ${REBUILD}`);
      assert.ok(html.includes(`href="#guide-${id}"`), `guide "${id}" not linked in the nav — ${REBUILD}`);
    }
  });

  test('first-steps renders first — it is the newbie entry point', () => {
    const positions = guides.map(id => [id, section.indexOf(`id="guide-${id}"`)]);
    for (const [id, pos] of positions) assert.ok(pos > 0, `guide "${id}" missing from section`);
    const first = positions.reduce((a, b) => (b[1] < a[1] ? b : a))[0];
    assert.equal(first, 'first-steps', `first guide on the page is "${first}", expected first-steps`);
  });

  test('guide screenshots are rewritten to site-relative paths and exist', () => {
    const srcs = [...section.matchAll(/<img src="([^"]+)"/g)].map(m => m[1]);
    assert.ok(srcs.length > 0, 'guides section has no images — the renderer dropped them');
    for (const src of srcs) {
      assert.ok(src.startsWith('user-guide/'), `image not rewritten from guide-relative: ${src}`);
      assert.ok(existsSync(`docs/${src}`), `image missing on disk: docs/${src}`);
    }
  });

  test('cross-guide links became in-page anchors whose targets exist', () => {
    const anchors = [...section.matchAll(/href="#(guide-[^"]+)"/g)].map(m => m[1]);
    assert.ok(anchors.length > 0, 'no cross-guide links found — first-steps links to every engine guide');
    for (const a of anchors) {
      assert.ok(section.includes(`id="${a}"`), `link target #${a} has no matching guide block`);
    }
    // no leftover links into the Markdown source tree
    assert.ok(!/href="[^"]*\.md"/.test(section), 'a link still points at a .md file');
  });

  test('no raw Markdown leaked into the rendered guides', () => {
    const leaks: [RegExp, string][] = [
      [/\]\(/, 'unconverted [label](target) link/image'],
      [/\*\*/, 'unconverted **bold** markers'],
      [/(^|\n)\s*#{1,3}\s/, 'unconverted # heading'],
      [/^\s*```/m, 'unconverted code fence'],
    ];
    for (const [re, what] of leaks) {
      const m = re.exec(section);
      assert.ok(!m, `${what} leaked at: "${section.slice(Math.max(0, (m?.index ?? 0) - 40), (m?.index ?? 0) + 40)}"`);
    }
  });

  test('skipped files are not rendered as guides', () => {
    for (const f of SKIP) {
      const id = f.replace(/\.md$/, '').toLowerCase();
      assert.ok(!section.includes(`id="guide-${id}"`), `${f} should not be a guide block`);
    }
  });
});
