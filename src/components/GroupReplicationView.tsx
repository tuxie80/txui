/**
 * MySQL Group Replication status — the "⟡ Group replication" tab of the
 * Replication panel (mysql engine only; the tab is not offered elsewhere).
 *
 * Detection mirrors the Galera tab's pattern with the GR-specific three-way
 * probe: SELECT PLUGIN_NAME, PLUGIN_STATUS FROM information_schema.PLUGINS
 * WHERE PLUGIN_NAME='group_replication' through `monitor_query` (read-family,
 * no special grant — unknown-means-allowed, so no privilege gate). The
 * outcome is honest and named in the empty state: 'absent' (plugin never
 * installed — plain MySQL, and every MariaDB: GR is MySQL-only), 'inactive'
 * (installed but DISABLED), 'active'. ACTIVE with an EMPTY members table is
 * the fourth state: plugin loaded, group never started → the empty state
 * hints START GROUP_REPLICATION (and keeps polling, so starting the group
 * from the editor lights the tab up on the next tick).
 *
 * Once active, the view polls performance_schema.replication_group_members
 * and replication_group_member_stats plus the identity SELECT every 5 s
 * (pause-able, watchdog, tab-visibility — the GaleraClusterView poll
 * conventions) and hands everything to utils/groupReplication.ts — parsing
 * and health rules are pure and unit-tested there; this file only renders.
 * performance_schema needs no grant beyond what a monitoring account has.
 *
 * Provisioning progress (MGR's SST equivalent): while any member is
 * RECOVERING the poll additionally reads performance_schema.clone_status /
 * clone_progress — opportunistically, exactly like the Galera tab's
 * WSREP_INFO probe: the clone plugin absent or the tables empty is the
 * common idle case and stays silent (null → no card). Unlike Galera's SST,
 * the clone tables DO expose a byte-level percentage, so the bar is
 * determinate whenever a clone runs on THIS server.
 */
import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { QueryResult } from '../types';
import { usePoll } from '../hooks/usePoll';
import { errorDisplay } from '../utils/appError';
import {
  grPluginState, parseGrSnapshot, grStatsFor, grGroupNotStarted, grFindings,
  grStateHealth, parseCloneProgress, GR_IDENTITY_SQL, GR_QUEUE_WARN,
  type GrPluginState, type GrSnapshot, type GrCloneProgress, type GrMemberStats,
} from '../utils/groupReplication';
import type { Health } from '../utils/replication';

interface Props {
  sessionId: string;
}

type Probe = 'pending' | GrPluginState;

/** If a poll somehow never settles (backend hang), don't wedge the guard forever. */
const IN_FLIGHT_WATCHDOG_MS = 30_000;

const MEMBERS_SQL = 'SELECT * FROM performance_schema.replication_group_members';
const STATS_SQL = 'SELECT * FROM performance_schema.replication_group_member_stats';
const CLONE_STATUS_SQL = 'SELECT * FROM performance_schema.clone_status';
const CLONE_PROGRESS_SQL = 'SELECT * FROM performance_schema.clone_progress';
const PLUGIN_PROBE_SQL =
  "SELECT PLUGIN_NAME, PLUGIN_STATUS FROM information_schema.PLUGINS WHERE PLUGIN_NAME = 'group_replication'";

/** QueryResult rows → string cells with NULLs as null, for the pure parsers. */
const cells = (r: QueryResult): (string | null)[][] =>
  r.rows.map(row => row.map(v => (v == null ? null : String(v))));

const num = (n: number | null) => n === null ? null : n.toLocaleString();

