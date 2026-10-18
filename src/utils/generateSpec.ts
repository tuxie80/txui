/**
 * The TxShell `\generate` verb's spec file (datagen Phase 5) — one JSON object
 * describing a run of the SAME `generate_data` pipeline the 🎲 panel drives:
 *
 *   {
 *     "table": "shop.customers",           // required; qualified as needed
 *     "rowCount": 100000,                  // required, 1..1e15
 *     "seed": 7,                           // optional, default 1 (a script
 *                                          //   should be reproducible)
 *     "locale": "cs",                      // optional, default "default"
 *     "useCopy": true,                     // optional, PG COPY fast path
 *     "createDdl": "CREATE TABLE …",       // optional, run first
 *     "specs": [                           // required, ≥ 1 column
 *       { "name": "id", "typeName": "BIGINT", "generator": "sequence",
 *         "unique": true },
 *       { "name": "email", "typeName": "VARCHAR(255)", "generator": "email",
 *         "params": { "nullPct": 5 } }
 *     ]
 *   }
 *
 * Generators and params are the panel's — params keys not given default to
 * DEFAULT_PARAMS, so a spec only states what it changes. Every problem is
 * collected with its column location, never thrown at the first (a spec file
 * is fixed in an editor).
 *
 * Pure and dependency-free — driven by `node --test`.
 */
import { DEFAULT_PARAMS, GENERATOR_MAP, sanitizeGenParams, validateUniqueGroups } from './datagen.ts';
import type { ColumnSpec } from './datagen.ts';

export interface GenerateSpec {
  /** Pre-quoted, possibly qualified — exactly what GenRun.table carries. */
  table: string;
  rowCount: number;
  seed: number;
  locale: string;
  useCopy: boolean;
  createDdl: string | null;
  specs: ColumnSpec[];
}

/**
 * The panel's own parser guard (MAX_ROWS in DataGenPanel): f64 integers are
 * exact to 2^53 ≈ 9.0e15, and 1e15 stays an order of magnitude under it, so
 * chunk arithmetic never drifts. Beyond it a run is refused, not clamped —
 * this file is the whole instruction, and a wrong count must not silently
 * become a different run.
 */
export const GENERATE_MAX_ROWS = 1e15;

export type ParsedGenerateSpec =
  | { ok: true; spec: GenerateSpec }
  | { ok: false; errors: string[] };

export function parseGenerateSpec(text: string): ParsedGenerateSpec {
  const errors: string[] = [];

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { ok: false, errors: [`not valid JSON: ${e instanceof Error ? e.message : String(e)}`] };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, errors: ['a generate spec is a JSON object: { "table", "rowCount", "specs": […] }'] };
  }
  const rec = raw as Record<string, unknown>;

  const table = typeof rec.table === 'string' ? rec.table.trim() : '';
  if (!table) errors.push('table: name the target table ("db.customers" — qualify it; the generator runs on its own connection)');

  const rc = rec.rowCount;
  let rowCount = 0;
  if (typeof rc !== 'number' || !Number.isInteger(rc)) {
    errors.push('rowCount: must be an integer');
  } else if (rc < 1 || rc > GENERATE_MAX_ROWS) {
    errors.push(`rowCount: ${rc} is outside 1…${GENERATE_MAX_ROWS.toExponential(0)}`);
  } else {
    rowCount = rc;
  }

  let seed = 1;
  if (rec.seed !== undefined) {
    if (typeof rec.seed !== 'number' || !Number.isInteger(rec.seed) || rec.seed < 0) {
      errors.push('seed: must be a non-negative integer');
    } else {
      seed = rec.seed;
    }
  }

  let locale = 'default';
  if (rec.locale !== undefined) {
    if (typeof rec.locale !== 'string' || !rec.locale) errors.push('locale: must be a string ("default", "cs", "en_GB", "ja"…)');
    else locale = rec.locale;
  }

  let useCopy = true;
  if (rec.useCopy !== undefined) {
    if (typeof rec.useCopy !== 'boolean') errors.push('useCopy: must be true or false');
    else useCopy = rec.useCopy;
  }

  let createDdl: string | null = null;
  if (rec.createDdl !== undefined && rec.createDdl !== null) {
    if (typeof rec.createDdl !== 'string' || !rec.createDdl.trim()) {
      errors.push('createDdl: must be a CREATE TABLE statement');
    } else {
      createDdl = rec.createDdl;
    }
  }

  const specs: ColumnSpec[] = [];
  const rawSpecs = rec.specs;
  if (!Array.isArray(rawSpecs) || rawSpecs.length === 0) {
    errors.push('specs: at least one column is required');
  } else {
    const seen = new Set<string>();
    for (let i = 0; i < rawSpecs.length; i++) {
      const rs = rawSpecs[i];
      const obj = rs && typeof rs === 'object' && !Array.isArray(rs) ? rs as Record<string, unknown> : null;
      const name = obj && typeof obj.name === 'string' ? obj.name.trim() : '';
      const where = name || `specs[${i}]`;
      if (!obj) {
        errors.push(`${where}: a column spec is an object: { "name", "typeName", "generator", "params"? }`);
        continue;
      }
      if (!name) errors.push(`specs[${i}]: missing name`);
      else if (seen.has(name)) errors.push(`${where}: duplicate column name`);
      if (name) seen.add(name);

      const typeName = typeof obj.typeName === 'string' ? obj.typeName.trim() : '';
      if (!typeName) errors.push(`${where}: missing typeName ("BIGINT", "VARCHAR(255)"…)`);

      const generator = typeof obj.generator === 'string' ? obj.generator : '';
      if (!generator) errors.push(`${where}: missing generator`);
      else if (!GENERATOR_MAP.has(generator)) errors.push(`${where}: unknown generator "${generator}"`);

      const sp = sanitizeGenParams(obj.params, where);
      errors.push(...sp.errors);
      // Warnings from the sanitizer (clamps, dropped keys) would be invisible
      // in a file-driven run; treat them as errors so the file says what it
      // means.
      errors.push(...sp.warnings);

      if (obj.unique !== undefined && typeof obj.unique !== 'boolean') {
        errors.push(`${where}: unique must be true or false`);
      }

      specs.push({
        name: name || `column_${i}`,
        typeName: typeName || 'TEXT',
        generator: generator || 'constant',
        params: { ...DEFAULT_PARAMS, ...sp.params },
        ...(obj.unique === true ? { unique: true } : {}),
      });
    }
  }

  // Composite uniqueness groups are config-checked here too — headless, a bad
  // group must fail the parse, not die mid-run in the writer's own validation.
  if (!errors.length) {
    errors.push(...validateUniqueGroups(specs).map(p => `${p.column}: ${p.reason}`));
  }

  if (errors.length) return { ok: false, errors };
  return { ok: true, spec: { table, rowCount, seed, locale, useCopy, createDdl, specs } };
}
