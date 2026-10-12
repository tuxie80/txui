/**
 * The ClickHouse SQL Quality pipeline — the CH twin of utils/qualityRun.ts
 * (PG-parity precedent, docs/SQL_QUALITY_DEEPDIVE.md §7: a third rulebook,
 * NOT the MySQL analyzer threaded with an isCh flag). Everything Tauri-backed
 * (monitor_query, get_ddl, explain_query with its CH `mode`) arrives through
 * the shared {@link QualityIo}; this module stays pure per the utils contract.
 *
 * Pipeline: table resolution over system.tables → static lint (CH-S*) with
 * key metadata → column map via `SELECT * FROM (<sql>) LIMIT 0` (the HTTP
 * JSONCompact meta carries exact type + Nullable() nullability — no Rust
 * column_map arm needed) → referenced-table sizes/keys (CH-M*) → the three
 * safe EXPLAIN kinds (indexes = 1 → CH-E*, ESTIMATE → CH-T* + the estimated
 * plan section, PIPELINE → raw only, rules are v1.5) → system.query_log
 * history (CH-Q1). Every section degrades on its own ("_Failed: …_"), never
 * the run — a session without the query_log grant still gets everything else.
 */
import { errorDisplay } from './appError.ts';
import type { QueryResult } from '../types';
import { escapeLiteral } from './sqlIdent.ts';
import { substitutePositional } from './sqlLint.ts';
import type { Finding } from './sqlLint.ts';
import { substituteVariables } from './sqlVars.ts';
import { extractQueryShape } from './typeAudit.ts';
import { buildRawTxt, buildFindingsTxt, mdTable } from './qualityReport.ts';
import type { ReportSection } from './qualityReport.ts';
import { toAsciiTable } from './exporters.ts';
import { reportTimestamp } from './qualityRun.ts';
import type { QualityIo, QualityMeta, QualityRunResult } from './qualityRun.ts';
import {
  chStaticRules, chMetadataRules, chExplainRules, chEstimateRules,
  chQueryLogFinding, parseChEstimate,
} from './chQuality.ts';
import type { ChTableMeta } from './chQuality.ts';

export interface ChQualityChecks {
  lint: boolean;
  columnMap: boolean;
  tables: boolean;
  explain: boolean;
  queryLog: boolean;
}

export interface ChQualityInput {
  sql: string;
  engine: string;
  connectionName: string;
  params: string;
  qCount: number;
  varNames: string[];
  checks: ChQualityChecks;
  dbOverride: string;
}

// ── system.* queries ─────────────────────────────────────────────────────────
// Mirrored verbatim in src-tauri/src/db/clickhouse_live_tests.rs
// (clickhouse_live_quality_shapes) — change them in both places.

/** Engine, size and all three keys for the referenced tables. */
export const CH_TABLE_META_SQL = (inList: string): string =>
  `SELECT database, name, engine, total_rows, total_bytes, partition_key, sorting_key, primary_key `
  + `FROM system.tables WHERE database || '.' || name IN (${inList})`;

/** Per-column key participation + declared type. */
export const CH_COLUMN_META_SQL = (inList: string): string =>
  `SELECT database, table, name, type, is_in_partition_key, is_in_sorting_key, is_in_primary_key `
  + `FROM system.columns WHERE database || '.' || table IN (${inList}) `
  + `ORDER BY database, table, position`;

/** Unqualified-name → database resolution (prefer the session's current DB). */
export const CH_TABLE_LOOKUP_SQL = (inList: string): string =>
  `SELECT name, database FROM system.tables WHERE name IN (${inList})`;

/** Measured history of this normalized query shape on this node. */
export const CH_QUERY_LOG_SQL = (escapedSql: string, windowDays: number): string =>
  `SELECT count() AS executions, round(avg(read_rows)) AS avg_read_rows, `
  + `round(avg(read_bytes)) AS avg_read_bytes, round(avg(query_duration_ms)) AS avg_ms `
  + `FROM system.query_log WHERE type = 'QueryFinish' `
  + `AND event_time > now() - INTERVAL ${windowDays} DAY `
  + `AND normalized_query_hash = normalizedQueryHash('${escapedSql}')`;

export const CH_QUERY_LOG_WINDOW_DAYS = 30;

function resultToAscii(r: QueryResult): string {
  return toAsciiTable(r.columns.map(c => c.name), r.rows);
}

