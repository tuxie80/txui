/**
 * Schema comparator ⇆ — two instances or two schemas on one instance.
 * Compares every object type, shows only-left / only-right / different /
 * identical with property-level details, side-by-side DDL diff on click,
 * exports a .md report and a reviewed-only migration script (both directions).
 *
 * MySQL and PostgreSQL. Both sides must be the same engine — a cross-engine
 * pair is refused rather than diffed, since the two share almost no DDL
 * vocabulary and every column would read as "different".
 */
import { errorDisplay } from '../utils/appError';
import { can } from '../utils/engineCaps';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { ConnectionConfig, QueryResult } from '../types';
import { ConnectionsStore } from '../store/connections';
import {
  fetchSnapshotFor, diffSnapshots, generateMigration,
} from '../utils/schemaDiff';
import type { Snapshot, DiffEntry, ObjectKind, DiffStatus } from '../utils/schemaDiff';
import { lineDiff } from '../utils/lineDiff';
import type { DiffRow } from '../utils/lineDiff';
import { saveTextAs } from '../utils/exportersIo';
import { mdTable } from '../utils/qualityReport';
import { basename } from '../utils/platform';

interface SideState {
  connId: string;
  schemas: string[];
  schema: string;
}

// Kinds a given engine can produce; empty families simply never appear.
const KINDS: ObjectKind[] = ['schema', 'table', 'view', 'matview', 'procedure', 'function',
                            'trigger', 'event', 'sequence', 'type'];
const KIND_ICON: Record<ObjectKind, string> = {
  schema: '🗄', table: '▦', view: '👁', matview: '📀', procedure: '⚙', function: 'ƒ',
  trigger: '⚡', event: '⏰', sequence: '🔢', type: '🏷',
};
const STATUS_LABEL: Record<DiffStatus, string> = {
  only_left: '◀ only left', only_right: 'only right ▶', different: '≠ different', same: '= identical',
};

interface PanelProps { onClose?: () => void }

