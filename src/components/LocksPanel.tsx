/**
 * 🔒 Locks & Deadlocks — blocking chains, the deadlock wait-for graph and a
 * local incident history. One panel, two tabs:
 *
 * Blocking (5 s auto-refresh):
 *   MySQL  — sys.innodb_lock_waits: who waits on whom, wait age, both
 *            statements, one-click Kill blocker; plus parsed InnoDB engine
 *            status (transactions, buffer pool, row ops, semaphores).
 *   PG     — pg_blocking_pids() joined to pg_stat_activity, same shape.
 *   MSSQL  — sys.dm_os_waiting_tasks, same shape.
 * Deadlocks (was the standalone Deadlocks panel):
 *   MySQL  — SHOW ENGINE INNODB STATUS → the LATEST DETECTED DEADLOCK section
 *            parsed into a graph (utils/deadlockGraph.ts): transactions as
 *            nodes, lock waits as labeled edges (mode · table · index), the
 *            wait cycle highlighted, the victim marked. Detection records the
 *            event into history.db (deadlock_events); the server's "latest"
 *            changes only when a new one happens, so the store dedupes by raw
 *            text and a refresh loop cannot pile up copies. Any past event
 *            re-opens as the same graph from its stored parse.
 *   MSSQL  — the system_health ring buffer keeps a HISTORY of full deadlock
 *            graphs (on by default): newest shown, every one recorded.
 *   PG     — deadlock *counters* per database (pg_stat_database.deadlocks)
 *            plus a history of counter snapshots; the per-incident detail
 *            lands only in the server log, which the tab says honestly.
 * Everything read-only except the explicit Kill actions (confirm-gated).
 */
import { errorDisplay } from '../utils/appError';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { QueryResult, Session } from '../types';
import { executeKill, partialProc } from '../utils/killExec';
import { confirmDialog } from '../utils/appDialog';
import { useTabVisible } from '../store/tabVisibility';
import { usePoll } from '../hooks/usePoll';
import { parseInnodbStatus, type InnodbStatus } from '../utils/innodbStatus';
import {
  parseDeadlockGraph, layoutDeadlockGraph, lockLabel, edgeInCycle,
  DL_NODE_W, DL_NODE_H,
  type DeadlockGraph,
} from '../utils/deadlockGraph';
import { parseMssqlDeadlock, MSSQL_DEADLOCK_SQL } from '../utils/mssqlDeadlock';

interface Props { session: Session; onClose: () => void; }

// sys.innodb_lock_waits column names vary slightly across 5.7/8.x — select
// defensively and map by name instead of position.
const MYSQL_WAITS_SAFE_SQL = 'SELECT * FROM sys.innodb_lock_waits';

const PG_WAITS_SQL = `
SELECT w.pid            AS waiting_pid,
       w.query          AS waiting_query,
       b.pid            AS blocking_pid,
       b.query          AS blocking_query,
       EXTRACT(EPOCH FROM now() - w.query_start)::int AS wait_secs,
       w.wait_event_type || ':' || w.wait_event AS wait_event
FROM pg_stat_activity w
JOIN LATERAL unnest(pg_blocking_pids(w.pid)) AS blocker(pid) ON true
JOIN pg_stat_activity b ON b.pid = blocker.pid
WHERE cardinality(pg_blocking_pids(w.pid)) > 0`.trim();

/**
 * SQL Server blocking chains, in the same shape the MySQL and PostgreSQL
 * queries return.
 *
 * `sys.dm_os_waiting_tasks` is the one that actually knows who is waiting on
 * whom — `dm_exec_requests.blocking_session_id` covers only requests, and a
 * task can wait without one. The waiting statement is sliced out of the batch
 * with the request's statement offsets (SQL Server reports the whole batch
 * otherwise, so a 40-line script would show as one blob); the blocker's text
 * comes from `most_recent_sql_handle`, because a blocker is very often idle
 * inside an open transaction and has no *current* request at all — which is
 * exactly the case a DBA is hunting.
 *
 * OUTER APPLY, not CROSS APPLY: a handle can be null or aged out of the plan
 * cache, and losing the whole row because the text is gone would hide the
 * blocking chain the panel exists to show.
 */
