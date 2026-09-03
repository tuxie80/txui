/**
 * Splitting `CREATE TABLE` into a load-shaped table and the rest.
 *
 * Loading rows into a table that already carries its secondary indexes makes
 * the server maintain every B-tree per row, as random I/O. Loading into a
 * PK-only table and building the indexes afterwards makes it one sorted pass
 * per index. Measured on MySQL 8.0.46, 598,689 rows, four secondary indexes:
 *
 *   with indexes present   3,454 ms
 *   PK-only load           1,290 ms   +  one combined ADD KEY  778 ms
 *                          ──────────────────────────────────────────
 *                          2,068 ms total — **1.67× faster**
 *
 * …and that is the *best case for the indexed version*: a server-local
 * `INSERT … SELECT` with no network and no batching. Over a wire it is worse.
 *
 * **The primary key is not deferred.** InnoDB clusters the table on it, so
 * adding it afterwards rewrites everything — measured at 544 ms on the same
 * data, wiping out much of the gain. The keyset chunker already delivers rows
 * in PK order, which is exactly what a clustered index wants.
 *
 * So the split is:
 *
 *   ┌ load table ──────────┐  ┌ deferred ─────────────────────────────┐
 *   │ columns              │  │ secondary KEY / UNIQUE KEY            │
 *   │ PRIMARY KEY          │  │ FULLTEXT / SPATIAL KEY                │
 *   │ table options        │  │ FOREIGN KEY (also breaks FK cycles)   │
 *   └──────────────────────┘  │ CHECK constraints                     │
 *                             │ AUTO_INCREMENT = n                    │
 *                             └───────────────────────────────────────┘
 *
 * Parsing `SHOW CREATE TABLE` rather than rebuilding from `information_schema`
 * is deliberate: the server's own rendering is authoritative, and every
 * reconstruction is a chance to differ from it. The parser below is therefore
 * conservative — it moves whole lines it recognises and leaves anything it does
 * not understand in the load table, where the worst case is a slower load
 * rather than a wrong one.
 *
 * Pure and dependency-free — driven by `node --test`.
 */

export type DeferredKind =
  | 'index' | 'unique' | 'fulltext' | 'spatial' | 'foreign-key' | 'check';

export interface DeferredClause {
  kind: DeferredKind;
  /** Constraint or index name, when it has one. */
  name: string | null;
  /** The clause as it appeared, without the trailing comma. */
  text: string;
}

export interface SplitTable {
  /** `CREATE TABLE` with columns, PK and table options only. */
  createSql: string;
  /** Everything held back until the data has landed. */
  deferred: DeferredClause[];
  /** `AUTO_INCREMENT=n` lifted out of the table options, if present. */
  autoIncrement: number | null;
  /** Columns the server computes — never in an INSERT column list. */
  generatedColumns: string[];
  /** Column names in declared order, generated ones excluded. */
  loadColumns: string[];
}

/** Statements that rebuild the table's shape after a load. */
export interface RebuildPlan {
  /** One combined ALTER — InnoDB makes a single pass for a combined add. */
  indexSql: string | null;
  /** FKs added separately: they can reference tables loaded later. */
  foreignKeySql: string | null;
  /** CHECKs last — a violation here is a DATA finding, not a schema one. */
  checkSql: string | null;
  /** Restores the counter the load reset. */
  autoIncrementSql: string | null;
}

const IDENT = '`((?:[^`]|``)*)`';

/**
 * Split the body of a `CREATE TABLE` into its top-level clauses.
 *
 * Not a line splitter and not a naive comma split: a clause can contain commas
 * inside parentheses (`KEY x (a,b)`), inside string literals
 * (`DEFAULT 'a,b'`) and inside backticked identifiers. All three occur in the
 * fixture this was built against.
 */
