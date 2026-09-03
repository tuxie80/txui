/**
 * The landing screen's cross-server activity feed — shown in place of the
 * first-run how-to once the user has connections.
 *
 * A compact, read-only window into the 📜 Audit log (the same `audit_list`
 * command, no filters): the newest events across every server, with session
 * connect/disconnect reading as "Connected" / "Disconnected — lasted …".
 * Refreshes on mount, i.e. every time the welcome view is shown again.
 */
import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { errorDisplay } from '../utils/appError';
import { feedRows, type FeedEntry, type FeedRow } from '../utils/welcomeFeed';

const FEED_LIMIT = 30;

export function WelcomeAudit({ onOpenAudit }: { onOpenAudit: () => void }) {
  const [rows, setRows] = useState<FeedRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    invoke<FeedEntry[]>('audit_list', { search: null, limit: FEED_LIMIT })
      .then(entries => setRows(feedRows(entries)))
      .catch(e => setError(errorDisplay(e)));
  }, []);

  return (
    <div className="ws-feed">
      <div className="ws-feed-head">
        <span className="ws-feed-title">Recent activity</span>
        <button className="toolbar-btn" onClick={onOpenAudit}>Open full audit log</button>
      </div>
      {error && <div className="proc-error-bar">{error}</div>}
      {rows && rows.length === 0 && (
        <div className="ws-muted">No activity yet — double-click a connection in the sidebar to open it.</div>
      )}
      {rows && rows.length > 0 && (
        <ul className="ws-feed-list">
          {rows.map(r => (
            <li key={r.id} className={r.ok ? '' : 'ws-feed-err'}>
              <span className="ws-feed-when">{r.when}</span>
              <span className="ws-feed-conn">{r.connection}</span>
              <span className="ws-feed-engine">{r.engine}</span>
              <span className="ws-feed-text">{r.text}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
