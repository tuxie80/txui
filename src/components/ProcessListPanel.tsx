/**
 * Live processlist panel (MySQL SHOW FULL PROCESSLIST / pg_stat_activity)
 * with auto-refresh and one-click kill — the DBA feature no competitor has.
 * Rendered as a full-pane overlay inside the session workspace.
 *
 * "Watch" hands the selected thread to the Watch panel's Statement mode as a
 * PINNED thread (phase + progress, read-only) — the answer to "an ALTER was
 * started elsewhere; is it moving?" Killing stays here, where it is audited.
 */
import { errorDisplay } from '../utils/appError';
import { useCallback, useMemo, useState } from 'react';
import { cellSortKey, compareCellKeys } from '../utils/sortValue';
import { invoke } from '@tauri-apps/api/core';
import type { QueryResult } from '../types';
import type { SortClause } from '../types/browser';
import { FastGrid } from './FastGrid';
import { CopyExportMenu } from './CopyExportMenu';
import type { SelRect } from './FastGrid';
import { executeKill, partialProc } from '../utils/killExec';
import { PREFS, usePreference } from '../store/preferences';
import { useSessionPrivileges } from '../store/sessionPrivileges';
import { privilegeTip } from '../utils/privileges';
import { can, ENGINE_LABELS } from '../utils/engineCaps';
import { longClass } from '../utils/longQuery';
import { usePoll } from '../hooks/usePoll';

interface Props {
  sessionId: string;
  /** audit-log attribution for kills issued here */
  connectionName?: string;
  engine?: string;
  onClose: () => void;
}

const INTERVALS = [1, 2, 3, 5, 10, 30];

