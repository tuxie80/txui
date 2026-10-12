/**
 * Schema designer for a NEW Parquet file — the connection form's *New…*
 * button → ParquetSchemaDialog → `create_parquet_file`.
 *
 * PURE (no React/Tauri — the repo's utils contract, node-testable). The type
 * allowlist below is the single source for the dialog's dropdown and is
 * mirrored by the Rust side (`commands/export.rs::resolve_parquet_type`),
 * which re-validates everything: the two lists must move together.
 */

export type ParquetTypeId =
  | 'string' | 'integer' | 'float' | 'boolean' | 'date' | 'timestamp' | 'decimal' | 'binary';

export interface ParquetTypeOption {
  id: ParquetTypeId;
  label: string;
  /** decimal carries precision/scale inputs in the dialog. */
  needsParams?: boolean;
}

/** The dropdown order is the display order — most-wanted first. */
export const PARQUET_TYPES: readonly ParquetTypeOption[] = [
  { id: 'string',    label: 'string (UTF-8 text)' },
  { id: 'integer',   label: 'integer (64-bit)' },
  { id: 'float',     label: 'float (double)' },
  { id: 'boolean',   label: 'boolean' },
  { id: 'date',      label: 'date' },
  { id: 'timestamp', label: 'timestamp (ms)' },
  { id: 'decimal',   label: 'decimal (exact, p/s)', needsParams: true },
  { id: 'binary',    label: 'binary' },
];

export const DECIMAL_DEFAULTS = { precision: 18, scale: 2 } as const;
export const MAX_PRECISION = 38;
export const MAX_NAME_LEN = 128;

/** One row of the dialog. precision/scale are only read when type is decimal. */
export interface ParquetColumnDraft {
  name: string;
  type: ParquetTypeId;
  nullable: boolean;
  precision: number;
  scale: number;
}

export function newColumnDraft(name = ''): ParquetColumnDraft {
  return { name, type: 'string', nullable: true, ...DECIMAL_DEFAULTS };
}

/** The wire form of a column's type — `decimal` spells out its parameters. */
export function dataTypeSpec(c: ParquetColumnDraft): string {
  return c.type === 'decimal' ? `decimal(${c.precision},${c.scale})` : c.type;
}

/** The `create_parquet_file` argument shape (snake_case inside the payload). */
export interface ParquetColumnPayload {
  name: string;
  data_type: string;
  nullable: boolean;
}

export function buildPayload(cols: ParquetColumnDraft[]): ParquetColumnPayload[] {
  return cols.map(c => ({ name: c.name.trim(), data_type: dataTypeSpec(c), nullable: c.nullable }));
}

/**
 * Every problem with the draft, human-readable, in row order. The Rust side
 * enforces the same rules — this list exists so the dialog can say what is
 * wrong BEFORE the save dialog opens, not after.
 */
export function validateColumns(cols: ParquetColumnDraft[]): string[] {
  const errors: string[] = [];
  if (cols.length === 0) {
    errors.push('Add at least one column — a Parquet file is its schema.');
    return errors;
  }
  const seen = new Set<string>();
  cols.forEach((c, i) => {
    const row = `column ${i + 1}`;
    const name = c.name.trim();
    if (!name) {
      errors.push(`${row}: name is required`);
    } else {
      if ([...name].length > MAX_NAME_LEN) {
        errors.push(`${row}: name is longer than ${MAX_NAME_LEN} characters`);
      }
      // eslint-disable-next-line no-control-regex
      if (/[\u0000-\u001f\u007f]/.test(name)) {
        errors.push(`${row}: name contains a control character`);
      }
      if (seen.has(name)) {
        errors.push(`${row}: duplicate name "${name}"`);
      }
      seen.add(name);
    }
    if (c.type === 'decimal') {
      const { precision: p, scale: s } = c;
      if (!Number.isInteger(p) || p < 1 || p > MAX_PRECISION) {
        errors.push(`${row}: decimal precision must be a whole number 1–${MAX_PRECISION}`);
      }
      if (!Number.isInteger(s) || s < 0) {
        errors.push(`${row}: decimal scale must be a whole number ≥ 0`);
      } else if (Number.isInteger(p) && s > p) {
        errors.push(`${row}: decimal scale (${s}) cannot exceed precision (${p})`);
      }
    }
  });
  return errors;
}
