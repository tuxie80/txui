/**
 * Line and case operations (src/utils/lineOps.ts) — the Notepad++ /
 * Sublime line-manipulation set the SQL editor was missing.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  convertCase, convertIndent, joinLines, keepDuplicateLines, leadingNumber,
  numberSequence, removeBlankLines, removeDuplicateLines, reverseLines,
  shuffleLines, sortLines, trimTrailing, indentLevels,
} from '../src/utils/lineOps.ts';

describe('sortLines', () => {
  test('ascending and descending', () => {
    assert.deepEqual(sortLines(['b', 'a', 'c'], 'asc'), ['a', 'b', 'c']);
    assert.deepEqual(sortLines(['b', 'a', 'c'], 'desc'), ['c', 'b', 'a']);
  });

  /// Lexicographic order puts 10 before 9, which is wrong for anything
  /// derived from an id — the reason numeric mode exists.
  test('numeric sort orders by value, not by digit', () => {
    assert.deepEqual(sortLines(['10', '9', '100'], 'asc'), ['10', '100', '9']);
    assert.deepEqual(sortLines(['10', '9', '100'], 'numeric-asc'), ['9', '10', '100']);
    assert.deepEqual(sortLines(['10', '9', '100'], 'numeric-desc'), ['100', '10', '9']);
  });

  test('numeric sort reads the number at the start of the line', () => {
    assert.deepEqual(
      sortLines(['20 rows', '3 rows', '100 rows'], 'numeric-asc'),
      ['3 rows', '20 rows', '100 rows']);
  });

  /// Treating them as zero would bury them among real zeroes.
  test('lines with no number sort last rather than as zero', () => {
    assert.deepEqual(
      sortLines(['banana', '2', '0', '1'], 'numeric-asc'),
      ['0', '1', '2', 'banana']);
  });

  test('negatives and decimals sort correctly', () => {
    assert.deepEqual(
      sortLines(['-5', '2.5', '-10', '0'], 'numeric-asc'),
      ['-10', '-5', '0', '2.5']);
  });

  test('case-insensitive sort groups regardless of case', () => {
    assert.deepEqual(sortLines(['b', 'A', 'a', 'B'], 'asc', false).map(s => s.toLowerCase()),
                     ['a', 'a', 'b', 'b']);
  });

  /// `Č` must sort among the Cs, not after `Z` — which is what a plain `<`
  /// comparison does, since U+010C is above every ASCII letter. The exact
  /// order of `C` against `Č` is a locale question and deliberately not
  /// asserted; that they are neighbours is the property that matters.
  test('accented letters sort among their base letter, not after Z', () => {
    const out = sortLines(['Zebra', 'Čapek', 'Cizek', 'Adam'], 'asc');
    assert.equal(out[0], 'Adam');
    assert.equal(out[3], 'Zebra', `Č sorted past Z: ${out.join(' ')}`);
    assert.deepEqual(out.slice(1, 3).sort(), ['Cizek', 'Čapek'].sort());
    // The naive comparison this guards against.
    const naive = ['Zebra', 'Čapek', 'Cizek', 'Adam'].sort();
    assert.equal(naive[3], 'Čapek', 'fixture no longer demonstrates the bug');
  });

  test('sorting does not mutate the input', () => {
    const input = ['c', 'a'];
    sortLines(input, 'asc');
    assert.deepEqual(input, ['c', 'a']);
  });
});

describe('duplicates', () => {
  /// First rather than last, so the order of what remains matches how it was
  /// written — the usual reason for deduping is to keep reading it.
  test('the first of each repeat is kept, in original order', () => {
    assert.deepEqual(removeDuplicateLines(['b', 'a', 'b', 'c', 'a']), ['b', 'a', 'c']);
  });

  test('case-insensitive dedupe', () => {
    assert.deepEqual(removeDuplicateLines(['A', 'a', 'B'], false), ['A', 'B']);
  });

  test('keeping duplicates is the inverse question', () => {
    assert.deepEqual(keepDuplicateLines(['a', 'b', 'a', 'c', 'b']), ['a', 'b', 'a', 'b']);
  });

  test('nothing repeated means nothing kept', () => {
    assert.deepEqual(keepDuplicateLines(['a', 'b']), []);
  });
});

describe('simple transforms', () => {
  test('reverse', () => {
    assert.deepEqual(reverseLines(['a', 'b', 'c']), ['c', 'b', 'a']);
  });

  test('blank and whitespace-only lines are removed', () => {
    assert.deepEqual(removeBlankLines(['a', '', '  ', '\t', 'b']), ['a', 'b']);
  });

  test('trailing whitespace goes, leading stays', () => {
    assert.deepEqual(trimTrailing(['  a   ', 'b\t']), ['  a', 'b']);
  });

  test('join collapses to one line and drops blanks', () => {
    assert.deepEqual(joinLines(['a', '  ', 'b']), ['a b']);
    assert.deepEqual(joinLines(['a', 'b'], ', '), ['a, b']);
  });

  test('an empty input survives every transform', () => {
    for (const f of [reverseLines, removeBlankLines, trimTrailing, removeDuplicateLines]) {
      assert.deepEqual(f([]), [], f.name);
    }
  });
});

describe('shuffleLines', () => {
  /// A shuffle must be a permutation — same multiset, nothing lost or cloned.
  test('is a permutation of the input', () => {
    const input = Array.from({ length: 50 }, (_, i) => String(i));
    const out = shuffleLines(input, () => 0.42);
    assert.equal(out.length, input.length);
    assert.deepEqual([...out].sort(), [...input].sort());
  });

  test('does not mutate the input', () => {
    const input = ['a', 'b', 'c'];
    shuffleLines(input, () => 0.5);
    assert.deepEqual(input, ['a', 'b', 'c']);
  });
});

describe('convertIndent', () => {
  test('spaces become tabs at the configured width', () => {
    assert.deepEqual(convertIndent(['        x'], 'tabs', 4), ['\t\tx']);
  });

  test('tabs become spaces', () => {
    assert.deepEqual(convertIndent(['\t\tx'], 'spaces', 4), ['        x']);
  });

  /// A tab advances to the next stop, it is not worth a fixed count — which
  /// is why the conversion counts visual columns.
  test('a mixed indent converts to the right depth', () => {
    assert.deepEqual(convertIndent(['\t  x'], 'spaces', 4), ['      x']);
  });

  test('only the indent is touched, never the line body', () => {
    assert.deepEqual(convertIndent(['    a\tb'], 'spaces', 4), ['    a\tb']);
  });

  test('an unindented line is unchanged', () => {
    assert.deepEqual(convertIndent(['x'], 'tabs', 4), ['x']);
  });
});

describe('convertCase', () => {
  test('upper and lower', () => {
    assert.equal(convertCase('SeLeCt', 'upper'), 'SELECT');
    assert.equal(convertCase('SeLeCt', 'lower'), 'select');
  });

  test('title uppercases each word and lowercases the rest', () => {
    assert.equal(convertCase('hello WORLD', 'title'), 'Hello World');
  });

  /// Matches what Notepad++ and Sublime do with the same command.
  test('title treats an underscore as a word boundary', () => {
    assert.equal(convertCase('customer_id', 'title'), 'Customer_Id');
  });

  test('swap inverts each letter', () => {
    assert.equal(convertCase('Hello World', 'swap'), 'hELLO wORLD');
  });

  test('digits and punctuation are left alone by swap', () => {
    assert.equal(convertCase('a1-B2', 'swap'), 'A1-b2');
  });

  test('accented letters convert correctly', () => {
    assert.equal(convertCase('žluťoučký', 'upper'), 'ŽLUŤOUČKÝ');
    assert.equal(convertCase('ŽLUŤOUČKÝ', 'title'), 'Žluťoučký');
  });

  test('empty text stays empty', () => {
    for (const m of ['upper', 'lower', 'title', 'swap'] as const) {
      assert.equal(convertCase('', m), '');
    }
  });
});

describe('numberSequence', () => {
  test('counts from a start by a step', () => {
    assert.deepEqual(numberSequence(4, 1, 1), ['1', '2', '3', '4']);
    assert.deepEqual(numberSequence(3, 10, 5), ['10', '15', '20']);
  });

  test('a negative step counts down', () => {
    assert.deepEqual(numberSequence(3, 5, -2), ['5', '3', '1']);
  });

  /// Zero-fill matters when the number becomes part of an identifier and has
  /// to sort as text.
  test('padding zero-fills to a fixed width', () => {
    assert.deepEqual(numberSequence(3, 8, 1, 3), ['008', '009', '010']);
  });

  test('padding goes after the sign, never before it', () => {
    assert.deepEqual(numberSequence(1, -7, 1, 4), ['-007']);
  });

  test('hex output', () => {
    assert.deepEqual(numberSequence(3, 14, 1, 0, true), ['e', 'f', '10']);
  });

  test('a zero or negative count yields nothing', () => {
    assert.deepEqual(numberSequence(0, 1, 1), []);
    assert.deepEqual(numberSequence(-5, 1, 1), []);
  });
});

describe('leadingNumber', () => {
  test('reads an integer, a decimal and a negative', () => {
    assert.equal(leadingNumber('42 rows'), 42);
    assert.equal(leadingNumber('  3.5x'), 3.5);
    assert.equal(leadingNumber('-8'), -8);
  });

  test('a line that does not start with a number has none', () => {
    assert.equal(leadingNumber('id 42'), null);
    assert.equal(leadingNumber(''), null);
  });
});

// ── Indent guides ───────────────────────────────────────────────────────────
// Not in CodeMirror core, so the depth calculation is ours and worth pinning.

describe('indentLevels', () => {
  test('counts whole units of spaces', () => {
    assert.equal(indentLevels('', 2), 0);
    assert.equal(indentLevels('x', 2), 0);
    assert.equal(indentLevels('  x', 2), 1);
    assert.equal(indentLevels('    x', 2), 2);
  });

  /// A tab advances to the next stop; counting it as a fixed width puts the
  /// guides where the text is not.
  test('a tab advances to the next stop', () => {
    assert.equal(indentLevels('\tx', 4), 1);
    assert.equal(indentLevels('  \tx', 4), 1, 'two spaces then a tab is one stop');
    assert.equal(indentLevels('\t\tx', 4), 2);
  });

  test('a partial unit does not count as a level', () => {
    assert.equal(indentLevels('   x', 2), 1);
    assert.equal(indentLevels(' x', 2), 0);
  });

  test('indentation stops at the first non-space', () => {
    assert.equal(indentLevels('  x    y', 2), 1);
  });

  test('a whitespace-only line still reports its depth', () => {
    assert.equal(indentLevels('    ', 2), 2);
  });
});
