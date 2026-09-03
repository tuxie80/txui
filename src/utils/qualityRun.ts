/**
 * The SQL Quality analysis pipeline (WP-16 16.5) — extracted from
 * SqlQualityPanel's ~535-line inline `run` so it is testable: everything
 * Tauri-backed (monitor_query, get_ddl, the EXPLAIN family) arrives through
 * the injected {@link QualityIo}, and this module stays free of React/Tauri
 * imports per the utils contract. The pipeline itself — static lint, table
 * resolution, sizes, DDL audit, type/ceiling audits, InnoDB stats, column
 * map, index advisor, EXPLAIN (+warnings, +JSON), guarded EXPLAIN ANALYZE,
 * report assembly — is a pure move from the panel.
 */
import { errorDisplay } from './appError.ts';
import type { QueryResult } from '../types';
import { escapeLiteral } from './sqlIdent.ts';
import { lintSql, substitutePositional } from './sqlLint.ts';
import type { Finding } from './sqlLint.ts';
import { substituteVariables } from './sqlVars.ts';
import {
  extractQueryShape, parseColumnType, auditJoinTypes, auditCeilings, auditPgCeilings,
} from './typeAudit.ts';
import type { ColumnMeta, ColumnType } from './typeAudit.ts';
import { buildRawTxt, buildFindingsTxt, mdTable } from './qualityReport.ts';
import type { ReportSection } from './qualityReport.ts';
import { analyzePlanText } from './planAnalyze.ts';
import { parseMssqlPlan } from './mssqlPlan.ts';
import type { PlanNode } from './planParse.ts';
import { PG_SNAPSHOT_SQL } from './schemaCollect.ts';
import { auditDdl } from './ddlAudit.ts';
import { auditPgDdl } from './ddlAuditPg.ts';
import { toAsciiTable } from './exporters.ts';

export interface QualityChecks {
  lint: boolean;
  columnMap: boolean;
  stats: boolean;
  tables: boolean;
  types: boolean;
  ceilings: boolean;
  explain: boolean;
  explainJson: boolean;
  analyze: boolean;
}

export interface QualityInput {
  sql: string;
  engine: string;
  connectionName: string;
  isMysql: boolean;
  serverCapable: boolean;
  params: string;
  qCount: number;
  varNames: string[];
  checks: QualityChecks;
  timeoutSec: number;
  dbOverride: string;
}

/** Everything the pipeline needs from the outside world. */
export interface QualityIo {
  /** Progress line for the run log. */
  say(msg: string): void;
  /** The source was auto-beautified — the editor may want to show it. */
  onPretty?(pretty: string): void;
  /** monitor_query on the panel's session. */
  query(sql: string): Promise<QueryResult>;
  getDdl(parent: string): Promise<string>;
  columnMap(sql: string, db: string | null): Promise<{
    parse_ok: boolean; parse_error: string | null; statement_kind: string | null;
    tables: string[]; columns: { name: string; type_name: string; nullable: boolean | null }[];
    eq_cols: string[]; range_cols: string[]; sources: string[];
  }>;
  explainQuery(sql: string, db: string | null): Promise<{ format: string; engine: string; content: string }>;
  explainWithWarnings(sql: string, db: string | null): Promise<{ explain: QueryResult; warnings: QueryResult | null }>;
  explainAnalyzeGuarded(sql: string, timeoutMs: number, db: string | null): Promise<string>;
}

export interface QualityMeta {
  connectionName: string;
  engine: string;
  date: string;
  sql: string;
  substitutedSql: string;
}

export interface QualityRunResult {
  findings: Finding[];
  sections: ReportSection[];
  meta: QualityMeta;
  txt: string;
  rawBlocks: { label: string; text: string; wallMs?: number }[];
}

/** `YYYY-MM-DD HH:MM` — the report stamp. */
export function reportTimestamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function resultToAscii(r: QueryResult): string {
  return toAsciiTable(r.columns.map(c => c.name), r.rows);
}

