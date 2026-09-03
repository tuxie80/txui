/**
 * A slim database selector for the plugin panels that take a `schema` prop —
 * the same default database the editor toolbar's "db roulette" sets, so a
 * panel can be re-pointed at another schema without a trip back to an editor
 * tab. The change goes through QueryTabs' `changeDb` (backend `set_session_db`
 * + state), so the new value flows back into every panel's `schema` prop.
 *
 * Hidden entirely when the engine has no selectable-database concept
 * (`engineCaps.databaseSelect` — Redis, MongoDB, DuckDB, SQL Server) or the
 * schema list has not loaded yet; the panel then behaves exactly as before.
 */
import { MenuSelect } from './MenuSelect';
import { can } from '../utils/engineCaps';
import type { Engine } from '../utils/engineCaps';

export function DbScopeBar({ engine, dbList, currentDb, onChange }: {
  /** Owning session — the selector changes THAT session's default database. */
  sessionId: string;
  engine: Engine;
  dbList: string[];
  currentDb: string;
  onChange: (db: string) => void;
}) {
  if (!can(engine, 'databaseSelect') || dbList.length === 0) return null;
  return (
    <div className="db-scope-bar">
      <span className="db-scope-label">Database:</span>
      <MenuSelect
        className="db-roulette"
        title="Default database for this session (unqualified names resolve here)"
        value={currentDb}
        options={[{ value: '', label: '— no default DB —' },
          ...dbList.map(d => ({ value: d, label: d }))]}
        onChange={onChange}
      />
    </div>
  );
}
