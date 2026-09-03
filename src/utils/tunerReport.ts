/**
 * Server Tuner — types matching the `tuner_analyze` backend contract
 * (snake_case payloads), plus pure helpers: score color mapping, finding
 * grouping/filtering, uptime formatting and the Markdown report export.
 * Pure: no React/Tauri imports — unit-tested with node --test.
 */

export type TunerSeverity = 'ok' | 'info' | 'advice' | 'warn' | 'critical';
export type TunerCategory = 'performance' | 'security' | 'resilience' | 'schema' | 'config';
export type TunerFlavor = 'mysql' | 'mariadb' | 'percona' | 'postgres' | 'redis' | 'clickhouse' | 'sqlite';

export interface TunerFinding {
  id: string;
  category: TunerCategory;
  severity: TunerSeverity;
  title: string;
  detail: string;
  recommendation: string | null;
  /** Ready-to-run SET GLOBAL statements — display + copy only, NEVER auto-run. */
  fix_sql: string[];
  /** [mysqld] config lines. */
  fix_config: string[];
  points_lost: number;
}

export interface TunerReport {
  generated_at: string;
  server: {
    version: string;
    version_comment: string;
    flavor: TunerFlavor;
    arch: string;
    uptime_secs: number;
    cloud: string | null;
  };
  eol: {
    product: string;
    cycle: string;
    eol_date: string | null;
    status: 'supported' | 'eol-soon' | 'eol' | 'unknown';
    latest: string | null;
    source: 'endoflife.date' | 'cache' | 'builtin-fallback';
  } | null;
  score: {
    total: number;       // 0-100
    performance: number; // /40
    security: number;    // /30
    resilience: number;  // /30
  };
  findings: TunerFinding[];
}

export const CATEGORY_ORDER: TunerCategory[] = ['performance', 'security', 'resilience', 'schema', 'config'];

export const CATEGORY_LABELS: Record<TunerCategory, string> = {
  performance: 'Performance',
  security: 'Security',
  resilience: 'Resilience',
  schema: 'Schema',
  config: 'Config',
};

export const SEVERITY_LABELS: Record<TunerSeverity, string> = {
  ok: 'OK',
  info: 'Info',
  advice: 'Advice',
  warn: 'Warn',
  critical: 'Critical',
};

/** Hottest first — used for sorting findings inside a group and count badges. */
const SEVERITY_RANK: Record<TunerSeverity, number> = {
  critical: 0, warn: 1, advice: 2, info: 3, ok: 4,
};

export type ScoreColor = 'red' | 'amber' | 'green';

/** Gauge color: red <50, amber 50-79, green 80+. */
export function scoreColor(total: number): ScoreColor {
  if (total >= 80) return 'green';
  if (total >= 50) return 'amber';
  return 'red';
}

/** "Problems only" filter = warn + critical + advice. */
export function isProblem(severity: TunerSeverity): boolean {
  return severity === 'warn' || severity === 'critical' || severity === 'advice';
}

export interface FindingGroup {
  category: TunerCategory;
  findings: TunerFinding[];
  counts: Partial<Record<TunerSeverity, number>>;
  /** warn + critical + advice count. */
  problems: number;
}

/**
 * Group findings by category (in CATEGORY_ORDER order, empty categories
 * dropped). Inside a group, hottest severity first, then most points lost.
 * Unknown categories from the backend fall into 'config'.
 */
