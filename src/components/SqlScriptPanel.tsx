import { useEffect, useMemo, useRef, useState } from 'react';
import { Channel, invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import type { Session } from '../types';
import { errorDisplay } from '../utils/appError';
import { alertDialog, confirmDialog } from '../utils/appDialog';
import { audited } from '../utils/panelAudit';
import { basename } from '../utils/platform';
import { fmtDuration } from '../utils/fmtDuration';
import {
  applySqlScriptEvent, compressionForSqlScript, formatSqlScriptBytes,
  initialSqlScriptState, sqlScriptCompressionLabel, sqlScriptPercent, validSqlScriptLimitMiB,
  type SqlScriptEvent,
} from '../utils/sqlScript';
import { clearTabActivities, panelTabKey, setActivity } from '../store/tabActivity';
import { StatusIcon } from './StatusIcon';

interface Props {
  session: Session;
  schema?: string | null;
  onClose: () => void;
  onSchemaChanged?: () => void;
}

interface RunSummary {
  statements: number;
  executed: number;
  rows_affected: number;
  uncompressed_bytes: number;
  ms: number;
}

export function SqlScriptPanel({ session, schema, onClose, onSchemaChanged }: Props) {
  const [path, setPath] = useState('');
  const [continueOnError, setContinueOnError] = useState(false);
  const [limitMiB, setLimitMiB] = useState(64);
  const [running, setRunning] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [state, setState] = useState(initialSqlScriptState);
  const runKeyRef = useRef<string | null>(null);
  const mountedRef = useRef(true);
  const logRef = useRef<HTMLDivElement>(null);
  const activityKey = panelTabKey(session.sessionId, 'sqlscript');

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [state.log]);

  const percent = sqlScriptPercent(state.sourceBytes, state.sourceTotal);
  const compression = compressionForSqlScript(path);
  const blockedReason = useMemo(() => {
    if (session.engine !== 'mysql') return 'The built-in script runner currently supports MySQL and MariaDB only.';
    if (session.readOnly) return 'This connection is read-only. Enable writes before running a script.';
    if (running) return 'A script is already running.';
    if (!path) return 'Choose a SQL script or supported compressed/archive file first.';
    if (!validSqlScriptLimitMiB(limitMiB)) return 'Statement limit must be a whole number from 1 to 1024 MiB.';
    return null;
  }, [session.engine, session.readOnly, running, path, limitMiB]);

  useEffect(() => {
    if (!running) { clearTabActivities(activityKey); return; }
    setActivity(activityKey, {
      id: 'sqlscript',
      label: `SQL script ${cancelling ? 'cancelling' : state.phase}`,
      detail: `${basename(state.path || path)} · ${state.executed.toLocaleString()} ok · ${state.failed.toLocaleString()} failed · ${formatSqlScriptBytes(state.uncompressedBytes)}`,
      threads: state.backendId === null ? undefined : [state.backendId],
      survives: true,
      kill: () => {
        if (runKeyRef.current) invoke('cancel_sql_script', { runKey: runKeyRef.current }).catch(() => {});
      },
    });
  }, [activityKey, running, cancelling, state, path]);

  async function browse() {
    try {
      const picked = await open({
        multiple: false,
        filters: [{ name: 'SQL scripts and archives', extensions: ['sql', 'gz', 'zst', 'xz', 'bz2', 'lz4', 'zip'] }],
      });
      if (typeof picked === 'string') {
        setPath(picked);
        setState(initialSqlScriptState());
      }
    } catch { /* dialog dismissed */ }
  }

  async function run() {
    if (blockedReason) {
      if (session.readOnly) await alertDialog(blockedReason);
      return;
    }
    if (session.environment === 'prod') {
      const message = `Run ${basename(path)} on PRODUCTION connection '${session.connectionName}'?\n\n`
        + 'Every statement is checked first, but already committed work cannot be rolled back if a later statement fails.';
      if (!await confirmDialog(message, { danger: true })) return;
    }
    const runKey = crypto.randomUUID();
    runKeyRef.current = runKey;
    setRunning(true);
    setCancelling(false);
    setState(initialSqlScriptState());
    const channel = new Channel<SqlScriptEvent>();
    channel.onmessage = event => {
      if (!mountedRef.current) return;
      setState(previous => applySqlScriptEvent(previous, event));
      if (event.type === 'done') {
        setRunning(false);
        setCancelling(false);
        if (event.executed > 0) onSchemaChanged?.();
      }
    };
    try {
      await audited({
        sessionId: session.sessionId,
        engine: session.engine,
        tab: 'SQL script',
        source: 'dump',
        database: schema ?? '',
        statement: `-- built-in SQL script: ${path} (${compression})`,
        rowsAffected: (result: RunSummary) => result.rows_affected,
        run: () => invoke<RunSummary>('run_sql_script', {
          sessionId: session.sessionId,
          path,
          compression,
          continueOnError,
          maxStatementBytes: limitMiB * 1024 * 1024,
          runKey,
          onEvent: channel,
        }),
      });
      if (mountedRef.current) setRunning(false);
    } catch (error) {
      if (!mountedRef.current) return;
      setRunning(false);
      setCancelling(false);
      setState(previous => previous.done ? previous : applySqlScriptEvent(previous, {
        type: 'done', ok: false, cancelled: false,
        partial: previous.phase === 'executing', ms: 0,
        statements: previous.statementsTotal ?? previous.statementsSeen,
        executed: previous.executed, failed: previous.failed,
        rows_affected: previous.rowsAffected,
        uncompressed_bytes: previous.uncompressedBytes,
        error: errorDisplay(error),
      }));
    }
  }

  async function cancel() {
    if (!runKeyRef.current || cancelling) return;
    setCancelling(true);
    try {
      await invoke('cancel_sql_script', { runKey: runKeyRef.current });
    } catch (error) {
      setCancelling(false);
      setState(previous => ({
        ...previous,
        log: [...previous.log, { kind: 'error', text: `Cancel failed: ${errorDisplay(error)}` }],
      }));
    }
  }

  const statusText = state.phase === 'idle' ? 'Not started'
    : state.phase === 'done'
      ? state.done?.cancelled ? 'Cancelled' : state.done?.ok ? 'Completed' : 'Failed'
      : cancelling ? `Cancelling ${state.phase}` : state.phase === 'validating' ? 'Validating locally' : 'Executing';

  return (
    <div className="ss-root">
      <div className="ss-bar">
        <span className="ss-title">SQL script</span>
        <span className={`ss-status ss-${state.done?.ok ? 'ok' : state.done ? 'err' : 'running'}`}>
          {state.done?.ok && <StatusIcon kind="ok" />} {statusText}
        </span>
        <span className="ss-elapsed">{state.done ? fmtDuration(state.done.ms) : ''}</span>
        <div style={{ flex: 1 }} />
        {running
          ? <button className="toolbar-btn ss-cancel" onClick={cancel} disabled={cancelling}>
              {cancelling ? 'Cancelling…' : 'Cancel'}
            </button>
          : <button className={`primary run-btn ${blockedReason ? 'unavail' : ''}`}
              data-tip={blockedReason ?? 'Validate the whole file, then execute it on this session'}
              onClick={run}>Run script</button>}
        <button className="icon-btn" title="Close" onClick={onClose}>×</button>
      </div>

      <div className="ss-body">
        <div className="ss-form">
          <div className="ss-field">
            <label>Source file (SQL / compressed / archive)</label>
            <div className="ss-target">
              <input value={path} onChange={e => { setPath(e.target.value); setState(initialSqlScriptState()); }}
                disabled={running} placeholder=".sql, .gz, .zst, .xz, .bz2, .lz4, .zip or tar archive" />
              <button className="toolbar-btn" onClick={browse} disabled={running}>Browse…</button>
            </div>
            <div className="ss-hint">
              {path ? `${sqlScriptCompressionLabel(compression)} · ${basename(path)}` : 'No external mysql/mariadb client, shell, zcat or temporary SQL file.'}
            </div>
            <div className="ss-hint">
              Supported: .sql, .sql.gz, .sql.zst, .sql.xz, .sql.bz2, .sql.lz4, .zip, .tar.gz, .tar.xz, .tar.zst.
              ZIP and tar archives must contain exactly one .sql file and no other files.
            </div>
          </div>

          <div className="ss-field">
            <label>Target database</label>
            <div className="ss-value">{state.database ?? schema ?? 'Selected by the database bar above; the script can override it with USE.'}</div>
          </div>

          <div className="ss-field">
            <label>Maximum statement size (MiB)</label>
            <input className="ss-limit" type="number" min={1} max={1024} step={1}
              value={limitMiB} disabled={running}
              onChange={e => setLimitMiB(Number(e.target.value))} />
            <div className="ss-hint">1–1024 MiB. Memory holds streaming buffers, the current statement and one queued statement.</div>
          </div>

          <label className="ss-check">
            <input type="checkbox" checked={continueOnError} disabled={running}
              onChange={e => setContinueOnError(e.target.checked)} />
            <span>Continue after SQL errors (default: stop on first error)</span>
          </label>

          <div className="ss-note">
            Validation first, execution second; LZ4 also receives a separate structural frame-validation read.
            The file must not change. Every statement runs sequentially on one dedicated connection.
            No automatic transaction, retry, resume or rollback is implied.
          </div>

          <div className="ss-progress-head">
            <span>{state.phase === 'executing' ? 'Execution pass' : state.phase === 'validating' ? 'Validation pass' : 'Source progress'}</span>
            <span>{percent}%</span>
          </div>
          <div className="ss-progress" aria-label={`Compressed source progress ${percent}%`}>
            <div style={{ width: `${percent}%` }} />
          </div>
          <div className="ss-progress-bytes">
            {formatSqlScriptBytes(state.sourceBytes)} / {formatSqlScriptBytes(state.sourceTotal)} compressed
          </div>

          <dl className="ss-stats">
            <div><dt>Uncompressed read</dt><dd>{formatSqlScriptBytes(state.uncompressedBytes)}</dd></div>
            <div><dt>Statements seen</dt><dd>{state.statementsSeen.toLocaleString()}{state.statementsTotal === null ? '' : ` / ${state.statementsTotal.toLocaleString()}`}</dd></div>
            <div><dt>Executed</dt><dd>{state.executed.toLocaleString()}</dd></div>
            <div><dt>Failed</dt><dd className={state.failed ? 'ss-error' : ''}>{state.failed.toLocaleString()}</dd></div>
            <div><dt>Rows affected</dt><dd>{state.rowsAffected.toLocaleString()}</dd></div>
            <div><dt>Current source line</dt><dd>{state.currentLine?.toLocaleString() ?? '—'}</dd></div>
            <div><dt>Backend connection</dt><dd>{state.backendId?.toLocaleString() ?? '—'}</dd></div>
            <div><dt>Statement limit</dt><dd>{formatSqlScriptBytes(state.maxStatementBytes)}</dd></div>
          </dl>

          {state.done?.partial && (
            <div className="ss-warning">The run stopped during execution. Statements already committed remain in the database.</div>
          )}
          {state.done?.error && <div className="ss-error-detail">{state.done.error}</div>}
        </div>

        <div className="ss-log-pane">
          <div className="ss-log-head">
            <span>Statement flow</span>
            <span>{state.log.length.toLocaleString()} lines (5,000 retained)</span>
          </div>
          <div className="ss-log" ref={logRef}>
            {state.log.length === 0
              ? <div className="ws-muted">Validation, statement outcomes and final counts appear here. SQL text is not logged.</div>
              : state.log.map((line, index) => (
                  <div key={index} className={`ss-line ss-line-${line.kind}`}>{line.text}</div>
                ))}
          </div>
        </div>
      </div>
    </div>
  );
}
