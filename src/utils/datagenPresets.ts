/**
 * Generator presets (datagen Phase 5) — a column's generator + params saved
 * under a name, reusable across columns and tables. The DbSchema `ref:` idea:
 * "the way we generate an email address" is said once and pointed at, rather
 * than re-dialed on every column.
 *
 * A preset is deliberately engine-agnostic and connection-free — it is a
 * generator id plus a params bundle, nothing about a server — so it is stored
 * globally (see store/datagenPresets.ts), not per connection.
 *
 * Pure and dependency-free — driven by `node --test`.
 */
import { DEFAULT_PARAMS, GENERATOR_MAP } from './datagen.ts';
import type { ColumnSpec, GenParams } from './datagen.ts';

export interface GenPreset {
  name: string;
  generator: string;
  /** A full params snapshot (see capturePreset for what is excluded). */
  params: GenParams;
}

export const MAX_PRESET_NAME = 60;

/** A usable name, or null. Whitespace is collapsed so "order  status" stays one preset. */
export function normalizePresetName(name: string): string | null {
  const t = name.trim().replace(/\s+/g, ' ');
  return t.length >= 1 && t.length <= MAX_PRESET_NAME ? t : null;
}

/**
 * Snapshot a column's generator config as a preset.
 *
 * The FK address fields (fkTable/fkColumn/fkGroup) are NOT captured: they name
 * a parent in this one schema, and carried into a preset they would silently
 * point every reuse at that same table. The FK *shape* (dist, nullPct) is
 * kept; the address is dialed per column, as before. `uniqueGroup` is stripped
 * for the same reason — it names a scope of sibling columns in this one spec,
 * and a preset reuse would silently join (or single-handedly form) that group.
 */
export function capturePreset(name: string, spec: ColumnSpec): GenPreset | { error: string } {
  const n = normalizePresetName(name);
  if (!n) return { error: `Preset names are 1–${MAX_PRESET_NAME} characters.` };
  if (!GENERATOR_MAP.has(spec.generator)) {
    return { error: `Unknown generator "${spec.generator}" — nothing to save.` };
  }
  const params = { ...spec.params };
  delete params.fkTable;
  delete params.fkColumn;
  delete params.fkGroup;
  delete params.uniqueGroup;
  return { name: n, generator: spec.generator, params };
}

/** Why a preset cannot be applied right now, or null when it can. */
export function presetProblem(p: GenPreset): string | null {
  return GENERATOR_MAP.has(p.generator)
    ? null
    : `unknown generator "${p.generator}" (the catalogue no longer has it)`;
}

/**
 * Apply a preset to a column: the generator and the params are REPLACED, not
 * merged — a preset means "exactly this configuration", and merging would
 * leave dials from the column's previous generator leaking into the new one.
 * The column's name, type and unique flag are untouched.
 */
export function applyPreset(spec: ColumnSpec, preset: GenPreset): ColumnSpec {
  return { ...spec, generator: preset.generator, params: { ...preset.params } };
}

/** Insert or replace by name. */
export function upsertPreset(list: GenPreset[], preset: GenPreset): GenPreset[] {
  return list.some(p => p.name === preset.name)
    ? list.map(p => (p.name === preset.name ? preset : p))
    : [...list, preset];
}

export function removePreset(list: GenPreset[], name: string): GenPreset[] {
  return list.filter(p => p.name !== name);
}

/** Rename, refusing collisions (the store confirms overwrite before calling). */
export function renamePreset(
  list: GenPreset[], oldName: string, newName: string,
): { list: GenPreset[] } | { error: string } {
  const n = normalizePresetName(newName);
  if (!n) return { error: `Preset names are 1–${MAX_PRESET_NAME} characters.` };
  if (!list.some(p => p.name === oldName)) return { error: `No preset named "${oldName}".` };
  if (n !== oldName && list.some(p => p.name === n)) {
    return { error: `A preset named "${n}" already exists.` };
  }
  return { list: list.map(p => (p.name === oldName ? { ...p, name: n } : p)) };
}

/**
 * Tolerant read of the persisted form (localStorage). Structurally broken
 * entries are skipped rather than failing the whole list — a hand-edited or
 * downgraded store should lose one preset, not all of them. Presets naming a
 * generator the catalogue no longer has are KEPT (deleting them would be
 * silent data loss); presetProblem flags them at apply time.
 */
export function parsePresets(raw: unknown): GenPreset[] {
  if (!Array.isArray(raw)) return [];
  const out: GenPreset[] = [];
  for (const e of raw) {
    if (!e || typeof e !== 'object' || Array.isArray(e)) continue;
    const rec = e as Record<string, unknown>;
    const name = typeof rec.name === 'string' ? normalizePresetName(rec.name) : null;
    const generator = rec.generator;
    const p = rec.params;
    if (!name || typeof generator !== 'string' || !generator) continue;
    if (!p || typeof p !== 'object' || Array.isArray(p)) continue;
    // Merge over defaults so a preset saved by an older build (fewer knobs)
    // still yields a complete GenParams — the wire format requires one.
    const params: GenParams = { ...DEFAULT_PARAMS, ...(p as Partial<GenParams>) };
    delete params.fkTable;
    delete params.fkColumn;
    delete params.fkGroup;
    delete params.uniqueGroup;
    out.push({ name, generator, params });
  }
  // Names are the identity; a corrupt file with duplicates keeps the last.
  return [...new Map(out.map(p => [p.name, p])).values()];
}
