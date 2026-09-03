/**
 * Scratch buffers — connection-less sessions against an in-memory DuckDB
 * (`open_scratch_session` in the backend opens `file_path: ":memory:"` without
 * touching the vault or connections.json).
 *
 * The only pure logic on this side is the name. Every scratch session is an
 * independent in-memory database, so the tabs are numbered — "Scratch 1",
 * "Scratch 2", … — by the smallest free integer: a closed number is reused,
 * and two live scratch tabs can never share a name (a plain count+1 would
 * collide the moment an earlier tab closes).
 */

export const SCRATCH_BASE = 'Scratch';

/** The display name for a new scratch session, given the names already open. */
export function nextScratchName(existing: readonly string[]): string {
  const used = new Set(existing);
  for (let n = 1; ; n++) {
    const name = `${SCRATCH_BASE} ${n}`;
    if (!used.has(name)) return name;
  }
}