const MSSQL_WAITS_SQL = `
SELECT
    wt.session_id                                        AS waiting_pid,
    ISNULL(SUBSTRING(wq.text, (wr.statement_start_offset/2)+1,
        ((CASE wr.statement_end_offset WHEN -1
              THEN DATALENGTH(wq.text) ELSE wr.statement_end_offset END
          - wr.statement_start_offset)/2)+1), '')        AS waiting_query,
    wt.blocking_session_id                               AS blocking_pid,
    ISNULL(bq.text, '')                                  AS blocking_query,
    wt.wait_duration_ms / 1000                           AS wait_secs,
    wt.wait_type + ISNULL(' · ' + wt.resource_description, '') AS detail
FROM sys.dm_os_waiting_tasks wt
LEFT JOIN sys.dm_exec_requests wr ON wr.session_id = wt.session_id
OUTER APPLY sys.dm_exec_sql_text(wr.sql_handle) wq
LEFT JOIN sys.dm_exec_connections bc ON bc.session_id = wt.blocking_session_id
OUTER APPLY sys.dm_exec_sql_text(bc.most_recent_sql_handle) bq
WHERE wt.blocking_session_id IS NOT NULL
  AND wt.blocking_session_id <> wt.session_id
ORDER BY wt.wait_duration_ms DESC`.trim();

const PG_COUNTERS_SQL =
  'SELECT datname, deadlocks FROM pg_stat_database WHERE datname IS NOT NULL AND deadlocks > 0 ORDER BY deadlocks DESC';

interface WaitRow {
  waitingPid: string;
  waitingQuery: string;
  blockingPid: string;
  blockingQuery: string;
  waitSecs: string;
  detail: string;      // locked table/index (MySQL) or wait event (PG)
}

function pq(sessionId: string, sql: string): Promise<QueryResult> {
  return invoke<QueryResult>('panel_query', { sessionId, sql, token: crypto.randomUUID() });
}

/** Render a parsed InnoDB number/string, or an em-dash when the field was absent. */
function fmt(v: number | string | null | undefined): string {
  if (v === null || v === undefined) return '—';
  return typeof v === 'number' ? v.toLocaleString() : v;
}

