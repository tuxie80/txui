/**
 * The ClickHouse SQL Quality rulebook (the ClickHouse plan: "real work, not a
 * flag").
 *
 * The MySQL/PG analyzer does not translate: ClickHouse has no cost optimizer,
 * no rows-examined, no EXPLAIN ANALYZE and no InnoDB statistics. What it has
 * instead is unusually legible evidence — MergeTree key metadata in
 * `system.tables`/`system.columns`, REAL pruning counts in
 * `EXPLAIN indexes = 1` (parts/granules the scan still has to read), honest
 * read volumes in `EXPLAIN ESTIMATE`, and a per-node execution history in
 * `system.query_log`. These rules judge that evidence, so the finding ids are
 * a third namespace beside the MySQL (L/D/S/A/E/X) and schema-review sets:
 *
 *   CH-S*  static, over the SQL text alone
 *   CH-M*  catalog metadata (engine, keys, sizes) × the predicates
 *   CH-E*  EXPLAIN indexes = 1 pruning evidence
 *   CH-T*  EXPLAIN ESTIMATE read volumes
 *   CH-Q*  system.query_log history
 *
 * Everything here is pure — the collector that fills {@link ChTableMeta} and
 * runs the EXPLAIN kinds lives in utils/qualityRunCh.ts. Driven by
 * `node --test` (tests/chQuality.test.ts) over the fixtures in
 * tests/fixtures/ch-*.
 */
import type { Finding, Severity } from './sqlLint.ts';
import { blank } from './sqlAlias.ts';
import { extractQueryShape } from './typeAudit.ts';
import { parseClickhousePlan } from './planClickhouse.ts';
import type { PlanNode } from './planParse.ts';

// ── inputs ──────────────────────────────────────────────────────────────────

/** Per-column key participation, from `system.columns`. */
export interface ChColumnMeta {
  inPartition: boolean;
  inSorting: boolean;
  inPrimary: boolean;
  /** Server type string, e.g. `Nullable(DateTime)`, `LowCardinality(String)`. */
  type: string;
}

/** One referenced MergeTree table, from `system.tables` + `system.columns`. */
export interface ChTableMeta {
  /** Qualified `db.table`, lowercased. */
  name: string;
  engine: string;
  partitionKey: string;
  sortingKey: string;
  primaryKey: string;
  /** NULL on the server (views, some engines) — unknown, never zero. */
  totalRows: number | null;
  /** Lowercased column name → metadata. */
  columns: Map<string, ChColumnMeta>;
}

/** One row of `EXPLAIN ESTIMATE`: (database, table, parts, rows, marks). */
export interface ChEstimateRow {
  db: string;
  table: string;
  parts: number;
  rows: number;
  marks: number;
}

/** Aggregated `system.query_log` history for one normalized query shape. */
export interface ChQueryLogStats {
  executions: number;
  avgReadRows: number;
  avgReadBytes: number;
  avgDurationMs: number;
}

// ── thresholds (named, so the report can cite them) ─────────────────────────

/** CH-T1: an ESTIMATE read above this many rows is a headline finding. */
export const CH_T1_ROW_THRESHOLD = 1_000_000_000;
/** CH-T1: reading ≥90% of a table's total_rows is a whole-table read. */
export const CH_T1_WHOLE_TABLE_FRACTION = 0.9;
/** CH-M2: prefix/partition advice only matters once the table is large. */
export const CH_M2_LARGE_TABLE = 10_000_000;
/** CH-T2: many parts read with few rows each — the small-parts smell. */
export const CH_T2_MIN_PARTS = 50;
export const CH_T2_MIN_ROWS_PER_PART = 10_000;

// ── SQL text helpers ────────────────────────────────────────────────────────

const hasWhere = (b: string): boolean => /\bwhere\b/i.test(b);
const hasLimit = (b: string): boolean => /\blimit\b/i.test(b);

/** The WHERE clause of the blanked SQL, cut at the next clause boundary. */
function whereClause(b: string): string {
  const m = /\bwhere\b/i.exec(b);
  if (!m) return '';
  const rest = b.slice(m.index + 5);
  const end = /\b(group\s+by|having|qualify|window|order\s+by|limit|union|into\s+outfile|format)\b/i
    .exec(rest);
  return end ? rest.slice(0, end.index) : rest;
}

