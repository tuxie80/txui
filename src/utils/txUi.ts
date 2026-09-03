/**
 * UI state machine for the manual-transaction toggle in the editor toolbar.
 *
 * The backend truth (src-tauri/src/commands/query.rs) is simple:
 *  - `begin_transaction` holds a dedicated connection with BEGIN executed.
 *  - `commit_transaction` / `rollback_transaction` REMOVE the connection from
 *    the map first, then run the verb — so even a failed COMMIT ends the
 *    transaction session (the dropped connection rolls back server-side).
 *
 * The UI mirrors that: any end (ok or failed) returns to `auto`, and a failed
 * begin returns to `auto`. While an invoke is in flight the machine sits in
 * `pending` so a double-click cannot fire a second begin/commit.
 */
export type TxMode = 'auto' | 'pending' | 'open';

export type TxEvent =
  | 'begin'       // user clicked the AUTO toggle
  | 'begin-ok'    // begin_transaction resolved
  | 'begin-fail'  // begin_transaction rejected
  | 'end'         // user clicked Commit or Rollback
  | 'end-done';   // commit/rollback settled — EITHER way the tx session is over

export function txReduce(mode: TxMode, ev: TxEvent): TxMode {
  switch (ev) {
    case 'begin':      return mode === 'auto' ? 'pending' : mode;
    case 'begin-ok':   return mode === 'pending' ? 'open' : mode;
    case 'begin-fail': return mode === 'pending' ? 'auto' : mode;
    case 'end':        return mode === 'open' ? 'pending' : mode;
    case 'end-done':   return mode === 'pending' ? 'auto' : mode;
  }
}

export const txIsOpen = (m: TxMode) => m === 'open';
export const txIsBusy = (m: TxMode) => m === 'pending';

// ── toolbar enablement ───────────────────────────────────────────────────────

/**
 * What the Commit / Rollback pair should do, given the three facts that decide
 * it. Extracted from the toolbar because getting it wrong is silent: a button
 * that looks live while nothing is pinned settles whichever pooled connection
 * it reaches, and a spurious warning trains people to ignore the real one.
 */
export interface TxControls {
  /** Commit and Rollback clickable. */
  canSettle: boolean;
  /** The AUTO toggle can open a transaction. */
  canBegin: boolean;
  /** The server's setting disagrees with the connection's. */
  mismatch: boolean;
}

/**
 * Deliberately NOT modelled: SQL Server's *doomed* transaction
 * (`XACT_STATE() = -1`), where a transaction is alive but can no longer be
 * committed.
 *
 * It was built and then removed, because it cannot happen here. TxUI sends each
 * statement as its own batch, and SQL Server rolls an uncommittable transaction
 * back at the **end of the batch** that doomed it — *"Uncommittable transaction
 * is detected at the end of the batch. The transaction is rolled back."* By the
 * time any later statement (including the `tx_status` probe) runs, `@@TRANCOUNT`
 * is already 0, so `held` is false and there is nothing to grey. Verified
 * against SQL Server 2022, with and without TRY/CATCH.
 *
 * If TxUI ever gains multi-statement batches sharing one round trip, the state
 * becomes observable and Commit would need greying inside them.
 */
export function txControls(
  mode: TxMode,
  /** The connection is configured with autocommit OFF (pins a connection). */
  manualCommit: boolean,
  /** The server's own `@@autocommit`; null when unknown or not applicable. */
  serverAutocommit: boolean | null,
): TxControls {
  const open = txIsOpen(mode);
  const busy = txIsBusy(mode);
  return {
    canSettle: open && !busy,
    // With autocommit off the session re-pins itself, so there is never an
    // `auto` state for the user to act on.
    canBegin: !open && !busy && !manualCommit,
    // Compared against the CONNECTION's setting, never against whether a
    // transaction is open: `@@autocommit` describes the connection's mode and
    // stays 1 inside a plain BEGIN, so comparing it to the held state would
    // flag every ordinary manual transaction as a fault.
    mismatch: serverAutocommit !== null && serverAutocommit === manualCommit,
  };
}