export function GroupReplicationView({ sessionId }: Props) {
  const [probe, setProbe] = useState<Probe>('pending');
  // Current + previous snapshot in one state so the rate-based health rules
  // always compare two different polls (functional update, no stale closure).
  const [pair, setPair] = useState<{ cur: GrSnapshot; prev: GrSnapshot | null } | null>(null);
  const [clone, setClone] = useState<GrCloneProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const snap = pair?.cur ?? null;

  // One detection probe per session. Failure to answer reads as "no GR" —
  // the empty state names what was asked, so nothing is hidden.
  useEffect(() => {
    let dead = false;
    (async () => {
      try {
        const r = await invoke<QueryResult>('monitor_query', { sessionId, sql: PLUGIN_PROBE_SQL });
        const rows = r.rows.map(row => [String(row[0] ?? ''), String(row[1] ?? '')] as [string, string]);
        if (!dead) setProbe(grPluginState(rows));
      } catch {
        if (!dead) setProbe('absent');
      }
    })();
    return () => { dead = true; };
  }, [sessionId]);

  const body = useCallback(async () => {
    if (probe !== 'active') return;
    try {
      const [members, stats, identity] = await Promise.all([
        invoke<QueryResult>('monitor_query', { sessionId, sql: MEMBERS_SQL }),
        invoke<QueryResult>('monitor_query', { sessionId, sql: STATS_SQL }),
        invoke<QueryResult>('monitor_query', { sessionId, sql: GR_IDENTITY_SQL }),
      ]);
      const parsed = parseGrSnapshot(
        members.columns.map(c => c.name), cells(members),
        stats.columns.map(c => c.name), cells(stats),
        identity.rows[0]?.map(v => (v == null ? null : String(v))),
      );
      setPair(p => ({ cur: parsed, prev: p?.cur ?? null }));
      // Provisioning watch: only worth the two extra reads while a member is
      // RECOVERING, and only meaningful when the clone plugin is installed —
      // both failure modes are tolerated silently (null → no card), the
      // WSREP_INFO convention.
      if (parsed.members.some(m => m.state === 'RECOVERING')) {
        try {
          const [cs, cp] = await Promise.all([
            invoke<QueryResult>('monitor_query', { sessionId, sql: CLONE_STATUS_SQL }),
            invoke<QueryResult>('monitor_query', { sessionId, sql: CLONE_PROGRESS_SQL }),
          ]);
          setClone(parseCloneProgress(
            cs.columns.map(c => c.name), cells(cs),
            cp.columns.map(c => c.name), cells(cp),
          ));
        } catch { setClone(null); }
      } else {
        setClone(null);
      }
      setError(null);
      setUpdatedAt(new Date());
    } catch (e) {
      setError(errorDisplay(e));
    }
  }, [sessionId, probe]);
  const refresh = usePoll(body, 5, { paused: paused || probe !== 'active', inFlightGraceMs: IN_FLIGHT_WATCHDOG_MS });

  if (probe === 'pending') {
    return <div className="proc-loading">Probing for the group_replication plugin…</div>;
  }
  if (probe === 'absent') {
    return (
      <div className="gal-empty">
        <div className="gal-empty-title">Group Replication is not active on this server</div>
        <div>
          <code>{PLUGIN_PROBE_SQL}</code> returned no row — the group_replication plugin is
          not installed on this server. Plain MySQL answers this way until the plugin is
          installed (<code>INSTALL PLUGIN group_replication SONAME 'group_replication.so'</code>);
          MariaDB always answers this way — Group Replication is MySQL-only (its sibling
          there is Galera, on the other tab). The async-replication view is unaffected.
        </div>
      </div>
    );
  }
  if (probe === 'inactive') {
    return (
      <div className="gal-empty">
        <div className="gal-empty-title">group_replication plugin installed but not ACTIVE</div>
        <div>
          The plugin row exists in information_schema.PLUGINS but its status is not ACTIVE
          (DISABLED or mid-uninstall). The server was likely started with
          group_replication disabled; check the error log and the plugin load options.
        </div>
      </div>
    );
  }

  const findings = snap ? grFindings(snap, pair?.prev ?? undefined) : [];
  const notStarted = snap !== null && grGroupNotStarted(snap.members.length);
  const committedSet = snap?.stats.find(s => s.committedAllMembers !== null)?.committedAllMembers ?? null;

  const kv = (label: string, value: string | null, opts: { health?: Health; mono?: boolean } = {}) => (
    <tr className={opts.health ? `repl-${opts.health}` : ''}>
      <td className="repl-key">{label}</td>
      <td className={`repl-val ${opts.mono ? 'repl-mono' : ''}`}>
        {value ?? <span className="fg-null">—</span>}
      </td>
    </tr>
  );

  const statsRow = (s: GrMemberStats, name: string, queueHealth: Health, conflictHealth: Health) => (
    <tr key={s.memberId ?? name}>
      <td className="repl-mono">{name}</td>
      <td className="mgr-num">{num(s.txChecked) ?? '—'}</td>
      <td className={`mgr-num ${conflictHealth ? `repl-${conflictHealth}` : ''}`}>{num(s.conflicts) ?? '—'}</td>
      <td className="mgr-num">{num(s.certQueue) ?? '—'}</td>
      <td className={`mgr-num ${queueHealth ? `repl-${queueHealth}` : ''}`}>{num(s.applierQueue) ?? '—'}</td>
      <td className="mgr-num">{num(s.remoteApplied) ?? '—'}</td>
      <td className="mgr-num">{num(s.localProposed) ?? '—'}</td>
      <td className="mgr-num">{num(s.localRollback) ?? '—'}</td>
    </tr>
  );

  return (
    <div>
      <div className="gal-toolbar">
        <button className="toolbar-btn" onClick={() => setPaused(p => !p)}>
          {paused ? '▶ Resume' : '⏸ Pause'}
        </button>
        <button className="toolbar-btn" onClick={refresh}>↻ Refresh</button>
        {updatedAt && (
          <span className="repl-updated" title="Last successful refresh">
            updated {updatedAt.toLocaleTimeString()}
          </span>
        )}
        <span className="proc-status" style={{ border: 'none', background: 'none' }}>
          {paused ? 'paused' : 'every 5s'}
        </span>
      </div>

      {error && <div className="proc-error-bar">{error}</div>}

      {notStarted && (
        <div className="gal-empty">
          <div className="gal-empty-title">Plugin active, but the group is not started</div>
          <div>
            <code>performance_schema.replication_group_members</code> is empty — the
            group_replication plugin is loaded but no group is running on this server.
            <code>START GROUP_REPLICATION</code> joins (or, on the first member with
            group_replication_bootstrap_group=ON, founds) the group; this view picks it
            up on the next poll.
          </div>
        </div>
      )}

      {clone && (
        <div className="gal-transfer gal-transfer-catchup">
          <div className="gal-transfer-head">
            <span className="gal-transfer-title">
              Provisioning — distributed clone {clone.state ?? ''}
              {clone.currentStage ? ` (${clone.currentStage})` : ''}
            </span>
            {clone.source && <span className="gal-transfer-elapsed">donor {clone.source}</span>}
          </div>
          <div className="gal-transfer-detail">
            {clone.state === 'Completed'
              ? 'The clone finished; the member applies the remaining binlog backlog and then turns ONLINE.'
              : 'A RECOVERING member is being provisioned by clone — MGR\u2019s SST equivalent. Stages: ' +
                clone.stages.map(s => `${s.stage} ${s.state === 'Completed' ? '✓' : s.state === 'In Progress' ? '…' : '·'}`).join('  ')}
          </div>
          {clone.errorMessage && (
            <div className="gal-finding-detail">⚠ clone error {clone.errorNo ?? ''}: {clone.errorMessage}</div>
          )}
          <div className="gal-progress">
            {clone.overallPct !== null
              ? <div className="gal-progress-fill" style={{ width: `${clone.overallPct * 100}%` }} />
              : <div className="gal-progress-pulse" />}
          </div>
        </div>
      )}

      {snap && findings.length > 0 && (
        <div className="gal-findings">
          {findings.map((f, i) => (
            <div key={i} className={`gal-finding gal-${f.level}`}>
              <div className="gal-finding-title">{f.title}</div>
              <div className="gal-finding-detail">{f.detail}</div>
            </div>
          ))}
        </div>
      )}

      {snap && !notStarted && (
        <>
          <div className="repl-section">
            <div className="repl-title">Group</div>
            <table className="repl-kv"><tbody>
              {kv('Group name', snap.groupName, { mono: true })}
              {kv('Mode', snap.singlePrimary === null ? null
                : snap.singlePrimary ? 'single-primary' : 'MULTI-PRIMARY',
                { health: snap.singlePrimary === false ? 'warn' : null })}
              {kv('This member', snap.localAddress, { mono: true })}
              {kv('Seeds', snap.seeds, { mono: true })}
              {kv('Committed (all members)', committedSet, { mono: true })}
            </tbody></table>
          </div>

          <div className="repl-section">
            <div className="repl-title">Members</div>
            <table className="gal-membership mgr-members">
              <thead>
                <tr><th>Member</th><th>Role</th><th>State</th><th>Version</th></tr>
              </thead>
              <tbody>
                {snap.members.map(m => {
                  const isThis = m.id !== null && m.id === snap.serverUuid;
                  const stateH = grStateHealth(m.state);
                  return (
                    <tr key={m.id ?? `${m.host}:${m.port}`}>
                      <td className="repl-mono">
                        {m.host ?? '?'}{m.port !== null ? `:${m.port}` : ''}
                        {isThis && <span className="mgr-this" data-tip="This row is the server you are connected to (@@server_uuid)">this node</span>}
                      </td>
                      <td>
                        {m.role
                          ? <span className={`mgr-badge ${m.role === 'PRIMARY' ? 'mgr-badge-primary' : 'mgr-badge-secondary'}`}>{m.role}</span>
                          : <span className="fg-null">—</span>}
                      </td>
                      <td>
                        {m.state
                          ? <span className={`mgr-badge mgr-state-${stateH ?? 'unknown'}${m.state === 'RECOVERING' ? ' mgr-state-pulse' : ''}`}>{m.state}</span>
                          : <span className="fg-null">—</span>}
                      </td>
                      <td className="repl-mono">{m.version ?? <span className="fg-null">—</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {snap.stats.length > 0 && (
            <div className="repl-section">
              <div className="repl-title">Transaction stats</div>
              <table className="gal-membership mgr-stats">
                <thead>
                  <tr>
                    <th>Member</th>
                    <th data-tip="COUNT_TRANSACTIONS_CHECKED — certification decisions this member took part in">Certified</th>
                    <th data-tip="COUNT_CONFLICTS_DETECTED — certification conflicts (cumulative)">Conflicts</th>
                    <th data-tip="COUNT_TRANSACTIONS_IN_QUEUE — certified, waiting in the certification queue">Cert queue</th>
                    <th data-tip="COUNT_TRANSACTIONS_REMOTE_IN_APPLIER_QUEUE — the apply backlog">Applier queue</th>
                    <th data-tip="COUNT_TRANSACTIONS_REMOTE_APPLIED">Applied</th>
                    <th data-tip="COUNT_TRANSACTIONS_LOCAL_PROPOSED">Proposed</th>
                    <th data-tip="COUNT_TRANSACTIONS_LOCAL_ROLLBACK">Rollback</th>
                  </tr>
                </thead>
                <tbody>
                  {snap.stats.map(s => {
                    const who = snap.members.find(m => m.id === s.memberId);
                    const name = who ? `${who.host ?? '?'}${who.port !== null ? `:${who.port}` : ''}` : (s.memberId ?? '?');
                    const prevS = pair?.prev ? grStatsFor(pair.prev, s.memberId) : null;
                    const queueHealth: Health = s.applierQueue === null ? null
                      : (prevS?.applierQueue !== null && prevS?.applierQueue !== undefined && s.applierQueue > prevS.applierQueue) || s.applierQueue > GR_QUEUE_WARN
                        ? 'warn' : null;
                    const conflictHealth: Health = s.conflicts ? 'warn' : null;
                    return statsRow(s, name, queueHealth, conflictHealth);
                  })}
                </tbody>
              </table>
              <div className="repl-hint">
                Apply lag shows as the applier queue — transactions certified by the group
                but not yet applied here. A queue that only grows poll over poll means this
                member is falling behind (see the findings above).
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