export interface ChPredicate {
  /** Bare predicate columns (lowercased, last segment of a.b). */
  plain: string[];
  /** Function-wrapped predicate columns: `toDate(ts) = …` — op is the comparison. */
  wrapped: { fn: string; column: string; op: string }[];
}

/** Predicate columns out of the WHERE clause (structure only — literals are blanked). */
export function chPredicates(sql: string): ChPredicate {
  const w = whereClause(blank(sql));
  const plain = new Set<string>();
  const wrapped: { fn: string; column: string; op: string }[] = [];
  {
    const re = /(?:[A-Za-z_][\w$]*\.)?([A-Za-z_][\w$]*)\s*(?:=|!=|<>|>=?|<=?|\bIN\b|\bLIKE\b|\bILIKE\b|\bBETWEEN\b)/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(w)) !== null) plain.add(m[1].toLowerCase());
  }
  {
    const re = /([A-Za-z_][\w$]*)\s*\(\s*(?:[A-Za-z_][\w$]*\.)?([A-Za-z_][\w$]*)\s*\)\s*(=|!=|<>|>=?|<=?|\bIN\b|\bBETWEEN\b|\bLIKE\b)/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(w)) !== null) {
      wrapped.push({ fn: m[1].toLowerCase(), column: m[2].toLowerCase(), op: m[3].toLowerCase() });
    }
  }
  return { plain: [...plain], wrapped };
}

/**
 * Monotonic wrappers ClickHouse can see through for pruning: a range on the
 * bare column still prunes when the key expression wraps it in one of these.
 */
const MONOTONIC_FN = new Set([
  'toyyyymm', 'toyyyymmdd', 'todate', 'todate32', 'tostartofmonth',
  'tostartofweek', 'tostartofday', 'tostartofhour', 'toyear', 'tomonth',
  'tomonday', 'toquarter', 'tostartoftenminutes', 'tostartoffifteenminutes',
]);

interface KeyEntry { raw: string; /** bare identifier, or the inner column of a monotonic wrapper */ column: string | null }

