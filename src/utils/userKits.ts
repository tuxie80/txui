/**
 * User schema kits (datagen Phase 5) — importing a kit from a JSON file.
 *
 * A kit is a shareable description of a demo *world* (see schemaKits.ts for
 * the bundled five and the type's rationale). The file format is exactly the
 * `SchemaKit` shape as JSON, so a kit that validates here drops into the kit
 * picker next to the bundled ones and generates identically.
 *
 * Validation follows the house rule for hand-written files: EVERY problem is
 * collected with its location ("orders.customer_id: …"), never thrown at the
 * first — a kit is fixed in a text editor, and one-error-at-a-time is a dozen
 * round trips. References are checked against the generator registry
 * (datagen.ts) and against the kit's own tables; out-of-range counts are
 * CLAMPED with a warning rather than rejected, matching how the panel's own
 * inputs clamp.
 *
 * Pure and dependency-free — driven by `node --test`.
 */
import { GENERATOR_MAP, sanitizeGenParams } from './datagen.ts';
import { SCHEMA_KITS } from './schemaKits.ts';
import type { KitColumn, KitTable, SchemaKit } from './schemaKits.ts';

/** Sane bounds, not policy: beyond these the number is a typo, not a design. */
export const MAX_KIT_TABLES = 64;
export const MAX_KIT_COLUMNS = 256;
/**
 * Row-count ceiling for a kit table — the same 1e15 parser guard the panel
 * applies to its own row inputs (f64 integers stay exact to 2^53 ≈ 9.0e15, an
 * order of magnitude above this). resolveRowCounts is deliberately uncapped
 * for the scale knob; a cap lives here instead because a JSON file is typed by
 * hand and `1000000000000000000` is a slipped finger.
 */
export const MAX_KIT_BASE_ROWS = 1e15;
/** Referential ratio bounds — "3 orders per customer", not 3 million. */
export const MIN_KIT_RATIO = 0.001;
export const MAX_KIT_RATIO = 1000;

/** Quoted on the way into DDL, but a kit full of exotic names is a typo farm. */
const IDENT = /^[A-Za-z_][A-Za-z0-9_$]{0,63}$/;
/** Kit ids live next to the bundled ones in one picker; keep them slugs. */
const KIT_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export type KitImport =
  | { ok: true; kit: SchemaKit; warnings: string[] }
  | { ok: false; errors: string[] };

/**
 * Parse and validate a user kit from its JSON text.
 *
 * On success the returned kit is normalized: clamps applied, flags coerced to
 * booleans, params sanitized. The warnings list says what was fixed. On
 * failure the errors list is the COMPLETE problem set.
 */
