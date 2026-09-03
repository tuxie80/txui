/**
 * Dump / restore workbench — drives mysqldump, mydumper/myloader,
 * pg_dump/pg_restore and mysql/psql with a visible generated command,
 * live streamed output and cancellation. The password never appears in
 * the command; the backend passes it via MYSQL_PWD / PGPASSWORD.
 */
import { errorDisplay } from '../utils/appError';
import { alertDialog, confirmDialog } from '../utils/appDialog';
import { useEffect, useMemo, useRef, useState } from 'react';
import { StatusIcon } from './StatusIcon';
import { invoke, Channel } from '@tauri-apps/api/core';
import { open, save } from '@tauri-apps/plugin-dialog';
import type { ConnectionConfig } from '../types';
import { ConnectionsStore } from '../store/connections';
import type { Mode, ToolSpec, OptionValues } from '../utils/dumpTools';
import {
  specsFor, defaultOptions, previewCommand, splitTables, splitExtraArgs,
} from '../utils/dumpTools';
import { unavailableTip } from '../utils/platformCaps';
import { audited } from '../utils/panelAudit';
import { clearTabActivities, panelTabKey, setActivity } from '../store/tabActivity';

/**
 * Tools that do not exist on every desktop.
 *
 * mydumper and myloader are one upstream project with one Windows story (there
 * is no Windows build), so both map to the same feature id. Everything else
 * here ships for all three and merely has to be found on PATH — a missing
 * mysqldump is "not installed", which is a different sentence with a different
 * fix, and the panel already says it.
 */
const PLATFORM_BOUND: Record<string, 'mydumper' | undefined> = {
  mydumper: 'mydumper',
  myloader: 'mydumper',
};
/** The hover/inline reason this tool cannot run here, or null if it can. */
function platformTip(toolId: string): string | null {
  const f = PLATFORM_BOUND[toolId];
  return f ? unavailableTip(f) : null;
}

const ENGINE_ICON: Record<string, string> = { mysql: '🐬', postgres: '🐘', redis: '⚡' };

interface ToolInfo { tool: string; path: string | null; version: string | null }

type ToolEvent =
  | { type: 'started'; pid: number | null; display_cmd: string }
  | { type: 'line'; stream: string; line: string }
  | { type: 'done'; ok: boolean; exit_code: number | null; ms: number; cancelled: boolean };

interface LogLine { stream: 'stdout' | 'stderr' | 'meta'; line: string }

interface Props { onClose?: () => void }

