/**
 * Replica set dashboard — the folder-as-a-group tooling from
 * docs/REPLICASET_DEEPDIVE.md. Opens ephemeral sessions to every member of a
 * replica-set folder and shows, side by side:
 *
 *   1. Replication matrix — per-member lag / IO / SQL / errors (5 s poll),
 *      worst lag first (use case D)
 *   2. Unused-index intersection — only indexes unused on EVERY member are
 *      safe drop candidates; per-member uptime shown as the caveat (use case B)
 *   3. Config & version drift — key settings across members, differing
 *      values highlighted (use cases C/F, config part)
 *
 * Everything is read-only. Sessions opened here are closed on unmount.
 */
import { errorDisplay } from '../utils/appError';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { ConnectionConfig, QueryResult } from '../types';
import { ConnectionsStore } from '../store/connections';
import { getFolderMeta } from '../store/folderMeta';
import { usePoll } from '../hooks/usePoll';

interface Props {
  folder: string;
  onClose: () => void;
}

interface ReplSection {
  title: string;
  kv: [string, string][] | null;
  table: QueryResult | null;
}

interface Member {
  config: ConnectionConfig;
  sessionId: string | null;
  connectError: string | null;
}

interface ReplRow {
  lag: number | null;          // worst lag across channels, seconds
  ioRunning: string;
  sqlRunning: string;
  lastError: string;
  role: 'primary' | 'replica' | '—';
}

interface IndexKey { schema: string; table: string; index: string }

const POLL_MS = 5000;

function pq(sessionId: string, sql: string): Promise<QueryResult> {
  return invoke<QueryResult>('panel_query', { sessionId, sql, token: crypto.randomUUID() });
}

/** Pull the interesting bits out of the engine-shaped replication sections. */
function summarizeRepl(sections: ReplSection[], isPrimary: boolean): ReplRow {
  let lag: number | null = null;
  let io = '—', sql = '—', error = '';
  let sawReplicaSection = false;
  for (const s of sections) {
    for (const [k, v] of s.kv ?? []) {
      if (/seconds_behind/i.test(k) && v !== '' && v.toLowerCase() !== 'null') {
        sawReplicaSection = true;
        const n = Number(v);
        if (!Number.isNaN(n)) lag = Math.max(lag ?? 0, n);
      }
      if (/(replica|slave)_io_running$/i.test(k)) { io = v; sawReplicaSection = true; }
      if (/(replica|slave)_sql_running$/i.test(k)) { sql = v; sawReplicaSection = true; }
      if (/^last_(io_|sql_)?error$/i.test(k) && v.trim()) error = v;
      // PG standby: pg_last_wal_replay info arrives as kv too
      if (/replay_lag|lag_seconds/i.test(k) && v.trim()) {
        sawReplicaSection = true;
        const n = parseFloat(v);
        if (!Number.isNaN(n)) lag = Math.max(lag ?? 0, n);
      }
      if (/in_recovery/i.test(k) && /^t(rue)?$/i.test(v.trim())) sawReplicaSection = true;
    }
  }
  return {
    lag,
    ioRunning: io,
    sqlRunning: sql,
    lastError: error,
    role: isPrimary ? 'primary' : sawReplicaSection ? 'replica' : '—',
  };
}

const MYSQL_DRIFT_SQL =
  "SELECT @@version AS version, @@read_only AS read_only, @@super_read_only AS super_read_only, " +
  "@@binlog_format AS binlog_format, @@gtid_mode AS gtid_mode, @@sync_binlog AS sync_binlog, " +
  "@@innodb_flush_log_at_trx_commit AS innodb_flush_log_at_trx_commit, @@max_connections AS max_connections, " +
  "@@innodb_buffer_pool_size AS innodb_buffer_pool_size";
const PG_DRIFT_SQL =
  "SELECT current_setting('server_version') AS version, pg_is_in_recovery()::text AS in_recovery, " +
  "current_setting('wal_level') AS wal_level, current_setting('synchronous_commit') AS synchronous_commit, " +
  "current_setting('max_connections') AS max_connections, current_setting('shared_buffers') AS shared_buffers, " +
  "current_setting('work_mem') AS work_mem";

const MYSQL_UNUSED_SQL =
  'SELECT object_schema, object_name, index_name FROM sys.schema_unused_indexes LIMIT 2000';
