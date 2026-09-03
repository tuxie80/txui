/**
 * 🏷 Fleet — the checks that run across everything sharing a label.
 *
 * Folders organise the sidebar. **Labels are what functions run on.** Pick
 * `cz-test` — one primary, two replicas — and this connects to all three and
 * answers the questions you cannot answer one server at a time:
 *
 *   - **Variables** — are they configured the same? A replica tuned differently
 *     will not behave like the thing it is standing by for.
 *   - **Indexes** — do they carry the same ones, and *in which direction* do
 *     they differ? On Google Cloud SQL a secondary index can be created only on
 *     a replica, so replica-only is normal there; an index missing *from* a
 *     replica is a failover that changes every query plan.
 *   - **Statistics** — is `mysql.innodb_table_stats` fresh? A table last
 *     measured a month ago is one where a plan flips without the query
 *     changing, which is the failure people describe as "it was fine
 *     yesterday".
 *
 * Roles are **detected**, not configured: a starred primary in a config file
 * goes stale the first time somebody fails over, and then every check that
 * depends on it is quietly wrong. The replication status is the truth.
 *
 * All of it is read-only. Sessions opened here are closed on unmount. The
 * judgement — which differences are findings and which are how it is supposed
 * to be — lives in utils/fleetChecks; this runs it and shows it.
 */
import { errorDisplay } from '../utils/appError';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { ConnectionConfig, QueryResult } from '../types';
import { ConnectionsStore } from '../store/connections';
import { StatusIcon } from './StatusIcon';
import { fleetLabels, hasLabel, labelKey } from '../utils/labels';
import {
  variableDrift, indexDivergence, statsFreshness, worstSeverity, indexKey,
  STALE_DAYS,
} from '../utils/fleetChecks';
import type {
  FleetMember, Role, Severity, VariableDrift, IndexDivergence, IndexRef,
  StatFinding, StatRow,
} from '../utils/fleetChecks';

interface Props {
  /** Pre-selected label, when opened from a chip. */
  label?: string | null;
  onClose: () => void;
}

type Tab = 'variables' | 'indexes' | 'statistics';

const TABS: { id: Tab; label: string }[] = [
  { id: 'variables', label: 'Variables' },
  { id: 'indexes', label: 'Indexes' },
  { id: 'statistics', label: 'Statistics' },
];

interface Member extends FleetMember {
  config: ConnectionConfig;
  sessionId: string | null;
  error: string | null;
}

function pq(sessionId: string, sql: string): Promise<QueryResult> {
  return invoke<QueryResult>('panel_query', { sessionId, sql, token: crypto.randomUUID() });
}

/**
 * Which server is the primary, asked of the server itself.
 *
 * `SHOW REPLICA STATUS` returning rows means this one is following something.
 * Anything else is treated as a primary only when it also reports replicas of
 * its own or simply has no upstream — an isolated server with neither is
 * `unknown`, because guessing "primary" would make a lone server look like the
 * authority in a comparison it should not be part of.
 */
