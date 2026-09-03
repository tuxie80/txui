/**
 * Relationships that exist only in a comment.
 *
 * Most production MySQL has no foreign keys at all — they were left out for
 * online-DDL reasons, or for replication, or because someone decided in 2016.
 * The relationships are still there; they live in the column comment:
 *
 *     `order_id INT UNSIGNED COMMENT 'References wapi_orders.order_id'`
 *
 * TxUI already has somewhere to put those: `store/virtualFks.ts` holds
 * user-declared relations and feeds JOIN completion, data-browser
 * click-through and the ER diagram. Until now every one of them had to be
 * typed in by hand, one at a time, for a schema that had already written them
 * down in a place nobody reads.
 *
 * ## A soft reference is a style, not a defect
 *
 * This is the rule the whole module hangs on, taken from the `../review`
 * rulebook. A relationship declared in a comment is a **deliberate house
 * choice**, and reporting "you should add a FOREIGN KEY" for every one of them
 * is noise a developer cannot act on. The only thing worth checking is whether
 * the two columns are the same precise type — because a join across a type
 * difference coerces one side and silently loses its index, whether or not
 * anyone declared a constraint.
 *
 * So: discover the pair, offer it as a virtual FK, compare the types. Never
 * suggest the constraint.
 *
 * Pure and dependency-free — driven by `node --test`.
 */

export interface SoftRef {
  /** Table the comment is on. */
  fromTable: string;
  fromColumn: string;
  /** Table the comment names. */
  toTable: string;
  /** Column the comment names, or null when it only named a table. */
  toColumn: string | null;
  /** The comment text that produced this, for the "why" in the UI. */
  evidence: string;
}

/**
 * The patterns.
 *
 * Ordered longest-alternative-first inside each group, and every one anchored
 * with `\b`. That is not tidiness: `\bref(?:erence|erences|erencing)?\b`
 * written the other way round matches `Ref` inside `References` and captures
 * `erences` as the table name — a bug worth a regression test of its own, and
 * it has one below.
 *
 * `odkaz na` is Czech for "reference to"; schemas are commented in the
 * language of the team that wrote them, and dropping it would silently halve
 * the yield on exactly the schemas this was built for.
 */
const REF_WORD = String.raw`(?:references|referencing|reference|refers\s+to|ref|fk\s+to|fk|foreign\s+key\s+to|belongs\s+to|odkaz\s+na|odkaz|see|viz)`;

/** `schema.table.column`, `table.column`, `table(column)`, or bare `table`. */
const TARGET = String.raw`([A-Za-z_][\w$]*)(?:\s*\.\s*([A-Za-z_][\w$]*))?(?:\s*\(\s*([A-Za-z_][\w$]*)\s*\))?`;

const PATTERNS: RegExp[] = [
  // "References wapi_orders.order_id", "FK to orders(id)", "odkaz na orders.id"
  new RegExp(String.raw`\b${REF_WORD}\b[:\s]+` + TARGET, 'i'),
  // "-> orders.id" / "→ orders.id"
  new RegExp(String.raw`(?:->|→|=>)\s*` + TARGET, 'i'),
];

/**
 * Read a relationship out of one column comment, or `null`.
 *
 * Deliberately conservative. This feeds a feature that rewrites how the app
 * navigates a schema, so a wrong pair is worse than a missed one: a comment
 * that merely *mentions* another table is not a reference, and only the
 * explicit forms above count.
 */
export function parseSoftRef(
  table: string, column: string, comment: string | null | undefined,
): SoftRef | null {
  const text = (comment ?? '').trim();
  if (!text) return null;

  for (const re of PATTERNS) {
    const m = re.exec(text);
    if (!m) continue;
    const [, first, second, paren] = m;
    if (!first) continue;

    // Three shapes, resolved explicitly:
    //   orders(id)     → table + column
    //   orders.id      → table + column
    //   orders         → table only, column guessed later against the catalog
    const t = first;
    const c: string | null = paren ?? second ?? null;

    // A self-reference is almost always the comment describing this column,
    // not pointing at another table ("references the id of this table").
    if (t.toLowerCase() === table.toLowerCase() && !c) continue;

    return { fromTable: table, fromColumn: column, toTable: t, toColumn: c, evidence: text };
  }
  return null;
}

/** Every soft reference in a set of commented columns. */
export function findSoftRefs(
  columns: readonly { table: string; column: string; comment?: string | null }[],
): SoftRef[] {
  const out: SoftRef[] = [];
  for (const c of columns) {
    const ref = parseSoftRef(c.table, c.column, c.comment);
    if (ref) out.push(ref);
  }
  return out;
}

