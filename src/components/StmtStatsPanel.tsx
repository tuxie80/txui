/**
 * Statement statistics over time — snapshot → diff, one panel for the two
 * engines that keep cumulative per-statement digests.
 *
 * Both halves answer the same question — "which statements got slower between
 * these two moments" — over different catalogues, so the panel is a thin
 * engine switch, not a merge: PostgreSQL needs the pg_stat_statements
 * availability dance (detect → offer to enable) and a changed/new/gone diff
 * with a reset guard, MySQL reads an always-on performance_schema table and
 * diffs positive deltas only. The pure arithmetic stays in utils/pgssDiff and
 * utils/mysqlDigestDiff; the persistent snapshot store is already shared
 * (DigestStoreSection). Gated on the `stmtStats` engine capability, so the
 * fallback below is unreachable from the menus — it exists for the same
 * reason every panel refuses gracefully rather than assuming its gate.
 */
import type { Session } from '../types';
import { StatusIcon } from './StatusIcon';
import { PgssHistoryPanel } from './PgssHistoryPanel';
import { MysqlDigestPanel } from './MysqlDigestPanel';

interface Props {
  session: Session;
  onClose: () => void;
}

export function StmtStatsPanel({ session, onClose }: Props) {
  if (session.engine === 'postgres') return <PgssHistoryPanel session={session} onClose={onClose} />;
  if (session.engine === 'mysql') return <MysqlDigestPanel session={session} onClose={onClose} />;
  return (
    <div className="proc-panel">
      <div className="proc-toolbar">
        <span className="proc-title">📉 Statement statistics</span>
        <div style={{ flex: 1 }} />
        <button className="icon-btn" onClick={onClose} title="Close">×</button>
      </div>
      <div className="dg-body">
        <div className="mnt-warn">
          <StatusIcon kind="error" /> Statement statistics need MySQL
          (performance_schema digests) or PostgreSQL (pg_stat_statements) —
          this engine keeps no cumulative statement digest to snapshot.
        </div>
      </div>
    </div>
  );
}
