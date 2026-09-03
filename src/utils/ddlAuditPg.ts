/**
 * DDL deep-dive, PostgreSQL dialect: table-design audit over the CREATE TABLE
 * the backend assembles (db/postgres.rs `table_ddl`) or a pasted definition.
 *
 * The twin of ddlAudit.ts — deliberately NOT the MySQL D-rules re-parsed with
 * double quotes. The rules here are the ones that translate honestly or are
 * PG's own:
 *
 *  - ported unchanged in spirit: reserved-word names (D4, graded by PG's own
 *    "reserved" category), money in binary floats (D5), temporal data in text
 *    (D3), no PRIMARY KEY (D7 — different consequence, same name), FK columns
 *    without a supporting index (D15 — PG never auto-indexes the child side,
 *    which makes this MORE dangerous than on InnoDB), redundant prefix
 *    indexes (D16), pervasive nullable columns (D18);
 *  - PG's own: `timestamp without time zone` (D20 — THE classic PG finding),
 *    `serial`/nextval instead of identity (D21), the `money` type (D22),
 *    blank-padded `char(n)` (D23);
 *  - deliberately absent: the InnoDB rules — unsigned ids, ENGINE=, CHARSET=,
 *    prefix indexes on TEXT, wide-PK secondary-index bloat, 2038 ceilings.
 *    None of those mechanisms exist here, and a finding that invents them is
 *    the confident-wrong advice this audit exists to prevent.
 *
 * Pure and dependency-free — driven by node --test (tests/ddlAuditPg.test.ts).
 */
import type { Finding } from './sqlLint';
import { RESERVED_WORDS, PG_RESERVED_WORDS } from './sqlIdent.ts';

interface Col { name: string; type: string; line: string }

/** Lines that introduce a table constraint, never a column. */
const CONSTRAINT_LINE = /^\s*(?:CONSTRAINT\s+(?:"[^"]+"|\w+)\s+)?(?:PRIMARY\s+KEY|FOREIGN\s+KEY|UNIQUE\b|CHECK\b|EXCLUDE\b|LIKE\b)/i;

/** Where a column's type ends and its attributes begin. */
const TYPE_END = /\s+(?:NOT\s+NULL|NULL|DEFAULT\b|PRIMARY\s+KEY|REFERENCES\b|UNIQUE\b|CHECK\b|COLLATE\b|GENERATED\b|CONSTRAINT\b)\b/i;

const MONEY_NAME = /(price|cost|amount|total|sum|fee|balance|salary|revenue|discount|vat|tax)/i;

/** The text between the CREATE TABLE's outer parens (nested parens balanced). */
function tableBody(ddl: string): string {
  const m = /create\s+table\s/i.exec(ddl);
  if (!m) return '';
  const open = ddl.indexOf('(', m.index);
  if (open < 0) return '';
  let depth = 0;
  for (let i = open; i < ddl.length; i++) {
    if (ddl[i] === '(') depth++;
    else if (ddl[i] === ')') {
      depth--;
      if (depth === 0) return ddl.slice(open + 1, i);
    }
  }
  return ddl.slice(open + 1);
}

/** Split a table body at top-level commas — type parens hold their own. */
function topLevelSplit(body: string): string[] {
  const parts: string[] = [];
  let depth = 0, cur = '';
  for (const ch of body) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; }
    else cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  return parts;
}

/** Parse an index column list into plain column names; expressions are dropped. */
function indexCols(list: string): string[] {
  return list.split(',')
    .map(c => {
      const t = c.trim().replace(/\s+(?:ASC|DESC|NULLS\s+(?:FIRST|LAST))$/i, '');
      const m = /^"([^"]+)"$/.exec(t) ?? /^([A-Za-z_]\w*)$/.exec(t);
      return (m?.[1] ?? m?.[2] ?? '').toLowerCase();
    })
    .filter(Boolean);
}