/**
 * Drop the ones that point at something that is not there.
 *
 * A comment naming a table that does not exist is itself worth reporting — the
 * `../review` rulebook has a whole finding for it, with a did-you-mean — but it
 * must not become a virtual FK, because navigating to a missing table is a
 * dead end the user cannot fix from here.
 */
export function resolveSoftRefs(
  refs: readonly SoftRef[],
  tables: ReadonlySet<string>,
  columnsOf: (table: string) => ReadonlySet<string>,
): { resolved: SoftRef[]; unresolved: Array<SoftRef & { why: string; didYouMean?: string }> } {
  const lower = new Map<string, string>();
  for (const t of tables) lower.set(t.toLowerCase(), t);

  const resolved: SoftRef[] = [];
  const unresolved: Array<SoftRef & { why: string; didYouMean?: string }> = [];

  for (const r of refs) {
    const actual = lower.get(r.toTable.toLowerCase());
    if (!actual) {
      unresolved.push({
        ...r,
        why: `no table named ${r.toTable} in this schema`,
        didYouMean: nearestName(r.toTable, [...tables]),
      });
      continue;
    }
    const cols = columnsOf(actual);
    if (r.toColumn) {
      const colActual = [...cols].find(c => c.toLowerCase() === r.toColumn!.toLowerCase());
      if (!colActual) {
        unresolved.push({ ...r, toTable: actual, why: `${actual} has no column ${r.toColumn}` });
        continue;
      }
      resolved.push({ ...r, toTable: actual, toColumn: colActual });
      continue;
    }
    // The comment named only a table. Guess its key rather than refusing: `id`
    // is right in the overwhelming majority, and the pair is offered for
    // approval, not applied silently.
    const guess = [...cols].find(c => c.toLowerCase() === 'id')
      ?? [...cols].find(c => c.toLowerCase() === `${actual.toLowerCase()}_id`)
      ?? null;
    if (!guess) {
      unresolved.push({ ...r, toTable: actual, why: `${actual} has no obvious key column` });
      continue;
    }
    resolved.push({ ...r, toTable: actual, toColumn: guess });
  }
  return { resolved, unresolved };
}

/** The commonest typo shape: a missing or extra plural. Cheap, and it is what
 *  the misses actually look like (`wapi_warehouse` → `wapi_warehouses`). */
export function nearestName(name: string, candidates: readonly string[]): string | undefined {
  const n = name.toLowerCase();
  const variants = [n + 's', n + 'es', n.replace(/s$/, ''), n.replace(/es$/, '')];
  return candidates.find(c => variants.includes(c.toLowerCase()));
}

/**
 * SQL for every commented column in a schema.
 *
 * Comments are catalog data, so this is as cheap as any other catalog read and
 * touches no user table.
 */
export function commentedColumnsSql(engine: string, schema: string): string {
  const lit = schema.replace(/'/g, "''");
  if (engine === 'sqlserver') {
    // SQL Server has no `column_comment`: a column's description is an
    // **extended property** named MS_Description, hanging off the column by
    // (object_id, column_id). The MySQL query below fails on the missing
    // column, so this feature simply produced nothing.
    return `SELECT t.name AS table_name, c.name AS column_name,
       CONVERT(nvarchar(4000), ep.value) AS column_comment
FROM sys.extended_properties ep
JOIN sys.tables t ON t.object_id = ep.major_id
JOIN sys.columns c ON c.object_id = ep.major_id AND c.column_id = ep.minor_id
JOIN sys.schemas s ON s.schema_id = t.schema_id
WHERE ep.class = 1 AND ep.minor_id > 0 AND ep.name = 'MS_Description'
  AND s.name = '${lit}' AND CONVERT(nvarchar(4000), ep.value) <> ''
ORDER BY t.name, c.column_id`;
  }
  if (engine === 'postgres') {
    return `SELECT c.relname AS table_name, a.attname AS column_name, d.description AS column_comment
FROM pg_description d
JOIN pg_class c ON c.oid = d.objoid
JOIN pg_namespace n ON n.oid = c.relnamespace
JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = d.objsubid
WHERE n.nspname = '${lit}' AND d.objsubid > 0 AND d.description <> ''
ORDER BY 1, 2`;
  }
  return `SELECT table_name, column_name, column_comment
FROM information_schema.columns
WHERE table_schema = '${lit}' AND column_comment <> ''
ORDER BY table_name, ordinal_position`;
}