export function SchemaComparePanel({ onClose }: PanelProps) {
  const [conns, setConns] = useState<ConnectionConfig[]>([]);
  const [left, setLeft] = useState<SideState>({ connId: '', schemas: [], schema: '' });
  const [right, setRight] = useState<SideState>({ connId: '', schemas: [], schema: '' });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ diff: DiffEntry[]; left: Snapshot; right: Snapshot } | null>(null);
  const [hideSame, setHideSame] = useState(true);
  const [ddlView, setDdlView] = useState<{ name: string; rows: DiffRow[] } | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  // comparator-owned sessions: connId → sessionId (closed on unmount)
  const sessionsRef = useRef<Map<string, string>>(new Map());

  useEffect(() => {
    ConnectionsStore.list()
      // Both engines are comparable; a cross-engine pair is refused below.
      .then(list => setConns(list.filter(c => can(c.engine, 'sqlDba'))))
      .catch(() => {});
    const sessions = sessionsRef.current;
    return () => {
      for (const sid of sessions.values()) ConnectionsStore.close(sid).catch(() => {});
      sessions.clear();
    };
  }, []);

  const note = (m: string) => { setFlash(m); setTimeout(() => setFlash(null), 2500); };

  const ensureSession = useCallback(async (connId: string): Promise<string> => {
    const hit = sessionsRef.current.get(connId);
    if (hit) return hit;
    const sid = await ConnectionsStore.open(connId);
    sessionsRef.current.set(connId, sid);
    return sid;
  }, []);

  const runnerFor = useCallback((sessionId: string) =>
    (sql: string) => invoke<QueryResult>('monitor_query', { sessionId, sql }), []);

  const pickConnection = useCallback(async (side: 'left' | 'right', connId: string) => {
    const set = side === 'left' ? setLeft : setRight;
    set(s => ({ ...s, connId, schemas: [], schema: '' }));
    if (!connId) return;
    setError(null);
    setBusy(`Loading schemas (${side})…`);
    try {
      const sid = await ensureSession(connId);
      const engine = conns.find(c => c.id === connId)?.engine ?? 'mysql';
      // pg_namespace rather than information_schema.schemata: before PG 14 the
      // latter lists only schemas the role OWNS, so a reporting account would
      // see an empty picker.
      const r = await runnerFor(sid)(engine === 'postgres'
        ? "SELECT nspname FROM pg_catalog.pg_namespace WHERE nspname NOT LIKE 'pg\\_%' AND nspname <> 'information_schema' AND has_schema_privilege(oid,'USAGE') ORDER BY nspname"
        : "SELECT schema_name FROM information_schema.schemata WHERE schema_name NOT IN ('mysql','sys','performance_schema','information_schema') ORDER BY schema_name");
      const schemas = r.rows.map(row => String(row[0]));
      set(s => ({ ...s, schemas, schema: schemas[0] ?? '' }));
    } catch (e) {
      setError(errorDisplay(e));
    } finally {
      setBusy(null);
    }
  }, [ensureSession, runnerFor, conns]);

  const compare = useCallback(async () => {
    if (!left.connId || !right.connId || !left.schema || !right.schema) return;
    const lEngine = conns.find(c => c.id === left.connId)?.engine ?? 'mysql';
    const rEngine = conns.find(c => c.id === right.connId)?.engine ?? 'mysql';
    if (lEngine !== rEngine) {
      // A MySQL table and a PostgreSQL table share almost no vocabulary —
      // every column would read as "different" and the migration script would
      // be nonsense. Refuse rather than produce a misleading diff.
      setError(`Cannot compare ${lEngine} with ${rEngine} — both sides must be the same engine.`);
      return;
    }
    setError(null);
    setResult(null);
    setDdlView(null);
    try {
      setBusy('Snapshotting left…');
      const lsid = await ensureSession(left.connId);
      const lsnap = await fetchSnapshotFor(runnerFor(lsid), left.schema, lEngine as 'mysql' | 'postgres');
      setBusy('Snapshotting right…');
      const rsid = await ensureSession(right.connId);
      const rsnap = await fetchSnapshotFor(runnerFor(rsid), right.schema, rEngine as 'mysql' | 'postgres');
      setBusy('Diffing…');
      const diff = diffSnapshots(lsnap, rsnap);
      setResult({ diff, left: lsnap, right: rsnap });
    } catch (e) {
      setError(errorDisplay(e));
    } finally {
      setBusy(null);
    }
  }, [left, right, ensureSession, runnerFor, conns]);

  const openDdl = useCallback(async (e: DiffEntry) => {
    if (e.kind === 'schema') return;
    setBusy(`DDL ${e.name}…`);
    try {
      const fetchSide = async (connId: string, schema: string): Promise<string> => {
        try {
          const sid = await ensureSession(connId);
          return await invoke<string>('get_ddl', { sessionId: sid, parent: `${schema}.${e.name}` });
        } catch {
          return '';
        }
      };
      const [l, r] = await Promise.all([
        e.status === 'only_right' ? Promise.resolve('') : fetchSide(left.connId, left.schema),
        e.status === 'only_left' ? Promise.resolve('') : fetchSide(right.connId, right.schema),
      ]);
      setDdlView({ name: e.name, rows: lineDiff(l || '-- (absent)', r || '-- (absent)') });
    } finally {
      setBusy(null);
    }
  }, [left, right, ensureSession]);

  // ── exports ────────────────────────────────────────────────────────────────

  const buildReport = useCallback((): string => {
    if (!result) return '';
    const changed = result.diff.filter(d => d.status !== 'same');
    const parts = [
      `# Schema comparison`,
      '',
      `**Left:** ${conns.find(c => c.id === left.connId)?.name} / \`${left.schema}\``,
      `**Right:** ${conns.find(c => c.id === right.connId)?.name} / \`${right.schema}\``,
      '',
      `**${changed.length} differences** (of ${result.diff.length} objects compared)`,
      '',
      mdTable(['Kind', 'Object', 'Status'],
        changed.map(d => [d.kind, d.name, STATUS_LABEL[d.status]])),
      '',
      '## Details',
      '',
    ];
    for (const d of changed) {
      parts.push(`### ${d.kind} ${d.name} — ${STATUS_LABEL[d.status]}`);
      for (const line of d.details) parts.push(`- ${line}`);
      parts.push('');
    }
    return parts.join('\n');
  }, [result, conns, left, right]);

  const exportMigration = useCallback(async (direction: 'ltr' | 'rtl') => {
    if (!result) return;
    setBusy('Generating migration…');
    try {
      const src = direction === 'ltr'
        ? { snap: result.left, connId: left.connId, schema: left.schema }
        : { snap: result.right, connId: right.connId, schema: right.schema };
      const dst = direction === 'ltr' ? result.right : result.left;
      // diff is oriented left→right; for rtl regenerate with sides swapped
      const diff = direction === 'ltr' ? result.diff : diffSnapshots(result.right, result.left);
      const sid = await ensureSession(src.connId);
      const script = await generateMigration(diff, src.snap, dst, name =>
        invoke<string>('get_ddl', { sessionId: sid, parent: `${src.schema}.${name}` }));
      const p = await saveTextAs(script, `migration_${direction === 'ltr' ? 'to_right' : 'to_left'}.sql`, 'SQL', ['sql']);
      if (p) note(`Saved ${basename(p)}`);
    } catch (e) {
      setError(errorDisplay(e));
    } finally {
      setBusy(null);
    }
  }, [result, left, right, ensureSession]);

  // ── derived ────────────────────────────────────────────────────────────────

  const grouped = useMemo(() => {
    if (!result) return [];
    const visible = result.diff.filter(d => !hideSame || d.status !== 'same');
    return KINDS
      .map(k => ({ kind: k, entries: visible.filter(d => d.kind === k) }))
      .filter(g => g.entries.length > 0);
  }, [result, hideSame]);

  const counts = useMemo(() => {
    const c = { only_left: 0, only_right: 0, different: 0, same: 0 };
    for (const d of result?.diff ?? []) c[d.status]++;
    return c;
  }, [result]);

  const sideSelect = (side: 'left' | 'right', st: SideState) => (
    <div className="sc-side">
      <select value={st.connId} onChange={e => pickConnection(side, e.target.value)}>
        <option value="">— connection —</option>
        {conns.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
      </select>
      <select
        value={st.schema}
        disabled={st.schemas.length === 0}
        onChange={e => (side === 'left' ? setLeft : setRight)(s => ({ ...s, schema: e.target.value }))}
      >
        {st.schemas.length === 0 && <option value="">— schema —</option>}
        {st.schemas.map(s => <option key={s} value={s}>{s}</option>)}
      </select>
    </div>
  );

  return (
    <div className="proc-panel" style={{ position: 'relative', inset: 'auto', height: '100%' }}>
      <div className="proc-toolbar">
        <span className="proc-title">⇆ Compare</span>
        {sideSelect('left', left)}
        <span className="sc-vs">⇆</span>
        {sideSelect('right', right)}
        <button
          className="primary run-btn"
          disabled={!!busy || !left.schema || !right.schema}
          onClick={compare}
        >{busy ?? 'Compare'}</button>
        <div style={{ flex: 1 }} />
        {flash && <span className="result-flash">{flash}</span>}
        {result && (
          <>
            <label className="gsp-check">
              <input type="checkbox" checked={hideSame} onChange={e => setHideSame(e.target.checked)} />
              hide identical
            </label>
            <button className="toolbar-btn" onClick={async () => {
              const p = await saveTextAs(buildReport(), 'schema_comparison.md', 'Markdown', ['md']);
              if (p) note(`Saved ${basename(p)}`);
            }}>Export .md</button>
            <button className="toolbar-btn" title="ALTER script that makes RIGHT match LEFT"
              onClick={() => exportMigration('ltr')}>Migrate →</button>
            <button className="toolbar-btn" title="ALTER script that makes LEFT match RIGHT"
              onClick={() => exportMigration('rtl')}>← Migrate</button>
          </>
        )}
        {onClose && <button className="icon-btn" title="Close" onClick={onClose}>×</button>}
      </div>

      {error && <div className="proc-error-bar">{error}</div>}

      <div className="sc-body">
        <div className="sc-list">
          {!result && !busy && (
            <div className="mx-empty">
              Pick a connection + schema on each side (same connection twice compares two schemas on one instance), then Compare.
              <br />MySQL / MariaDB / Percona and PostgreSQL — both sides must be the same engine.
            </div>
          )}
          {result && (
            <div className="sc-summary">
              <span className="sc-chip sc-left">◀ {counts.only_left}</span>
              <span className="sc-chip sc-diff">≠ {counts.different}</span>
              <span className="sc-chip sc-right">{counts.only_right} ▶</span>
              <span className="sc-chip sc-same">= {counts.same}</span>
            </div>
          )}
          {grouped.map(g => (
            <div key={g.kind}>
              <div className="dv-cat">{KIND_ICON[g.kind]} {g.kind}s</div>
              {g.entries.map(e => (
                <div
                  key={`${e.kind}:${e.name}`}
                  className={`sc-entry sc-st-${e.status}`}
                  onClick={() => e.kind !== 'schema' && e.status !== 'same' && openDdl(e)}
                  title={e.kind !== 'schema' ? 'Click for side-by-side DDL' : ''}
                >
                  <div className="sc-entry-head">
                    <span className="sc-entry-name">{e.name}</span>
                    <span className="sc-entry-status">{STATUS_LABEL[e.status]}</span>
                  </div>
                  {e.details.slice(0, 8).map((d, i) => (
                    <div key={i} className="sc-detail">{d}</div>
                  ))}
                  {e.details.length > 8 && (
                    <div className="sc-detail">… {e.details.length - 8} more</div>
                  )}
                </div>
              ))}
            </div>
          ))}
        </div>

        {ddlView && (
          <div className="sc-ddl">
            <div className="sc-ddl-head">
              <span>{ddlView.name} — side-by-side DDL</span>
              <button className="icon-btn" onClick={() => setDdlView(null)}>×</button>
            </div>
            <div className="sc-ddl-grid">
              {ddlView.rows.map((r, i) => (
                <div key={i} className={`sc-ddl-row sc-dr-${r.type}`}>
                  <pre className="sc-ddl-cell">{r.left ?? ''}</pre>
                  <pre className="sc-ddl-cell">{r.right ?? ''}</pre>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