const PG_UNUSED_SQL =
  'SELECT schemaname, relname, indexrelname FROM pg_stat_user_indexes WHERE idx_scan = 0 LIMIT 2000';
const MYSQL_UPTIME_SQL =
  "SELECT VARIABLE_VALUE FROM performance_schema.global_status WHERE VARIABLE_NAME = 'Uptime'";
const PG_UPTIME_SQL =
  'SELECT EXTRACT(EPOCH FROM now() - pg_postmaster_start_time())::bigint::text';

function fmtUptime(sec: number | null): string {
  if (sec === null) return '—';
  if (sec < 3600) return `${Math.round(sec / 60)}min`;
  if (sec < 86400) return `${(sec / 3600).toFixed(1)}h`;
  return `${(sec / 86400).toFixed(1)}d`;
}

export function ReplicaSetPanel({ folder, onClose }: Props) {
  const [members, setMembers] = useState<Member[]>([]);
  const [repl, setRepl] = useState<Map<string, ReplRow | { error: string }>>(new Map());
  const [drift, setDrift] = useState<Map<string, Record<string, string> | { error: string }>>(new Map());
  const [unused, setUnused] = useState<{
    common: IndexKey[];
    perMember: Map<string, number>;      // connection id → unused count on that member
    uptime: Map<string, number | null>;  // connection id → uptime seconds
    loaded: boolean;
    minMembers: number;
  } | null>(null);
  const [loadingIdx, setLoadingIdx] = useState(false);
  const openedRef = useRef<string[]>([]);
  const aliveRef = useRef(true);
  const primaryId = getFolderMeta(folder).primaryId ?? null;

  // ── Connect to every member on mount, close on unmount ─────────────────────
  useEffect(() => {
    aliveRef.current = true;
    (async () => {
      const all = await ConnectionsStore.list().catch(() => [] as ConnectionConfig[]);
      const inFolder = all.filter(c => {
        const g = c.group ?? '';
        return (g === folder || g.startsWith(folder + '/')) && c.engine !== 'redis';
      });
      const connected: Member[] = await Promise.all(inFolder.map(async config => {
        try {
          const sessionId = await ConnectionsStore.open(config.id);
          openedRef.current.push(sessionId);
          return { config, sessionId, connectError: null };
        } catch (e) {
          return { config, sessionId: null, connectError: errorDisplay(e) };
        }
      }));
      if (aliveRef.current) setMembers(connected);
    })();
    return () => {
      aliveRef.current = false;
      for (const sid of openedRef.current) {
        ConnectionsStore.close(sid).catch(() => {});
      }
      openedRef.current = [];
    };
  }, [folder]);

  const live = useMemo(() => members.filter(m => m.sessionId), [members]);

  // ── 1. Replication matrix — poll ────────────────────────────────────────────
  const pollRepl = useCallback(async () => {
    const next = new Map<string, ReplRow | { error: string }>();
    await Promise.all(live.map(async m => {
      try {
        const sections = await invoke<ReplSection[]>('replication_status', { sessionId: m.sessionId });
        next.set(m.config.id, summarizeRepl(sections, m.config.id === primaryId));
      } catch (e) {
        next.set(m.config.id, { error: errorDisplay(e) });
      }
    }));
    if (aliveRef.current) setRepl(next);
  }, [live, primaryId]);

  // Loop + in-flight guard + hidden-tab gate via hooks/usePoll: the unguarded
  // copy fanned replication_status to every member every 5 s — one unreachable
  // member stacked overlapping N-server rounds, and the whole fleet kept being
  // polled while the tab was hidden.
  usePoll(pollRepl, POLL_MS / 1000, {
    immediate: live.length > 0,
    paused: live.length === 0,
  });

  // ── 2. Config & version drift — once per connect ────────────────────────────
  useEffect(() => {
    if (live.length === 0) return;
    (async () => {
      const next = new Map<string, Record<string, string> | { error: string }>();
      await Promise.all(live.map(async m => {
        try {
          const sql = m.config.engine === 'mysql' ? MYSQL_DRIFT_SQL : PG_DRIFT_SQL;
          const r = await pq(m.sessionId!, sql);
          const row: Record<string, string> = {};
          r.columns.forEach((c, i) => { row[c.name] = String(r.rows[0]?.[i] ?? ''); });
          next.set(m.config.id, row);
        } catch (e) {
          next.set(m.config.id, { error: errorDisplay(e) });
        }
      }));
      if (aliveRef.current) setDrift(next);
    })();
  }, [live]);

  // ── 3. Unused-index intersection — on demand (heavier) ─────────────────────
  const loadUnused = useCallback(async () => {
    setLoadingIdx(true);
    try {
      const perMember = new Map<string, number>();
      const uptime = new Map<string, number | null>();
      const sets: Map<string, IndexKey>[] = [];
      await Promise.all(live.map(async m => {
        try {
          const isMy = m.config.engine === 'mysql';
          const [idx, up] = await Promise.all([
            pq(m.sessionId!, isMy ? MYSQL_UNUSED_SQL : PG_UNUSED_SQL),
            pq(m.sessionId!, isMy ? MYSQL_UPTIME_SQL : PG_UPTIME_SQL).catch(() => null),
          ]);
          const set = new Map<string, IndexKey>();
          for (const row of idx.rows) {
            const key: IndexKey = { schema: String(row[0]), table: String(row[1]), index: String(row[2]) };
            set.set(`${key.schema}.${key.table}.${key.index}`, key);
          }
          sets.push(set);
          perMember.set(m.config.id, set.size);
          const upVal = up?.rows?.[0]?.[0];
          uptime.set(m.config.id, upVal != null ? Number(upVal) : null);
        } catch {
          perMember.set(m.config.id, -1); // query failed on this member
          uptime.set(m.config.id, null);
        }
      }));
      // Intersection over members that answered — an index is a drop candidate
      // only when EVERY answering member reports it unused.
      const answering = sets.length;
      let common: IndexKey[] = [];
      if (answering > 0) {
        const counter = new Map<string, { key: IndexKey; n: number }>();
        for (const set of sets) {
          for (const [k, key] of set) {
            const e = counter.get(k);
            if (e) e.n += 1; else counter.set(k, { key, n: 1 });
          }
        }
        common = [...counter.values()].filter(e => e.n === answering).map(e => e.key)
          .sort((a, b) => a.schema.localeCompare(b.schema) || a.table.localeCompare(b.table) || a.index.localeCompare(b.index));
      }
      if (aliveRef.current) setUnused({ common, perMember, uptime, loaded: true, minMembers: answering });
    } finally {
      if (aliveRef.current) setLoadingIdx(false);
    }
  }, [live]);

  // ── Drift matrix shape ──────────────────────────────────────────────────────
  const driftMatrix = useMemo(() => {
    const rows: { setting: string; values: (string | null)[]; differs: boolean }[] = [];
    if (live.length === 0) return rows;
    const keys = new Set<string>();
    for (const m of live) {
      const d = drift.get(m.config.id);
      if (d && !('error' in d)) Object.keys(d).forEach(k => keys.add(k));
    }
    for (const k of keys) {
      const values = live.map(m => {
        const d = drift.get(m.config.id);
        return d && !('error' in d) ? (d[k] ?? null) : null;
      });
      const present = values.filter((v): v is string => v !== null);
      const differs = present.length > 1 && new Set(present).size > 1;
      rows.push({ setting: k, values, differs });
    }
    rows.sort((a, b) => Number(b.differs) - Number(a.differs) || a.setting.localeCompare(b.setting));
    return rows;
  }, [live, drift]);

  const sortedByLag = useMemo(() => {
    return [...live].sort((a, b) => {
      const ra = repl.get(a.config.id), rb = repl.get(b.config.id);
      const la = ra && !('error' in ra) ? ra.lag ?? -1 : -2;
      const lb = rb && !('error' in rb) ? rb.lag ?? -1 : -2;
      return lb - la;
    });
  }, [live, repl]);

  return (
    <div className="proc-panel rs-panel">
      <div className="proc-toolbar">
        <span className="proc-title">🔁 Replica set — {folder}</span>
        <span className="dv-desc">
          {members.length} member{members.length !== 1 ? 's' : ''}
          {members.some(m => m.connectError) &&
            ` · ${members.filter(m => m.connectError).length} unreachable`}
          {' · read-only'}
        </span>
        <div style={{ flex: 1 }} />
        <button className="toolbar-btn" onClick={pollRepl}>↻ Refresh</button>
        <button className="icon-btn" onClick={onClose} title="Close">×</button>
      </div>

      <div className="rs-body">
        {members.length === 0 && <div className="mx-empty">Connecting to members…</div>}

        {members.some(m => m.connectError) && (
          <div className="rs-connect-errors">
            {members.filter(m => m.connectError).map(m => (
              <div key={m.config.id} className="rs-conn-err">
                ⚠ {m.config.name}: {m.connectError}
              </div>
            ))}
          </div>
        )}

        {live.length > 0 && (
          <>
            {/* ── Replication matrix ── */}
            <div className="rs-section">
              <div className="rs-section-title">Replication — worst lag first <span className="dv-desc">(polls every 5 s)</span></div>
              <table className="rs-table">
                <thead>
                  <tr><th>member</th><th>role</th><th>lag</th><th>IO</th><th>SQL</th><th>last error</th></tr>
                </thead>
                <tbody>
                  {sortedByLag.map(m => {
                    const r = repl.get(m.config.id);
                    if (!r) return <tr key={m.config.id}><td>{m.config.name}</td><td colSpan={5} className="rs-dim">…</td></tr>;
                    if ('error' in r) return <tr key={m.config.id}><td>{m.config.name}</td><td colSpan={5} className="rs-err">{r.error.slice(0, 120)}</td></tr>;
                    const lagCls = r.lag === null ? '' : r.lag > 60 ? 'rs-bad' : r.lag > 5 ? 'rs-warn' : 'rs-ok';
                    return (
                      <tr key={m.config.id}>
                        <td>{m.config.name}{m.config.id === primaryId ? ' ★' : ''}</td>
                        <td>{r.role}</td>
                        <td className={lagCls}>{r.lag === null ? '—' : `${r.lag}s`}</td>
                        <td className={/yes|streaming/i.test(r.ioRunning) ? 'rs-ok' : r.ioRunning === '—' ? '' : 'rs-bad'}>{r.ioRunning}</td>
                        <td className={/yes/i.test(r.sqlRunning) ? 'rs-ok' : r.sqlRunning === '—' ? '' : 'rs-bad'}>{r.sqlRunning}</td>
                        <td className="rs-err-cell" title={r.lastError}>{r.lastError.slice(0, 80) || '—'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* ── Unused-index intersection ── */}
            <div className="rs-section">
              <div className="rs-section-title">
                Unused indexes — intersection across all members
                <span className="dv-desc">(safe drop candidates: unused on EVERY member; mind the uptimes)</span>
                <button className="toolbar-btn" onClick={loadUnused} disabled={loadingIdx}>
                  {loadingIdx ? 'Scanning…' : unused ? '↻ Rescan' : '▶ Scan'}
                </button>
              </div>
              {unused?.loaded && (
                <>
                  <div className="rs-uptimes">
                    {live.map(m => (
                      <span key={m.config.id} className="rs-uptime">
                        {m.config.name}: {unused.perMember.get(m.config.id) === -1
                          ? 'query failed'
                          : `${unused.perMember.get(m.config.id)} unused`}
                        {' · up '}{fmtUptime(unused.uptime.get(m.config.id) ?? null)}
                      </span>
                    ))}
                  </div>
                  {unused.common.length === 0
                    ? <div className="mx-empty">No index is unused on all {unused.minMembers} answering members.</div>
                    : (
                      <table className="rs-table">
                        <thead><tr><th>schema</th><th>table</th><th>index</th></tr></thead>
                        <tbody>
                          {unused.common.slice(0, 200).map(k => (
                            <tr key={`${k.schema}.${k.table}.${k.index}`}>
                              <td>{k.schema}</td><td>{k.table}</td><td>{k.index}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  {unused.common.length > 200 && (
                    <div className="dv-desc">…and {unused.common.length - 200} more</div>
                  )}
                </>
              )}
            </div>

            {/* ── Config & version drift ── */}
            <div className="rs-section">
              <div className="rs-section-title">Config & version drift <span className="dv-desc">(differing values highlighted, drift first)</span></div>
              {driftMatrix.length === 0
                ? <div className="mx-empty">Loading settings…</div>
                : (
                  <table className="rs-table">
                    <thead>
                      <tr>
                        <th>setting</th>
                        {live.map(m => <th key={m.config.id}>{m.config.name}</th>)}
                      </tr>
                    </thead>
                    <tbody>
                      {driftMatrix.map(row => (
                        <tr key={row.setting} className={row.differs ? 'rs-drift' : ''}>
                          <td>{row.setting}</td>
                          {row.values.map((v, i) => (
                            <td key={i} className={row.differs ? 'rs-warn' : ''}>{v ?? '—'}</td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
