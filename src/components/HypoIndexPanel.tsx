/**
 * 🧪 HypoPG — hypothetical-index what-if advisor (PostgreSQL only).
 *
 * "Would this index help?" answered without building it. HypoPG registers a
 * candidate index that exists only for this session, so the planner can be
 * asked to cost a query with it present and the answer compared against the
 * plan without it. Nothing is written to disk and nothing is executed: every
 * plan here is a plain EXPLAIN, never EXPLAIN ANALYZE — a hypothetical index
 * has no pages to scan, and not running the query is what keeps this safe to
 * point at production.
 *
 * The one number that matters is the estimated-cost delta, and the one caveat
 * that matters beside it is whether the planner *actually reached for* the new
 * index — a query that got cheaper for some unrelated reason is not a reason
 * to build anything. Both come from utils/hypopg; the SQL never leaves it.
 */
import { errorDisplay } from '../utils/appError';
import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { QueryResult, Session } from '../types';
import { StatusIcon } from './StatusIcon';
import {
  hypopgDetectSql, hypopgEnableSql, hypopgCreateSql, hypopgResetSql,
  explainJsonSql, looksLikeCreateIndex, readHypopgStatus, computeCostDelta, verdictOf,
} from '../utils/hypopg';
import type { HypopgStatus, CostDelta } from '../utils/hypopg';

interface Props {
  session: Session;
  onClose: () => void;
}

interface Outcome {
  delta: CostDelta;
  baselineJson: string;
  hypoJson: string;
  createdNames: string[];
}

const fmtCost = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 2 });