/** Split a key expression on top-level commas (functions contain commas). */
function splitTopLevel(expr: string): string[] {
  const parts: string[] = [];
  let depth = 0, start = 0;
  for (let i = 0; i < expr.length; i++) {
    const ch = expr[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    else if (ch === ',' && depth === 0) { parts.push(expr.slice(start, i)); start = i + 1; }
  }
  parts.push(expr.slice(start));
  return parts.map(p => p.trim()).filter(p => p.length > 0);
}

/** Parse `user_id, toYYYYMM(ts)` into entries a predicate can match against. */
export function keyEntries(expr: string): KeyEntry[] {
  const e = expr.trim();
  if (!e || e.toLowerCase() === 'tuple()') return [];
  return splitTopLevel(e).map(raw => {
    const bare = /^[A-Za-z_][\w$]*$/.test(raw) ? raw.toLowerCase() : null;
    if (bare) return { raw, column: bare };
    const w = /^([A-Za-z_][\w$]*)\s*\(\s*([A-Za-z_][\w$]*)\s*\)$/.exec(raw);
    if (w && MONOTONIC_FN.has(w[1].toLowerCase())) return { raw, column: w[2].toLowerCase() };
    return { raw, column: null };
  });
}

/** Find a table's metadata by qualified or bare name, case-insensitively. */
export function chMetaFor(name: string, meta: ReadonlyMap<string, ChTableMeta>): ChTableMeta | undefined {
  const n = name.toLowerCase();
  const hit = meta.get(n);
  if (hit) return hit;
  for (const [key, m] of meta) if (key === n || key.endsWith(`.${n}`)) return m;
  return undefined;
}

/** Unwrap Nullable()/LowCardinality() so width estimates see the base type. */
function baseType(t: string): string {
  let s = t.trim();
  for (;;) {
    const m = /^(?:Nullable|LowCardinality)\((.*)\)$/.exec(s);
    if (!m) return s;
    s = m[1].trim();
  }
}

/** Rough per-row width of one column — a model, never presented as measured. */
function approxTypeBytes(t: string): number {
  const b = baseType(t);
  if (/^(U?Int8|Bool)\b/.test(b)) return 1;
  if (/^U?Int16\b/.test(b)) return 2;
  if (/^(U?Int32|Float32|Date32?|Decimal32)\b/.test(b)) return 4;
  if (/^(U?Int64|Float64|DateTime(64)?|Decimal64)\b/.test(b)) return 8;
  if (/^(U?Int128|Decimal128|UUID)\b/.test(b)) return 16;
  if (/^(U?Int256|Decimal256)\b/.test(b)) return 32;
  if (/^FixedString\((\d+)\)/.test(b)) return Number(/FixedString\((\d+)\)/.exec(b)![1]);
  if (/^(String|IPv[46])\b/.test(b)) return 16; // short-string average guess
  if (/^Array\(/.test(b)) return 32;
  return 8;
}

// ── CH-S*: static rules (SQL text alone) ────────────────────────────────────

export function chStaticRules(sql: string, meta?: ReadonlyMap<string, ChTableMeta>): Finding[] {
  const out: Finding[] = [];
  const b = blank(sql);

  // CH-S1 — unbounded read: no WHERE, no LIMIT, but a real table behind FROM.
  if (/\bfrom\b/i.test(b) && !hasWhere(b) && !hasLimit(b)) {
    out.push({
      id: 'CH-S1', severity: 'yellow', confidence: 'inferred',
      title: 'Unbounded SELECT — no WHERE and no LIMIT',
      detail: 'The scan reads the whole table. ClickHouse has no row-examined cap by '
        + 'default, so this runs to completion however large the table is. If the goal '
        + 'is exploration, add LIMIT; if it is a whole-table aggregate, that is a '
        + 'legitimate shape — CH-T1 upgrades this when ESTIMATE shows a very large read.',
      snippet: sql.replace(/\s+/g, ' ').slice(0, 90),
    });
  }

  // CH-S2 — SELECT *: column count + approximate row width once metadata resolves.
  if (/\bselect\s+\*[\s,]/i.test(b) || /\bselect\s+\*$/i.test(b)) {
    const shape = extractQueryShape(sql);
    const m = shape.tables.length === 1 && meta ? chMetaFor(shape.tables[0], meta) : undefined;
    if (m && m.columns.size > 0) {
      const n = m.columns.size;
      const width = [...m.columns.values()].reduce((s, c) => s + approxTypeBytes(c.type), 0);
      out.push({
        id: 'CH-S2', severity: n >= 20 ? 'orange' : 'yellow',
        confidence: 'certain',
        title: `SELECT * reads all ${n} columns of ${m.name} (~${width} B/row uncompressed)`,
        detail: 'ClickHouse is columnar — every named column is a separate read, so the '
          + 'cost of SELECT * scales with the column count, not the row count. Naming the '
          + 'columns the consumer actually uses is the single cheapest CH optimization. '
          + 'The width is a model estimate from the declared types, not a measurement.',
        cost: { rows: m.totalRows ?? undefined },
      });
    } else {
      out.push({
        id: 'CH-S2', severity: 'yellow', confidence: 'inferred',
        title: 'SELECT * — every column is read from disk',
        detail: 'ClickHouse is columnar: unnamed columns are never touched, and every '
          + 'starred one is. Name the columns the consumer uses. (Column count unknown — '
          + 'run with the Referenced tables check to get it.)',
      });
    }
  }

  // CH-S3 — FINAL: forces the merge the background process is paid to do.
  if (/\bfrom\s+[A-Za-z_][\w$]*(?:\.[A-Za-z_][\w$]*)?\s+final\b/i.test(b)) {
    out.push({
      id: 'CH-S3', severity: 'orange', confidence: 'inferred',
      title: 'FINAL merges every part at query time',
      detail: 'SELECT … FROM t FINAL collapses all parts on read — the dedup/merge the '
        + 'background merger does for free becomes a per-query, single-scan cost, and it '
        + 'defeats most index pruning. For ReplacingMergeTree prefer argMax/GROUP BY on '
        + 'the rows you need; reserve FINAL for one-off audits.',
      fix: '-- instead of  SELECT … FROM t FINAL WHERE k = …\n'
        + 'SELECT key, argMax(col, version) FROM t WHERE k = … GROUP BY key',
    });
  }

  // CH-S4 — arrayJoin explodes the row count mid-pipeline.
  if (/\barrayjoin\s*\(/i.test(b)) {
    out.push({
      id: 'CH-S4', severity: 'yellow', confidence: 'inferred',
      title: 'arrayJoin multiplies rows mid-query',
      detail: 'Every array element becomes a row downstream of the arrayJoin — joins, '
        + 'aggregations and sorts after it work on the exploded cardinality. Filter '
        + '(arrayExists/arrayFilter) before exploding when only matching elements matter.',
    });
  }

  // CH-S5 — cartesian join: explicit CROSS JOIN, or a comma join with no keys.
  if (/\bcross\s+join\b/i.test(b)) {
    out.push({
      id: 'CH-S5', severity: 'red', confidence: 'inferred',
      title: 'CROSS JOIN — every row pairs with every row',
      detail: 'ClickHouse executes this as a full cartesian product in memory; on '
        + 'analytical table sizes that is a query that never returns. If a partial '
        + 'cartesian was intended (ASOF/inequality), rewrite with the smallest side '
        + 'bounded first.',
    });
  } else {
    const b2 = b.replace(/\([^()]*\)/g, ''); // subquery bodies aside (one level)
    const from = /\bfrom\b([\s\S]*?)(?:\bwhere\b|\bgroup\s+by\b|\border\s+by\b|\blimit\b|$)/i.exec(b2);
    if (from && from[1].includes(',')) {
      const keyed = extractQueryShape(sql).joins.length > 0;
      if (!keyed) {
        out.push({
          id: 'CH-S5', severity: 'red', confidence: 'inferred',
          title: 'Comma join with no join keys — cartesian product',
          detail: 'Multiple tables in FROM with no equality relating them is a CROSS '
            + 'JOIN written with a comma. Add the join condition (or make it an explicit '
            + 'JOIN … ON so the missing key cannot come back).',
        });
      }
    }
  }

  // CH-S6 — ORDER BY without LIMIT: full sort of the whole result.
  if (/\border\s+by\b/i.test(b) && !hasLimit(b)) {
    out.push({
      id: 'CH-S6', severity: 'yellow', confidence: 'inferred',
      title: 'ORDER BY without LIMIT sorts the entire result',
      detail: 'The whole result set is materialized and sorted before the first row '
        + 'returns. With LIMIT n, ClickHouse keeps only a partial-sort heap of n rows '
        + '— the difference between sorting a stream and sorting a table.',
    });
  }

  // CH-S7 — leading-wildcard LIKE: token bloom/ngram skip indexes cannot help.
  {
    const m = /\b(?:i?like)\s+'%/i.exec(sql);
    if (m) {
      out.push({
        id: 'CH-S7', severity: 'yellow', confidence: 'inferred',
        title: `Leading-wildcard ${/^i/i.test(m[0]) ? 'ILIKE' : 'LIKE'} — no index or skip index can serve it`,
        detail: 'A pattern starting with % is a substring search over every value of the '
          + 'column. A tokenbf_v1/ngrambf_v1 data-skipping index only helps when the '
          + 'needle is a fixed token — rewrite as hasToken()/endsWith() semantics or '
          + 'anchor the pattern (prefix%) if the data allows.',
        snippet: m[0],
      });
    }
  }

  // CH-S8 — function-wrapped predicate column: range on the bare column instead.
  {
    // A predicate written AS a table's key/partition expression is the good
    // pattern, not the anti-pattern — collect those expressions so S8 never
    // flags its own fix.
    const keyExprs = new Set<string>();
    for (const t of meta?.values() ?? []) {
      for (const expr of [t.partitionKey, t.sortingKey, t.primaryKey]) {
        for (const e of keyEntries(expr)) keyExprs.add(e.raw.toLowerCase().replace(/\s+/g, ''));
      }
    }
    const { wrapped } = chPredicates(sql);
    const seen = new Set<string>();
    for (const w of wrapped) {
      const key = `${w.fn}(${w.column})`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (keyExprs.has(key)) continue;
      if (MONOTONIC_FN.has(w.fn)) {
        // ClickHouse's key analysis sees THROUGH monotonic functions on
        // ranges, so `toDate(ts) >= …` prunes fine and stays silent. The
        // equality form is the classic anti-pattern: it asks for one whole
        // day/month as an expression match, and the moment the key expression
        // differs even slightly the pruning is gone with no warning.
        if (w.op !== '=') continue;
        out.push({
          id: 'CH-S8', severity: 'orange', confidence: 'inferred',
          title: `${w.fn}(${w.column}) = … matches an interval — say it as a range`,
          detail: `Equality on ${w.fn}(${w.column}) asks for every row inside one `
            + 'day/month/…, but as an expression match. A half-open range on the bare '
            + 'column says the same thing AND keeps partition/primary-key pruning '
            + 'working no matter how the key expression is written.',
          fix: `WHERE ${w.column} >= <start> AND ${w.column} < <start> + INTERVAL 1 DAY`,
        });
        continue;
      }
      out.push({
        id: 'CH-S8', severity: 'orange', confidence: 'inferred',
        title: `Predicate on ${w.fn}(${w.column}) — rewrite as a range on the bare column`,
        detail: `Wrapping the column in ${w.fn}() means the primary-key/partition `
          + 'analysis sees an opaque expression, not the column. A range on the bare '
          + 'column prunes; a function comparison does not.',
        fix: `-- instead of  ${w.fn}(${w.column}) ${w.op} <value>\n`
          + `WHERE ${w.column} >= <range_start> AND ${w.column} < <range_end>`,
      });
    }
  }

  return out;
}

// ── CH-M*: catalog metadata × predicates ────────────────────────────────────

export function chMetadataRules(sql: string, tables: ReadonlyMap<string, ChTableMeta>): Finding[] {
  const out: Finding[] = [];
  const { plain, wrapped } = chPredicates(sql);

  for (const t of tables.values()) {
    // CH-M1 — MergeTree family ordered by tuple(): no sorting key at all.
    if (/MergeTree/i.test(t.engine) && !/Distributed|Replicated.*Distributed/i.test(t.engine)) {
      if (t.sortingKey.trim().toLowerCase() === 'tuple()') {
        out.push({
          id: 'CH-M1', severity: 'orange', confidence: 'certain',
          title: `${t.name} (${t.engine}) has ORDER BY tuple() — no sorting key`,
          detail: 'Every query against this table is a full scan by construction: with '
            + 'no sorting key there is no primary index and no granule-level pruning. '
            + 'Choose the columns the common filters use (most selective equality first, '
            + 'then the time column).',
          fix: `ALTER TABLE ${t.name} MODIFY ORDER BY (<filter_columns>);  -- or recreate with ORDER BY`,
        });
      }
    }

    // CH-M3 — Distributed fan-out: one hop per shard, per query.
    if (/^Distributed/i.test(t.engine)) {
      out.push({
        id: 'CH-M3', severity: 'info', confidence: 'certain',
        title: `${t.name} is a Distributed table — the query fans out to every shard`,
        detail: 'Read volume below is per-shard work summed at the initiator; a query '
          + 'that is fine on one node multiplies across the cluster. Prefer a local '
          + 'table + GLOBAL IN/JOIN shape for heavy filters, and aggregate before the '
          + 'distributed step where possible.',
      });
    }

    // CH-M2 — large table, predicates that touch no pruning surface.
    if (plain.length > 0 && (t.totalRows ?? 0) >= CH_M2_LARGE_TABLE) {
      const partitionCols = new Set(
        keyEntries(t.partitionKey).map(e => e.column).filter((c): c is string => c !== null));
      for (const [name, c] of t.columns) if (c.inPartition) partitionCols.add(name);
      const primary = keyEntries(t.primaryKey);
      const sorting = keyEntries(t.sortingKey);
      const firstKey = (primary[0] ?? sorting[0])?.column ?? null;
      const touchesPartition = plain.some(c => partitionCols.has(c));
      const touchesKeyPrefix = firstKey !== null && plain.includes(firstKey);
      const keyName = primary[0]?.raw ?? sorting[0]?.raw ?? null;
      if (!touchesPartition && !touchesKeyPrefix && (keyName !== null || partitionCols.size > 0)) {
        out.push({
          id: 'CH-M2', severity: 'orange', confidence: 'certain',
          title: `${t.name}: predicates (${plain.join(', ')}) hit neither the partition key nor the leading key column`,
          detail: `This table holds ~${(t.totalRows ?? 0).toLocaleString()} rows. `
            + 'ClickHouse prunes on the partition key and on a PREFIX of the primary/'
            + `sorting key — here ${keyName ? `the leading key entry is \`${keyName}\`` : 'there is no key prefix'}`
            + (partitionCols.size ? ` and the partition key covers ${[...partitionCols].join(', ')}` : '')
            + '. A predicate on a later key column alone prunes little; the scan reads '
            + 'nearly everything.',
          fix: keyName
            ? `-- lead with the key:  WHERE ${keyName} = … AND ${plain[0]} = …`
            : undefined,
        });
      }
    }

    // CH-M4 — predicate wraps a partition-key column in a function.
    const partEntries = keyEntries(t.partitionKey);
    const partInner = new Set(partEntries.map(e => e.column).filter((c): c is string => c !== null));
    for (const w of wrapped) {
      if (!partInner.has(w.column)) continue;
      // The partition expression itself used as the predicate DOES prune.
      if (partEntries.some(e => e.raw.toLowerCase().replace(/\s+/g, '') === `${w.fn}(${w.column})`)) continue;
      out.push({
        id: 'CH-M4', severity: 'orange', confidence: 'certain',
        title: `Predicate ${w.fn}(${w.column}) hides the partition key of ${t.name} from pruning`,
        detail: `The partition key is \`${t.partitionKey}\`. Partition pruning fires `
          + 'when the predicate matches the partition expression itself, or a range on '
          + `the bare column \`${w.column}\` — a different function around the same `
          + 'column prunes nothing.',
        fix: `WHERE ${w.column} >= <start> AND ${w.column} < <end>   -- or match the key: ${t.partitionKey} = …`,
      });
    }
  }
  return out;
}

// ── CH-E*: EXPLAIN indexes = 1 ──────────────────────────────────────────────

interface IndexEntry {
  name: string;
  parts: [number, number] | null;
  granules: [number, number] | null;
  verbatim: string[];
}

/** ReadFromMergeTree nodes of a parsed indexes=1 plan, with their index entries. */
export function chIndexReads(planText: string): { table: string | null; entries: IndexEntry[] }[] {
  let root: PlanNode;
  try {
    root = parseClickhousePlan(planText).root;
  } catch {
    return [];
  }
  const reads: { table: string | null; entries: IndexEntry[] }[] = [];
  const walk = (n: PlanNode) => {
    if (/^ReadFromMergeTree/i.test(n.op)) {
      const table = /\(([^)]+)\)/.exec(n.op)?.[1] ?? null;
      const idxNode = n.children.find(c => c.op === 'Indexes');
      const entries: IndexEntry[] = (idxNode?.children ?? []).map(e => {
        const partsTxt = e.children.find(c => c.op === 'Parts')?.detail ?? '';
        const granTxt = e.children.find(c => c.op === 'Granules')?.detail ?? '';
        const pm = /^(\d+)\s*\/\s*(\d+)$/.exec(partsTxt.trim());
        const gm = /^(\d+)\s*\/\s*(\d+)$/.exec(granTxt.trim());
        return {
          name: e.op,
          parts: pm ? [Number(pm[1]), Number(pm[2])] : null,
          granules: gm ? [Number(gm[1]), Number(gm[2])] : null,
          verbatim: [partsTxt && `Parts: ${partsTxt}`, granTxt && `Granules: ${granTxt}`]
            .filter((s): s is string => !!s),
        };
      });
      reads.push({ table, entries });
    }
    n.children.forEach(walk);
  };
  walk(root);
  return reads;
}

export function chExplainRules(
  sql: string,
  planText: string,
  tables: ReadonlyMap<string, ChTableMeta>,
): Finding[] {
  const out: Finding[] = [];
  const reads = chIndexReads(planText);
  const where = hasWhere(blank(sql));

  for (const read of reads) {
    const label = read.table ?? 'the MergeTree read';
    const meta = read.table ? chMetaFor(read.table, tables) : undefined;

    // CH-E1 — no index information, or every index kept every part.
    const allParts = read.entries.length > 0
      && read.entries.every(e => e.parts !== null && e.parts[0] === e.parts[1]);
    if (read.entries.length === 0 || allParts) {
      const sev: Severity = where ? 'red' : 'orange';
      const quote = read.entries.length
        ? ' ' + read.entries.map(e => `${e.name} (${e.verbatim.join(' · ') || 'no counts'})`).join(', ') + '.'
        : '';
      out.push({
        id: 'CH-E1', severity: sev, confidence: 'certain',
        title: where
          ? `EXPLAIN indexes = 1: the WHERE prunes nothing on ${label}`
          : `EXPLAIN indexes = 1: no pruning on ${label} — full part set read`,
        detail: (read.entries.length === 0
          ? 'The plan shows no Indexes section for this read, so every part is read.'
          : `Every index kept every part:${quote}`)
          + ' The parts/granules counts are what the scan WILL read, reported by the '
          + 'server before execution — as close to evidence as a non-executing EXPLAIN '
          + 'gets.'
          + (where
            ? ' With a WHERE clause present this means the predicates match no '
              + 'partition/primary-key prefix — see CH-M2.'
            : ' Without a WHERE this is expected; CH-S1 covers the unbounded shape.'),
      });
    }

    // CH-E2 — partitioned table, but no MinMax/Partition index entry at all.
    if (meta && read.entries.length > 0) {
      const hasPartitionKey = meta.partitionKey.trim() !== ''
        && meta.partitionKey.trim().toLowerCase() !== 'tuple()';
      const hasPartEntry = read.entries.some(e => /^(MinMax|Partition)$/i.test(e.name));
      if (hasPartitionKey && !hasPartEntry) {
        out.push({
          id: 'CH-E2', severity: 'orange', confidence: 'certain',
          title: `${meta.name} is partitioned (${meta.partitionKey}) but the plan shows no Partition/MinMax index`,
          detail: 'The Indexes section lists '
            + read.entries.map(e => e.name).join(', ')
            + ' only. On a partitioned table the MinMax/Partition entries are what '
            + 'throw whole partitions away; their absence means partition pruning is '
            + 'not in play for this query shape.',
        });
      }
    }
  }
  return out;
}

// ── CH-T*: EXPLAIN ESTIMATE ─────────────────────────────────────────────────

/** Parse an `EXPLAIN ESTIMATE` answer: `db⇥table⇥parts⇥rows⇥marks` per line. */
export function parseChEstimate(content: string): ChEstimateRow[] {
  const rows: ChEstimateRow[] = [];
  for (const line of content.replace(/\\n/g, '\n').split('\n')) {
    if (line.trim() === '') continue;
    const f = line.split('\t');
    if (f.length !== 5) continue;
    const [db, table, parts, rowsN, marks] = f;
    const p = Number(parts), r = Number(rowsN), mk = Number(marks);
    if (!Number.isFinite(p) || !Number.isFinite(r) || !Number.isFinite(mk)) continue;
    rows.push({ db, table, parts: p, rows: r, marks: mk });
  }
  if (rows.length === 0) throw new Error('no EXPLAIN ESTIMATE rows');
  return rows;
}

export function chEstimateRules(
  sql: string,
  rows: ChEstimateRow[],
  tables: ReadonlyMap<string, ChTableMeta>,
  threshold = CH_T1_ROW_THRESHOLD,
): Finding[] {
  const out: Finding[] = [];
  const limit = hasLimit(blank(sql));
  const total = rows.reduce((s, r) => s + r.rows, 0);

  // CH-T1 — a very large read, unbounded.
  if (!limit && total > threshold) {
    out.push({
      id: 'CH-T1', severity: 'orange', confidence: 'certain',
      title: `EXPLAIN ESTIMATE: ${total.toLocaleString()} rows to read, no LIMIT`,
      detail: `The server's own metadata says the scan reads ${total.toLocaleString()} `
        + `rows (threshold ${threshold.toLocaleString()}). This upgrades CH-S1 from a `
        + 'shape warning to a measured volume: on a shared cluster this is the query '
        + 'that saturates the disk for everyone. Bound it (LIMIT, tighter time range) '
        + 'or pre-aggregate.',
      cost: { rows: total },
    });
  }
  if (!limit) {
    for (const r of rows) {
      const meta = chMetaFor(`${r.db}.${r.table}`, tables);
      if (meta?.totalRows && meta.totalRows > 0
          && r.rows >= CH_T1_WHOLE_TABLE_FRACTION * meta.totalRows
          && total <= threshold) {
        out.push({
          id: 'CH-T1', severity: 'orange', confidence: 'certain',
          title: `EXPLAIN ESTIMATE: whole-table read of ${r.db}.${r.table} (${r.rows.toLocaleString()} of ~${meta.totalRows.toLocaleString()} rows)`,
          detail: 'The estimate covers ≥90% of the table with no LIMIT — a full scan '
            + 'confirmed by the server\'s own part metadata, not inferred from the SQL '
            + 'shape.',
          cost: { rows: r.rows },
        });
      }
    }
  }

  // CH-T2 — many parts, few rows each: the small-parts smell.
  for (const r of rows) {
    if (r.parts >= CH_T2_MIN_PARTS && r.rows / r.parts < CH_T2_MIN_ROWS_PER_PART) {
      out.push({
        id: 'CH-T2', severity: 'yellow', confidence: 'certain',
        title: `${r.db}.${r.table}: ${r.parts} parts read, averaging ${Math.round(r.rows / r.parts).toLocaleString()} rows each`,
        detail: `Reading ≥${CH_T2_MIN_PARTS} parts at <${CH_T2_MIN_ROWS_PER_PART.toLocaleString()} `
          + 'rows/part means the read pays per-part overhead (seeks, merges, marks) for '
          + 'very little data each — the signature of too many small parts (small '
          + 'insert batches, or merges falling behind). Check the Partitions DBA view '
          + 'and the merge backlog.',
      });
    }
  }
  return out;
}

// ── CH-Q*: system.query_log ─────────────────────────────────────────────────

export function chQueryLogFinding(stats: ChQueryLogStats | null, windowDays = 30): Finding {
  if (!stats || stats.executions === 0) {
    return {
      id: 'CH-Q1', severity: 'info', confidence: 'certain',
      title: `system.query_log: no completed runs of this query shape in the last ${windowDays} days`,
      detail: 'No QueryFinish events share this normalized_query_hash on THIS node — '
        + 'query_log is local to each server, and may also be disabled or flushing on '
        + 'a delay (SYSTEM FLUSH LOGS). First run, a rotated log, or a disabled log all '
        + 'look like this.',
    };
  }
  const gib = stats.avgReadBytes / 1024 ** 3;
  return {
    id: 'CH-Q1', severity: 'info', confidence: 'certain',
    title: `system.query_log: ${stats.executions} run${stats.executions === 1 ? '' : 's'} in ${windowDays}d — `
      + `avg ${Math.round(stats.avgReadRows).toLocaleString()} rows / ${gib >= 0.1 ? `${gib.toFixed(1)} GiB` : `${Math.round(stats.avgReadBytes / 1024 ** 2).toLocaleString()} MiB`} / ${Math.round(stats.avgDurationMs).toLocaleString()} ms`,
    detail: 'Measured history of this exact normalized query shape (QueryFinish events '
      + 'on this node) — the closest thing ClickHouse has to EXPLAIN ANALYZE for a '
      + 'query that already ran. Rows read is the number to watch: it moves with data '
      + 'growth even when the SQL does not change.',
    cost: { rows: Math.round(stats.avgReadRows), bytes: Math.round(stats.avgReadBytes) },
  };
}
