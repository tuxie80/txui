/**
 * The engine support matrix — the one table a reader consults to answer "does
 * TxUI do X on my database?".
 *
 * Three things about it had drifted, all the same way: something was written
 * out by hand for the engines that existed at the time, and never extended.
 *
 *  1. **The capability column published identifiers.** The HTML generator kept
 *     a label map covering 15 of the 33 flags and fell through to the raw key
 *     for the rest, so `longQueryWatch`, `namespaceDdl` and `queryStore` were
 *     printed as camelCase in a table aimed at people choosing a database.
 *     Labels and prose are now required for every flag, and the prose is lifted
 *     from the JSDoc in engineCaps.ts rather than restated.
 *  2. **The badge palette stopped at six engines.** DuckDB, MongoDB and SQL
 *     Server drew uncoloured badges — the same six-of-nine omission that once
 *     published them as the word "undefined".
 *  3. **The section was sixth on the page**, below three keyboard-shortcut
 *     sections, and its columns were in declaration order rather than in any
 *     order a reader would want.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ENGINES, ENGINE_CAPS, ENGINE_LABELS } from '../src/utils/engineCaps.ts';

const html = readFileSync('docs/index.html', 'utf8');
const css = readFileSync('dev/docs.css', 'utf8');
const inv = JSON.parse(readFileSync('docs/inventory.json', 'utf8'));
const REBUILD = 'run dev/build_docs.sh';

/** The `<section id="…">` ids, in the order they appear on the page. */
const sectionOrder = [...html.matchAll(/<section id="([a-z]+)" class="doc-section"/g)].map(m => m[1]);
/** Just the engine-matrix section — bounded, or later sections leak into it. */
const matrixStart = html.indexOf('<section id="engines"');
const matrixEnd = html.indexOf('<section id="', matrixStart + 1);
const matrix = html.slice(matrixStart, matrixEnd);

describe('engine matrix placement', () => {
  test('it is the second section, right after the overview', () => {
    assert.equal(sectionOrder[0], 'overview');
    assert.equal(sectionOrder[1], 'engines',
      `the engine matrix is section ${sectionOrder.indexOf('engines') + 1} of `
      + `${sectionOrder.length} (${sectionOrder.join(' → ')}) — it belongs second, `
      + `where someone evaluating TxUI will actually meet it. ${REBUILD}`);
  });

  test('and second in the sidenav, so the page and the nav agree', () => {
    const nav = [...html.matchAll(/<li><a href="#([a-z]+)">/g)].map(m => m[1]);
    assert.deepEqual(nav.slice(0, 2), ['overview', 'engines'], `sidenav is ${nav.join(', ')}`);
  });
});

describe('engine ordering — most complete first', () => {
  const count = (e: string) =>
    inv.capabilityKeys.filter((c: string) => inv.capabilityMatrix[e][c]).length;
  /** Engine columns in the order the published header row lists them. */
  const header = matrix.slice(matrix.indexOf('<thead>'), matrix.indexOf('</thead>'));
  const cols = [...header.matchAll(/<th class="e-([a-z]+)">/g)].map(m => m[1]);

  test('every engine has a column', () => {
    assert.deepEqual([...cols].sort(), [...ENGINES].sort(), `columns: ${cols.join(', ')} — ${REBUILD}`);
  });

  test('capability counts descend left to right', () => {
    const counts = cols.map(count);
    assert.deepEqual(counts, [...counts].sort((a, b) => b - a),
      `columns run ${cols.map((c, i) => `${c}=${counts[i]}`).join(' ')} — `
      + `the matrix must read as a ranking. ${REBUILD}`);
  });

  test('SQL Server lands third, behind MySQL and PostgreSQL', () => {
    // Not cosmetic: it is the concrete claim 0.63.0 makes about the engine,
    // and the ordering is what puts it in front of a reader.
    assert.deepEqual(cols.slice(0, 3), ['mysql', 'postgres', 'sqlserver'],
      `first three columns are ${cols.slice(0, 3).join(', ')}`);
  });

  test('the published counts are the real ones', () => {
    const scores = /<tr class="cap-score">([\s\S]*?)<\/tr>/.exec(matrix)?.[1] ?? '';
    const shown = [...scores.matchAll(/<th class="ctr">(\d+)<\/th>/g)].map(m => Number(m[1]));
    assert.deepEqual(shown, cols.map(count), `header scores drifted — ${REBUILD}`);
  });
});

describe('every capability is published, and in English', () => {
  const capKeys = Object.keys(ENGINE_CAPS[ENGINES[0]]);

  test('all of them appear as rows', () => {
    const rows = [...matrix.matchAll(/<code class="cap-key">(\w+)<\/code>/g)].map(m => m[1]);
    assert.deepEqual([...rows].sort(), [...capKeys].sort(),
      `the table lists ${rows.length} of ${capKeys.length} capabilities — a flag `
      + `missing from a CAP_GROUPS block is absent from the page entirely. ${REBUILD}`);
  });

  test('each row leads with a human label, never the identifier', () => {
    // Parse per cell, not across the whole section — a <b> in the section lede
    // would otherwise be read as the first row's label.
    const cells = [...matrix.matchAll(/<td class="cap">([\s\S]*?)<\/td>/g)].map(m => m[1]);
    assert.equal(cells.length, capKeys.length, `${cells.length} capability cells — ${REBUILD}`);
    for (const cell of cells) {
      const key = /<code class="cap-key">(\w+)<\/code>/.exec(cell)?.[1];
      const label = /<b>([^<]+)<\/b>/.exec(cell)?.[1];
      assert.ok(key && label, `a capability cell has no key or no label — ${REBUILD}`);
      assert.notEqual(label, key,
        `"${key}" is published as its own identifier. Add a CAP_LABEL entry in `
        + 'dev/gen_docs_html.mjs.');
      assert.match(label!, /^[A-Z]/, `"${key}" label "${label}" is not prose`);
      assert.ok(/<div class="cap-desc">/.test(cell), `"${key}" has no description`);
    }
  });

  test('each row explains itself, from the doc comment in engineCaps.ts', () => {
    for (const cap of capKeys) {
      const doc = inv.capabilityDocs?.[cap];
      assert.ok(doc?.summary, `capability "${cap}" has no doc comment in EngineCaps — ${REBUILD}`);
      assert.ok(doc.summary.length > 15, `"${cap}" summary is too short to help: ${doc.summary}`);
    }
  });

  test('doc-comment markdown is rendered, not printed', () => {
    const visible = matrix.replace(/data-search="[^"]*"/g, '');
    assert.ok(!visible.includes('`'),
      'a literal backtick reached the page — prose() in dev/gen_docs_html.mjs '
      + 'should have turned `code` spans into <code>');
  });
});

describe('engine styling covers every engine', () => {
  for (const e of ENGINES) {
    test(`${ENGINE_LABELS[e]} has a badge colour`, () => {
      assert.match(css, new RegExp(`--e-${e}\\s*:\\s*#`),
        `dev/docs.css defines no --e-${e} colour, so ${ENGINE_LABELS[e]} badges render uncoloured`);
      assert.match(css, new RegExp(`\\.e-${e}\\{`),
        `dev/docs.css has no .e-${e} rule`);
    });
  }
});
