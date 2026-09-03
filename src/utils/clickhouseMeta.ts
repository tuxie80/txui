/**
 * Small pure helpers for reading ClickHouse's system catalog.
 *
 * Kept out of the React hooks so they can be unit-tested without pulling in
 * the store/Tauri module graph.
 */

/**
 * ClickHouse table engine → what the object *is* for hinting and explorer
 * purposes.
 *
 * The View family is four separate engines (`View`, `MaterializedView`,
 * `LiveView`, `WindowView`), so matching only `'View'` — or only
 * `'MaterializedView'` — mislabels the rest. Everything else is table-shaped,
 * including `Dictionary`, which is queried exactly like a table.
 */
export function clickhouseObjectKind(tableEngine: string): 'table' | 'view' {
  return tableEngine.endsWith('View') ? 'view' : 'table';
}