/** A small read-only key/value table reusing the panel's rs-table styling. */
function KvTable({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <table className="rs-table" style={{ maxWidth: 520 }}>
      <tbody>
        {rows.map(([k, v]) => (
          <tr key={k}>
            <td className="rs-dim" style={{ width: 220 }}>{k}</td>
            <td>{v}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function colIdx(r: QueryResult, ...names: string[]): number {
  for (const n of names) {
    const i = r.columns.findIndex(c => c.name.toLowerCase() === n);
    if (i >= 0) return i;
  }
  return -1;
}

// ── Deadlock graph (absorbed from the standalone Deadlocks panel) ───────────

interface DeadlockEventMeta {
  id: number;
  connection_id: string;
  engine: string;
  detected_at: string;
  victim: string;
  txn_count: number;
  created_at: string;
}

interface DeadlockEvent extends DeadlockEventMeta {
  raw: string;
  parsed: string;
}

/** One PG counters snapshot, as stored in a PG event's `parsed` payload. */
interface PgCounters { counters: [string, number][] }

/** Short victim label for the history list: "(2) · thread 813". */
function victimLabel(g: DeadlockGraph): string {
  if (g.victim === null) return '';
  const t = g.transactions.find(t => t.ordinal === g.victim);
  return `(${g.victim})` + (t?.threadId ? ` · thread ${t.threadId}` : '');
}

const GRAPH_W = 780;
const GRAPH_H = 400;

/** The wait-for graph as SVG. */
function GraphSvg({ g }: { g: DeadlockGraph }) {
  // Marker ids must be unique per mounted graph (live + stored can coexist).
  const uid = useId().replace(/[^a-zA-Z0-9]/g, '');
  const pos = layoutDeadlockGraph(g.transactions.map(t => t.ordinal), GRAPH_W, GRAPH_H);
  const center = (ord: number) => {
    const p = pos.get(ord)!;
    return { x: p.x + DL_NODE_W / 2, y: p.y + DL_NODE_H / 2 };
  };
  /** Clip a center-to-center line to the node rectangle's border. */
  const border = (c: { x: number; y: number }, d: { x: number; y: number }) => {
    const adx = Math.abs(d.x) || 1e-6, ady = Math.abs(d.y) || 1e-6;
    const t = Math.min(DL_NODE_W / 2 / adx, DL_NODE_H / 2 / ady);
    return { x: c.x + d.x * t, y: c.y + d.y * t };
  };

  return (
    <svg className="dl-graph" viewBox={`0 0 ${GRAPH_W} ${GRAPH_H}`} role="img"
      aria-label="Deadlock wait-for graph">
      <defs>
        <marker id={`dl-arr-${uid}`} viewBox="0 0 10 10" refX="9" refY="5"
          markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0 0L10 5L0 10z" className="dl-arrow" />
        </marker>
        <marker id={`dl-arr-cyc-${uid}`} viewBox="0 0 10 10" refX="9" refY="5"
          markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0 0L10 5L0 10z" className="dl-arrow-cycle" />
        </marker>
      </defs>

      {g.edges.map((e, i) => {
        const c1 = center(e.from);
        // An unresolved holder (the section did not say who blocks us) is a
        // dashed stub toward the middle — shown as unknown, never guessed.
        const c2 = e.to !== null
          ? center(e.to)
          : { x: GRAPH_W / 2, y: GRAPH_H / 2 };
        const d = { x: c2.x - c1.x, y: c2.y - c1.y };
        const s = border(c1, d);
        const t = e.to !== null ? border(c2, { x: -d.x, y: -d.y }) : {
          x: c1.x + d.x * 0.32, y: c1.y + d.y * 0.32,
        };
        // Curve sideways so the two directions of a mutual wait separate.
        const mx = (s.x + t.x) / 2, my = (s.y + t.y) / 2;
        const len = Math.hypot(d.x, d.y) || 1;
        const off = e.to !== null ? 26 : 0;
        const cxp = mx - (d.y / len) * off, cyp = my + (d.x / len) * off;
        const onCycle = edgeInCycle(e, g.cycle);
        const cls = onCycle ? 'dl-edge dl-edge-cycle' : 'dl-edge';
        return (
          <g key={i}>
            <path d={`M ${s.x} ${s.y} Q ${cxp} ${cyp} ${t.x} ${t.y}`}
              className={e.to === null ? 'dl-edge dl-edge-unknown' : cls}
              markerEnd={e.to !== null
                ? `url(#dl-arr-${onCycle ? `cyc-${uid}` : uid})`
                : undefined} />
            <text x={cxp} y={cyp - 6} textAnchor="middle"
              className={onCycle ? 'dl-lbl dl-lbl-cycle' : 'dl-lbl'}>
              {e.to === null ? `${lockLabel(e.lock)} · holder?` : lockLabel(e.lock)}
            </text>
          </g>
        );
      })}

      {g.transactions.map(tx => {
        const p = pos.get(tx.ordinal)!;
        const isVictim = g.victim === tx.ordinal;
        const inCycle = g.cycle?.includes(tx.ordinal) ?? false;
        return (
          <g key={tx.ordinal}>
            <rect x={p.x} y={p.y} width={DL_NODE_W} height={DL_NODE_H} rx={8}
              className={isVictim ? 'dl-node dl-node-victim' : inCycle ? 'dl-node dl-node-cycle' : 'dl-node'} />
            <text x={p.x + 10} y={p.y + 20} className="dl-txt dl-txt-head">
              ({tx.ordinal}){tx.trxId ? ` · trx ${tx.trxId}` : ''}
            </text>
            <text x={p.x + 10} y={p.y + 38} className="dl-txt dl-dim">
              {[tx.threadId ? `thread ${tx.threadId}` : null,
                tx.user && tx.host ? `${tx.user}@${tx.host}` : null]
                .filter(Boolean).join(' · ') || '—'}
            </text>
            {isVictim && (
              <text x={p.x + DL_NODE_W - 10} y={p.y + DL_NODE_H - 10}
                textAnchor="end" className="dl-txt dl-victim-badge">victim — rolled back</text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

/** The per-transaction detail table under the graph. */
function TxnTable({ g }: { g: DeadlockGraph }) {
  return (
    <table className="rs-table">
      <thead>
        <tr><th></th><th>trx id</th><th>thread</th><th>user@host</th><th>state</th>
          <th>waiting for</th><th>holds</th><th>statement</th></tr>
      </thead>
      <tbody>
        {g.transactions.map(tx => (
          <tr key={tx.ordinal} className={g.victim === tx.ordinal ? 'rs-bad' : ''}>
            <td>({tx.ordinal}){g.victim === tx.ordinal ? ' ⚑' : ''}</td>
            <td className="rs-dim">{tx.trxId ?? '—'}</td>
            <td>{tx.threadId ?? '—'}</td>
            <td className="rs-dim">{tx.user && tx.host ? `${tx.user}@${tx.host}` : '—'}</td>
            <td className="rs-dim">{tx.status ?? '—'}</td>
            <td className="rs-warn">{tx.waitingFor ? lockLabel(tx.waitingFor) : '—'}</td>
            <td>{tx.holds.length ? tx.holds.map(lockLabel).join('; ') : '—'}</td>
            <td className="locks-sql" title={tx.query ?? ''}>{tx.query ? tx.query.slice(0, 120) : '—'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** A stored or live MySQL incident: graph + details + raw toggle. */
function MysqlIncident({ g, raw }: { g: DeadlockGraph; raw: string }) {
  const [showRaw, setShowRaw] = useState(false);
  return (
    <div className="locks-deadlock">
      <div className="rs-dim" style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
        <span>{g.when}</span>
        <button className="toolbar-btn" onClick={() => setShowRaw(r => !r)}>
          {showRaw ? 'Graph view' : 'Raw section'}
        </button>
      </div>
      {showRaw
        ? <pre className="locks-pre">{raw.slice(0, 12000)}</pre>
        : (
          <>
            <GraphSvg g={g} />
            {g.cycle === null && (
              <div className="mnt-note">
                The resolved waits do not close a loop — the report does not always name
                the holder of every waited lock. Transactions and their locks are below.
              </div>
            )}
            <TxnTable g={g} />
          </>
        )}
    </div>
  );
}

/** The PG honesty block — why there is no graph, stated once, plainly. */
function PgNoGraphNote() {
  return (
    <div className="mnt-note">
      PostgreSQL counts deadlocks but publishes no per-incident structure: which backends
      waited on which locks, and with which statements, is written only to the server log
      when <code>deadlock_timeout</code> fires (set <code>log_lock_waits = on</code> for the
      lock detail). There is no system view to build a graph from, so there is none here —
      the Blocking tab&rsquo;s chain is the live equivalent.
    </div>
  );
}

function PgCountersTable({ counters }: { counters: [string, number][] }) {
  if (!counters.length) {
    return <div className="mx-empty">No deadlocks counted in pg_stat_database.</div>;
  }
  return (
    <table className="rs-table" style={{ maxWidth: 420 }}>
      <thead><tr><th>database</th><th>deadlocks since stats reset</th></tr></thead>
      <tbody>
        {counters.map(([db, n]) => (
          <tr key={db}><td>{db}</td><td className="rs-warn">{n}</td></tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * The Deadlocks tab: the live latest deadlock (or PG counters), the recorded
 * incident history, and a stored-event viewer. Check-on-mount plus an explicit
 * "Check now" — deliberately NOT on the Blocking tab's 5 s poll, so recording
 * an incident stays a deliberate (deduped) act, not a timer's side effect.
 */
function DeadlocksSection({ session }: { session: Session }) {
  const { sessionId, connectionId, engine } = session;
  const isMysql = engine === 'mysql';
  const isMssql = engine === 'sqlserver';
  const [live, setLive] = useState<DeadlockGraph | null>(null);
  const [pgCounters, setPgCounters] = useState<[string, number][]>([]);
  const [events, setEvents] = useState<DeadlockEventMeta[]>([]);
  /** null = the live/current view; an id = viewing that stored event. */
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [stored, setStored] = useState<DeadlockEvent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [lastAt, setLastAt] = useState('');

  const listEvents = useCallback(async () => {
    setEvents(await invoke<DeadlockEventMeta[]>('list_deadlock_events', { connectionId }));
  }, [connectionId]);

  const refresh = useCallback(async () => {
    setBusy(true); setError(null);
    try {
      if (isMysql) {
        const statusR = await pq(sessionId, 'SHOW ENGINE INNODB STATUS').catch(() => null);
        const row = statusR?.rows[0];
        const statusText = row ? String(row[2] ?? row[row.length - 1] ?? '') : '';
        const g = parseDeadlockGraph(statusText);
        setLive(g);
        if (g) {
          // Recorded on detection; the store dedupes the unchanged "latest".
          await invoke('record_deadlock_event', {
            connectionId, engine: 'mysql', detectedAt: g.when,
            victim: victimLabel(g), txnCount: g.transactions.length,
            raw: g.raw, parsed: JSON.stringify(g),
          });
        }
      } else if (isMssql) {
        // SQL Server keeps a HISTORY of full deadlock graphs in system_health,
        // which runs by default — so unlike MySQL (latest only) and PostgreSQL
        // (counters only) there may be several, and each is complete. Newest
        // first; every one is recorded, and the store dedupes by raw text so a
        // refresh cannot pile up copies.
        const r = await pq(sessionId, MSSQL_DEADLOCK_SQL).catch(() => null);
        const reports = (r?.rows ?? []).map(row => ({
          xml: String(row[0] ?? ''), at: String(row[1] ?? ''),
        }));
        let newest: ReturnType<typeof parseMssqlDeadlock> = null;
        for (const rep of reports) {
          const g = parseMssqlDeadlock(rep.xml, rep.at);
          if (!g) continue;
          if (!newest) newest = g;
          await invoke('record_deadlock_event', {
            connectionId, engine: 'sqlserver', detectedAt: g.when,
            victim: victimLabel(g), txnCount: g.transactions.length,
            raw: g.raw, parsed: JSON.stringify(g),
          });
        }
        setLive(newest);
      } else {
        const r = await pq(sessionId, PG_COUNTERS_SQL).catch(() => null);
        const counters: [string, number][] =
          (r?.rows ?? []).map(row => [String(row[0]), Number(row[1])]);
        setPgCounters(counters);
        // A counter snapshot is history too — recorded only when the counts
        // moved (identical raw dedupes), i.e. when a deadlock was counted.
        await invoke('record_deadlock_event', {
          connectionId, engine: 'postgres', detectedAt: '',
          victim: '', txnCount: 0,
          raw: JSON.stringify(counters), parsed: JSON.stringify({ counters } satisfies PgCounters),
        });
      }
      await listEvents();
      setLastAt(new Date().toLocaleTimeString());
    } catch (e) {
      setError(errorDisplay(e));
    } finally {
      setBusy(false);
    }
  }, [sessionId, connectionId, isMysql, isMssql, listEvents]);

  useEffect(() => { void refresh(); }, [refresh]);

  // Load a stored event when one is selected; back to live when deselected.
  useEffect(() => {
    if (selectedId === null) { setStored(null); return; }
    let alive = true;
    invoke<DeadlockEvent>('get_deadlock_event', { id: selectedId })
      .then(ev => { if (alive) setStored(ev); })
      .catch(e => { if (alive) setError(errorDisplay(e)); });
    return () => { alive = false; };
  }, [selectedId]);

  const remove = useCallback(async (id: number) => {
    setError(null);
    try {
      await invoke('delete_deadlock_event', { id });
      if (selectedId === id) setSelectedId(null);
      await listEvents();
    } catch (e) {
      setError(errorDisplay(e));
    }
  }, [selectedId, listEvents]);

  // What the main area shows: the selected stored event, else the live view.
  const storedGraph: DeadlockGraph | null = (() => {
    if (!stored || stored.engine !== 'mysql' || !stored.parsed) return null;
    try { return JSON.parse(stored.parsed) as DeadlockGraph; } catch { return null; }
  })();
  const storedPg: PgCounters | null = (() => {
    if (!stored || stored.engine !== 'postgres' || !stored.parsed) return null;
    try { return JSON.parse(stored.parsed) as PgCounters; } catch { return null; }
  })();

  const eventLabel = (m: DeadlockEventMeta) =>
    m.engine === 'mysql' || m.engine === 'sqlserver'
      ? `#${m.id} · ${m.detected_at || m.created_at}${m.victim ? ` · victim ${m.victim}` : ''} · ${m.txn_count} txns`
      : `#${m.id} · ${m.created_at} · counters`;

  return (
    <>
      {error && <div className="proc-error-bar">{error}</div>}

      <div className="locks-body">
        {selectedId === null ? (
          <div className="rs-section">
            <div className="rs-section-title">
              {isMysql ? 'Latest detected deadlock (InnoDB)'
                : isMssql ? 'Deadlocks (system_health — full history)'
                : 'Deadlock counters (pg_stat_database)'}
              <div style={{ flex: 1 }} />
              <span className="dv-desc">{lastAt && `checked ${lastAt}`}</span>
              <button className="toolbar-btn" disabled={busy} onClick={() => void refresh()}>
                {busy ? 'Checking…' : '↻ Check now'}
              </button>
            </div>
            {(isMysql || isMssql) && !live && (
              <div className="mx-empty">No deadlock recorded by the server since its last status reset.</div>
            )}
            {(isMysql || isMssql) && live && <MysqlIncident g={live} raw={live.raw} />}
            {!isMysql && !isMssql && (
              <>
                <PgNoGraphNote />
                <PgCountersTable counters={pgCounters} />
              </>
            )}
          </div>
        ) : (
          <div className="rs-section">
            <div className="rs-section-title">
              Stored event {stored ? eventLabel(stored) : '…'}
              <div style={{ flex: 1 }} />
              <button className="toolbar-btn" onClick={() => setSelectedId(null)}>← Back to live</button>
            </div>
            {stored && storedGraph && <MysqlIncident g={storedGraph} raw={stored.raw} />}
            {stored && storedPg && (
              <>
                <PgNoGraphNote />
                <PgCountersTable counters={storedPg.counters} />
              </>
            )}
            {stored && !storedGraph && !storedPg && (
              <div className="mx-empty">The stored parse could not be read; the raw section is below.</div>
            )}
            {stored && !storedGraph && !storedPg && (
              <pre className="locks-pre">{stored.raw.slice(0, 12000)}</pre>
            )}
          </div>
        )}

        <div className="rs-section">
          <div className="rs-section-title">History — recorded on detection (50 per connection kept)</div>
          {events.length === 0
            ? <div className="mx-empty">Nothing recorded yet for this connection.</div>
            : (
              <div className="row-actions" style={{ justifyContent: 'flex-start', padding: 0, gap: 8, flexWrap: 'wrap' }}>
                {events.map(m => (
                  <span key={m.id} className="dv-desc dl-event" style={{ alignSelf: 'center' }}>
                    <button className={`toolbar-btn${selectedId === m.id ? ' dl-event-active' : ''}`}
                      onClick={() => setSelectedId(m.id)}>{eventLabel(m)}</button>
                    <button className="icon-btn" title="Delete stored event" onClick={() => void remove(m.id)}>×</button>
                  </span>
                ))}
              </div>
            )}
        </div>
      </div>
    </>
  );
}

// ── The panel ────────────────────────────────────────────────────────────────

export function LocksPanel({ session, onClose }: Props) {
  const { sessionId, engine, connectionName } = session;
  const isMysql = engine === 'mysql';
  const isMssql = engine === 'sqlserver';
  const [tab, setTab] = useState<'blocking' | 'deadlocks'>('blocking');
  const [waits, setWaits] = useState<WaitRow[]>([]);
  const [innodb, setInnodb] = useState<InnodbStatus | null>(null);
  const [innodbTab, setInnodbTab] = useState<'txn' | 'buffer' | 'rowops' | 'semaphores'>('txn');
  const [error, setError] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const [lastAt, setLastAt] = useState('');
  const aliveRef = useRef(true);
  // A hidden tab polls nothing; overlapping polls never queue (`SHOW ENGINE
  // INNODB STATUS` can outlive the 5 s interval on a busy server) — both are
  // hooks/usePoll's job now.
  const visible = useTabVisible();

  const body = useCallback(async () => {
    try {
      if (isMysql) {
        const [waitsR, statusR] = await Promise.all([
          pq(sessionId, MYSQL_WAITS_SAFE_SQL),
          pq(sessionId, 'SHOW ENGINE INNODB STATUS').catch(() => null),
        ]);
        const wp = colIdx(waitsR, 'waiting_pid');
        const wq = colIdx(waitsR, 'waiting_query');
        const bp = colIdx(waitsR, 'blocking_pid');
        const bq = colIdx(waitsR, 'blocking_query');
        const wa = colIdx(waitsR, 'wait_age_secs', 'wait_age');
        const lt = colIdx(waitsR, 'locked_table', 'locked_table_name');
        const li = colIdx(waitsR, 'locked_index');
        const rows: WaitRow[] = waitsR.rows.map(r => ({
          waitingPid: String(r[wp] ?? '?'),
          waitingQuery: String(r[wq] ?? ''),
          blockingPid: String(r[bp] ?? '?'),
          blockingQuery: String(r[bq] ?? ''),
          waitSecs: String(r[wa] ?? '?'),
          detail: [r[lt], r[li]].filter(Boolean).join(' · '),
        }));
        let idb: InnodbStatus | null = null;
        if (statusR && statusR.rows[0]) {
          // SHOW ENGINE INNODB STATUS → (Type, Name, Status); status text is the 3rd col
          const statusText = String(statusR.rows[0][2] ?? statusR.rows[0][statusR.rows[0].length - 1] ?? '');
          idb = parseInnodbStatus(statusText);
        }
        if (!aliveRef.current) return;
        setWaits(rows);
        setInnodb(idb);
      } else if (isMssql) {
        // No InnoDB status and no pg_stat_database counters — the blocking
        // chain is the whole tab here. Deadlock history is the Deadlocks
        // tab's job (SQL Server keeps it in the system_health ring buffer,
        // which is richer than either of the other two engines offer).
        const waitsR = await pq(sessionId, MSSQL_WAITS_SQL);
        const rows: WaitRow[] = waitsR.rows.map(r => ({
          waitingPid: String(r[0] ?? '?'),
          waitingQuery: String(r[1] ?? ''),
          blockingPid: String(r[2] ?? '?'),
          blockingQuery: String(r[3] ?? ''),
          waitSecs: String(r[4] ?? '?'),
          detail: String(r[5] ?? ''),
        }));
        if (!aliveRef.current) return;
        setWaits(rows);
      } else {
        const waitsR = await pq(sessionId, PG_WAITS_SQL);
        const rows: WaitRow[] = waitsR.rows.map(r => ({
          waitingPid: String(r[0] ?? '?'),
          waitingQuery: String(r[1] ?? ''),
          blockingPid: String(r[2] ?? '?'),
          blockingQuery: String(r[3] ?? ''),
          waitSecs: String(r[4] ?? '?'),
          detail: String(r[5] ?? ''),
        }));
        if (!aliveRef.current) return;
        setWaits(rows);
      }
      setError(null);
      setLastAt(new Date().toLocaleTimeString());
    } catch (e) {
      if (aliveRef.current) setError(errorDisplay(e));
    }
  }, [sessionId, isMysql, isMssql]);
  const refresh = usePoll(body, 5, { paused });
  // aliveRef mirrors the old cleanup semantics: a response landing after the
  // tab was hidden (or the panel re-armed) must not setState.
  useEffect(() => {
    if (!visible) return;
    aliveRef.current = true;
    return () => { aliveRef.current = false; };
  }, [paused, visible]);

  const kill = useCallback(async (w: WaitRow) => {
    const pid = Number(w.blockingPid);
    if (!await confirmDialog(`Kill ${isMysql ? 'query on thread' : 'backend'} ${w.blockingPid}? The blocked statements can then proceed.`, { danger: true, okLabel: 'Kill' })) return;
    try {
      // Same logged path as every other kill in the app (📓 Log + 📜 Audit),
      // carrying what the chain told us about the blocker.
      const [outcome] = await executeKill({
        sessionId, ids: [pid], mode: 'query', source: 'Locks panel (kill blocker)',
        procs: [partialProc({
          id: pid,
          info: w.blockingQuery,
          state: w.detail,
          blocking: [Number(w.waitingPid)].filter(n => Number.isFinite(n)),
          time: Number(w.waitSecs) || 0,
        })],
        connectionName, engine,
      });
      if (outcome && !outcome.ok) setError(outcome.error ?? 'kill failed');
      refresh();
    } catch (e) {
      setError(errorDisplay(e));
    }
  }, [sessionId, isMysql, refresh, connectionName, engine]);

  return (
    <div className="proc-panel">
      <div className="proc-toolbar">
        <span className="proc-title">🔒 Locks &amp; Deadlocks</span>
        <span className="dv-desc">{lastAt && `updated ${lastAt}`} · every 5 s</span>
        <div style={{ flex: 1 }} />
        <button className="toolbar-btn" onClick={() => setPaused(p => !p)}>{paused ? '▶ Resume' : '⏸ Pause'}</button>
        <button className="toolbar-btn" onClick={refresh}>↻ Refresh</button>
        <button className="icon-btn" onClick={onClose} title="Close">×</button>
      </div>

      {error && <div className="proc-error-bar">{error}</div>}

      <div className="mnt-tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'blocking'}
          className={`mnt-tab${tab === 'blocking' ? ' active' : ''}`}
          data-tip="Blocking chains — who waits on whom, with a confirm-gated kill of the blocker"
          onClick={() => setTab('blocking')}>Blocking</button>
        <button role="tab" aria-selected={tab === 'deadlocks'}
          className={`mnt-tab${tab === 'deadlocks' ? ' active' : ''}`}
          data-tip="Deadlocks — wait-for graph of the latest incident + recorded history"
          onClick={() => setTab('deadlocks')}>Deadlocks</button>
      </div>

      {tab === 'deadlocks' ? <DeadlocksSection session={session} /> : (
        <div className="locks-body">
          <div className="rs-section">
            <div className="rs-section-title">Blocking now</div>
            {waits.length === 0
              ? <div className="mx-empty">No lock waits — nothing is blocked right now.</div>
              : (
                <table className="rs-table">
                  <thead>
                    <tr>
                      <th>waiting</th><th>waiting statement</th><th>wait</th>
                      <th>blocked by</th><th>blocking statement</th>
                      <th>{isMysql ? 'lock' : 'wait event'}</th><th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {waits.map((w, i) => (
                      <tr key={i}>
                        <td>{w.waitingPid}</td>
                        <td className="locks-sql" title={w.waitingQuery}>{w.waitingQuery.slice(0, 90) || '—'}</td>
                        <td className={Number(w.waitSecs) > 30 ? 'rs-bad' : Number(w.waitSecs) > 5 ? 'rs-warn' : ''}>{w.waitSecs}s</td>
                        <td className="rs-warn">{w.blockingPid}</td>
                        <td className="locks-sql" title={w.blockingQuery}>{w.blockingQuery.slice(0, 90) || '(idle in transaction)'}</td>
                        <td className="rs-dim">{w.detail}</td>
                        <td><button className="toolbar-btn locks-kill" onClick={() => kill(w)}>Kill blocker</button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
          </div>

          {isMysql && innodb && (
            <div className="rs-section">
              <div className="rs-section-title">
                InnoDB engine status
                <div className="gsp-seg" style={{ flex: 'none' }}>
                  <button className={innodbTab === 'txn' ? 'active' : ''} onClick={() => setInnodbTab('txn')}>Transactions</button>
                  <button className={innodbTab === 'buffer' ? 'active' : ''} onClick={() => setInnodbTab('buffer')}>Buffer pool</button>
                  <button className={innodbTab === 'rowops' ? 'active' : ''} onClick={() => setInnodbTab('rowops')}>Row ops</button>
                  <button className={innodbTab === 'semaphores' ? 'active' : ''} onClick={() => setInnodbTab('semaphores')}>Semaphores</button>
                </div>
              </div>

              {innodbTab === 'txn' && (
                <div className="locks-deadlock">
                  <KvTable rows={[['History list length (undo purge lag)', fmt(innodb.transactions.historyListLength)]]} />
                  {innodb.transactions.transactions.length === 0
                    ? <div className="mx-empty">No active transactions right now.</div>
                    : (
                      <table className="rs-table">
                        <thead>
                          <tr><th>trx id</th><th>thread</th><th>state</th><th>age</th><th>statement</th></tr>
                        </thead>
                        <tbody>
                          {innodb.transactions.transactions.map((t, i) => (
                            <tr key={i}>
                              <td className="rs-dim">{t.id}</td>
                              <td>{t.threadId ?? '—'}</td>
                              <td className={t.lockWait ? 'rs-warn' : ''}>{t.lockWait ? 'LOCK WAIT · ' : ''}{t.status || '—'}</td>
                              <td className={(t.activeSecs ?? 0) > 30 ? 'rs-bad' : (t.activeSecs ?? 0) > 5 ? 'rs-warn' : ''}>{t.activeSecs != null ? `${t.activeSecs}s` : '—'}</td>
                              <td className="locks-sql" title={t.query ?? ''}>{t.query ? t.query.slice(0, 120) : '—'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                </div>
              )}

              {innodbTab === 'buffer' && (
                <KvTable rows={[
                  ['Buffer pool size (pages)', fmt(innodb.bufferPool.totalPages)],
                  ['Free pages', fmt(innodb.bufferPool.freePages)],
                  ['Database pages', fmt(innodb.bufferPool.databasePages)],
                  ['Modified (dirty) pages', fmt(innodb.bufferPool.modifiedPages)],
                  ['Buffer pool hit rate', fmt(innodb.bufferPool.hitRate)],
                  ['Pages read / created / written', `${fmt(innodb.bufferPool.pagesRead)} / ${fmt(innodb.bufferPool.pagesCreated)} / ${fmt(innodb.bufferPool.pagesWritten)}`],
                ]} />
              )}

              {innodbTab === 'rowops' && (
                <KvTable rows={[
                  ['Queries inside InnoDB', fmt(innodb.rowOps.queriesInside)],
                  ['Queries queued', <span className={(innodb.rowOps.queriesQueued ?? 0) > 0 ? 'rs-warn' : ''}>{fmt(innodb.rowOps.queriesQueued)}</span>],
                  ['Inserts (per s / total)', `${fmt(innodb.rowOps.insertsPerSec)} / ${fmt(innodb.rowOps.insertedTotal)}`],
                  ['Updates (per s / total)', `${fmt(innodb.rowOps.updatesPerSec)} / ${fmt(innodb.rowOps.updatedTotal)}`],
                  ['Deletes (per s / total)', `${fmt(innodb.rowOps.deletesPerSec)} / ${fmt(innodb.rowOps.deletedTotal)}`],
                  ['Reads (per s / total)', `${fmt(innodb.rowOps.readsPerSec)} / ${fmt(innodb.rowOps.readTotal)}`],
                ]} />
              )}

              {innodbTab === 'semaphores' && (
                <KvTable rows={[
                  ['OS waits (total)', fmt(innodb.semaphores.osWaits)],
                  ['Spin rounds (total)', fmt(innodb.semaphores.spinRounds)],
                  ['Mutex spin waits', fmt(innodb.semaphores.mutexSpinWaits)],
                  ['RW-shared OS waits', fmt(innodb.semaphores.rwSharedWaits)],
                  ['RW-excl OS waits', fmt(innodb.semaphores.rwExclWaits)],
                  ['Reservation count', fmt(innodb.semaphores.reservationCount)],
                  ['Signal count', fmt(innodb.semaphores.signalCount)],
                ]} />
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