async function detectRole(sessionId: string, engine: string): Promise<Role> {
  try {
    if (engine === 'sqlserver') {
      // Two questions in one, in the order that answers correctly. A readable
      // secondary in an availability group is a replica AND reports
      // READ_ONLY, but a database set READ_ONLY on a standalone instance
      // reports the same thing and is not a replica — so the AG DMVs are asked
      // first, and the updateability answer is the fallback for an instance
      // that has none. Neither raises when Always On is not configured;
      // sys.dm_hadr_* is simply empty.
      const r = await pq(sessionId, `SELECT CASE
        WHEN EXISTS (SELECT 1 FROM sys.dm_hadr_database_replica_states rs
                     JOIN sys.dm_hadr_availability_replica_states ars
                       ON ars.replica_id = rs.replica_id
                     WHERE rs.database_id = DB_ID() AND ars.role_desc = 'SECONDARY')
          THEN 'replica'
        WHEN CONVERT(varchar(30), DATABASEPROPERTYEX(DB_NAME(), 'Updateability')) <> 'READ_WRITE'
          THEN 'replica'
        ELSE 'primary' END`);
      const role = String(r.rows[0]?.[0] ?? '');
      return role === 'replica' ? 'replica' : role === 'primary' ? 'primary' : 'unknown';
    }
    if (engine === 'mysql') {
      const r = await pq(sessionId, 'SHOW REPLICA STATUS');
      if (r.rows.length > 0) return 'replica';
      const legacy = await pq(sessionId, 'SHOW SLAVE STATUS').catch(() => null);
      if (legacy && legacy.rows.length > 0) return 'replica';
      const ro = await pq(sessionId, 'SELECT @@read_only').catch(() => null);
      // A writable server with no upstream is the primary.
      if (ro && String(ro.rows[0]?.[0] ?? '1') === '0') return 'primary';
      return 'unknown';
    }
    const r = await pq(sessionId, 'SELECT pg_is_in_recovery()');
    const inRecovery = String(r.rows[0]?.[0] ?? '').toLowerCase();
    return inRecovery === 'true' || inRecovery === 't' ? 'replica' : 'primary';
  } catch {
    return 'unknown';
  }
}