export function parseUserKit(text: string): KitImport {
  const errors: string[] = [];
  const warnings: string[] = [];

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { ok: false, errors: [`not valid JSON: ${e instanceof Error ? e.message : String(e)}`] };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, errors: ['a kit is a JSON object: { "id", "title", "defaultName", "tables": […] }'] };
  }
  const rec = raw as Record<string, unknown>;

  // ── identity ──
  const id = typeof rec.id === 'string' ? rec.id : '';
  if (!id) errors.push('id: a kit needs an id (a short slug like "shop_demo")');
  else if (!KIT_ID.test(id)) errors.push(`id "${id}": lowercase letters, digits, - and _ only`);
  else if (SCHEMA_KITS.some(k => k.id === id)) {
    errors.push(`id "${id}" is taken by a bundled kit — pick another`);
  }

  const title = typeof rec.title === 'string' ? rec.title.trim() : '';
  if (!title) errors.push('title: a kit needs a display title');
  const description = typeof rec.description === 'string' ? rec.description : '';
  const defaultName = typeof rec.defaultName === 'string' ? rec.defaultName : '';
  if (!defaultName) errors.push('defaultName: the database/schema name the kit suggests');
  else if (!IDENT.test(defaultName)) {
    errors.push(`defaultName "${defaultName}": must be a SQL identifier (it goes into CREATE DATABASE)`);
  }

  // ── tables ──
  const rawTables = rec.tables;
  if (!Array.isArray(rawTables) || rawTables.length === 0) {
    errors.push('tables: a kit needs at least one table');
    return { ok: false, errors };
  }
  if (rawTables.length > MAX_KIT_TABLES) {
    errors.push(`tables: ${rawTables.length} is past the ${MAX_KIT_TABLES}-table limit`);
  }

  const tables: KitTable[] = [];
  const tableIndex = new Map<string, number>();   // name → position (topological order)
  // Every table name mentioned anywhere, valid or not — so an fk pointing at a
  // table listed LATER is reported as an ordering problem, not as "unknown".
  const allTableNames = new Set<string>(
    rawTables.map(rt => (rt && typeof rt === 'object' && !Array.isArray(rt)
      && typeof (rt as Record<string, unknown>).name === 'string')
      ? String((rt as Record<string, unknown>).name) : '').filter(Boolean));
  const take = Math.min(rawTables.length, MAX_KIT_TABLES);
  for (let ti = 0; ti < take; ti++) {
    const rt = rawTables[ti];
    const where = typeof rt === 'object' && rt !== null && typeof (rt as Record<string, unknown>).name === 'string'
      ? String((rt as Record<string, unknown>).name)
      : `table[${ti}]`;
    if (!rt || typeof rt !== 'object' || Array.isArray(rt)) {
      errors.push(`${where}: a table is an object: { "name", "rows", "columns": […] }`);
      continue;
    }
    const t = rt as Record<string, unknown>;

    const name = typeof t.name === 'string' ? t.name : '';
    if (!name) errors.push(`table[${ti}]: missing name`);
    else if (!IDENT.test(name)) errors.push(`${name}: table name must be a SQL identifier`);
    else if (tableIndex.has(name)) errors.push(`${name}: duplicate table name`);

    const columns = parseColumns(t.columns, name || where, tableIndex, allTableNames, errors, warnings);
    const rows = parseRows(t.rows, name || where, tableIndex, errors, warnings);
    const indexes = parseIndexes(t.indexes, name || where, columns, errors);

    if (name && !tableIndex.has(name)) tableIndex.set(name, tables.length);
    // Tables with fatal shape errors are still carried (with what parsed) so
    // later tables' FK checks see the real name list — one bad table must not
    // cascade into a hundred "unknown table" errors.
    tables.push({
      name: name || `table_${ti}`,
      columns,
      rows: rows ?? { base: 1 },
      ...(indexes.length ? { indexes } : {}),
    });
  }

  if (errors.length) return { ok: false, errors };
  const kit: SchemaKit = { id, title, description, defaultName, tables };
  // Column-existence and composite-group checks need the parsed tables, so
  // they run as a second pass (checkFkTargets).
  const fkErrors = checkFkTargets(kit);
  if (fkErrors.length) return { ok: false, errors: fkErrors };
  return { ok: true, kit, warnings };
}

