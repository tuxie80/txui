/**
 * Execution plan view — three lenses on one parsed plan.
 *
 *   • **Graph** — the plan as a diagram: operation boxes flowing bottom-up,
 *     edges weighted by row volume, boxes tinted by cost. Default, because the
 *     shape of a plan is the thing a table cannot show.
 *   • **Tree** — Aqua Data Studio style indented operation tree with metric
 *     columns. Still the fastest way to read exact numbers.
 *   • **Raw** — the untouched server output, for when you do not trust us.
 *
 * The banner above them all states whether the numbers are *measured* or
 * *estimated*. That distinction is the single most important thing on this
 * screen: a plain EXPLAIN is the optimiser telling you what it intends, and
 * treating it as evidence of what happened is how people spend an afternoon
 * tuning a cost model instead of a query.
 */
import { errorDisplay } from '../utils/appError';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { parsePlan } from '../utils/planParse';
import type { PlanNode, ParsedPlan } from '../utils/planParse';
import { buildCostModel } from '../utils/planCost';
import { formatWeight } from '../utils/planCost';
import { allFindings } from '../utils/planGlossary';
import { analyseStability, rankRisks } from '../utils/planStability';
import {
  parseProfile, profileTotal, profileFindings, meaningOf, formatSeconds,
  supportsProfiling, ENABLE_SQL, PROFILE_SQL,
} from '../utils/mysqlProfile';
import type { ProfileStage } from '../utils/mysqlProfile';
import { invoke } from '@tauri-apps/api/core';
import type { QueryResult } from '../types';
import { copyToClipboard } from '../utils/exportersIo';
import {
  downloadBlob, downloadSvg, liveSvgToString, svgToPng, themeFromDocument,
} from '../utils/erExport';
import { StatusIcon } from './StatusIcon';
import { PlanGraph, PlanNodeDetail } from './PlanGraph';
import {
  makeRun, pushRun, seriesFor, diffRuns, verdict, detectInstability,
} from '../utils/planHistory';
import type { PlanRun } from '../utils/planHistory';
import { diffPlans, flattenDiff, primaryMetric } from '../utils/planDiff';
import type { PlanNodeDiff } from '../utils/planDiff';

export interface ExplainData {
  format: string;   // "json" | "text"
  engine: string;
  content: string;
  analyzed: boolean;
  sql: string;
  /** ClickHouse only: which EXPLAIN kind produced this ("indexes" | "pipeline"
   *  | "estimate" | "plan"). Undefined for the other engines. */
  mode?: string;
  /**
   * When the plan was fetched, ms epoch.
   *
   * Stamped by the caller rather than read here: run history needs a
   * timestamp, and reading the clock while rendering makes the render impure.
   */
  at?: number;
}

interface Props {
  data: ExplainData;
  /** Re-run with EXPLAIN ANALYZE (executes the query — caller confirms) */
  onAnalyze?: () => void;
  /** ClickHouse: re-run with a different EXPLAIN kind. None of them execute. */
  onMode?: (mode: string) => void;
  /** Needed by the profiler, which runs the statement on this session. */
  sessionId?: string;
  /**
   * The tab's plan history and its writer.
   *
   * Runs live ON THE TAB, in memory only — not on disk (a plan history that
   * survived restarts would invite comparing today's run against one from a
   * week ago on different data, a number that looks authoritative and answers
   * nothing), and not module-global (comparing against another tab's or
   * another session's runs of a similar-looking query was never meaningful).
   * Every plan that parses is recorded here when it is opened — manual
   * EXPLAINs and opened auto-EXPLAINs alike — so a comparison is available
   * without having had to ask for one beforehand: you only know you wanted
   * the "before" once you have the "after".
   */
  runs: PlanRun[];
  onRecordRuns: (runs: PlanRun[]) => void;
}

