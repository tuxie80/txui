/**
 * SQL Quality report assembly — a Markdown deep-dive document plus a raw-
 * output .txt, mirroring the structure of a manual query analysis
 * (exec summary of ranked findings → sections → raw appendices).
 */
import type { Evidence, Finding, Severity } from './sqlLint.ts';
import { SEVERITY_ORDER } from './sqlLint.ts';

/**
 * ── Detail levels ─────────────────────────────────────────────────────────
 *
 * A 45-finding report is unusable at one fixed depth. Too terse and nobody
 * can act on it; too verbose and nobody reads it twice. The same findings are
 * therefore rendered at five depths, and the depth is the reader's choice —
 * not the analyzer's.
 *
 *   oneline   one grep-able line per finding — scanning, tickets, diffs
 *   summary   the verdict: counts and a table, nothing else
 *   standard  what was observed and the fix (the previous, only, behaviour)
 *   deep      + why it matters, the evidence with its source, the rule cited
 *   forensic  + the passed checks, the assumptions, the raw command output
 *
 * Two switches are deliberately *not* folded into the level, because they are
 * genuinely independent of it: a severity floor (a one-line report of
 * blockers only is a perfectly reasonable thing to want) and whether the
 * checks that passed are shown (the difference between a report that nags and
 * one that is trusted).
 */
export type DetailLevel = 'oneline' | 'summary' | 'standard' | 'deep' | 'forensic';

export const DETAIL_LEVELS: readonly DetailLevel[] = [
  'oneline', 'summary', 'standard', 'deep', 'forensic',
];

/** How each level presents itself in the picker. */
export const DETAIL_LABEL: Record<DetailLevel, string> = {
  oneline:  'One line',
  summary:  'Summary',
  standard: 'Standard',
  deep:     'Deep',
  forensic: 'Forensic',
};

export const DETAIL_HINT: Record<DetailLevel, string> = {
  oneline:  'One grep-able line per finding — for scanning and pasting into a ticket',
  summary:  'Counts and a table: the verdict, nothing else',
  standard: 'What was observed and how to fix it',
  deep:     'Adds why it matters, the evidence behind each number, and the rule cited',
  forensic: 'Adds the checks that passed, the assumptions used, and the raw output',
};

const DEPTH: Record<DetailLevel, number> = {
  oneline: 0, summary: 1, standard: 2, deep: 3, forensic: 4,
};

/**
 * A constant the analysis used to produce a number.
 *
 * `forensic` prints these, because a modelled figure that cannot be checked
 * has to be believed instead — and the estimate is always the one that ends up
 * in a change request. Naming the constant is the difference between "12
 * minutes" and "12 minutes, at an assumed 40 MB/s".
 */
export interface Assumption {
  name: string;
  value: string;
  /** What it feeds, so a reader can tell whether it matters to them. */
  affects: string;
}

export interface RenderOptions {
  level: DetailLevel;
  /** Drop anything less severe than this. Default: everything. */
  floor?: Severity;
  /**
   * Show the checks that passed. Default follows the level — off below
   * `forensic`, because at those depths they crowd out the problems.
   */
  showPassed?: boolean;
  /** Constants the analysis used. Printed at `forensic` only. */
  assumptions?: Assumption[];
}

const DEFAULTS: RenderOptions = { level: 'standard' };

/** Findings at or above the floor. */
export function atOrAbove(findings: Finding[], floor?: Severity): Finding[] {
  if (!floor) return findings;
  return findings.filter(f => SEVERITY_ORDER[f.severity] <= SEVERITY_ORDER[floor]);
}

/** How many of each severity — the number a reader looks at first. */
export function severityCounts(findings: Finding[]): Record<Severity, number> {
  const counts: Record<Severity, number> = { red: 0, orange: 0, yellow: 0, info: 0 };
  for (const f of findings) counts[f.severity] += 1;
  return counts;
}