export function DumpRestorePanel({ onClose }: Props) {
  const [conns, setConns] = useState<ConnectionConfig[]>([]);
  const [tools, setTools] = useState<Map<string, ToolInfo>>(new Map());
  const [connId, setConnId] = useState<string>('');
  const [mode, setMode] = useState<Mode>('dump');
  const [toolId, setToolId] = useState<string>('');
  const [database, setDatabase] = useState('');
  const [tables, setTables] = useState('');
  const [target, setTarget] = useState('');
  const [options, setOptions] = useState<OptionValues>({});
  const [extraArgs, setExtraArgs] = useState('');
  const [running, setRunning] = useState(false);
  const [log, setLog] = useState<LogLine[]>([]);
  const [done, setDone] = useState<{ ok: boolean; code: number | null; ms: number; cancelled: boolean } | null>(null);
  const runKeyRef = useRef<string | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const mountedRef = useRef(true);
  // Set true in the body too — under StrictMode's mount/unmount/mount the ref
  // survives, and a cleanup-only effect would leave it false after remount.
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    ConnectionsStore.list()
      .then(list => setConns(list.filter(c => c.engine !== 'redis' && c.engine !== 'mongodb')))
      .catch(() => {});
    invoke<ToolInfo[]>('probe_dump_tools')
      .then(list => setTools(new Map(list.map(t => [t.tool, t]))))
      .catch(() => {});
  }, []);

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [log]);

  const conn = useMemo(() => conns.find(c => c.id === connId) ?? null, [conns, connId]);
  const specs = useMemo(
    () => (conn ? specsFor(conn.engine, mode) : []),
    [conn, mode]);
  const spec: ToolSpec | null = specs.find(s => s.id === toolId) ?? null;

  // Selecting a connection / mode: pick the first *installed* tool and reset
  // tool-scoped inputs.
  function resetForSpecs(newSpecs: ToolSpec[]) {
    // Preferring an installed tool must not preselect one this desktop cannot
    // run at all — otherwise the panel opens already pointing at a dead end.
    const here = newSpecs.filter(s => !platformTip(s.id));
    const first = here.find(s => tools.get(s.id)?.path) ?? here[0] ?? newSpecs[0];
    setToolId(first ? first.id : '');
    setOptions(first ? defaultOptions(first) : {});
    setTarget('');
    setTables('');
    setExtraArgs('');
    setDone(null);
  }
  function pickConn(id: string) {
    setConnId(id);
    const c = conns.find(x => x.id === id);
    setDatabase(c?.database ?? '');
    resetForSpecs(c ? specsFor(c.engine, mode) : []);
  }
  function pickMode(m: Mode) {
    setMode(m);
    resetForSpecs(conn ? specsFor(conn.engine, m) : []);
  }
  function pickTool(id: string) {
    setToolId(id);
    const s = specs.find(x => x.id === id);
    setOptions(s ? defaultOptions(s) : {});
    setTarget('');
    setDone(null);
  }

  async function browseTarget() {
    if (!spec) return;
    try {
      if (spec.targetKind === 'save-file') {
        const p = await save({ defaultPath: spec.targetDefault });
        if (p) setTarget(p);
      } else if (spec.targetKind === 'directory' || spec.targetKind === 'new-directory') {
        const p = await open({ directory: true });
        if (typeof p === 'string') setTarget(p);
      } else {
        const p = await open({ multiple: false });
        if (typeof p === 'string') setTarget(p);
      }
    } catch { /* dialog dismissed */ }
  }

  const built = useMemo(() => {
    if (!spec || !conn) return null;
    try {
      return spec.build({
        user: conn.user ?? '',
        database,
        tables: spec.supportsTables ? splitTables(tables) : [],
        target: target || `<${spec.targetLabel.toLowerCase()}>`,
        options,
        extraArgs,
      });
    } catch {
      return null;
    }
  }, [spec, conn, database, tables, target, options, extraArgs]);

  const toolInfo = spec ? tools.get(spec.id) : undefined;
  const missingTool = !!spec && !toolInfo?.path;
  const needsDb = spec ? spec.id !== 'myloader' : false;
  const canRun = !!conn && !!spec && !!built && !running && !missingTool
    && !!target && (!needsDb || !!database.trim());

  async function run() {
    if (!conn || !spec || !built || !canRun) return;
    if (spec.mode === 'restore') {
      if (conn.read_only) {
        await alertDialog(`'${conn.name}' is read-only — restore is blocked.`);
        return;
      }
      if (conn.environment === 'prod'
          && !await confirmDialog(`⚠️ '${conn.name}' is tagged PROD.\n\nThis will WRITE into ${database || 'the dump’s original database'} using ${spec.id}. Continue?`, { danger: true })) {
        return;
      }
    }
    const runKey = crypto.randomUUID();
    runKeyRef.current = runKey;
    activityKeyRef.current = panelTabKey(conn.id, 'dump');
    setRunning(true);
    setDone(null);
    setLog([]);
    const chan = new Channel<ToolEvent>();
    chan.onmessage = ev => {
      if (!mountedRef.current) return;
      if (ev.type === 'started') {
        setLog(prev => [...prev, { stream: 'meta', line: `$ ${ev.display_cmd}` }]);
      } else if (ev.type === 'line') {
        setLog(prev => [
          ...prev.slice(-4999),
          { stream: ev.stream === 'stderr' ? 'stderr' : 'stdout', line: ev.line },
        ]);
      } else {
        setDone({ ok: ev.ok, code: ev.exit_code, ms: ev.ms, cancelled: ev.cancelled });
        setRunning(false);
      }
    };
    try {
      // Dumping production, or restoring over a database, is among the most
      // consequential things this app can do and it was recorded nowhere.
      // The command line is audited as the panel previews it — never the
      // password, which the backend passes through MYSQL_PWD / PGPASSWORD and
      // which panelAudit redacts from the free-text extra args regardless.
      //
      // There is no session here (the tool talks to the server itself), so
      // this lands in the 📜 Audit log rather than a session's 📓 Log.
      await audited({
        sessionId: '', connectionName: conn.name,
        engine: conn.engine, tab: '🗄 Dump / Restore', source: 'dump',
        database: database || '',
        statement: `${conn.name}: ${previewCommand(spec.id, built)}`,
        run: () => invoke('run_dump_tool', {
          connectionId: conn.id,
          tool: spec.id,
          args: built.args,
          stdinFile: built.stdinFile ?? null,
          runKey,
          onEvent: chan,
        }),
      });
    } catch (err) {
      if (mountedRef.current) {
        setLog(prev => [...prev, { stream: 'stderr', line: errorDisplay(err) }]);
        setDone(d => d ?? { ok: false, code: null, ms: 0, cancelled: false });
        setRunning(false);
      }
    }
  }

  async function cancel() {
    if (runKeyRef.current) {
      try { await invoke('cancel_dump_tool', { runKey: runKeyRef.current }); } catch { /* gone */ }
    }
  }

  // A dump/restore is an external process that keeps running with this panel
  // closed — the status-bar popover must be able to name it, and cancel it.
  // There is no session here (the tool talks to the server itself), so the
  // registry key is scoped by the connection id, exactly as the backend
  // scopes its cancel handle (`ext_job_key(connection_id, …)`).
  const activityKeyRef = useRef<string | null>(null);
  useEffect(() => {
    const key = activityKeyRef.current;
    if (!key) return;
    if (!running) { clearTabActivities(key); activityKeyRef.current = null; return; }
    setActivity(key, {
      id: 'run',
      label: `${mode === 'dump' ? 'Dump' : 'Restore'} running · ${conn?.name ?? ''}`,
      detail: `${toolId}${database ? ` ${database}` : ''} → ${target}`,
      survives: true,
      kill: () => {
        if (runKeyRef.current) invoke('cancel_dump_tool', { runKey: runKeyRef.current }).catch(() => {});
      },
    });
    // toolId/database/target are fixed once a run starts — re-reading them per
    // render would re-register the same activity with no new information.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, mode, conn?.name]);

  const extraArgCount = splitExtraArgs(extraArgs).length;

  return (
    <div className="dr-root">
      <div className="dr-bar">
        <span className="dr-title">🗄 Dump / Restore</span>
        <div className="dr-mode">
          <button className={mode === 'dump' ? 'dr-seg dr-seg-on' : 'dr-seg'}
            onClick={() => pickMode('dump')}>Dump</button>
          <button className={mode === 'restore' ? 'dr-seg dr-seg-on' : 'dr-seg'}
            onClick={() => pickMode('restore')}>Restore</button>
        </div>
        <div style={{ flex: 1 }} />
        {done && (
          <span className={done.ok ? 'dr-done-ok' : 'dr-done-err'}>
            {done.cancelled ? 'cancelled'
              : done.ok ? <><StatusIcon kind="ok" /> {`finished in ${(done.ms / 1000).toFixed(1)}s`}</>
              : <><StatusIcon kind="error" /> {`failed (exit ${done.code ?? '?'})`}</>}
          </span>
        )}
        {running
          ? <button className="toolbar-btn dr-cancel" onClick={cancel}>■ Cancel</button>
          : <button className="primary run-btn" disabled={!canRun} onClick={run}>
              {mode === 'dump' ? '▶ Dump' : '▶ Restore'}
            </button>}
        {onClose && (
          <button className="icon-btn" title="Close" onClick={async () => {
            if (running && !await confirmDialog('A run is still in progress — closing kills it. Close anyway?', { danger: true })) return;
            if (running) cancel();
            onClose();
          }}>×</button>
        )}
      </div>

      <div className="dr-body">
        <div className="dr-form">
          <div className="dr-field">
            <label>Connection</label>
            <select value={connId} onChange={e => pickConn(e.target.value)}>
              <option value="" disabled>Select a connection…</option>
              {conns.map(c => (
                <option key={c.id} value={c.id}>
                  {ENGINE_ICON[c.engine]} {c.name}
                  {c.environment ? ` [${c.environment.toUpperCase()}]` : ''}
                  {c.read_only ? ' 🔒' : ''}
                </option>
              ))}
            </select>
          </div>

          {/* An engine with no tool for this mode would otherwise render an
              empty <select> and a form that does nothing — the connection is
              listed, so the user has already concluded it should work. Saying
              why, and what to use instead, is the whole of the fix. */}
          {conn && specs.length === 0 && (
            <div className="dr-warn">
              {conn.engine === 'sqlserver' ? (
                <>
                  <b>SQL Server has no client-side dump tool</b> comparable to
                  {' '}<code>mysqldump</code> or <code>pg_dump</code>, so this panel has nothing
                  to drive. <code>BACKUP DATABASE</code> writes to a path <em>the server</em> can
                  see rather than this machine, and <code>mssql-scripter</code> is a separate
                  install that is not a peer of the bundled clients.
                  {' '}Take a <code>BACKUP DATABASE</code> from the SQL editor, or script the
                  schema from 📋 Documenter and the data from ⬇ Export.
                </>
              ) : (
                <>No {mode === 'dump' ? 'dump' : 'restore'} tool is wired for {conn.engine}.</>
              )}
            </div>
          )}

          {conn && specs.length > 0 && (
            <>
              <div className="dr-field">
                <label>Tool</label>
                <select value={toolId} onChange={e => pickTool(e.target.value)}>
                  {specs.map(s => {
                    const info = tools.get(s.id);
                    const off = platformTip(s.id);
                    return (
                      <option key={s.id} value={s.id} disabled={!!off}>
                        {s.label}
                        {off ? ' — not on this platform' : info?.path ? '' : ' — not installed'}
                      </option>
                    );
                  })}
                </select>
                {toolInfo?.version && <div className="dr-hint">{toolInfo.version}</div>}
                {/* A <select> cannot hover-explain a single option, so the
                    reason for the greyed entries is stated once, here. */}
                {specs.some(s => platformTip(s.id)) && (
                  <div className="dr-hint">
                    {specs.filter(s => platformTip(s.id)).map(s => platformTip(s.id))[0]}
                  </div>
                )}
                {missingTool && spec && (
                  <div className="dr-warn">
                    {spec.id} not found — install the DB client tools (mysql-client / mydumper / libpq; on macOS via Homebrew) and reopen this panel.
                  </div>
                )}
              </div>

              <div className="dr-field">
                <label>Database{spec?.id === 'myloader' ? ' (from dump metadata)' : ''}</label>
                <input value={database} onChange={e => setDatabase(e.target.value)}
                  placeholder={spec?.id === 'myloader' ? 'optional — dump decides' : 'database name'} />
              </div>

              {spec?.supportsTables && (
                <div className="dr-field">
                  <label>Tables (optional, space/comma-separated)</label>
                  <input value={tables} onChange={e => setTables(e.target.value)}
                    placeholder="all tables" />
                </div>
              )}

              {spec && (
                <div className="dr-field">
                  <label>{spec.targetLabel}</label>
                  <div className="dr-target">
                    <input value={target} onChange={e => setTarget(e.target.value)}
                      placeholder={spec.targetKind === 'save-file' ? spec.targetDefault : ''} />
                    <button className="toolbar-btn" onClick={browseTarget}>Browse…</button>
                    {spec.id === 'pg_restore' && (
                      /* directory-format archives are directories — file picker can't select them */
                      <button className="toolbar-btn" onClick={async () => {
                        try {
                          const p = await open({ directory: true });
                          if (typeof p === 'string') setTarget(p);
                        } catch { /* dismissed */ }
                      }}>Dir…</button>
                    )}
                  </div>
                </div>
              )}

              {spec && spec.options.length > 0 && (
                <div className="dr-opts">
                  {spec.options.map(o => (
                    <div key={o.key} className="dr-opt" title={o.hint}>
                      {o.kind === 'flag' ? (
                        <label className="dr-check">
                          <input type="checkbox" checked={!!options[o.key]}
                            onChange={e => setOptions(p => ({ ...p, [o.key]: e.target.checked }))} />
                          <span>{o.label}</span>
                        </label>
                      ) : (
                        <label className="dr-inline">
                          <span>{o.label}</span>
                          <input
                            type={o.kind === 'number' ? 'number' : 'text'}
                            value={String(options[o.key] ?? '')}
                            placeholder={o.placeholder}
                            onChange={e => setOptions(p => ({
                              ...p,
                              [o.key]: o.kind === 'number' ? Number(e.target.value) : e.target.value,
                            }))} />
                        </label>
                      )}
                    </div>
                  ))}
                </div>
              )}

              <div className="dr-field">
                <label>Extra arguments{extraArgCount > 0 ? ` (${extraArgCount})` : ''}</label>
                <input value={extraArgs} onChange={e => setExtraArgs(e.target.value)}
                  placeholder="appended verbatim, quote-aware" />
              </div>

              {spec && built && (
                <div className="dr-preview-wrap">
                  <label>Command</label>
                  <pre className="dr-preview">{
                    // Without a tunnel the endpoint is known now — show it; with
                    // SSH the placeholders resolve to the tunnel at spawn time.
                    previewCommand(spec.id, conn.use_ssh ? built : {
                      ...built,
                      args: built.args.map(a => a
                        .replaceAll('{{host}}', conn.host ?? 'localhost')
                        .replaceAll('{{port}}', String(conn.port ?? (conn.engine === 'mysql' ? 3306 : 5432)))),
                    })
                  }</pre>
                  <div className="dr-hint">
                    password via {conn.engine === 'mysql' ? 'MYSQL_PWD' : 'PGPASSWORD'} — never on the command line
                    {conn.use_ssh && <> · {'{{host}}'}/{'{{port}}'} resolve to an SSH tunnel opened for this run</>}
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        <div className="dr-log-pane">
          <div className="dr-log-head">
            <span>Output</span>
            {log.length > 0 && !running && (
              <button className="toolbar-btn" onClick={() => setLog([])}>Clear</button>
            )}
          </div>
          <div className="dr-log" ref={logRef}>
            {log.length === 0
              ? <div className="ws-muted">Tool output appears here.</div>
              : log.map((l, i) => (
                  <div key={i} className={`dr-line dr-line-${l.stream}`}>{l.line}</div>
                ))}
          </div>
        </div>
      </div>
    </div>
  );
}
