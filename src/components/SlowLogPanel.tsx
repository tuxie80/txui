/**
 * Slow-query-log analyzer — the pt-query-digest fallback for when
 * performance_schema is off or you need history it doesn't keep. Open a slow
 * log file; it's parsed and grouped by statement fingerprint, ranked by total
 * time. Parsing/aggregation is in utils/slowLogParse (pure, tested); this reads
 * the file and renders.
 */
import { useState } from 'react';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { Channel, invoke } from '@tauri-apps/api/core';
import type { Session } from '../types';
import { errorDisplay } from '../utils/appError';
import { parseSlowLog, groupSlowLog, type SlowEntry, type SlowGroup } from '../utils/slowLogParse';

interface Props { session: Session; onClose: () => void; }

const fmtMs = (ms: number) => ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${ms.toFixed(1)} ms`;

export function SlowLogPanel({ onClose }: Props) {
  const [groups, setGroups] = useState<SlowGroup[] | null>(null);
  const [file, setFile] = useState<string>('');
  const [entries, setEntries] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const openFile = async () => {
    setError(null);
    try {
      const picked = await openDialog({
        multiple: false,
        filters: [{ name: 'Slow log', extensions: ['log', 'slow', 'txt'] }, { name: 'All files', extensions: ['*'] }],
      });
      if (!picked || Array.isArray(picked)) return;
      setBusy(true);
      // Streamed in bounded chunks (the file can be 100+ MB); each parseable
      // segment is cut at a record boundary (`# Time:` / `# User@Host:` line)
      // so entries never straddle chunks. The backend's `done` message — not
      // the invoke resolution — ends the stream: channel messages are
      // delivered asynchronously and can trail the command's return.
      const es: SlowEntry[] = [];
      let carry = '';
      await new Promise<void>((resolve, reject) => {
        const chan = new Channel<{ text: string | null; done: boolean }>();
        chan.onmessage = (m) => {
          if (m.done) {
            es.push(...parseSlowLog(carry));
            resolve();
            return;
          }
          const buf = carry + (m.text ?? '');
          const cut = Math.max(buf.lastIndexOf('\n# Time:'), buf.lastIndexOf('\n# User@Host:'));
          if (cut > 0) {
            es.push(...parseSlowLog(buf.slice(0, cut + 1)));
            carry = buf.slice(cut + 1);
          } else {
            carry = buf;
          }
        };
        invoke('read_slow_log', { path: picked, onChunk: chan }).catch(reject);
      });
      setEntries(es.length);
      setGroups(groupSlowLog(es));
      setFile(picked);
    } catch (e) {
      setError(errorDisplay(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="proc-panel">
      <div className="proc-toolbar">
        <span className="proc-title">🐢 Slow-log analyzer</span>
        <button className="primary" disabled={busy} onClick={() => void openFile()}>
          {busy ? 'Parsing…' : 'Open slow log…'}
        </button>
        {file && <span className="dv-desc">{file.split(/[\\/]/).pop()} · {entries.toLocaleString()} statements · {groups?.length ?? 0} shapes</span>}
        <div style={{ flex: 1 }} />
        <button className="icon-btn" onClick={onClose} title="Close">×</button>
      </div>

      {error && <div className="proc-error-bar">{error}</div>}

      {!groups && !error && (
        <div className="mnt-note">
          Open a MySQL/MariaDB slow-query-log file. It groups statements by shape (literals normalized)
          and ranks them by total time — the queries worth fixing first.
        </div>
      )}

      {groups && (
        <div className="slowlog-result">
          <table className="td-table">
            <thead>
              <tr><th>Statement shape</th><th>count</th><th>total time</th><th>avg</th><th>max</th><th>rows examined</th></tr>
            </thead>
            <tbody>
              {groups.slice(0, 200).map((g, i) => (
                <tr key={i}>
                  <td className="slowlog-sample" title={g.sample}>{g.sample}</td>
                  <td style={{ textAlign: 'right' }}>{g.count.toLocaleString()}</td>
                  <td style={{ textAlign: 'right' }}>{fmtMs(g.totalMs)}</td>
                  <td style={{ textAlign: 'right' }}>{fmtMs(g.avgMs)}</td>
                  <td style={{ textAlign: 'right' }}>{fmtMs(g.maxMs)}</td>
                  <td style={{ textAlign: 'right' }}>{g.rowsExamined.toLocaleString()}</td>
                </tr>
              ))}
              {groups.length === 0 && <tr><td colSpan={6} className="mnt-empty">No slow statements found in this file.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