export function splitClauses(body: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  let quote: string | null = null;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (quote) {
      cur += c;
      if (c === '\\' && quote !== '`') { cur += body[++i] ?? ''; continue; }
      if (c === quote) {
        // A doubled quote is an escaped one, not a terminator.
        if (body[i + 1] === quote) { cur += body[++i]; } else { quote = null; }
      }
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { quote = c; cur += c; continue; }
    if (c === '(') { depth++; cur += c; continue; }
    if (c === ')') { depth--; cur += c; continue; }
    if (c === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** Classify one top-level clause. `null` = it belongs in the load table. */
export function classifyClause(clause: string): DeferredClause | null {
  const c = clause.trim();
  const named = (re: RegExp): string | null => {
    const m = re.exec(c);
    return m ? (m[1] ?? '').replace(/``/g, '`') : null;
  };

  // PRIMARY KEY stays — InnoDB clusters on it. Checked first because
  // "PRIMARY KEY" also matches the generic KEY pattern.
  if (/^PRIMARY\s+KEY\b/i.test(c)) return null;

  if (/^CONSTRAINT\s+.*\s+FOREIGN\s+KEY\b/i.test(c) || /^FOREIGN\s+KEY\b/i.test(c)) {
    return { kind: 'foreign-key', name: named(new RegExp(`^CONSTRAINT\\s+${IDENT}`, 'i')), text: c };
  }
  if (/^CONSTRAINT\s+.*\s+CHECK\b/i.test(c) || /^CHECK\s*\(/i.test(c)) {
    return { kind: 'check', name: named(new RegExp(`^CONSTRAINT\\s+${IDENT}`, 'i')), text: c };
  }
  if (/^FULLTEXT\s+(KEY|INDEX)\b/i.test(c)) {
    return { kind: 'fulltext', name: named(new RegExp(`^FULLTEXT\\s+(?:KEY|INDEX)\\s+${IDENT}`, 'i')), text: c };
  }
  if (/^SPATIAL\s+(KEY|INDEX)\b/i.test(c)) {
    return { kind: 'spatial', name: named(new RegExp(`^SPATIAL\\s+(?:KEY|INDEX)\\s+${IDENT}`, 'i')), text: c };
  }
  if (/^UNIQUE\s+(KEY|INDEX)\b/i.test(c)) {
    return { kind: 'unique', name: named(new RegExp(`^UNIQUE\\s+(?:KEY|INDEX)\\s+${IDENT}`, 'i')), text: c };
  }
  if (/^(KEY|INDEX)\s/i.test(c)) {
    return { kind: 'index', name: named(new RegExp(`^(?:KEY|INDEX)\\s+${IDENT}`, 'i')), text: c };
  }
  // A column definition, or something unrecognised. Either way it stays — the
  // cost of being wrong here is a slower load, not a broken one.
  return null;
}

/** Is this clause a generated column? Those can never be inserted into. */
export function generatedColumnName(clause: string): string | null {
  const m = new RegExp(`^${IDENT}\\s`).exec(clause.trim());
  if (!m) return null;
  return /\bGENERATED\s+ALWAYS\s+AS\b/i.test(clause) || /\bAS\s*\(/i.test(clause)
    ? m[1].replace(/``/g, '`')
    : null;
}

/** A plain column's name, or null when the clause is not a column. */
export function columnName(clause: string): string | null {
  const m = new RegExp(`^${IDENT}\\s`).exec(clause.trim());
  if (!m) return null;
  // Everything that starts with an identifier and is not a key/constraint.
  return classifyClause(clause) === null && !/^(PRIMARY|UNIQUE|FULLTEXT|SPATIAL|KEY|INDEX|CONSTRAINT|CHECK|FOREIGN)\b/i.test(clause.trim())
    ? m[1].replace(/``/g, '`')
    : null;
}

/**
 * Split a `SHOW CREATE TABLE` result into a load table plus deferred clauses.
 *
 * `AUTO_INCREMENT=n` is lifted out of the table options because a load resets
 * the counter; it is restored afterwards. Losing it is not cosmetic — a table
 * whose rows were deleted has a counter ahead of its data, and a copy that
 * forgets it hands out primary keys that already existed.
 */
export function splitCreateTable(createSql: string): SplitTable {
  const openIdx = createSql.indexOf('(');
  const closeIdx = createSql.lastIndexOf(')');
  if (openIdx < 0 || closeIdx < openIdx) {
    // Not something we recognise — hand it back whole rather than mangling it.
    return {
      createSql, deferred: [], autoIncrement: null,
      generatedColumns: [], loadColumns: [],
    };
  }

  const head = createSql.slice(0, openIdx).trimEnd();
  const body = createSql.slice(openIdx + 1, closeIdx);
  let tail = createSql.slice(closeIdx + 1);

  const clauses = splitClauses(body);
  const kept: string[] = [];
  const deferred: DeferredClause[] = [];
  const generatedColumns: string[] = [];
  const loadColumns: string[] = [];

  for (const clause of clauses) {
    const d = classifyClause(clause);
    if (d) { deferred.push(d); continue; }
    kept.push(clause);
    const gen = generatedColumnName(clause);
    if (gen) { generatedColumns.push(gen); continue; }
    const col = columnName(clause);
    if (col) loadColumns.push(col);
  }

  // Lift AUTO_INCREMENT=n out of the table options — but only where it is an
  // option, not where it appears inside a string. A table commented
  // `COMMENT='reset AUTO_INCREMENT=5 nightly'` would otherwise lose that text
  // AND have a fabricated counter applied to it.
  const lifted = liftAutoIncrement(tail);
  const autoIncrement = lifted.value;
  tail = lifted.rest;

  const indent = '  ';
  const rebuilt = `${head} (\n${kept.map(c => indent + c).join(',\n')}\n)${tail.trimEnd()}`;

  return { createSql: rebuilt, deferred, autoIncrement, generatedColumns, loadColumns };
}

const q = (name: string) => '`' + name.replace(/`/g, '``') + '`';

/**
 * Pull `AUTO_INCREMENT = n` out of a table's option list, ignoring any that
 * sits inside a quoted string.
 *
 * A regex over the whole tail cannot tell an option from the contents of a
 * `COMMENT`, and getting it wrong corrupts the comment and invents a counter.
 */
export function liftAutoIncrement(tail: string): { value: number | null; rest: string } {
  let out = '';
  let quote: string | null = null;
  let value: number | null = null;
  let i = 0;
  while (i < tail.length) {
    const c = tail[i];
    if (quote) {
      out += c;
      if (c === '\\') { out += tail[++i] ?? ''; i++; continue; }
      if (c === quote) {
        if (tail[i + 1] === quote) { out += tail[++i]; } else { quote = null; }
      }
      i++;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { quote = c; out += c; i++; continue; }
    if (value === null) {
      const m = /^\s*AUTO_INCREMENT\s*=\s*(\d+)/i.exec(tail.slice(i));
      if (m) { value = Number(m[1]); i += m[0].length; continue; }
    }
    out += c;
    i++;
  }
  return { value, rest: out };
}

/**
 * The statements that put back what the split held out.
 *
 * Indexes go in **one** `ALTER`: InnoDB makes a single pass over the table for
 * a combined add and one pass per statement otherwise. Measured — four indexes
 * in one `ALTER` took 778 ms against a 1,290 ms load.
 *
 * Foreign keys are separate because they can reference a table that has not
 * been loaded yet, so the whole set is applied only once every table is in.
 * Checks are last: a `CHECK` that fails is a statement about the *data*, and
 * reporting it as a schema failure would send someone to the wrong place.
 *
 * `FULLTEXT` indexes are emitted one per statement — InnoDB permits only one
 * to be added per `ALTER`, so batching them is a runtime error.
 */
export function rebuildPlan(schema: string, table: string, split: SplitTable): RebuildPlan {
  const target = `${q(schema)}.${q(table)}`;

  const indexish = split.deferred.filter(
    d => d.kind === 'index' || d.kind === 'unique' || d.kind === 'spatial');
  const fulltext = split.deferred.filter(d => d.kind === 'fulltext');
  const fks = split.deferred.filter(d => d.kind === 'foreign-key');
  const checks = split.deferred.filter(d => d.kind === 'check');

  const stmts: string[] = [];
  if (indexish.length > 0) {
    stmts.push(`ALTER TABLE ${target}\n  ${indexish.map(d => `ADD ${d.text}`).join(',\n  ')}`);
  }
  // One statement each — InnoDB rejects two FULLTEXT adds in one ALTER.
  for (const f of fulltext) stmts.push(`ALTER TABLE ${target} ADD ${f.text}`);

  return {
    indexSql: stmts.length > 0 ? stmts.join(';\n') : null,
    foreignKeySql: fks.length > 0
      ? `ALTER TABLE ${target}\n  ${fks.map(d => `ADD ${d.text}`).join(',\n  ')}`
      : null,
    checkSql: checks.length > 0
      ? `ALTER TABLE ${target}\n  ${checks.map(d => `ADD ${d.text}`).join(',\n  ')}`
      : null,
    autoIncrementSql: split.autoIncrement !== null
      ? `ALTER TABLE ${target} AUTO_INCREMENT = ${split.autoIncrement}`
      : null,
  };
}

/**
 * The `INSERT` / `LOAD DATA` column list.
 *
 * Generated columns are excluded because inserting into one is an error, not a
 * silent no-op — and `SELECT *` on the source would return them, so the read
 * side has to use this list too. Invisible columns (8.0.23+) are the mirror
 * hazard: they are absent from `SELECT *`, which is the other reason the column
 * list is always explicit and never a star.
 */
export function loadColumnList(split: SplitTable): string {
  return split.loadColumns.map(q).join(', ');
}