export function ProcessListPanel({ sessionId, connectionName, engine, onClose }: Props) {
  /**
   * Whether this role may signal *other* backends. Killing your own is always
   * allowed; killing someone else's needs SUPER/CONNECTION_ADMIN on MySQL or
   * the pg_signal_backend role on PostgreSQL. The privilege layer knew this
   * already — the button just never asked, so the user found out by failing.
   */
  const privs = useSessionPrivileges(sessionId, engine ?? '');
  const killBlocked = privilegeTip(privs, 'kill-others', 'Kill');
  // Statement watching polls the progress catalogs, which only the three
  // longQueryWatch engines publish — everywhere else the button greys with
  // the reason, it does not disappear (the house rule).
  const watchBlocked = engine && !can(engine, 'longQueryWatch')
    ? `Watch — not available for ${ENGINE_LABELS[engine as keyof typeof ENGINE_LABELS] ?? engine}: it polls the `
      + 'progress catalogs (performance_schema stages, pg_stat_progress_*, '
      + 'dm_exec_requests), which only MySQL, PostgreSQL and SQL Server publish'
    : null;

  const [result, setResult] = useState<QueryResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [intervalSec, setIntervalSec] = useState(3);
  const [paused, setPaused] = useState(false);
  const [filter, setFilter] = useState('');
  const [selectedPid, setSelectedPid] = useState<number | null>(null);
  // Settings → Safety → Interactive kill. Off makes this a read-only monitor.
  const [interactiveKill] = usePreference(PREFS.interactiveKill);
  const [killErr, setKillErr] = useState<string | null>(null);
  const [sort, setSort] = useState<SortClause[]>([]);
  // Long-query spotlight: rows at >= threshold tint yellow, >= 2× red.
  const [threshold, setThreshold] = useState(30);
  const [onlyLong, setOnlyLong] = useState(false);
  const [longestFirst, setLongestFirst] = useState(false);
  const body = useCallback(async () => {
    try {
      const r = await invoke<QueryResult>('list_processes', { sessionId });
      setResult(r);
      setError(null);
    } catch (e) {
      setError(errorDisplay(e));
    }
  }, [sessionId]);
  // In-flight skip, hidden-tab gate, interval + cleanup — hooks/usePoll owns
  // the loop (this panel was its canonical copy).
  const refresh = usePoll(body, intervalSec, { paused });

  // Column index of the process id: MySQL "Id", PG "pid"
  const pidCol = useMemo(() => {
    if (!result) return -1;
    return result.columns.findIndex(c => /^(id|pid)$/i.test(c.name));
  }, [result]);

  // Column index of the elapsed seconds: "Time" in both engines
  const timeCol = useMemo(() => {
    if (!result) return -1;
    return result.columns.findIndex(c => /^time$/i.test(c.name));
  }, [result]);

  // Client-side filter over every cell
  const filteredRows = useMemo(() => {
    if (!result) return [];
    let out = result.rows;
    if (filter.trim()) {
      const q = filter.toLowerCase();
      out = out.filter(row => row.some(cell => cell !== null && String(cell).toLowerCase().includes(q)));
    }
    if (onlyLong && timeCol >= 0 && threshold > 0) {
      out = out.filter(row => Number(row[timeCol]) >= threshold);
    }
    if (longestFirst && timeCol >= 0) {
      out = [...out].sort((a, b) => Number(b[timeCol]) - Number(a[timeCol]));
    } else if (sort.length > 0 && result) {
      const ci = result.columns.findIndex(c => c.name === sort[0].column);
      if (ci >= 0) {
        const dir = sort[0].direction === 'asc' ? 1 : -1;
        const keyed = out.map(row => ({ row, key: cellSortKey(row[ci]) }));
        keyed.sort((a, b) => {
          if (a.key === null) return b.key === null ? 0 : 1;
          if (b.key === null) return -1;
          return compareCellKeys(a.key, b.key) * dir;
        });
        out = keyed.map(k => k.row);
      }
    }
    return out;
  }, [result, filter, sort, onlyLong, longestFirst, threshold, timeCol]);

  // Row tint from the Time column — FastGrid compares the returned string,
  // so rows re-tint only when their class actually changes.
  const rowClass = useCallback((r: number) => {
    if (!result || timeCol < 0 || threshold <= 0) return '';
    const cls = longClass(Number(filteredRows[r]?.[timeCol]), threshold);
    return cls ? `fg-row-${cls}` : '';
  }, [result, filteredRows, timeCol, threshold]);

  const onSortCol = useCallback((col: string) => {
    setSort(prev => {
      const ex = prev.find(s => s.column === col);
      if (!ex) return [{ column: col, direction: 'asc' }];
      if (ex.direction === 'asc') return [{ column: col, direction: 'desc' }];
      return [];
    });
  }, []);

  const handleSelection = useCallback((sel: SelRect | null) => {
    if (!sel || pidCol < 0) { setSelectedPid(null); return; }
    const row = filteredRows[sel.r1];
    const pid = row ? Number(row[pidCol]) : NaN;
    setSelectedPid(Number.isFinite(pid) ? pid : null);
  }, [filteredRows, pidCol]);

  /** The selected grid row as a ProcInfo, so the kill log carries its detail. */
  const selectedProc = useCallback(() => {
    if (!result || selectedPid === null) return undefined;
    const idx = result.columns.findIndex(c => /^(id|pid)$/i.test(c.name));
    const row = filteredRows.find(r => idx >= 0 && Number(r[idx]) === selectedPid);
    if (!row) return undefined;
    const col = (re: RegExp) => {
      const i = result.columns.findIndex(c => re.test(c.name));
      return i >= 0 && row[i] != null ? String(row[i]) : '';
    };
    return partialProc({
      id: selectedPid,
      user: col(/^user(name)?$/i),
      host: col(/^host$/i),
      db: col(/^(db|datname|database)$/i),
      command: col(/^(command|state)$/i),
      time: Number(col(/^time$/i)) || 0,
      state: col(/^(state|wait)$/i),
      info: col(/^(info|query)$/i),
    });
  }, [result, filteredRows, selectedPid]);

  async function kill(terminate: boolean) {
    if (selectedPid === null) return;
    setKillErr(null);
    const proc = selectedProc();
    try {
      // executeKill logs one line per thread (session 📓 Log + 📜 Audit).
      const [outcome] = await executeKill({
        sessionId, ids: [selectedPid], mode: terminate ? 'connection' : 'query',
        source: 'Processes panel', procs: proc ? [proc] : [],
        connectionName, engine,
      });
      if (outcome && !outcome.ok) setKillErr(outcome.error ?? 'kill failed');
      await refresh();
    } catch (e) {
      setKillErr(errorDisplay(e));
    }
  }

  return (
    <div className="proc-panel">
      <div className="proc-toolbar">
        <span className="proc-title">⚡ Processes</span>
        <input
          className="proc-filter"
          placeholder="Filter…"
          value={filter}
          onChange={e => setFilter(e.target.value)}
        />
        <select
          value={intervalSec}
          onChange={e => setIntervalSec(Number(e.target.value))}
          title="Auto-refresh interval"
        >
          {INTERVALS.map(s => <option key={s} value={s}>{s}s</option>)}
        </select>
        <label className="proc-threshold" title="Long-query threshold (seconds) — rows this old tint yellow, twice this old tint red">
          long ≥
          <input
            type="number" min={1} max={86400}
            value={threshold}
            onChange={e => setThreshold(Math.max(1, Number(e.target.value) || 1))}
          />s
        </label>
        <label className="proc-onlylong" title="Show only rows at or above the threshold">
          <input type="checkbox" checked={onlyLong} onChange={e => setOnlyLong(e.target.checked)} />
          only long
        </label>
        <button
          className={`toolbar-btn${longestFirst ? ' proc-sort-on' : ''}`}
          title="Sort by Time, longest running first"
          onClick={() => setLongestFirst(v => !v)}
        >⏱ longest</button>
        <button className="toolbar-btn" onClick={() => setPaused(p => !p)}>
          {paused ? '▶ Resume' : '⏸ Pause'}
        </button>
        <button className="toolbar-btn" onClick={refresh}>↻ Refresh</button>
        {result && (
          <CopyExportMenu
            getData={() => ({ columns: result.columns.map(c => c.name), rows: filteredRows })}
            tableName="processlist"
            engine={engine}
          />
        )}

        <div style={{ flex: 1 }} />

        {killErr && <span className="proc-err">{killErr}</span>}
        <button
          className={`toolbar-btn${watchBlocked ? ' unavail' : ''}`}
          disabled={selectedPid === null}
          aria-disabled={watchBlocked ? true : undefined}
          data-tip={watchBlocked ?? undefined}
          title={watchBlocked
            ?? 'Watch this thread\'s live phase + progress in the Watch panel — read-only, no KILL'}
          onClick={() => {
            if (watchBlocked || selectedPid === null) return;
            window.dispatchEvent(new CustomEvent('dbgui:toggle-panel', {
              detail: { panel: 'watch', scope: 'statement', threadId: selectedPid },
            }));
          }}
        >👁 Watch{selectedPid !== null ? ` ${selectedPid}` : ''}</button>
        {interactiveKill ? (
          <>
            <button
              className={`toolbar-btn proc-kill${killBlocked ? ' unavail' : ''}`}
              disabled={selectedPid === null}
              aria-disabled={killBlocked ? true : undefined}
              data-tip={killBlocked ?? undefined}
              onClick={() => { if (!killBlocked) kill(false); }}
              title={killBlocked ?? 'Abort the running statement, keep the connection (KILL QUERY / pg_cancel_backend)'}
            >Kill query{selectedPid !== null ? ` ${selectedPid}` : ''}</button>
            <button
              className={`toolbar-btn proc-kill-hard${killBlocked ? ' unavail' : ''}`}
              disabled={selectedPid === null}
              aria-disabled={killBlocked ? true : undefined}
              data-tip={killBlocked ?? undefined}
              onClick={() => { if (!killBlocked) kill(true); }}
              title={killBlocked ?? 'Terminate the whole connection (KILL / pg_terminate_backend)'}
            >Kill connection</button>
          </>
        ) : (
          <span className="proc-monitor-note" title="Interactive kill is off (Settings → Safety)">monitor only</span>
        )}
        <button className="icon-btn" onClick={onClose} title="Close">×</button>
      </div>

      {error && <div className="proc-error-bar">{error}</div>}

      {result ? (
        <FastGrid
          columns={result.columns}
          rows={filteredRows}
          sort={sort}
          onSortCol={onSortCol}
          onSelectionChange={handleSelection}
          rowClass={rowClass}
        />
      ) : (
        !error && <div className="proc-loading">Loading…</div>
      )}

      <div className="proc-status">
        {result && `${filteredRows.length}${filter ? ` / ${result.rows.length}` : ''} backends`}
        {paused ? ' · paused' : ` · every ${intervalSec}s`}
      </div>
    </div>
  );
}