export function HypoIndexPanel({ session, onClose }: Props) {
  const { sessionId } = session;
  const run = useCallback(
    (sql: string) => invoke<QueryResult>('monitor_query', { sessionId, sql }),
    [sessionId]);

  const [status, setStatus] = useState<HypopgStatus | null>(null);
  const [detecting, setDetecting] = useState(true);
  const [enabling, setEnabling] = useState(false);
  const [query, setQuery] = useState('');
  const [indexDdl, setIndexDdl] = useState('');
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Outcome | null>(null);
  const [showPlans, setShowPlans] = useState(false);

  const detect = useCallback(async () => {
    setDetecting(true);
    try {
      const r = await run(hypopgDetectSql());
      setStatus(readHypopgStatus(r.rows[0]));
    } catch (e) {
      setError(errorDisplay(e));
      setStatus(null);
    } finally {
      setDetecting(false);
    }
  }, [run]);

  useEffect(() => { void detect(); }, [detect]);

  const enable = useCallback(async () => {
    setEnabling(true);
    setError(null);
    try {
      await run(hypopgEnableSql());
      await detect();
    } catch (e) {
      setError(errorDisplay(e));
    } finally {
      setEnabling(false);
    }
  }, [run, detect]);

  /** The one cell of an EXPLAIN (FORMAT JSON) result is the plan document. */
  const explain = useCallback(async (sql: string): Promise<string> => {
    const r = await run(explainJsonSql(sql));
    const cell = r.rows[0]?.[0];
    if (cell == null) throw new Error('EXPLAIN returned no plan');
    return typeof cell === 'string' ? cell : JSON.stringify(cell);
  }, [run]);

  const analyze = useCallback(async () => {
    setError(null);
    setResult(null);
    if (!query.trim()) { setError('Enter a target query to plan.'); return; }
    if (!looksLikeCreateIndex(indexDdl)) {
      setError('The candidate must be a CREATE INDEX statement.');
      return;
    }
    setRunning(true);
    try {
      // Start from a clean slate — a stray index from a previous run would
      // silently bias the baseline.
      await run(hypopgResetSql());
      const baselineJson = await explain(query);

      const created = await run(hypopgCreateSql(indexDdl));
      const createdNames = created.rows.map(row => String(row[1]));

      const hypoJson = await explain(query);
      const delta = computeCostDelta(baselineJson, hypoJson, createdNames);
      setResult({ delta, baselineJson, hypoJson, createdNames });
    } catch (e) {
      setError(errorDisplay(e));
    } finally {
      // Hypothetical indexes are session-local, but leaving them registered
      // would poison the next query run in this connection — always clean up.
      try { await run(hypopgResetSql()); } catch { /* best-effort */ }
      setRunning(false);
    }
  }, [query, indexDdl, run, explain]);

  const ready = status?.installed === true;

  return (
    <div className="proc-panel">
      <div className="proc-toolbar">
        <span className="proc-title">🧪 HypoPG — hypothetical index advisor</span>
        <span className="dv-desc">{session.connectionName}</span>
        <div style={{ flex: 1 }} />
        <button className="icon-btn" onClick={onClose} title="Close">×</button>
      </div>

      {error && <div className="proc-error-bar">{error}</div>}

      <div className="dg-body">
        <div className="dg-target" style={{ maxWidth: 860 }}>
          {/* ── availability banner ─────────────────────────────────────── */}
          {detecting ? (
            <div className="dv-desc">Checking for the HypoPG extension…</div>
          ) : !status ? (
            <div className="mnt-warn">
              <StatusIcon kind="error" /> Could not determine HypoPG availability.
              <button className="toolbar-btn" onClick={() => void detect()} style={{ marginLeft: 8 }}>
                Retry
              </button>
            </div>
          ) : ready ? (
            <div className="mnt-bulk-cost c-metadata">
              <StatusIcon kind="ok" />
              <span>HypoPG {status.installedVersion} is installed — candidates are
                session-local and never touch disk.</span>
            </div>
          ) : status.available ? (
            <div className="mnt-warn">
              <StatusIcon kind="error" />
              <span>
                HypoPG {status.availableVersion} is available on this server but not
                enabled in this database.
              </span>
              <button className="primary" onClick={enable} disabled={enabling} style={{ marginLeft: 8 }}>
                {enabling ? 'Enabling…' : 'Enable extension'}
              </button>
            </div>
          ) : (
            <div className="mnt-warn">
              <StatusIcon kind="error" />
              <span>
                HypoPG is not installed on this server. Install the OS package
                (e.g. <code>postgresql-XX-hypopg</code>), then reconnect.
              </span>
            </div>
          )}

          {/* ── inputs ──────────────────────────────────────────────────── */}
          <label className="dg-field-inline" style={{ display: 'block', marginTop: 12 }}>
            <span>Target query</span>
            <textarea
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="SELECT * FROM orders WHERE customer_id = 42"
              spellCheck={false}
              rows={4}
              disabled={!ready || running}
              style={{ width: '100%', fontFamily: 'var(--mono, monospace)', resize: 'vertical' }}
            />
          </label>

          <label className="dg-field-inline" style={{ display: 'block', marginTop: 8 }}>
            <span>Candidate index</span>
            <textarea
              value={indexDdl}
              onChange={e => setIndexDdl(e.target.value)}
              placeholder="CREATE INDEX ON orders (customer_id)"
              spellCheck={false}
              rows={2}
              disabled={!ready || running}
              style={{ width: '100%', fontFamily: 'var(--mono, monospace)', resize: 'vertical' }}
            />
          </label>

          <div className="row-actions" style={{ marginTop: 8 }}>
            <span className="dv-desc" style={{ flex: 1 }}>
              Plans the query with and without the index — read-only, the query
              never runs.
            </span>
            <button className="primary" disabled={!ready || running} onClick={analyze}>
              {running ? 'Planning…' : '▶ What-if'}
            </button>
          </div>

          {/* ── result ──────────────────────────────────────────────────── */}
          {result && (
            <div className="mnt-results" style={{ marginTop: 12 }}>
              <div className={`mnt-bulk-cost ${result.delta.improved && result.delta.indexUsed ? 'c-metadata' : 'c-rebuild'}`}>
                <StatusIcon kind={result.delta.improved && result.delta.indexUsed ? 'ok' : 'error'} />
                <span>{verdictOf(result.delta)}</span>
              </div>

              <div className="row-actions" style={{ marginTop: 8, gap: 24 }}>
                <span className="dv-desc">
                  Baseline cost <b>{fmtCost(result.delta.baselineCost)}</b>
                </span>
                <span className="dv-desc">
                  With index <b>{fmtCost(result.delta.hypoCost)}</b>
                </span>
                <span className="dv-desc">
                  Delta{' '}
                  <b style={{ color: result.delta.improved ? 'var(--ok, #3a3)' : 'var(--danger, #c33)' }}>
                    {result.delta.absolute <= 0 ? '' : '+'}{fmtCost(result.delta.absolute)}
                    {' '}({result.delta.percent <= 0 ? '' : '+'}{result.delta.percent.toFixed(1)}%)
                  </b>
                </span>
                <span className="dv-desc">
                  Index used:{' '}
                  <b>{result.delta.indexUsed ? 'yes' : 'no'}</b>
                </span>
              </div>

              {result.createdNames.length > 0 && (
                <div className="dv-desc" style={{ marginTop: 6 }}>
                  Hypothetical index: <code>{result.createdNames.join(', ')}</code>
                </div>
              )}

              <div className="row-actions" style={{ marginTop: 8 }}>
                <button className="dbs-link" onClick={() => setShowPlans(v => !v)}>
                  {showPlans ? 'hide' : 'show'} plans (JSON)
                </button>
              </div>
              {showPlans && (
                <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                  <div style={{ flex: 1, minWidth: 260 }}>
                    <div className="dv-desc">Baseline</div>
                    <pre className="mnt-bulk-sql" style={{ maxHeight: 260, overflow: 'auto' }}>
                      {result.baselineJson}
                    </pre>
                  </div>
                  <div style={{ flex: 1, minWidth: 260 }}>
                    <div className="dv-desc">With hypothetical index</div>
                    <pre className="mnt-bulk-sql" style={{ maxHeight: 260, overflow: 'auto' }}>
                      {result.hypoJson}
                    </pre>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
