/**
 * SQL Quality window — paste or load a query, tick what to verify, get a
 * deep-dive report (exportable as .md + raw .txt), modeled on a manual
 * DBA analysis: static lint, referenced-table DDL/sizes, join data-type
 * audit (signed/unsigned, collations, implicit casts), integer ceilings,
 * EXPLAIN (+SHOW WARNINGS), EXPLAIN FORMAT=JSON, guarded EXPLAIN ANALYZE.
 */
import { errorDisplay } from '../utils/appError';
import { runQualityAnalysis, reportTimestamp } from '../utils/qualityRun';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import type { QueryResult, Session } from '../types';
import { countPositional, SEVERITY_ICON, SEVERITY_ORDER } from '../utils/sqlLint';
import type { Finding } from '../utils/sqlLint';
import { findVariables } from '../utils/sqlVars';
import { buildMarkdown, buildFindingsTxt, categoryOf } from '../utils/qualityReport';
import type { ReportSection, RenderOptions } from '../utils/qualityReport';
import {
  renderFindings, atOrAbove, DETAIL_LEVELS, DETAIL_LABEL, DETAIL_HINT,
} from '../utils/qualityReport';
import { usePreference, PREFS, QUALITY_FLOORS } from '../store/preferences';
import type { Severity } from '../utils/sqlLint';
import { ASSUMPTIONS } from '../utils/ddlCost';
import { reviewSchema } from '../utils/schemaRules';
import { MYSQL_SNAPSHOT_SQL, PG_SNAPSHOT_SQL, buildSnapshot } from '../utils/schemaCollect';
import type { Grid } from '../utils/schemaCollect';
import { saveTextAs, copyToClipboard } from '../utils/exportersIo';
import { basename } from '../utils/platform';

interface Props {
  session: Session;
  onClose: () => void;
}

