/**
 * Secret redaction for LOG OUTPUT ONLY (session log, server-log file, audit).
 * Replaces credential values in account/replication DDL with `****` so logs
 * are safe to share. Never applied to what gets executed or to query_history
 * (re-run needs the original SQL).
 *
 * Conservative by design: only quoted values in explicit credential syntax are
 * touched — ordinary string literals elsewhere are left alone:
 *   SELECT 'password = x'            → untouched (no quoted value after `=`)
 *   WHERE name = 'IDENTIFIED BY'     → untouched (no quoted value after BY)
 * A false positive (e.g. `WHERE password = 'x'`) hides data — safe direction;
 * a false negative would leak a secret.
 */

/** Single- or double-quoted string literal, incl. \\-escapes and ''/"" doubling. */
const Q = `'(?:[^'\\\\]|\\\\.|'')*'|"(?:[^"\\\\]|\\\\.|"")*"`;

/** IDENTIFIED BY 'x' / IDENTIFIED WITH plugin BY 'x' / IDENTIFIED … AS 'x' */
const IDENTIFIED_RE = new RegExp(
  `(\\bidentified\\s+(?:with\\s+\\w+\\s+)?(?:by|as))\\s+(${Q})`, 'gi');

/** PASSWORD = 'x' — also SOURCE_PASSWORD, MASTER_PASSWORD, … (\w* prefix) */
const PASSWORD_KV_RE = new RegExp(`(\\b\\w*password\\s*=)\\s*(${Q})`, 'gi');

/** PASSWORD('x') — the MySQL PASSWORD() hash function */
const PASSWORD_FN_RE = new RegExp(`\\b(password\\s*\\()\\s*(${Q})\\s*\\)`, 'gi');

export function redactSecrets(sql: string): string {
  return sql
    .replace(IDENTIFIED_RE, '$1 ****')
    .replace(PASSWORD_KV_RE, '$1 ****')
    .replace(PASSWORD_FN_RE, '$1****)');
}

/**
 * Command lines carry credentials in shapes SQL never does.
 *
 * TxUI never puts a password in argv itself — the dump tools get it through
 * `MYSQL_PWD` / `PGPASSWORD`, precisely so it cannot be read out of the
 * process table. But the dump panel has a free-text "extra args" field, and a
 * user who types `--password=hunter2` into it would otherwise have that
 * written verbatim into the audit log and the session log, which are the two
 * things people paste into tickets.
 *
 * Unquoted-value forms, because a shell argument usually has no quotes:
 *   --password=x   --password x   -px   PGPASSWORD=x   MYSQL_PWD=x
 *
 * Applied *in addition to* `redactSecrets`, never instead of it.
 */
export function redactCommandLine(cmd: string): string {
  return cmd
    // --password=x / --password x / -p x, and the same for --pass / --pwd
    .replace(/(--(?:password|pass|pwd))(\s*[= ]\s*)(\S+)/gi, '$1$2****')
    // -pSECRET (MySQL's no-space form). `-p` alone prompts, so it is left be.
    .replace(/(^|\s)(-p)(\S+)/g, '$1$2****')
    // Environment assignments written into the line.
    .replace(/\b(MYSQL_PWD|PGPASSWORD|MYSQL_PASSWORD|POSTGRES_PASSWORD)(\s*=\s*)(\S+)/gi, '$1$2****')
    // A password embedded in a connection URL: scheme://user:secret@host
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+):([^\s@]+)@/gi, '$1:****@');
}
