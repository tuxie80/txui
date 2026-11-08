import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { Session } from '../types';
import { safeOperationUnavailableReason } from '../utils/operationSupport';
import { errorDisplay } from '../utils/appError';
import { benchmarkVerdict } from '../utils/benchmark';
import { correlatePlanEvidence } from '../utils/planCorrelation';
import type { PlanCorrelation } from '../utils/planCorrelation';
import { renderQueryLabReport } from '../utils/queryLabReport';
import { buildQueryLabMigrationHandoff } from '../utils/queryLabMigration';
import { saveTextAs } from '../utils/exportersIo';
import {
  createDefaultQueryLabExperiment, parseQueryLabExperiment, queryLabIndexEvidenceMode,
  queryLabSpecSha256, validateQueryLabExperiment,
} from '../utils/queryLabSpec';
import type {
  NormalizedQueryLabExperiment, QueryLabCandidate, QueryLabEvidenceRequirements,
  QueryLabExperiment, QueryLabParameterKind,
} from '../utils/queryLabSpec';
import type { MigrationScratchRecord } from '../utils/migrationPreflight';
import { StatusIcon } from './StatusIcon';

interface QueryLabPlanEvidence {
  label: string;
  format: string;
  content: string;
  elapsed_ms: number;
  elapsed_us?: number | null;
}

function planElapsedMs(plan: QueryLabPlanEvidence): number {
  return plan.elapsed_us !== undefined && plan.elapsed_us !== null ? plan.elapsed_us / 1000 : plan.elapsed_ms;
}

function planElapsedLabel(plan: QueryLabPlanEvidence): string {
  return plan.elapsed_us !== undefined && plan.elapsed_us !== null ? `${plan.elapsed_us} µs` : `${plan.elapsed_ms} ms`;
}

interface QueryLabBaselineResponse {
  run_key: string;
  spec_sha256: string;
  execution_mode: 'estimate' | 'measured';
  database: string;
  engine: string;
  version: string;
  backend_id: number;
  timeout_ms: number;
  estimated_plan: QueryLabPlanEvidence;
  measured_plan: QueryLabPlanEvidence | null;
  index_evidence_mode: 'none' | 'hypothetical' | 'real';
  comparison_policy: string;
  cost_estimates: boolean;
  settings: { name: string; value: string | null }[];
  cache_observations: string[];
  cleanup: { timeout_restored: boolean; connection_closed: boolean; hypopg_reset?: boolean | null };
}

interface QueryLabHypopgResponse {
  run_key: string;
  spec_sha256: string;
  candidate_id: string;
  backend_id: number;
  baseline_plan: QueryLabPlanEvidence;
  candidate_plan: QueryLabPlanEvidence;
  created_index_names: string[];
  used_index_names: string[];
  baseline_cost: number | null;
  candidate_cost: number | null;
  absolute_delta: number | null;
  percent_delta: number | null;
  index_used: boolean;
  verdict: 'not_used' | 'lower_estimated_cost' | 'higher_estimated_cost' | 'unchanged';
  comparison_policy: string;
  cleanup: { timeout_restored: boolean; connection_closed: boolean; hypopg_reset: boolean | null };
}

interface QueryLabRealIndexResponse {
  run_key: string;
  spec_sha256: string;
  candidate_id: string;
  scratch_run_key: string;
  scratch_database: string;
  backend_id: number;
  index_name: string;
  index_build_ms: number;
  baseline_plan: QueryLabPlanEvidence;
  candidate_plan: QueryLabPlanEvidence;
  index_used: boolean;
  comparison_policy: string;
  cleanup: { index_dropped: boolean; scratch_dropped: boolean; timeout_restored: boolean; connection_closed: boolean };
}

interface QueryLabRewriteResponse {
  run_key: string;
  spec_sha256: string;
  candidate_id: string;
  backend_id: number;
  correctness: 'equal' | 'different' | 'unverified';
  reason: string | null;
  row_order_policy: 'ordered' | 'multiset';
  max_rows: number;
  max_bytes: number;
  baseline: QueryLabRewriteEvidence;
  candidate: QueryLabRewriteEvidence;
  cleanup: { timeout_restored: boolean; connection_closed: boolean };
}

interface QueryLabRewriteEvidence {
  columns: { name: string; type_name: string }[];
  rows_observed: number;
  bytes_observed: number;
  sha256: string | null;
  complete: boolean;
  unverified_reason: string | null;
}

interface QueryLabBenchmarkResponse {
  run_key: string;
  spec_sha256: string;
  candidate_id: string;
  backend_id: number;
  warmup_runs: number;
  repetitions: number;
  pairs: { repetition: number; order: 'baseline_first' | 'candidate_first'; baseline_ms: number; candidate_ms: number }[];
  baseline_ms: number[];
  candidate_ms: number[];
  baseline: QueryLabTimingSummary;
  candidate: QueryLabTimingSummary;
  baseline_sha256: string | null;
  candidate_sha256: string | null;
  cleanup: { timeout_restored: boolean; connection_closed: boolean };
}

interface QueryLabTimingSummary {
  count: number;
  min_ms: number;
  median_ms: number;
  p95_ms: number;
  max_ms: number;
}

function PlanCorrelationEvidence({ correlation }: { correlation: PlanCorrelation }) {
  return <div className="sqp-f-evidence">
    <h4>Plan correlation · {correlation.headline}</h4>
    {!correlation.comparable && <p className="dv-desc">{correlation.reason}</p>}
    {correlation.runtime && <p className="dv-desc">Runtime: {correlation.runtime.baselineMs} ms → {correlation.runtime.candidateMs} ms · delta {correlation.runtime.deltaMs} ms ({correlation.runtime.improvementPct ?? 'not available'}%).</p>}
    <p className="dv-desc">Plan diff: {correlation.diff.changed} changed · {correlation.diff.added} added · {correlation.diff.removed} removed.</p>
    {(['baseline', 'candidate'] as const).map(kind => {
      const evidence = correlation[kind];
      return <p className="dv-desc" key={kind}>
        {kind}: cardinality {evidence.cardinality
          ? `${evidence.cardinality.factor}× ${evidence.cardinality.direction} at ${evidence.cardinality.operation} (${evidence.cardinality.estimatedRowsPerLoop} → ${evidence.cardinality.actualRowsPerLoop} rows/loop)`
          : 'not available'} · buffers {evidence.buffers
          ? `${evidence.buffers.hit} hit / ${evidence.buffers.read} read at ${evidence.buffers.operation}`
          : 'not available'} · spills {evidence.spills.length ? evidence.spills.join(', ') : 'none reported'}.
      </p>;
    })}
  </div>;
}

