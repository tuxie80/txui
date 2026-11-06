import { parseMigrationHandoff } from './operationHandoff.ts';
import type { MigrationHandoff, SafeOperationEngine } from './operationHandoff.ts';
import type { ChangeReviewResult, ReviewTable } from './changeReview.ts';

export type MigrationPhase =
  | 'draft' | 'reviewed' | 'rehearsed' | 'ready' | 'deploying' | 'verifying'
  | 'done' | 'failed' | 'cancelled';

export interface MigrationEndpoint {
  sessionId: string;
  connectionId: string;
}

export interface MigrationProofAnchor {
  sqlSha256: string;
  source: MigrationEndpoint;
  target: MigrationEndpoint;
  database: string | null;
}

export interface MigrationReviewProof {
  anchor: MigrationProofAnchor;
  catalogComplete: boolean;
  review: ChangeReviewResult;
}

export interface MigrationRehearsalProof {
  anchor: MigrationProofAnchor;
  scratch: MigrationEndpoint & { database: string; runKey: string };
  execution: MigrationRunOutcome;
  finalTables: ReviewTable[];
  differences: string[];
  unverified: string[];
}

export interface MigrationDeployment {
  anchor: MigrationProofAnchor;
  runId: string;
  totalStatements: number;
}

export interface MigrationRunOutcome {
  runId: string;
  completedStatements: number;
  failedStatements: number;
  cancelled: boolean;
  ok?: boolean;
  unknownStatements?: number;
  notStartedStatements?: number;
}

export interface MigrationVerification {
  runId: string;
  differences: string[];
  unverified: string[];
}

export interface MigrationDraft {
  version: 1;
  phase: MigrationPhase;
  engine: SafeOperationEngine;
  database: string | null;
  sql: string;
  sqlSha256: string;
  origin: MigrationHandoff['origin'];
  source: MigrationEndpoint;
  target: MigrationEndpoint;
  reviewProof: MigrationReviewProof | null;
  rehearsalProof: MigrationRehearsalProof | null;
  deployment: MigrationDeployment | null;
  runOutcome: MigrationRunOutcome | null;
  verification: MigrationVerification | null;
  stopReason: { from: MigrationPhase; message: string } | null;
}

export interface CreateMigrationDraftInput extends MigrationHandoff {
  sqlSha256: string;
  source: MigrationEndpoint;
  target: MigrationEndpoint;
}

function immutable<T>(value: T): T {
  if (Array.isArray(value)) {
    return Object.freeze(value.map(item => immutable(item))) as T;
  }
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => [key, immutable(item)]);
    return Object.freeze(Object.fromEntries(entries)) as T;
  }
  return value;
}

function endpoint(value: MigrationEndpoint, label: string): MigrationEndpoint {
  if (!value.sessionId.trim() || !value.connectionId.trim()) {
    throw new Error(`${label} sessionId and connectionId are required`);
  }
  return { sessionId: value.sessionId, connectionId: value.connectionId };
}

function sameEndpoint(a: MigrationEndpoint, b: MigrationEndpoint): boolean {
  return a.sessionId === b.sessionId && a.connectionId === b.connectionId;
}

function anchorOf(draft: MigrationDraft): MigrationProofAnchor {
  return {
    sqlSha256: draft.sqlSha256,
    source: { ...draft.source },
    target: { ...draft.target },
    database: draft.database,
  };
}

function assertAnchor(draft: MigrationDraft, anchor: MigrationProofAnchor): void {
  const expected = anchorOf(draft);
  if (anchor.sqlSha256 !== expected.sqlSha256
      || anchor.database !== expected.database
      || !sameEndpoint(anchor.source, expected.source)
      || !sameEndpoint(anchor.target, expected.target)) {
    throw new Error('proof belongs to a different migration draft');
  }
}

function assertPhase(draft: MigrationDraft, phase: MigrationPhase): void {
  if (draft.phase !== phase) throw new Error(`expected phase ${phase}, got ${draft.phase}`);
}

function requireText(value: string, label: string): void {
  if (!value.trim()) throw new Error(`${label} is required`);
}

export function createMigrationDraft(input: CreateMigrationDraftInput): MigrationDraft {
  const handoff = parseMigrationHandoff({
    version: input.version,
    engine: input.engine,
    database: input.database,
    sql: input.sql,
    origin: input.origin,
  });
  if (!/^[0-9a-f]{64}$/.test(input.sqlSha256)) {
    throw new Error('sqlSha256 must be a lowercase SHA-256 digest');
  }
  return immutable({
    version: 1 as const,
    phase: 'draft' as const,
    engine: handoff.engine,
    database: handoff.database,
    sql: handoff.sql,
    sqlSha256: input.sqlSha256,
    origin: handoff.origin,
    source: endpoint(input.source, 'source'),
    target: endpoint(input.target, 'target'),
    reviewProof: null,
    rehearsalProof: null,
    deployment: null,
    runOutcome: null,
    verification: null,
    stopReason: null,
  });
}

