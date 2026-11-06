import type { ChangeReviewResult, ChangeStatement } from './changeReview.ts';
import type { DdlCost } from './ddlCost.ts';

export interface MigrationCostInput {
  operation: string;
  algorithm: string;
  lock: string;
  rebuild: boolean;
  seconds: number | null;
  blocked_seconds: number | null;
  disk_bytes: number | null;
  replica_lag_seconds: number | null;
  why: string;
}

export interface MigrationStatementInput {
  kind: string;
  line: number;
  table: string | null;
  supported: boolean;
  summary: string;
  destructive: boolean;
  lossy: boolean;
  cost: MigrationCostInput | null;
}

export interface MigrationStatementPreflight extends MigrationStatementInput {
  number: number;
  implicit_commit: boolean;
}

export interface MigrationPreflightResponse {
  sql_sha256: string;
  statement_count: number;
  affected_objects: string[];
  unsupported: number;
  destructive: number;
  lossy: number;
  implicit_commits: number;
  statements: MigrationStatementPreflight[];
  environment: string | null;
  read_only: boolean;
  prod_allow_ddl: boolean;
  prod_allow_unfiltered_write: boolean;
  stop_on_first_error: true;
}

export interface MigrationScratchRecord {
  run_key: string;
  session_id: string;
  connection_id: string;
  engine: string;
  name: string;
  status: 'creating' | 'active' | 'executing' | 'executed' | 'execution_failed'
    | 'execution_cancelled' | 'cleanup_failed' | 'cancelled' | 'failed' | 'dropped';
  error: string | null;
  created_at: string;
  updated_at: string;
}

export interface MigrationStatementExecution {
  number: number;
  line: number;
  ms: number;
  rows_affected: number;
  ok: boolean;
  error: string | null;
  error_code: string;
  db_code: string;
  sqlstate: string;
}

export interface MigrationExecutionResult {
  run_key: string;
  sql_sha256: string;
  backend_id: number | null;
  statement_total: number;
  executed: number;
  committed: number;
  unknown: number;
  failed: number;
  not_started: number;
  statements: MigrationStatementExecution[];
  ok: boolean;
  cancelled: boolean;
  partial: boolean;
  ms: number;
  error: string | null;
}

function destructive(statement: ChangeStatement): boolean {
  return statement.kind === 'drop-table' || statement.kind === 'truncate'
    || statement.findings.some(finding => /destroys|DROP\/CREATE rewrite/i.test(finding.title));
}

function lossy(statement: ChangeStatement): boolean {
  return destructive(statement) || statement.findings.some(finding =>
    /\b(?:narrows|changes) type\b|NULL → NOT NULL|NOT NULL without a default|incompatible column types/i.test(finding.title));
}

function costInput(cost: DdlCost | null): MigrationCostInput | null {
  if (!cost) return null;
  return {
    operation: cost.operation,
    algorithm: cost.algorithm,
    lock: cost.lock,
    rebuild: cost.rebuild,
    seconds: cost.seconds,
    blocked_seconds: cost.blockedSeconds,
    disk_bytes: cost.diskBytes,
    replica_lag_seconds: cost.replicaLagSeconds,
    why: cost.why,
  };
}

export function buildMigrationPreflightStatements(review: ChangeReviewResult): MigrationStatementInput[] {
  return review.statements.map(statement => ({
    kind: statement.kind,
    line: statement.line,
    table: statement.table,
    supported: statement.supported,
    summary: statement.summary,
    destructive: destructive(statement),
    lossy: lossy(statement),
    cost: costInput(statement.cost),
  }));
}