interface Checks {
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

export function SqlQualityPanel({ session, onClose }: Props) {
  const serverCapable = session.engine === 'mysql' || session.engine === 'postgres'
    || session.engine === 'sqlserver';
  const isMysql = session.engine === 'mysql';
  const isMssql = session.engine === 'sqlserver';
  /**
   * Schema review is NOT the same capability as query analysis.
   *
   * It needs a per-engine *rulebook* — the MySQL rules judge InnoDB index
   * mechanics, PostgreSQL's judge timestamptz and unlogged tables — and a
   * collector that reads that engine's catalog. SQL Server has query analysis
   * (lint, types, ceilings, SHOWPLAN) but no rulebook, so the mode stays greyed
   * with the reason rather than running MySQL's catalog queries against it.
   */
  const canSchemaReview = isMysql || session.engine === 'postgres';

  const [sql, setSql] = useState('');
  const [params, setParams] = useState('');
  const [dbOverride, setDbOverride] = useState('');
  const [schemas, setSchemas] = useState<string[]>([]);
  useEffect(() => {
    if (!serverCapable) return;
    const q = isMysql ? 'SELECT schema_name FROM information_schema.schemata ORDER BY schema_name'
      // schema_id < 16384 excludes the empty schemas SQL Server creates for its
      // fixed database roles — a dozen entries nobody has ever put a table in.
      : isMssql ? 'SELECT name FROM sys.schemas WHERE schema_id < 16384 ORDER BY name'
      : "SELECT nspname FROM pg_namespace WHERE nspname NOT LIKE 'pg_%' ORDER BY nspname";
    invoke<QueryResult>('monitor_query', { sessionId: session.sessionId, sql: q })
      .then(r => setSchemas(r.rows.map(row => String(row[0])))).catch(() => {});
  }, [session.sessionId, serverCapable, isMysql, isMssql]);
  const [checks, setChecks] = useState<Checks>({
    lint: true,
    // SQL Server's column map is the best of the three: it returns the
    // DECLARED type with its length (`nvarchar(120)`, `decimal(10,2)`) rather
    // than a bare type name, and without executing the statement.
    columnMap: serverCapable,
    // SQL Server's statistics freshness has its own section (sys.dm_db_stats_properties).
    stats: isMysql || isMssql,
    tables: serverCapable, types: serverCapable,
    ceilings: serverCapable, explain: serverCapable, explainJson: serverCapable,
    analyze: false,
  });
  const [timeoutSec, setTimeoutSec] = useState(120);
  const [running, setRunning] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  /**
   * The run's *result*, not its rendering. The detail level is applied when
   * the report is drawn, so changing it re-renders instantly instead of
   * re-running the analysis — and Copy/Export get exactly what is on screen.
   */
  const [report, setReport] = useState<{
    findings: Finding[]; sections: ReportSection[];
    meta: Parameters<typeof buildMarkdown>[0]; txt: string;
  } | null>(null);
  /**
   * Two questions, one panel. `query` asks "will this statement be fast and
   * correct"; `schema` asks "is the database it lands in sane" — the
   * catalog-driven two thirds of the rulebook, which needs no SQL input at
   * all. They share the report, the detail control and the exports.
   */
  const [mode, setMode] = useState<'query' | 'schema'>('query');
  const [detail, setDetail] = usePreference(PREFS.qualityDetail);
  const [floor, setFloor] = usePreference(PREFS.qualityFloor);
  const [showPassed, setShowPassed] = usePreference(PREFS.qualityShowPassed);
  const renderOpts: RenderOptions = useMemo(() => ({
    level: detail,
    // `info` is the floor that filters nothing, so it is sent as absent.
    floor: floor === 'info' ? undefined : (floor as Severity),
    showPassed,
    // Printed at `forensic` only: every constant that turned a size into a
    // duration, so the reader can check the number instead of believing it.
    assumptions: [
      { name: 'Rebuild throughput', value: `${ASSUMPTIONS.rebuildMbPerSec} MB/s`,
        affects: 'estimated ALTER / rebuild time, and the replica lag it adds' },
      { name: 'Metadata-only floor', value: `${ASSUMPTIONS.metadataFloorSeconds} s`,
        affects: 'operations that change only the catalog' },
      { name: 'Row counts', value: 'optimizer statistics, never COUNT(*)',
        affects: 'every row figure in this report — they are estimates, and stale statistics make them worse' },
      { name: 'Statement timeout', value: `${timeoutSec} s`,
        affects: 'the guarded EXPLAIN ANALYZE' },
    ],
  }), [detail, floor, showPassed, timeoutSec]);
  const reportMd = useMemo(
    () => (report ? buildMarkdown(report.meta, report.findings, report.sections, renderOpts) : ''),
    [report, renderOpts]);
  const [flash, setFlash] = useState<string | null>(null);
  // Raw evidence blocks (EXPLAIN, DDL, stats…) — clickable chips → plain-text popup
  const [rawBlocks, setRawBlocks] = useState<{ label: string; text: string }[]>([]);
  const [rawView, setRawView] = useState<{ label: string; text: string } | null>(null);
  useEffect(() => {
    if (!rawView) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setRawView(null); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [rawView]);

  const qCount = useMemo(() => countPositional(sql), [sql]);
  const varNames = useMemo(() => findVariables(sql), [sql]);
  const needsParams = qCount > 0 || varNames.length > 0;

  const set = (patch: Partial<Checks>) => setChecks(c => ({ ...c, ...patch }));
  const note = (msg: string) => {
    setFlash(msg);
    setTimeout(() => setFlash(null), 2500);
  };

  async function loadFile() {
    const p = await open({ filters: [{ name: 'SQL', extensions: ['sql', 'txt'] }], multiple: false });
    if (typeof p === 'string') {
      try {
        // read via backend-free path: use fetch on asset? Simplest: csv_preview won't fit — use invoke read
        const text = await invoke<string>('read_text_file', { path: p });
        setSql(text);
      } catch (e) { note(`Could not read file: ${errorDisplay(e)}`); }
    }
  }

  const run = useCallback(async () => {
    if (!sql.trim() || running) return;
    setRunning(true);
    setReport(null);
    const logs: string[] = [];
    const say = (m: string) => { logs.push(m); setLog([...logs]); };
    try {
      // The pipeline itself lives in utils/qualityRun (WP-16 16.5) — pure and
      // testable; everything Tauri-backed goes in through the io object.
      const out = await runQualityAnalysis({
        sql, engine: session.engine, connectionName: session.connectionName,
        isMysql, serverCapable, params, qCount, varNames, checks, timeoutSec,
        dbOverride,
      }, {
        say,
        onPretty: pretty => setSql(pretty),
        query: sqlText => invoke<QueryResult>('monitor_query', { sessionId: session.sessionId, sql: sqlText }),
        getDdl: parent => invoke<string>('get_ddl', { sessionId: session.sessionId, parent }),
        columnMap: (sqlText, db) => invoke('column_map', { sessionId: session.sessionId, sql: sqlText, db }),
        explainQuery: (sqlText, db) => invoke('explain_query', { sessionId: session.sessionId, sql: sqlText, analyze: false, db }),
        explainWithWarnings: (sqlText, db) => invoke('explain_with_warnings', { sessionId: session.sessionId, sql: sqlText, db }),
        explainAnalyzeGuarded: (sqlText, timeoutMs, db) => invoke('explain_analyze_guarded', { sessionId: session.sessionId, sql: sqlText, timeoutMs, db }),
      });
      setReport({ findings: out.findings, sections: out.sections, meta: out.meta, txt: out.txt });
      setRawBlocks(out.rawBlocks);
      say(`Done — ${out.findings.length} finding${out.findings.length === 1 ? '' : 's'}.`);
    } catch (e) {
      say(`Aborted: ${errorDisplay(e)}`);
    } finally {
      setRunning(false);
    }
  }, [sql, running, params, qCount, varNames, checks, session, isMysql, serverCapable, timeoutSec, dbOverride]);

  /**
   * Review the schema as it stands — the rulebook without a parser.
   *
   * Six independent queries per dialect (seven on PostgreSQL, which adds the
   * sequence-headroom read): each failure costs its part of the report and
   * nothing else, because a restricted account (no `mysql.*` grant, so no
   * statistics) must still get everything that does not depend on it.
   */
  const runSchemaReview = useCallback(async () => {
    if (running) return;
    setRunning(true);
    setReport(null);
    const logs: string[] = [];
    const say = (m: string) => { logs.push(m); setLog([...logs]); };
    setLog([]);
    // The review is scoped to one schema — the DB box at the top picks it.
    const schema = dbOverride.trim();
    try {
      if (!schema) {
        say('Pick a database first — the review is scoped to one schema.');
        return;
      }
      say(`Reading the catalog of \`${schema}\`…`);
      const grid = async (sql: string): Promise<Grid | null> => {
        try {
          const r = await invoke<QueryResult>('monitor_query', { sessionId: session.sessionId, sql });
          return { columns: r.columns.map(c => c.name), rows: r.rows };
        } catch {
          return null;
        }
      };

      // The two dialects read different catalogs (information_schema vs
      // pg_catalog) but produce the same grid shapes — see schemaCollect.ts.
      const SNAP = isMysql ? MYSQL_SNAPSHOT_SQL : PG_SNAPSHOT_SQL;
      const [defaults, tables, columns, indexes, foreignKeys, sequences] = await Promise.all([
        grid(SNAP.defaults(schema)),
        grid(SNAP.tables(schema)),
        grid(SNAP.columns(schema)),
        grid(SNAP.indexes(schema)),
        grid(SNAP.foreignKeys(schema)),
        isMysql ? Promise.resolve(null) : grid(PG_SNAPSHOT_SQL.sequences(schema)),
      ]);

      // Persisted statistics first; the fallback estimates only if that is not
      // readable, because its size columns can trigger a per-table dive.
      let stats = await grid(SNAP.stats(schema));
      let statsSource = isMysql ? 'mysql.innodb_table_stats' : 'pg_stat_user_tables + pg_relation_size';
      if (!stats) {
        stats = await grid(SNAP.statsFallback(schema));
        statsSource = isMysql
          ? 'information_schema.TABLES (estimated — no mysql.* grant)'
          : 'pg_class.reltuples (estimated — pg_stat_user_tables unreadable)';
        if (stats) say(isMysql
          ? 'No mysql.innodb_table_stats grant — sizes are information_schema estimates.'
          : 'pg_stat_user_tables unreadable — row counts are pg_class.reltuples estimates.');
      }

      const snap = buildSnapshot({
        schema, engine: session.engine,
        defaults, tables, stats, statsSource, columns, indexes, foreignKeys, sequences,
      });
      const { findings, scanned } = reviewSchema(snap);
      say(`Reviewed ${scanned.tables} tables, ${scanned.columns} columns, `
        + `${scanned.indexes} indexes, ${scanned.foreignKeys} foreign keys.`);

      setReport({
        findings,
        sections: [],
        meta: {
          connectionName: session.connectionName,
          engine: session.engine,
          date: reportTimestamp(),
          sql: `-- schema review: ${schema}`,
        },
        txt: '',
      });
      setRawBlocks([]);
      say(`Done — ${findings.length} finding${findings.length === 1 ? '' : 's'}.`);
    } catch (e) {
      say(`Aborted: ${errorDisplay(e)}`);
    } finally {
      setRunning(false);
    }
  }, [running, dbOverride, session, isMysql]);

  const sevCounts = useMemo(() => {
    const c = { red: 0, orange: 0, yellow: 0, info: 0 };
    for (const f of report?.findings ?? []) c[f.severity]++;
    return c;
  }, [report]);

  return (
    <div className="proc-panel">
      <div className="proc-toolbar">
        <span className="proc-title">🔍 SQL Quality</span>
        {/* Two questions, one panel — see the `mode` state. The switch is a
            pair of buttons rather than a dropdown because which one you are
            in changes what the whole left half of the panel is. */}
        <button
          className={`toolbar-btn${mode === 'query' ? ' toolbar-btn-on' : ''}`}
          data-tip="Analyse one statement: plan, types, indexes"
          onClick={() => setMode('query')}
        >Query</button>
        {/* The rulebook is per-engine: MySQL judges signedness, charsets and
            InnoDB index mechanics; PostgreSQL gets its own re-derived set
            (timestamptz, identity vs serial, unlogged tables, NOT VALID
            FKs, FK without an index) — see docs/POSTGRES_DEEPDIVE.md §G9.
            Greyed rather than dead on the engines that have no rulebook. */}
        <button
          className={`toolbar-btn${mode === 'schema' ? ' toolbar-btn-on' : ''}${canSchemaReview ? '' : ' unavail'}`}
          data-tip={isMysql
            ? 'Review the schema itself: types, keys, indexes, collation — no SQL needed'
            : session.engine === 'postgres'
              ? 'Review the schema itself: timestamptz vs timestamp, identity vs serial, sequence headroom, unlogged tables, NOT VALID / unindexed foreign keys — no SQL needed'
              : `Schema review — no rulebook for ${session.engine} yet.\nThe rules are per-engine (MySQL 8 and PostgreSQL each have their own); applying one engine's judgements to another produces confident, wrong advice.`}
          aria-disabled={canSchemaReview ? undefined : true}
          onClick={() => { if (canSchemaReview) setMode('schema'); }}
        >Schema</button>
        {mode === 'query' && <button className="toolbar-btn" onClick={loadFile}>Load .sql…</button>}
        {serverCapable && (
          <label className="sqp-db" title="Run all analysis against THIS database — fixes cross-schema 'table not found' errors">
            <span>DB:</span>
            <input list="sqp-db-list" value={dbOverride}
              onChange={e => setDbOverride(e.target.value)}
              placeholder="(session default)"
              spellCheck={false} autoComplete="off" autoCorrect="off" autoCapitalize="off" />
            <datalist id="sqp-db-list">
              {schemas.map(sc => <option key={sc} value={sc} />)}
            </datalist>
          </label>
        )}
        <div style={{ flex: 1 }} />
        {flash && <span className="result-flash">{flash}</span>}
        {report && (
          <>
            {/* Detail, floor and passed-checks are three independent choices:
                "blockers only, one line" is as reasonable an ask as "everything,
                forensic". They apply to the screen and to every export, so what
                you send someone is what you were reading. */}
            <select
              className="toolbar-select"
              value={detail}
              data-tip={DETAIL_HINT[detail]}
              onChange={e => setDetail(e.target.value as typeof detail)}
            >
              {DETAIL_LEVELS.map(l => (
                <option key={l} value={l}>{DETAIL_LABEL[l]}</option>
              ))}
            </select>
            <select
              className="toolbar-select"
              value={floor}
              data-tip="Hide findings less severe than this"
              onChange={e => setFloor(e.target.value as typeof floor)}
            >
              {QUALITY_FLOORS.map(f => (
                <option key={f} value={f}>
                  {f === 'info' ? 'All severities' : `${SEVERITY_ICON[f as Severity]} and above`}
                </option>
              ))}
            </select>
            <label className="form-check" data-tip="List the checks that passed, not only the problems">
              <input type="checkbox" checked={showPassed}
                     onChange={e => setShowPassed(e.target.checked)} />
              Passed
            </label>
            <button className="toolbar-btn" onClick={async () => {
              const p = await saveTextAs(reportMd, 'query_analysis.md', 'Markdown', ['md']);
              if (p) note(`Saved ${basename(p)}`);
            }}>Export .md</button>
            <button className="toolbar-btn" onClick={async () => {
              const p = await saveTextAs(report.txt, 'query_analysis_raw.txt', 'Text', ['txt']);
              if (p) note(`Saved ${basename(p)}`);
            }}>Export raw .txt</button>
            <button className="toolbar-btn" onClick={() => copyToClipboard(reportMd).then(() => note('Copied .md'))}>Copy .md</button>
            <button className="toolbar-btn" data-tip="Findings only, Markdown" onClick={async () => {
              const md = `# Findings\n\n${renderFindings(report.findings, renderOpts)}`;
              const p = await saveTextAs(md, 'findings.md', 'Markdown', ['md']);
              if (p) note(`Saved ${basename(p)}`);
            }}>Findings .md</button>
            <button className="toolbar-btn" data-tip="Findings only, plain text" onClick={async () => {
              const p = await saveTextAs(detail === 'oneline'
                ? renderFindings(report.findings, renderOpts)
                : buildFindingsTxt(atOrAbove(report.findings, renderOpts.floor)), 'findings.txt', 'Text', ['txt']);
              if (p) note(`Saved ${basename(p)}`);
            }}>Findings .txt</button>
          </>
        )}
        <button className="icon-btn" onClick={onClose} title="Close">×</button>
      </div>

      {rawBlocks.length > 0 && (
        <div className="sqp-rawchips">
          <span className="sqp-rawchips-label">Raw outputs:</span>
          {rawBlocks.map((b, i) => (
            <button key={i} className="toolbar-btn" onClick={() => setRawView(b)}>{b.label}</button>
          ))}
        </div>
      )}

      {rawView && (
        <div className="modal-overlay" onClick={() => setRawView(null)}>
          <div className="modal sqp-rawmodal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <span className="modal-title">{rawView.label}</span>
              <button className="toolbar-btn" onClick={() => copyToClipboard(rawView.text).then(() => note('Copied'))}>Copy</button>
              <button className="toolbar-btn" onClick={async () => {
                const p = await saveTextAs(rawView.text, `${rawView.label.toLowerCase().replace(/[^a-z0-9]+/g, '_')}.txt`, 'Text', ['txt']);
                if (p) note(`Saved ${basename(p)}`);
              }}>Save…</button>
              <button className="modal-close" onClick={() => setRawView(null)}>×</button>
            </div>
            <pre className="sqp-rawpre">{rawView.text}</pre>
          </div>
        </div>
      )}

      <div className="sqp-body">
        <div className="sqp-left">
          {mode === 'schema' ? (
            <div className="sqp-schema-intro">
              <h3>Schema review — {dbOverride.trim() || 'pick a database above'}</h3>
              {isMysql ? (
                <>
                  <p>
                    The rulebook applied to the database as it stands: integer sizing and
                    AUTO_INCREMENT headroom, oversized indexed strings, the charset and
                    collation chain at all four levels, keys, redundant indexes, and every
                    column name that is declared two different ways across the schema.
                  </p>
                  <p className="sqp-schema-note">
                    Read-only and cheap: row counts and sizes come from
                    <code> mysql.innodb_table_stats</code> — no <code>COUNT(*)</code> is issued and
                    no table is opened. Findings that quote a number name its source and its age.
                  </p>
                </>
              ) : (
                <>
                  <p>
                    The PostgreSQL rulebook applied to the schema as it stands: timestamp vs
                    timestamptz, identity vs serial, sequence headroom against the column's
                    range, <code>money</code> and blank-padded <code>char(n)</code>, unlogged
                    tables, NOT VALID foreign keys, FK columns PostgreSQL never auto-indexed,
                    redundant indexes, and names that collide with reserved words.
                  </p>
                  <p className="sqp-schema-note">
                    Read-only and cheap: row counts come from <code>pg_stat_user_tables</code>,
                    sizes from <code>pg_relation_size</code> — no <code>COUNT(*)</code> is issued
                    and no table is opened. Findings that quote a number name its source and its age.
                  </p>
                </>
              )}
            </div>
          ) : (
            <textarea
              className="sqp-sql"
              value={sql}
              onChange={e => setSql(e.target.value)}
              placeholder="Paste the query to analyze (or Load .sql)…"
              spellCheck={false}
            />
          )}
          {mode === 'query' && needsParams && (
            <div className="sqp-params">
              <div className="sqp-params-head">
                Parameters ({qCount > 0 ? `${qCount} × ?` : ''}{qCount > 0 && varNames.length > 0 ? ' + ' : ''}{varNames.map(v => ':' + v).join(' ')}) — one value per line, worst-case values recommended
              </div>
              <textarea
                className="sqp-parambox"
                value={params}
                onChange={e => setParams(e.target.value)}
                placeholder={'2025-01-01 00:00:00\n8793\n1349777\n…'}
                spellCheck={false}
              />
            </div>
          )}
        </div>

        <div className="sqp-right">
          <div className="sqp-checks" style={mode === 'schema' ? { display: 'none' } : undefined}>
            <div className="sqp-check-title">Verify</div>
            <label className="gsp-check"><input type="checkbox" checked={checks.lint}
              onChange={e => set({ lint: e.target.checked })} /> Static analysis (offline lint)</label>
            <label className="gsp-check" title={serverCapable ? 'Server prepares the statement — exact type for every output column, no execution' : 'MySQL/PostgreSQL only'}>
              <input type="checkbox" disabled={!serverCapable} checked={checks.columnMap}
              onChange={e => set({ columnMap: e.target.checked })} /> Column map (exact output types)</label>
            <label className="gsp-check" title={isMysql ? 'n_rows, index cardinality, stats age from mysql.innodb_table_stats / innodb_index_stats' : 'MySQL only'}>
              <input type="checkbox" disabled={!isMysql} checked={checks.stats}
              onChange={e => set({ stats: e.target.checked })} /> InnoDB statistics (stale stats, cardinality)</label>
            <label className="gsp-check" title={serverCapable ? '' : 'MySQL/PostgreSQL only'}>
              <input type="checkbox" disabled={!serverCapable} checked={checks.tables}
              onChange={e => set({ tables: e.target.checked })} /> Referenced tables — sizes + DDL</label>
            <label className="gsp-check" title={serverCapable ? '' : 'MySQL/PostgreSQL only'}>
              <input type="checkbox" disabled={!serverCapable} checked={checks.types}
              onChange={e => set({ types: e.target.checked })} /> Data-type audit (signed/unsigned, collations, casts)</label>
            <label className="gsp-check" title={isMysql ? 'AUTO_INCREMENT vs integer type max' : 'Sequence/identity last_value vs the column type max — PG sequences are int8, the column is not'}>
              <input type="checkbox" disabled={!serverCapable} checked={checks.ceilings}
              onChange={e => set({ ceilings: e.target.checked })} /> Integer ceilings ({isMysql ? 'AUTO_INCREMENT' : 'sequence/identity'})</label>
            <label className="gsp-check" title={serverCapable ? '' : 'MySQL/PostgreSQL only'}>
              <input type="checkbox" disabled={!serverCapable} checked={checks.explain}
              onChange={e => set({ explain: e.target.checked })} /> EXPLAIN + SHOW WARNINGS</label>
            <label className="gsp-check" title={serverCapable ? '' : 'MySQL/PostgreSQL only'}>
              <input type="checkbox" disabled={!serverCapable} checked={checks.explainJson}
              onChange={e => set({ explainJson: e.target.checked })} /> EXPLAIN FORMAT=JSON (costs)</label>
            <label className="gsp-check sqp-danger" title="Actually executes the statement under a server-side timeout">
              <input type="checkbox" disabled={!serverCapable} checked={checks.analyze}
              onChange={e => set({ analyze: e.target.checked })} /> EXPLAIN ANALYZE — ⚠ executes the query</label>
            {checks.analyze && (
              <label className="dg-field-inline" style={{ paddingLeft: 22 }}>
                <span>guard</span>
                <input type="number" min={5} max={3600} value={timeoutSec}
                  onChange={e => setTimeoutSec(Math.max(5, Number(e.target.value) || 120))} />
                <span>s</span>
              </label>
            )}
            <button
              className="primary"
              style={{ marginTop: 10 }}
              disabled={running || !sql.trim()}
              onClick={run}
            >{running ? 'Analyzing…' : '▶ Analyze'}</button>
          </div>

          {mode === 'schema' && (
            <button
              className="primary"
              style={{ marginTop: 10 }}
              disabled={running || !dbOverride.trim()}
              data-tip={dbOverride.trim() ? undefined : 'Choose the database to review in the DB box above'}
              onClick={runSchemaReview}
            >{running ? 'Reviewing…' : '▶ Review schema'}</button>
          )}

          <div className="sqp-log">
            {log.map((l, i) => <div key={i} className="sqp-log-line">{l}</div>)}
          </div>

          {report && (
            <div className="sqp-results">
              <div className="sqp-sev-row">
                {sevCounts.red > 0 && <span className="sqp-sev">🔴 {sevCounts.red}</span>}
                {sevCounts.orange > 0 && <span className="sqp-sev">🟠 {sevCounts.orange}</span>}
                {sevCounts.yellow > 0 && <span className="sqp-sev">🟡 {sevCounts.yellow}</span>}
                {sevCounts.info > 0 && <span className="sqp-sev">ℹ️ {sevCounts.info}</span>}
                {report.findings.length === 0 && <span className="sqp-sev">✅ clean</span>}
              </div>
              {/* The same three switches that govern the exported document
                  govern what is on screen — a panel that shows more than it
                  exports makes the control feel like a lie. */}
              {atOrAbove(report.findings, renderOpts.floor)
                .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity])
                .map((f, i) => (
                <div key={`${f.id}-${i}`} className={`sqp-finding sqp-${f.severity}`}>
                  <div className="sqp-f-title">{SEVERITY_ICON[f.severity]} <b>{categoryOf(f.id)}</b> — {f.title}</div>
                  <div className="sqp-f-detail">{f.detail}</div>
                  {f.snippet && <code className="sqp-f-snippet">{f.snippet}</code>}
                  {detail !== 'summary' && detail !== 'oneline' && f.fix && (
                    <code className="sqp-f-snippet sqp-f-fix">{f.fix}</code>
                  )}
                  {(detail === 'deep' || detail === 'forensic') && (
                    <>
                      {f.why && <div className="sqp-f-why">{f.why}</div>}
                      {f.evidence?.map((e, k) => (
                        <div key={k} className="sqp-f-evidence">
                          <b>{e.source}</b> · {e.value}
                          {e.age ? ` · ${e.age}` : ''}
                          {e.modelled ? ' · model estimate, not a measurement' : ''}
                        </div>
                      ))}
                      {f.ruleRef && <div className="sqp-f-evidence">{f.ruleRef}</div>}
                    </>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
