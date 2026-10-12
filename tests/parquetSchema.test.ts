/**
 * tests for src/utils/parquetSchema.ts — the pure half of "create a Parquet
 * file with a chosen schema" (ParquetSchemaDialog → create_parquet_file).
 * The rules tested here are mirrored in Rust
 * (commands/export.rs::resolve_parquet_type + create_parquet_file validation);
 * a change to one must land in the other.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  PARQUET_TYPES, DECIMAL_DEFAULTS, MAX_PRECISION, MAX_NAME_LEN,
  newColumnDraft, dataTypeSpec, buildPayload, validateColumns,
  type ParquetColumnDraft,
} from '../src/utils/parquetSchema.ts';

function col(over: Partial<ParquetColumnDraft> = {}): ParquetColumnDraft {
  return { ...newColumnDraft('c1'), ...over };
}

describe('the type list mirrors the Rust allowlist', () => {
  test('exactly the eight types the backend maps, each with a label', () => {
    assert.deepEqual(
      PARQUET_TYPES.map(t => t.id),
      ['string', 'integer', 'float', 'boolean', 'date', 'timestamp', 'decimal', 'binary'],
    );
    for (const t of PARQUET_TYPES) assert.ok(t.label.trim().length > 0, `unlabeled type ${t.id}`);
  });

  test('only decimal asks for parameters', () => {
    const withParams = PARQUET_TYPES.filter(t => t.needsParams).map(t => t.id);
    assert.deepEqual(withParams, ['decimal']);
  });
});

describe('dataTypeSpec', () => {
  test('scalar types pass through by name', () => {
    assert.equal(dataTypeSpec(col({ type: 'string' })), 'string');
    assert.equal(dataTypeSpec(col({ type: 'timestamp' })), 'timestamp');
    assert.equal(dataTypeSpec(col({ type: 'binary' })), 'binary');
  });

  test('decimal spells out its parameters the way the Rust parser reads them', () => {
    assert.equal(dataTypeSpec(col({ type: 'decimal', precision: 10, scale: 2 })), 'decimal(10,2)');
    assert.equal(dataTypeSpec(col({ type: 'decimal', precision: 38, scale: 0 })), 'decimal(38,0)');
  });
});

describe('buildPayload', () => {
  test('emits the command payload shape, names trimmed', () => {
    const out = buildPayload([
      col({ name: '  id  ', type: 'integer', nullable: false }),
      col({ name: 'amount', type: 'decimal', precision: 12, scale: 4 }),
    ]);
    assert.deepEqual(out, [
      { name: 'id', data_type: 'integer', nullable: false },
      { name: 'amount', data_type: 'decimal(12,4)', nullable: true },
    ]);
  });
});

describe('validateColumns', () => {
  test('an empty schema is refused', () => {
    assert.ok(validateColumns([]).some(e => /at least one column/i.test(e)));
  });

  test('a sound schema produces no errors', () => {
    assert.deepEqual(validateColumns([
      col({ name: 'id', type: 'integer', nullable: false }),
      col({ name: 'price', type: 'decimal', precision: 10, scale: 2 }),
      col({ name: 'note', type: 'string' }),
    ]), []);
  });

  test('names: empty, whitespace-only, too long, control characters', () => {
    assert.ok(validateColumns([col({ name: '' })]).some(e => /name is required/.test(e)));
    assert.ok(validateColumns([col({ name: '   ' })]).some(e => /name is required/.test(e)));
    assert.ok(validateColumns([col({ name: 'x'.repeat(MAX_NAME_LEN + 1) })])
      .some(e => /longer than/.test(e)));
    // Exactly at the limit is fine.
    assert.deepEqual(validateColumns([col({ name: 'x'.repeat(MAX_NAME_LEN) })]), []);
    assert.ok(validateColumns([col({ name: 'a\u0007b' })]).some(e => /control character/.test(e)));
  });

  test('duplicates are reported once, on the second occurrence', () => {
    const errors = validateColumns([col({ name: 'a' }), col({ name: 'b' }), col({ name: 'a' })]);
    assert.deepEqual(errors, ['column 3: duplicate name "a"']);
  });

  test('decimal bounds: precision 1..=38, scale 0..precision', () => {
    assert.ok(validateColumns([col({ type: 'decimal', precision: 0 })]).some(e => /precision/.test(e)));
    assert.ok(validateColumns([col({ type: 'decimal', precision: MAX_PRECISION + 1 })])
      .some(e => /precision/.test(e)));
    assert.ok(validateColumns([col({ type: 'decimal', precision: 5.5 })])
      .some(e => /whole number/.test(e)));
    assert.ok(validateColumns([col({ type: 'decimal', precision: 10, scale: -1 })])
      .some(e => /scale/.test(e)));
    assert.ok(validateColumns([col({ type: 'decimal', precision: 4, scale: 5 })])
      .some(e => /cannot exceed precision/.test(e)));
    // Boundaries are valid.
    assert.deepEqual(validateColumns([col({ type: 'decimal', precision: 38, scale: 38 })]), []);
    assert.deepEqual(validateColumns([col({ type: 'decimal', precision: 1, scale: 0 })]), []);
    // The dialog defaults are valid — a user who touches nothing can create.
    assert.deepEqual(validateColumns([col({ type: 'decimal', ...DECIMAL_DEFAULTS })]), []);
  });

  test('decimal rules do not fire for scalar types carrying stray params', () => {
    assert.deepEqual(validateColumns([col({ type: 'integer', precision: 0, scale: -3 })]), []);
  });

  test('every error names its row', () => {
    const errors = validateColumns([col({ name: '' }), col({ name: '' })]);
    assert.equal(errors.length, 2);
    assert.ok(errors[0].startsWith('column 1:'), errors[0]);
    assert.ok(errors[1].startsWith('column 2:'), errors[1]);
  });
});