export function FleetPanel({ label: initialLabel, onClose }: Props) {
  const [conns, setConns] = useState<ConnectionConfig[]>([]);
  const [labelChoice, setLabelChoice] = useState(initialLabel ?? '');
  const [members, setMembers] = useState<Member[]>([]);
  const [tab, setTab] = useState<Tab>('variables');
  const [loading, setLoading] = useState(false);
  const [ranAt, setRanAt] = useState<number | null>(null);
  const [showExpected, setShowExpected] = useState(false);

  const [drift, setDrift] = useState<VariableDrift[] | null>(null);
  const [indexes, setIndexes] = useState<IndexDivergence[] | null>(null);
  const [stats, setStats] = useState<StatFinding[] | null>(null);

  const alive = useRef(true);
  const opened = useRef<string[]>([]);

  useEffect(() => {
    ConnectionsStore.list().then(setConns).catch(() => {});
  }, []);

  const labels = useMemo(() => fleetLabels(conns), [conns]);
  // Derived rather than stored: "no choice yet" and "the first label" are the
  // same state, and an effect that writes one into the other just adds a render
  // and a chance for them to disagree.
  const label = labelChoice || labels[0]?.name || '';

  const chosen = useMemo(
    () => conns.filter(c => label && hasLabel(c, label) && c.engine !== 'redis'),
    [conns, label]);

  /** Connect to every member of the label and detect its role. */
  const connect = useCallback(async () => {
    for (const sid of opened.current) ConnectionsStore.close(sid).catch(() => {});
    opened.current = [];
    if (chosen.length === 0) {
      // An empty label clears the previous one's members immediately, rather
      // than after a round-trip that never happens.
      setMembers([]);
      return;
    }
    setLoading(true);
    const built: Member[] = await Promise.all(chosen.map(async config => {
      try {
        const sessionId = await ConnectionsStore.open(config.id);
        opened.current.push(sessionId);
        const role = await detectRole(sessionId, config.engine);
        return { id: config.id, name: config.name, role, config, sessionId, error: null };
      } catch (e) {
        return {
          id: config.id, name: config.name, role: 'unknown' as Role,
          config, sessionId: null, error: errorDisplay(e),
        };
      }
    }));
    if (!alive.current) return;
    setMembers(built);
    setLoading(false);
  }, [chosen]);

  useEffect(() => {
    alive.current = true;
    void connect();
    return () => {
      alive.current = false;
      for (const sid of opened.current) ConnectionsStore.close(sid).catch(() => {});
      opened.current = [];
    };
  }, [connect]);

  const live = useMemo(() => members.filter(m => m.sessionId), [members]);
  const engine = live[0]?.config.engine ?? 'mysql';
  const isMysql = engine === 'mysql';
  const isMssql = engine === 'sqlserver';

  /** Run every check. One pass, so a single Refresh answers the whole panel. */
  const run = useCallback(async () => {
    if (live.length < 2) return;
    setLoading(true);

    // ── variables ──
    // `sys.configurations` is the direct analogue: name/value pairs the
    // instance is actually running with. `value_in_use`, not `value` — a
    // setting changed but not RECONFIGUREd is not in effect, and reporting the
    // staged value would say two servers agree when they do not.
    const varSql = isMssql
      ? "SELECT name, CONVERT(varchar(64), value_in_use) FROM sys.configurations"
      : isMysql ? 'SHOW GLOBAL VARIABLES' : 'SHOW ALL';
    const vars = new Map<string, Map<string, string>>();
    await Promise.all(live.map(async m => {
      try {
        const r = await pq(m.sessionId!, varSql);
        const map = new Map<string, string>();
        for (const row of r.rows) map.set(String(row[0]), String(row[1] ?? ''));
        vars.set(m.id, map);
      } catch { /* a member that cannot answer is simply absent */ }
    }));

    // ── indexes ──
    const idxSql = isMssql
      // `i.name IS NOT NULL` drops heaps, which sys.indexes lists as a row with
      // no name — a nameless "index" on every heap would show as divergence the
      // moment one server has a heap and another does not.
      ? `SELECT s.name, t.name, i.name
         FROM sys.indexes i
         JOIN sys.tables t ON t.object_id = i.object_id
         JOIN sys.schemas s ON s.schema_id = t.schema_id
         WHERE i.name IS NOT NULL AND t.is_ms_shipped = 0`
      : isMysql
      ? `SELECT table_schema, table_name, index_name FROM information_schema.statistics
         WHERE table_schema NOT IN ('mysql','sys','information_schema','performance_schema')
         GROUP BY table_schema, table_name, index_name`
      : `SELECT schemaname, tablename, indexname FROM pg_indexes
         WHERE schemaname NOT IN ('pg_catalog','information_schema')`;
    const idx = new Map<string, Set<string>>();
    const refs = new Map<string, IndexRef>();
    await Promise.all(live.map(async m => {
      try {
        const r = await pq(m.sessionId!, idxSql);
        const set = new Set<string>();
        for (const row of r.rows) {
          const ref: IndexRef = {
            schema: String(row[0]), table: String(row[1]), index: String(row[2]),
          };
          const k = indexKey(ref);
          refs.set(k, ref);
          set.add(k);
        }
        idx.set(m.id, set);
      } catch { /* skipped, not counted as "everything missing" */ }
    }));

    // ── statistics ──
    const stat = new Map<string, StatRow[]>();
    if (isMssql) {
      await Promise.all(live.map(async m => {
        try {
          // The freshest statistic on each table, as epoch milliseconds — the
          // same shape MySQL's innodb_table_stats.last_update has. A table with
          // no statistics at all answers NULL rather than 0, so "never
          // analysed" stays distinguishable from "analysed at the epoch".
          const r = await pq(m.sessionId!, `SELECT s.name, t.name,
              CONVERT(bigint, DATEDIFF_BIG(millisecond, '1970-01-01', st.last_updated)),
              p.row_count
            FROM sys.tables t
            JOIN sys.schemas s ON s.schema_id = t.schema_id
            OUTER APPLY (SELECT MAX(sp.last_updated) AS last_updated
                         FROM sys.stats x
                         CROSS APPLY sys.dm_db_stats_properties(x.object_id, x.stats_id) sp
                         WHERE x.object_id = t.object_id) st
            OUTER APPLY (SELECT SUM(ps.row_count) AS row_count
                         FROM sys.dm_db_partition_stats ps
                         WHERE ps.object_id = t.object_id AND ps.index_id IN (0, 1)) p
            WHERE t.is_ms_shipped = 0`);
          stat.set(m.id, r.rows.map(row => ({
            schema: String(row[0]), table: String(row[1]),
            lastUpdate: row[2] == null ? null : Number(row[2]),
            rows: row[3] == null ? null : Number(row[3]),
          })));
        } catch { /* not readable — reported as an empty section */ }
      }));
    } else if (isMysql) {
      await Promise.all(live.map(async m => {
        try {
          const r = await pq(m.sessionId!,
            `SELECT database_name, table_name,
                    UNIX_TIMESTAMP(last_update) * 1000, n_rows
             FROM mysql.innodb_table_stats
             WHERE database_name NOT IN ('mysql','sys')`);
          stat.set(m.id, r.rows.map(row => ({
            schema: String(row[0]), table: String(row[1]),
            lastUpdate: row[2] == null ? null : Number(row[2]),
            rows: row[3] == null ? null : Number(row[3]),
          })));
        } catch { /* not available — reported as an empty section */ }
      }));
    } else {
      await Promise.all(live.map(async m => {
        try {
          const r = await pq(m.sessionId!,
            `SELECT schemaname, relname,
                    EXTRACT(EPOCH FROM GREATEST(last_analyze, last_autoanalyze)) * 1000,
                    n_live_tup
             FROM pg_stat_user_tables`);
          stat.set(m.id, r.rows.map(row => ({
            schema: String(row[0]), table: String(row[1]),
            lastUpdate: row[2] == null ? null : Number(row[2]),
            rows: row[3] == null ? null : Number(row[3]),
          })));
        } catch { /* ignored */ }
      }));
    }

    if (!alive.current) return;
    const fm: FleetMember[] = live.map(m => ({ id: m.id, name: m.name, role: m.role }));
    setDrift(variableDrift(fm, vars, { includeExpected: showExpected }));
    setIndexes(indexDivergence(fm, idx, refs));
    setStats(statsFreshness(fm, stat, Date.now()));
    setRanAt(Date.now());
    setLoading(false);
  }, [live, isMysql, isMssql, showExpected]);

  // Runs once the members are connected, and again when the exclusion toggle
  // changes. `run` itself is async and sets state only after awaiting, but the
  // rule cannot see through the call.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (live.length >= 2) void run(); }, [live.length, showExpected]);

  const badge = (items: { severity: Severity }[] | null) => {
    const w = items ? worstSeverity(items) : null;
    if (!w || !items || items.length === 0) return null;
    return <span className={`fl-badge fl-badge-${w}`}>{items.length}</span>;
  };

  const nameOf = (id: string) => members.find(m => m.id === id)?.name ?? id;

  return (
    <div className="fleet">
      <div className="panel-header">
        <span className="panel-title">🏷 Fleet</span>
        <select className="fl-label-pick" value={label} onChange={e => setLabelChoice(e.target.value)}>
          {labels.length === 0 && <option value="">— no label names more than one server —</option>}
          {labels.map(l => (
            <option key={labelKey(l.name)} value={l.name}>
              {l.hidden ? `◌ ${l.name}` : l.name} ({l.members.length})
            </option>
          ))}
        </select>
        <div style={{ flex: 1 }} />
        {ranAt && <span className="fl-ran">checked {new Date(ranAt).toLocaleTimeString()}</span>}
        <button className="toolbar-btn" onClick={() => void run()} disabled={loading || live.length < 2}>
          {loading ? '…' : '↻ Re-check'}
        </button>
        <button className="icon-btn" onClick={onClose} title="Close">×</button>
      </div>

      {labels.length === 0 && (
        <div className="fl-note">
          No label names more than one server yet. Labels are set per connection —
          folders organise the sidebar, labels are what these checks run on.
        </div>
      )}

      {/* Who is in this label, and what each one is. Roles are detected from
          the servers themselves, so a failover cannot leave this wrong. */}
      {members.length > 0 && (
        <div className="fl-members">
          {members.map(m => (
            <span key={m.id} className={`fl-member fl-role-${m.role}${m.error ? ' fl-member-down' : ''}`}
                  title={m.error ?? `${m.config.host ?? ''} · ${m.role}`}>
              <span className="fl-role">{m.role === 'primary' ? 'P' : m.role === 'replica' ? 'R' : '?'}</span>
              {m.name}
              {m.error && <StatusIcon kind="error" size={11} />}
            </span>
          ))}
          {live.length < 2 && !loading && (
            <span className="fl-note-inline">
              at least two reachable servers are needed to compare anything
            </span>
          )}
        </div>
      )}

      <div className="fl-tabs" role="tablist">
        {TABS.map(t => (
          <button key={t.id} role="tab" aria-selected={tab === t.id}
                  className={`fl-tab${tab === t.id ? ' active' : ''}`}
                  onClick={() => setTab(t.id)}>
            {t.label}
            {t.id === 'variables' && badge(drift)}
            {t.id === 'indexes' && badge(indexes)}
            {t.id === 'statistics' && badge(stats)}
          </button>
        ))}
      </div>

      <div className="fl-body">
        {tab === 'variables' && (
          <>
            <label className="fl-opt">
              <input type="checkbox" checked={showExpected}
                     onChange={e => setShowExpected(e.target.checked)} />
              <span>
                Include variables expected to differ
                <em> — server_id, hostname, read_only, paths… These differ by design;
                  reporting them every time is how a real finding gets skipped past.</em>
              </span>
            </label>
            {drift?.length === 0 && (
              <div className="fl-ok"><StatusIcon kind="ok" /> Every checked variable agrees across {live.length} servers.</div>
            )}
            {drift?.map(d => (
              <div key={d.name} className={`fl-row fl-${d.severity}`}>
                <div className="fl-row-head">
                  <code>{d.name}</code>
                  <span className="fl-muted">
                    {d.outliers.length === 1
                      ? `${nameOf(d.outliers[0])} differs`
                      : `${d.outliers.length} of ${live.length} differ`}
                  </span>
                </div>
                <div className="fl-values">
                  {live.map(m => {
                    const v = d.values.get(m.id);
                    const odd = d.outliers.includes(m.id);
                    return (
                      <span key={m.id} className={`fl-val${odd ? ' fl-val-odd' : ''}`}>
                        <b>{m.name}</b>
                        <code>{v === undefined ? '— not set —' : v || "''"}</code>
                      </span>
                    );
                  })}
                </div>
              </div>
            ))}
          </>
        )}

        {tab === 'indexes' && (
          <>
            {indexes?.length === 0 && (
              <div className="fl-ok"><StatusIcon kind="ok" /> Every server carries the same indexes.</div>
            )}
            {indexes?.map(d => (
              <div key={indexKey(d.index)} className={`fl-row fl-${d.severity}`}>
                <div className="fl-row-head">
                  <code>{d.index.schema}.{d.index.table}</code>
                  <code className="fl-idx">{d.index.index}</code>
                  <span className={`fl-kind fl-kind-${d.kind}`}>{d.kind.replace(/-/g, ' ')}</span>
                </div>
                <div className="fl-note-sm">{d.note}</div>
                <div className="fl-values">
                  <span className="fl-val"><b>on</b> {d.present.map(nameOf).join(', ')}</span>
                  <span className="fl-val fl-val-odd"><b>missing</b> {d.absent.map(nameOf).join(', ')}</span>
                </div>
              </div>
            ))}
          </>
        )}

        {tab === 'statistics' && (
          <>
            {stats?.length === 0 && (
              <div className="fl-ok">
                <StatusIcon kind="ok" /> No table has statistics older than {STALE_DAYS} days.
              </div>
            )}
            {stats?.map(f => (
              <div key={`${f.schema}.${f.table}`} className={`fl-row fl-${f.severity}`}>
                <div className="fl-row-head">
                  <code>{f.schema}.{f.table}</code>
                  <span className="fl-muted">
                    {f.worstAgeDays === null ? 'never measured' : `${Math.round(f.worstAgeDays)} days old`}
                  </span>
                </div>
                <div className="fl-note-sm">{f.note}</div>
                <div className="fl-values">
                  {live.map(m => {
                    const age = f.ageDays.get(m.id);
                    return (
                      <span key={m.id} className={`fl-val${age === null || (age ?? 0) >= STALE_DAYS ? ' fl-val-odd' : ''}`}>
                        <b>{m.name}</b>
                        <code>{age === undefined ? '—' : age === null ? 'never' : `${Math.round(age)}d`}</code>
                      </span>
                    );
                  })}
                </div>
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}
