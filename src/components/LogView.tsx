/**
 * 📓 Log view — the per-session activity list and the joined run log, as one
 * component (extracted from QueryTabs, WP-06).
 *
 * Two things justify the extraction:
 *  1. **Subscription locality.** This component — not QueryTabs — subscribes
 *     to the log stores, so a log line re-renders one leaf, not every mounted
 *     session's whole workspace tree.
 *  2. **Windowed rows.** Up to 20 000 entries can be shown in the "All"
 *     scope; only the visible slice (plus a small overscan) is materialized
 *     as DOM, absolutely positioned inside a spacer — the same row-windowing
 *     idea FastGrid uses, simplified for fixed-height single-line rows. The
 *     list is iterated backwards by index (top = newest) instead of building
 *     `map().reverse()` copies per render.
 *
 * Scope state stays in the host (QueryTabs): the view unmounts on result-tab
 * switches and the chosen scope must survive that.
 */
import { memo, useCallback, useLayoutEffect, useRef, useState } from 'react';
import {
  clearLog, clearRunLog, formatLog, formatRunLog, messageOf, nowTs, runLine,
  useRunLog, useSessionLog, type LogEntry,
} from '../store/logStore';
import { toCsv, toJson } from '../utils/exporters';
import { saveTextAs, copyToClipboard } from '../utils/exportersIo';

export type LogScope = 'session' | 'run';

interface Props {
  sid: string;
  connectionName: string;
  scope: LogScope;
  onScope: (s: LogScope) => void;
}

/**
 * Map log entries to a column/row grid for structured (CSV/JSON) export —
 * the same `(columns, rows)` shape the result exporters consume, so the
 * serializers in `utils/exporters.ts` render it unchanged. `connection` is
 * only meaningful in the joined run view, so it is added there alone. `level`
 * carries the status (ok/err/warn/info); an error's text lives in `message`.
 */
function logToRows(entries: readonly LogEntry[], withConn: boolean): { columns: string[]; rows: unknown[][] } {
  const columns = [
    'timestamp',
    ...(withConn ? ['connection'] : []),
    'level', 'action', 'detail', 'message', 'rows', 'ms', 'exec_ms', 'fetch_ms',
  ];
  const rows = entries.map(e => [
    e.stamp.replace(/^\[|\]$/g, ''),
    ...(withConn ? [e.label ?? e.sessionId?.slice(0, 8) ?? ''] : []),
    e.level, e.action, e.detail, messageOf(e),
    e.rows ?? null, e.ms ?? null, e.execMs ?? null, e.fetchMs ?? null,
  ]);
  return { columns, rows };
}

/** Rows drawn beyond the viewport on each side, so scrolling never flashes. */
const OVERSCAN = 12;