// Human category from the finding id prefix (no cryptic codes in output).
export function categoryOf(id: string): string {
  const p = id.replace(/[0-9]+$/, '');
  switch (p) {
    case 'L':  return 'Query logic';
    case 'D':  return 'Table design';
    case 'S':  return 'Statistics';
    case 'A':  return 'Indexing';
    case 'CM': return 'Columns & types';
    case 'W':  return 'Server warnings';
    case 'E':  return 'Execution plan';
    case 'X':  return 'Execution (ANALYZE)';
    case 'T':  return 'Data types';
    case 'NAME': return 'Naming & upgrades';
    default:   return 'General';
  }
}
const SEV_WORD: Record<string, string> = { red: 'CRITICAL', orange: 'WARNING', yellow: 'ADVISORY' };

// Findings that describe a passed/informational check rather than a problem.
function isVerified(f: Finding): boolean {
  return f.id === 'CM' || f.id === 'A0' || /^no /i.test(f.title) || /: no /i.test(f.title);
}
function splitFindings(findings: Finding[]): { problems: Finding[]; verified: Finding[] } {
  const problems: Finding[] = [], verified: Finding[] = [];
  for (const f of findings) (isVerified(f) ? verified : problems).push(f);
  problems.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
  return { problems, verified };
}

export interface ReportSection {
  title: string;
  /** markdown body (already formatted) */
  md: string;
  /**
   * The section's findings, unrendered.
   *
   * `md` is the prose around them — a table of join pairs, a plan, a note.
   * The findings are kept separate so the detail level reaches *inside* a
   * section: without this, `deep` and `forensic` added depth to the summary
   * and nothing to the eight sections underneath it, which is where the
   * detail actually lives.
   */
  findings?: Finding[];
  /** raw command output for the .txt companion (optional) */
  raw?: { label: string; text: string; wallMs?: number }[];
}

export interface ReportMeta {
  connectionName: string;
  engine: string;
  date: string;          // YYYY-MM-DD HH:mm
  sql: string;
  substitutedSql?: string;
}

export function findingsTable(findings: Finding[]): string {
  const { problems } = splitFindings(findings);
  if (problems.length === 0) return '_No problems found._\n';
  const rows = problems.map((f, i) =>
    `| ${i + 1} | ${SEV_WORD[f.severity] ?? f.severity} | ${categoryOf(f.id)} | ${f.title.replace(/\|/g, '\\|')} |`);
  return ['| # | Priority | Area | Finding |', '|---|---|---|---|', ...rows].join('\n') + '\n';
}

export function findingsDetail(findings: Finding[]): string {
  const { problems, verified } = splitFindings(findings);
  const out: string[] = [];
  problems.forEach((f, i) => {
    const parts = [`### ${i + 1}. [${SEV_WORD[f.severity] ?? f.severity}] ${categoryOf(f.id)} — ${f.title}`, '', f.detail];
    if (f.snippet) parts.push('', '```sql', f.snippet, '```');
    out.push(parts.join('\n'));
  });
  if (problems.length === 0) out.push('_No problems found._');
  if (verified.length) {
    out.push('---');
    out.push('### Checked & OK');
    out.push(verified.map(f => `- **${categoryOf(f.id)}** — ${f.title}`).join('\n'));
  }
  return out.join('\n\n') + '\n';
}

export function buildMarkdown(
  meta: ReportMeta,
  findings: Finding[],
  sections: ReportSection[],
  opts: RenderOptions = DEFAULTS,
): string {
  const parts: string[] = [];
  parts.push(`# SQL Quality Report`);
  parts.push('');
  parts.push(`**Date:** ${meta.date}`);
  parts.push(`**Connection:** ${meta.connectionName} (${meta.engine})`);
  parts.push('');
  parts.push('---');
  parts.push('');
  parts.push('## Findings summary');
  parts.push('');
  parts.push(renderFindings(findings, opts));

  // The per-analysis sections are the detail; at `oneline` and `summary` the
  // reader has explicitly asked for the verdict and nothing else, and pasting
  // eight sections underneath it would defeat the choice they just made.
  if (DEPTH[opts.level] >= 2) {
    for (let i = 0; i < sections.length; i++) {
      parts.push('---');
      parts.push('');
      parts.push(`## ${i + 1}. ${sections[i].title}`);
      parts.push('');
      parts.push(sections[i].md.trimEnd());
      const f = sections[i].findings;
      if (f && f.length) {
        parts.push('');
        parts.push(renderFindings(f, opts).trimEnd());
      }
      parts.push('');
    }
  }

  parts.push('---');
  parts.push('');
  parts.push('## Appendix — query under analysis');
  parts.push('');
  parts.push('```sql');
  parts.push(meta.sql.trimEnd());
  parts.push('```');
  if (meta.substitutedSql && meta.substitutedSql !== meta.sql) {
    parts.push('');
    parts.push('With substituted parameters:');
    parts.push('');
    parts.push('```sql');
    parts.push(meta.substitutedSql.trimEnd());
    parts.push('```');
  }
  return parts.join('\n') + '\n';
}

