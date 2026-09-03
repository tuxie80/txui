/**
 * Pure builders for the MySQL/MariaDB event-scheduler management statements the
 * DBA Views "Scheduled events" panel emits into the editor (never executed here
 * — review-only, see DbaViewsPanel).
 *
 * Two things the read-only view could show but not change:
 *   - the global scheduler being on/off (`SET GLOBAL event_scheduler`), and
 *   - an individual event being enabled/disabled (`ALTER EVENT … ENABLE|DISABLE`).
 *
 * Kept dependency-light (only `quoteIdent`) so it unit-tests straight from node
 * — see tests/eventSchedulerSql.test.ts.
 */
import { quoteIdent } from './sqlIdent.ts';

/** Engine tag — the scheduler exists only on MySQL/MariaDB/Percona ('mysql'). */
type Engine = 'mysql' | string;

/**
 * Turn the global event scheduler on or off.
 *
 *   `SET GLOBAL event_scheduler = ON;`  /  `= OFF;`
 *
 * A running scheduler is the prerequisite for *any* event firing; an ENABLED
 * event on a server with the scheduler OFF never runs.
 */
export function schedulerToggleSql(on: boolean): string {
  return `SET GLOBAL event_scheduler = ${on ? 'ON' : 'OFF'};`;
}

/**
 * Enable or disable a single event, addressed by its schema and name.
 *
 *   ``ALTER EVENT `schema`.`name` ENABLE;``  /  `` DISABLE;``
 *
 * Identifiers are quoted unconditionally so names that collide with reserved
 * words or need escaping still resolve.
 */
export function alterEventSql(
  schema: string, name: string, enable: boolean, engine: Engine = 'mysql',
): string {
  const path = `${quoteIdent(schema, engine)}.${quoteIdent(name, engine)}`;
  return `ALTER EVENT ${path} ${enable ? 'ENABLE' : 'DISABLE'};`;
}
