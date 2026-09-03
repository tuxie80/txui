/**
 * "This tab is still running something" — the window you get when closing a tab
 * that has live server-side work, instead of losing it silently.
 *
 * It names every activity (statement / job / scenario, plus the server threads
 * it holds) and offers the three honest choices:
 *   • **Kill & close**  — stop the work, then close the tab
 *   • **Close, keep running** — close the window onto it; the work continues on
 *     the server (only offered when the work genuinely survives)
 *   • **Cancel** — the default: change nothing
 */
import { useEffect, useRef } from 'react';
import type { TabActivity } from '../store/tabActivity';
import { closeGuard } from '../utils/tabModel';
import { StatusIcon } from './StatusIcon';

interface Props {
  tabLabel: string;
  /** true when the close is a session DISCONNECT — then nothing keeps running */
  isDisconnect?: boolean;
  activities: TabActivity[];
  onKillAndClose: () => void;
  onCloseKeepRunning: () => void;
  onCancel: () => void;
}

export function CloseTabConfirm({
  tabLabel, isDisconnect = false, activities, onKillAndClose, onCloseKeepRunning, onCancel,
}: Props) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  // Cancel is the default action: focused, and Esc picks it.
  useEffect(() => { cancelRef.current?.focus(); }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  const { canKeepRunning } = closeGuard(activities);
  // A disconnect takes the connection away — nothing of ours survives that.
  const canSurvive = canKeepRunning && !isDisconnect;
  const threads = activities.flatMap(a => a.threads ?? []);
  /** It finished while you were reading — nothing left to decide about. */
  const finished = activities.length === 0;

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal ctc-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <span className="modal-title">⚠ “{tabLabel}” is still running something</span>
          <button className="modal-close" onClick={onCancel}>×</button>
        </div>

        <div className="ctc-body">
          {finished ? (
            <div className="ctc-lead ctc-finished">
              <StatusIcon kind="ok" /> It finished on its own while this window was open — there is nothing left to stop.
              {isDisconnect && ' Disconnecting still ends the session.'}
            </div>
          ) : (
          <div className="ctc-lead">
            {activities.length === 1 ? 'One thing is' : `${activities.length} things are`} still
            running in this tab{isDisconnect ? ' — and this disconnects the session' : ''}:
          </div>
          )}

          <ul className="ctc-list">
            {activities.map(a => (
              <li key={a.id} className="ctc-item">
                <div className="ctc-item-label">{a.label}</div>
                <code className="ctc-item-detail">{a.detail}</code>
                {a.threads && a.threads.length > 0 && (
                  <div className="ctc-item-threads">
                    server thread{a.threads.length > 1 ? 's' : ''}: {a.threads.map(t => `#${t}`).join(' ')}
                  </div>
                )}
                {!a.survives && (
                  <div className="ctc-item-warn">cannot be watched any more once this tab is gone</div>
                )}
                {!a.kill && (
                  <div className="ctc-item-warn">TxUI has no cancel for this one — it has to finish on its own</div>
                )}
              </li>
            ))}
          </ul>

          {!finished && <div className="ctc-note">
            {threads.length > 0
              ? `Kill & close issues a server-side stop for ${threads.length} thread(s) and logs every kill.`
              : 'Kill & close asks the server to stop the work before the tab goes.'}
            {canSurvive && ' Close, keep running leaves it working — you can still see it in ⚡ Processes and kill it later with `kill`/`killall`.'}
          </div>}
        </div>

        <div className="ctc-actions">
          <button ref={cancelRef} className="toolbar-btn ctc-cancel" onClick={onCancel}>
            Cancel (Esc)
          </button>
          <div style={{ flex: 1 }} />
          {finished ? (
            <button className="toolbar-btn ctc-keep" onClick={onCloseKeepRunning}>
              Close tab
            </button>
          ) : (
            <>
              {canSurvive && (
                <button className="toolbar-btn ctc-keep" onClick={onCloseKeepRunning}>
                  Close, keep running
                </button>
              )}
              <button className="toolbar-btn ctc-kill" onClick={onKillAndClose}>
                Kill &amp; close
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
