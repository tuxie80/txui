export type SqlScriptCompression =
  | 'plain' | 'gzip' | 'zstd' | 'xz' | 'bzip2' | 'lz4'
  | 'zip' | 'tar_gzip' | 'tar_xz' | 'tar_zstd';
export type SqlScriptPhase = 'idle' | 'validating' | 'executing' | 'done';

export type SqlScriptEvent =
  | { type: 'started'; path: string; compression: SqlScriptCompression; source_total: number;
      database: string | null; max_statement_bytes: number }
  | { type: 'phase'; phase: string; statements_total: number | null }
  | { type: 'progress'; phase: string; source_bytes: number; source_total: number;
      uncompressed_bytes: number; statements_seen: number; statements_total: number | null;
      executed: number; failed: number; rows_affected: number;
      current_line: number | null; backend_id: number | null }
  | { type: 'statement_done'; number: number; line: number; bytes: number;
      rows_affected: number; ms: number }
  | { type: 'statement_error'; number: number; line: number; message: string }
  | { type: 'done'; ok: boolean; cancelled: boolean; partial: boolean; ms: number;
      statements: number; executed: number; failed: number; rows_affected: number;
      uncompressed_bytes: number; error: string | null };

export interface SqlScriptLogLine {
  kind: 'meta' | 'ok' | 'error';
  text: string;
}

export interface SqlScriptDone {
  ok: boolean;
  cancelled: boolean;
  partial: boolean;
  ms: number;
  error: string | null;
}

export interface SqlScriptState {
  phase: SqlScriptPhase;
  path: string;
  compression: SqlScriptCompression;
  database: string | null;
  sourceBytes: number;
  sourceTotal: number;
  uncompressedBytes: number;
  statementsSeen: number;
  statementsTotal: number | null;
  executed: number;
  failed: number;
  rowsAffected: number;
  currentLine: number | null;
  backendId: number | null;
  maxStatementBytes: number;
  done: SqlScriptDone | null;
  log: SqlScriptLogLine[];
}

export const SQL_SCRIPT_LOG_LIMIT = 5000;

export function initialSqlScriptState(): SqlScriptState {
  return {
    phase: 'idle', path: '', compression: 'plain', database: null,
    sourceBytes: 0, sourceTotal: 0, uncompressedBytes: 0,
    statementsSeen: 0, statementsTotal: null, executed: 0, failed: 0,
    rowsAffected: 0, currentLine: null, backendId: null,
    maxStatementBytes: 64 * 1024 * 1024, done: null, log: [],
  };
}

export function compressionForSqlScript(path: string): SqlScriptCompression {
  const lower = path.toLowerCase();
  if (lower.endsWith('.tar.gz')) return 'tar_gzip';
  if (lower.endsWith('.tar.xz')) return 'tar_xz';
  if (lower.endsWith('.tar.zst')) return 'tar_zstd';
  if (lower.endsWith('.zip')) return 'zip';
  if (lower.endsWith('.gz')) return 'gzip';
  if (lower.endsWith('.zst')) return 'zstd';
  if (lower.endsWith('.xz')) return 'xz';
  if (lower.endsWith('.bz2')) return 'bzip2';
  if (lower.endsWith('.lz4')) return 'lz4';
  return 'plain';
}

export function sqlScriptCompressionLabel(compression: SqlScriptCompression): string {
  return {
    plain: 'Plain SQL', gzip: 'Gzip', zstd: 'Zstandard', xz: 'XZ', bzip2: 'Bzip2',
    lz4: 'LZ4', zip: 'ZIP archive', tar_gzip: 'tar + gzip',
    tar_xz: 'tar + XZ', tar_zstd: 'tar + Zstandard',
  }[compression];
}

export function validSqlScriptLimitMiB(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= 1024;
}

export function sqlScriptPercent(bytes: number, total: number): number {
  if (total <= 0) return 0;
  return Math.max(0, Math.min(100, Math.floor((bytes / total) * 100)));
}

export function formatSqlScriptBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  const digits = unit === 0 || value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${units[unit]}`;
}

function withLog(state: SqlScriptState, line: SqlScriptLogLine): SqlScriptLogLine[] {
  return [...state.log.slice(-(SQL_SCRIPT_LOG_LIMIT - 1)), line];
}

export function applySqlScriptEvent(state: SqlScriptState, event: SqlScriptEvent): SqlScriptState {
  switch (event.type) {
    case 'started':
      return {
        ...initialSqlScriptState(),
        phase: 'validating', path: event.path, compression: event.compression,
        database: event.database, sourceTotal: event.source_total,
        maxStatementBytes: event.max_statement_bytes,
        log: [{ kind: 'meta', text: `Source: ${event.path} (${event.compression})` }],
      };
    case 'phase': {
      const phase = event.phase === 'executing' ? 'executing' : 'validating';
      return {
        ...state, phase, statementsTotal: event.statements_total,
        log: phase === 'executing'
          ? withLog(state, { kind: 'meta', text: `Validation complete: ${event.statements_total ?? 0} statements. Execution started.` })
          : state.log,
      };
    }
    case 'progress':
      return {
        ...state,
        phase: event.phase === 'executing' ? 'executing' : 'validating',
        sourceBytes: event.source_bytes, sourceTotal: event.source_total,
        uncompressedBytes: event.uncompressed_bytes,
        statementsSeen: event.statements_seen, statementsTotal: event.statements_total,
        executed: event.executed, failed: event.failed, rowsAffected: event.rows_affected,
        currentLine: event.current_line, backendId: event.backend_id,
      };
    case 'statement_done':
      return {
        ...state,
        log: withLog(state, {
          kind: 'ok',
          text: `#${event.number} · line ${event.line} · ${formatSqlScriptBytes(event.bytes)} · ${event.rows_affected.toLocaleString()} rows affected · ${event.ms.toLocaleString()} ms`,
        }),
      };
    case 'statement_error':
      return {
        ...state,
        log: withLog(state, { kind: 'error', text: `#${event.number} · line ${event.line} · ${event.message}` }),
      };
    case 'done': {
      const outcome = event.cancelled ? 'Cancelled' : event.ok ? 'Completed' : 'Failed';
      const detail = `${outcome}: ${event.executed.toLocaleString()} executed, ${event.failed.toLocaleString()} failed, ${event.rows_affected.toLocaleString()} rows affected in ${event.ms.toLocaleString()} ms.`;
      return {
        ...state, phase: 'done',
        statementsSeen: event.statements, statementsTotal: event.statements,
        executed: event.executed, failed: event.failed,
        rowsAffected: event.rows_affected, uncompressedBytes: event.uncompressed_bytes,
        done: {
          ok: event.ok, cancelled: event.cancelled, partial: event.partial,
          ms: event.ms, error: event.error,
        },
        log: withLog(state, {
          kind: event.ok ? 'ok' : 'error',
          text: event.partial ? `${detail} Committed work is not rolled back.` : detail,
        }),
      };
    }
  }
}
