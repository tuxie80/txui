import { sha256Hex } from './datagenStandards.ts';
import { renderOperationReport } from './operationReport.ts';
import type { OperationReport, OperationReportSection } from './operationReport.ts';
import { buildRefreshPlan, resolveRefreshTable, resolveRefreshWindow } from './refreshPlan.ts';
import type { RefreshExecutionPlan } from './refreshExecution.ts';
import type { RefreshMaskPlan } from './refreshMask.ts';
import type { RefreshProgressState } from './refreshExecute.ts';
import type { RefreshRowSetPlan } from './refreshRowSets.ts';
import type { RefreshSpec, RefreshTablePolicy } from './refreshSpec.ts';

export interface RefreshReportInput {
  spec: RefreshSpec;
  sourceName: string;
  targetName: string;
  executionPlan: RefreshExecutionPlan | null;
  rowSetPlan: RefreshRowSetPlan | null;
  maskPlan: RefreshMaskPlan | null;
  preflight: { preflightSha256: string; emptyTables: number } | null;
  progress: RefreshProgressState;
}

function hashText(value: string): string {
  return sha256Hex(Array.from(new TextEncoder().encode(value)));
}

function policyText(policy: RefreshTablePolicy): string {
  switch (policy.policy) {
    case 'full': return `${policy.table} · full table`;
    case 'exclude': return `${policy.table} · excluded`;
    case 'generate': return `${policy.table} · generate ${policy.rows} rows · seed offset ${policy.seedOffset}`;
    case 'predicate': return `${policy.table} · predicate ${policy.where}`;
    case 'row_limit':
    case 'sample': {
      const kind = policy.policy === 'sample' ? `sample seed ${policy.sampleSeed}` : `ordered ${policy.orderBy.join(', ')} ${policy.direction}`;
      return `${policy.table} · ${policy.policy} · ${policy.rows} rows · ${kind} · unique tie-breaker ${policy.tieBreaker.join(', ')} · ${policy.limitKind ?? 'soft'} limit`;
    }
    case 'time_window': {
      const window = resolveRefreshWindow(policy);
      return `${policy.table} · ${policy.mode} · ${policy.amount} ${policy.unit} · ${policy.column} ≥ ${window.startUtc} and < ${window.cutoffUtc} · timezone ${window.timeZone} · NULLs ${policy.nullPolicy}`;
    }
  }
}

function outcome(input: RefreshReportInput): OperationReport['outcome'] {
  if (input.progress.status === 'failed' || input.progress.status === 'uncertain') return 'failed';
  if (input.progress.status === 'cancelled') return 'cancelled';
  if (input.progress.status === 'completed' && input.progress.verification?.status === 'verified') return 'completed';
  return 'incomplete';
}

