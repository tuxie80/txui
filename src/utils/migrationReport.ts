import type { MigrationDraft } from './migrationPlan.ts';
import type { MigrationReviewResult } from './migrationReview.ts';
import type {
  MigrationExecutionResult, MigrationPreflightResponse,
} from './migrationPreflight.ts';
import type { MigrationFinalComparison } from './migrationVerification.ts';
import { renderOperationReport } from './operationReport.ts';
import type { OperationReport, OperationReportSection } from './operationReport.ts';

export interface MigrationReportInput {
  draft: MigrationDraft;
  review: MigrationReviewResult | null;
  preflight: MigrationPreflightResponse | null;
  sourceName: string;
  targetName: string;
  rehearsalExecution?: MigrationExecutionResult | null;
  deploymentExecution?: MigrationExecutionResult | null;
  targetVerification?: MigrationFinalComparison | null;
}

function executionSection(
  heading: string,
  execution: MigrationExecutionResult,
  runLabel: string,
): OperationReportSection {
  return {
    heading,
    facts: [
      { label: 'Run ID', value: execution.run_key },
      { label: 'SQL SHA-256', value: execution.sql_sha256 },
      { label: 'Backend ID', value: execution.backend_id },
      { label: 'Duration ms', value: execution.ms },
      { label: 'Committed statements', value: execution.committed },
      { label: 'Unknown outcomes', value: execution.unknown },
      { label: 'Failed statements', value: execution.failed },
      { label: 'Not-started statements', value: execution.not_started },
      { label: 'Cancelled', value: execution.cancelled },
      { label: 'Partial', value: execution.partial },
    ],
    lines: execution.statements.map(statement =>
      `${runLabel} ${statement.number}/${execution.statement_total} · source line ${statement.line} · ${statement.ms} ms · ${statement.ok ? 'committed' : statement.error ?? 'not completed'}`
        + `${statement.db_code ? ` · db ${statement.db_code}` : ''}${statement.sqlstate ? ` · SQLSTATE ${statement.sqlstate}` : ''}`),
  };
}