export function groupFindings(findings: TunerFinding[]): FindingGroup[] {
  const byCat = new Map<TunerCategory, TunerFinding[]>();
  for (const f of findings) {
    const cat = (CATEGORY_ORDER as string[]).includes(f.category) ? f.category : 'config';
    if (!byCat.has(cat)) byCat.set(cat, []);
    byCat.get(cat)!.push(f);
  }
  return CATEGORY_ORDER.filter(c => byCat.has(c)).map(c => {
    const list = [...byCat.get(c)!].sort((a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || b.points_lost - a.points_lost);
    const counts: Partial<Record<TunerSeverity, number>> = {};
    let problems = 0;
    for (const f of list) {
      counts[f.severity] = (counts[f.severity] ?? 0) + 1;
      if (isProblem(f.severity)) problems++;
    }
    return { category: c, findings: list, counts, problems };
  });
}

/** Severity counts rendered compactly, hottest first: "1 critical · 2 warn". */
export function countsText(counts: Partial<Record<TunerSeverity, number>>): string {
  return (Object.keys(SEVERITY_RANK) as TunerSeverity[])
    .filter(sev => (counts[sev] ?? 0) > 0)
    .map(sev => `${counts[sev]} ${sev}`)
    .join(' · ');
}

/** Humanized uptime: "3 d 4 h", "2 h 15 min", "45 s" (negative clamps to 0). */
export function fmtUptime(secs: number): string {
  const s = Math.max(0, Math.round(secs));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (d > 0) return h > 0 ? `${d} d ${h} h` : `${d} d`;
  if (h > 0) return m > 0 ? `${h} h ${m} min` : `${h} h`;
  if (m > 0) return r > 0 ? `${m} min ${r} s` : `${m} min`;
  return `${r} s`;
}

export function flavorLabel(flavor: TunerFlavor): string {
  switch (flavor) {
    case 'mariadb': return 'MariaDB';
    case 'percona': return 'Percona';
    case 'postgres': return 'PostgreSQL';
    case 'redis': return 'Redis';
    case 'clickhouse': return 'ClickHouse';
    case 'sqlite': return 'SQLite';
    default: return 'MySQL';
  }
}

/** Suggested export filename: tuner-report-2026-08-05-10-30-00.md */
export function reportFileName(report: TunerReport): string {
  const stamp = report.generated_at.slice(0, 19).replace(/[:T]/g, '-').replace(/[^\w-]/g, '-');
  return `tuner-report-${stamp || 'snapshot'}.md`;
}

/** Standalone Markdown report: score, server, EOL, findings grouped with fixes. */
export function reportToMarkdown(report: TunerReport): string {
  const s = report.server;
  const lines: string[] = [];
  lines.push('# Server Tuner Report');
  lines.push('');
  lines.push(`- **Generated:** ${report.generated_at}`);
  lines.push(`- **Server:** ${flavorLabel(s.flavor)} ${s.version} (${s.version_comment}), ${s.arch}, up ${fmtUptime(s.uptime_secs)}`);
  if (s.cloud) lines.push(`- **Cloud:** ${s.cloud}`);
  lines.push('');
  lines.push(`## Health score: ${report.score.total}/100`);
  lines.push('');
  lines.push(`- Performance: ${report.score.performance}/40`);
  lines.push(`- Security: ${report.score.security}/30`);
  lines.push(`- Resilience: ${report.score.resilience}/30`);
  lines.push('');
  if (report.eol) {
    const e = report.eol;
    const status = e.status === 'eol' ? 'EOL' : e.status === 'eol-soon' ? 'EOL soon' : e.status;
    lines.push('## End of life');
    lines.push('');
    lines.push(`- **${e.product} ${e.cycle}:** ${status}${e.eol_date ? ` on ${e.eol_date}` : ''}`);
    if (e.latest) lines.push(`- Latest release: ${e.latest} — plan an upgrade path`);
    if (e.source !== 'endoflife.date') {
      lines.push(`- Offline data (source: ${e.source}) — verify against https://endoflife.date`);
    }
    lines.push('');
  }
  lines.push('## Findings');
  lines.push('');
  if (report.findings.length === 0) lines.push('No findings.');
  for (const g of groupFindings(report.findings)) {
    lines.push(`### ${CATEGORY_LABELS[g.category]} (${countsText(g.counts)})`);
    lines.push('');
    for (const f of g.findings) {
      lines.push(`#### [${f.severity.toUpperCase()}] ${f.title}${f.points_lost > 0 ? ` (−${f.points_lost} pts)` : ''}`);
      lines.push('');
      lines.push(f.detail);
      if (f.recommendation) {
        lines.push('');
        lines.push(`**Recommendation:** ${f.recommendation}`);
      }
      if (f.fix_sql.length > 0) {
        lines.push('');
        lines.push('```sql');
        lines.push(...f.fix_sql);
        lines.push('```');
      }
      if (f.fix_config.length > 0) {
        lines.push('');
        lines.push('```ini');
        lines.push('[mysqld]');
        lines.push(...f.fix_config);
        lines.push('```');
      }
      lines.push('');
    }
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}