export function buildRefreshOperationReport(input: RefreshReportInput): OperationReport {
  const { spec, progress } = input;
  const plan = buildRefreshPlan(spec);
  const incomplete: string[] = [];
  if (plan.blockers.length) incomplete.push(...plan.blockers.map(value => `Selection: ${value}`));
  if (input.rowSetPlan && !input.rowSetPlan.fixedPoint) incomplete.push('Fixed-point row-set planning is incomplete');
  if (input.rowSetPlan) incomplete.push(...input.rowSetPlan.blockers.map(value => `Row sets: ${value}`));
  if (input.executionPlan && !input.executionPlan.executable) incomplete.push('The execution plan is not executable');
  if (input.executionPlan) incomplete.push(...input.executionPlan.blockers.map(value => `Execution: ${value}`));
  if (input.maskPlan && !input.maskPlan.complete) incomplete.push(...input.maskPlan.blockers.map(value => `Masks: ${value}`));
  if (!progress.runKey) incomplete.push('Refresh execution has not run');
  else if (!progress.status) incomplete.push('Terminal execution evidence is not complete');
  if (progress.status === 'uncertain') incomplete.push('A target statement or commit outcome is uncertain; no rollback or success is claimed');
  if (progress.error) incomplete.push('The run failed; terminal error prose is intentionally omitted from this value-free report');
  if (!progress.verification) incomplete.push('No terminal verification report is available');
  if (progress.verification && progress.verification.status !== 'verified') {
    incomplete.push(`Verification is ${progress.verification.status}; disabled checks and unverified columns are not matching-content proof`);
  }
  for (const column of progress.verification?.unverified_columns ?? []) {
    incomplete.push(`Unverified ${column.table}.${column.column} (${column.data_type}): ${column.reason}`);
  }
  for (const table of progress.verification?.tables ?? []) {
    if (table.count_status === 'failed') incomplete.push(`${table.table}: exact count verification failed`);
    if (table.content_status === 'failed') incomplete.push(`${table.table}: masked-content verification failed`);
  }
  for (const edge of progress.verification?.foreign_keys ?? []) {
    if (edge.status === 'failed') incomplete.push(`${edge.child} ${edge.name}: ${edge.orphan_rows ?? 'unknown'} FK orphan rows`);
  }

  const sections: OperationReportSection[] = [
    {
      heading: 'Refresh identity',
      facts: [
        { label: 'Specification SHA-256', value: plan.specSha256 },
        { label: 'Catalog SHA-256', value: input.executionPlan?.catalogSha256 ?? null },
        { label: 'Planned row-set SHA-256', value: input.executionPlan?.rowSetSha256 ?? null },
        { label: 'Source', value: `${input.sourceName} · ${spec.source.connectionId}` },
        { label: 'Target', value: `${input.targetName} · ${spec.target.connectionId}` },
        { label: 'Schema mappings', value: spec.schemaMappings.map(mapping => `${mapping.source} → ${mapping.target}`).join(', ') },
        { label: 'Seed SHA-256 (seed omitted)', value: hashText(spec.seed) },
        { label: 'Explicit FK-breaking masks', value: spec.allowFkBreaking },
        { label: 'Unmasked sensitive columns acknowledged', value: spec.acknowledgeUnmaskedSensitive ?? false },
        { label: 'Run ID', value: progress.runKey },
        { label: 'Run status', value: progress.status ?? progress.phase },
      ],
    },
    {
      heading: 'Selection and cutoff semantics',
      facts: [
        { label: 'Requested rows', value: input.rowSetPlan?.totals.requested ?? progress.requestedRows },
        { label: 'FK-closure rows', value: input.rowSetPlan?.totals.closureAdded ?? progress.closureRows },
        { label: 'Final selected rows', value: input.rowSetPlan?.totals.final ?? progress.plannedRows },
        { label: 'Fixed-point iterations', value: input.rowSetPlan?.iterations ?? null },
        { label: 'Key-only planning queries', value: input.rowSetPlan?.sourceQueries ?? null },
        { label: 'Planning key rows read', value: input.rowSetPlan?.sourceRowsRead ?? null },
      ],
      lines: spec.tables.map(policyText),
    },
    {
      heading: 'Masks',
      facts: [
        { label: 'Explicit specification masks', value: spec.masks.length },
        { label: 'Validated mask rules', value: input.maskPlan?.rules.length ?? null },
        { label: 'Mask contract complete', value: input.maskPlan?.complete ?? null },
      ],
      lines: spec.masks.map(mask => {
        const table = resolveRefreshTable(spec, mask.table);
        const sourceKey = typeof table === 'string' ? mask.table : `${table.sourceSchema}.${table.tableName}`;
        const resolved = input.maskPlan?.rules.find(rule => rule.column === mask.column && rule.table === sourceKey);
        const detail = mask.rule === 'constant' ? 'constant (value omitted)'
          : mask.rule === 'fake' ? `fake · ${mask.generator}` : mask.rule;
        return `${mask.table}.${mask.column} · ${detail}${resolved?.relation ? ` · relational scope ${resolved.relation}` : ''}`;
      }),
    },
    {
      heading: 'Target preflight and committed scope',
      facts: [
        { label: 'Preflight SHA-256', value: input.preflight?.preflightSha256 ?? null },
        { label: 'Selected target tables proven empty', value: input.preflight?.emptyTables ?? null },
        { label: 'Source backend ID', value: progress.sourceBackendId },
        { label: 'Target backend ID', value: progress.targetBackendId },
        { label: 'Inserted rows including uncommitted', value: progress.rowsInserted },
        { label: 'Committed rows', value: progress.committedRows },
        { label: 'In-flight rows', value: progress.inFlightRows },
        { label: 'Remaining rows', value: progress.remainingRows },
        { label: 'Committed chunks', value: progress.chunksCommitted },
        { label: 'Elapsed ms', value: progress.elapsedMs },
        { label: 'Measured committed rows/s', value: progress.rowsPerSecond },
        { label: 'ETA seconds', value: progress.etaSeconds },
        { label: 'Source bytes read', value: progress.sourceBytesRead },
        { label: 'Target outbound SQL bytes', value: progress.targetBytesWritten },
      ],
      lines: [
        'Source and target never share a transaction; committed target chunks remain after failure or cancellation',
        'Terminal error prose is retained in the application log and intentionally omitted from this portable report',
      ],
    },
  ];

  if (input.rowSetPlan) {
    sections.push({
      heading: 'Requested and FK-closure rows by table',
      lines: input.rowSetPlan.tables.map(table => `${table.table} · ${table.action} · requested ${table.requested ?? 'unknown'} + closure ${table.closureAdded ?? 'unknown'} = final ${table.final ?? 'unknown'}`),
    });
  }

  const verification = progress.verification;
  if (verification) {
    const lines = verification.tables.map(table => `${table.table} → ${table.target} · selected ${table.selected_rows} · committed ${table.committed_rows} · target ${table.target_rows ?? 'not counted'} · counts ${table.count_status} · content ${table.content_status} · chunks ${table.chunks_checked} · table SHA-256 ${table.content_sha256 ?? 'not available'}${table.chunk_hashes_omitted ? ` · ${table.chunk_hashes_omitted} matching chunk hashes omitted from the bounded report` : ''}`);
    lines.push(...verification.foreign_keys.map(edge => `${edge.child} → ${edge.parent} · ${edge.name} · ${edge.status} · orphan rows ${edge.orphan_rows ?? 'not checked'}`));
    lines.push(...verification.unverified_columns.map(column => `UNVERIFIED ${column.table}.${column.column} (${column.data_type}) · ${column.reason}`));
    for (const table of verification.tables) {
      lines.push(...table.chunk_hashes.map(chunk => `${table.table} chunk ${chunk.chunk_index} · ${chunk.rows} rows · ${chunk.matched ? 'matched' : 'FAILED'} · outbound ${chunk.outbound_sha256} · target ${chunk.target_sha256}`));
    }
    sections.push({
      heading: 'Verification coverage and failures',
      facts: [
        { label: 'Verification status', value: verification.status },
        { label: 'Comparable-content SHA-256', value: verification.comparable_content_sha256 },
        { label: 'Tables', value: verification.tables.length },
        { label: 'FK checks', value: verification.foreign_keys.length },
        { label: 'Unverified columns', value: verification.unverified_columns.length },
      ],
      lines,
    });
  }

  return {
    title: 'Safe Environment Refresh report',
    subject: `${input.targetName} · ${spec.schemaMappings.map(mapping => mapping.target).join(', ')}`,
    outcome: outcome(input),
    sections,
    incompleteEvidence: [...new Set(incomplete)],
  };
}

export function renderRefreshReport(input: RefreshReportInput): string {
  return renderOperationReport(buildRefreshOperationReport(input));
}
