import { useEffect, useRef, useState } from 'react';
import { StatusIcon } from './StatusIcon';
import { invoke } from '@tauri-apps/api/core';
import { confirmDialog } from '../utils/appDialog';

interface HistoryEntry {
  id: number;
  connection_id: string;
  engine: string;
  sql: string;
  execution_ms: number;
  rows_returned: number;
  error: string | null;
  created_at: string;
}

interface Props {
  connectionId: string;
  onSelect: (sql: string) => void;
  onClose: () => void;
}

export function HistoryPanel({ connectionId, onSelect, onClose }: Props) {
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  // Monotonic request id — a slow earlier query must never overwrite a newer
  // one's results (out-of-order responses while typing).
  const reqRef = useRef(0);
  const debounceRef = useRef<number | undefined>(undefined);

  async function load(q?: string) {
    const req = ++reqRef.current;
    setLoading(true);
    try {
      const rows: HistoryEntry[] = await invoke('search_history', {
        connectionId,
        query: q || null,
        limit: 200,
      });
      if (req === reqRef.current) setEntries(rows);
    } finally {
      if (req === reqRef.current) setLoading(false);
    }
  }

  useEffect(() => {
    load();
    const req = reqRef;
    const debounce = debounceRef;
    // Invalidate any in-flight request and clear the pending debounce so a
    // late response can't setState after unmount / connection change.
    return () => { req.current++; if (debounce.current) window.clearTimeout(debounce.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionId]);

  async function handleDelete(id: number, e: React.MouseEvent) {
    e.stopPropagation();
    await invoke('delete_history_entry', { id });
    setEntries(prev => prev.filter(e => e.id !== id));
  }

  async function handleClearAll() {
    if (!await confirmDialog('Clear all history for this connection?', { danger: true, okLabel: 'Clear' })) return;
    await invoke('clear_connection_history', { connectionId });
    setEntries([]);
  }

  function handleSearch(q: string) {
    setSearch(q);
    if (debounceRef.current) window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => load(q || undefined), 200);
  }

  return (
    <div className="history-panel">
      <div className="history-header">
        <span className="history-title">Query history</span>
        <div style={{ display: 'flex', gap: 6 }}>
          <button className="icon-btn" onClick={handleClearAll} title="Clear all">🗑</button>
          <button className="icon-btn" onClick={onClose} title="Close">×</button>
        </div>
      </div>

      <div className="history-search">
        <input
          value={search}
          onChange={e => handleSearch(e.target.value)}
          placeholder="Filter history…"
          autoFocus
        />
      </div>

      <div className="history-list">
        {loading && <div className="history-empty">Loading…</div>}
        {!loading && entries.length === 0 && (
          <div className="history-empty">No history yet.</div>
        )}
        {entries.map(entry => (
          <div
            key={entry.id}
            className={`history-item ${entry.error ? 'has-error' : ''}`}
            onClick={() => onSelect(entry.sql)}
          >
            <pre className="history-sql">{entry.sql.length > 200 ? entry.sql.slice(0, 200) + '…' : entry.sql}</pre>
            <div className="history-meta">
              <span>{entry.created_at.replace('T', ' ').slice(0, 16)}</span>
              {!entry.error && (
                <span>{entry.rows_returned} rows · {entry.execution_ms}ms</span>
              )}
              {entry.error && <span className="history-err"><StatusIcon kind="error" /> {entry.error.slice(0, 60)}</span>}
              <button
                className="history-delete"
                onClick={e => handleDelete(entry.id, e)}
                title="Delete"
              >×</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
