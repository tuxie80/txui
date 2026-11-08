import { sha256Hex } from './datagenStandards.ts';
import { parseMigrationHandoff } from './operationHandoff.ts';
import type { MigrationHandoff } from './operationHandoff.ts';
import type { QueryLabCandidate, QueryLabExecutionMode } from './queryLabSpec.ts';

function quote(engine: 'mysql' | 'postgres', identifier: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(identifier)) throw new Error(`invalid migration identifier ${identifier}`);
  return engine === 'mysql' ? `\`${identifier}\`` : `"${identifier}"`;
}

function qualifiedTable(engine: 'mysql' | 'postgres', table: string): string {
  const parts = table.split('.');
  if (parts.length < 1 || parts.length > 2 || parts.some(part => !part)) throw new Error('index table must be table or schema.table');
  return parts.map(part => quote(engine, part)).join('.');
}

export function queryLabIndexArtifact(
  candidate: Extract<QueryLabCandidate, { kind: 'index' }>,
  engine: 'mysql' | 'postgres',
  specSha256: string,
): string {
  const stem = candidate.id.replace(/[^a-z0-9_]/g, '_').slice(0, 40);
  const indexName = `idx_${stem}_${specSha256.slice(0, 8)}`;
  const columns = candidate.columns.map(column => quote(engine, column)).join(', ');
  const predicate = candidate.where ? ` WHERE ${candidate.where}` : '';
  return `CREATE ${candidate.unique ? 'UNIQUE ' : ''}INDEX ${quote(engine, indexName)} ON ${qualifiedTable(engine, candidate.table)} (${columns})${predicate}`;
}

export function buildQueryLabMigrationHandoff(input: {
  engine: 'mysql' | 'postgres';
  database: string;
  specSha256: string;
  mode: QueryLabExecutionMode;
  candidate: QueryLabCandidate;
  correctness: 'equal' | 'not_applicable';
  verdict: string;
  indexUsed?: boolean | null;
}): MigrationHandoff {
  if (!/^[0-9a-f]{64}$/.test(input.specSha256)) throw new Error('Query Lab spec hash must be a lowercase SHA-256 digest');
  if (input.candidate.kind === 'setting') throw new Error('Setting candidates cannot become a migration artifact');
  if (input.candidate.kind === 'index' && input.indexUsed !== true) {
    throw new Error('Create migration requires proof that the candidate index was used');
  }
  if (input.candidate.kind === 'rewrite' && input.correctness !== 'equal') {
    throw new Error('Create migration requires equal rewrite results');
  }
  const sql = input.candidate.kind === 'index'
    ? queryLabIndexArtifact(input.candidate, input.engine, input.specSha256)
    : input.candidate.sql;
  const artifactSha256 = sha256Hex(Array.from(new TextEncoder().encode(sql)));
  return parseMigrationHandoff({
    version: 1,
    engine: input.engine,
    database: input.database,
    sql,
    origin: 'query-lab',
    labEvidence: {
      specSha256: input.specSha256,
      artifactSha256,
      candidateId: input.candidate.id,
      candidateKind: input.candidate.kind,
      mode: input.mode,
      correctness: input.correctness,
      verdict: input.verdict,
      indexUsed: input.candidate.kind === 'index' ? true : null,
    },
  });
}
