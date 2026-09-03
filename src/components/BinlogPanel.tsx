/**
 * Binary-log events viewer + point-in-time-recovery helper (MySQL/MariaDB).
 *
 * `SHOW BINARY LOGS` lists the files; picking one runs `SHOW BINLOG EVENTS IN …`
 * to show what actually happened in it. From a selected event position the panel
 * generates (never runs) the `mysqlbinlog` command line for a PITR replay — the
 * recovery step that was previously only reachable by hand.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { QueryResult, Session } from '../types';
import { errorDisplay } from '../utils/appError';
import { escapeLiteral } from '../utils/sqlIdent';

interface Props { session: Session; onClose: () => void; }

export function BinlogPanel({ session, onClose }: Props) {
  const sessionId = session.sessionId;
  const [files, setFiles] = useState<{ name: string; size: number }[]>([]);
  const [file, setFile] = useState<string>('');
  const [events, setEvents] = useState<QueryResult | null>(null);
  const [pos, setPos] = useState<string>('');
  const [stopAt, setStopAt] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const q = useCallback(
    (sql: string) => invoke<QueryResult>('monitor_query', { sessionId, sql }),
    [sessionId]);

  useEffect(() => {
    q('SHOW BINARY LOGS')
      .then(r => {
        const fs = r.rows.map(row => ({ name: String(row[0]), size: Number(row[1] ?? 0) }));
        setFiles(fs);
        if (fs.length && !file) setFile(fs[fs.length - 1].name); // newest by default
      })
      .catch(e => setError(errorDisplay(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadEvents = useCallback(async (f: string) => {
    if (!f) return;
    setBusy(true); setError(null);
    try {
      setEvents(await q(`SHOW BINLOG EVENTS IN ${escapeLiteral(f, session.engine)} LIMIT 500`));
    } catch (e) {
      setError(errorDisplay(e));
    } finally {
      setBusy(false);
    }
  }, [q, session.engine]);

  useEffect(() => { if (file) void loadEvents(file); }, [file, loadEvents]);

  // The generated PITR command line — placeholders for connection details,
  // never executed. --start-position from the selected event, optional stop.
  const pitr = useMemo(() => {
    if (!file) return '';
    const start = pos.trim() ? ` --start-position=${pos.trim()}` : '';
    const stop = stopAt.trim() ? ` --stop-datetime='${stopAt.trim()}'` : '';
    return `mysqlbinlog${start}${stop} '${file}' | mysql -h<host> -P<port> -u<user> -p`;
  }, [file, pos, stopAt]);

  return (
    <div className="proc-panel">
      <div className="proc-toolbar">
        <span className="proc-title">🧷 Binary log events</span>
        <label className="dg-field-inline"><span>File</span>
          <select value={file} onChange={e => setFile(e.target.value)}>
            {files.map(f => <option key={f.name} value={f.name}>{f.name} ({f.size.toLocaleString()} B)</option>)}
          </select>
        </label>
        <button className="toolbar-btn" disabled={busy || !file} onClick={() => void loadEvents(file)}>
          {busy ? 'Loading…' : 'Reload'}
        </button>
        <div style={{ flex: 1 }} />
        <button className="icon-btn" onClick={onClose} title="Close">×</button>
      </div>

      {error && <div className="proc-error-bar">{error}</div>}

      <div className="binlog-pitr">
        <span className="dv-desc">PITR replay (generated — fill in connection, review, then run in a shell):</span>
        <div className="binlog-pitr-row">
          <label className="dg-field-inline"><span>start-position</span>
            <input className="td-in" style={{ width: 120 }} value={pos} placeholder="e.g. 4"
              onChange={e => setPos(e.target.value)} /></label>
          <label className="dg-field-inline"><span>stop-datetime</span>
            <input className="td-in" style={{ width: 200 }} value={stopAt} placeholder="2026-01-01 12:00:00"
              onChange={e => setStopAt(e.target.value)} /></label>
          <button className="toolbar-btn" onClick={() => navigator.clipboard.writeText(pitr)}>Copy command</button>
        </div>
        <code className="binlog-cmd">{pitr}</code>
      </div>

      {events && (
        <div className="binlog-events">
          <table className="td-table">
            <thead>
              <tr>{events.columns.map(c => <th key={c.name}>{c.name}</th>)}</tr>
            </thead>
            <tbody>
              {events.rows.slice(0, 500).map((row, i) => (
                <tr key={i} onClick={() => { const p = events.columns.findIndex(c => c.name === 'Pos'); if (p >= 0) setPos(String(row[p])); }}>
                  {row.map((cell, j) => (
                    <td key={j} className={events.columns[j]?.name === 'Info' ? 'binlog-info' : ''}>
                      {cell === null ? '' : String(cell)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
