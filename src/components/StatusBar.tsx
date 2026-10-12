import { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-shell';
import { relaunch } from '@tauri-apps/plugin-process';
import { usePoll } from '../hooks/usePoll';
import { getAllActivities, useActivityVersion } from '../store/tabActivity';
import { useSchemaScan } from '../store/schemaScan';
import { useUpdater, cancelDownload, releaseTagUrl } from '../store/updater';
import { collectRunningTasks } from '../utils/runningTasks';

interface AppMetrics {
  rss_bytes: number;
  cpu_percent: number;
  total_mem_bytes: number;
  used_mem_bytes: number;
}

function formatBytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  if (mb < 1024) return `${mb < 100 ? mb.toFixed(1) : Math.round(mb)} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
}

interface Props {
  /** open sessions, so the popover can name the server each task runs on */
  sessions: { sessionId: string; connectionName: string }[];
}

/**
 * App-wide status bar: the TxUI process's own RAM + CPU, refreshed every 1s,
 * plus — while anything is running on a server — a "⟳ N running" popover
 * naming each task with a way to stop it (store/tabActivity's registry).
 */
export function StatusBar({ sessions }: Props) {
  const [metrics, setMetrics] = useState<AppMetrics | null>(null);
  const [tasksOpen, setTasksOpen] = useState(false);
  // The clock the elapsed column renders against. Date.now() is impure, so it
  // must not be called during render — the 1 s poll tick and the popover-open
  // click refresh it instead (which is also exactly the freshness it needs).
  const [nowMs, setNowMs] = useState(0);
  const [updateOpen, setUpdateOpen] = useState(false);

  // Self-update chip (store/updater): ⇩ while a download runs, ↻ once the
  // bundle is swapped and only a relaunch is left. `failed` renders nothing —
  // the updater never opens a dialog.
  const update = useUpdater();

  // hooks/usePoll with the window-level gate: a minimized window has no
  // status bar to read, so the 1 s app_metrics tick pauses while
  // document.hidden (visibleOnly:false — this poller is not inside a tab).
  usePoll(async () => {
    setNowMs(Date.now());
    try {
      const m = await invoke<AppMetrics>('app_metrics');
      setMetrics(m);
    } catch {
      // keep the previous value; a failed poll is not worth surfacing
    }
  }, 1, { visibleOnly: false, windowVisibleOnly: true });

  // Re-render when the SET of running things changes; payloads (elapsed,
  // progress) are read on demand here, per the registry's contract. The 1 s
  // metrics tick above is what keeps the elapsed column fresh while open.
  useActivityVersion();
  // While the object explorer re-scans, its one-liner sits left-aligned in
  // the bar ("scanning reporting.orders…"); null the rest of the time.
  const scan = useSchemaScan();
  const entries = getAllActivities();
  const rows = collectRunningTasks(
    entries.map(e => ({
      key: e.key,
      sessionId: e.sessionId,
      activity: {
        id: e.activity.id,
        label: e.activity.label,
        detail: e.activity.detail,
        threads: e.activity.threads,
        startedAt: e.activity.startedAt,
        hasKill: !!e.activity.kill,
      },
    })),
    id => sessions.find(s => s.sessionId === id)?.connectionName,
    nowMs,
  );

  /** Fire a task's cancel — the closures are already fire-and-forget. */
  const stopOne = (i: number) => {
    try { void entries[i].activity.kill?.(); } catch { /* best-effort */ }
  };
  const stopAll = () => {
    for (const e of entries) {
      try { void e.activity.kill?.(); } catch { /* best-effort */ }
    }
  };

  return (
    <div className="status-bar">
      {scan && <span className="sb-scan">{scan.text}</span>}
      {update.kind === 'available' && update.action === 'notify' && (
        <button
          className="sb-tasks-btn"
          title="A new TxUI release is out — click for the release page"
          onClick={() => { void open(releaseTagUrl(update.info.version)).catch(() => {}); }}
        >⇩ {update.info.version} available</button>
      )}
      {(update.kind === 'downloading' || (update.kind === 'available' && update.action === 'auto')) && (
        <>
          <button
            className="sb-tasks-btn"
            title="Downloading the update in the background — click for details"
            onClick={() => setUpdateOpen(o => !o)}
          >⇩ downloading{update.kind === 'downloading' && update.pct !== null ? ` ${update.pct} %` : '…'}</button>
          {updateOpen && (
            <>
              <div className="sb-tasks-backdrop" onClick={() => setUpdateOpen(false)} />
              <div className="sb-tasks-pop">
                <div className="sb-tasks-head">
                  <span>
                    Downloading TxUI {update.kind === 'available' ? update.info.version : update.version} in the background
                  </span>
                </div>
                <div className="sb-task">
                  <div className="sb-task-main">
                    <div className="sb-task-detail">
                      Nothing to wait on — keep working. When it is done this turns
                      into a restart button.
                    </div>
                  </div>
                  <button className="toolbar-btn sb-task-stop"
                    onClick={() => { void open(releaseTagUrl(
                      update.kind === 'available' ? update.info.version : update.version)).catch(() => {}); }}>
                    Notes</button>
                  {/* Frontend-side only — the backend finishes and installs
                      anyway (store/updater); the chip just stops telling you. */}
                  <button className="toolbar-btn sb-task-stop"
                    onClick={() => { setUpdateOpen(false); cancelDownload(); }}>
                    Cancel</button>
                </div>
              </div>
            </>
          )}
        </>
      )}
      {update.kind === 'ready' && (
        <button
          className="sb-tasks-btn"
          title={`Version ${update.version} is installed — restart to run it`}
          onClick={() => { void relaunch().catch(() => {}); }}
        >↻ Restart to {update.version}</button>
      )}
      {rows.length > 0 && (
        <>
          <button
            className="sb-tasks-btn"
            title="Still running on your servers — click to see / stop"
            onClick={() => { setNowMs(Date.now()); setTasksOpen(o => !o); }}
          >⟳ {rows.length} running</button>
          {tasksOpen && (
            <>
              <div className="sb-tasks-backdrop" onClick={() => setTasksOpen(false)} />
              <div className="sb-tasks-pop">
                <div className="sb-tasks-head">
                  <span>Still running on the servers</span>
                  {rows.some(r => r.canStop) && (
                    <button className="toolbar-btn sb-task-stop" onClick={stopAll}>Stop all</button>
                  )}
                </div>
                {rows.map((row, i) => (
                  <div className="sb-task" key={row.key}>
                    <div className="sb-task-main">
                      <div className="sb-task-label">
                        {row.label}{row.elapsed ? ` · ${row.elapsed}` : ''}
                      </div>
                      <div className="sb-task-detail" title={row.detail}>
                        {row.sessionName} — {row.detail}
                      </div>
                    </div>
                    {/* A task with no cancel is greyed WITH its reason, never
                        hidden and never `disabled` (a disabled button shows no
                        tooltip) — the repo's unavailability rule. */}
                    {row.canStop ? (
                      <button className="toolbar-btn sb-task-stop" onClick={() => stopOne(i)}>Stop</button>
                    ) : (
                      <span className="unavail"
                        data-tip="TxUI has no cancel for this one — it has to finish on its own">
                        <button className="toolbar-btn sb-task-stop">Stop</button>
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </>
          )}
        </>
      )}
      {metrics && (
        <span>RAM {formatBytes(metrics.rss_bytes)} · CPU {metrics.cpu_percent.toFixed(1)}%</span>
      )}
    </div>
  );
}
