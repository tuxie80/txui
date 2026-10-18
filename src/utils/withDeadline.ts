/**
 * Bound a promise the UI is waiting on.
 *
 * The backend already bounds its own connects, but the UI must not depend on
 * that: an IPC call that never settles would leave a row showing "connecting"
 * with no end and no explanation, which is indistinguishable from the app
 * being broken. This guarantees the UI always gets an answer.
 *
 * The underlying work is NOT cancelled — it cannot be, once it is in the
 * backend. What is bounded is how long the interface pretends to be waiting.
 *
 * Pure module: no React/Tauri imports, unit-tested with `node --test`.
 */
export class DeadlineError extends Error {
  /** The deadline that elapsed, in ms. */
  readonly ms: number;
  constructor(ms: number) {
    super(`timed out after ${Math.round(ms / 1000)}s`);
    this.name = 'DeadlineError';
    this.ms = ms;
  }
}

/**
 * How long the UI pretends to be waiting on a connect/test for this config:
 * the connection's own timeout plus grace for TLS/handshake/SSH, or the
 * backend default (15 s) plus the same grace. Shared by the sidebar's
 * connect/test and the form's Test button, so every "waiting" surface gives
 * up on the same schedule.
 */
export function connectDeadlineMs(cfg: { connect_timeout_secs?: number | null }): number {
  return ((cfg.connect_timeout_secs ?? 15) + 8) * 1000;
}

export function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  // A non-positive deadline means "no deadline" rather than "fail instantly",
  // which is the safer reading of a mis-configured timeout.
  if (!(ms > 0)) return work;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new DeadlineError(ms)), ms);
    work.then(
      v => { clearTimeout(timer); resolve(v); },
      e => { clearTimeout(timer); reject(e); },
    );
  });
}
