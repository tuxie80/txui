/**
 * Reading typed errors from the backend.
 *
 * Commands are being converted from `Result<_, String>` to a typed `AppError`
 * (see `src-tauri/src/apperror.rs`), which arrives as:
 *
 * ```json
 * { "code": "cancelled", "message": "Query cancelled", "detail": null }
 * ```
 *
 * The conversion is incremental, so this has to cope with **both** shapes: a
 * typed object from a converted command, and a bare string from one not yet
 * touched. Every consumer goes through here, so when the last command is
 * converted nothing else has to change.
 *
 * **Match on `code`, never on `message`.** The message is for people and may
 * be reworded; the code is a contract. That distinction is not pedantry — it
 * is the bug this replaces. `utils/scriptRun.ts` decided whether to stop a
 * multi-statement run by checking whether the error text contained
 * "Query cancelled", and needed a test proving PostgreSQL's
 * `canceling statement due to statement timeout` was not mistaken for it.
 *
 * Pure and dependency-free — driven by `node --test`.
 */

export type ErrorCode =
  | 'cancelled'
  | 'timeout'
  | 'connection_lost'
  | 'connect_failed'
  | 'permission_denied'
  | 'guard_refused'
  | 'sql_syntax'
  | 'constraint'
  | 'not_found'
  | 'bad_request'
  | 'unsupported'
  | 'local'
  | 'unknown';

export interface AppError {
  /** TxUI's coarse class, for deciding what to do. */
  code: ErrorCode;
  message: string;
  detail: string | null;
  /**
   * **The server's own error number** — `1146` on MySQL, `42P01` on
   * PostgreSQL. This is the identity of the error: what you search for, quote
   * in a ticket, or match against a runbook. `code` above is a bucket.
   */
  db_code: string | null;
  /** The SQL standard's five-character class, e.g. `23000`, `40001`. */
  sqlstate: string | null;
}

const CODES = new Set<string>([
  'cancelled', 'timeout', 'connection_lost', 'connect_failed', 'permission_denied',
  'guard_refused', 'sql_syntax', 'constraint', 'not_found', 'bad_request',
  'unsupported', 'local', 'unknown',
]);

/**
 * Normalise whatever a command rejected with into an `AppError`.
 *
 * A string from an unconverted command becomes `unknown` **with its text
 * preserved** — deliberately not re-classified here by pattern-matching. The
 * backend owns classification; duplicating that guesswork in the frontend
 * would give two sources of truth that disagree at the margins, which is
 * exactly what typing the error was meant to end.
 */
export function toAppError(err: unknown): AppError {
  if (err && typeof err === 'object') {
    const o = err as Record<string, unknown>;
    if (typeof o.code === 'string' && CODES.has(o.code)) {
      return {
        code: o.code as ErrorCode,
        message: typeof o.message === 'string' ? o.message : o.code,
        detail: typeof o.detail === 'string' ? o.detail : null,
        db_code: typeof o.db_code === 'string' ? o.db_code : null,
        sqlstate: typeof o.sqlstate === 'string' ? o.sqlstate : null,
      };
    }
    // An Error instance, or something else object-shaped.
    if (o instanceof Error) {
      return { code: 'unknown', message: o.message, detail: null, db_code: null, sqlstate: null };
    }
    // An object carrying a message but a code this build does not know —
    // an older or newer backend, or a code added on one side only. Keep the
    // message: `String(o)` would make it "[object Object]", and every string
    // fallback downstream would then be matching against that instead of the
    // server's text. Measured: with a mis-serialized `Cancelled` code, this
    // path made `isCancelled` return false for a real cancellation, so a
    // cancel mid-script was reported as a failed statement.
    if (typeof o.message === 'string') {
      return {
        code: 'unknown',
        message: o.message,
        detail: typeof o.detail === 'string' ? o.detail : null,
        db_code: typeof o.db_code === 'string' ? o.db_code : null,
        sqlstate: typeof o.sqlstate === 'string' ? o.sqlstate : null,
      };
    }
  }
  const text = String(err);
  return { code: 'unknown', message: text, detail: null, db_code: null, sqlstate: null };
}

/** The text to show a person. */
export function errorMessage(err: unknown): string {
  return toAppError(err).message;
}

/**
 * Did the user ask for this to stop?
 *
 * The replacement for `String(err).includes('Query cancelled')`. Until every
 * command is converted, an unconverted one still arrives as a string — so the
 * legacy check survives as a **narrow** fallback on the backend's own exact
 * wording, not a loose `/cancel/i` that would swallow a timeout.
 */
export function isCancelled(err: unknown): boolean {
  const e = toAppError(err);
  if (e.code !== 'unknown') return e.code === 'cancelled';
  return e.message.includes('Query cancelled');
}

/**
 * Did it exceed a ceiling?
 *
 * Separate from cancellation on purpose: PostgreSQL reports a timeout as
 * `canceling statement due to statement timeout`, and treating that as user
 * intent makes a run that blew its limit look like one somebody stopped.
 */
export function isTimeout(err: unknown): boolean {
  const e = toAppError(err);
  if (e.code !== 'unknown') return e.code === 'timeout';
  return /statement timeout|lock wait timeout|max_execution_time/i.test(e.message);
}

/** Is another attempt plausibly useful? Mirrors `ErrorCode::retryable`. */
export function isRetryable(err: unknown): boolean {
  return ['connection_lost', 'connect_failed', 'timeout'].includes(toAppError(err).code);
}

/** Refused by TxUI's own guards rather than by the server. */
export function isGuardRefusal(err: unknown): boolean {
  return toAppError(err).code === 'guard_refused';
}

/**
 * How prominently to show it.
 *
 * A cancellation is not a failure and must not be reported as one — a red
 * banner for something the user just clicked Cancel on trains people to
 * ignore red banners.
 */
export function errorSeverity(err: unknown): 'info' | 'warn' | 'error' {
  const { code } = toAppError(err);
  if (code === 'cancelled') return 'info';
  if (code === 'timeout' || code === 'guard_refused') return 'warn';
  return 'error';
}

/**
 * A short label for the log's `action` column and for grouping in telemetry.
 *
 * Counting failures by code is the thing prose errors made impossible.
 */
export function errorLabel(err: unknown): string {
  return toAppError(err).code.replace(/_/g, ' ');
}

/**
 * How the error should be shown to a person.
 *
 * The server's number goes **first and verbatim** — `1146` is what someone
 * pastes into a search box or a ticket, and burying it after a sentence (or
 * dropping it, which is what the error formatters used to do by calling
 * `db.message()` and discarding `db.code()`) means they have to go and
 * reproduce the error on a CLI to find out what it actually was.
 *
 * `ERROR 1146 (42S02): Table 'shop.orders' doesn't exist`
 */
export function errorDisplay(err: unknown): string {
  const e = toAppError(err);
  if (!e.db_code) return e.message;
  const state = e.sqlstate && e.sqlstate !== e.db_code ? ` (${e.sqlstate})` : '';
  return `ERROR ${e.db_code}${state}: ${e.message}`;
}
