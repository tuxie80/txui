import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke, Channel } from '@tauri-apps/api/core';
import type { QueryResult, Session } from '../types';
import { safeOperationUnavailableReason } from '../utils/operationSupport';
import type { MigrationOrigin } from '../utils/operationHandoff';
import { reviewMigrationWithCatalog } from '../utils/migrationReview';
import type { MigrationReviewResult } from '../utils/migrationReview';
import { buildMigrationPreflightStatements } from '../utils/migrationPreflight';
import type { MigrationExecutionResult, MigrationPreflightResponse, MigrationScratchRecord } from '../utils/migrationPreflight';
import { buildMigrationCloneInput } from '../utils/migrationClone';
import type { MigrationCloneResult } from '../utils/migrationClone';
import { compareMigrationFinalModel, compareMigrationTargetModel } from '../utils/migrationVerification';
import type { MigrationFinalComparison } from '../utils/migrationVerification';
import {
  createMigrationDraft, finishMigrationDeployment, markMigrationDone, markMigrationReady,
  markMigrationRehearsed, markMigrationReviewed, startMigrationDeployment,
} from '../utils/migrationPlan';
import type { MigrationDraft, MigrationRunOutcome } from '../utils/migrationPlan';
import { sha256Hex } from '../utils/datagenStandards';
import { renderMigrationReport } from '../utils/migrationReport';
import { saveTextAs } from '../utils/exportersIo';
import { errorDisplay, isCancelled } from '../utils/appError';
import { SEVERITY_ICON } from '../utils/sqlLint';
import { useServerFlavor } from '../store/serverFlavors';
import { clearTabActivities, panelTabKey, setActivity } from '../store/tabActivity';
import type { Grid } from '../utils/schemaCollect';
import { StatusIcon } from './StatusIcon';

interface Props {
  session: Session;
  openSessions?: Session[];
  schema?: string | null;
  initialSql?: string;
  initialOrigin?: MigrationOrigin;
  onClose: () => void;
}

interface DeploymentProgress {
  committed: number;
  unknown: number;
  failed: number;
  notStarted: number;
  backendId: number | null;
}

type DeploymentEvent =
  | { type: 'started'; run_key: string; statement_total: number; database: string }
  | { type: 'backend'; backend_id: number }
  | { type: 'statement'; statement: MigrationExecutionResult['statements'][number]; committed: number; unknown: number; failed: number; not_started: number }
  | { type: 'done'; ok: boolean; cancelled: boolean; committed: number; unknown: number; failed: number; not_started: number };

