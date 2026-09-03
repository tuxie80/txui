/**
 * Server Tuner — read-only health analysis ("💊 Tuner" tab) for the MySQL
 * family and PostgreSQL: health-score gauge + per-category sub-scores, EOL
 * banner, findings grouped by category with expandable detail and copy-able
 * guided fixes. Both engines return the identical TunerReport shape, so this
 * panel does not branch on engine beyond the config-file convention
 * (`[mysqld]` vs postgresql.conf).
 *
 * Fixes are NEVER executed from this panel — they can only be copied or
 * inserted into the editor for review.
 * Backend: `tuner_analyze` (types in utils/tunerReport).
 */
import { errorDisplay } from '../utils/appError';
import { useCallback, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Spinner } from './Spinner';
import {
  CATEGORY_LABELS, SEVERITY_LABELS, countsText, flavorLabel, fmtUptime,
  groupFindings, isProblem, reportFileName, reportToMarkdown, scoreColor,
} from '../utils/tunerReport';
import type { TunerFinding, TunerReport } from '../utils/tunerReport';
import { copyToClipboard, saveTextAs } from '../utils/exportersIo';

interface Props {
  sessionId: string;
  engine?: string;
  environment?: string | null;
  onClose: () => void;
}

/** Copy button with transient "✓ Copied" feedback. */
function CopyBtn({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="toolbar-btn tun-copy"
      onClick={() => {
        copyToClipboard(text)
          .then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200); })
          .catch(() => {});
      }}
    >{copied ? '✓ Copied' : label}</button>
  );
}

/** Donut gauge for the 0-100 health score (red <50, amber 50-79, green 80+). */
function Gauge({ score }: { score: number }) {
  const r = 52;
  const c = 2 * Math.PI * r;
  const frac = Math.max(0, Math.min(100, score)) / 100;
  return (
    <svg className="tun-gauge" viewBox="0 0 140 140" role="img" aria-label={`Health score ${score} of 100`}>
      <circle className="tun-gauge-track" cx="70" cy="70" r={r} />
      <circle
        className={`tun-gauge-fill tun-gauge-${scoreColor(score)}`}
        cx="70" cy="70" r={r}
        strokeDasharray={`${frac * c} ${c}`}
        transform="rotate(-90 70 70)"
      />
      <text className="tun-gauge-num" x="70" y="70">{score}</text>
      <text className="tun-gauge-cap" x="70" y="92">/ 100</text>
    </svg>
  );
}