/** Raw .txt companion — `##### LABEL … #####` blocks like a terminal capture. */
export function buildRawTxt(meta: ReportMeta, sections: ReportSection[]): string {
  const parts: string[] = [];
  parts.push(`##### SQL QUALITY RAW OUTPUT — ${meta.connectionName} (${meta.engine}) — ${meta.date} #####`);
  parts.push('');
  for (const s of sections) {
    for (const r of s.raw ?? []) {
      parts.push(`##### ${r.label} #####`);
      parts.push(r.text.trimEnd());
      if (r.wallMs !== undefined) {
        parts.push(`##### ${r.label} wall=${(r.wallMs / 1000).toFixed(1)}s #####`);
      }
      parts.push('');
    }
  }
  return parts.join('\n') + '\n';
}

/** `RED  L3  line 12  COUNT(x) counts non-NULL values only` */
export function onelineFinding(f: Finding): string {
  const sev = (SEV_WORD[f.severity] ?? f.severity).padEnd(8);
  const id = f.id.padEnd(6);
  const where = f.at ? `L${f.at.line}${f.at.col ? `:${f.at.col}` : ''}`.padEnd(7) : ''.padEnd(7);
  // One line means one line: a title with a newline in it would break every
  // downstream grep, sort and paste.
  return `${sev}${id}${where}${f.title.replace(/\s+/g, ' ')}`;
}

function evidenceLines(ev: Evidence[]): string[] {
  return ev.map(e => {
    const bits = [`**${e.source}**`, e.value];
    if (e.age) bits.push(`_(${e.age})_`);
    // Stated, not implied: an estimate that reads like a measurement is the
    // one failure mode this whole field exists to prevent.
    if (e.modelled) bits.push('— _model estimate, not a measurement_');
    return `  - ${bits.join(' · ')}`;
  });
}

function costLine(f: Finding): string | null {
  const c = f.cost;
  if (!c) return null;
  const bits: string[] = [];
  if (c.seconds != null) bits.push(`~${c.seconds.toFixed(2)} s`);
  if (c.blockedSeconds != null) bits.push(`writes blocked ${c.blockedSeconds.toFixed(2)} s`);
  if (c.rows != null) bits.push(`${c.rows.toLocaleString()} rows`);
  if (c.bytes != null) bits.push(`${(c.bytes / 1024 ** 3).toFixed(1)} GiB`);
  return bits.length ? `**Cost:** ${bits.join(' · ')}` : null;
}

/** One finding, at the requested depth. */
export function renderFinding(f: Finding, n: number, level: DetailLevel): string {
  if (DEPTH[level] === 0) return onelineFinding(f);
  const parts = [`### ${n}. [${SEV_WORD[f.severity] ?? f.severity}] ${categoryOf(f.id)} — ${f.title}`, '', f.detail];
  if (f.at) parts.push('', `_Line ${f.at.line}${f.at.col ? `, column ${f.at.col}` : ''}._`);
  if (f.snippet) parts.push('', '```sql', f.snippet, '```');
  const cost = costLine(f);
  if (cost) parts.push('', cost);
  if (f.fix) parts.push('', '**Fix:**', '', '```sql', f.fix.trimEnd(), '```');
  if (DEPTH[level] >= 3) {
    if (f.why) parts.push('', `**Why it matters:** ${f.why}`);
    if (f.evidence?.length) parts.push('', '**Evidence:**', ...evidenceLines(f.evidence));
    const tail: string[] = [];
    if (f.ruleRef) tail.push(f.ruleRef);
    if (f.confidence) {
      tail.push(f.confidence === 'certain'
        ? 'confidence: certain (the server answered)'
        : 'confidence: inferred (parsed, not confirmed)');
    }
    if (tail.length) parts.push('', `_${tail.join(' · ')}_`);
  }
  return parts.join('\n');
}