export function buildMigrationOperationReport(input: MigrationReportInput): OperationReport {
  const { draft, review, preflight } = input;
  const incomplete: string[] = [];
  if (!review?.catalogComplete) incomplete.push('The live before-state catalog is incomplete');
  if ((review?.review.summary.unsupported ?? 0) > 0) {
    incomplete.push(`${review!.review.summary.unsupported} statement(s) are not fully modeled`);
  }
  if (!draft.rehearsalProof) incomplete.push('Rehearsal proof is not complete');
  if (draft.rehearsalProof) {
    incomplete.push(...draft.rehearsalProof.differences.map(value => `Rehearsal difference: ${value}`));
    incomplete.push(...draft.rehearsalProof.unverified.map(value => `Rehearsal unverified: ${value}`));
  }
  if (!draft.deployment) incomplete.push('Deployment has not run');
  if (draft.deployment && !draft.runOutcome) incomplete.push('Deployment outcome was not received');
  if ((draft.runOutcome?.unknownStatements ?? 0) > 0) {
    incomplete.push(`${draft.runOutcome!.unknownStatements} deployment statement outcome(s) are unknown`);
  }
  if (draft.phase === 'verifying') incomplete.push('Final target verification is not complete');
  if (input.targetVerification) {
    incomplete.push(...input.targetVerification.differences.map(value => `Target difference: ${value}`));
    incomplete.push(...input.targetVerification.unverified.map(value => `Target unverified: ${value}`));
  }

  const sections: OperationReportSection[] = [{
    heading: 'Migration identity',
    facts: [
      { label: 'Engine', value: draft.engine },
      { label: 'Database/schema', value: draft.database },
      { label: 'Origin', value: draft.origin },
      { label: 'Phase', value: draft.phase },
      { label: 'SQL SHA-256', value: draft.sqlSha256 },
      { label: 'Source', value: `${input.sourceName} · ${draft.source.connectionId}` },
      { label: 'Target', value: `${input.targetName} · ${draft.target.connectionId}` },
      { label: 'Source session ID', value: draft.source.sessionId },
      { label: 'Target session ID', value: draft.target.sessionId },
      { label: 'Stop on first error', value: preflight?.stop_on_first_error ?? null },
      { label: 'Target environment', value: preflight?.environment ?? null },
      { label: 'Target read-only', value: preflight?.read_only ?? null },
    ],
  }];

  if (review) {
    sections.push({
      heading: 'Review',
      facts: [
        { label: 'Statements', value: review.review.summary.statements },
        { label: 'Modeled', value: review.review.summary.supported },
        { label: 'Unsupported', value: review.review.summary.unsupported },
        { label: 'Destructive', value: review.review.summary.destructive },
        { label: 'Rebuilds', value: review.review.summary.rebuilds },
        { label: 'Catalog complete', value: review.catalogComplete },
        { label: 'Final modeled tables', value: review.review.tables.length },
      ],
      findings: review.review.findings.map(finding => ({
        severity: finding.severity === 'red' ? 'error' : finding.severity === 'info' ? 'info' : 'warning',
        message: `${finding.id} · ${finding.title} · ${finding.detail}${finding.at ? ` · line ${finding.at.line}${finding.at.col ? `, column ${finding.at.col}` : ''}` : ''}`,
      })),
    });
  }

  if (draft.rehearsalProof) {
    const proof = draft.rehearsalProof;
    sections.push({
      heading: 'Rehearsal proof',
      facts: [
        { label: 'Scratch database/schema', value: proof.scratch.database },
        { label: 'Scratch run ID', value: proof.scratch.runKey },
        { label: 'Completed statements', value: proof.execution.completedStatements },
        { label: 'Failed statements', value: proof.execution.failedStatements },
        { label: 'Cancelled', value: proof.execution.cancelled },
        { label: 'Final tables checked', value: proof.finalTables.length },
        { label: 'Differences', value: proof.differences.length },
        { label: 'Unverified checks', value: proof.unverified.length },
      ],
      lines: [...proof.differences, ...proof.unverified],
    });
    if (input.rehearsalExecution) {
      if (input.rehearsalExecution.run_key === proof.scratch.runKey) {
        sections.push(executionSection('Rehearsal execution', input.rehearsalExecution, 'statement'));
      } else {
        incomplete.push('Rehearsal execution evidence belongs to a different run');
      }
    }
  }

  if (draft.deployment) {
    if (input.deploymentExecution?.run_key === draft.deployment.runId) {
      sections.push(executionSection('Deployment execution', input.deploymentExecution, 'statement'));
    } else if (input.deploymentExecution) {
      incomplete.push('Deployment execution evidence belongs to a different run');
    }
    sections.push({
      heading: 'Deployment and verification',
      facts: [
        { label: 'Deployment run ID', value: draft.deployment.runId },
        { label: 'Total statements', value: draft.deployment.totalStatements },
        { label: 'Committed statements', value: draft.runOutcome?.completedStatements ?? null },
        { label: 'Failed statements', value: draft.runOutcome?.failedStatements ?? null },
        { label: 'Unknown outcomes', value: draft.runOutcome?.unknownStatements ?? null },
        { label: 'Not-started statements', value: draft.runOutcome?.notStartedStatements ?? null },
        { label: 'Cancelled', value: draft.runOutcome?.cancelled ?? null },
        { label: 'Target differences', value: input.targetVerification?.differences.length ?? null },
        { label: 'Target unverified checks', value: input.targetVerification?.unverified.length ?? null },
        { label: 'Unrelated target tables excluded', value: input.targetVerification?.outOfScopeTables.length ?? null },
        { label: 'Verified done', value: draft.phase === 'done' },
      ],
      lines: [
        'No automatic rollback is claimed for completed, failed, cancelled or unknown statements',
        ...(draft.stopReason ? [`Stop reason from ${draft.stopReason.from}: ${draft.stopReason.message}`] : []),
        ...(input.targetVerification?.differences ?? []),
        ...(input.targetVerification?.unverified ?? []),
      ],
    });
  }

  return {
    title: 'Migration Cockpit report',
    subject: `${draft.database ?? 'no database/schema'} on ${input.targetName}`,
    outcome: draft.phase === 'done' ? 'completed' : draft.phase === 'failed' ? 'failed' : draft.phase === 'cancelled' ? 'cancelled' : 'incomplete',
    sections,
    incompleteEvidence: [...new Set(incomplete)],
  };
}

export function renderMigrationReport(input: MigrationReportInput): string {
  return renderOperationReport(buildMigrationOperationReport(input));
}