export function MigrationPanel({ session, openSessions = [session], schema = null, initialSql = '', initialOrigin = 'editor', onClose }: Props) {
  const unavailable = safeOperationUnavailableReason(session.engine, 'migration');
  const flavor = useServerFlavor(session.sessionId, session.engine, session.connectionId);
  const [sql, setSql] = useState(initialSql);
  const [draft, setDraft] = useState<MigrationDraft | null>(null);
  const [result, setResult] = useState<MigrationReviewResult | null>(null);
  const [preflight, setPreflight] = useState<MigrationPreflightResponse | null>(null);
  const [preflightError, setPreflightError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const reviewRunRef = useRef(0);
  const eligible = openSessions.filter(candidate =>
    candidate.engine === session.engine && !candidate.readOnly && candidate.environment !== 'prod');
  const [rehearsalSessionId, setRehearsalSessionId] = useState(
    eligible.some(candidate => candidate.sessionId === session.sessionId)
      ? session.sessionId : eligible[0]?.sessionId ?? session.sessionId);
  const [scratchRecords, setScratchRecords] = useState<MigrationScratchRecord[]>([]);
  const [creating, setCreating] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [cleaning, setCleaning] = useState<string | null>(null);
  const [cloning, setCloning] = useState<string | null>(null);
  const [cloneResults, setCloneResults] = useState<Record<string, MigrationCloneResult>>({});
  const [executing, setExecuting] = useState<string | null>(null);
  const [executionCancelling, setExecutionCancelling] = useState(false);
  const [executionResults, setExecutionResults] = useState<Record<string, MigrationExecutionResult>>({});
  const [verifying, setVerifying] = useState<string | null>(null);
  const [verificationResults, setVerificationResults] = useState<Record<string, MigrationFinalComparison>>({});
  const [scratchError, setScratchError] = useState<string | null>(null);
  const [confirmDeployment, setConfirmDeployment] = useState(false);
  const [deploying, setDeploying] = useState(false);
  const [deploymentCancelling, setDeploymentCancelling] = useState(false);
  const [deploymentResult, setDeploymentResult] = useState<MigrationExecutionResult | null>(null);
  const [deploymentProgress, setDeploymentProgress] = useState<DeploymentProgress | null>(null);
  const [targetVerifying, setTargetVerifying] = useState(false);
  const [targetVerification, setTargetVerification] = useState<MigrationFinalComparison | null>(null);
  const deploymentRunRef = useRef<string | null>(null);
  const runKeyRef = useRef<string | null>(null);
  const activityKey = panelTabKey(session.sessionId, 'migration');

  const refreshScratch = useCallback(async () => {
    try {
      const records = await invoke<MigrationScratchRecord[]>('migration_scratch_list');
      setScratchRecords(records);
    } catch (e) {
      setScratchError(errorDisplay(e));
    }
  }, []);

  useEffect(() => { void refreshScratch(); }, [refreshScratch]);

  const scratchBlocked = creating ? 'Scratch creation is already running.'
    : !result || !draft ? 'Review a migration before creating rehearsal scratch.'
    : !result.catalogComplete ? 'Rehearsal requires a complete live before-state.'
    : (result.review.summary.unsupported > 0) ? 'Unsupported migration statements block rehearsal.'
    : preflightError ? 'Backend preflight must pass before rehearsal.'
    : !preflight ? 'Run backend preflight before rehearsal.'
    : eligible.length === 0 ? 'Open a writable, non-production rehearsal session of the same engine.'
    : null;

  const createScratch = useCallback(async () => {
    if (creating || !result || !draft || !preflight || preflightError) return;
    const runKey = crypto.randomUUID();
    runKeyRef.current = runKey;
    setCreating(true);
    setCancelling(false);
    setScratchError(null);
    try {
      const record = await invoke<MigrationScratchRecord>('migration_rehearsal_create', {
        sessionId: rehearsalSessionId, runKey,
      });
      setScratchRecords(current => [record, ...current.filter(item => item.run_key !== record.run_key)]);
      setLogs(current => [...current, `Scratch ${record.name} created on ${record.engine}; migration SQL was not executed.`]);
    } catch (e) {
      if (!isCancelled(e)) setScratchError(errorDisplay(e));
      setLogs(current => [...current, isCancelled(e)
        ? 'Scratch creation cancelled; cleanup completed when the created object could be confirmed.'
        : `Scratch creation failed: ${errorDisplay(e)}`]);
    } finally {
      setCreating(false);
      setCancelling(false);
      runKeyRef.current = null;
      await refreshScratch();
    }
  }, [creating, result, draft, preflight, preflightError, rehearsalSessionId, refreshScratch]);

  const cloneScratch = useCallback(async (record: MigrationScratchRecord) => {
    if (!result?.catalog || cloning || scratchBlocked) return;
    setCloning(record.run_key);
    setScratchError(null);
    try {
      const input = buildMigrationCloneInput(result.catalog, result.review);
      const outcome = await invoke<MigrationCloneResult>('migration_rehearsal_clone', {
        runKey: record.run_key,
        sourceSessionId: session.sessionId,
        sourceSchema: schema?.trim() ?? '',
        affected: input.affected,
        tables: input.tables,
        foreignKeys: input.foreignKeys,
      });
      setCloneResults(current => ({ ...current, [record.run_key]: outcome }));
      setLogs(current => [...current,
        `Cloned ${outcome.tables_cloned} tables and ${outcome.foreign_keys_added} foreign keys into ${record.name}; migration SQL was not executed.`]);
    } catch (e) {
      if (!isCancelled(e)) setScratchError(errorDisplay(e));
      setLogs(current => [...current, isCancelled(e)
        ? `Clone into ${record.name} cancelled; earlier cloned objects remain for inspection or cleanup.`
        : `Clone into ${record.name} failed: ${errorDisplay(e)}`]);
    } finally {
      setCloning(null);
      await refreshScratch();
    }
  }, [result, cloning, scratchBlocked, session.sessionId, schema, refreshScratch]);

  const executeScratch = useCallback(async (record: MigrationScratchRecord) => {
    const cloned = cloneResults[record.run_key];
    if (!result || !draft || !preflight || preflightError || executing || record.status !== 'active'
        || executionResults[record.run_key] || !cloned || cloned.statements_executed !== cloned.total_statements) return;
    setExecuting(record.run_key);
    setExecutionCancelling(false);
    setScratchError(null);
    try {
      const outcome = await invoke<MigrationExecutionResult>('migration_rehearsal_execute', {
        runKey: record.run_key,
        sql: draft.sql,
        expectedSqlSha256: draft.sqlSha256,
        statements: buildMigrationPreflightStatements(result.review),
        catalogComplete: result.catalogComplete,
        tablesComplete: result.review.tables.every(table => table.complete),
      });
      setExecutionResults(current => ({ ...current, [record.run_key]: outcome }));
      setLogs(current => [...current,
        ...outcome.statements.map(statement => statement.ok
          ? `Rehearsal statement ${statement.number}/${outcome.statement_total} · line ${statement.line} · ${statement.ms} ms · backend ${outcome.backend_id ?? 'unknown'}`
          : `Rehearsal statement ${statement.number}/${outcome.statement_total} · line ${statement.line} · ${statement.error ?? 'not completed'}`),
        outcome.ok
          ? `Exact migration hash executed in ${record.name}: ${outcome.executed}/${outcome.statement_total} statements. Final comparison has not run; no deployment has run.`
          : `${outcome.cancelled ? 'Rehearsal cancelled' : 'Rehearsal stopped'} in ${record.name}: ${outcome.executed}/${outcome.statement_total} statements succeeded. Earlier objects remain; create fresh scratch rather than retrying this run.`,
      ]);
    } catch (e) {
      if (!isCancelled(e)) setScratchError(errorDisplay(e));
      setLogs(current => [...current, `Rehearsal execution could not start or its outcome was not received: ${errorDisplay(e)}`]);
    } finally {
      setExecuting(null);
      setExecutionCancelling(false);
      await refreshScratch();
    }
  }, [result, draft, preflight, preflightError, executing, cloneResults, executionResults, refreshScratch]);

  const verifyScratch = useCallback(async (record: MigrationScratchRecord) => {
    const execution = executionResults[record.run_key];
    if (!result?.catalog || !draft || draft.phase !== 'reviewed' || !execution?.ok || verifying
        || execution.sql_sha256 !== draft.sqlSha256 || record.status !== 'executed') return;
    const request = reviewRunRef.current;
    setVerifying(record.run_key);
    setScratchError(null);
    try {
      const runGrid = async (query: string): Promise<Grid | null> => {
        try {
          const response = await invoke<QueryResult>('monitor_query', { sessionId: record.session_id, sql: query });
          return { columns: response.columns.map(column => column.name), rows: response.rows };
        } catch {
          return null;
        }
      };
      const finalState = await reviewMigrationWithCatalog({
        sql: '', engine: session.engine === 'mysql' ? 'mysql' : 'postgres',
        mariaDb: session.engine === 'mysql' && flavor.flavor === 'mariadb',
        schema: record.name, runGrid, purpose: 'final-state',
        onLog: message => {
          if (request === reviewRunRef.current) setLogs(current => [...current, message]);
        },
      });
      if (request !== reviewRunRef.current) return;
      const comparison = compareMigrationFinalModel({
        engine: session.engine === 'mysql' ? 'mysql' : 'postgres',
        snapshot: result.catalog,
        review: result.review,
        actualTables: finalState.review.tables,
        catalogComplete: finalState.catalogComplete,
      });
      setVerificationResults(current => ({ ...current, [record.run_key]: comparison }));
      setLogs(current => [...current,
        ...comparison.notes.map(note => `Explained: ${note}`),
        ...comparison.differences.map(difference => `Difference: ${difference}`),
        ...comparison.unverified.map(reason => `Unverified: ${reason}`),
      ]);
      if (comparison.differences.length === 0 && comparison.unverified.length === 0) {
        const rehearsed = markMigrationRehearsed(draft, {
          anchor: draft.reviewProof!.anchor,
          scratch: {
            sessionId: record.session_id, connectionId: record.connection_id,
            database: record.name, runKey: record.run_key,
          },
          execution: {
            runId: record.run_key, completedStatements: execution.executed,
            failedStatements: execution.failed, cancelled: execution.cancelled,
          },
          finalTables: comparison.actualTables,
          differences: comparison.differences,
          unverified: comparison.unverified,
        });
        setDraft(rehearsed);
        setLogs(current => [...current,
          `Final objects match the expected model in ${record.name}. Rehearsal proof is complete; deployment has not run.`]);
      } else {
        setLogs(current => [...current,
          `Rehearsal proof withheld: ${comparison.differences.length} differences and ${comparison.unverified.length} unverified checks.`]);
      }
    } catch (e) {
      setScratchError(errorDisplay(e));
      setLogs(current => [...current, `Final-object comparison failed: ${errorDisplay(e)}`]);
    } finally {
      if (request === reviewRunRef.current) setVerifying(null);
    }
  }, [result, draft, executionResults, verifying, session, flavor]);

  const deploy = useCallback(async () => {
    if (!draft || !result || !preflight || preflightError || deploying
        || !['rehearsed', 'ready'].includes(draft.phase) || !schema?.trim()) return;
    const runKey = crypto.randomUUID();
    const ready = draft.phase === 'rehearsed' ? markMigrationReady(draft) : draft;
    const started = startMigrationDeployment(ready, runKey);
    deploymentRunRef.current = runKey;
    setDeploying(true);
    setDeploymentCancelling(false);
    setConfirmDeployment(false);
    setDeploymentResult(null);
    setDeploymentProgress({
      committed: 0, unknown: 0, failed: 0,
      notStarted: started.deployment!.totalStatements, backendId: null,
    });
    setDraft(started);
    setScratchError(null);
    const channel = new Channel<DeploymentEvent>();
    channel.onmessage = event => {
      if (event.type === 'backend') {
        setDeploymentProgress(current => current ? { ...current, backendId: event.backend_id } : current);
      } else if (event.type === 'statement') {
        setDeploymentProgress(current => ({
          committed: event.committed, unknown: event.unknown, failed: event.failed,
          notStarted: event.not_started, backendId: current?.backendId ?? null,
        }));
        setLogs(current => [...current, event.statement.ok
          ? `Deployment statement ${event.statement.number}/${started.deployment!.totalStatements} committed · line ${event.statement.line} · ${event.statement.ms} ms`
          : `Deployment statement ${event.statement.number}/${started.deployment!.totalStatements} · ${event.statement.error ?? 'not completed'}`]);
      }
    };
    try {
      const outcome = await invoke<MigrationExecutionResult>('migration_deploy_execute', {
        sessionId: session.sessionId,
        runKey,
        rehearsalRunKey: draft.rehearsalProof!.scratch.runKey,
        sourceConnectionId: draft.source.connectionId,
        targetConnectionId: draft.target.connectionId,
        database: draft.database,
        sql: draft.sql,
        expectedSqlSha256: draft.sqlSha256,
        statements: buildMigrationPreflightStatements(result.review),
        catalogComplete: result.catalogComplete,
        tablesComplete: result.review.tables.every(table => table.complete),
        onEvent: channel,
      });
      setDeploymentResult(outcome);
      const runOutcome: MigrationRunOutcome = {
        runId: runKey, completedStatements: outcome.committed,
        failedStatements: outcome.failed, cancelled: outcome.cancelled, ok: outcome.ok,
        unknownStatements: outcome.unknown, notStartedStatements: outcome.not_started,
      };
      const finished = finishMigrationDeployment(started, runOutcome, outcome.error ?? undefined);
      setDraft(finished);
      setLogs(current => [...current,
        `Deployment ${outcome.ok ? 'statements completed' : outcome.cancelled ? 'cancelled' : 'stopped'} · ${outcome.committed} committed · ${outcome.unknown} unknown · ${outcome.failed} failed · ${outcome.not_started} not started · backend ${outcome.backend_id ?? 'unknown'} · ${outcome.ms} ms`,
        outcome.ok
          ? 'Deployment entered verification. Final target comparison is not complete; this is not a done badge.'
          : 'No rollback is claimed. Inspect the target and per-statement evidence before creating a new migration draft.',
      ]);
    } catch (e) {
      const message = errorDisplay(e);
      setDraft(finishMigrationDeployment(started, {
        runId: runKey, completedStatements: 0, failedStatements: 0,
        cancelled: isCancelled(e), ok: false,
      }, `Deployment outcome was not received: ${message}. Do not retry the same run ID; inspect target/audit evidence.`));
      setScratchError(message);
      setLogs(current => [...current, `Deployment failed before a trustworthy result was received: ${message}`]);
    } finally {
      setDeploying(false);
      setDeploymentCancelling(false);
      deploymentRunRef.current = null;
    }
  }, [draft, result, preflight, preflightError, deploying, schema, session.sessionId]);

  const verifyTarget = useCallback(async () => {
    if (!result?.catalog || !draft || draft.phase !== 'verifying' || !deploymentResult?.ok
        || deploymentResult.run_key !== draft.deployment!.runId || targetVerifying) return;
    if (session.sessionId !== draft.target.sessionId || session.connectionId !== draft.target.connectionId) {
      const message = 'Target session identity changed after deployment; final verification was refused.';
      setScratchError(message);
      setLogs(current => [...current, message]);
      return;
    }
    const request = reviewRunRef.current;
    setTargetVerifying(true);
    setTargetVerification(null);
    setScratchError(null);
    try {
      const runGrid = async (query: string): Promise<Grid | null> => {
        try {
          const response = await invoke<QueryResult>('monitor_query', { sessionId: draft.target.sessionId, sql: query });
          return { columns: response.columns.map(column => column.name), rows: response.rows };
        } catch {
          return null;
        }
      };
      const finalState = await reviewMigrationWithCatalog({
        sql: '', engine: draft.engine, mariaDb: draft.engine === 'mysql' && flavor.flavor === 'mariadb',
        schema: draft.database ?? '', runGrid, purpose: 'final-state',
        onLog: message => {
          if (request === reviewRunRef.current) setLogs(current => [...current, message]);
        },
      });
      if (request !== reviewRunRef.current) return;
      const comparison = compareMigrationTargetModel({
        engine: draft.engine, snapshot: result.catalog, review: result.review,
        actualTables: finalState.review.tables, catalogComplete: finalState.catalogComplete,
      });
      setTargetVerification(comparison);
      setLogs(current => [...current,
        ...comparison.notes.map(note => `Target scope: ${note}`),
        ...comparison.differences.map(difference => `Target difference: ${difference}`),
        ...comparison.unverified.map(reason => `Target unverified: ${reason}`),
      ]);
      if (comparison.differences.length === 0 && comparison.unverified.length === 0) {
        setDraft(markMigrationDone(draft, {
          runId: draft.deployment!.runId,
          differences: comparison.differences,
          unverified: comparison.unverified,
        }));
        setLogs(current => [...current,
          `Final target verification complete — ${comparison.actualTables.length} scoped tables checked; ${comparison.outOfScopeTables.length} unrelated tables excluded. Migration is done.`]);
      } else {
        setLogs(current => [...current,
          `Final target verification withheld: ${comparison.differences.length} differences and ${comparison.unverified.length} unverified checks. The draft remains verifying.`]);
      }
    } catch (e) {
      setScratchError(errorDisplay(e));
      setLogs(current => [...current, `Target verification failed: ${errorDisplay(e)}`]);
    } finally {
      if (request === reviewRunRef.current) setTargetVerifying(false);
    }
  }, [result, draft, deploymentResult, targetVerifying, flavor, session.sessionId, session.connectionId]);

  const exportReport = useCallback(async () => {
    if (!draft) return;
    setScratchError(null);
    try {
      const rehearsalRun = draft.rehearsalProof?.scratch.runKey;
      const report = renderMigrationReport({
        draft, review: result, preflight,
        sourceName: session.connectionName, targetName: session.connectionName,
        rehearsalExecution: rehearsalRun ? executionResults[rehearsalRun] : null,
        deploymentExecution: deploymentResult,
        targetVerification,
      });
      const path = await saveTextAs(report, 'migration-report.md', 'Markdown', ['md']);
      if (path) setLogs(current => [...current, `Migration report saved to ${path}`]);
    } catch (e) {
      setScratchError(errorDisplay(e));
    }
  }, [draft, result, preflight, session.connectionName, executionResults, deploymentResult, targetVerification]);

  const cleanupScratch = useCallback(async (runKey: string) => {
    setCleaning(runKey);
    setScratchError(null);
    try {
      const record = await invoke<MigrationScratchRecord>('migration_rehearsal_cleanup', { runKey });
      setScratchRecords(current => current.filter(item => item.run_key !== record.run_key));
      setLogs(current => [...current, `Scratch ${record.name} dropped.`]);
    } catch (e) {
      setScratchError(errorDisplay(e));
      await refreshScratch();
    } finally {
      setCleaning(null);
    }
  }, [refreshScratch]);

  useEffect(() => {
    if (!creating && !cloning && !executing && !deploying) { clearTabActivities(activityKey); return; }
    const runKey = deploying ? deploymentRunRef.current : executing ?? cloning ?? runKeyRef.current;
    setActivity(activityKey, {
      id: deploying ? 'migration-deploy-execute' : executing ? 'migration-rehearsal-execute' : cloning ? 'migration-rehearsal-clone' : 'migration-rehearsal-create',
      label: deploying
        ? deploymentCancelling ? 'Cancelling target deployment' : 'Deploying migration to target'
        : executing
          ? executionCancelling ? 'Cancelling migration rehearsal' : 'Executing migration rehearsal'
          : cloning ? 'Cloning before-state' : cancelling ? 'Cancelling scratch creation' : 'Creating rehearsal scratch',
      detail: runKey ?? rehearsalSessionId,
      survives: true,
      kill: () => {
        if (runKey) {
          if (deploying) setDeploymentCancelling(true);
          else if (executing) setExecutionCancelling(true);
          else if (!cloning) setCancelling(true);
          void invoke('cancel_watched', { runKey }).catch(() => {});
        }
      },
    });
  }, [activityKey, creating, cloning, executing, deploying, cancelling, executionCancelling, deploymentCancelling, rehearsalSessionId]);

  useEffect(() => {
    reviewRunRef.current++;
    setRunning(false);
    setDraft(null);
    setResult(null);
    setPreflight(null);
    setPreflightError(null);
    setVerifying(null);
    setCloneResults({});
    setExecutionResults({});
    setVerificationResults({});
    setConfirmDeployment(false);
    setDeploymentResult(null);
    setDeploymentProgress(null);
    setTargetVerification(null);
    setLogs([]);
    setError(null);
  }, [schema]);
  useEffect(() => () => { reviewRunRef.current++; }, []);

  const review = useCallback(async () => {
    if (!sql.trim() || running || unavailable) return;
    const request = ++reviewRunRef.current;
    setRunning(true);
    setError(null);
    setResult(null);
    setPreflight(null);
    setPreflightError(null);
    setDraft(null);
    setConfirmDeployment(false);
    setDeploymentResult(null);
    setDeploymentProgress(null);
    setTargetVerification(null);
    setLogs([]);
    try {
      const runGrid = async (query: string): Promise<Grid | null> => {
        try {
          const r = await invoke<QueryResult>('monitor_query', { sessionId: session.sessionId, sql: query });
          return { columns: r.columns.map(column => column.name), rows: r.rows };
        } catch {
          return null;
        }
      };
      const outcome = await reviewMigrationWithCatalog({
        sql,
        engine: session.engine === 'mysql' ? 'mysql' : 'postgres',
        mariaDb: session.engine === 'mysql' && flavor.flavor === 'mariadb',
        schema: schema ?? '', runGrid,
        onLog: message => {
          if (request === reviewRunRef.current) setLogs(current => [...current, message]);
        },
      });
      if (request !== reviewRunRef.current) return;
      const database = schema?.trim() || null;
      const initial = createMigrationDraft({
        version: 1,
        engine: session.engine === 'mysql' ? 'mysql' : 'postgres',
        database,
        sql,
        sqlSha256: sha256Hex(Array.from(new TextEncoder().encode(sql))),
        origin: initialOrigin,
        source: { sessionId: session.sessionId, connectionId: session.connectionId },
        target: { sessionId: session.sessionId, connectionId: session.connectionId },
      });
      const reviewed = markMigrationReviewed(initial, {
        anchor: {
          sqlSha256: initial.sqlSha256,
          source: initial.source,
          target: initial.target,
          database,
        },
        catalogComplete: outcome.catalogComplete,
        review: outcome.review,
      });
      setResult(outcome);
      setDraft(reviewed);
      try {
        const backend = await invoke<MigrationPreflightResponse>('migration_preflight', {
          sessionId: session.sessionId,
          sql,
          statements: buildMigrationPreflightStatements(outcome.review),
        });
        if (backend.sql_sha256 !== initial.sqlSha256) {
          throw new Error('backend and frontend computed different SQL hashes; preflight was discarded');
        }
        if (request !== reviewRunRef.current) return;
        setPreflight(backend);
        setLogs(current => [...current, `Backend preflight passed — ${backend.statement_count} statements, stop on first error.`]);
      } catch (e) {
        if (request === reviewRunRef.current) {
          const message = errorDisplay(e);
          setPreflightError(message);
          setLogs(current => [...current, `Backend preflight refused: ${message}`]);
        }
      }
    } catch (e) {
      if (request === reviewRunRef.current) setError(errorDisplay(e));
    } finally {
      if (request === reviewRunRef.current) setRunning(false);
    }
  }, [sql, running, unavailable, session, flavor, schema, initialOrigin]);

  const summary = result?.review.summary;
  const findings = result?.review.findings ?? [];
  return (
    <div className="proc-panel">
      <div className="proc-toolbar">
        <span className="proc-title">Migration Cockpit</span>
        <span className="dv-desc">{session.connectionName}</span>
        <span className="dv-desc">Phase: {draft?.phase ?? 'draft'}</span>
        <div style={{ flex: 1 }} />
        <button className="toolbar-btn" disabled={!draft} title="Export a deterministic report with incomplete evidence and no credentials or row data" onClick={() => void exportReport()}>Export report .md</button>
        <button className="icon-btn" onClick={onClose} title="Close">×</button>
      </div>
      <div className="dg-body">
        {unavailable ? (
          <div className="mnt-warn"><StatusIcon kind="error" /><span>{unavailable}</span></div>
        ) : (
          <div className="sqp-main">
            <div className="sqp-left">
              <div className="sqp-schema-intro">
                <h3>Review migration</h3>
                <p className="sqp-schema-note">
                  Models CREATE/ALTER/DROP TABLE, columns, indexes and foreign keys in statement order.
                  Review is read-only. Rehearsal is isolated in scratch; deployment requires its proof and a separate target confirmation.
                </p>
              </div>
              <label className="dg-field-inline" style={{ display: 'block' }}>
                <span>Ordered migration SQL</span>
                <textarea
                  className="sqp-sql"
                  value={sql}
                  readOnly={deploying || targetVerifying}
                  onChange={event => {
                    reviewRunRef.current++;
                    setRunning(false);
                    setSql(event.target.value);
                    setDraft(null);
                    setResult(null);
                    setPreflight(null);
                    setPreflightError(null);
                    setVerifying(null);
                    setCloneResults({});
                    setExecutionResults({});
                    setVerificationResults({});
                    setConfirmDeployment(false);
                    setDeploymentResult(null);
                    setDeploymentProgress(null);
                    setTargetVerification(null);
                    setLogs([]);
                    setError(null);
                  }}
                  placeholder="ALTER TABLE orders ADD COLUMN note varchar(255);"
                  spellCheck={false}
                />
              </label>
              <button className="primary" disabled={running || !sql.trim()} onClick={() => void review()}>
                {running ? 'Reviewing…' : '▶ Review migration'}
              </button>
              {error && <div className="proc-error-bar">{error}</div>}
              <div className="sqp-log">
                {logs.map((line, index) => <div key={index} className="sqp-log-line">{line}</div>)}
              </div>
              <section>
                <h3>Rehearsal scratch</h3>
                <p className="dv-desc">Uses only a generated scratch database/schema on an explicit writable, non-production session. Clone the before-state, then execute the exact reviewed hash once. Deployment never runs here.</p>
                <label className="dg-field-inline">
                  <span>Rehearsal session</span>
                  <select
                    className="toolbar-select"
                    value={rehearsalSessionId}
                    disabled={creating || eligible.length === 0}
                    onChange={event => setRehearsalSessionId(event.target.value)}
                  >
                    {eligible.map(candidate => (
                      <option key={candidate.sessionId} value={candidate.sessionId}>
                        {candidate.connectionName} · {candidate.environment ?? 'unspecified'}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="row-actions">
                  <button className="primary" disabled={!!scratchBlocked} title={scratchBlocked ?? 'Create isolated rehearsal scratch'} onClick={() => void createScratch()}>
                    {creating ? 'Creating…' : '+ Create scratch'}
                  </button>
                  {creating && <button className="cancel-btn" onClick={() => {
                    if (runKeyRef.current) {
                      setCancelling(true);
                      void invoke('cancel_watched', { runKey: runKeyRef.current }).catch(() => {});
                    }
                  }}>{cancelling ? 'Cancelling…' : '■ Cancel'}</button>}
                </div>
                {scratchBlocked && <p className="dv-desc">{scratchBlocked}</p>}
                {scratchError && <div className="proc-error-bar">{scratchError}</div>}
                {scratchRecords.length > 0 && (
                  <div className="mnt-results">
                    <h4>Scratch requiring cleanup</h4>
                    {scratchRecords.map(record => (
                      <div key={record.run_key} className="sqp-finding">
                        <div className="sqp-f-title"><b>{record.name}</b> · {record.status}</div>
                        <div className="sqp-f-detail">{record.engine} · session {record.session_id}</div>
                        {record.error && <div className="sqp-f-detail">{record.error}</div>}
                        {record.status === 'active' && !cloneResults[record.run_key] && (
                          <button
                            className="toolbar-btn"
                            disabled={cloning !== null || executing !== null || cleaning !== null || !!scratchBlocked || record.connection_id !== session.connectionId}
                            title={record.connection_id !== session.connectionId
                              ? 'The initial native clone requires the source and scratch on the same connection'
                              : 'Clone catalog structure and foreign keys; do not execute migration SQL'}
                            onClick={() => void cloneScratch(record)}
                          >
                            {cloning === record.run_key ? 'Cloning…' : 'Clone before-state'}
                          </button>
                        )}
                        {cloning === record.run_key && <button className="cancel-btn" onClick={() => {
                          void invoke('cancel_watched', { runKey: record.run_key }).catch(() => {});
                        }}>■ Cancel clone</button>}
                        {cloneResults[record.run_key] && (
                          <div className="sqp-f-evidence">
                            {cloneResults[record.run_key].tables_cloned} tables · {cloneResults[record.run_key].foreign_keys_added} foreign keys · {cloneResults[record.run_key].statements_executed}/{cloneResults[record.run_key].total_statements} clone statements
                          </div>
                        )}
                        {record.status === 'active' && cloneResults[record.run_key] && !executionResults[record.run_key] && (
                          <button
                            className="primary"
                            disabled={executing !== null || cleaning !== null || cloning !== null || !!scratchBlocked
                              || cloneResults[record.run_key].statements_executed !== cloneResults[record.run_key].total_statements}
                            title="Execute the exact reviewed SQL hash once on one pinned scratch connection"
                            onClick={() => void executeScratch(record)}
                          >
                            {executing === record.run_key ? 'Executing…' : '▶ Execute migration in scratch'}
                          </button>
                        )}
                        {executing === record.run_key && <button className="cancel-btn" onClick={() => {
                          setExecutionCancelling(true);
                          void invoke('cancel_watched', { runKey: record.run_key }).catch(() => {});
                        }}>{executionCancelling ? 'Cancelling…' : '■ Cancel execution'}</button>}
                        {executionResults[record.run_key] && (
                          <div className="sqp-f-evidence">
                            <div><b>{executionResults[record.run_key].ok ? 'Execution complete' : executionResults[record.run_key].cancelled ? 'Execution cancelled' : 'Execution stopped'}</b> · {executionResults[record.run_key].executed}/{executionResults[record.run_key].statement_total} succeeded · backend {executionResults[record.run_key].backend_id ?? 'unknown'} · {executionResults[record.run_key].ms} ms</div>
                            {executionResults[record.run_key].statements.map(statement => (
                              <div key={statement.number}>#{statement.number} · line {statement.line} · {statement.ms} ms · {statement.ok ? 'ok' : statement.error}</div>
                            ))}
                            <div>{executionResults[record.run_key].ok
                              ? verificationResults[record.run_key]?.differences.length === 0 && verificationResults[record.run_key]?.unverified.length === 0
                                ? 'Exact SQL hash executed and final objects verified. Rehearsal proof is complete.'
                                : 'Exact SQL hash executed. Final comparison is still required for rehearsal proof.'
                              : 'Partial objects may remain and were not rolled back. This scratch cannot be executed again.'}</div>
                          </div>
                        )}
                        {executionResults[record.run_key]?.ok && draft?.phase === 'reviewed' && (
                          <button className="primary" disabled={verifying !== null || cleaning !== null} onClick={() => void verifyScratch(record)}>
                            {verifying === record.run_key ? 'Comparing…' : verificationResults[record.run_key] ? '↻ Recheck final objects' : '▶ Compare final objects'}
                          </button>
                        )}
                        {verificationResults[record.run_key] && (
                          <div className="sqp-f-evidence">
                            <div><b>{verificationResults[record.run_key].differences.length === 0 && verificationResults[record.run_key].unverified.length === 0 ? 'Final model matches' : 'Rehearsal proof withheld'}</b> · {verificationResults[record.run_key].expectedTables.length} expected/{verificationResults[record.run_key].actualTables.length} actual tables · {verificationResults[record.run_key].differences.length} differences · {verificationResults[record.run_key].unverified.length} unverified</div>
                            {verificationResults[record.run_key].notes.map(note => <div key={note}>Explained: {note}</div>)}
                            {verificationResults[record.run_key].differences.map(difference => <div key={difference}>Difference: {difference}</div>)}
                            {verificationResults[record.run_key].unverified.map(reason => <div key={reason}>Unverified: {reason}</div>)}
                          </div>
                        )}
                        <button
                          className="toolbar-btn"
                          disabled={cleaning !== null || cloning !== null || executing !== null || verifying !== null || deploying
                            || (draft?.rehearsalProof?.scratch.runKey === record.run_key && ['rehearsed', 'ready'].includes(draft.phase))}
                          title={draft?.rehearsalProof?.scratch.runKey === record.run_key && ['rehearsed', 'ready'].includes(draft.phase)
                            ? 'Keep the completed rehearsal record until deployment finishes; it authorizes the exact source/hash binding'
                            : 'Drop this generated scratch object'}
                          onClick={() => void cleanupScratch(record.run_key)}
                        >
                          {cleaning === record.run_key ? 'Dropping…' : 'Drop scratch'}
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </section>
              <section>
                <h3>Target deployment</h3>
                <p className="dv-desc">Runs the original statements sequentially on one dedicated target connection after a complete Rust preflight. Each statement commits independently; failure or cancellation never implies rollback.</p>
                {draft && ['rehearsed', 'ready'].includes(draft.phase) && !confirmDeployment && !deploying && (
                  <button className="primary" disabled={!schema?.trim() || !!preflightError || !preflight} onClick={() => setConfirmDeployment(true)}>
                    Prepare target deployment
                  </button>
                )}
                {confirmDeployment && draft && (
                  <div className="mnt-warn">
                    <StatusIcon kind="pending" />
                    <div>
                      <div><b>Confirm exact deployment target</b></div>
                      <div>{session.connectionName} · {draft.database} · {preflight?.statement_count ?? 0} statements</div>
                      <div>SQL SHA-256: {draft.sqlSha256}</div>
                      <div>Rehearsal run: {draft.rehearsalProof?.scratch.runKey}</div>
                      <div>There is no automatic rollback. The run ID is single-use and every attempted statement is audited.</div>
                      <div className="row-actions">
                        <button className="danger-btn" onClick={() => void deploy()}>Deploy exact SQL now</button>
                        <button className="toolbar-btn" onClick={() => setConfirmDeployment(false)}>Cancel</button>
                      </div>
                    </div>
                  </div>
                )}
                {deploying && (
                  <button className="cancel-btn" onClick={() => {
                    if (deploymentRunRef.current) {
                      setDeploymentCancelling(true);
                      void invoke('cancel_watched', { runKey: deploymentRunRef.current }).catch(() => {});
                    }
                  }}>{deploymentCancelling ? 'Cancelling…' : '■ Cancel deployment'}</button>
                )}
                {deploymentProgress && (
                  <div className="sqp-f-evidence">
                    <b>{deploying ? 'Deployment running' : draft?.phase === 'verifying' ? 'Awaiting target verification' : draft?.phase === 'done' ? 'Deployment and verification complete' : 'Deployment stopped'}</b> · {deploymentProgress.committed} committed · {deploymentProgress.unknown} unknown · {deploymentProgress.failed} failed · {deploymentProgress.notStarted} not started · backend {deploymentProgress.backendId ?? deploymentResult?.backend_id ?? 'unknown'}
                  </div>
                )}
                {deploymentResult?.statements.map(statement => (
                  <div key={statement.number} className="sqp-f-detail">#{statement.number} · line {statement.line} · {statement.ms} ms · {statement.ok ? 'committed' : statement.error}</div>
                ))}
                {draft?.phase === 'verifying' && deploymentResult?.ok && (
                  <button className="primary" disabled={targetVerifying} onClick={() => void verifyTarget()}>
                    {targetVerifying ? 'Verifying target…' : targetVerification ? '↻ Recheck deployed target' : '▶ Verify deployed target'}
                  </button>
                )}
                {targetVerification && (
                  <div className="sqp-f-evidence">
                    <div><b>{targetVerification.differences.length === 0 && targetVerification.unverified.length === 0 ? 'Target model matches' : 'Final verification withheld'}</b> · {targetVerification.expectedTables.length} expected/{targetVerification.actualTables.length} scoped actual tables · {targetVerification.outOfScopeTables.length} unrelated excluded · {targetVerification.differences.length} differences · {targetVerification.unverified.length} unverified</div>
                    {targetVerification.notes.map(note => <div key={note}>Scope: {note}</div>)}
                    {targetVerification.differences.map(difference => <div key={difference}>Difference: {difference}</div>)}
                    {targetVerification.unverified.map(reason => <div key={reason}>Unverified: {reason}</div>)}
                  </div>
                )}
                {draft?.phase === 'done' && (
                  <div className="mnt-bulk-cost c-metadata">
                    <StatusIcon kind="ok" />
                    <span>Deployed target verified — every modeled table, column, index and foreign key in scope checked. Migration done.</span>
                  </div>
                )}
                {draft?.stopReason && <div className="proc-error-bar">{draft.stopReason.message}</div>}
              </section>
            </div>
            <div className="sqp-right">
              {result && summary && (
                <>
                  <div className={`mnt-bulk-cost ${result.catalogComplete ? 'c-metadata' : 'c-rebuild'}`}>
                    <StatusIcon kind={result.catalogComplete ? 'ok' : 'pending'} />
                    <span>{result.catalogComplete
                      ? `Live before-state — ${result.catalog!.tables.length} catalog tables loaded`
                      : 'Migration-only — no complete live before-state; not live verified'}</span>
                  </div>
                  <div className="sqp-sev-row">
                    <span className="sqp-sev">{summary.supported}/{summary.statements} modeled</span>
                    <span className="sqp-sev">{summary.unsupported} unsupported</span>
                    <span className="sqp-sev">{summary.destructive} destructive</span>
                    <span className="sqp-sev">{summary.rebuilds} rebuilds</span>
                  </div>
                  {preflightError && (
                    <div className="mnt-warn">
                      <StatusIcon kind="error" />
                      <span>Backend preflight refused: {preflightError}</span>
                    </div>
                  )}
                  {preflight && (
                    <section>
                      <h3>Backend preflight</h3>
                      <div className="mnt-bulk-cost c-metadata">
                        <StatusIcon kind="ok" />
                        <span>SQL hash verified · stop on first error · no deployment has run</span>
                      </div>
                      <div className="sqp-f-detail">
                        {preflight.statement_count} statements · {preflight.affected_objects.length} affected objects · {preflight.destructive} destructive · {preflight.lossy} lossy · {preflight.implicit_commits} implicit commits
                      </div>
                      <div className="sqp-f-evidence">
                        Environment: {preflight.environment ?? 'unspecified'} · read-only: {preflight.read_only ? 'yes' : 'no'} · prod DDL opt-in: {preflight.prod_allow_ddl ? 'yes' : 'no'} · unfiltered-write opt-in: {preflight.prod_allow_unfiltered_write ? 'yes' : 'no'}
                      </div>
                      <div className="sqp-f-detail">Affected objects, in ordered migration sequence: {preflight.affected_objects.join(', ') || 'none named'}</div>
                    </section>
                  )}
                  {(summary.unsupported > 0 || !result.catalogComplete) && (
                    <div className="mnt-warn">
                      <StatusIcon kind="error" />
                      <span>{summary.unsupported > 0
                        ? `${summary.unsupported} unsupported statement(s) are a named rehearsal blocker, never an assumed-safe pass.`
                        : 'Rehearsal requires a complete live before-state.'}</span>
                    </div>
                  )}
                  <section>
                    <h3>Statements</h3>
                    {result.review.statements.map(statement => (
                      <div key={statement.number} className="sqp-finding">
                        <div className="sqp-f-title">
                          <b>{statement.number}. {statement.supported ? 'Modeled' : 'Unsupported'}</b> — {statement.summary}
                        </div>
                        <div className="sqp-f-evidence">
                          Line {statement.line}, column {statement.col} · {statement.kind}
                          {preflight?.statements[statement.number - 1]?.implicit_commit ? ' · implicit commit' : ''}
                        </div>
                        {statement.cost && (
                          <div className="sqp-f-evidence">
                            {statement.cost.operation} · {statement.cost.algorithm}/{statement.cost.lock}
                            {statement.cost.rebuild ? ' · rebuild' : ''}
                            {statement.cost.seconds == null ? ' · duration unknown' : ` · ~${statement.cost.seconds}s`}
                            {statement.cost.blockedSeconds == null ? '' : ` · writes blocked ~${statement.cost.blockedSeconds}s`}
                            {statement.cost.diskBytes == null ? '' : ` · extra disk ~${statement.cost.diskBytes} bytes`}
                          </div>
                        )}
                      </div>
                    ))}
                  </section>
                  <section>
                    <h3>Findings</h3>
                    {findings.length === 0 && <p className="dv-desc">No findings.</p>}
                    {findings.map((finding, index) => (
                      <div key={`${finding.id}-${index}`} className={`sqp-finding sqp-${finding.severity}`}>
                        <div className="sqp-f-title">{SEVERITY_ICON[finding.severity]} <b>{finding.id}</b> — {finding.title}</div>
                        <div className="sqp-f-detail">{finding.detail}</div>
                        {finding.at && <div className="sqp-f-evidence">Line {finding.at.line}{finding.at.col ? `, column ${finding.at.col}` : ''}</div>}
                        {finding.snippet && <code className="sqp-f-snippet">{finding.snippet}</code>}
                      </div>
                    ))}
                  </section>
                  <section>
                    <h3>Final table model</h3>
                    {result.review.tables.length === 0 && <p className="dv-desc">No tables in the final model.</p>}
                    {result.review.tables.map(table => (
                      <div key={table.name} className="sqp-finding">
                        <div className="sqp-f-title"><b>{table.name}</b> — {table.complete ? 'complete' : 'partial'} · {table.source}</div>
                        <div className="sqp-f-detail">
                          {table.columns.length} columns · {table.indexes.length} indexes · {table.foreignKeys.length} foreign keys
                        </div>
                      </div>
                    ))}
                  </section>
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