function parseColumns(
  raw: unknown, tname: string, tableIndex: Map<string, number>,
  allTableNames: Set<string>,
  errors: string[], warnings: string[],
): KitColumn[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    errors.push(`${tname}: needs at least one column`);
    return [];
  }
  if (raw.length > MAX_KIT_COLUMNS) {
    errors.push(`${tname}: ${raw.length} columns is past the ${MAX_KIT_COLUMNS}-column limit`);
  }
  const cols: KitColumn[] = [];
  const seen = new Set<string>();
  for (let ci = 0; ci < Math.min(raw.length, MAX_KIT_COLUMNS); ci++) {
    const rc = raw[ci];
    const obj = rc && typeof rc === 'object' && !Array.isArray(rc) ? rc as Record<string, unknown> : null;
    const cname = obj && typeof obj.name === 'string' ? obj.name : '';
    const where = cname ? `${tname}.${cname}` : `${tname}.column[${ci}]`;
    if (!obj) {
      errors.push(`${where}: a column is an object: { "name", "type", "generator", … }`);
      continue;
    }
    if (!cname) errors.push(`${where}: missing name`);
    else if (!IDENT.test(cname)) errors.push(`${where}: column name must be a SQL identifier`);
    else if (seen.has(cname)) errors.push(`${where}: duplicate column name`);
    if (cname) seen.add(cname);

    const type = typeof obj.type === 'string' ? obj.type.trim() : '';
    if (!type) errors.push(`${where}: missing type (a MySQL-flavoured type like "BIGINT" or "VARCHAR(100)")`);

    const generator = typeof obj.generator === 'string' ? obj.generator : '';
    if (!generator) errors.push(`${where}: missing generator`);
    else if (!GENERATOR_MAP.has(generator)) {
      errors.push(`${where}: unknown generator "${generator}"`);
    }

    // Params ride sanitizeGenParams (datagen.ts): types are errors, ranges
    // are clamps with warnings.
    const sp = sanitizeGenParams(obj.params, where);
    errors.push(...sp.errors);
    warnings.push(...sp.warnings);

    // ── FK references, checked against the kit's own tables ──
    // Table-level checks happen here (the name lists are all that is needed);
    // COLUMN existence and composite-group consistency run as a second pass
    // (checkFkTargets) once every table is parsed.
    let fk: KitColumn['fk'];
    if (obj.fk !== undefined && obj.fk !== null) {
      const f = obj.fk;
      if (!f || typeof f !== 'object' || Array.isArray(f)) {
        errors.push(`${where}: fk must be an object: { "table", "column", "dist"?, "group"? }`);
      } else {
        const fr = f as Record<string, unknown>;
        const ftable = typeof fr.table === 'string' ? fr.table : '';
        const fcolumn = typeof fr.column === 'string' ? fr.column : '';
        if (!ftable) errors.push(`${where}: fk needs a table`);
        else if (ftable !== tname && !allTableNames.has(ftable)) {
          errors.push(`${where}: fk references unknown table "${ftable}" — a kit may only reference its own tables`);
        } else if (ftable !== tname && !tableIndex.has(ftable)) {
          // Parents generate before children, so the target must be THIS
          // table (self-reference) or an earlier one.
          errors.push(`${where}: fk references "${ftable}", which comes later in the kit — parents must be listed before children`);
        }
        if (!fcolumn) errors.push(`${where}: fk needs a column`);
        const rawDist = fr.dist;
        const dist: 'uniform' | 'zipf' | undefined =
          rawDist === 'uniform' || rawDist === 'zipf' ? rawDist : undefined;
        if (rawDist !== undefined && dist === undefined) {
          errors.push(`${where}: fk.dist must be "uniform" or "zipf"`);
        }
        const group = fr.group === undefined ? undefined : fr.group;
        if (group !== undefined && typeof group !== 'string') {
          errors.push(`${where}: fk.group must be a string`);
        }
        if (ftable && fcolumn && (rawDist === undefined || dist !== undefined)) {
          fk = {
            table: ftable, column: fcolumn,
            ...(dist ? { dist } : {}),
            ...(typeof group === 'string' ? { group } : {}),
          };
        }
      }
    }
    // The fk generator and the fk block must agree — a column named as an FK
    // without the generator (or vice versa) generates independent integers
    // instead of references, silently.
    if (fk && generator === 'fk') { /* consistent */ }
    else if (fk && generator && generator !== 'fk') {
      errors.push(`${where}: has an fk block but generator "${generator}" — the generator must be "fk"`);
    } else if (!fk && generator === 'fk') {
      errors.push(`${where}: generator "fk" needs an fk block naming the parent table and column`);
    }

    // ── server-computed columns ──
    let generated: KitColumn['generated'];
    if (obj.generated !== undefined && obj.generated !== null) {
      const g = obj.generated;
      const okShape = g && typeof g === 'object' && !Array.isArray(g)
        && typeof (g as Record<string, unknown>).mysql === 'string'
        && typeof (g as Record<string, unknown>).postgres === 'string'
        && typeof (g as Record<string, unknown>).sqlserver === 'string';
      if (!okShape) {
        errors.push(`${where}: generated needs all three dialects: { "mysql", "postgres", "sqlserver" }`);
      } else {
        const gr = g as Record<string, string>;
        generated = { mysql: gr.mysql, postgres: gr.postgres, sqlserver: gr.sqlserver };
      }
    }

    cols.push({
      name: cname || `column_${ci}`,
      type: type || 'TEXT',
      generator: generator || 'constant',
      ...(Object.keys(sp.params).length ? { params: sp.params } : {}),
      ...(obj.pk ? { pk: true } : {}),
      ...(obj.nullable ? { nullable: true } : {}),
      ...(obj.unique ? { unique: true } : {}),
      ...(fk ? { fk } : {}),
      ...(generated ? { generated } : {}),
    });
  }
  return cols;
}

