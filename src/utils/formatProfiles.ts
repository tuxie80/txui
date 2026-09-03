/**
 * Named formatting styles.
 *
 * One keyword-case toggle is enough right up until you work on two codebases.
 * House styles differ on things people genuinely argue about — tabs against
 * spaces, leading against trailing commas, uppercase keywords — and the answer
 * is not to pick one, it is to let the setting be a named thing you switch.
 *
 * The three built-ins are not arbitrary: they are the conventions that actually
 * exist in the wild, so most people will find theirs already here rather than
 * building it.
 *
 * Pure and dependency-free — driven by `node --test`.
 */
import type { BeautifyOptions } from './sqlBeautify.ts';

export interface FormatProfile {
  id: string;
  name: string;
  /** Shown under the name in the picker; says who writes like this. */
  note?: string;
  keywordCase: 'upper' | 'lower';
  /** Spaces per level, or 0 to indent with a tab. */
  indentWidth: number;
  /** `trailing`: `a,\n b`. `leading`: `a\n, b`. */
  commaStyle: 'trailing' | 'leading';
  /** Uppercase built-in function names too. */
  functionCase: 'upper' | 'lower' | 'preserve';
  /** True to keep the user's blank lines between statements. */
  preserveBlankLines: boolean;
  /** Read-only: a built-in cannot be edited, only copied. */
  builtin?: boolean;
}

export const BUILT_IN_PROFILES: FormatProfile[] = [
  {
    id: 'default',
    name: 'TxUI default',
    note: 'Uppercase keywords, two spaces, trailing commas.',
    keywordCase: 'upper',
    indentWidth: 2,
    commaStyle: 'trailing',
    functionCase: 'preserve',
    preserveBlankLines: true,
    builtin: true,
  },
  {
    id: 'leading-comma',
    name: 'Leading commas',
    note: 'The style that makes a commented-out column a one-character edit.',
    keywordCase: 'upper',
    indentWidth: 4,
    commaStyle: 'leading',
    functionCase: 'preserve',
    preserveBlankLines: true,
    builtin: true,
  },
  {
    id: 'lowercase',
    name: 'Lowercase',
    note: 'Common in PostgreSQL and ORM-adjacent codebases.',
    keywordCase: 'lower',
    indentWidth: 2,
    commaStyle: 'trailing',
    functionCase: 'lower',
    preserveBlankLines: true,
    builtin: true,
  },
  {
    id: 'tabs',
    name: 'Tabs',
    note: 'Indent with a tab, so the reader picks the width.',
    keywordCase: 'upper',
    indentWidth: 0,
    commaStyle: 'trailing',
    functionCase: 'preserve',
    preserveBlankLines: true,
    builtin: true,
  },
];

export const DEFAULT_PROFILE_ID = 'default';

/** The indent string a profile implies. */
export function indentOf(p: FormatProfile): string {
  return p.indentWidth <= 0 ? '\t' : ' '.repeat(p.indentWidth);
}

/** Beautifier options for a profile. */
export function optionsFor(p: FormatProfile, engine?: BeautifyOptions['engine']): BeautifyOptions {
  return { keywordCase: p.keywordCase, engine };
}

/**
 * Move commas from the end of a line to the start of the next.
 *
 * Applied after the beautifier rather than inside it: comma placement is
 * purely visual and does not interact with anything else the formatter
 * decides, so bolting it on keeps one formatting engine instead of two.
 *
 * Only top-level commas at end-of-line move. A comma inside `DECIMAL(10,2)` or
 * a string is left alone, which is the same rule everything else here follows.
 */
export function applyCommaStyle(sql: string, style: FormatProfile['commaStyle']): string {
  if (style !== 'leading') return sql;
  const lines = sql.split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.replace(/\s+$/, '');
    if (!trimmed.endsWith(',') || i === lines.length - 1) {
      out.push(line);
      continue;
    }
    // The next line takes the comma, keeping its own indentation.
    const next = lines[i + 1] ?? '';
    const lead = /^\s*/.exec(next)?.[0] ?? '';
    if (!next.trim()) { out.push(line); continue; }
    out.push(trimmed.slice(0, -1).replace(/\s+$/, ''));
    lines[i + 1] = `${lead.slice(0, Math.max(0, lead.length - 2))}, ${next.trim()}`;
  }
  return out.join('\n');
}

/** Re-indent from the beautifier's two spaces to the profile's unit. */
export function applyIndent(sql: string, profile: FormatProfile): string {
  const unit = indentOf(profile);
  if (unit === '  ') return sql;
  return sql.split('\n').map(line => {
    const m = /^( +)/.exec(line);
    if (!m) return line;
    const levels = Math.floor(m[1].length / 2);
    return unit.repeat(levels) + line.slice(m[1].length);
  }).join('\n');
}

/** Everything a profile changes, applied to already-beautified SQL. */
export function applyProfile(sql: string, profile: FormatProfile): string {
  return applyCommaStyle(applyIndent(sql, profile), profile.commaStyle);
}

// ── storage ──────────────────────────────────────────────────────────────────

const KEY = 'dbgui.formatProfiles';
const ACTIVE_KEY = 'dbgui.formatProfile';

/** User profiles, plus the built-ins. Built-ins always win a name clash. */
export function loadProfiles(storage: Storage): FormatProfile[] {
  let custom: FormatProfile[] = [];
  try {
    const raw = storage.getItem(KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    if (Array.isArray(parsed)) {
      custom = parsed.filter((p: unknown): p is FormatProfile =>
        !!p && typeof p === 'object' && typeof (p as FormatProfile).id === 'string');
    }
  } catch { /* corrupt storage falls back to the built-ins */ }
  const builtinIds = new Set(BUILT_IN_PROFILES.map(p => p.id));
  return [...BUILT_IN_PROFILES, ...custom.filter(p => !builtinIds.has(p.id))];
}

export function saveProfiles(profiles: FormatProfile[], storage: Storage): void {
  try {
    storage.setItem(KEY, JSON.stringify(profiles.filter(p => !p.builtin)));
  } catch { /* quota */ }
}

/** The active profile, falling back to the default when it has been deleted. */
export function activeProfile(storage: Storage): FormatProfile {
  const all = loadProfiles(storage);
  let id = DEFAULT_PROFILE_ID;
  try { id = storage.getItem(ACTIVE_KEY) ?? DEFAULT_PROFILE_ID; } catch { /* ignore */ }
  return all.find(p => p.id === id) ?? all[0];
}

export function setActiveProfile(id: string, storage: Storage): void {
  try { storage.setItem(ACTIVE_KEY, id); } catch { /* quota */ }
}

/** A copy of a profile, ready to edit. Built-ins are copied, never mutated. */
export function duplicateProfile(p: FormatProfile, existing: FormatProfile[]): FormatProfile {
  const base = `${p.id}-copy`;
  let id = base;
  let n = 2;
  while (existing.some(x => x.id === id)) id = `${base}-${n++}`;
  return { ...p, id, name: `${p.name} copy`, note: undefined, builtin: false };
}
