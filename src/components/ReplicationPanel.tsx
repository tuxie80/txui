/**
 * Replication dashboard — multi-channel aware, health first.
 *
 * MySQL multi-source replication returns one `SHOW REPLICA STATUS` row per
 * channel; the backend emits one section each. Here we render channels as a
 * summary **table (one row per channel)** with the vital columns (IO/SQL
 * thread, seconds behind, source), and each row expands inline to the curated
 * detail fields (positions, GTIDs, errors…). A prominent **collapsed-channel
 * alert** surfaces the actual error text (Last_IO/SQL/Error) whenever a
 * thread is not running — so a stalled channel and its cause are impossible
 * to miss. The "all fields" dump remains as a final fallback.
 *
 * Non-channel sections (connected replicas, PostgreSQL standby/slots) render
 * as key/value blocks or tables as before.
 *
 * Refresh: polls `replication_status` every 5s (pause-able) through one
 * interval; a successful poll stamps "updated HH:MM:SS" in the toolbar so
 * the refresh is visible.
 */
import { errorDisplay } from '../utils/appError';
import { useCallback, useState } from 'react';
import {
  pgCreatePublicationSql, pgDropPublicationSql, pgRefreshPublicationSql,
  pgCreateSubscriptionSql, pgDropSubscriptionSql, pgCreateSlotSql, pgDropSlotSql,
} from '../utils/pgObjectSql';
import { invoke } from '@tauri-apps/api/core';
import { usePoll } from '../hooks/usePoll';
import { FastGrid } from './FastGrid';
import {
  type Channel, type Health, type ReplSection,
  isChannelSection, toChannel, isRunning, nonEmpty, channelError,
  channelSummary, visibleDetailRows, kvHealth, KEY_FIELDS, yn, lagHealth,
} from '../utils/replication';

interface Props {
  sessionId: string;
  engine: string;
  onClose: () => void;
}

/** If a poll somehow never settles (backend hang), don't wedge the guard forever. */
const IN_FLIGHT_WATCHDOG_MS = 30_000;

