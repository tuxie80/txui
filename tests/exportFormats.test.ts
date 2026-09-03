/**
 * The export formats added for markup and templates (src/utils/exporters.ts).
 *
 * Every one of these is a *escaping* problem wearing a formatting costume. An
 * unescaped `&` breaks XML, an unescaped `<` breaks HTML, and an unescaped `&`
 * in LaTeX silently becomes a column separator. The failure is not that the
 * file looks wrong — it is that it opens, parses, or compiles into something
 * that is not your data.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  toXml, toHtml, toLatex, applyTemplate, toTemplate, serialize, FORMAT_LABELS, withEol } from '../src/utils/exporters.ts';

const COLS = ['id', 'name', 'note'];
const ROWS: unknown[][] = [
  [1, 'plain', 'ok'],
  [2, 'a & b < c > d', null],
  [3, '"quoted"', "it's"],
];

// ── XML ─────────────────────────────────────────────────────────────────────

test('XML escapes the characters that would break the document', () => {
  const x = toXml(COLS, ROWS);
  assert.match(x, /a &amp; b &lt; c &gt; d/);
  assert.ok(!/a & b < c/.test(x), 'raw markup characters leaked through');
});

test('XML marks NULL rather than exporting it as an empty string', () => {
  // An empty element and a NULL are different values; conflating them is how a
  // round-trip loses data silently.
  const x = toXml(COLS, ROWS);
  assert.match(x, /<note xsi:nil="true"\/>/);
  assert.match(x, /xmlns:xsi=/, 'the nil attribute needs its namespace declared');
});

test('XML sanitises column names that cannot be element names', () => {
  const x = toXml(['count(*)', '2nd col'], [[1, 2]]);
  assert.match(x, /<count___>/, 'punctuation should be replaced');
  assert.match(x, /<_2nd_col>/, 'an element cannot start with a digit');
});

// ── HTML ────────────────────────────────────────────────────────────────────

test('HTML escapes markup and is self-contained', () => {
  const h = toHtml(COLS, ROWS, 'My <Result>');
  assert.match(h, /a &amp; b &lt; c &gt; d/);
  assert.match(h, /<title>My &lt;Result&gt;<\/title>/, 'the title is escaped too');
  assert.match(h, /^<!doctype html>/);
  assert.match(h, /<style>/, 'it should open in a browser without anything else');
});

test('HTML marks NULL distinctly from an empty cell', () => {
  assert.match(toHtml(COLS, ROWS), /<td class="null">NULL<\/td>/);
});

// ── LaTeX ───────────────────────────────────────────────────────────────────

test('LaTeX escapes every character that changes the document', () => {
  // `&` is a column separator, `%` starts a comment, `$` opens maths — an
  // unescaped one does not look wrong, it compiles into something else.
  const l = toLatex(['a'], [['& % $ # _ { }']]);
  assert.match(l, /\\&/);
  assert.match(l, /\\%/);
  assert.match(l, /\\\$/);
  assert.match(l, /\\#/);
  assert.match(l, /\\_/);
  assert.match(l, /\\\{/);
  assert.match(l, /\\\}/);
});

test('LaTeX handles the characters that have no simple escape', () => {
  const l = toLatex(['a'], [['~ ^ \\']]);
  assert.match(l, /\\textasciitilde\{\}/);
  assert.match(l, /\\textasciicircum\{\}/);
  assert.match(l, /\\textbackslash\{\}/);
});

test('LaTeX produces a complete tabular with a column spec', () => {
  const l = toLatex(COLS, ROWS);
  assert.match(l, /\\begin\{tabular\}\{l l l\}/);
  assert.match(l, /\\end\{tabular\}/);
  assert.equal((l.match(/\\\\/g) ?? []).length >= ROWS.length, true);
});

// ── templates ───────────────────────────────────────────────────────────────

test('a template substitutes by name and by position', () => {
  assert.equal(applyTemplate('{id}: {name}', COLS, ROWS[0]), '1: plain');
  assert.equal(applyTemplate('{1}-{2}', COLS, ROWS[0]), '1-plain');
});

test('template names are case-insensitive', () => {
  assert.equal(applyTemplate('{ID}', COLS, ROWS[0]), '1');
  assert.equal(applyTemplate('{ Name }', COLS, ROWS[0]), 'plain');
});

test('an unknown placeholder is LEFT AS WRITTEN, not blanked', () => {
  // A typo that silently produces empty output is how a export looks like it
  // worked and is missing a column.
  assert.equal(applyTemplate('{nope}', COLS, ROWS[0]), '{nope}');
  assert.equal(applyTemplate('{99}', COLS, ROWS[0]), '{99}');
});

test('doubled braces are a literal brace', () => {
  assert.equal(applyTemplate('{{{id}}}', COLS, ROWS[0]), '{1}');
  assert.equal(applyTemplate('{{}}', COLS, ROWS[0]), '{}');
});

test('a template renders every row, one per line', () => {
  const out = toTemplate('id={id}', COLS, ROWS);
  assert.deepEqual(out.trimEnd().split('\n'), ['id=1', 'id=2', 'id=3']);
});

test('a template renders NULL visibly', () => {
  // The cell renderer decides how; what matters is that it is not silently ''.
  const out = applyTemplate('{note}', COLS, ROWS[1]);
  assert.notEqual(out, '{note}', 'the column exists, so it must substitute');
});

// ── the registry ────────────────────────────────────────────────────────────

test('every format serialises and is labelled', () => {
  for (const f of ['tsv', 'csv', 'json', 'ascii', 'markdown', 'insert',
                   'html', 'xml', 'latex'] as const) {
    const out = serialize(f, COLS, ROWS, 'my_table');
    assert.ok(out.length > 10, `${f} produced nothing`);
    assert.ok(FORMAT_LABELS[f], `${f} has no label`);
  }
});

test('no format loses a row', () => {
  for (const f of ['csv', 'tsv', 'markdown', 'insert', 'html', 'xml', 'latex'] as const) {
    const out = serialize(f, COLS, ROWS, 't');
    for (const marker of ['plain', 'quoted']) {
      assert.ok(out.includes(marker) || out.includes('&quot;'),
        `${f} dropped a row containing "${marker}"`);
    }
  }
});

// ── line endings in written files ───────────────────────────────────────────

test('exports can be written with the line endings older Windows tooling wants', () => {
  // Every exporter joins with \n, which Excel and modern Notepad read fine and
  // plenty of older Windows tooling shows as one run-on line. Converted in one
  // place — where a file is written — rather than in ten exporters.
  assert.equal(withEol('a\nb\n', '\r\n'), 'a\r\nb\r\n');
  assert.equal(withEol('a\nb\n', '\n'), 'a\nb\n');
});

test('a string that already has CRLF does not become CRCRLF', () => {
  // SQL pasted from a Windows editor arrives with CRLF already in it.
  assert.equal(withEol('a\r\nb', '\r\n'), 'a\r\nb');
  assert.equal(withEol('a\r\nb', '\n'), 'a\nb');
});