/** ClickHouse EXPLAIN kinds offered in the toolbar. */
const CH_EXPLAIN_MODES: Array<{ id: string; label: string; title: string }> = [
  { id: 'indexes', label: 'Indexes', title: 'EXPLAIN indexes = 1 — primary-key ranges and partitions the scan reads' },
  { id: 'pipeline', label: 'Pipeline', title: 'EXPLAIN PIPELINE — the processor execution graph' },
  { id: 'estimate', label: 'Estimate', title: 'EXPLAIN ESTIMATE — rows, marks and parts to be read' },
  { id: 'plan', label: 'Plan', title: 'EXPLAIN PLAN — the logical query plan' },
];

const VIEWS = ['graph', 'icicle', 'tree', 'compare', 'profile', 'raw'] as const;
type View = typeof VIEWS[number];
const VIEW_LABELS: Record<View, string> = {
  graph: 'Graph', icicle: 'Cost', tree: 'Tree', compare: 'Compare',
  profile: 'Profile', raw: 'Raw',
};

const VIEW_KEY = 'dbgui.planView';

/** One cell of the comparison's numeric columns, for the node's main metric. */
function metricCell(n: PlanNodeDiff, which: 'before' | 'after' | 'delta'): string {
  const m = primaryMetric(n);
  if (!m) return '—';
  const unit = (v: number) => (m.name === 'time' ? formatWeight(v, 'time')
    : m.name === 'cost' ? formatWeight(v, 'cost')
    : `${Math.round(v).toLocaleString()} ${m.name}`);
  if (which === 'delta') {
    if (m.delta === undefined) return '—';
    return `${m.delta > 0 ? '+' : ''}${unit(m.delta)}`;
  }
  const v = which === 'before' ? m.before : m.after;
  return v === undefined ? '—' : unit(v);
}

/** Green for smaller, red for larger — every metric here is smaller-is-better. */
function deltaClass(n: PlanNodeDiff): string {
  const m = primaryMetric(n);
  if (!m || m.delta === undefined) return '';
  return m.better ? 'cmp-down' : 'cmp-up';
}

interface FlatRow {
  node: PlanNode;
  depth: number;
  path: string;
  hasKids: boolean;
}

function flatten(root: PlanNode, collapsed: Set<string>): FlatRow[] {
  const out: FlatRow[] = [];
  const walk = (n: PlanNode, depth: number, path: string) => {
    out.push({ node: n, depth, path, hasKids: n.children.length > 0 });
    if (!collapsed.has(path)) {
      n.children.forEach((c, i) => walk(c, depth + 1, `${path}.${i}`));
    }
  };
  walk(root, 0, '0');
  return out;
}

function severityClass(s: number): string {
  if (s >= 0.5)  return 'plan-hot';
  if (s >= 0.2)  return 'plan-warm';
  if (s >= 0.05) return 'plan-mild';
  return '';
}