export function auditPgDdl(table: string, ddl: string): Finding[] {
  const f: Finding[] = [];
  const push = (id: string, severity: Finding['severity'], title: string, detail: string) =>
    f.push({ id, severity, title: `${table}: ${title}`, detail });

  // ── columns ────────────────────────────────────────────────────────────
  const cols: Col[] = [];
  for (const part of topLevelSplit(tableBody(ddl))) {
    if (CONSTRAINT_LINE.test(part)) continue;
    const m = /^\s*(?:"([^"]+)"|([A-Za-z_]\w*))\s+(\S[\s\S]*?)\s*$/.exec(part);
    if (!m) continue;
    const rest = m[3];
    const typeMatch = TYPE_END.exec(rest);
    const type = (typeMatch ? rest.slice(0, typeMatch.index) : rest).trim().toLowerCase();
    if (!type) continue;
    cols.push({ name: m[1] ?? m[2], type, line: part.trim().replace(/\s+/g, ' ') });
  }
  if (cols.length === 0) {
    push('D0', 'orange', 'DDL parser matched no columns',
      'The design audit could not parse this definition — findings below are incomplete. (Report this DDL shape so the parser learns it.)');
  }

  for (const c of cols) {
    const n = c.name.toLowerCase();

    // keyword / reserved-word identifiers — graded by PG's own strictness:
    // the manual's "reserved" category is the orange case; a word reserved
    // only on MySQL (or a weaker PG category) is the yellow cross-engine one.
    if (PG_RESERVED_WORDS.has(n)) {
      push('D4', 'orange', `column name "${c.name}" is a reserved word in PostgreSQL`,
        'Works only while everyone remembers the double quotes (and the exact case — unquoted names fold to lower case). ORMs, dumps and hand-written queries regularly break on it. Prefer a domain name: "delivery_date", "order_status"…');
    } else if (RESERVED_WORDS.has(n)) {
      push('D4', 'yellow', `column name "${c.name}" is reserved on MySQL (legal bare here)`,
        'PostgreSQL accepts it unquoted, but it collides with the MySQL ∪ PG reserved set — a cross-engine migration or federation tool breaks on the name. A domain name survives both engines.');
    }

    // THE classic: timestamp without time zone.
    if (c.type === 'timestamp' || c.type === 'timestamp without time zone') {
      push('D20', 'yellow', `"${c.name}" is timestamp without time zone`,
        'The stored value is a wall clock with no zone — what instant it means depends on the TimeZone of whoever reads it, and a DST fold makes some wall clocks ambiguous. Unless the column genuinely holds a local civil time (a shop\'s opening hours), the type you want is timestamptz. Fix: ALTER COLUMN … TYPE timestamptz USING … AT TIME ZONE \'UTC\'.');
    }

    // serial / nextval → identity (SQL-standard, PG 10+).
    if (/^(bigserial|serial8|serial4|serial|smallserial|serial2)\b/.test(c.type) || /nextval\(/i.test(c.line)) {
      push('D21', 'yellow', `"${c.name}" uses serial/nextval instead of an identity column`,
        'serial is a macro over a hidden sequence: owned implicitly, granted separately (INSERT privilege is not enough — the sequence needs USAGE), invisible to the SQL standard. GENERATED … AS IDENTITY ties the sequence to the column: it follows RENAME, drops with the column, and needs no separate grant. Use identity for anything new; migrate this one when it is next touched.');
    }

    // the money type — locale-shaped output, fixed locale scale.
    if (c.type === 'money') {
      push('D22', 'orange', `"${c.name}" uses the money type`,
        'money parses and prints through lc_monetary and takes its scale from the locale — the same value dumps and restores differently across environments. Fix: numeric(14,2) (explicit scale, locale-independent text).');
    }

    // blank-padded char(n).
    if (/^(?:character|char|bpchar)\(\d+\)$/.test(c.type)) {
      push('D23', 'yellow', `"${c.name}" is ${c.type} — blank-padded`,
        'char(n) pads every value to the declared width and compares ignoring trailing blanks, so \'AB\' equals \'AB  \' and LIKE patterns surprise. Almost always varchar(n)/text was meant.');
    }

    // money-like data in a binary float.
    if (/^(?:real|double precision|float(?:\(\d+\))?)$/.test(c.type) && MONEY_NAME.test(n)) {
      push('D5', 'red', `"${c.name}" ${c.type} for money`,
        'Binary floats cannot represent 0.10 exactly — sums drift and comparisons fail unpredictably, silently. Fix: numeric(14,2).');
    }

    // temporal data in text.
    if (/^(?:text|character varying|varchar)(?:\(\d+\))?$/.test(c.type) && /date|time|day/.test(n)) {
      push('D3', 'red', `"${c.name}" ${c.type} holds date-like data`,
        'Dates in text: no validation, string comparison order only works for ISO format, no date arithmetic, no BRIN/btree range semantics the planner understands. Fix: date/timestamptz with an explicit USING cast.');
    }
  }

  // ── keys and indexes ─────────────────────────────────────────────────────
  interface Idx { name: string; cols: string[]; unique: boolean }
  const indexes: Idx[] = [];
  // constraint forms: PRIMARY KEY (…), UNIQUE (…)
  for (const m of ddl.matchAll(/(PRIMARY\s+KEY|UNIQUE)\s*(?:\([^)]*\))?\s*\(([^)]+)\)/gi)) {
    const cols2 = indexCols(m[2]);
    if (cols2.length) indexes.push({
      name: m[1].toUpperCase().replace(/\s+/g, ' '),
      cols: cols2,
      unique: true,
    });
  }
  // inline forms: "id integer PRIMARY KEY" / "code text UNIQUE"
  for (const c of cols) {
    if (/\bPRIMARY\s+KEY\b/i.test(c.line)) indexes.push({ name: 'PRIMARY KEY', cols: [c.name.toLowerCase()], unique: true });
    else if (/\bUNIQUE\b/i.test(c.line)) indexes.push({ name: 'UNIQUE', cols: [c.name.toLowerCase()], unique: true });
  }
  // CREATE INDEX statements following the table definition.
  for (const m of ddl.matchAll(/CREATE\s+(UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"([^"]+)"|(\w+))\s+ON\s+(?:ONLY\s+)?(?:"?[\w$]+"?\s*\.\s*)?"?[\w$]+"?\s*(?:USING\s+\w+\s*)?\(([^;]+)\)/gi)) {
    const cols2 = indexCols(m[4]);
    if (cols2.length) indexes.push({ name: m[2] ?? m[3] ?? '(unnamed)', cols: cols2, unique: !!m[1] });
  }

  // FK columns lacking a supporting (leftmost) index. InnoDB requires and
  // auto-creates one; PostgreSQL creates NOTHING — every parent DELETE or key
  // UPDATE probes the child with a sequential scan while holding locks.
  const fkCols: string[][] = [];
  for (const m of ddl.matchAll(/FOREIGN\s+KEY\s*\(([^)]+)\)/gi)) {
    const cols2 = indexCols(m[1]);
    if (cols2.length) fkCols.push(cols2);
  }
  for (const c of cols) {
    if (/\bREFERENCES\b/i.test(c.line)) fkCols.push([c.name.toLowerCase()]);
  }
  for (const fkc of fkCols) {
    const supported = indexes.some(ix =>
      ix.cols.length >= fkc.length && fkc.every((c, i) => ix.cols[i] === c));
    if (!supported) {
      push('D15', 'orange', `FK column${fkc.length > 1 ? 's' : ''} (${fkc.join(', ')}) ha${fkc.length > 1 ? 've' : 's'} no leading index`,
        'PostgreSQL does not index the child side of a foreign key. Every DELETE or key UPDATE on the parent probes this table with a sequential scan while holding locks on it — the classic "deleting one customer locks the database" incident. Fix: CREATE INDEX ON … (' + fkc.join(', ') + ').');
    }
  }

  // redundant index: one index is a leftmost prefix of another.
  for (let a = 0; a < indexes.length; a++) {
    for (let b = 0; b < indexes.length; b++) {
      if (a === b) continue;
      const short = indexes[a], long = indexes[b];
      // A UNIQUE index is a constraint, not only an access path, so it is
      // never redundant even when its columns are a prefix.
      if (short.unique) continue;
      if (short.cols.length < long.cols.length
          && short.cols.every((c, k) => long.cols[k] === c)) {
        push('D16', 'yellow', `redundant index "${short.name}" (${short.cols.join(', ')})`,
          `It is a leftmost prefix of "${long.name}" (${long.cols.join(', ')}), which already serves the same lookups. Every write maintains both — drop the shorter one unless it is UNIQUE (a constraint, not just an access path).`);
        break;
      }
    }
  }

  if (!/PRIMARY\s+KEY/i.test(ddl)) {
    push('D7', 'red', 'no PRIMARY KEY',
      'No REPLICA IDENTITY for logical replication (UPDATE/DELETE cannot be decoded without REPLICA IDENTITY FULL), no row can be addressed or deduplicated, no ON CONFLICT target. Add a real PK.');
  }

  // nullable-heavy: many columns with no NOT NULL and no explicit default.
  const nullable = cols.filter(c => !/not\s+null/i.test(c.line));
  if (cols.length >= 5 && nullable.length >= Math.ceil(cols.length * 0.7)) {
    push('D18', 'yellow', `${nullable.length}/${cols.length} columns are nullable`,
      'Pervasive NULLs push validation into every query (IS NULL / COALESCE), complicate indexes (a btree skips all-NULL rows), and often signal missing NOT NULL + DEFAULT. Tighten the columns that are genuinely required.');
  }

  return f;
}