interface Props {
  session: Session;
  schema?: string | null;
  onClose: () => void;
}

export function QueryLabPanel({ session, schema, onClose }: Props) {
  const unavailable = safeOperationUnavailableReason(session.engine, 'querylab');
  const [experiment, setExperiment] = useState<QueryLabExperiment>(() => createDefaultQueryLabExperiment({
    engine: session.engine === 'postgres' ? 'postgres' : 'mysql',
    database: schema || 'shop',
    sessionId: session.sessionId,
    connectionId: session.connectionId,
    environment: session.environment,
    readOnly: session.readOnly,
  }));
  const [validated, setValidated] = useState<NormalizedQueryLabExperiment | null>(null);
  const [workspace, setWorkspace] = useState<'query' | 'candidates' | 'run'>('query');
  const [baseline, setBaseline] = useState<QueryLabBaselineResponse | null>(null);
  const [baselineRunning, setBaselineRunning] = useState(false);
  const [baselineError, setBaselineError] = useState<string | null>(null);
  const [hypopg, setHypopg] = useState<QueryLabHypopgResponse | null>(null);
  const [hypopgRunning, setHypopgRunning] = useState(false);
  const [hypopgError, setHypopgError] = useState<string | null>(null);
  const [scratchRecords, setScratchRecords] = useState<MigrationScratchRecord[]>([]);
  const [scratchError, setScratchError] = useState<string | null>(null);
  const [realIndex, setRealIndex] = useState<QueryLabRealIndexResponse | null>(null);
  const [realIndexRunning, setRealIndexRunning] = useState(false);
  const [realIndexCancelling, setRealIndexCancelling] = useState(false);
  const [realIndexError, setRealIndexError] = useState<string | null>(null);
  const [rewrite, setRewrite] = useState<QueryLabRewriteResponse | null>(null);
  const [rewriteRunning, setRewriteRunning] = useState(false);
  const [rewriteCancelling, setRewriteCancelling] = useState(false);
  const [rewriteError, setRewriteError] = useState<string | null>(null);
  const [benchmark, setBenchmark] = useState<QueryLabBenchmarkResponse | null>(null);
  const [benchmarkRunning, setBenchmarkRunning] = useState(false);
  const [benchmarkCancelling, setBenchmarkCancelling] = useState(false);
  const [benchmarkError, setBenchmarkError] = useState<string | null>(null);
  const [reportStatus, setReportStatus] = useState<string | null>(null);
  const benchmarkRunKey = useRef<string | null>(null);
  const realRunKey = useRef<string | null>(null);
  const rewriteRunKey = useRef<string | null>(null);
  const errors = useMemo(() => validateQueryLabExperiment(experiment), [experiment]);
  const specHash = useMemo(() => queryLabSpecSha256(experiment), [experiment]);
  const specHashRef = useRef(specHash);
  specHashRef.current = specHash;
  const benchmarkAssessment = useMemo(() => benchmark ? benchmarkVerdict({
    baselineMs: benchmark.baseline_ms,
    candidateMs: benchmark.candidate_ms,
    baselineSha256: benchmark.baseline_sha256,
    candidateSha256: benchmark.candidate_sha256,
    improvementThresholdPct: experiment.improvementThresholdPct,
    candidateKind: 'rewrite',
  }) : null, [benchmark, experiment.improvementThresholdPct]);
  const realIndexAssessment = useMemo(() => realIndex ? benchmarkVerdict({
    baselineMs: [planElapsedMs(realIndex.baseline_plan)],
    candidateMs: [planElapsedMs(realIndex.candidate_plan)],
    baselineSha256: realIndex.spec_sha256,
    candidateSha256: realIndex.spec_sha256,
    improvementThresholdPct: experiment.improvementThresholdPct,
    candidateKind: 'index',
    indexUsed: realIndex.index_used,
  }) : null, [realIndex, experiment.improvementThresholdPct]);
  const realIndexCorrelation = useMemo(() => realIndex ? correlatePlanEvidence({
    engine: experiment.engine,
    baselinePlan: realIndex.baseline_plan.content,
    candidatePlan: realIndex.candidate_plan.content,
    baselineMs: planElapsedMs(realIndex.baseline_plan),
    candidateMs: planElapsedMs(realIndex.candidate_plan),
  }) : null, [realIndex, experiment.engine]);
  const hypopgCorrelation = useMemo(() => hypopg ? correlatePlanEvidence({
    engine: 'postgres',
    baselinePlan: hypopg.baseline_plan.content,
    candidatePlan: hypopg.candidate_plan.content,
  }) : null, [hypopg]);

  const refreshScratch = useCallback(async () => {
    try {
      setScratchRecords(await invoke<MigrationScratchRecord[]>('migration_scratch_list'));
    } catch (error) {
      setScratchError(errorDisplay(error));
    }
  }, []);
  useEffect(() => { void refreshScratch(); }, [refreshScratch]);

  const patch = (change: (current: QueryLabExperiment) => QueryLabExperiment) => {
    setExperiment(change);
    setValidated(null);
    setBaseline(null);
    setBaselineError(null);
    setHypopg(null);
    setHypopgError(null);
    setRealIndex(null);
    setRealIndexError(null);
    setRewrite(null);
    setRewriteError(null);
    setBenchmark(null);
    setBenchmarkError(null);
  };
  const updateCandidate = (index: number, change: Partial<QueryLabCandidate>) => {
    patch(current => ({
      ...current,
      candidates: current.candidates.map((candidate, at) => at === index
        ? { ...candidate, ...change } as QueryLabCandidate : candidate),
    }));
  };
  const changeCandidateKind = (index: number, kind: QueryLabCandidate['kind']) => {
    const id = experiment.candidates[index]?.id ?? `candidate-${index + 1}`;
    const candidate: QueryLabCandidate = kind === 'index'
      ? { id, kind, name: 'Candidate index', table: 'orders', columns: ['customer_id'], unique: false, where: null }
      : kind === 'rewrite'
        ? { id, kind, name: 'Candidate rewrite', sql: experiment.originalSql }
        : { id, kind, name: 'work_mem', value: '64MB' };
    patch(current => ({ ...current, candidates: current.candidates.map((current, at) => at === index ? candidate : current) }));
  };
  const updateEvidence = (key: keyof QueryLabEvidenceRequirements, value: boolean) => {
    patch(current => ({ ...current, evidence: { ...current.evidence, [key]: value } }));
  };
  const validate = () => {
    setWorkspace('run');
    const parsed = parseQueryLabExperiment(experiment);
    setValidated(parsed.ok ? parsed.experiment : null);
    setBaseline(null);
    setBaselineError(null);
    setHypopg(null);
    setHypopgError(null);
    setRealIndex(null);
    setRealIndexError(null);
    setRewrite(null);
    setRewriteError(null);
    setBenchmark(null);
    setBenchmarkError(null);
  };
  const baselinePayload = (normalized: NormalizedQueryLabExperiment, runKey: string) => ({
    session_id: normalized.scratch?.sessionId ?? session.sessionId,
    connection_id: normalized.scratch?.connectionId ?? session.connectionId,
    run_key: runKey, engine: normalized.engine,
    database: normalized.database, sql: normalized.resolvedSql, spec_sha256: specHash,
    execution_mode: normalized.executionMode, timeout_ms: normalized.timeoutMs,
    index_evidence_mode: queryLabIndexEvidenceMode(normalized.executionMode, normalized.candidates),
    evidence: {
      plan: normalized.evidence.plan, cost: normalized.evidence.cost,
      timing: normalized.evidence.timing, buffers: normalized.evidence.buffers,
      result_equality: normalized.evidence.resultEquality,
    },
    has_rewrite_candidate: normalized.candidates.some(candidate => candidate.kind === 'rewrite'),
    scratch: normalized.scratch ? {
      session_id: normalized.scratch.sessionId,
      connection_id: normalized.scratch.connectionId,
      database: normalized.scratch.database,
      environment: normalized.scratch.environment,
      read_only: normalized.scratch.readOnly,
      run_key: normalized.scratch.runKey,
    } : null,
  });
  const captureBaseline = async () => {
    if (!validated || baselineRunning) return;
    setBaselineRunning(true);
    setBaselineError(null);
    setBaseline(null);
    try {
      const response = await invoke<QueryLabBaselineResponse>('query_lab_baseline', {
        input: baselinePayload(validated, crypto.randomUUID()),
      });
      setBaseline(response);
    } catch (error) {
      setBaselineError(errorDisplay(error));
    } finally {
      setBaselineRunning(false);
    }
  };
  const captureHypopg = async () => {
    const candidate = validated?.candidates.find(candidate => candidate.kind === 'index');
    if (!validated || validated.executionMode !== 'estimate' || validated.engine !== 'postgres' || !candidate || hypopgRunning) return;
    setHypopgRunning(true);
    setHypopgError(null);
    setHypopg(null);
    try {
      const response = await invoke<QueryLabHypopgResponse>('query_lab_hypopg_estimate', {
        input: {
          session_id: validated.scratch?.sessionId ?? session.sessionId,
          connection_id: validated.scratch?.connectionId ?? session.connectionId,
          run_key: crypto.randomUUID(), database: validated.database,
          sql: validated.resolvedSql, spec_sha256: specHash,
          index_evidence_mode: 'hypothetical', timeout_ms: validated.timeoutMs,
          candidate: {
            id: candidate.id, name: candidate.name, table: candidate.table,
            columns: candidate.columns, unique: candidate.unique, where_clause: candidate.where,
          },
        },
      });
      setHypopg(response);
    } catch (error) {
      setHypopgError(errorDisplay(error));
    } finally {
      setHypopgRunning(false);
    }
  };
  const captureRealIndex = async () => {
    const candidate = validated?.candidates.find(candidate => candidate.kind === 'index');
    if (!validated || validated.executionMode !== 'measured' || !candidate || !validated.scratch?.runKey || realIndexRunning) return;
    const runKey = crypto.randomUUID();
    realRunKey.current = runKey;
    setRealIndexRunning(true);
    setRealIndexCancelling(false);
    setRealIndexError(null);
    setRealIndex(null);
    try {
      const response = await invoke<QueryLabRealIndexResponse>('query_lab_real_index_measure', {
        input: {
          baseline: baselinePayload(validated, runKey),
          candidate: {
            id: candidate.id, name: candidate.name, table: candidate.table,
            columns: candidate.columns, unique: candidate.unique, where_clause: candidate.where,
          },
        },
      });
      if (response.spec_sha256 !== specHashRef.current) {
        setRealIndexError('The experiment changed during execution; the stale result was discarded after backend cleanup.');
      } else {
        setRealIndex(response);
      }
    } catch (error) {
      setRealIndexError(errorDisplay(error));
    } finally {
      if (realRunKey.current === runKey) realRunKey.current = null;
      setRealIndexRunning(false);
      setRealIndexCancelling(false);
      await refreshScratch();
    }
  };
  const captureRewrite = async () => {
    const candidate = validated?.candidates.find(candidate => candidate.kind === 'rewrite');
    if (!validated || validated.executionMode !== 'measured' || !candidate || rewriteRunning) return;
    const runKey = crypto.randomUUID();
    rewriteRunKey.current = runKey;
    setRewriteRunning(true);
    setRewriteCancelling(false);
    setRewriteError(null);
    setRewrite(null);
    try {
      const response = await invoke<QueryLabRewriteResponse>('query_lab_rewrite_measure', {
        input: {
          baseline: baselinePayload(validated, runKey),
          candidate: { id: candidate.id, name: candidate.name, sql: candidate.sql },
          row_order_policy: validated.resultRowOrder,
          max_rows: validated.resultMaxRows,
          max_bytes: validated.resultMaxBytes,
        },
      });
      if (response.spec_sha256 !== specHashRef.current) {
        setRewriteError('The experiment changed during execution; the stale result was discarded after connection cleanup.');
      } else {
        setRewrite(response);
      }
    } catch (error) {
      setRewriteError(errorDisplay(error));
    } finally {
      if (rewriteRunKey.current === runKey) rewriteRunKey.current = null;
      setRewriteRunning(false);
      setRewriteCancelling(false);
    }
  };
  const captureBenchmark = async () => {
    const candidate = validated?.candidates.find(candidate => candidate.kind === 'rewrite');
    if (!validated || validated.executionMode !== 'measured' || !candidate || benchmarkRunning) return;
    const runKey = crypto.randomUUID();
    benchmarkRunKey.current = runKey;
    setBenchmarkRunning(true);
    setBenchmarkCancelling(false);
    setBenchmarkError(null);
    setBenchmark(null);
    try {
      const response = await invoke<QueryLabBenchmarkResponse>('query_lab_benchmark', {
        input: {
          rewrite: {
            baseline: baselinePayload(validated, runKey),
            candidate: { id: candidate.id, name: candidate.name, sql: candidate.sql },
            row_order_policy: validated.resultRowOrder,
            max_rows: validated.resultMaxRows,
            max_bytes: validated.resultMaxBytes,
          },
          warmup_runs: validated.warmupRuns,
          repetitions: validated.repetitions,
        },
      });
      if (response.spec_sha256 !== specHashRef.current) {
        setBenchmarkError('The experiment changed during benchmarking; the stale result was discarded after connection cleanup.');
      } else {
        setBenchmark(response);
      }
    } catch (error) {
      setBenchmarkError(errorDisplay(error));
    } finally {
      if (benchmarkRunKey.current === runKey) benchmarkRunKey.current = null;
      setBenchmarkRunning(false);
      setBenchmarkCancelling(false);
    }
  };
  const cleanupScratch = async (record: MigrationScratchRecord) => {
    setScratchError(null);
    try {
      await invoke('migration_rehearsal_cleanup', { runKey: record.run_key });
      await refreshScratch();
    } catch (error) {
      setScratchError(errorDisplay(error));
    }
  };
  const createMigration = () => {
    const candidate = validated?.candidates[0] ?? experiment.candidates[0];
    if (!candidate) return;
    try {
      const handoff = buildQueryLabMigrationHandoff({
        engine: experiment.engine,
        database: experiment.database,
        specSha256: specHash,
        mode: validated?.executionMode ?? experiment.executionMode,
        candidate,
        correctness: candidate.kind === 'rewrite' && rewrite?.correctness === 'equal' ? 'equal' : candidate.kind === 'rewrite' ? 'not_applicable' : 'not_applicable',
        verdict: benchmarkAssessment?.verdict ?? realIndexAssessment?.verdict ?? hypopg?.verdict ?? 'not_measured',
        indexUsed: candidate.kind === 'index' ? realIndex?.index_used ?? hypopg?.index_used ?? false : null,
      });
      window.dispatchEvent(new CustomEvent('dbgui:open-migration', { detail: handoff }));
      setReportStatus(`Migration handoff sent for ${candidate.id}; Migration Cockpit starts at Review with independent proof gates.`);
    } catch (error) {
      setReportStatus(errorDisplay(error));
    }
  };
  const exportReport = async () => {
    const candidate = validated?.candidates[0] ?? experiment.candidates[0];
    if (!candidate) return;
    try {
      const report = renderQueryLabReport({
        engine: experiment.engine,
        database: experiment.database,
        mode: validated?.executionMode ?? experiment.executionMode,
        specSha256: specHash,
        originalSql: validated?.resolvedSql ?? experiment.originalSql,
        candidate: { id: candidate.id, kind: candidate.kind, name: candidate.name, sql: candidate.kind === 'rewrite' ? candidate.sql : null },
        scratch: validated?.scratch ?? experiment.scratch,
        correctness: rewrite ? {
          status: rewrite.correctness,
          reason: rewrite.reason,
          rowOrder: rewrite.row_order_policy,
          maxRows: rewrite.max_rows,
          maxBytes: rewrite.max_bytes,
          baseline: { rows: rewrite.baseline.rows_observed, bytes: rewrite.baseline.bytes_observed, sha256: rewrite.baseline.sha256, complete: rewrite.baseline.complete, reason: rewrite.baseline.unverified_reason },
          candidate: { rows: rewrite.candidate.rows_observed, bytes: rewrite.candidate.bytes_observed, sha256: rewrite.candidate.sha256, complete: rewrite.candidate.complete, reason: rewrite.candidate.unverified_reason },
        } : null,
        verdict: benchmarkAssessment ?? realIndexAssessment,
        benchmark: benchmark ? {
          warmupRuns: benchmark.warmup_runs,
          repetitions: benchmark.repetitions,
          pairs: benchmark.pairs,
          baselineMs: benchmark.baseline_ms,
          candidateMs: benchmark.candidate_ms,
          baseline: {
            count: benchmark.baseline.count, minMs: benchmark.baseline.min_ms,
            medianMs: benchmark.baseline.median_ms, p95Ms: benchmark.baseline.p95_ms, maxMs: benchmark.baseline.max_ms,
          },
          candidate: {
            count: benchmark.candidate.count, minMs: benchmark.candidate.min_ms,
            medianMs: benchmark.candidate.median_ms, p95Ms: benchmark.candidate.p95_ms, maxMs: benchmark.candidate.max_ms,
          },
          baselineSha256: benchmark.baseline_sha256,
          candidateSha256: benchmark.candidate_sha256,
        } : null,
        correlation: realIndexCorrelation ?? hypopgCorrelation,
        hypopg: hypopg ? {
          verdict: hypopg.verdict,
          baselineCost: hypopg.baseline_cost,
          candidateCost: hypopg.candidate_cost,
          absoluteDelta: hypopg.absolute_delta,
          percentDelta: hypopg.percent_delta,
          created: hypopg.created_index_names,
          used: hypopg.used_index_names,
          reset: hypopg.cleanup.hypopg_reset === true,
        } : null,
        realIndex: realIndex ? {
          indexName: realIndex.index_name,
          buildMs: realIndex.index_build_ms,
          used: realIndex.index_used,
          scratchDropped: realIndex.cleanup.scratch_dropped,
          indexDropped: realIndex.cleanup.index_dropped,
          timeoutRestored: realIndex.cleanup.timeout_restored,
          connectionClosed: realIndex.cleanup.connection_closed,
        } : null,
        cacheObservations: baseline?.cache_observations,
        timeoutRestored: realIndex?.cleanup.timeout_restored ?? rewrite?.cleanup.timeout_restored ?? benchmark?.cleanup.timeout_restored ?? hypopg?.cleanup.timeout_restored ?? baseline?.cleanup.timeout_restored,
        connectionClosed: realIndex?.cleanup.connection_closed ?? rewrite?.cleanup.connection_closed ?? benchmark?.cleanup.connection_closed ?? hypopg?.cleanup.connection_closed ?? baseline?.cleanup.connection_closed,
      });
      const path = await saveTextAs(report, 'query-lab-report.md', 'Markdown', ['md']);
      setReportStatus(path ? `Report saved to ${path}` : 'Report export cancelled');
    } catch (error) {
      setReportStatus(errorDisplay(error));
    }
  };
  const migrationCandidate = validated?.candidates[0] ?? experiment.candidates[0];
  const migrationReady = Boolean(migrationCandidate && (
    (migrationCandidate.kind === 'index' && (hypopg?.index_used || realIndex?.index_used))
    || (migrationCandidate.kind === 'rewrite' && rewrite?.correctness === 'equal')
  ));

  return (
    <div className="proc-panel op-panel op-query-lab" data-workspace={workspace}>
      <div className="proc-toolbar">
        <span className="proc-title">Query Optimization Lab</span>
        <span className="dv-desc">{session.connectionName}</span>
        <span className="dv-desc">Specification v1</span>
        <div className="op-steps" aria-label="Query Lab workflow">
          {(['query', 'candidates', 'run'] as const).map((step, index) => (
            <button key={step} className={workspace === step ? 'active' : ''} onClick={() => setWorkspace(step)}>
              {index + 1}. {step === 'query' ? 'Query' : step === 'candidates' ? 'Candidates' : 'Run & evidence'}
            </button>
          ))}
        </div>
        <button className="toolbar-btn" onClick={validate}>Validate experiment</button>
        <div style={{ flex: 1 }} />
        <button className="toolbar-btn" disabled={!migrationReady} title="Send only the selected artifact to Migration Cockpit at Review" onClick={createMigration}>Create migration</button>
        <button className="toolbar-btn" disabled={!baseline && !hypopg && !realIndex && !rewrite && !benchmark} title="Export deterministic evidence without query-result rows" onClick={() => void exportReport()}>Export report .md</button>
        <button className="icon-btn" onClick={onClose} title="Close">×</button>
      </div>
      <div className="dg-body">
        {unavailable ? (
          <div className="mnt-warn"><StatusIcon kind="error" /><span>{unavailable}</span></div>
        ) : (
          <div className="sqp-main">
            <div className="sqp-left">
              <section hidden={workspace !== 'query'}>
                <h3>Original query and database</h3>
                <label className="dg-field-inline"><span>Database/schema</span>
                  <input value={experiment.database} onChange={event => patch(current => ({
                    ...current, database: event.target.value,
                    scratch: current.scratch ? { ...current.scratch, database: event.target.value } : null,
                  }))} />
                </label>
                <label className="dg-field-inline" style={{ display: 'block' }}><span>One SELECT or read-only WITH statement</span>
                  <textarea className="sqp-sql" rows={7} value={experiment.originalSql} spellCheck={false}
                    onChange={event => patch(current => ({ ...current, originalSql: event.target.value }))} />
                </label>
                <p className="dv-desc">Named <code>:parameters</code> require concrete values below. Positional <code>$1</code>/<code>?</code>, writes, multi-statements and client commands are refused before any invocation.</p>
              </section>

              <section hidden={workspace !== 'query'}>
                <h3>Concrete parameters</h3>
                {Object.entries(experiment.parameters).map(([name, parameter]) => (
                  <div className="sqp-f-evidence" key={name}>
                    <label>Name <input value={name} onChange={event => patch(current => {
                      const parameters = Object.fromEntries(Object.entries(current.parameters)
                        .map(([key, value]) => [key === name ? event.target.value : key, value]));
                      return { ...current, parameters };
                    })} /></label>
                    <label>Kind <select value={parameter.kind} onChange={event => patch(current => ({
                      ...current,
                      parameters: {
                        ...current.parameters,
                        [name]: { kind: event.target.value as QueryLabParameterKind, value: event.target.value === 'null' ? '' : parameter.value },
                      },
                    }))}>
                      {(['text', 'number', 'boolean', 'null'] as const).map(kind => <option key={kind} value={kind}>{kind}</option>)}
                    </select></label>
                    <label>Value <input value={parameter.value} disabled={parameter.kind === 'null'} onChange={event => patch(current => ({
                      ...current, parameters: { ...current.parameters, [name]: { ...parameter, value: event.target.value } },
                    }))} /></label>
                    <button className="toolbar-btn" onClick={() => patch(current => ({
                      ...current, parameters: Object.fromEntries(Object.entries(current.parameters).filter(([key]) => key !== name)),
                    }))}>Remove</button>
                  </div>
                ))}
                <button className="toolbar-btn" onClick={() => patch(current => ({
                  ...current,
                  parameters: {
                    ...current.parameters,
                    [`param_${Object.keys(current.parameters).length + 1}`]: { kind: 'text', value: '' },
                  },
                }))}>+ Add parameter</button>
              </section>

              <section hidden={workspace !== 'candidates'}>
                <h3>Candidates</h3>
                {experiment.candidates.map((candidate, index) => (
                  <div className="sqp-finding" key={`${candidate.id}-${index}`}>
                    <div className="row-actions">
                      <input aria-label={`Candidate ${index + 1} ID`} value={candidate.id} onChange={event => updateCandidate(index, { id: event.target.value })} />
                      <select aria-label={`Candidate ${index + 1} kind`} value={candidate.kind} onChange={event => changeCandidateKind(index, event.target.value as QueryLabCandidate['kind'])}>
                        {(['index', 'rewrite', 'setting'] as const).map(kind => <option key={kind} value={kind}>{kind}</option>)}
                      </select>
                      <button className="toolbar-btn" onClick={() => patch(current => ({
                        ...current, candidates: current.candidates.filter((_, at) => at !== index),
                      }))}>Remove</button>
                    </div>
                    <label className="dg-field-inline"><span>Name</span><input value={candidate.name} onChange={event => updateCandidate(index, { name: event.target.value })} /></label>
                    {candidate.kind === 'index' && <>
                      <label className="dg-field-inline"><span>Table</span><input value={candidate.table} onChange={event => updateCandidate(index, { table: event.target.value })} /></label>
                      <label className="dg-field-inline"><span>Columns (comma separated)</span><input value={candidate.columns.join(',')} onChange={event => updateCandidate(index, { columns: event.target.value.split(',').map(value => value.trim()) })} /></label>
                      <label className="dg-field-inline"><span>Unique</span><input type="checkbox" checked={candidate.unique} onChange={event => updateCandidate(index, { unique: event.target.checked })} /></label>
                      <label className="dg-field-inline"><span>Optional partial-index predicate</span><input value={candidate.where ?? ''} onChange={event => updateCandidate(index, { where: event.target.value || null })} /></label>
                    </>}
                    {candidate.kind === 'rewrite' && <label className="dg-field-inline" style={{ display: 'block' }}><span>Read-only rewrite SQL</span>
                      <textarea className="sqp-sql" rows={5} value={candidate.sql} spellCheck={false} onChange={event => updateCandidate(index, { sql: event.target.value })} />
                    </label>}
                    {candidate.kind === 'setting' && <label className="dg-field-inline"><span>Setting value</span><input value={candidate.value} onChange={event => updateCandidate(index, { value: event.target.value })} /></label>}
                  </div>
                ))}
                <button className="toolbar-btn" onClick={() => patch(current => ({
                  ...current,
                  candidates: [...current.candidates, { id: `rewrite-${current.candidates.length + 1}`, kind: 'rewrite', name: 'Candidate rewrite', sql: current.originalSql }],
                }))}>+ Add rewrite candidate</button>
              </section>
            </div>

            <div className="sqp-right">
              <section hidden={workspace === 'run'}>
                <h3>Execution and evidence</h3>
                <label className="dg-field-inline"><span>Experiment mode</span>
                  <select value={experiment.executionMode} onChange={event => patch(current => ({
                    ...current, executionMode: event.target.value as QueryLabExperiment['executionMode'],
                  }))}>
                    <option value="estimate">Estimate — plans and cost only</option>
                    <option value="measured">Measured — explicit non-production scratch</option>
                  </select>
                </label>
                <label className="dg-field-inline"><span>Warmup runs (0–10)</span><input type="number" value={experiment.warmupRuns} onChange={event => patch(current => ({ ...current, warmupRuns: Number(event.target.value) }))} /></label>
                <label className="dg-field-inline"><span>Measured repetitions (1–30)</span><input type="number" value={experiment.repetitions} onChange={event => patch(current => ({ ...current, repetitions: Number(event.target.value) }))} /></label>
                <label className="dg-field-inline"><span>Server timeout ms (100–60000)</span><input type="number" value={experiment.timeoutMs} onChange={event => patch(current => ({ ...current, timeoutMs: Number(event.target.value) }))} /></label>
                <label className="dg-field-inline"><span>Improvement threshold %</span><input type="number" value={experiment.improvementThresholdPct} onChange={event => patch(current => ({ ...current, improvementThresholdPct: Number(event.target.value) }))} /></label>
                <label className="dg-field-inline"><span>Rewrite row order</span>
                  <select aria-label="Result row order" value={experiment.resultRowOrder} onChange={event => patch(current => ({ ...current, resultRowOrder: event.target.value as QueryLabExperiment['resultRowOrder'] }))}>
                    <option value="ordered">Ordered — sequence must match</option>
                    <option value="multiset">Multiset — order ignored, duplicates retained</option>
                  </select>
                </label>
                <label className="dg-field-inline"><span>Rewrite max rows (1–100000)</span><input type="number" value={experiment.resultMaxRows} onChange={event => patch(current => ({ ...current, resultMaxRows: Number(event.target.value) }))} /></label>
                <label className="dg-field-inline"><span>Rewrite max decoded bytes</span><input type="number" value={experiment.resultMaxBytes} onChange={event => patch(current => ({ ...current, resultMaxBytes: Number(event.target.value) }))} /></label>
                {([
                  ['plan', 'Estimated plans (required)'],
                  ['cost', 'Estimated cost'],
                  ['timing', 'Measured timing'],
                  ['buffers', 'Buffer reads'],
                  ['resultEquality', 'Result equality'],
                ] as const).map(([key, label]) => <label className="dg-field-inline" key={key}><span>{label}</span>
                  <input type="checkbox" checked={experiment.evidence[key]} onChange={event => updateEvidence(key, event.target.checked)} />
                </label>)}
              </section>

              <section hidden={workspace === 'run'}>
                <h3>Scratch identity</h3>
                {experiment.scratch ? <>
                  <label className="dg-field-inline"><span>Migration scratch</span>
                    <select aria-label="Migration scratch" value={experiment.scratch.runKey ?? ''} onChange={event => {
                      const record = scratchRecords.find(item => item.run_key === event.target.value && item.status === 'active'
                        && item.session_id === session.sessionId && item.connection_id === session.connectionId && item.engine === experiment.engine);
                      patch(current => ({
                        ...current,
                        scratch: record ? {
                          sessionId: record.session_id, connectionId: record.connection_id,
                          database: record.name, environment: session.environment ?? null,
                          readOnly: session.readOnly ?? false, runKey: record.run_key,
                        } : current.scratch ? {
                          ...current.scratch, sessionId: session.sessionId, connectionId: session.connectionId,
                          database: current.database, environment: session.environment ?? null,
                          readOnly: session.readOnly ?? false, runKey: null,
                        } : null,
                      }));
                    }}>
                      <option value="">Same-name explicit target — baselines only, no real indexes</option>
                      {scratchRecords.filter(record => record.session_id === session.sessionId
                        && record.connection_id === session.connectionId && record.engine === experiment.engine)
                        .map(record => <option key={record.run_key} value={record.run_key} disabled={record.status !== 'active'}>
                          {record.name} · {record.status} · {record.run_key}
                        </option>)}
                    </select>
                  </label>
                  <button className="toolbar-btn" onClick={() => void refreshScratch()}>Refresh scratch records</button>
                  <p className="dv-desc">Session {experiment.scratch.sessionId} · connection {experiment.scratch.connectionId} · database {experiment.scratch.database} · environment {experiment.scratch.environment ?? 'unspecified'} · {experiment.scratch.readOnly ? 'read-only' : 'writable'} · run {experiment.scratch.runKey ?? 'not Migration-owned'}.</p>
                  <p className="dv-desc">Real indexes require an active Migration scratch with a cloned before-state. The candidate command consumes and drops that scratch after success, error or cancellation. Migration cloning copies structure, not table rows; no production-runtime verdict is made.</p>
                </> : <p className="dv-desc">No scratch target is configured. Measured mode remains blocked.</p>}
                {scratchError && <div className="mnt-warn"><StatusIcon kind="error" /><span>{scratchError}</span></div>}
                {scratchRecords.filter(record => record.status === 'cleanup_failed' && record.session_id === session.sessionId)
                  .map(record => <div className="sqp-f-evidence" key={record.run_key}>
                    <span>Leftover {record.name} · {record.error ?? 'cleanup failed'}</span>
                    <button className="toolbar-btn" onClick={() => void cleanupScratch(record)}>Retry Migration cleanup</button>
                  </div>)}
              </section>

              <section hidden={workspace !== 'run'}>
                <h3>Specification proof</h3>
                <p className="dv-desc">Spec SHA-256: {specHash}</p>
                {errors.length > 0 ? <div className="mnt-warn"><StatusIcon kind="error" /><span>{errors.length} blockers; no database invocation is possible.</span></div>
                  : <div className="mnt-bulk-cost c-metadata"><StatusIcon kind="ok" /><span>Contract is valid. Local proof is complete; baseline capture uses the guarded backend.</span></div>}
                {errors.map(error => <div className="sqp-f-evidence" key={error}>{error}</div>)}
                {validated && <div>
                  <p className="dv-desc"><b>Validated without a database call.</b> {validated.candidates.length} candidates · {validated.executionMode} mode · {validated.warmupRuns} warmup + {validated.repetitions} measured runs · timeout {validated.timeoutMs} ms.</p>
                  <details className="op-disclosure"><summary>Resolved SQL preview</summary><code className="sqp-f-snippet">{validated.resolvedSql}</code></details>
                  <button className="primary" disabled={baselineRunning} onClick={() => void captureBaseline()}>{baselineRunning ? 'Capturing baseline…' : 'Capture baseline'}</button>
                  {validated.engine === 'postgres' && validated.executionMode === 'estimate' && validated.candidates.some(candidate => candidate.kind === 'index') && <button className="toolbar-btn" disabled={hypopgRunning} onClick={() => void captureHypopg()}>{hypopgRunning ? 'Estimating index…' : 'Estimate index (HypoPG)'}</button>}
                  {validated.executionMode === 'measured' && validated.candidates.some(candidate => candidate.kind === 'index') && (validated.scratch?.runKey ? <>
                    <button className="primary" disabled={realIndexRunning} onClick={() => void captureRealIndex()}>{realIndexRunning ? 'Building and measuring…' : 'Build & measure real index'}</button>
                    {realIndexRunning && <button className="cancel-btn" onClick={() => {
                      if (realRunKey.current) {
                        setRealIndexCancelling(true);
                        void invoke('cancel_watched', { runKey: realRunKey.current }).catch(() => {});
                      }
                    }}>{realIndexCancelling ? 'Cancelling and cleaning…' : '■ Cancel + clean scratch'}</button>}
                    <p className="dv-desc">Measured baseline → create real index → measured candidate → drop index → drop Migration scratch. Create wall time includes lock wait and rebuild; no benchmark winner is chosen.</p>
                  </> : <p className="dv-desc">Select an active Migration scratch above to enable real-index execution. Same-name targets remain baseline-only.</p>)}
                  {validated.executionMode === 'measured' && validated.candidates.some(candidate => candidate.kind === 'rewrite') && <>
                    <button className="primary" disabled={rewriteRunning} onClick={() => void captureRewrite()}>{rewriteRunning ? 'Executing and hashing…' : 'Check rewrite results'}</button>
                    {rewriteRunning && <button className="cancel-btn" onClick={() => {
                      if (rewriteRunKey.current) {
                        setRewriteCancelling(true);
                        void invoke('cancel_watched', { runKey: rewriteRunKey.current }).catch(() => {});
                      }
                    }}>{rewriteCancelling ? 'Cancelling…' : '■ Cancel rewrite'}</button>}
                    <p className="dv-desc">Both read-only queries execute within the declared row/byte budgets. Only complete canonical typed hashes can be equal; different results are invalid, never a winner.</p>
                    <button className="toolbar-btn" disabled={benchmarkRunning} onClick={() => void captureBenchmark()}>{benchmarkRunning ? 'Benchmarking…' : 'Benchmark rewrite'}</button>
                    {benchmarkRunning && <button className="cancel-btn" onClick={() => {
                      if (benchmarkRunKey.current) {
                        setBenchmarkCancelling(true);
                        void invoke('cancel_watched', { runKey: benchmarkRunKey.current }).catch(() => {});
                      }
                    }}>{benchmarkCancelling ? 'Cancelling…' : '■ Cancel benchmark'}</button>}
                    {benchmarkRunning && <p className="dv-desc">Running up to {2 * (validated.warmupRuns + validated.repetitions)} full-drain steps with alternating order. Rows are discarded one at a time, never queued.</p>}
                  </>}
                </div>}
                {baselineError && <div className="mnt-warn"><StatusIcon kind="error" /><span>{baselineError}</span></div>}
                {hypopgError && <div className="mnt-warn"><StatusIcon kind="error" /><span>{hypopgError}</span></div>}
                {realIndexError && <div className="mnt-warn"><StatusIcon kind="error" /><span>{realIndexError}</span></div>}
                {rewriteError && <div className="mnt-warn"><StatusIcon kind="error" /><span>{rewriteError}</span></div>}
                {benchmarkError && <div className="mnt-warn"><StatusIcon kind="error" /><span>{benchmarkError}</span></div>}
                {reportStatus && <p className="dv-desc">{reportStatus}</p>}
              </section>

              <div className="op-stage" hidden={workspace !== 'run'}>
              {baseline && <section aria-label="Query Lab baseline evidence">
                <h3>Baseline · {baseline.execution_mode}</h3>
                <p className="dv-desc">Index evidence: {baseline.index_evidence_mode} · {baseline.comparison_policy}</p>
                <p className="dv-desc">{baseline.engine} · {baseline.version} · backend {baseline.backend_id} · timeout {baseline.timeout_ms} ms · cost estimates {baseline.cost_estimates ? 'included' : 'not requested'}.</p>
                <p className="dv-desc">Cleanup: timeout {baseline.cleanup.timeout_restored ? 'restored' : 'NOT restored'} · dedicated connection {baseline.cleanup.connection_closed ? 'closed' : 'NOT closed'}.</p>
                {baseline.cache_observations.map(observation => <div className="sqp-f-evidence" key={observation}>{observation}</div>)}
                {baseline.settings.map(setting => <div className="sqp-f-evidence" key={setting.name}>{setting.name}: {setting.value ?? 'not available'}</div>)}
                <details className="op-disclosure">
                  <summary>Estimated plan · {baseline.estimated_plan.label} · {baseline.estimated_plan.elapsed_ms} ms</summary>
                  <pre className="sqp-sql">{baseline.estimated_plan.content}</pre>
                </details>
                {baseline.measured_plan && <details className="op-disclosure">
                  <summary>EXECUTED QUERY · {baseline.measured_plan.label} · {baseline.measured_plan.elapsed_ms} ms</summary>
                  <p className="dv-desc">EXPLAIN ANALYZE actually executed the read-only statement; this is measured evidence, not a hypothetical estimate.</p>
                  <pre className="sqp-sql">{baseline.measured_plan.content}</pre>
                </details>}
              </section>}
              {hypopg && <section aria-label="HypoPG candidate evidence">
                <h3>Hypothetical index · {hypopg.candidate_id}</h3>
                <p className="dv-desc">{hypopg.comparison_policy}</p>
                <p className="dv-desc">Verdict: <b>{hypopg.verdict}</b> · baseline cost {hypopg.baseline_cost ?? 'not available'} · candidate cost {hypopg.candidate_cost ?? 'not available'} · delta {hypopg.absolute_delta ?? 'not available'} ({hypopg.percent_delta ?? 'not available'}%).</p>
                <p className="dv-desc">Index used: {hypopg.index_used ? 'yes' : 'no'} · created {hypopg.created_index_names.join(', ')} · used {hypopg.used_index_names.join(', ') || 'none'}.</p>
                <p className="dv-desc">Cleanup: HypoPG reset {hypopg.cleanup.hypopg_reset ? 'complete' : 'incomplete'} · timeout {hypopg.cleanup.timeout_restored ? 'restored' : 'NOT restored'} · dedicated connection {hypopg.cleanup.connection_closed ? 'closed' : 'NOT closed'}.</p>
                {hypopgCorrelation && <PlanCorrelationEvidence correlation={hypopgCorrelation} />}
                {!hypopg.index_used && <div className="mnt-warn"><StatusIcon kind="error" /><span>The planner ignored the hypothetical index; no improvement is claimed.</span></div>}
                <details className="op-disclosure"><summary>Baseline plan</summary><pre className="sqp-sql">{hypopg.baseline_plan.content}</pre></details>
                <details className="op-disclosure"><summary>Candidate plan</summary><pre className="sqp-sql">{hypopg.candidate_plan.content}</pre></details>
              </section>}
              {realIndex && <section aria-label="Real index candidate evidence">
                <h3>Real index on Migration scratch · {realIndex.candidate_id}</h3>
                <p className="dv-desc">{realIndex.comparison_policy}</p>
                {realIndexAssessment && <p className="dv-desc">Verdict: <b>{realIndexAssessment.verdict}</b> · {realIndexAssessment.reason}</p>}
                {realIndexCorrelation && <PlanCorrelationEvidence correlation={realIndexCorrelation} />}
                <p className="dv-desc">Scratch {realIndex.scratch_database} · run {realIndex.scratch_run_key} · backend {realIndex.backend_id} · index {realIndex.index_name}.</p>
                <p className="dv-desc">Create wall time: <b>{realIndex.index_build_ms} ms</b> (lock wait + rebuild; components not separately observed). Candidate index used: <b>{realIndex.index_used ? 'yes' : 'no'}</b>.</p>
                <p className="dv-desc">Cleanup: candidate index {realIndex.cleanup.index_dropped ? 'dropped' : 'NOT dropped'} · Migration scratch {realIndex.cleanup.scratch_dropped ? 'dropped' : 'NOT dropped'} · timeout {realIndex.cleanup.timeout_restored ? 'restored' : 'NOT restored'} · dedicated connection {realIndex.cleanup.connection_closed ? 'closed' : 'NOT closed'}.</p>
                {!realIndex.index_used && <div className="mnt-warn"><StatusIcon kind="error" /><span>The planner did not use the real candidate index; no improvement is claimed.</span></div>}
                <details className="op-disclosure"><summary>EXECUTED BASELINE · {planElapsedLabel(realIndex.baseline_plan)}</summary><pre className="sqp-sql">{realIndex.baseline_plan.content}</pre></details>
                <details className="op-disclosure"><summary>EXECUTED CANDIDATE · {planElapsedLabel(realIndex.candidate_plan)}</summary><pre className="sqp-sql">{realIndex.candidate_plan.content}</pre></details>
              </section>}
              {rewrite && <section aria-label="Rewrite correctness evidence">
                <h3>Rewrite correctness · {rewrite.candidate_id} · <b>{rewrite.correctness}</b></h3>
                <p className="dv-desc">Backend {rewrite.backend_id} · {rewrite.row_order_policy} rows · budgets {rewrite.max_rows} rows / {rewrite.max_bytes} decoded bytes. No query-result rows are retained in this evidence.</p>
                {rewrite.reason && <div className={rewrite.correctness === 'equal' ? 'sqp-f-evidence' : 'mnt-warn'}><StatusIcon kind={rewrite.correctness === 'unverified' ? 'error' : 'pending'} /><span>{rewrite.reason}</span></div>}
                {(['baseline', 'candidate'] as const).map(kind => {
                  const evidence = rewrite[kind];
                  return <div className="sqp-f-evidence" key={kind}>
                    <h4>{kind === 'baseline' ? 'EXECUTED BASELINE' : 'EXECUTED CANDIDATE'} · {evidence.complete ? 'complete canonical hash' : 'unverified'}</h4>
                    <p className="dv-desc">{evidence.rows_observed} observed rows · {evidence.bytes_observed} decoded bytes · columns {evidence.columns.map(column => `${column.name}:${column.type_name}`).join(', ') || 'none'}.</p>
                    <p className="dv-desc">SHA-256: {evidence.sha256 ?? 'not available'} {evidence.unverified_reason ? `· ${evidence.unverified_reason}` : ''}</p>
                  </div>;
                })}
                <p className="dv-desc">Cleanup: timeout {rewrite.cleanup.timeout_restored ? 'restored' : 'NOT restored'} · dedicated connection {rewrite.cleanup.connection_closed ? 'closed' : 'NOT closed'} · scratch left active for further read-only experiments.</p>
              </section>}
              {benchmark && <section aria-label="Benchmark timing evidence">
                <h3>Benchmark · {benchmark.candidate_id} · {benchmark.warmup_runs} warmup + {benchmark.repetitions} repetitions</h3>
                <p className="dv-desc">Backend {benchmark.backend_id} · {benchmark.pairs.length} measured pairs · alternating order · full-drain execution with no result queue. Raw observations stay beside the noise-aware verdict. Plan correlation is not available for this timing-only run.</p>
                {benchmarkAssessment && <p className="dv-desc">Verdict: <b>{benchmarkAssessment.verdict}</b> · median delta {benchmarkAssessment.deltaMs ?? 'not available'} ms ({benchmarkAssessment.improvementPct ?? 'not available'}%) · baseline-on-baseline noise {benchmarkAssessment.noiseFloorMs ?? 'not available'} ms · configured threshold {benchmarkAssessment.thresholdMs ?? 'not available'} ms. {benchmarkAssessment.reason}</p>}
                {(['baseline', 'candidate'] as const).map(kind => {
                  const summary = benchmark[kind];
                  const raw = kind === 'baseline' ? benchmark.baseline_ms : benchmark.candidate_ms;
                  return <div className="sqp-f-evidence" key={kind}>
                    <h4>{kind} · count {summary.count} · min {summary.min_ms} ms · median {summary.median_ms} ms · p95 {summary.p95_ms} ms · max {summary.max_ms} ms</h4>
                    <p className="dv-desc">Raw timings: [{raw.join(', ')}] ms · SHA-256 {kind === 'baseline' ? benchmark.baseline_sha256 : benchmark.candidate_sha256}</p>
                  </div>;
                })}
                <details className="op-disclosure">
                  <summary>Raw repetition pairs · {benchmark.pairs.length}</summary>
                  {benchmark.pairs.map(pair => <div className="sqp-f-evidence" key={pair.repetition}>
                    Repetition {pair.repetition} · {pair.order} · baseline {pair.baseline_ms} ms · candidate {pair.candidate_ms} ms
                  </div>)}
                </details>
                <p className="dv-desc">Cleanup: timeout {benchmark.cleanup.timeout_restored ? 'restored' : 'NOT restored'} · dedicated connection {benchmark.cleanup.connection_closed ? 'closed' : 'NOT closed'}.</p>
              </section>}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