export const LogView = memo(function LogView({ sid, connectionName, scope, onScope }: Props) {
  const sessionLog = useSessionLog(sid);
  const runLog = useRunLog();
  const shown = scope === 'run' ? runLog : sessionLog;
  const [popup, setPopup] = useState(false);

  // ── windowing state ──
  const listRef = useRef<HTMLDivElement | null>(null);
  const probeRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewH, setViewH] = useState(400);
  // Row height follows the font scale — measured from a probe row, never
  // hardcoded, so the Settings font stepper cannot desynchronize the math.
  const [rowH, setRowH] = useState(23);
  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const measure = () => {
      setViewH(el.clientHeight);
      const h = probeRef.current?.offsetHeight;
      if (h && h > 0) setRowH(h);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const exportLogAs = useCallback(async (format: 'csv' | 'json') => {
    const isRun = scope === 'run';
    const { columns, rows } = logToRows(isRun ? runLog : sessionLog, isRun);
    const text = format === 'csv' ? toCsv(columns, rows) : toJson(columns, rows);
    const base = isRun ? 'txui-log-all' : `txui-log-${connectionName}`;
    await saveTextAs(text, `${base}.${format}`, format.toUpperCase(), [format]);
  }, [scope, runLog, sessionLog, connectionName]);

  const exportTxt = useCallback(async () => {
    if (scope === 'run') {
      await saveTextAs(formatRunLog(`TxUI log — all connections — ${nowTs()}`),
        'txui-log-all.txt', 'Text', ['txt']);
    } else {
      await saveTextAs(formatLog(sid, `TxUI log — ${connectionName} — ${nowTs()}`),
        `txui-log-${connectionName}.txt`, 'Text', ['txt']);
    }
  }, [scope, sid, connectionName]);

  // Visible display-range [first, last): display index 0 is the NEWEST entry.
  const total = shown.length;
  const first = Math.max(0, Math.floor(scrollTop / rowH) - OVERSCAN);
  const last = Math.min(total, Math.ceil((scrollTop + viewH) / rowH) + OVERSCAN);
  const visible: { e: LogEntry; i: number; d: number }[] = [];
  for (let d = first; d < last; d++) {
    const i = total - 1 - d;            // append-order index (stable key)
    visible.push({ e: shown[i], i, d });
  }

  return (
    <div className="session-log">
      <div className="sl-toolbar">
        <span className="proc-title">
          📓 Log — {scope === 'run' ? 'this run, every connection' : connectionName}
        </span>
        <span className="dv-desc">
          {scope === 'run'
            ? 'every session opened since the app started, including disconnected ones (top = newest)'
            : 'all activity this session (top = newest); 📜 Audit keeps the immutable cross-session record'}
        </span>
        <div style={{ flex: 1 }} />
        {/* Two scopes, one list. The run scope answers "what was happening at
            14:32" across every connection and tab — a question the
            per-session log cannot answer, and loses outright once that
            connection is closed. */}
        <button
          className={`toolbar-btn${scope === 'session' ? ' toolbar-btn-on' : ''}`}
          data-tip="Only this connection"
          onClick={() => onScope('session')}
        >This connection</button>
        <button
          className={`toolbar-btn${scope === 'run' ? ' toolbar-btn-on' : ''}`}
          data-tip="Every connection and tab opened since the app started — disconnected ones included"
          onClick={() => onScope('run')}
        >All ({runLog.length})</button>
        <button className="toolbar-btn" onClick={() => setPopup(true)}>Popup</button>
        <button className="toolbar-btn" onClick={() => copyToClipboard(
          scope === 'run' ? formatRunLog() : formatLog(sid))}>Copy</button>
        <button className="toolbar-btn" onClick={() => void exportTxt()}>Export .txt</button>
        <button className="toolbar-btn" onClick={() => void exportLogAs('csv')}>Export .csv</button>
        <button className="toolbar-btn" onClick={() => void exportLogAs('json')}>Export .json</button>
        <button
          className="toolbar-btn"
          data-tip={scope === 'run'
            ? 'Clear the joined run log — the per-connection logs stay'
            : 'Clear this connection’s log — the joined run log stays'}
          onClick={() => (scope === 'run' ? clearRunLog() : clearLog(sid))}
        >Clear</button>
      </div>
      <div
        className="sl-list"
        ref={listRef}
        onScroll={e => setScrollTop(e.currentTarget.scrollTop)}
      >
        {total === 0 && (
          <div className="mx-empty">No activity yet.</div>
        )}
        {/* Invisible probe: one representative row whose measured height
            drives the windowing math. */}
        <div ref={probeRef} className="sl-line" aria-hidden
          style={{ position: 'absolute', visibility: 'hidden', pointerEvents: 'none', left: 0, right: 0 }}>
          <span className="sl-ts">00:00:00.000</span>
          <code className="sl-sql">probe</code>
        </div>
        {total > 0 && (
          <div style={{ position: 'relative', height: total * rowH }}>
            {/* Key by the ORIGINAL (append-order) index — a reversed-index key
                would shift for every row on each new entry, re-associating
                all nodes. */}
            {visible.map(({ e, i, d }) => (
              <div
                key={i}
                className={`sl-line sl-${e.level}`}
                style={{ position: 'absolute', top: d * rowH, left: 0, right: 0, boxSizing: 'border-box' }}
              >
                <span className="sl-ts">{e.ts}</span>
                {/* In the joined view two identical result lines from two
                    servers are indistinguishable without this. */}
                {scope === 'run' && (
                  <span className="sl-who">{e.label ?? e.sessionId?.slice(0, 8) ?? '?'}</span>
                )}
                <code className="sl-sql" title={scope === 'run' ? runLine(e) : messageOf(e)}>{messageOf(e)}</code>
              </div>
            ))}
          </div>
        )}
      </div>

      {popup && (
        <div className="modal-overlay" onClick={() => setPopup(false)}>
          <div className="modal sqp-rawmodal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <span className="modal-title">
                📓 Log — {scope === 'run' ? 'this run, every connection' : connectionName}
              </span>
              <button className="toolbar-btn" onClick={() => copyToClipboard(
                scope === 'run' ? formatRunLog() : formatLog(sid))}>Copy</button>
              <button className="toolbar-btn" onClick={() => void exportTxt()}>Export .txt</button>
              <button className="toolbar-btn" onClick={() => void exportLogAs('csv')}>Export .csv</button>
              <button className="toolbar-btn" onClick={() => void exportLogAs('json')}>Export .json</button>
              <button className="modal-close" onClick={() => setPopup(false)}>×</button>
            </div>
            {/* The popup shows whatever scope the Log tab is on — switching
                it here as well would be two controls for one state. */}
            <pre className="sqp-rawpre">{scope === 'run' ? formatRunLog() : formatLog(sid)}</pre>
          </div>
        </div>
      )}
    </div>
  );
});