export async function runChQualityAnalysis(input: ChQualityInput, io: QualityIo): Promise<QualityRunResult> {
  const { sql, engine, connectionName, params, qCount, varNames, checks, dbOverride } = input;
  const esc = (v: string) => escapeLiteral(v, engine);

  const findings: Finding[] = [];
  const sections: ReportSection[] = [];

  // Auto-beautify like the MySQL run — sql-formatter has no ClickHouse
  // dialect, so the mysql one stands in; anything it chokes on (CH has plenty
  // of non-standard syntax) falls back to the raw text.
  let src = sql;
  try {
    const { format } = await import('sql-formatter');
    const pretty = format(sql, { language: 'mysql', tabWidth: 2 });
    if (pretty.trim()) { src = pretty; io.onPretty?.(pretty); }
  } catch { /* unparseable — analyze the raw text */ }

  let subSql = src;
  const paramValues = params.split('\n').map(s => s.trim()).filter(s => s.length > 0);
  if (qCount > 0) subSql = substitutePositional(subSql, paramValues, engine);
  if (varNames.length > 0) {
    const vals: Record<string, { value: string; raw: boolean }> = {};
    varNames.forEach((v, i) => {
      const raw = paramValues[qCount + i] ?? '';
      vals[v] = { value: raw, raw: /^-?\d+(\.\d+)?$/.test(raw) };
    });
    subSql = substituteVariables(subSql, vals, engine);
  }

  // ── resolve the referenced tables (drives metadata + S2's column count) ──
  const shape = extractQueryShape(src);
  const meta: Map<string, ChTableMeta> = new Map();
  let currentDb = '';
  let qualified: string[] = [];

  const needSchema = checks.tables || checks.explain || checks.lint;
  if (needSchema && shape.tables.length > 0) {
    io.say(`Resolving ${shape.tables.length} referenced tables…`);
    if (dbOverride.trim()) {
      currentDb = dbOverride.trim();
    } else {
      try {
        const dbRes = await io.query('SELECT currentDatabase()');
        currentDb = String(dbRes.rows[0]?.[0] ?? '');
      } catch { /* unknown stays empty — names resolve via system.tables */ }
    }
    const bare = shape.tables.filter(t => !t.includes('.'));
    const schemaOf: Record<string, string> = {};
    if (bare.length > 0) {
      try {
        const r = await io.query(CH_TABLE_LOOKUP_SQL(bare.map(t => `'${esc(t)}'`).join(',')));
        for (const row of r.rows) {
          const name = String(row[0]).toLowerCase();
          const db = String(row[1]);
          if (!schemaOf[name] || db === currentDb) schemaOf[name] = db;
        }
      } catch { /* best effort */ }
    }
    qualified = shape.tables.map(t =>
      t.includes('.') ? t : `${schemaOf[t.toLowerCase()] || currentDb}.${t}`);

    // ── key + size metadata ──
    try {
      const inList = qualified.map(t => `'${esc(t)}'`).join(',');
      const [tRes, cRes] = await Promise.all([
        io.query(CH_TABLE_META_SQL(inList)),
        io.query(CH_COLUMN_META_SQL(inList)),
      ]);
      for (const r of tRes.rows) {
        const key = `${r[0]}.${r[1]}`.toLowerCase();
        meta.set(key, {
          name: key,
          engine: String(r[2] ?? ''),
          totalRows: r[3] === null ? null : Number(r[3]),
          // total_bytes (r[4]) is shown in the sizes table, not needed by rules
          partitionKey: String(r[5] ?? ''),
          sortingKey: String(r[6] ?? ''),
          primaryKey: String(r[7] ?? ''),
          columns: new Map(),
        });
      }
      for (const r of cRes.rows) {
        const key = `${r[0]}.${r[1]}`.toLowerCase();
        const t = meta.get(key);
        if (!t) continue;
        t.columns.set(String(r[2]).toLowerCase(), {
          type: String(r[3] ?? ''),
          inPartition: String(r[4]) === '1',
          inSorting: String(r[5]) === '1',
          inPrimary: String(r[6]) === '1',
        });
      }
    } catch (e) {
      io.say(`Table metadata unavailable (${errorDisplay(e)}) — metadata rules skipped.`);
    }
  }

  const explainDb = (dbOverride.trim() || currentDb
    || (qualified[0]?.includes('.') ? qualified[0].split('.')[0] : '')) || null;

  // ── 1. static lint (CH-S*) — after metadata so S2 can name the width ──
  if (checks.lint) {
    io.say('Static analysis…');
    const lint = chStaticRules(src, meta);
    findings.push(...lint);
    sections.push({
      title: 'Static analysis (ClickHouse rules)',
      md: lint.length ? '' : '_No static findings._',
      findings: lint,
    });
  }

  // ── 2. column map — LIMIT 0 describe over the HTTP JSONCompact meta ──
  if (checks.columnMap) {
    io.say('Column map (LIMIT 0 describe)…');
    try {
      const inner = subSql.replace(/;+\s*$/, '');
      const r = await io.query(`SELECT * FROM (${inner}) LIMIT 0`);
      const w = Math.max(...r.columns.map(c => c.name.length), 6);
      const lines = r.columns.map((c, i) =>
        `${String(i + 1).padStart(3)}. ${c.name.padEnd(w)}  ${c.type_name}${c.nullable ? '  NULL' : '  NOT NULL'}`);
      findings.push({
        id: 'CM', severity: 'yellow', confidence: 'certain',
        title: `Column map — ${r.columns.length} output columns, exact server types (LIMIT 0 describe)`,
        detail: 'Types come from the server preparing the statement — the HTTP '
          + 'JSONCompact meta block, read with LIMIT 0, so no rows are scanned. '
          + 'Nullable() wrappers are the nullability.',
      });
      sections.push({ title: 'Column map', md: '```\n' + lines.join('\n') + '\n```' });
    } catch (e) {
      sections.push({ title: 'Column map', md: `_Failed: ${errorDisplay(e)}_` });
    }
  }

  // ── 3. referenced tables — sizes + keys + DDL appendix ──
  if (checks.tables && qualified.length > 0) {
    io.say('Referenced tables — sizes + MergeTree keys…');
    try {
      const rows = qualified.map(q => {
        const t = meta.get(q.toLowerCase());
        return t
          ? [t.name, t.engine,
             t.totalRows === null ? '' : t.totalRows.toLocaleString(),
             t.partitionKey, t.sortingKey, t.primaryKey]
          : [q, '', '', '', '', ''];
      });
      const missing = qualified.filter(q => !meta.has(q.toLowerCase()));
      const metaFindings = chMetadataRules(src, meta);
      findings.push(...metaFindings);
      sections.push({
        title: 'Referenced tables (sizes + keys)',
        md: mdTable(['Table', 'Engine', 'Rows', 'Partition key', 'Sorting key', 'Primary key'], rows)
          + (missing.length ? `\n⚠ Not found in system.tables (check names/database): ${missing.join(', ')}\n` : '')
          + (metaFindings.length ? '' : '\n✅ Key metadata raises no warnings.'),
        findings: metaFindings,
        raw: [{ label: 'TABLE KEYS', text: rows.map(r => r.join('\t')).join('\n') }],
      });
    } catch (e) {
      sections.push({ title: 'Referenced tables (sizes + keys)', md: `_Failed: ${errorDisplay(e)}_` });
    }

    io.say('DDL of referenced tables…');
    const ddls: { label: string; text: string }[] = [];
    for (const t of qualified) {
      try {
        ddls.push({ label: `DDL ${t}`, text: await io.getDdl(t) });
      } catch (e) {
        ddls.push({ label: `DDL ${t}`, text: `-- failed: ${errorDisplay(e)}` });
      }
    }
    sections.push({
      title: 'DDL (appendix)',
      md: ddls.map(d => `**${d.label.replace('DDL ', '')}**\n\n\`\`\`sql\n${d.text}\n\`\`\``).join('\n\n'),
      raw: ddls,
    });
  }

  // ── 4. EXPLAIN — all three safe kinds, each degrading on its own ──
  if (checks.explain) {
    io.say('EXPLAIN indexes = 1…');
    try {
      const t0 = performance.now();
      const res = await io.explainQuery(subSql, explainDb, 'indexes');
      const ef = chExplainRules(subSql, res.content, meta);
      findings.push(...ef);
      sections.push({
        title: 'EXPLAIN indexes = 1 (index pruning)',
        md: '```\n' + res.content.trimEnd() + '\n```'
          + (ef.length ? '' : '\n✅ The scan prunes — at least one index narrows the part set.'),
        findings: ef,
        raw: [{ label: 'EXPLAIN indexes = 1', text: res.content, wallMs: performance.now() - t0 }],
      });
    } catch (e) {
      sections.push({ title: 'EXPLAIN indexes = 1', md: `_Failed: ${errorDisplay(e)}_` });
    }

    io.say('EXPLAIN ESTIMATE…');
    try {
      const t0 = performance.now();
      const res = await io.explainQuery(subSql, explainDb, 'estimate');
      const est = parseChEstimate(res.content);
      const tf = chEstimateRules(subSql, est, meta);
      findings.push(...tf);
      // T3: the Parts/Rows/Marks table IS the estimated-plan section — the one
      // CH EXPLAIN kind with honest numbers, so it renders as metrics, not a
      // finding.
      sections.push({
        title: 'Query plan (estimated)',
        md: mdTable(['Table', 'Parts', 'Rows', 'Marks'],
          est.map(r => [`${r.db}.${r.table}`, r.parts.toLocaleString(),
            r.rows.toLocaleString(), r.marks.toLocaleString()]))
          + '\n_Server metadata counts of what the scan will read — not executed._',
        findings: tf,
        raw: [{ label: 'EXPLAIN ESTIMATE', text: res.content, wallMs: performance.now() - t0 }],
      });
    } catch (e) {
      sections.push({ title: 'Query plan (estimated)', md: `_Failed: ${errorDisplay(e)}_` });
    }

    io.say('EXPLAIN PIPELINE…');
    try {
      const t0 = performance.now();
      const res = await io.explainQuery(subSql, explainDb, 'pipeline');
      // Raw evidence only in v1: the processor graph has no counts attached,
      // and inventing rules for it without per-transform numbers would be the
      // confident-wrong-advice failure this panel exists to prevent. v1.5.
      sections.push({
        title: 'EXPLAIN PIPELINE (raw — no rules yet)',
        md: '```\n' + res.content.trimEnd() + '\n```'
          + '\n_The processor graph, verbatim. Per-transform row/time attribution is v1.5._',
        raw: [{ label: 'EXPLAIN PIPELINE', text: res.content, wallMs: performance.now() - t0 }],
      });
    } catch (e) {
      sections.push({ title: 'EXPLAIN PIPELINE', md: `_Failed: ${errorDisplay(e)}_` });
    }
  }

  // ── 5. recent executions — system.query_log, honest without the grant ──
  if (checks.queryLog) {
    io.say('Recent executions (system.query_log)…');
    try {
      const r = await io.query(CH_QUERY_LOG_SQL(esc(src), CH_QUERY_LOG_WINDOW_DAYS));
      const row = r.rows[0];
      const stats = row
        ? {
            executions: Number(row[0]) || 0,
            avgReadRows: Number(row[1]) || 0,
            avgReadBytes: Number(row[2]) || 0,
            avgDurationMs: Number(row[3]) || 0,
          }
        : null;
      const qf = chQueryLogFinding(stats, CH_QUERY_LOG_WINDOW_DAYS);
      findings.push(qf);
      sections.push({
        title: 'Recent executions (system.query_log)',
        md: '```\n' + resultToAscii(r) + '\n```',
        findings: [qf],
        raw: [{ label: 'QUERY LOG', text: resultToAscii(r) }],
      });
    } catch (e) {
      // No ACCESS to system.query_log (or logging disabled) must not cost the
      // run — the section says so and everything else still reports.
      sections.push({
        title: 'Recent executions (system.query_log)',
        md: `_Unavailable: ${errorDisplay(e)}_\n\nquery_log is per-node and grant-gated — this session cannot read it, so there is no measured history to report. The EXPLAIN sections above are unaffected.`,
      });
    }
  }

  // assemble
  const reportMeta: QualityMeta = {
    connectionName,
    engine,
    date: reportTimestamp(),
    sql,
    substitutedSql: subSql,
  };
  const txt = buildRawTxt(reportMeta, sections);
  return {
    findings, sections, meta: reportMeta, txt,
    rawBlocks: [
      { label: '⚑ Findings', text: buildFindingsTxt(findings) },
      ...sections.flatMap(x => x.raw ?? []),
    ],
  };
}