export function editMigrationDraft(
  draft: MigrationDraft,
  changes: {
    sql?: string;
    sqlSha256?: string;
    database?: string | null;
    source?: MigrationEndpoint;
    target?: MigrationEndpoint;
  },
): MigrationDraft {
  if (['deploying', 'verifying', 'done'].includes(draft.phase)) {
    throw new Error(`cannot edit a migration in phase ${draft.phase}`);
  }
  const sql = changes.sql ?? draft.sql;
  const database = changes.database === undefined ? draft.database : changes.database;
  const source = changes.source ?? draft.source;
  const target = changes.target ?? draft.target;
  if (sql !== draft.sql && changes.sqlSha256 === undefined) {
    throw new Error('changing SQL requires its new SHA-256 digest');
  }
  const sqlSha256 = changes.sqlSha256 ?? draft.sqlSha256;
  if (sql === draft.sql && sqlSha256 !== draft.sqlSha256) {
    throw new Error('SQL digest changed while SQL stayed the same');
  }
  if (sql === draft.sql && database === draft.database
      && sameEndpoint(source, draft.source) && sameEndpoint(target, draft.target)) {
    return draft;
  }
  return createMigrationDraft({
    version: 1,
    engine: draft.engine,
    origin: draft.origin,
    sql,
    sqlSha256,
    database,
    source,
    target,
  });
}

export function markMigrationReviewed(
  draft: MigrationDraft,
  proof: MigrationReviewProof,
): MigrationDraft {
  assertPhase(draft, 'draft');
  assertAnchor(draft, proof.anchor);
  if (proof.review.summary.statements < 1) throw new Error('review has no statements');
  return immutable({ ...draft, phase: 'reviewed' as const, reviewProof: proof, stopReason: null });
}

export function markMigrationRehearsed(
  draft: MigrationDraft,
  proof: MigrationRehearsalProof,
): MigrationDraft {
  assertPhase(draft, 'reviewed');
  assertAnchor(draft, proof.anchor);
  const review = draft.reviewProof!;
  if (!review.catalogComplete || review.review.summary.unsupported > 0) {
    throw new Error('rehearsal requires a complete catalog and fully supported migration');
  }
  requireText(proof.scratch.database, 'scratch database');
  requireText(proof.scratch.runKey, 'scratch run key');
  endpoint(proof.scratch, 'scratch');
  if (proof.execution.runId !== proof.scratch.runKey) {
    throw new Error('execution outcome belongs to a different scratch run');
  }
  if (proof.execution.cancelled || proof.execution.failedStatements > 0
      || proof.execution.completedStatements !== review.review.summary.statements) {
    throw new Error('rehearsal requires complete successful scratch execution');
  }
  if (proof.differences.length) {
    throw new Error('rehearsal still has unexplained final-object differences');
  }
  if (proof.unverified.length || proof.finalTables.some(table => !table.complete)) {
    throw new Error('rehearsal has incomplete verification evidence');
  }
  return immutable({ ...draft, phase: 'rehearsed' as const, rehearsalProof: proof, stopReason: null });
}

export function markMigrationReady(draft: MigrationDraft): MigrationDraft {
  assertPhase(draft, 'rehearsed');
  return immutable({ ...draft, phase: 'ready' as const, stopReason: null });
}

export function startMigrationDeployment(draft: MigrationDraft, runId: string): MigrationDraft {
  assertPhase(draft, 'ready');
  requireText(runId, 'runId');
  const deployment: MigrationDeployment = {
    anchor: anchorOf(draft),
    runId,
    totalStatements: draft.reviewProof!.review.summary.statements,
  };
  return immutable({ ...draft, phase: 'deploying' as const, deployment, stopReason: null });
}

export function beginMigrationVerification(
  draft: MigrationDraft,
  outcome: MigrationRunOutcome,
): MigrationDraft {
  assertPhase(draft, 'deploying');
  const deployment = draft.deployment!;
  if (outcome.runId !== deployment.runId) throw new Error('run outcome belongs to a different run');
  if (outcome.cancelled || outcome.failedStatements > 0
      || outcome.completedStatements !== deployment.totalStatements) {
    throw new Error('verification requires a complete, successful deployment');
  }
  return immutable({ ...draft, phase: 'verifying' as const, runOutcome: outcome, stopReason: null });
}

export function finishMigrationDeployment(
  draft: MigrationDraft,
  outcome: MigrationRunOutcome,
  message?: string,
): MigrationDraft {
  assertPhase(draft, 'deploying');
  if (outcome.runId !== draft.deployment!.runId) throw new Error('run outcome belongs to a different run');
  if (outcome.ok === true) return beginMigrationVerification(draft, outcome);
  const explanation = message?.trim() || (outcome.cancelled ? 'deployment cancelled' : 'deployment failed');
  return immutable({
    ...draft,
    phase: outcome.cancelled ? 'cancelled' as const : 'failed' as const,
    runOutcome: outcome,
    stopReason: { from: 'deploying' as const, message: explanation },
  });
}

export function markMigrationDone(
  draft: MigrationDraft,
  verification: MigrationVerification,
): MigrationDraft {
  assertPhase(draft, 'verifying');
  if (verification.runId !== draft.deployment!.runId) {
    throw new Error('verification belongs to a different run');
  }
  if (verification.differences.length || verification.unverified.length) {
    throw new Error('migration still has differences or unverified checks');
  }
  return immutable({ ...draft, phase: 'done' as const, verification, stopReason: null });
}

export function failMigration(draft: MigrationDraft, message: string): MigrationDraft {
  if (['done', 'failed', 'cancelled'].includes(draft.phase)) {
    throw new Error(`cannot fail a migration in phase ${draft.phase}`);
  }
  requireText(message, 'failure message');
  return immutable({
    ...draft,
    phase: 'failed' as const,
    stopReason: { from: draft.phase, message },
  });
}

export function cancelMigration(draft: MigrationDraft, message = 'cancelled by user'): MigrationDraft {
  if (['done', 'failed', 'cancelled'].includes(draft.phase)) {
    throw new Error(`cannot cancel a migration in phase ${draft.phase}`);
  }
  requireText(message, 'cancellation message');
  return immutable({
    ...draft,
    phase: 'cancelled' as const,
    stopReason: { from: draft.phase, message },
  });
}
