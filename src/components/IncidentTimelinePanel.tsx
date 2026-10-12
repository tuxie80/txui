/**
 * Incident timeline (🕐) — one chronological per-connection view answering
 * "what happened on this server between 14:00 and 14:30?": audit statements,
 * connect/disconnect lifecycle, deadlocks, digest snapshots, multi-server
 * runs, long-query captures and Galera wsrep transition events, merged into a
 * single newest-first list.
 *
 * Everything shown is LOCAL data (history.db) — no server grant, no engine
 * gate, no polling: Refresh re-reads the window. The backend
 * (`incident_timeline` command) owns the mixed UTC/local timestamp
 * normalization; events arrive with `at_ms` epoch and this panel never parses
 * a timestamp string.
 *
 * Honest edges the footer keeps visible: every store is capped (audit rows by
 * name, 50 deadlocks / 100 long queries / 100 snapshots / 100 Galera events
 * per connection), so "nothing before March" means retention, not a quiet
 * server. And audit rows are keyed by connection NAME — renaming a connection
 * orphans its old rows from this view (docs/FEATURES.md).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { Session } from '../types';
import { errorDisplay } from '../utils/appError';
import { fmtDuration } from '../utils/fmtDuration';
import {
  bucketize, filterKinds, groupByDay, KIND_LABEL, localText, mergeTimeline,
  summarizeTitle, timeOfDay, TIMELINE_KINDS,
} from '../utils/incidentTimeline';
import type { TimelineEvent, TimelineKind } from '../utils/incidentTimeline';

interface Props {
  session: Session;
  onClose: () => void;
}

/** datetime-local input value ('YYYY-MM-DDTHH:MM') of a Date. */
function inputValue(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Parse a datetime-local value; null when incomplete (still typing). */
function parseInput(v: string): Date | null {
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Kinds whose detail holds runnable SQL worth the insert/copy drill-in. */
const SQL_KINDS: ReadonlySet<TimelineKind> = new Set(['audit', 'long_query', 'multi_run']);

export function IncidentTimelinePanel({ session, onClose }: Props) {
  const [events, setEvents] = useState<TimelineEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Default window: today.
  const [from, setFrom] = useState(() => {
    const d = new Date(); d.setHours(0, 0, 0, 0); return inputValue(d);
  });
  const [to, setTo] = useState(() => {
    const d = new Date(); d.setHours(23, 59, 0, 0); return inputValue(d);
  });
  const [enabled, setEnabled] = useState<ReadonlySet<TimelineKind>>(new Set(TIMELINE_KINDS));
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());

  const load = useCallback(async () => {
    const f = parseInput(from);
    const t = parseInput(to);
    setLoading(true);
    setError(null);
    try {
      const rows = await invoke<TimelineEvent[]>('incident_timeline', {
        connectionId: session.connectionId,
        connectionName: session.connectionName,
        // `to` covers the whole picked minute.
        from: f ? localText(f) : null,
        to: t ? localText(new Date(t.getTime() + 59_000)) : null,
        kinds: null,
        limit: 2000,
      });
      setEvents(mergeTimeline(rows));
    } catch (e) {
      setError(errorDisplay(e));
    } finally {
      setLoading(false);
    }
  }, [from, to, session.connectionId, session.connectionName]);

  useEffect(() => { void load(); }, [load]);

  const shown = useMemo(() => filterKinds(events, enabled), [events, enabled]);
  const days = useMemo(() => groupByDay(shown), [shown]);

  /** Density strip: the window in ~48 buckets, height ∝ events inside. */
  const strip = useMemo(() => {
    const f = parseInput(from), t = parseInput(to);
    if (!f || !t || t.getTime() <= f.getTime()) return [];
    const bucketMs = Math.max(60_000, Math.ceil((t.getTime() - f.getTime()) / 48));
    return bucketize(shown, bucketMs);
  }, [shown, from, to]);
  const stripMax = Math.max(1, ...strip.map(b => b.count));

  /** The oldest event in the fetched window — retention is named, so a cap
   *  does not read as "nothing happened". */
  const oldest = events.length > 0 ? events[events.length - 1] : null;

  const toggleKind = (k: TimelineKind) => {
    const next = new Set(enabled);
    if (next.has(k)) next.delete(k); else next.add(k);
    setEnabled(next);
  };
  const toggleRow = (id: string) => {
    const next = new Set(expanded);
    if (next.has(id)) next.delete(id); else next.add(id);
    setExpanded(next);
  };

  /** The SQL a row can hand to the editor, when its kind carries one. */
  const rowSql = (e: TimelineEvent): string | null => {
    if (!SQL_KINDS.has(e.kind)) return null;
    // audit rows keep the statement in `title`; captures/runs in `detail`.
    const sql = e.kind === 'audit' ? e.title : e.detail;
    return sql.trim() ? sql : null;
  };

  const copyDetail = async (e: TimelineEvent) => {
    const text = [e.title, e.detail].filter(s => s.trim()).join('\n');
    try { await navigator.clipboard.writeText(text); } catch { /* clipboard is a convenience */ }
  };

  return (
    <div className="proc-panel">
      <div className="proc-toolbar">
        <span className="proc-title">🕐 Incident timeline</span>
        <input
          type="datetime-local" className="tl-when" value={from}
          data-tip="Window start (local time)"
          onChange={e => setFrom(e.target.value)}
        />
        <span className="dv-desc">→</span>
        <input
          type="datetime-local" className="tl-when" value={to}
          data-tip="Window end (local time)"
          onChange={e => setTo(e.target.value)}
        />
        <button className="toolbar-btn" onClick={() => void load()}>↻ Refresh</button>
        <div style={{ flex: 1 }} />
        <span className="dv-desc">{session.connectionName} · local data, no server queries</span>
        <button className="icon-btn" title="Close" onClick={onClose}>×</button>
      </div>

      <div className="tl-chips">
        {TIMELINE_KINDS.map(k => (
          <button
            key={k}
            className={`qsb-btn${enabled.has(k) ? ' active' : ''}`}
            data-tip={`${enabled.has(k) ? 'Hide' : 'Show'} ${KIND_LABEL[k]} events`}
            onClick={() => toggleKind(k)}
          >{KIND_LABEL[k]}</button>
        ))}
      </div>

      {strip.length > 1 && (
        <div className="tl-strip" data-tip="Event density across the window">
          {strip.map(b => (
            <span
              key={b.start}
              className="tl-strip-bar"
              style={{ height: `${Math.max(8, (b.count / stripMax) * 100)}%` }}
              data-tip={`${new Date(b.start).toLocaleString()} — ${b.count} event${b.count === 1 ? '' : 's'}`}
            />
          ))}
        </div>
      )}

      {error && <div className="proc-error-bar">{error}</div>}

      <div className="tl-list">
        {loading && <div className="history-empty">Loading…</div>}
        {!loading && shown.length === 0 && (
          <div className="history-empty">
            No events in this window.
            {oldest && <> The oldest event on record for this connection is {new Date(oldest.at_ms).toLocaleString()}.</>}
          </div>
        )}
        {!loading && days.map(g => (
          <div key={g.label} className="tl-day">
            <div className="tl-day-head">{g.label}</div>
            {g.events.map(e => (
              <div key={e.id} className={`tl-row${e.ok ? '' : ' tl-bad'}`}>
                <div className="tl-row-main" onClick={() => toggleRow(e.id)}>
                  <span className="tl-time">{timeOfDay(e.at_ms)}</span>
                  <span className={`tl-kind tl-kind-${e.kind}`}>{KIND_LABEL[e.kind]}</span>
                  <span className="tl-title">{summarizeTitle(e)}</span>
                  {e.duration_ms > 0 && (
                    <span className="tl-dur">{fmtDuration(e.duration_ms)}</span>
                  )}
                  {!e.ok && <span className="tl-status">failed</span>}
                </div>
                {expanded.has(e.id) && (
                  <div className="tl-detail">
                    {e.detail && <pre className="tl-detail-text">{e.detail}</pre>}
                    {e.kind === 'audit' && e.title !== e.detail && (
                      <pre className="tl-detail-text">{e.title}</pre>
                    )}
                    <div className="tl-detail-actions">
                      <button className="toolbar-btn" onClick={() => void copyDetail(e)}>Copy</button>
                      {rowSql(e) && (
                        <button
                          className="toolbar-btn"
                          data-tip="Insert this statement into the current editor"
                          onClick={() => window.dispatchEvent(new CustomEvent('dbgui:insert-sql', {
                            detail: { sql: `\n${rowSql(e)}\n` },
                          }))}
                        >Insert into editor</button>
                      )}
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        ))}
      </div>

      <div className="proc-status">
        {shown.length.toLocaleString()} event{shown.length === 1 ? '' : 's'}
        {oldest && (
          <> · oldest retained: {new Date(oldest.at_ms).toLocaleString()}
            {' '}(stores are capped — 50 deadlocks / 100 long queries / 100 snapshots / 100 galera events per connection)</>
        )}
        {' '}· audit rows are keyed by connection name — a rename orphans older rows
      </div>
    </div>
  );
}
