/**
 * Galera consistency spot-check — the pure half.
 *
 * The backend (`commands/galera.rs::galera_consistency_check`) ships one raw
 * per-node outcome: row estimate, sampled row count and the checksum text of
 * `COALESCE(SUM(CRC32(CONCAT_WS('#', col…))), 0)` over either a PK-ordered
 * LIMIT sample or the whole table. Everything interpretive lives here:
 *
 *  - parsing the dialog's "schema.table" input (with a default-schema
 *    fallback from the current connection),
 *  - comparing the per-node results (all-equal → match; differing → which
 *    nodes diverge, grouped by checksum; failed/timed-out nodes are
 *    INCONCLUSIVE, never silently dropped from the verdict),
 *  - shaping the one-line verdict and the copyable report.
 *
 * Comparison key is (checksum_text, sampled_rows) together: a matching SUM
 * with a different row count is a mismatch, and both are needed because SUM
 * over CRC32 is an aggregate, not a hash.
 *
 * Pure: no React/Tauri imports — unit-tested with node --test.
 */

/** Sample sizes the dialog offers (row cap per node; "full" is a mode, not a size). */
export const SAMPLE_SIZE_OPTIONS = [
  { value: 1_000, label: '1,000 rows' },
  { value: 10_000, label: '10,000 rows' },
  { value: 100_000, label: '100,000 rows' },
] as const;
export const SAMPLE_SIZE_DEFAULT = 10_000;

export type CheckMode = 'sample' | 'full';

/** One node's outcome, as the panel assembles it from the backend event. */
export interface ConsistencyNodeResult {
  connectionId: string;
  connectionName: string;
  ok: boolean;
  /** Failure/inconclusive reason when ok=false (timeout, no PK, table missing…). */
  error: string | null;
  /** information_schema TABLES.TABLE_ROWS — an InnoDB estimate, null when unknown. */
  rowEstimate: number | null;
  sampledRows: number;
  checksumText: string | null;
  pkColumns: string[];
  elapsedMs: number;
}

export type ConsistencyStatus = 'match' | 'mismatch' | 'inconclusive';

export interface ChecksumGroup {
  /** `${checksumText}:${sampledRows}` — what the group shares. */
  key: string;
  checksumText: string;
  sampledRows: number;
  nodes: ConsistencyNodeResult[];
}

export interface ConsistencyVerdict {
  status: ConsistencyStatus;
  /** Nodes that answered and AGREE — present on every status. */
  groups: ChecksumGroup[];
  /**
   * Nodes named as divergent: every answered node outside the largest
   * checksum group. Empty on match/inconclusive (with no majority there is
   * no "odd one out" — a 2-node disagreement names both groups, no villain).
   */
  divergent: ConsistencyNodeResult[];
  /** Nodes that did not answer (error/timeout/refused) — listed, never hidden. */
  inconclusive: ConsistencyNodeResult[];
  /** One-line verdict text for the green/red line. */
  summary: string;
}

/** Split "schema.table" on the LAST dot so quoted-ish names keep their dots. */
export function parseTableRef(
  input: string,
  defaultSchema: string | null,
): { schema: string; table: string } | { error: string } {
  const trimmed = input.trim();
  if (!trimmed) return { error: 'name a table as schema.table' };
  const dot = trimmed.lastIndexOf('.');
  if (dot > 0 && dot < trimmed.length - 1) {
    return { schema: trimmed.slice(0, dot), table: trimmed.slice(dot + 1) };
  }
  if (dot < 0 && defaultSchema) {
    return { schema: defaultSchema, table: trimmed };
  }
  if (dot < 0) {
    return { error: 'no schema given and this connection has no default database — use schema.table' };
  }
  return { error: 'malformed table name — use schema.table' };
}

function groupKey(r: ConsistencyNodeResult): string {
  return `${r.checksumText ?? ''}:${r.sampledRows}`;
}