export async function runQualityAnalysis(input: QualityInput, io: QualityIo): Promise<QualityRunResult> {
  const {
    sql, engine, connectionName, isMysql, serverCapable, params, qCount,
    varNames, checks, timeoutSec, dbOverride,
  } = input;
  const esc = (v: string) => escapeLiteral(v, engine);
  // `isMysql` was a boolean because there were two dialects. A third one means
  // the "else" branch is no longer "PostgreSQL" — every place that assumed it
  // was would have quietly sent PG SQL to a SQL Server, which is the shape of
  // failure this whole module is meant to catch in other people's queries.
  const isMssql = engine === 'sqlserver';

  const findings: Finding[] = [];
  const sections: ReportSection[] = [];

  // parameter substitution
  // Auto-beautify on Analyze: the editor box and every analysis section work
  // on the formatted SQL (findings reference readable, indented text).
  let src = sql;
  try {
    const { format } = await import('sql-formatter');
    const pretty = format(sql, {
      language: engine === 'postgres' ? 'postgresql'
        : engine === 'sqlserver' ? 'transactsql' : 'mysql',
      tabWidth: 2,
    });
    if (pretty.trim()) { src = pretty; io.onPretty?.(pretty); }
  } catch { /* unparseable — analyze the raw text */ }

  // Pasted DDL? Run the table-design audit on it directly — EXPLAIN/prepare
  // are meaningless for CREATE TABLE (EXPLAIN CREATE … is a syntax error).
  const ddlMatch = /^\s*create\s+table\s+(?:if\s+not\s+exists\s+)?[`"]?([\w.]+)[`"]?/i.exec(src);
  const ddlMode = !!ddlMatch;
  if (ddlMode) {
    io.say('CREATE TABLE detected — table-design audit (query checks skipped)…');
    // Each dialect gets its own audit: the MySQL D-rules judge InnoDB
    // mechanisms PG does not have, and vice versa (ddlAuditPg).
    // The two rule sets judge mechanisms the other engine does not have — the
    // MySQL D-rules are about InnoDB, PostgreSQL's about TOAST and bloat.
    // Running either against T-SQL would produce confident findings about
    // things that are not there, so SQL Server gets an honest gap rather than
    // someone else's rules.
    const ddlFindings = isMssql ? []
      : engine === 'postgres'
      ? auditPgDdl(ddlMatch![1], src)
      : auditDdl(ddlMatch![1], src);
    findings.push(...ddlFindings);
    sections.push({
      title: `Table design audit — ${ddlMatch![1]}`,
      md: isMssql
        ? '_No T-SQL design rule set yet — the MySQL rules judge InnoDB mechanisms and the '
          + 'PostgreSQL ones judge TOAST, neither of which SQL Server has. Running them here '
          + 'would produce confident findings about things that are not there._'
        : ddlFindings.length ? '' : '_No design findings._',
      findings: ddlFindings,
      raw: [{ label: `DDL ${ddlMatch![1]} (pasted)`, text: src }],
    });
  }

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

  // (The caller wraps this whole pipeline in its own try/catch — an aborted
  // step surfaces as one "Aborted: …" log line, exactly as before.)
  // ── 1. static lint ──
    if (checks.lint) {
      io.say('Static analysis…');
      const lint = lintSql(src);
      findings.push(...lint);
      sections.push({
        title: 'Static analysis',
        md: lint.length ? '' : '_No static findings._',
        findings: lint,
      });
    }

    const shape = extractQueryShape(src);
    let currentDb = '';
    let qualified: string[] = [];
    const meta: ColumnMeta = new Map();

    const needSchema = checks.tables || checks.types || checks.ceilings || checks.stats;
    if (needSchema && serverCapable && shape.tables.length > 0) {
      io.say(`Resolving ${shape.tables.length} referenced tables…`);
      if (dbOverride.trim()) {
        currentDb = dbOverride.trim();   // explicit DB wins — fixes cross-schema analysis
      } else {
        const dbRes = await io.query(
          isMysql ? 'SELECT DATABASE()'
          : isMssql ? 'SELECT SCHEMA_NAME()'
          : 'SELECT current_schema()');
        currentDb = String(dbRes.rows[0]?.[0] ?? '');
        if (currentDb === 'null') currentDb = '';
      }

      // Resolve schema for unqualified tables via metadata — so the audit works
      // even with no default DB selected (the query used bare names).
      const bare = shape.tables.filter(t => !t.includes('.'));
      const schemaOf: Record<string, string> = {};
      if (bare.length > 0 && isMssql) {
        try {
          const r = await io.query(
            `SELECT t.name, s.name FROM sys.tables t JOIN sys.schemas s ON s.schema_id = t.schema_id`
            + ` WHERE t.name IN (${bare.map(t => `'${esc(t)}'`).join(',')})`);
          for (const row of r.rows) {
            const name = String(row[0]).toLowerCase();
            const sch = String(row[1]);
            if (!schemaOf[name] || sch === currentDb) schemaOf[name] = sch;
          }
        } catch { /* best effort */ }
      } else if (bare.length > 0 && isMysql) {
        try {
          const r = await io.query(`SELECT table_name, table_schema FROM information_schema.tables WHERE table_name IN (${bare.map(t => `'${esc(t)}'`).join(',')})`);
          for (const row of r.rows) {
            const name = String(row[0]).toLowerCase();
            const sch = String(row[1]);
            // prefer the current DB's schema if the name exists in several
            if (!schemaOf[name] || sch === currentDb) schemaOf[name] = sch;
          }
        } catch { /* best effort */ }
      }
      qualified = shape.tables.map(t =>
        t.includes('.') ? t : `${schemaOf[t.toLowerCase()] || currentDb}.${t}`);
    }

    // Database to USE for EXPLAIN: the session default, else the first
    // resolved table's schema (never leave it "no database selected").
    const explainDb = (currentDb
      || (qualified[0]?.includes('.') ? qualified[0].split('.')[0] : '')) || null;

    const inList = qualified.map(t => `'${esc(t)}'`).join(',');

    // ── 2. tables: sizes + DDL ──
    if (checks.tables && serverCapable && qualified.length > 0) {
      io.say('Table sizes…');
      try {
        const sizesSql = isMssql
          // `reserved_page_count` is the whole footprint including indexes;
          // IDENT_CURRENT is the ceiling check's input, and is the direct
          // analogue of MySQL's AUTO_INCREMENT column.
          ? `SELECT s.name + '.' + t.name AS t,
                    SUM(CASE WHEN p.index_id IN (0,1) THEN p.row_count ELSE 0 END) AS n_rows,
                    IDENT_CURRENT(s.name + '.' + t.name) AS identity_current,
                    CONVERT(decimal(12,1), SUM(p.reserved_page_count) * 8.0 / 1024) AS total_mb,
                    CONVERT(decimal(12,1), SUM(p.in_row_data_page_count) * 8.0 / 1024) AS data_mb
             FROM sys.tables t
             JOIN sys.schemas s ON s.schema_id = t.schema_id
             JOIN sys.dm_db_partition_stats p ON p.object_id = t.object_id
             WHERE s.name + '.' + t.name IN (${inList})
             GROUP BY s.name, t.name ORDER BY n_rows DESC`
          : isMysql
          ? `SELECT CONCAT(t.table_schema,'.',t.table_name) AS t, COALESCE(s.n_rows, t.TABLE_ROWS) AS n_rows, t.AUTO_INCREMENT, ROUND((t.DATA_LENGTH+t.INDEX_LENGTH)/1048576,1) AS total_mb, ROUND(t.DATA_LENGTH/1048576,1) AS data_mb, ROUND(t.INDEX_LENGTH/1048576,1) AS index_mb FROM information_schema.tables t LEFT JOIN mysql.innodb_table_stats s ON s.database_name=t.table_schema AND s.table_name=t.table_name WHERE CONCAT(t.table_schema,'.',t.table_name) IN (${inList}) ORDER BY n_rows DESC`
          : `SELECT schemaname||'.'||relname AS t, n_live_tup AS rows, NULL AS auto_increment, ROUND(pg_total_relation_size(relid)/1048576.0,1) AS total_mb FROM pg_stat_user_tables WHERE schemaname||'.'||relname IN (${inList}) ORDER BY n_live_tup DESC`;
        const sizes = await io.query(sizesSql);
        const sizeMd = mdTable(
          sizes.columns.map(c => c.name),
          sizes.rows.map(r => r.map(v => v === null ? '' : String(v))),
        );
        const missing = qualified.filter(q =>
          !sizes.rows.some(r => String(r[0]).toLowerCase() === q.toLowerCase()));
        sections.push({
          title: 'Referenced tables (scale)',
          md: sizeMd + (missing.length ? `\n⚠ Not found (check names/schema): ${missing.join(', ')}\n` : ''),
          raw: [{ label: 'TABLE SIZES', text: resultToAscii(sizes) }],
        });
      } catch (e) {
        sections.push({ title: 'Referenced tables (scale)', md: `_Failed: ${errorDisplay(e)}_` });
      }

      io.say('DDL of referenced tables…');
      const ddls: { label: string; text: string }[] = [];
      for (const t of qualified) {
        try {
          const ddl = await io.getDdl(t);
          ddls.push({ label: `DDL ${t}`, text: ddl });
          if (isMysql) findings.push(...auditDdl(t, ddl));
          else findings.push(...auditPgDdl(t, ddl));
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

    // ── 3. column metadata + type audit ──
    if ((checks.types || checks.ceilings) && serverCapable && qualified.length > 0) {
      io.say('Column metadata…');
      try {
        const colsSql = isMssql
          // `sys.columns` reports a type and a length separately, and an
          // nvarchar's length is in BYTES — so the declaration is rebuilt, the
          // same problem PostgreSQL's format_type solves there. Without it a
          // varchar(16) and a varchar(500) compare as the same type and every
          // width mismatch in a join goes unreported.
          ? `SELECT s.name + '.' + t.name AS t, c.name,
                TYPE_NAME(c.user_type_id) + CASE
                  WHEN TYPE_NAME(c.user_type_id) IN ('varchar','char','varbinary','binary')
                    THEN '(' + CASE WHEN c.max_length = -1 THEN 'max'
                                    ELSE CONVERT(varchar(10), c.max_length) END + ')'
                  WHEN TYPE_NAME(c.user_type_id) IN ('nvarchar','nchar')
                    THEN '(' + CASE WHEN c.max_length = -1 THEN 'max'
                                    ELSE CONVERT(varchar(10), c.max_length / 2) END + ')'
                  WHEN TYPE_NAME(c.user_type_id) IN ('decimal','numeric')
                    THEN '(' + CONVERT(varchar(10), c.precision) + ','
                             + CONVERT(varchar(10), c.scale) + ')'
                  ELSE '' END,
                CASE WHEN c.is_nullable = 1 THEN 'YES' ELSE 'NO' END,
                ISNULL(c.collation_name, ''),
                CASE WHEN EXISTS (SELECT 1 FROM sys.index_columns ic
                                  JOIN sys.indexes i ON i.object_id = ic.object_id
                                                    AND i.index_id = ic.index_id
                                  WHERE ic.object_id = c.object_id
                                    AND ic.column_id = c.column_id
                                    AND i.is_primary_key = 1) THEN 'PRI' ELSE '' END
             FROM sys.columns c
             JOIN sys.tables t ON t.object_id = c.object_id
             JOIN sys.schemas s ON s.schema_id = t.schema_id
             WHERE s.name + '.' + t.name IN (${inList})
             ORDER BY c.column_id`
          : isMysql
          ? `SELECT CONCAT(table_schema,'.',table_name) AS t, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COALESCE(COLLATION_NAME,'') , COLUMN_KEY FROM information_schema.columns WHERE CONCAT(table_schema,'.',table_name) IN (${inList})`
          : `SELECT table_schema||'.'||table_name AS t, column_name, CASE WHEN data_type='character varying' THEN 'varchar('||COALESCE(character_maximum_length::text,'')||')' WHEN data_type='character' THEN 'char('||COALESCE(character_maximum_length::text,'')||')' ELSE udt_name END, is_nullable, COALESCE(collation_name,''), '' FROM information_schema.columns WHERE table_schema||'.'||table_name IN (${inList})`;
        const cols = await io.query(colsSql);
        const pkTypes = new Map<string, ColumnType>();
        for (const r of cols.rows) {
          const tkey = String(r[0]).toLowerCase();
          const cname = String(r[1]).toLowerCase();
          const ct = parseColumnType(String(r[2]), String(r[4] ?? '') || null, String(r[3]).toUpperCase() === 'YES');
          if (!meta.has(tkey)) meta.set(tkey, new Map());
          meta.get(tkey)!.set(cname, ct);
          if (String(r[5]) === 'PRI') pkTypes.set(tkey, ct);
        }

        if (checks.types) {
          io.say(`Type audit: ${shape.joins.length} join pairs, ${shape.literals.length} literal comparisons…`);
          const tf = auditJoinTypes(shape, meta);
          findings.push(...tf);
          const pairsMd = shape.joins.length
            ? mdTable(['Left', 'Right'],
                shape.joins.map(j => [`${j.left.raw}`, `${j.right.raw}`]))
            : '_No qualified join pairs detected._\n';
          sections.push({
            title: 'Data-type audit (joins & filters)',
            md: pairsMd + (tf.length ? '' : '\n✅ All checked join keys and literal comparisons are type-consistent.'),
            findings: tf,
          });
        }

        if (checks.ceilings && isMssql) {
          io.say('IDENTITY ceilings…');
          // IDENT_CURRENT is the last value handed out, which is what runs into
          // the column type's maximum — the same relationship MySQL's
          // AUTO_INCREMENT has, so the same auditor answers it.
          const ai = await io.query(
            `SELECT s.name + '.' + t.name, IDENT_CURRENT(s.name + '.' + t.name)
             FROM sys.tables t JOIN sys.schemas s ON s.schema_id = t.schema_id
             WHERE s.name + '.' + t.name IN (${inList})
               AND OBJECTPROPERTY(t.object_id, 'TableHasIdentity') = 1`);
          const cf = auditCeilings(ai.rows.map(r => ({
            table: String(r[0]),
            autoInc: r[1] === null ? null : Number(r[1]),
            pkType: pkTypes.get(String(r[0]).toLowerCase()) ?? null,
          })));
          findings.push(...cf);
          sections.push({
            title: 'Integer ceilings (IDENTITY vs type max)',
            md: cf.length ? '' : '✅ No table above 20% of its identity column\'s ceiling.',
            findings: cf,
          });
        }

        if (checks.ceilings && isMysql) {
          io.say('Integer ceilings…');
          const aiSql = `SELECT CONCAT(table_schema,'.',table_name), AUTO_INCREMENT FROM information_schema.tables WHERE CONCAT(table_schema,'.',table_name) IN (${inList}) AND AUTO_INCREMENT IS NOT NULL`;
          const ai = await io.query(aiSql);
          const cf = auditCeilings(ai.rows.map(r => ({
            table: String(r[0]),
            autoInc: r[1] === null ? null : Number(r[1]),
            pkType: pkTypes.get(String(r[0]).toLowerCase()) ?? null,
          })));
          findings.push(...cf);
          sections.push({
            title: 'Integer ceilings (AUTO_INCREMENT vs type max)',
            md: cf.length ? '' : '✅ No table above 20% of its PK ceiling.',
            findings: cf,
          });
        }

        // PG: the sequence feeding an identity/serial column is always
        // int8; the ceiling that bites is the column's. last_value is NULL
        // without SELECT on the sequence — unknown stays silent.
        if (checks.ceilings && !isMysql && !isMssql) {
          io.say('Sequence/identity ceilings…');
          const seq = await io.query(PG_SNAPSHOT_SQL.sequencesForTables(inList));
          const cf = auditPgCeilings(seq.rows.map(r => ({
            table: String(r[0]),
            column: String(r[1]),
            dataType: String(r[2]),
            lastValue: r[3] === null ? null : Number(r[3]),
          })));
          findings.push(...cf);
          sections.push({
            title: 'Integer ceilings (sequence/identity vs column type max)',
            md: cf.length ? '' : '✅ No sequence-driven column above 20% of its type ceiling.',
            findings: cf,
          });
        }
      } catch (e) {
        sections.push({ title: 'Data-type audit', md: `_Failed: ${errorDisplay(e)}_` });
      }
    }

    // ── 4. EXPLAIN + SHOW WARNINGS ──
    // ── InnoDB optimizer statistics (Q2, SQL_QUALITY_DEEPDIVE) ──
    if (checks.stats && isMssql && qualified.length > 0 && !ddlMode) {
      io.say('Statistics freshness (sys.dm_db_stats_properties)…');
      try {
        const ts = await io.query(
          `SELECT s.name + '.' + t.name AS [table], st.name AS [statistic],
                  sp.rows, sp.rows_sampled, sp.modification_counter,
                  CONVERT(varchar(30), sp.last_updated, 120) AS last_updated
           FROM sys.stats st
           JOIN sys.tables t ON t.object_id = st.object_id
           JOIN sys.schemas s ON s.schema_id = t.schema_id
           CROSS APPLY sys.dm_db_stats_properties(st.object_id, st.stats_id) sp
           WHERE s.name + '.' + t.name IN (${inList})
           ORDER BY sp.last_updated`);
        sections.push({
          title: 'Statistics freshness',
          md: '```\n' + resultToAscii(ts) + '\n```\n'
            // modification_counter is the number the optimiser itself watches:
            // once it crosses the auto-update threshold the plan can flip
            // without the query changing, which is the "it was fine yesterday"
            // report.
            + '\n`modification_counter` is how many rows changed since the statistic was last '
            + 'built. A large one beside an old `last_updated` is a plan waiting to flip; '
            + '`UPDATE STATISTICS` (or the 🩹 Maintenance panel) rebuilds it.',
        });
      } catch (e) {
        sections.push({ title: 'Statistics freshness', md: `_Failed: ${errorDisplay(e)}_` });
      }
    }

    if (checks.stats && isMysql && qualified.length > 0 && !ddlMode) {
      io.say('InnoDB statistics (mysql.innodb_table_stats)…');
      try {
        const pairs = qualified.map(t => {
          const [db, tb] = t.includes('.') ? t.split('.') : [currentDb, t];
          return `(database_name = '${esc(db)}' AND table_name = '${esc(tb)}')`;
        }).join(' OR ');
        const ts = await io.query(`SELECT database_name, table_name, n_rows, clustered_index_size, sum_of_other_index_sizes, last_update FROM mysql.innodb_table_stats WHERE ${pairs}`);
        const ist = await io.query(`SELECT database_name, table_name, index_name, stat_name, stat_value FROM mysql.innodb_index_stats WHERE (${pairs}) AND stat_name LIKE 'n_diff_pfx%' ORDER BY table_name, index_name, stat_name`);
        sections.push({ title: 'InnoDB statistics', md: '```\n' + resultToAscii(ts) + '\n```' });
        const nowMs = Date.now();
        const rowsByTable = new Map<string, number>();
        for (const r of ts.rows) {
          const key = `${r[0]}.${r[1]}`;
          const nRows = Number(r[2]) || 0;
          rowsByTable.set(key, nRows);
          const age = (nowMs - new Date(String(r[5])).getTime()) / 86_400_000;
          if (age > 7 && nRows > 10_000) {
            findings.push({
              id: 'S1', severity: 'orange',
              title: `Stale optimizer statistics on ${key} (${Math.round(age)} days old, ~${nRows.toLocaleString()} rows)`,
              detail: `The optimizer plans against ${Math.round(age)}-day-old statistics — estimates in EXPLAIN can be far off and plans can flip. Fix: ANALYZE TABLE ${r[0]}.${r[1]};`,
            });
          }
        }
        // leading-prefix cardinality per index (n_diff_pfx01)
        for (const r of ist.rows) {
          if (String(r[3]) !== 'n_diff_pfx01') continue;
          const key = `${r[0]}.${r[1]}`;
          const nRows = rowsByTable.get(key) ?? 0;
          const card = Number(r[4]) || 0;
          if (nRows > 100_000 && card > 0 && card < 10 && String(r[2]) !== 'PRIMARY') {
            findings.push({
              id: 'S2', severity: 'yellow',
              title: `Low-selectivity index ${key}.${r[2]} — leading column has only ${card} distinct values over ~${nRows.toLocaleString()} rows`,
              detail: `Each lookup on the leading column still touches ~${Math.round(nRows / card).toLocaleString()} rows (from innodb_index_stats n_diff_pfx01). Consider reordering columns (most selective first) or dropping the index if unused.`,
            });
          }
        }
      } catch (e) {
        findings.push({ id: 'S0', severity: 'yellow', title: 'InnoDB stats unavailable', detail: `Reading mysql.innodb_table_stats failed (privilege?): ${errorDisplay(e)}` });
      }
    }

    // AST-exact predicates from column_map (advisor prefers these over regex)
    let astEq: string[] | null = null;
    let astRange: string[] | null = null;

    // db context for prepare/EXPLAIN when the connection has no default DB
    const dbGuess = dbOverride.trim() || currentDb || (qualified[0]?.includes('.') ? qualified[0].split('.')[0] : '');

    // ── Column map: server-described exact types (Q1, SQL_QUALITY_DEEPDIVE) ──
    if (checks.columnMap && serverCapable && !ddlMode) {
      io.say('Column map (server describe)…');
      try {
        const cm = await io.columnMap(subSql, dbGuess || null);
        if (cm.parse_ok) { astEq = cm.eq_cols; astRange = cm.range_cols; }
        const w = Math.max(...cm.columns.map(c => c.name.length), 6);
        const aligned = cm.sources.length === cm.columns.length;
        const lines = cm.columns.map((c, i) =>
          `${String(i + 1).padStart(3)}. ${c.name.padEnd(w)}  ${c.type_name}${c.nullable === false ? '  NOT NULL' : c.nullable === true ? '  NULL' : ''}`
          + (aligned && cm.sources[i] && cm.sources[i] !== c.name ? `  ← ${cm.sources[i]}` : ''));
        findings.push({
          id: 'CM', severity: cm.parse_ok ? 'yellow' : 'orange',
          title: `Column map — ${cm.columns.length} output columns, exact server types (${cm.statement_kind ?? 'statement'} over ${cm.tables.length} tables)`,
          detail: `Types come from the server preparing the statement (no execution) — exact for any preparable query.`
            + (cm.parse_ok ? '' : `
AST parse failed (heuristic checks still apply): ${cm.parse_error}`)
            + `
Tables: ${cm.tables.join(', ') || '—'}

${lines.join('\n')}`,
        });
        sections.push({ title: 'Column map', md: '```\n' + lines.join('\n') + '\n```' });
      } catch (e) {
        findings.push({ id: 'CM0', severity: 'orange', title: 'Column map failed (statement not preparable?)', detail: errorDisplay(e) });
      }
    }

    // ── Advisor synthesis: full scans × predicates × existing indexes ──
    if (isMysql && qualified.length > 0 && !ddlMode) {
      io.say('Index advisor (EXPLAIN × predicates × indexes)…');
      try {
        const ej = await io.explainQuery(subSql, dbGuess || null);
        const planTxt = ej.content;
        // every table block with its access type + row estimate
        const scans: { table: string; rows: number }[] = [];
        const re = /"table_name":\s*"([^"]+)"[\s\S]{0,400}?"access_type":\s*"(\w+)"(?:[\s\S]{0,200}?"rows_examined_per_scan":\s*(\d+))?/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(planTxt)) !== null) {
          if (m[2] === 'ALL') scans.push({ table: m[1], rows: Number(m[3] ?? 0) });
        }
        // predicate columns classified eq vs range (heuristic until the AST binder lands)
        const predMatches = [...subSql.matchAll(/(?:where|and|or)\s+`?(\w+)`?\s*(=|in\b|>=|<=|>|<|between)/gi)];
        const eqCols = astEq ?? [...new Set(predMatches.filter(x => x[2] === '=' || x[2].toLowerCase() === 'in').map(x => x[1].toLowerCase()))];
        const rangeCols = astRange ?? [...new Set(predMatches.filter(x => !(x[2] === '=' || x[2].toLowerCase() === 'in')).map(x => x[1].toLowerCase()).filter(c => !eqCols.includes(c)))];
        const whereCols = [...eqCols, ...rangeCols];
        const groupCols = [...new Set([...subSql.matchAll(/(?:group|order)\s+by\s+`?(\w+)`?/gi)].map(x => x[1].toLowerCase()).filter(c => !whereCols.includes(c)))];
        if (scans.length > 0) {
          const pairsAdv = qualified.map(t => {
            const [db, tb] = t.includes('.') ? t.split('.') : [currentDb, t];
            return `(table_schema = '${esc(db)}' AND table_name = '${esc(tb)}')`;
          }).join(' OR ');
          const idx = await io.query(`SELECT table_name, index_name, column_name, seq_in_index, cardinality FROM information_schema.statistics WHERE ${pairsAdv} ORDER BY table_name, index_name, seq_in_index`);
          // per table: index → ordered column list; column → best cardinality
          const idxCols = new Map<string, Map<string, string[]>>();
          const colCard = new Map<string, number>();
          for (const r of idx.rows) {
            const t = String(r[0]).toLowerCase();
            const ix = String(r[1]);
            const c = String(r[2]).toLowerCase();
            if (!idxCols.has(t)) idxCols.set(t, new Map());
            const m2 = idxCols.get(t)!;
            if (!m2.has(ix)) m2.set(ix, []);
            m2.get(ix)!.push(c);
            const card = Number(r[4]) || 0;
            const key = `${t}|${c}`;
            if (card > (colCard.get(key) ?? 0)) colCard.set(key, card);
          }
          for (const sc of scans) {
            const t = sc.table.toLowerCase();
            // does any existing index serve the predicates? leftmost-prefix rule:
            // leading index columns ⊆ equality set, then optionally one range col
            let served: string | null = null;
            let extendable: { name: string; cols: string[] } | null = null;
            for (const [name, cols] of idxCols.get(t) ?? []) {
              let i = 0;
              while (i < cols.length && eqCols.includes(cols[i])) i++;
              const eqCovered = i >= eqCols.length
                || (i < cols.length && rangeCols.includes(cols[i]));
              if (eqCovered && (rangeCols.length === 0 || (i < cols.length && rangeCols.includes(cols[i])))) {
                served = name; break;
              }
              if (i > 0 && i === cols.length) extendable = { name, cols }; // all-eq prefix, too short
            }
            // candidate: equalities by cardinality desc → most selective range → covering cols
            const eqOrdered = [...eqCols].sort((a, b) => (colCard.get(`${t}|${b}`) ?? 0) - (colCard.get(`${t}|${a}`) ?? 0));
            const bestRange = [...rangeCols].sort((a, b) => (colCard.get(`${t}|${b}`) ?? 0) - (colCard.get(`${t}|${a}`) ?? 0))[0];
            const candidate = [...eqOrdered, ...(bestRange ? [bestRange] : []), ...groupCols.filter(c => !eqOrdered.includes(c) && c !== bestRange)];
            findings.push({
              id: 'A1', severity: 'red',
              title: `Full table scan on ${sc.table}${sc.rows ? ` — ~${sc.rows.toLocaleString()} rows examined per scan` : ''}`,
              detail: served
                ? `Index \`${served}\` matches the predicates by leftmost-prefix but the optimizer scanned anyway — likely stale statistics (run ANALYZE TABLE ${sc.table}) or an implicit cast on a predicate column (see the data-type audit).`
                : candidate.length > 0
                  ? (extendable
                      ? `Index \`${extendable.name}\` (${extendable.cols.join(', ')}) is a usable prefix — EXTEND it instead of adding a new one:\n  ALTER TABLE ${sc.table} DROP INDEX \`${extendable.name}\`, ADD INDEX ix_${t}_ext (${[...extendable.cols, ...candidate.filter(c => !extendable!.cols.includes(c))].join(', ')});\n`
                      : `Predicates eq(${eqCols.join(', ') || '—'}) range(${rangeCols.join(', ') || '—'}) have no supporting index.\nRecommend:\n  CREATE INDEX ix_${t}_${candidate.join('_').slice(0, 40)} ON ${sc.table} (${candidate.join(', ')});\n(equalities first — ordered by cardinality from information_schema.statistics — then the most selective range column; trailing columns make it COVERING for GROUP BY/ORDER BY, so the full scan becomes an index range read with no row lookups.)`
                      + (sc.rows > 0 && (colCard.get(`${t}|${candidate[0]}`) ?? 0) > 1
                        ? `\nEstimated rows examined: ~${sc.rows.toLocaleString()} → ~${Math.max(1, Math.round(sc.rows / (colCard.get(`${t}|${candidate[0]}`) ?? 1))).toLocaleString()} (leading-column cardinality ${colCard.get(`${t}|${candidate[0]}`)?.toLocaleString()}).`
                        : ''))
                  : 'No WHERE predicates detected — the scan may be inherent (aggregation over the whole table).',
            });
          }
        } else {
          findings.push({ id: 'A0', severity: 'yellow', title: 'Advisor: no full table scans detected', detail: 'Every table access in the plan uses an index (ref/range/eq_ref/index).' });
        }
      } catch (e) {
        findings.push({ id: 'A9', severity: 'yellow', title: 'Advisor step failed', detail: errorDisplay(e) });
      }
    }

    // SHOW WARNINGS is MySQL's, and the traditional tabular EXPLAIN has no
    // SQL Server form — its plan is the XML one, read below.
    if (checks.explain && serverCapable && !ddlMode && !isMssql) {
      io.say('EXPLAIN…');
      const t0 = performance.now();
      try {
        const res = await io.explainWithWarnings(subSql, explainDb);
        const explainTxt = resultToAscii(res.explain);
        let warnMd = '';
        const raw: ReportSection['raw'] = [
          { label: 'EXPLAIN', text: explainTxt, wallMs: performance.now() - t0 },
        ];
        if (res.warnings && res.warnings.rows.length > 0) {
          const warnTxt = res.warnings.rows
            .map(r => `[${r[0]}] ${r[1]}: ${r[2]}`).join('\n\n');
          raw.push({ label: 'SHOW WARNINGS', text: warnTxt });
          const normalized = res.warnings.rows.find(r => String(r[1]) === '1003');
          const castCount = normalized ? (String(normalized[2]).match(/\bcast\(/gi) ?? []).length : 0;
          if (castCount > 0) {
            findings.push({
              id: 'W1', severity: 'orange',
              title: `Optimizer's normalized query contains ${castCount} cast() call${castCount === 1 ? '' : 's'}`,
              detail: 'Implicit type conversions confirmed by the server (SHOW WARNINGS Note 1003). Each cast() around a column can disable index access — cross-check against the data-type audit.',
            });
          }
          warnMd = `\n**SHOW WARNINGS** (${res.warnings.rows.length}):\n\n\`\`\`\n${warnTxt.slice(0, 4000)}\n\`\`\`\n`;
        }
        sections.push({
          title: 'EXPLAIN (traditional) + SHOW WARNINGS',
          md: `\`\`\`\n${explainTxt}\`\`\`\n${warnMd}`,
          raw,
        });
      } catch (e) {
        findings.push({ id: 'E0', severity: 'red', title: 'EXPLAIN failed', detail: errorDisplay(e) });
        sections.push({ title: 'EXPLAIN', md: `_Failed: ${errorDisplay(e)}_` });
      }
    }

    // ── 5. The query plan ──
    //
    // SQL Server's is a SHOWPLAN_XML document rather than MySQL's cost JSON, so
    // it goes through the same parser the plan viewer uses. That is the point:
    // the panel reports what the visualiser would show, rather than a second,
    // differently-wrong reading of the same document.
    if ((checks.explain || checks.explainJson) && serverCapable && !ddlMode && isMssql) {
      io.say('SHOWPLAN_XML…');
      const t0 = performance.now();
      try {
        const res = await io.explainQuery(subSql, explainDb);
        const plan = parseMssqlPlan(res.content);
        const flat: PlanNode[] = [];
        const walk = (n: PlanNode) => { flat.push(n); n.children.forEach(walk); };
        walk(plan.root);

        const worst = [...flat].sort((a, b) => b.severity - a.severity)[0];
        const scans = flat.filter(n => n.kind === 'scan-seq' && n.stats.relation);
        const flagged = flat.filter(n => (n.stats.flags ?? []).length > 0);

        // A clustered index scan IS a table scan — the clustered index is the
        // table. It is the single most common SQL Server performance problem
        // and the one most often read as "it's using an index".
        for (const n of scans) {
          findings.push({
            id: 'MS1', severity: (n.stats.rowsEst ?? 0) > 10_000 ? 'orange' : 'yellow',
            title: `Full scan of ${n.stats.relation} (${n.op})`,
            detail: `${n.op} reads every row — a Clustered Index Scan is a TABLE scan, because `
              + `the clustered index is the table. Estimated ${Math.round(n.stats.rowsEst ?? 0)
                .toLocaleString()} rows, ${(n.stats.costSelf ?? 0).toFixed(4)} of the plan's cost. `
              + 'A seek needs an index whose leading column the predicate can use.',
          });
        }
        for (const n of flagged) {
          const flags = n.stats.flags!;
          findings.push({
            id: 'MS2',
            severity: flags.some(f => /spill|missing index|conversion/.test(f)) ? 'orange' : 'yellow',
            title: `${n.op}: ${flags.join(', ')}`,
            detail: 'SQL Server attached this warning to the operator itself. '
              + 'A spill means the memory grant was too small and the work went to tempdb; '
              + 'an implicit conversion on a predicate disables index seeks; missing '
              + 'statistics mean the row estimates behind this plan are guesses.',
          });
        }

        const rows = flat.map(n => [
          n.op,
          n.stats.relation ?? '',
          Math.round(n.stats.rowsEst ?? 0).toLocaleString(),
          (n.stats.costSelf ?? 0).toFixed(4),
          (n.stats.flags ?? []).join(', '),
        ]);
        sections.push({
          title: `Query plan (${plan.measured ? 'measured' : 'estimated'})`,
          md: `${plan.summary}\n\n`
            + mdTable(['Operator', 'Object', 'Rows est', 'Cost (self)', 'Notes'], rows)
            + (worst ? `\n**Costliest operator:** ${worst.op}`
                + `${worst.stats.relation ? ` on ${worst.stats.relation}` : ''}`
                + ` — ${((worst.severity) * 100).toFixed(0)}% of the plan's cost.\n` : ''),
          raw: [{ label: 'SHOWPLAN_XML', text: res.content, wallMs: performance.now() - t0 }],
        });
      } catch (e) {
        sections.push({ title: 'Query plan', md: `_Failed: ${errorDisplay(e)}_` });
      }
    }

    if (checks.explainJson && serverCapable && !ddlMode && !isMssql) {
      io.say('EXPLAIN FORMAT=JSON…');
      try {
        const res = await io.explainQuery(subSql, explainDb);
        const costs = [...res.content.matchAll(/"query_cost":\s*"?([\d.]+)"?/g)]
          .map(m => Number(m[1])).sort((a, b) => b - a);
        const costMd = costs.length
          ? `Cost blocks (desc): ${costs.slice(0, 12).map(c => c.toLocaleString()).join(', ')}${costs.length > 12 ? ', …' : ''} — total ≈ **${costs.reduce((s, c) => s + c, 0).toLocaleString()}**\n`
          : '_No cost data in plan._\n';
        if (costs[0] > 1_000_000) {
          findings.push({
            id: 'E1', severity: 'red',
            title: `Plan block with cost ${Math.round(costs[0]).toLocaleString()}`,
            detail: 'A query_cost above ~1M units usually means a large scan or massive join fan-out. Find the block in the raw JSON plan (appendix) and check its access type.',
          });
        }
        sections.push({
          title: 'EXPLAIN FORMAT=JSON (cost overview)',
          md: costMd + '\nFull JSON plan is in the raw .txt companion.',
          raw: [{ label: 'EXPLAIN FORMAT=JSON', text: res.content }],
        });
      } catch (e) {
        sections.push({ title: 'EXPLAIN FORMAT=JSON', md: `_Failed: ${errorDisplay(e)}_` });
      }
    }

    // ── 6. EXPLAIN ANALYZE (guarded) ──
    // `explainAnalyzeGuarded` runs MySQL's EXPLAIN ANALYZE and parses its tree
    // text. SQL Server's measured plan is `SET STATISTICS XML`, a different
    // document entirely — it is read by the plan section above rather than
    // pushed through a parser written for another engine's output.
    if (checks.analyze && serverCapable && !ddlMode && !isMssql) {
      io.say(`EXPLAIN ANALYZE (executes the query, ${timeoutSec}s guard)…`);
      const t0 = performance.now();
      try {
        const text = await io.explainAnalyzeGuarded(subSql, timeoutSec * 1000, explainDb);
        const wall = performance.now() - t0;
        // systematic interpretation: est/actual ratios, loops, bottleneck
        const insights = analyzePlanText(text);
        findings.push(...insights.findings);
        sections.push({
          title: `EXPLAIN ANALYZE (measured, ${(wall / 1000).toFixed(1)}s wall)`,
          // The raw output lives in the appendix (and the Raw outputs chip),
          // not inlined and truncated here — one copy, complete, where the
          // forensic level goes looking for it.
          md: insights.md,
          findings: insights.findings,
          raw: [{ label: 'EXPLAIN ANALYZE', text, wallMs: wall }],
        });
      } catch (e) {
        const wall = performance.now() - t0;
        findings.push({
          id: 'X1', severity: 'red',
          title: `EXPLAIN ANALYZE did not finish in ${timeoutSec}s`,
          detail: `Server response after ${(wall / 1000).toFixed(0)}s: ${errorDisplay(e)}. The statement cannot complete within the guard for these parameters — that is itself the headline finding.`,
        });
        sections.push({
          title: 'EXPLAIN ANALYZE (timed out)',
          md: `_Did not finish in ${timeoutSec}s: ${errorDisplay(e)}_`,
          raw: [{ label: 'EXPLAIN ANALYZE (TIMEOUT)', text: errorDisplay(e), wallMs: wall }],
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
