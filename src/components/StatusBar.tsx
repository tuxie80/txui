import { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-shell';
import { relaunch } from '@tauri-apps/plugin-process';
import { usePoll } from '../hooks/usePoll';
import { getAllActivities, useActivityVersion } from '../store/tabActivity';
import { useSchemaScan } from '../store/schemaScan';
import { useUpdater, cancelDownload, releaseTagUrl, startDownload } from '../store/updater';
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
  sessions: { sessionId: string; connectionName: string }[];
}

export function StatusBar({ sessions }: Props) {
  const [metrics, setMetrics] = useState<AppMetrics | null>(null);
  const [tasksOpen, setTasksOpen] = useState(false);
  const [nowMs, setNowMs] = useState(0);
  const [updateOpen, setUpdateOpen] = useState(false);
  const { state: update, majorCandidate } = useUpdater();
  const activeVersion = update.kind === 'downloading' || update.kind === 'ready'
    ? update.version
    : update.kind === 'available' ? update.info.version : null;

  usePoll(async () => {
    setNowMs(Date.now());
    try {
      const m = await invoke<AppMetrics>('app_metrics');
      setMetrics(m);
    } catch {
      // Keep the previous value; a failed poll is not worth surfacing.
    }
  }, 1, { visibleOnly: false, windowVisibleOnly: true });

  useActivityVersion();
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
      {majorCandidate && activeVersion !== majorCandidate.version && (
        <button
          className="sb-tasks-btn sb-update-available"
          title={`TxUI ${majorCandidate.version} is available. New releases usually include bug fixes, improvements and new features. Click only when you want to leave your current major branch and install this version.`}
          onClick={() => { void startDownload(majorCandidate, 'latest'); }}
        >⬆ Upgrade to {majorCandidate.version}</button>
      )}
      {update.kind === 'available' && update.action === 'notify'
        && update.info.version !== majorCandidate?.version && (
        <button
          className="sb-tasks-btn sb-update-available"
          title={update.notUpdatable
            ? `TxUI ${update.info.version} is available. This package is owned by your package manager; open the release page.`
            : `TxUI ${update.info.version} is available, probably with bug fixes and feature improvements. Click to download and install it.`}
          onClick={() => {
            if (update.notUpdatable) {
              void open(releaseTagUrl(update.info.version)).catch(() => {});
            } else {
              void startDownload(update.info, 'branch');
            }
          }}
        >⬆ {update.info.version} available</button>
      )}
      {(update.kind === 'downloading' || (update.kind === 'available' && update.action === 'auto')) && (
        <>
          <button
            className="sb-tasks-btn sb-update-download"
            title="Downloading the update in the background — click for details"
            onClick={() => setUpdateOpen(o => !o)}
          ><span aria-hidden="true">↓</span><span>downloading</span><span className="sb-update-pct">{update.kind === 'downloading' && update.pct !== null ? `${update.pct} %` : '…'}</span></button>
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
