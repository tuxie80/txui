/**
 * Icons get a fixed-width slot; they are never baked into a label string.
 *
 * The icon set mixes full-width emoji (🩺 🔬 💊 🎲) with narrow text symbols
 * (⚡ ⇄ ⚙ ❯ ⓘ ⏱). Written inline — `${icon} ${label}` — each one pushes the
 * name after it by a different amount, so a column of labels has a ragged left
 * edge and a row of tabs changes width for reasons unrelated to the words.
 *
 * Nothing about that fails a build or a type check, and it is invisible in a
 * diff: the regression is one template literal. So the rule is pinned over the
 * source, the same way the portability and tools-menu rules are.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const SRC = new URL('../src/', import.meta.url).pathname;

function tsxFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return tsxFiles(p);
    return e.name.endsWith('.tsx') ? [p] : [];
  });
}

test('no component builds a label by concatenating an icon in front of a name', () => {
  // `{s.icon} {s.name}` and `${meta.icon} ${meta.label}` are the two shapes
  // this has actually appeared in.
  const jsxPair = /\{[a-z][\w.]*\.icon\}\s*\{[a-z][\w.]*\.(name|label|title)\}/;
  const templatePair = /\$\{[a-z][\w.]*\.icon\}\s+\$\{[a-z][\w.]*\.(name|label|title)\}/;

  // An icon inside a sentence is fine — nothing lines up against one line of
  // prose. Those carry `icon-slot-skip` on the line before, so the exception is
  // deliberate and visible in the diff rather than a hole in the rule. Same
  // idiom as `xplat-skip` in the portability rules.
  const offenders: string[] = [];
  for (const file of tsxFiles(SRC)) {
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (!jsxPair.test(line) && !templatePair.test(line)) return;
      if (lines.slice(Math.max(0, i - 3), i).some(l => l.includes('icon-slot-skip'))) return;
      offenders.push(`${file.replace(SRC, '')}:${i + 1}  ${line.trim().slice(0, 90)}`);
    });
  }
  assert.deepEqual(offenders, [],
    'put the icon in <span className="icon-slot"> instead of in the text');
});

test('the icon slot itself is a fixed width, or it is not a slot', () => {
  const css = readFileSync(new URL('../src/App.css', import.meta.url), 'utf8');
  const rule = /\.icon-slot\s*\{([^}]*)\}/.exec(css);
  assert.ok(rule, '.icon-slot is missing — every icon site depends on it');

  const body = rule[1];
  assert.match(body, /width:\s*[\d.]+\s*ch/,
    'width must be set, in ch so it tracks the font and --font-scale rather than '
    + 'clipping a wide emoji when text is enlarged');
  assert.match(body, /text-align:\s*center/, 'a narrow glyph must sit in the middle of its box');
  assert.match(body, /flex:\s*none/, 'the slot must not be squeezed by a long label beside it');
});

test('a plugin tab label carries no icon characters', () => {
  // The tab title is the plugin NAME. `newPanelTab` used to return
  // `${meta.icon} ${meta.label}`, which also meant renaming a plugin tab
  // opened an input with the emoji already in it.
  const tabs = readFileSync(new URL('../src/components/QueryTabs.tsx', import.meta.url), 'utf8');
  const fn = /function newPanelTab\([\s\S]*?\n\}/.exec(tabs);
  assert.ok(fn, 'newPanelTab not found');
  assert.doesNotMatch(fn[0], /meta\.icon/,
    'newPanelTab must not put the icon in the label — QueryTabs renders it in a slot');
});