function SubScore({ label, value, max }: { label: string; value: number; max: number }) {
  const pct = Math.max(0, Math.min(100, Math.round((value / max) * 100)));
  return (
    <div className="tun-sub">
      <div className="tun-sub-head">
        <span>{label}</span>
        <span className="tun-sub-val">{value}/{max}</span>
      </div>
      <div className="tun-sub-bar">
        <div className={`tun-sub-fill tun-gauge-${scoreColor(pct)}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

/** Hand SQL to the active session's editor (never executed here). */
function insertIntoEditor(sql: string) {
  window.dispatchEvent(new CustomEvent('dbgui:insert-sql', { detail: { sql } }));
}

/** Normalize fix lines into a runnable script: one ';'-terminated statement per line. */
function fixScript(lines: string[]): string {
  return lines.map(s => `${s.trim().replace(/;+\s*$/, '')};`).join('\n');
}

/** MySQL config lines live under a `[mysqld]` section header; PostgreSQL's
 *  postgresql.conf has no sections, and the generated lines already carry
 *  their own `# postgresql.conf` comment. */
function GuidedFix({ f, cfgHeader, cfgLabel }: { f: TunerFinding; cfgHeader: string; cfgLabel: string }) {
  return (
    <div className="tun-fix">
      <div className="tun-fix-title">Guided fix — review before applying; nothing runs from here</div>
      {f.fix_sql.length > 0 && (
        <>
          <div className="tun-fix-sub">Runtime (applies until restart)</div>
          {f.fix_sql.map((s, i) => (
            <div key={i} className="tun-fix-line">
              <code>{s}</code>
              <CopyBtn text={s} />
            </div>
          ))}
          <div className="tun-fix-actions">
            <CopyBtn text={fixScript(f.fix_sql)} label="Copy all" />
            <button
              className="toolbar-btn"
              title="Insert into the SQL editor for review — not executed"
              onClick={() => insertIntoEditor(fixScript(f.fix_sql))}
            >⇥ Insert into editor</button>
          </div>
        </>
      )}
      {f.fix_config.length > 0 && (
        <>
          <div className="tun-fix-sub">{cfgLabel}</div>
          <div className="tun-fix-line">
            <code>{f.fix_config.join('\n')}</code>
            <CopyBtn text={cfgHeader ? `${cfgHeader}\n${f.fix_config.join('\n')}` : f.fix_config.join('\n')} />
          </div>
        </>
      )}
    </div>
  );
}

function FindingRow({ f, open, onToggle, cfgHeader, cfgLabel }: {
  f: TunerFinding; open: boolean; onToggle: () => void; cfgHeader: string; cfgLabel: string;
}) {
  const hasFix = f.fix_sql.length > 0 || f.fix_config.length > 0;
  return (
    <div className="tun-finding">
      <div className="tun-finding-head" onClick={onToggle}>
        <span className={`tun-chip tun-chip-${f.severity}`}>{SEVERITY_LABELS[f.severity]}</span>
        <span className="tun-finding-title">{f.title}</span>
        {f.points_lost > 0 && <span className="tun-pts" title="Points lost from the health score">−{f.points_lost}</span>}
        {hasFix && <span className="tun-hasfix" title="Has a guided fix">🛠</span>}
        <span className="tun-chev">{open ? '▾' : '▸'}</span>
      </div>
      {open && (
        <div className="tun-finding-body">
          <div className="tun-detail">{f.detail}</div>
          {f.recommendation && <div className="tun-rec">→ {f.recommendation}</div>}
          {hasFix && <GuidedFix f={f} cfgHeader={cfgHeader} cfgLabel={cfgLabel} />}
        </div>
      )}
    </div>
  );
}

export function TunerPanel({ sessionId, engine, environment, onClose }: Props) {
  const [report, setReport] = useState<TunerReport | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unsupported, setUnsupported] = useState<string | null>(null);
  const [problemsOnly, setProblemsOnly] = useState(false);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [savedPath, setSavedPath] = useState<string | null>(null);

  const run = useCallback(async () => {
    setRunning(true);
    setError(null);
    setUnsupported(null);
    setSavedPath(null);
    try {
      const r = await invoke<TunerReport>('tuner_analyze', { sessionId });
      setReport(r);
    } catch (e) {
      const msg = errorDisplay(e);
      // PG/Redis: the backend declines with a "not supported yet" message.
      if (/not supported/i.test(msg)) setUnsupported(msg);
      else setError(msg);
    } finally {
      setRunning(false);
    }
  }, [sessionId]);

  const exportReport = useCallback(async () => {
    if (!report) return;
    try {
      const path = await saveTextAs(reportToMarkdown(report), reportFileName(report), 'Markdown', ['md']);
      if (path) setSavedPath(path);
    } catch (e) {
      setError(errorDisplay(e));
    }
  }, [report]);

  const toggleIn = (set: ReadonlySet<string>, key: string, apply: (s: ReadonlySet<string>) => void) => {
    const next = new Set(set);
    if (next.has(key)) next.delete(key); else next.add(key);
    apply(next);
  };

  // Every engine has a rule set: MySQL/MariaDB/Percona, PostgreSQL, Redis,
  // ClickHouse, SQLite.
  const isPg = engine === 'postgres';
  const isRedis = engine === 'redis';
  const isSqlite = engine === 'sqlite';
  const isMssql = engine === 'sqlserver';
  // SQL Server has no configuration FILE — every setting is `sp_configure` or
  // `ALTER DATABASE`, which is why its rule set emits no `fix_config` at all.
  // The header and label are still made correct rather than left to fall
  // through to `[mysqld]`, so a future finding that does carry one cannot
  // quietly render MySQL's.
  const cfgHeader = isPg || isRedis || isMssql ? '' : '[mysqld]';
  const cfgLabel = isPg ? 'Config file (persistent — postgresql.conf)'
    : isRedis ? 'Config file (persistent — redis.conf)'
    : isMssql ? 'Configuration (sp_configure — no file)'
    : 'Config file (persistent — add under [mysqld])';
  const groups = report
    ? groupFindings(problemsOnly ? report.findings.filter(f => isProblem(f.severity)) : report.findings)
    : [];
  const s = report?.server;
  const eol = report?.eol ?? null;
  const isProd = environment === 'prod';

  return (
    <div className="proc-panel">
      <div className="proc-toolbar">
        <span className="proc-title">💊 Server Tuner</span>
        {isProd && (
          <span className="tun-prod-note" title="Analysis reads status and variables only">
            prod · read-only analysis
          </span>
        )}
        {running && <span className="dv-running"><Spinner variant="dots" size="1.1em" className="spinner-inline" />analyzing… this is read-only</span>}
        <div style={{ flex: 1 }} />
        {report && (
          <>
            <button
              className={`qsb-btn ${!problemsOnly ? 'active' : ''}`}
              onClick={() => setProblemsOnly(false)}
            >All</button>
            <button
              className={`qsb-btn ${problemsOnly ? 'active' : ''}`}
              title="Advice + warnings + critical only"
              onClick={() => setProblemsOnly(true)}
            >Problems</button>
          </>
        )}
        {report && (
          <button className="toolbar-btn" disabled={running} onClick={run}>↻ Re-analyze</button>
        )}
        {report && (
          <button className="toolbar-btn" onClick={exportReport}>⇩ Export report</button>
        )}
        <button className="icon-btn" onClick={onClose} title="Close">×</button>
      </div>

      {error && <div className="proc-error-bar">{error}</div>}

      <div className="tun-body">
        {unsupported && (
          <div className="mx-empty">ⓘ {unsupported}</div>
        )}

        {!unsupported && !report && !running && (
          <div className="tun-start">
            <div className="tun-start-icon">💊</div>
            <div className="tun-start-text">
              {isSqlite
                ? 'Read-only file health check: journaling and durability, free space and auto-vacuum, planner statistics (ANALYZE), unindexed foreign keys and structural integrity — with maintenance SQL you can copy or insert into the editor, never auto-run.'
                : isRedis
                ? 'Read-only health check: memory ceiling and eviction policy, fragmentation and swapping, persistence and background-save health, slow commands, client limits, replication, and authentication — with guided fixes you can copy or insert into the editor.'
                : isPg
                ? 'Read-only health check: settings, memory and planner, autovacuum and bloat, transaction-ID wraparound, WAL and replication slots, authentication and schema hygiene — with guided fixes you can copy or insert into the editor.'
                : isMssql
                ? 'Read-only health check: max server memory and MAXDOP, the cost threshold for parallelism, tempdb file count, backups and log backups, AUTO_SHRINK and page verification, autogrowth and VLF count, plan-cache bloat, compatibility level and Query Store — with sp_configure and ALTER DATABASE fixes you can copy or insert into the editor.'
                : 'Read-only health check: variables, status, security and resilience — scored like MySQLTuner, with guided fixes you can copy or insert into the editor.'}
            </div>
            <button className="toolbar-btn tun-start-btn" onClick={run}>▶ Run analysis</button>
            {isProd && <div className="tun-start-note">Production connection — analysis runs reads only, nothing is changed.</div>}
          </div>
        )}

        {running && !report && (
          <div className="proc-loading"><Spinner variant="dots" size="1.1em" className="spinner-inline" />Analyzing server… this is read-only.</div>
        )}

        {report && s && (
          <>
            <div className="tun-dash">
              <Gauge score={report.score.total} />
              <div className="tun-dash-right">
                <div className="tun-server-line">
                  <span className="tun-flavor">{flavorLabel(s.flavor)}</span>
                  <span className="tun-version">{s.version}</span>
                  <span className="tun-dim">{s.version_comment}</span>
                  {s.arch && <span className="tun-dim">· {s.arch}</span>}
                  {!isSqlite && <span className="tun-dim">· up {fmtUptime(s.uptime_secs)}</span>}
                  {s.cloud && <span className="tun-cloud">☁ {s.cloud}</span>}
                </div>
                <div className="tun-subs">
                  <SubScore label="Performance" value={report.score.performance} max={40} />
                  <SubScore label="Security" value={report.score.security} max={30} />
                  <SubScore label="Resilience" value={report.score.resilience} max={30} />
                </div>
              </div>
            </div>

            {eol && (eol.status === 'eol' || eol.status === 'eol-soon') && (
              <div className={`tun-eol ${eol.status === 'eol' ? 'tun-eol-dead' : 'tun-eol-soon'}`}>
                {eol.status === 'eol' ? '🔴' : '🟡'} <strong>{eol.product} {eol.cycle}</strong>
                {eol.status === 'eol' ? ' is end of life' : ' approaches end of life'}
                {eol.eol_date ? ` (${eol.eol_date})` : ''}.
                {eol.latest ? ` Latest release: ${eol.latest} — plan an upgrade path.` : ''}
                {eol.source !== 'endoflife.date' && (
                  <span className="tun-eol-offline"> (offline data — verify against endoflife.date)</span>
                )}
              </div>
            )}
            {eol && eol.status !== 'eol' && eol.status !== 'eol-soon' && eol.source !== 'endoflife.date' && (
              <div className="tun-eol-note">EOL status from offline data ({eol.source}) — verify against endoflife.date.</div>
            )}

            {groups.length === 0 && (
              <div className="mx-empty">
                {problemsOnly ? 'No problems found — nice. 🎉' : 'No findings.'}
              </div>
            )}

            {groups.map(g => (
              <div key={g.category} className="tun-group">
                <div
                  className="tun-group-head"
                  onClick={() => toggleIn(collapsed, g.category, setCollapsed)}
                >
                  <span className="tun-chev">{collapsed.has(g.category) ? '▸' : '▾'}</span>
                  <span className="tun-group-name">{CATEGORY_LABELS[g.category]}</span>
                  <span className="tun-group-counts">{countsText(g.counts)}</span>
                </div>
                {!collapsed.has(g.category) && g.findings.map(f => (
                  <FindingRow
                    key={f.id}
                    f={f}
                    open={expanded.has(f.id)}
                    onToggle={() => toggleIn(expanded, f.id, setExpanded)}
                    cfgHeader={cfgHeader}
                    cfgLabel={cfgLabel}
                  />
                ))}
              </div>
            ))}

            <div className="proc-status">
              Generated {report.generated_at}
              {savedPath ? ` · saved to ${savedPath}` : ''}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
