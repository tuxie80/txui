/**
 * Checking a whole script *before* running any of it.
 *
 * A twenty-statement script on a read-only connection used to fail at
 * whichever statement first tried to write. Everything before it had already
 * run; everything after it never would. The user learns the connection is
 * read-only from statement seven, with six statements' worth of state already
 * applied and no clean way back.
 *
 * The same shape for production: the prod hard limits reject a destructive
 * DDL when it reaches the server, so a script is judged one statement at a
 * time and stops in the middle.
 *
 * This reads every statement first and answers one question: **can all of this
 * run?** If not, nothing runs, and the answer names each statement that would
 * be refused and why.
 *
 * ## Why it is a separate module and not another use of `guardWrite`
 *
 * `guardWrite` answers "may this one statement run", which is exactly right at
 * execution time and useless before it: it returns a verdict per statement,
 * with no notion of a script, no line numbers, and no way to say "statement 7
 * of 20". The pre-flight needs the *positions*, because a list of reasons with
 * nothing to point at is not actionable in a hundred-line script.
 *
 * It calls `guardWrite` for the verdict itself. Re-deriving "is this a write"
 * here would be a second answer to a question that already has one, and the
 * two would drift.
 *
 * Pure and dependency-free — driven by `node --test`.
 */
import { splitStatements } from './sqlSplit.ts';
import { guardWrite, isDangerousDdl, isUnfilteredWrite, isWriteStatement } from './sqlGuard.ts';

export type StatementVerdict = 'ok' | 'blocked' | 'confirm';

export interface PreflightRow {
  /** 1-based position in the script, as a person counts statements. */
  index: number;
  /** 1-based line in the document, for pointing at it. */
  line: number;
  /** The statement, trimmed and shortened for a list. */
  preview: string;
  verdict: StatementVerdict;
  /** Present when not `ok` — the whole reason, in one sentence. */
  reason?: string;
  /** True when this statement writes; drives the counts. */
  writes: boolean;
}

export interface PreflightReport {
  rows: PreflightRow[];
  total: number;
  writes: number;
  blocked: number;
  needConfirm: number;
  /** Nothing would be refused. */
  canRun: boolean;
  /** One line, for the button and the log. */
  summary: string;
}

const PREVIEW = 120;

function preview(sql: string): string {
  const one = sql.replace(/\s+/g, ' ').trim();
  return one.length > PREVIEW ? `${one.slice(0, PREVIEW)}…` : one;
}

/**
 * Read every statement and decide whether the script can run.
 *
 * `delimiter` is threaded through because a script may set its own
 * (`DELIMITER $$` around a routine body), and splitting on the wrong one would
 * chop a procedure into fragments and report nonsense about each piece.
 */
export function preflightScript(
  doc: string,
  opts: {
    readOnly?: boolean;
    environment?: string | null;
    /** Per-connection opt-outs, mirroring the server-side prod limits. */
    allowProdDdl?: boolean;
    allowUnfilteredWrite?: boolean;
    delimiter?: string;
  },
): PreflightReport {
  const parts = splitStatements(doc, opts.delimiter ?? ';').filter(p => p.text.trim());
  const isProd = opts.environment === 'prod';
  const rows: PreflightRow[] = [];

  parts.forEach((p, i) => {
    const sql = p.text;
    const writes = isWriteStatement(sql);
    // `from` is the document offset of the statement's first character;
    // `slice(0, undefined)` would return the whole document and give every
    // statement the same line, which is how the first version of this read.
    const line = doc.slice(0, p.from).split('\n').length;
    const base: Omit<PreflightRow, 'verdict' | 'reason'> = {
      index: i + 1, line, preview: preview(sql), writes,
    };

    const verdict = guardWrite(sql, { readOnly: opts.readOnly, environment: opts.environment });

    if (verdict === 'deny') {
      rows.push({
        ...base, verdict: 'blocked',
        reason: 'this connection is read-only, and this statement writes',
      });
      return;
    }

    // The prod hard limits are enforced server-side and reject the statement
    // when it arrives. Finding that out mid-script is the thing this exists to
    // prevent, so they are evaluated here too — with the same opt-outs, or the
    // pre-flight would refuse work the server would have accepted.
    if (isProd && isDangerousDdl(sql) && !opts.allowProdDdl) {
      rows.push({
        ...base, verdict: 'blocked',
        reason: 'destructive DDL is refused on a production connection '
          + '(the per-connection opt-out is off)',
      });
      return;
    }
    if (isProd && isUnfilteredWrite(sql) && !opts.allowUnfilteredWrite) {
      rows.push({
        ...base, verdict: 'blocked',
        reason: 'a WHERE-less UPDATE/DELETE is refused on a production connection '
          + '(the per-connection opt-out is off)',
      });
      return;
    }

    if (verdict === 'confirm') {
      rows.push({
        ...base, verdict: 'confirm',
        reason: 'writes to a production connection',
      });
      return;
    }

    // A WHERE-less write outside production is not blocked, and is still the
    // thing most worth seeing in a list before pressing run.
    if (isUnfilteredWrite(sql)) {
      rows.push({ ...base, verdict: 'confirm', reason: 'no WHERE clause — every row is affected' });
      return;
    }

    rows.push({ ...base, verdict: 'ok' });
  });

  const blocked = rows.filter(r => r.verdict === 'blocked').length;
  const needConfirm = rows.filter(r => r.verdict === 'confirm').length;
  const writes = rows.filter(r => r.writes).length;

  return {
    rows,
    total: rows.length,
    writes,
    blocked,
    needConfirm,
    canRun: blocked === 0,
    summary: summarize(rows.length, writes, blocked, needConfirm),
  };
}

function summarize(total: number, writes: number, blocked: number, confirm: number): string {
  if (total === 0) return 'Nothing to run.';
  const parts = [`${total} statement${total === 1 ? '' : 's'}`];
  parts.push(`${writes} write${writes === 1 ? '' : 's'}`);
  if (blocked > 0) {
    // Leading with the count and the consequence: the point of the list is
    // that nothing has run yet and nothing will.
    return `${blocked} of ${total} statement${total === 1 ? '' : 's'} would be refused — `
      + 'nothing has run.';
  }
  if (confirm > 0) parts.push(`${confirm} needing confirmation`);
  return parts.join(' · ');
}

/**
 * Is a pre-flight worth showing at all?
 *
 * A single statement is not a script — it already has the write confirmation,
 * which says more about it than a one-row table would. And a script with
 * nothing to refuse and nothing to confirm should not interrupt anyone.
 */
export function shouldPreflight(report: PreflightReport): boolean {
  return report.total > 1 && (report.blocked > 0 || report.needConfirm > 0);
}