/** The comparison: which nodes agree, which diverge, which never answered. */
export function compareConsistency(results: ConsistencyNodeResult[]): ConsistencyVerdict {
  const answered = results.filter(r => r.ok && r.checksumText !== null);
  const inconclusive = results.filter(r => !(r.ok && r.checksumText !== null));

  const byKey = new Map<string, ConsistencyNodeResult[]>();
  for (const r of answered) {
    const k = groupKey(r);
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k)!.push(r);
  }
  const groups: ChecksumGroup[] = [...byKey.entries()]
    .map(([key, nodes]) => ({
      key,
      checksumText: nodes[0].checksumText!,
      sampledRows: nodes[0].sampledRows,
      nodes,
    }))
    .sort((a, b) => b.nodes.length - a.nodes.length);

  const incNote = inconclusive.length > 0
    ? ` — ${inconclusive.length} node${inconclusive.length === 1 ? '' : 's'} inconclusive (${inconclusive.map(n => n.connectionName).join(', ')})`
    : '';

  if (answered.length < 2) {
    return {
      status: 'inconclusive',
      groups,
      divergent: [],
      inconclusive,
      summary: `Inconclusive — fewer than 2 nodes answered${incNote}`,
    };
  }
  if (groups.length === 1) {
    return {
      status: 'match',
      groups,
      divergent: [],
      inconclusive,
      summary: `Match — all ${answered.length} nodes identical ` +
        `(checksum ${groups[0].checksumText}, ${groups[0].sampledRows.toLocaleString()} rows)${incNote}`,
    };
  }
  // Mismatch. The largest group is the majority; everything else is named
  // divergent. A tie (2 nodes, 1+1) names nothing — there is no majority.
  const majority = groups[0];
  const tied = groups.length > 1 && groups[1].nodes.length === majority.nodes.length;
  const divergent = tied ? [] : groups.slice(1).flatMap(g => g.nodes);
  const names = divergent.map(n => n.connectionName).join(', ');
  return {
    status: 'mismatch',
    groups,
    divergent,
    inconclusive,
    summary: tied
      ? `MISMATCH — ${groups.length} different checksums across ${answered.length} nodes, no majority${incNote}`
      : `MISMATCH — ${names} diverge${divergent.length === 1 ? 's' : ''} from the other ${majority.nodes.length}${incNote}`,
  };
}

/** The suggestion shown under a mismatch — the drift scenarios this detects. */
export const MISMATCH_ADVICE =
  'Investigate wsrep_on=OFF drift, local writes or a repair accident on the divergent ' +
  'node(s) — then re-check. Compare the row counts first: a different sampled_rows ' +
  'points at inserted/deleted rows, an equal count at changed values.';

/** Copyable plain-text report of one run. */
export function formatConsistencyReport(
  tableRef: string,
  mode: CheckMode,
  sampleLimit: number,
  verdict: ConsistencyVerdict,
): string {
  const lines: string[] = [
    `Galera consistency spot-check — ${tableRef}`,
    `mode: ${mode === 'full' ? 'full table' : `sample (first ${sampleLimit.toLocaleString()} rows by PK)`}`,
    `verdict: ${verdict.summary}`,
    '',
    'node'.padEnd(24) + 'rows'.padStart(12) + '  checksum'.padEnd(24) + 'elapsed',
  ];
  const all = [...verdict.groups.flatMap(g => g.nodes), ...verdict.inconclusive];
  for (const n of all) {
    const name = n.connectionName.slice(0, 24).padEnd(24);
    if (n.ok && n.checksumText !== null) {
      lines.push(
        name +
        n.sampledRows.toLocaleString().padStart(12) +
        ('  ' + n.checksumText).padEnd(24) +
        `${n.elapsedMs} ms`,
      );
    } else {
      lines.push(name + '—'.padStart(12) + '  ' + (n.error ?? 'inconclusive'));
    }
  }
  if (verdict.status === 'mismatch') lines.push('', MISMATCH_ADVICE);
  return lines.join('\n');
}