export function ReplicationPanel({ sessionId, engine, onClose }: Props) {
  const isPg = engine === 'postgres';
  const [pubName, setPubName] = useState('');
  const [slotName, setSlotName] = useState('');
  const [subName, setSubName] = useState('');
  const [subConn, setSubConn] = useState('');
  const [subPub, setSubPub] = useState('');
  const emitRepl = (sql: string) => window.dispatchEvent(new CustomEvent('dbgui:insert-sql', { detail: { sql: `\n${sql}\n` } }));
  const [sections, setSections] = useState<ReplSection[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [paused, setPaused] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const body = useCallback(async () => {
    try {
      const s = await invoke<ReplSection[]>('replication_status', { sessionId });
      setSections(s);
      setError(null);
      setUpdatedAt(new Date());
    } catch (e) {
      setError(errorDisplay(e));
    }
  }, [sessionId]);
  // Loop via hooks/usePoll; the watchdog keeps this panel's old behavior — a
  // status call hung on a dead server stops silencing the poll after a while.
  const refresh = usePoll(body, 5, { paused, inFlightGraceMs: IN_FLIGHT_WATCHDOG_MS });

  const channels = (sections ?? []).filter(isChannelSection).map(toChannel);
  const otherSections = (sections ?? []).filter(s => !isChannelSection(s));
  const collapsed = channels.filter(c => !isRunning(c));

  const toggle = (name: string) =>
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name); else next.add(name);
      return next;
    });

  return (
    <div className="proc-panel">
      <div className="proc-toolbar">
        <span className="proc-title">⇄ Replication</span>
        {channels.length > 0 && (
          <span className="repl-chan-count">{channels.length} channel{channels.length === 1 ? '' : 's'}</span>
        )}
        <label className="gsp-check">
          <input type="checkbox" checked={showAll} onChange={e => setShowAll(e.target.checked)} />
          all fields
        </label>
        <button className="toolbar-btn" onClick={() => setPaused(p => !p)}>
          {paused ? '▶ Resume' : '⏸ Pause'}
        </button>
        <button className="toolbar-btn" onClick={refresh}>↻ Refresh</button>
        <div style={{ flex: 1 }} />
        {updatedAt && (
          <span className="repl-updated" title="Last successful refresh">
            updated {updatedAt.toLocaleTimeString()}
          </span>
        )}
        <span className="proc-status" style={{ border: 'none', background: 'none' }}>
          {paused ? 'paused' : 'every 5s'}
        </span>
        <button className="icon-btn" onClick={onClose} title="Close">×</button>
      </div>

      {error && <div className="proc-error-bar">{error}</div>}

      {/* PostgreSQL logical-replication actions — generate DDL into the editor
          (review before running). Complements the read-only monitoring below. */}
      {isPg && (
        <div className="repl-actions">
          <div className="repl-act-row">
            <span className="repl-act-label">Publication</span>
            <input className="td-in" value={pubName} placeholder="name"
              onChange={e => setPubName(e.target.value)} />
            <button className="toolbar-btn" disabled={!pubName.trim()}
              onClick={() => emitRepl(pgCreatePublicationSql(pubName.trim(), { allTables: true }))}>Create (all tables)</button>
            <button className="toolbar-btn" disabled={!pubName.trim()}
              onClick={() => emitRepl(pgDropPublicationSql(pubName.trim()))}>Drop</button>
          </div>
          <div className="repl-act-row">
            <span className="repl-act-label">Slot</span>
            <input className="td-in" value={slotName} placeholder="name"
              onChange={e => setSlotName(e.target.value)} />
            <button className="toolbar-btn" disabled={!slotName.trim()}
              onClick={() => emitRepl(pgCreateSlotSql(slotName.trim(), { logical: true }))}>Create logical</button>
            <button className="toolbar-btn" disabled={!slotName.trim()}
              onClick={() => emitRepl(pgDropSlotSql(slotName.trim()))}>Drop</button>
          </div>
          <div className="repl-act-row">
            <span className="repl-act-label">Subscription</span>
            <input className="td-in" value={subName} placeholder="name" style={{ width: 120 }}
              onChange={e => setSubName(e.target.value)} />
            <input className="td-in" value={subConn} placeholder="host=… dbname=… user=… password=…" style={{ flex: 1, minWidth: 180 }}
              onChange={e => setSubConn(e.target.value)} />
            <input className="td-in" value={subPub} placeholder="publication" style={{ width: 120 }}
              onChange={e => setSubPub(e.target.value)} />
            <button className="toolbar-btn" disabled={!subName.trim() || !subConn.trim() || !subPub.trim()}
              onClick={() => emitRepl(pgCreateSubscriptionSql(subName.trim(), subConn.trim(), [subPub.trim()]))}>Create</button>
            <button className="toolbar-btn" disabled={!subName.trim()}
              onClick={() => emitRepl(pgRefreshPublicationSql(subName.trim()))}>Refresh</button>
            <button className="toolbar-btn" disabled={!subName.trim()}
              onClick={() => emitRepl(pgDropSubscriptionSql(subName.trim()))}>Drop</button>
          </div>
        </div>
      )}

      <div className="repl-body">
        {sections === null && !error && <div className="proc-loading">Loading…</div>}

        {/* Collapsed-channel alerts — a stopped thread + its error, front and center */}
        {collapsed.map(c => (
          <div key={`alert-${c.name}`} className="repl-alert">
            <div className="repl-alert-head">
              ⚠ Channel <b>{c.name}</b> is not replicating — IO {c.io || '—'} · SQL {c.sql || '—'}
            </div>
            {channelError(c)
              ? <div className="repl-alert-err">{channelError(c)}</div>
              : <div className="repl-alert-err repl-alert-noerr">No error text reported (thread stopped manually, or STOP REPLICA issued).</div>}
          </div>
        ))}

        {/* Channel summary — one row per channel; click a row for the full detail */}
        {channels.length > 0 && (
          <div className="repl-section">
            <div className="repl-title">Channels</div>
            <div className="repl-matrix-wrap">
              <table className="repl-matrix repl-summary">
                <thead>
                  <tr>
                    <th className="repl-exp-col" />
                    <th>Channel</th>
                    <th>IO thread</th>
                    <th>SQL thread</th>
                    <th>Seconds behind</th>
                    <th>Source</th>
                  </tr>
                </thead>
                <tbody>
                  {channels.map(c => {
                    const s = channelSummary(c);
                    const open = expanded.has(c.name);
                    return (
                      <ChannelRows key={c.name} channel={c} summary={s} open={open} onToggle={() => toggle(c.name)} />
                    );
                  })}
                </tbody>
              </table>
            </div>
            {!channels.some(c => expanded.has(c.name)) && (
              <div className="repl-hint">Click a channel row for positions, GTIDs, filters and error detail.</div>
            )}
          </div>
        )}

        {/* Full per-channel field dump (on demand) */}
        {showAll && channels.map(c => (
          <div key={`all-${c.name}`} className="repl-section">
            <div className="repl-title">All fields — channel {c.name}</div>
            <table className="repl-kv">
              <tbody>
                {c.kv.map(([k, v]) => {
                  const h: Health = /_(IO|SQL)_Running$/.test(k) ? yn(v)
                    : /Seconds_Behind/i.test(k) ? lagHealth(v)
                    : /error/i.test(k) && nonEmpty(v) ? 'bad' : null;
                  return (
                    <tr key={k} className={h ? `repl-${h}` : ''}>
                      <td className="repl-key">{k}</td>
                      <td className="repl-val">{v || <span className="fg-null">—</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ))}

        {/* Non-channel sections (PG standby / connected replicas / slots) */}
        {otherSections.map((s, si) => (
          <div key={`sec-${si}`} className="repl-section">
            <div className="repl-title">{s.title}</div>
            {s.kv && (
              <table className="repl-kv">
                <tbody>
                  {s.kv
                    .filter(([k, v]) => showAll || KEY_FIELDS.includes(k) || (/error/i.test(k) && nonEmpty(v)))
                    .map(([k, v]) => {
                      const h = kvHealth(k, v);
                      return (
                        <tr key={k} className={h ? `repl-${h}` : ''}>
                          <td className="repl-key">{k}</td>
                          <td className="repl-val">{v || <span className="fg-null">—</span>}</td>
                        </tr>
                      );
                    })}
                </tbody>
              </table>
            )}
            {s.table && (
              <div className="repl-table">
                <FastGrid columns={s.table.columns} rows={s.table.rows} />
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/** Summary row + (when open) the expanded inline detail row for one channel. */
function ChannelRows({ channel, summary, open, onToggle }: {
  channel: Channel;
  summary: ReturnType<typeof channelSummary>;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <>
      <tr
        className={`repl-chan-row ${summary.running ? '' : 'repl-chan-stopped'}`}
        onClick={onToggle}
        title={open ? 'Collapse detail' : 'Expand detail'}
      >
        <td className="repl-exp-col">{open ? '▾' : '▸'}</td>
        <td className={`repl-mx-chan ${summary.running ? 'repl-good' : 'repl-bad'}`}>
          <span className="repl-mx-dot">{summary.running ? '●' : '■'}</span> {summary.name}
        </td>
        <td className={summary.ioHealth ? `repl-${summary.ioHealth}` : ''}>{summary.io}</td>
        <td className={summary.sqlHealth ? `repl-${summary.sqlHealth}` : ''}>{summary.sql}</td>
        <td className={summary.behindHealth ? `repl-${summary.behindHealth}` : ''}>{summary.behind}</td>
        <td className="repl-mono">{summary.source || <span className="fg-null">—</span>}</td>
      </tr>
      {open && (
        <tr className="repl-detail-row">
          <td />
          <td colSpan={5}>
            <table className="repl-kv repl-detail">
              <tbody>
                {visibleDetailRows(channel).map(r => {
                  const v = r.get(channel);
                  const h = r.health?.(channel) ?? (r.errorRow && nonEmpty(v) ? 'bad' : null);
                  return (
                    <tr key={r.label} className={r.errorRow ? 'repl-mx-errrow' : ''}>
                      <td className="repl-key">{r.label}</td>
                      <td className={`${h ? `repl-${h}` : ''} ${r.mono ? 'repl-mono' : ''} ${r.errorRow ? 'repl-mx-err' : ''}`}>
                        {nonEmpty(v) ? v : <span className="fg-null">—</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </td>
        </tr>
      )}
    </>
  );
}
