/**
 * Registered engine gaps — a feature this engine could plausibly have, that
 * TxUI deliberately does not offer it, and **why**.
 *
 * The house rule is "unavailable is shown, greyed and explained — never
 * hidden", but the plugin menu has only ever had two states: an engine offers a
 * panel (`engineCaps`), or the item is filtered out. Filtering is right for
 * most of it — nobody wants an ER diagram greyed on Redis, and a Parquet
 * session listing thirty dead entries is noise, not honesty.
 *
 * It is wrong for the cases a user has a *reason to expect* the feature and
 * will otherwise conclude the panel is missing, or broken, or that they are
 * looking in the wrong menu. SQL Server replication is exactly that: the engine
 * replicates, the panel exists, and the two are not connected.
 *
 * So this table is deliberately small. An entry earns its place by answering
 * "someone will look for this and not find it" — not by cataloguing everything
 * an engine cannot do. Everything without an entry keeps the old behaviour.
 *
 * Pure: no server, no React. `node --test` covers it.
 */

/** `engine::panel` → why it is greyed. */
const GAPS: Record<string, string> = {
  /**
   * Always On availability groups are not the shape this panel draws.
   *
   * The panel models one primary with replicas that report a position and a
   * lag — MySQL's binlog coordinates, PostgreSQL's LSN. An availability group
   * is a different object: replicas are per-*database*, synchronisation is a
   * commit mode rather than a byte offset, and the health that matters is
   * `synchronization_state` plus a redo queue, not "seconds behind".
   *
   * Half-mapping it — pointing `sys.dm_hadr_database_replica_states` at fields
   * that mean something else — would produce a topology that looks right and
   * misreports the one thing anyone opens it for. So it is registered as a gap
   * until the panel can model AGs properly, rather than shipped approximately.
   */
  'sqlserver::replication':
    'Replication — not available for SQL Server. This panel models a primary with '
    + 'replicas reporting a log position and lag (binlog coordinates, LSN); Always On '
    + 'availability groups replicate per database, with a synchronisation state and a '
    + 'redo queue instead. Mapping one onto the other would misreport exactly what you '
    + 'would open it to check. Use SSMS or sys.dm_hadr_* until the panel models AGs.',
};

/**
 * Why this engine does not offer this panel — or `null` to keep the default
 * behaviour (hidden when the capability is false, shown when it is true).
 */
export function engineGapReason(engine: string, panel: string): string | null {
  return GAPS[`${engine}::${panel}`] ?? null;
}

/** Every registered gap, for tests and for the generated documentation. */
export function registeredGaps(): Array<{ engine: string; panel: string; reason: string }> {
  return Object.entries(GAPS).map(([key, reason]) => {
    const [engine, panel] = key.split('::');
    return { engine, panel, reason };
  });
}
