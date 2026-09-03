/**
 * MySQL/MariaDB slow-query-log parser + pt-query-digest-style grouping.
 *
 * The slow log is the fallback when performance_schema is off or you need
 * history it doesn't keep. This parses the text format into per-statement
 * entries and groups them by a normalized fingerprint (literals → ?, IN-lists
 * collapsed), so the output is "which SHAPES of query cost the most", ranked by
 * total time — the same question pt-query-digest answers.
 *
 * Pure and dependency-free — driven by node --test. The panel reads the file
 * and renders; the parsing/aggregation lives here.
 */

export interface SlowEntry {
  queryTimeMs: number;
  lockTimeMs: number;
  rowsSent: number;
  rowsExamined: number;
  sql: string;
}

export interface SlowGroup {
  fingerprint: string;
  sample: string;
  count: number;
  totalMs: number;
  maxMs: number;
  avgMs: number;
  rowsExamined: number;
}

const HEADER = /^#\s/;

/** Normalize a statement to a fingerprint: literals → ?, IN (...) collapsed. */
export function fingerprint(sql: string): string {
  return sql
    .replace(/\/\*.*?\*\//gs, ' ')            // block comments
    .replace(/--[^\n]*/g, ' ')                // line comments
    .replace(/'(?:[^'\\]|\\.)*'/g, '?')       // string literals
    .replace(/"(?:[^"\\]|\\.)*"/g, '?')       // double-quoted literals
    .replace(/\b\d+\.\d+\b|\b\d+\b/g, '?')    // numbers
    .replace(/\bIN\s*\(\s*(?:\?\s*,\s*)*\?\s*\)/gi, 'IN (?)') // IN-lists
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** Parse the raw slow-log text into individual entries. */
export function parseSlowLog(text: string): SlowEntry[] {
  const lines = text.split('\n');
  const out: SlowEntry[] = [];
  let cur: Partial<SlowEntry> | null = null;
  let sqlLines: string[] = [];

  const flush = () => {
    if (cur && sqlLines.length) {
      const sql = sqlLines.join('\n').trim().replace(/;\s*$/, '');
      if (sql) out.push({
        queryTimeMs: cur.queryTimeMs ?? 0,
        lockTimeMs: cur.lockTimeMs ?? 0,
        rowsSent: cur.rowsSent ?? 0,
        rowsExamined: cur.rowsExamined ?? 0,
        sql,
      });
    }
    sqlLines = [];
  };

  for (const line of lines) {
    if (HEADER.test(line)) {
      // A `# Time:` or `# User@Host:` starts a new record boundary.
      if (/^#\s*(Time:|User@Host:)/.test(line)) { flush(); cur = cur && sqlLines.length ? {} : (cur ?? {}); if (!cur) cur = {}; }
      const qt = /Query_time:\s*([\d.]+)/.exec(line);
      const lt = /Lock_time:\s*([\d.]+)/.exec(line);
      const rs = /Rows_sent:\s*(\d+)/.exec(line);
      const re = /Rows_examined:\s*(\d+)/.exec(line);
      if (qt || lt || rs || re) {
        cur = cur ?? {};
        if (qt) cur.queryTimeMs = parseFloat(qt[1]) * 1000;
        if (lt) cur.lockTimeMs = parseFloat(lt[1]) * 1000;
        if (rs) cur.rowsSent = parseInt(rs[1], 10);
        if (re) cur.rowsExamined = parseInt(re[1], 10);
      }
      continue;
    }
    // Admin/session noise that isn't the statement itself.
    if (/^(SET\s+timestamp\s*=|use\s+\S+;?\s*$)/i.test(line.trim())) continue;
    if (line.trim()) sqlLines.push(line);
  }
  flush();
  return out;
}

/** Group entries by fingerprint and aggregate, sorted by total time. */
export function groupSlowLog(entries: SlowEntry[]): SlowGroup[] {
  const map = new Map<string, SlowGroup>();
  for (const e of entries) {
    const fp = fingerprint(e.sql);
    const g = map.get(fp);
    if (g) {
      g.count++;
      g.totalMs += e.queryTimeMs;
      g.maxMs = Math.max(g.maxMs, e.queryTimeMs);
      g.rowsExamined += e.rowsExamined;
    } else {
      map.set(fp, {
        fingerprint: fp, sample: e.sql, count: 1,
        totalMs: e.queryTimeMs, maxMs: e.queryTimeMs, avgMs: 0, rowsExamined: e.rowsExamined,
      });
    }
  }
  const groups = [...map.values()];
  for (const g of groups) g.avgMs = g.count ? g.totalMs / g.count : 0;
  groups.sort((a, b) => b.totalMs - a.totalMs);
  return groups;
}