export function ExplainView({ data, onAnalyze, onMode, sessionId, runs, onRecordRuns }: Props) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [copied, setCopied] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [view, setView] = useState<View>(() => {
    try {
      const saved = localStorage.getItem(VIEW_KEY);
      return (VIEWS as readonly string[]).includes(saved ?? '') ? (saved as View) : 'graph';
    } catch { return 'graph'; }
  });
  const pickView = (v: View) => {
    setView(v);
    try { localStorage.setItem(VIEW_KEY, v); } catch { /* quota */ }
  };

  // Attempt a parse regardless of the declared format: MySQL's measured plan
  // (EXPLAIN ANALYZE) arrives as TREE text, and refusing to parse anything not
  // labelled "json" is what used to drop it to a raw dump — losing the graph
  // in precisely the case that has real timings. parsePlan throws when there
  // is genuinely nothing to draw, and then the raw view is correct.
  const parsed = useMemo<ParsedPlan | null>(() => {
    try { return parsePlan(data.engine, data.content); }
    catch { return null; }
  }, [data]);

  const model = useMemo(() => (parsed ? buildCostModel(parsed) : null), [parsed]);

  // Every plan that parses becomes a run record; the current data's record.
  const current = useMemo(
    () => (parsed && model ? makeRun(data.sql, parsed, model, data.at ?? 0) : null),
    [parsed, model, data]);

  // Commit the current run to the tab's history once per `data`. An EFFECT,
  // not render: the list is the parent's state, and a parent setState during a
  // child's render is the "cannot update a component while rendering" warning.
  // The display series below does not wait for the commit — it appends the
  // current run itself while the list does not have it yet.
  const runsRef = useRef(runs);
  runsRef.current = runs;
  const [baseline, setBaseline] = useState<number | null>(null);
  useEffect(() => {
    if (!current) return;
    const list = runsRef.current;
    // Dedupe by (shape key, timestamp, text): reopening the same plan remounts
    // this view, and a remount must not record the run a second time.
    if (list.some(r => r.key === current.key && r.at === current.at && r.sql === current.sql)) return;
    const next = pushRun(list, current);
    const mine = seriesFor(next, current.key);
    onRecordRuns(next);
    // Default to the previous run — "did my last change help?" is the question.
    setBaseline(mine.length >= 2 ? mine.length - 2 : null);
  }, [current, onRecordRuns]);

  // The runs comparable with this statement (its shape key), the just-opened
  // plan included even before the commit above lands.
  const series = useMemo(() => {
    if (!current) return [];
    const mine = seriesFor(runs, current.key);
    return mine.some(r => r.at === current.at && r.sql === current.sql) ? mine : [...mine, current];
  }, [runs, current]);

  // ── MySQL statement profiler ──
  const canProfile = supportsProfiling(data.engine) && !!sessionId;
  const [stages, setStages] = useState<ProfileStage[] | null>(null);
  const [profiling, setProfiling] = useState(false);
  const [profileError, setProfileError] = useState<string | null>(null);

  const runProfile = useCallback(async () => {
    if (!canProfile) return;
    setProfiling(true);
    setProfileError(null);
    setStages(null);
    try {
      // Profiling is per-session and per-statement: the profile only exists on
      // the connection that just ran the query, so all three run in order on
      // the same session.
      await invoke('monitor_query', { sessionId, sql: ENABLE_SQL });
      await invoke('monitor_query', { sessionId, sql: data.sql });
      const res = await invoke<QueryResult>('monitor_query', { sessionId, sql: PROFILE_SQL });
      setStages(parseProfile(res.rows));
    } catch (e) {
      setProfileError(errorDisplay(e));
    } finally {
      setProfiling(false);
    }
  }, [canProfile, sessionId, data.sql]);

  const [changedOnly, setChangedOnly] = useState(true);
  const diff = useMemo(
    () => (baseline !== null && current && series[baseline]
      ? diffRuns(series[baseline], current) : null),
    [series, baseline, current]);

  // The node-level diff, which `diffRuns` cannot give: it matches on
  // `kind|op|relation` and so reports a re-indexed scan as one removal plus one
  // addition. `diffPlans` pairs on the index too, keeps the tree, and names the
  // access-path change outright.
  const treeDiff = useMemo(
    () => (baseline !== null && current && series[baseline]
      ? diffPlans(series[baseline].plan, current.plan) : null),
    [series, baseline, current]);
  const treeRows = useMemo(
    () => (treeDiff ? flattenDiff(treeDiff.root, changedOnly) : []),
    [treeDiff, changedOnly]);
  // Access-path changes are lifted out of the tree because they are the answer
  // to the question people came with, and hunting for them down an indented
  // list is the work this view exists to avoid.
  const accessChanges = useMemo(
    () => (treeDiff ? flattenDiff(treeDiff.root, true).filter(n => n.accessChange) : []),
    [treeDiff]);

  // One statement, more than one plan — the mechanism Datadog's database
  // monitoring uses. Computed from the series rather than the current run,
  // because a single plan is never evidence of anything.
  const instability = useMemo(() => detectInstability(series), [series]);

  const findings = useMemo(() => (model ? allFindings(model) : []), [model]);
  // Plan STABILITY is a property of the query's shape, not of this run — so it
  // is computed from the SQL and shown even when the plan itself looks fine.
  // The plan you are looking at is not the one that will page you.
  const stability = useMemo(() => analyseStability(data.sql), [data.sql]);

  // A new plan invalidates the old selection — path "0.1.0" addresses a
  // different node in a different tree. Adjusted during render rather than in
  // an effect, so the stale selection never gets painted for one frame first.
  const [prevData, setPrevData] = useState(data);
  if (prevData !== data) {
    setPrevData(data);
    setSelected(null);
  }

  async function copyRaw() {
    try {
      await copyToClipboard(data.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard unavailable */ }
  }

  // The graph view renders a live <svg> (.plan-svg); the icicle/tree views do
  // not, so image export is only offered there. The node paints through CSS
  // classes absent from a detached file, so liveSvgToString bakes them in.
  const rootRef = useRef<HTMLDivElement>(null);
  const [exporting, setExporting] = useState(false);

  async function exportGraph(kind: 'svg' | 'png') {
    const svgEl = rootRef.current?.querySelector('.plan-svg');
    if (!svgEl) return;
    setExporting(true);
    try {
      const svg = liveSvgToString(svgEl as SVGSVGElement, {
        background: themeFromDocument(rootRef.current).bg,
        title: 'Query execution plan',
      });
      if (kind === 'svg') downloadSvg(svg, 'query-plan.svg');
      else downloadBlob(await svgToPng(svg), 'query-plan.png');
    } catch { /* export unavailable */ }
    finally { setExporting(false); }
  }

  function toggle(path: string) {
    setCollapsed(prev => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path); else next.add(path);
      return next;
    });
  }

  const rows = parsed ? flatten(parsed.root, collapsed) : [];
  const selectedEntry = selected && model ? model.byPath.get(selected) : undefined;
  const worst = model?.ranked[0];
  const criticals = findings.filter(f => f.finding.level === 'critical').length;

  return (
    <div className="plan-view" ref={rootRef}>
      <div className="plan-toolbar">
        <span className="plan-badge">{data.engine} · {
          data.engine === 'clickhouse'
            ? `EXPLAIN ${(CH_EXPLAIN_MODES.find(m => m.id === (data.mode ?? 'indexes'))?.label ?? 'indexes').toUpperCase()}`
            : data.analyzed ? 'EXPLAIN ANALYZE' : 'EXPLAIN'
        }</span>
        {parsed?.summary && <span className="plan-summary">{parsed.summary}</span>}
        <div style={{ flex: 1 }} />
        {parsed && (
          <div className="plan-views" role="tablist" aria-label="Plan view">
            {VIEWS.map(v => (
              <button
                key={v}
                role="tab"
                aria-selected={view === v}
                className={`plan-view-tab${view === v ? ' active' : ''}`}
                onClick={() => pickView(v)}
              >{VIEW_LABELS[v]}</button>
            ))}
          </div>
        )}
        {data.engine === 'clickhouse' && onMode && (
          <div className="plan-views" role="tablist" aria-label="ClickHouse EXPLAIN kind">
            {CH_EXPLAIN_MODES.map(m => (
              <button
                key={m.id}
                role="tab"
                aria-selected={(data.mode ?? 'indexes') === m.id}
                className={`plan-view-tab${(data.mode ?? 'indexes') === m.id ? ' active' : ''}`}
                title={m.title}
                onClick={() => onMode(m.id)}
              >{m.label}</button>
            ))}
          </div>
        )}
        {data.engine !== 'clickhouse' && !data.analyzed && onAnalyze && (
          <button
            className="toolbar-btn plan-analyze-btn"
            title="Re-run with EXPLAIN ANALYZE — this executes the query"
            onClick={onAnalyze}
          >Analyze (runs query)</button>
        )}
        {view === 'graph' && (
          <>
            <button className="toolbar-btn" title="Download the plan graph as an SVG"
              onClick={() => void exportGraph('svg')} disabled={exporting}>SVG</button>
            <button className="toolbar-btn" title="Download the plan graph as a PNG"
              onClick={() => void exportGraph('png')} disabled={exporting}>PNG</button>
          </>
        )}
        <button className="toolbar-btn" onClick={copyRaw}>{copied ? 'Copied ✓' : 'Copy raw'}</button>
      </div>

      {/* The measured-vs-estimated banner. Never suppressed: the one time it is
          not shown is the one time somebody reads an estimate as a measurement. */}
      {parsed && model && data.engine === 'clickhouse' ? (
        // ClickHouse EXPLAIN executes nothing and has no cost model — calling
        // its structure "estimated" would import a distinction that does not
        // exist there. What it does carry are real read counts.
        <div className="plan-basis plan-basis-estimated">
          <b>Structural.</b> ClickHouse reports the plan&rsquo;s shape, not a cost
          model — there are no estimated costs or timings, and the query was not
          executed. Part and granule counts under Indexes are real counts of what
          the scan will read.
        </div>
      ) : parsed && model && (
        <div className={`plan-basis plan-basis-${model.measured ? 'measured' : 'estimated'}`}>
          {model.measured ? (
            <>
              <b>Measured.</b> Times are real, from an executed run
              {parsed.totalMs !== undefined && <> — {formatWeight(parsed.totalMs, 'time')} total</>}.
              Colour shows each step&rsquo;s share of the time.
            </>
          ) : (
            <>
              <b>Estimated.</b> Every number here is the optimiser&rsquo;s prediction, not a
              measurement — cost units are unitless and frequently wrong. Colour shows
              estimated cost.
              {onAnalyze && <> Run <b>Analyze</b> for real timings.</>}
            </>
          )}
          {worst && worst.weight > 0 && (
            <span className="plan-basis-worst">
              Hottest step: <b>{worst.node.op}</b>
              {worst.node.stats.relation ? ` on ${worst.node.stats.relation}` : ''}
              {' — '}{formatWeight(worst.weight, model.basis)}
              {worst.share > 0.005 && ` (${Math.round(worst.share * 100)}%)`}
            </span>
          )}
          {criticals > 0 && (
            <span className="plan-basis-alert">
              {criticals} critical finding{criticals === 1 ? '' : 's'}
            </span>
          )}
          {stability.risks.some(r => r.level === 'high') && (
            <span className="plan-basis-alert plan-basis-unstable"
                  title="This plan can change on a data or parameter shift">
              unstable plan risk
            </span>
          )}
        </div>
      )}

      {!parsed ? (
        <pre className="plan-text">{data.content}</pre>
      ) : view === 'profile' ? (
        <div className="plan-prof">
          {!canProfile ? (
            <div className="plan-empty">
              Statement profiling uses MySQL&rsquo;s <code>SHOW PROFILE</code> and is
              MySQL-only. On PostgreSQL, <b>EXPLAIN ANALYZE</b> already reports per-node
              timings — use the Graph view.
            </div>
          ) : (<>
            <div className="plan-prof-bar">
              <button className="primary" onClick={runProfile} disabled={profiling}>
                {profiling ? 'Profiling…' : stages ? 'Profile again' : '▶ Profile'}
              </button>
              <span className="plan-prof-warn">
                This <b>runs the statement</b> to measure it.
              </span>
              {stages && (
                <span className="plan-prof-total">
                  {formatSeconds(profileTotal(stages))} total
                </span>
              )}
            </div>

            {profileError && (
              <div className="plan-cmp-why">
                <StatusIcon kind="error" /> {profileError}
              </div>
            )}

            {stages && stages.length === 0 && (
              <div className="plan-empty">
                The profile came back empty — the server may have profiling disabled,
                or the statement returned before anything was measured.
              </div>
            )}

            {stages && stages.length > 0 && (<>
              {profileFindings(stages).map(f => (
                <div key={f.state} className="plan-prof-finding">
                  <div className="plan-prof-finding-head">
                    <b>{f.state}</b> — {Math.round(f.share * 100)}% of the statement
                  </div>
                  <p>{f.what}</p>
                  <p className="plan-prof-action">{f.concern}</p>
                </div>
              ))}

              <div className="plan-prof-stages">
                {stages.map(s2 => {
                  const m = meaningOf(s2.state);
                  return (
                    <div key={s2.state} className="plan-prof-stage" title={m?.what}>
                      <span className="plan-prof-name">{s2.state}</span>
                      <span className="plan-prof-bar-outer">
                        <span
                          className={`plan-prof-bar-fill${s2.share >= 0.3 ? ' hot' : ''}`}
                          style={{ width: `${Math.max(1, s2.share * 100)}%` }}
                        />
                      </span>
                      <span className="plan-prof-secs">{formatSeconds(s2.seconds)}</span>
                      <span className="plan-prof-pct">{Math.round(s2.share * 100)}%</span>
                    </div>
                  );
                })}
              </div>
            </>)}
          </>)}
        </div>
      ) : view === 'raw' ? (
        <pre className="plan-text">{data.content}</pre>
      ) : view === 'compare' ? (
        <div className="plan-compare">
          {series.length < 2 ? (
            <div className="plan-empty">
              Only one run of this statement so far. Run it again — after an index,
              a rewrite, or a change to the data — and this compares the two.
              <br /><br />
              Runs are grouped by the <b>shape</b> of the statement, so changing a
              literal keeps the series while changing the query starts a new one.
              History is kept for this session only.
            </div>
          ) : (<>
            <div className="plan-cmp-bar">
              <span>Compare with</span>
              <select
                value={baseline ?? ''}
                onChange={e => setBaseline(e.target.value === '' ? null : Number(e.target.value))}
              >
                {series.slice(0, -1).map((r, i) => (
                  <option key={i} value={i}>
                    run {i + 1} · {new Date(r.at).toLocaleTimeString()}
                    {r.measured ? '' : ' (estimated)'}
                  </option>
                ))}
              </select>
              <span className="plan-cmp-count">{series.length} runs recorded</span>
            </div>

            {diff && (
              <div className={`plan-verdict ${!diff.comparable ? 'nope'
                : diff.totalRatio < -0.05 ? 'better'
                : diff.totalRatio > 0.05 ? 'worse' : 'same'}`}>
                <StatusIconFor diff={diff} />
                <b>{verdict(diff)}</b>
                {diff.comparable && (
                  <span className="plan-cmp-nums">
                    {formatWeight(diff.before.totalWeight, diff.before.basis)}
                    {' → '}
                    {formatWeight(diff.after.totalWeight, diff.after.basis)}
                  </span>
                )}
              </div>
            )}

            {diff && !diff.comparable && (
              <div className="plan-cmp-why">{diff.incomparable}</div>
            )}

            {/* The totals compared fine but the trees refused (a measured plan
                against an estimated one can pass diffRuns on a shared basis yet
                fail diffPlans) — say so rather than rendering an empty table. */}
            {diff?.comparable && treeDiff && !treeDiff.comparable && (
              <div className="plan-cmp-why">
                {treeDiff.incomparableReason ?? 'These two plans cannot be compared.'}
              </div>
            )}

            {/* One statement producing several plans. Shown above the diff,
                because it reframes it: comparing two runs is only meaningful
                once you know whether you are comparing two plans or one plan
                twice. */}
            {instability.unstable && (
              <div className="plan-unstable">
                <div className="plan-unstable-h">
                  <StatusIcon kind={instability.spread && instability.spread >= 3 ? 'error' : 'pending'} />
                  <b>
                    This statement has produced {instability.variants.length} different
                    execution plans in this session.
                  </b>
                  {instability.spread !== undefined && (
                    <span className="plan-cmp-nums">
                      slowest is {instability.spread.toFixed(1)}× the fastest
                    </span>
                  )}
                </div>
                <div className="plan-unstable-rows">
                  {instability.variants.map((v, i) => (
                    <button
                      key={v.fingerprint}
                      type="button"
                      className={`plan-variant ${v.runs.includes(baseline ?? -1) ? 'is-baseline' : ''}`}
                      // Selecting a variant compares against its most recent
                      // run — the useful pairing is this plan against that one.
                      onClick={() => setBaseline(v.runs[v.runs.length - 1])}
                      disabled={v.runs[v.runs.length - 1] === series.length - 1}
                      title="Compare the current run against this plan"
                    >
                      <span className="plan-variant-n">plan {i + 1}</span>
                      <span className="plan-detail">
                        {v.runs.length} {v.runs.length === 1 ? 'run' : 'runs'}
                      </span>
                      <span className="plan-cmp-nums">
                        median {formatWeight(v.medianWeight, v.basis)}
                      </span>
                    </button>
                  ))}
                </div>
                <div className="plan-unstable-note">
                  The query did not change; the optimiser chose differently. This is what
                  “it was fast yesterday” usually means. Only runs from this session are
                  counted — seeing one plan here is not evidence that a statement is stable,
                  only that it has not flipped while you were watching.
                </div>
              </div>
            )}

            {diff?.comparable && treeDiff?.comparable && (<>
              {accessChanges.length > 0 && (
                <div className="plan-cmp-access">
                  <div className="plan-cmp-access-h">What changed in the access path</div>
                  {accessChanges.map((n, i) => (
                    <div key={i} className="plan-cmp-access-row">
                      <span className="plan-op-name">{n.op}</span>
                      {(n.after ?? n.before)?.stats.relation && (
                        <span className="plan-detail">{(n.after ?? n.before)!.stats.relation}</span>
                      )}
                      <span className="plan-cmp-access-what">{n.accessChange}</span>
                    </div>
                  ))}
                </div>
              )}

              <div className="plan-cmp-bar">
                <label className="plan-cmp-only">
                  <input
                    type="checkbox"
                    checked={changedOnly}
                    onChange={e => setChangedOnly(e.target.checked)}
                  />
                  Only steps that changed
                </label>
                <span className="plan-cmp-count">
                  {treeDiff.changed} changed · {treeDiff.added} added · {treeDiff.removed} removed
                </span>
              </div>

              <div className="scroller plan-cmp-table">
                {treeRows.length === 0 ? (
                  <div className="plan-empty">
                    The two plans are the same shape. Any difference is in timing alone.
                  </div>
                ) : (
                  <table className="plan-table">
                    <thead>
                      <tr>
                        <th className="plan-op-h">Step</th>
                        <th className="plan-op-h">Change</th>
                        <th className="plan-num-h">Before</th>
                        <th className="plan-num-h">After</th>
                        <th className="plan-num-h">Δ</th>
                      </tr>
                    </thead>
                    <tbody>
                      {treeRows.map((n, i) => (
                        <tr key={i} className={`cmp-${n.status}`}>
                          {/* Indented by depth: a flat list loses where in the
                              plan a step sits, which is most of what a plan says. */}
                          <td className="plan-op" style={{ paddingLeft: 8 + n.depth * 14 }}>
                            <span className="cmp-badge">{
                              n.status === 'added' ? '+'
                                : n.status === 'removed' ? '−'
                                : n.status === 'changed' ? '±' : ''
                            }</span>
                            <span className="plan-op-name">{n.op}</span>
                            {(n.after ?? n.before)?.stats.relation && (
                              <span className="plan-detail">{(n.after ?? n.before)!.stats.relation}</span>
                            )}
                          </td>
                          <td className="plan-detail">{n.accessChange ?? ''}</td>
                          <td className="plan-num">{metricCell(n, 'before')}</td>
                          <td className="plan-num">{metricCell(n, 'after')}</td>
                          <td className={`plan-num ${deltaClass(n)}`}>{metricCell(n, 'delta')}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </>)}
          </>)}
        </div>
      ) : (
        <div className="plan-body">
          <div className="plan-main">
            {view === 'tree' ? (
              <div className="plan-scroll">
                <table className="plan-table">
                  <thead>
                    <tr>
                      <th className="plan-op-h">Operation</th>
                      {parsed.metricColumns.map(c => <th key={c} className="plan-num-h">{c}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map(({ node, depth, path, hasKids }) => (
                      <tr
                        key={path}
                        className={`${severityClass(node.severity)}${selected === path ? ' plan-row-sel' : ''}`}
                        onClick={() => setSelected(selected === path ? null : path)}
                      >
                        <td className="plan-op">
                          <span style={{ paddingLeft: depth * 18 }} />
                          {hasKids ? (
                            <button
                              className="plan-toggle"
                              onClick={e => { e.stopPropagation(); toggle(path); }}
                            >{collapsed.has(path) ? '▸' : '▾'}</button>
                          ) : (
                            <span className="plan-toggle-spacer" />
                          )}
                          <span className="plan-op-name">{node.op}</span>
                          {node.detail && <span className="plan-detail">{node.detail}</span>}
                        </td>
                        {parsed.metricColumns.map(c => (
                          <td key={c} className="plan-num">{node.metrics[c] ?? ''}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              model && (
                <PlanGraph
                  plan={parsed}
                  model={model}
                  mode={view === 'icicle' ? 'icicle' : 'graph'}
                  selected={selected}
                  onSelect={setSelected}
                />
              )
            )}
          </div>

          {selectedEntry && model && (
            <PlanNodeDetail
              entry={selectedEntry}
              model={model}
              onClose={() => setSelected(null)}
            />
          )}
          {!selectedEntry && stability.risks.length > 0 && findings.length === 0 && (
            <StabilityAside stability={stability} />
          )}
          {!selectedEntry && findings.length > 0 && (
            <aside className="plan-inspector plan-inspector-summary">
              <div className="plan-insp-head">
                <div><h4>Findings</h4>
                  <p className="plan-insp-kind">{findings.length} across this plan</p></div>
              </div>
              {findings.slice(0, 8).map(({ entry, finding }, i) => (
                <button
                  key={i}
                  className={`plan-finding plan-finding-link lvl-${finding.level}`}
                  onClick={() => setSelected(entry.path)}
                >
                  <div className="plan-finding-badge">{finding.badge}</div>
                  <p className="plan-finding-observed">
                    <b>{entry.node.op}</b> — {finding.observed}
                  </p>
                </button>
              ))}
              <p className="plan-insp-hint">Select any node for its full explanation.</p>
              {stability.risks.length > 0 && <StabilitySection stability={stability} />}
            </aside>
          )}
        </div>
      )}
    </div>
  );
}

/** The verdict's mark — shape as well as colour. */
function StatusIconFor({ diff }: { diff: { comparable: boolean; totalRatio: number } }) {
  if (!diff.comparable) return <StatusIcon kind="error" />;
  if (diff.totalRatio < -0.05) return <StatusIcon kind="ok" />;
  if (diff.totalRatio > 0.05) return <StatusIcon kind="error" />;
  return <StatusIcon kind="skipped" />;
}

/** The stability report as its own aside, when there are no plan findings. */
function StabilityAside({ stability }: { stability: ReturnType<typeof analyseStability> }) {
  return (
    <aside className="plan-inspector plan-inspector-summary">
      <div className="plan-insp-head">
        <div>
          <h4>Plan stability</h4>
          <p className="plan-insp-kind">will this plan hold?</p>
        </div>
      </div>
      <StabilitySection stability={stability} />
    </aside>
  );
}

/**
 * Why this sits beside the plan rather than inside it: the plan on screen is
 * the one that ran. Stability is about the plan that has not happened yet.
 */
function StabilitySection({ stability }: { stability: ReturnType<typeof analyseStability> }) {
  return (
    <section className="plan-stab">
      <h5>Plan stability</h5>
      <div className={`plan-stab-score s-${
        stability.score >= 85 ? 'good' : stability.score >= 55 ? 'mid' : 'bad'}`}>
        <b>{stability.score}</b><span>/ 100</span>
        <em>{stability.verdict}</em>
      </div>
      {rankRisks(stability.risks).map(r => (
        <details key={r.id} className={`plan-stab-risk lvl-${r.level}`}>
          <summary>
            <span className="plan-stab-badge">{r.badge}</span>
            {r.title}
          </summary>
          <p className="plan-stab-observed">{r.observed}</p>
          <p><b>Why the plan can flip.</b> {r.why}</p>
          <p><b>What to do.</b> {r.action}</p>
        </details>
      ))}
    </section>
  );
}