function parseRows(
  raw: unknown, tname: string, tableIndex: Map<string, number>,
  errors: string[], warnings: string[],
): KitTable['rows'] | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    errors.push(`${tname}: rows must be { "base": n } or { "per": "parent", "ratio": r }`);
    return null;
  }
  const r = raw as Record<string, unknown>;
  if (r.base !== undefined) {
    const base = r.base;
    if (typeof base !== 'number' || !Number.isFinite(base)) {
      errors.push(`${tname}: rows.base must be a number`);
      return null;
    }
    const clamped = Math.min(MAX_KIT_BASE_ROWS, Math.max(1, Math.round(base)));
    if (clamped !== base) {
      warnings.push(`${tname}: rows.base ${base} clamped to ${clamped}`);
    }
    return { base: clamped };
  }
  const per = typeof r.per === 'string' ? r.per : '';
  const ratio = r.ratio;
  let ok = true;
  if (!per) { errors.push(`${tname}: rows.per must name an earlier table`); ok = false; }
  else if (per === tname) { errors.push(`${tname}: rows.per cannot be the table itself`); ok = false; }
  else if (!tableIndex.has(per)) {
    errors.push(`${tname}: rows.per references "${per}" — it must name an EARLIER table in the kit (its row count is what this multiplies)`);
    ok = false;
  }
  if (typeof ratio !== 'number' || !Number.isFinite(ratio) || ratio <= 0) {
    errors.push(`${tname}: rows.ratio must be a positive number`);
    ok = false;
  }
  if (!ok) return null;
  const clamped = Math.min(MAX_KIT_RATIO, Math.max(MIN_KIT_RATIO, ratio as number));
  if (clamped !== ratio) {
    warnings.push(`${tname}: rows.ratio ${ratio} clamped to ${clamped}`);
  }
  return { per, ratio: clamped };
}

function parseIndexes(
  raw: unknown, tname: string, columns: KitColumn[], errors: string[],
): string[][] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    errors.push(`${tname}: indexes must be an array of column-name arrays`);
    return [];
  }
  const colNames = new Set(columns.map(c => c.name));
  const out: string[][] = [];
  for (let i = 0; i < raw.length; i++) {
    const idx = raw[i];
    if (!Array.isArray(idx) || idx.length === 0 || idx.some(c => typeof c !== 'string')) {
      errors.push(`${tname}: indexes[${i}] must be an array of column names`);
      continue;
    }
    for (const c of idx as string[]) {
      if (!colNames.has(c)) errors.push(`${tname}: indexes[${i}] names unknown column "${c}"`);
    }
    out.push(idx as string[]);
  }
  return out;
}

/**
 * Second-order check the single pass cannot do: fk targets pointing at
 * EARLIER tables have their columns validated against the parsed kit. Called
 * by parseUserKit on the finished table list. (Split out so the column parser
 * stays a single pass over the raw JSON.)
 */
export function checkFkTargets(kit: SchemaKit): string[] {
  const errors: string[] = [];
  const byName = new Map(kit.tables.map(t => [t.name, t]));
  for (const t of kit.tables) {
    const groups = new Map<string, string>();   // group → target table
    for (const c of t.columns) {
      if (!c.fk) continue;
      const target = byName.get(c.fk.table);
      if (!target) continue;   // unknown table was already reported
      if (!target.columns.some(tc => tc.name === c.fk!.column)) {
        errors.push(`${t.name}.${c.name}: fk column "${c.fk.column}" does not exist in "${c.fk.table}"`);
      }
      if (c.fk.group) {
        const prev = groups.get(c.fk.group);
        if (prev !== undefined && prev !== c.fk.table) {
          errors.push(`${t.name}.${c.name}: fk group "${c.fk.group}" mixes targets ("${prev}" and "${c.fk.table}") — one group is ONE composite key to ONE table`);
        } else {
          groups.set(c.fk.group, c.fk.table);
        }
      }
    }
  }
  return errors;
}

/**
 * Tolerant read of the persisted list (localStorage). Anything that does not
 * look like a kit is skipped — the full validation happened at import time;
 * this guards against a hand-edited or version-skewed store.
 */
export function parseStoredKits(raw: unknown): SchemaKit[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((k): k is SchemaKit =>
    !!k && typeof k === 'object'
    && typeof (k as SchemaKit).id === 'string'
    && typeof (k as SchemaKit).title === 'string'
    && Array.isArray((k as SchemaKit).tables));
}