/**
 * The findings, rendered.
 *
 * One entry point for the screen, Copy and Export, so what you exported is
 * what you were looking at — a report that silently changes shape between the
 * panel and the file is worse than one that is only ever verbose.
 */
export function renderFindings(findings: Finding[], opts: RenderOptions = DEFAULTS): string {
  const level = opts.level;
  const depth = DEPTH[level];
  const showPassed = opts.showPassed ?? depth >= 4;
  const kept = atOrAbove(findings, opts.floor);
  const { problems, verified } = splitFindings(kept);
  const out: string[] = [];

  if (depth === 0) {
    if (problems.length === 0) return 'No problems found.\n';
    out.push(...problems.map(onelineFinding));
    if (showPassed && verified.length) {
      out.push('', ...verified.map(f => `OK      ${f.id.padEnd(6)}${''.padEnd(7)}${f.title}`));
    }
    return out.join('\n') + '\n';
  }

  const c = severityCounts(problems);
  out.push(`**${problems.length} finding${problems.length === 1 ? '' : 's'}** — `
    + `${c.red} critical · ${c.orange} warning · ${c.yellow} advisory · ${c.info} info`
    + (opts.floor && opts.floor !== 'info' ? ` _(showing ${SEV_WORD[opts.floor] ?? opts.floor} and above)_` : ''));
  out.push('');
  out.push(findingsTable(kept));

  if (depth >= 2) {
    problems.forEach((f, i) => out.push(renderFinding(f, i + 1, level)));
    if (problems.length === 0) out.push('_No problems found._');
  }

  if (showPassed && verified.length) {
    out.push('---');
    out.push('### Checked & OK');
    out.push(verified.map(f => `- **${categoryOf(f.id)}** — ${f.title}`).join('\n'));
  }

  // The numbers are only as good as what produced them, and at this depth the
  // reader is checking rather than skimming.
  if (depth >= 4 && opts.assumptions?.length) {
    out.push('---');
    out.push('### Assumptions behind the numbers');
    out.push(mdTable(
      ['Constant', 'Value', 'Affects'],
      opts.assumptions.map(a => [a.name, a.value, a.affects])).trimEnd());
    out.push('_Anything derived from these is a model estimate, not a measurement._');
  }
  return out.join('\n\n') + '\n';
}

export function mdTable(header: string[], rows: string[][]): string {
  const esc = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
  return [
    `| ${header.join(' | ')} |`,
    `|${header.map(() => '---').join('|')}|`,
    ...rows.map(r => `| ${r.map(esc).join(' | ')} |`),
  ].join('\n') + '\n';
}

/** Plain-text findings list — one block per finding, easy to grep/parse. */
export function buildFindingsTxt(findings: Finding[]): string {
  const { problems, verified } = splitFindings(findings);
  const out: string[] = [];
  out.push(problems.length
    ? `${problems.length} issue${problems.length === 1 ? '' : 's'} found — most important first:`
    : 'No problems found.');
  out.push('');
  problems.forEach((f, i) => {
    out.push(`${i + 1}. [${SEV_WORD[f.severity] ?? f.severity}] ${categoryOf(f.id)} — ${f.title}`);
    out.push(`     ${f.detail.replace(/\n/g, '\n     ')}`);
    if (f.snippet) out.push(`     query: ${f.snippet}`);
    out.push('');
  });
  if (verified.length) {
    out.push('Checked & OK:');
    verified.forEach(f => out.push(`  ✓ ${categoryOf(f.id)} — ${f.title}`));
    out.push('');
  }
  return out.join('\n');
}
