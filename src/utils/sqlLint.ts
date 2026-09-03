/**
 * Static SQL lint — offline checks that don't need a database.
 * Modeled on the findings a manual deep-dive produces (COUNT(col) NULL
 * semantics, DISTINCT(col) illusion, correlated subqueries, GROUP BY
 * determinism, materialize-then-count, non-sargable predicates…).
 */
import { sqlLiteral, RESERVED_WORDS, MYSQL_RESERVED_WINDOWS } from './sqlIdent.ts';
import { blank, findAliases } from './sqlAlias.ts';

export type Severity = 'red' | 'orange' | 'yellow' | 'info';

/**
 * Where a number in a finding came from.
 *
 * The single most important field on this page is `modelled`. A report that
 * mixes measured durations with model estimates and does not say which is
 * which will eventually be believed about the wrong one — and the estimate is
 * always the one that ends up in a change request. So every number that is
 * not a measurement says so, and every number that is says where it was read.
 */
export interface Evidence {
  /** What was read: `mysql.innodb_table_stats`, `EXPLAIN ANALYZE`, `pg_stats`. */
  source: string;
  /** The value(s), already formatted for a reader. */
  value: string;
  /** How stale the source is, when that changes what the value is worth. */
  age?: string;
  /** True when this is a model estimate rather than something measured. */
  modelled?: boolean;
}

export interface Finding {
  id: string;
  severity: Severity;
  title: string;
  detail: string;
  /** short quote from the query, when available */
  snippet?: string;

  // ── optional depth, rendered only at the higher detail levels ────────────
  // Every one of these is optional so that a rule which has nothing extra to
  // say costs nothing, and so that adding depth to one rule never touches
  // another. See utils/qualityReport.ts for which level shows what.

  /** The consequence — never a restatement of the title. Shown from `deep`. */
  why?: string;
  /** Runnable SQL, not prose. Shown from `standard`. */
  fix?: string;
  /** The values this was concluded from, each with its source. From `deep`. */
  evidence?: Evidence[];
  /** Citation into the rulebook, e.g. `rulebook §1 integers`. From `deep`. */
  ruleRef?: string;
  /** Where in the input, when the input has positions. Shown from `oneline`. */
  at?: { line: number; col?: number };
  /**
   * `certain` when the server itself answered (wire metadata, catalog);
   * `inferred` when a parser or a heuristic did. From `deep`.
   */
  confidence?: 'certain' | 'inferred';
  /** What acting — or not acting — costs. From `standard` when present. */
  cost?: { seconds?: number; blockedSeconds?: number; rows?: number; bytes?: number };
}

export const SEVERITY_ICON: Record<Severity, string> = {
  red: '🔴', orange: '🟠', yellow: '🟡', info: 'ℹ️',
};
export const SEVERITY_ORDER: Record<Severity, number> = {
  red: 0, orange: 1, yellow: 2, info: 3,
};

function snippetAt(sql: string, idx: number, len = 90): string {
  const start = Math.max(0, idx - 10);
  const s = sql.slice(start, start + len).replace(/\s+/g, ' ').trim();
  return s + (start + len < sql.length ? '…' : '');
}

const AGG_RE = /\b(count|sum|min|max|avg|group_concat|json_arrayagg|any_value|bit_and|bit_or|std|stddev|variance)\s*\($/;

export function lintSql(sql: string): Finding[] {
  const out: Finding[] = [];
  const b = blank(sql);
  const lower = b.toLowerCase();
  let n = 1;
  const push = (severity: Severity, title: string, detail: string, idx?: number) => {
    out.push({
      id: `L${n++}`,
      severity, title, detail,
      snippet: idx !== undefined ? snippetAt(sql, idx) : undefined,
    });
  };

  // ── COUNT(col) — NULL-dropping semantics ──
  {
    const re = /\bcount\s*\(\s*(?!\*)(?!distinct\b)([a-z_][\w.]*)\s*\)/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(b)) !== null) {
      push('orange', `COUNT(${m[1]}) counts non-NULL values only`,
        `If any branch/row can have NULL ${m[1]}, this silently under-counts. Use COUNT(*) for "how many rows", or confirm the NULL-drop is intended.`,
        m.index);
    }
  }

  // ── DISTINCT(col) illusion ──
  {
    const re = /\bdistinct\s*\(\s*[\w.`"]+\s*\)/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(b)) !== null) {
      push('orange', 'DISTINCT(col) applies to the whole row, not the column',
        'DISTINCT is a set quantifier, not a function — the parentheses are cosmetic. The deduplication grain is ALL selected columns; if you meant "distinct on this column", the result grain is accidental.',
        m.index);
    }
  }

  // ── materialize-then-count: COUNT over a derived UNION ──
  {
    const m = /\bselect\s+count\s*\([^)]*\)\s*from\s*\(/i.exec(b);
    if (m && /union\s+all|union\s/i.test(b.slice(m.index))) {
      push('red', 'COUNT over a derived UNION materializes every row first',
        'The whole UNION result (all columns, all expressions, all joins) is built into a temporary table just to count it. Replace with a sum of per-branch scalar COUNTs — each branch then only needs its key columns.',
        m.index);
    }
  }

  // ── correlated subqueries ──
  {
    const outer = findAliases(sql);
    const re = /\(\s*select\b/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(b)) !== null) {
      // find matching close paren
      let depth = 0, end = m.index;
      for (let i = m.index; i < b.length; i++) {
        if (b[i] === '(') depth++;
        else if (b[i] === ')') { depth--; if (depth === 0) { end = i; break; } }
      }
      const body = sql.slice(m.index + 1, end);
      const inner = findAliases(body);
      // outer aliases referenced inside but not defined inside → correlated
      const refs = new Set<string>();
      const refRe = /([a-z_][\w$]*)\s*\.\s*[a-z_]/gi;
      let r: RegExpExecArray | null;
      const bodyBlank = blank(body);
      while ((r = refRe.exec(bodyBlank)) !== null) refs.add(r[1].toLowerCase());
      const correlatedOn = [...refs].filter(a => outer.has(a) && !inner.has(a));
      if (correlatedOn.length > 0 && /\b(sum|count|min|max|avg)\s*\(/i.test(bodyBlank)) {
        push('red', `Correlated aggregate subquery (references outer ${correlatedOn.join(', ')})`,
          'Executed once per outer row. Pre-aggregate with GROUP BY and LEFT JOIN it once instead — and if the value feeds a column the consumer discards (e.g. under an outer COUNT), drop it from that path entirely.',
          m.index);
      } else if (correlatedOn.length > 0) {
        push('orange', `Correlated subquery (references outer ${correlatedOn.join(', ')})`,
          'Executed per outer row; verify the optimizer decorrelates it (check DEPENDENT SUBQUERY in EXPLAIN).',
          m.index);
      }
    }
  }

  // ── GROUP BY determinism: bare selected columns not in GROUP BY ──
  {
    const gbRe = /\bgroup\s+by\s+([^;)]+?)(?=\b(having|order|limit|union)\b|\)|;|$)/gi;
    let m: RegExpExecArray | null;
    let flagged = false;
    while (!flagged && (m = gbRe.exec(lower)) !== null) {
      const gbCols = new Set(
        m[1].split(',').map(s => s.trim().split(/\s/)[0].replace(/[`"]/g, '')).filter(Boolean)
      );
      // find the SELECT list that owns this GROUP BY: nearest preceding select
      const selIdx = lower.lastIndexOf('select', m.index);
      const fromIdx = lower.indexOf('from', selIdx);
      if (selIdx === -1 || fromIdx === -1 || fromIdx > m.index) continue;
      const selectList = b.slice(selIdx + 6, fromIdx);
      // bare columns: token.token or bare token not inside an aggregate call
      const colRe = /([a-z_][\w$]*(?:\.[a-z_][\w$]*)?)/gi;
      let c: RegExpExecArray | null;
      const bare: string[] = [];
      while ((c = colRe.exec(selectList)) !== null) {
        const tok = c[1];
        const before = selectList.slice(Math.max(0, c.index - 16), c.index).toLowerCase();
        if (AGG_RE.test(before + '(') || /\b(as|case|when|then|else|end|distinct|null|and|or|not|if|coalesce|concat|concat_ws|cast|convert|interval)\b/i.test(tok)) continue;
        // inside any function call? crude: preceding non-space char is '('? skip literals
        const clean = tok.replace(/[`"]/g, '');
        if (/^\d/.test(clean)) continue;
        if (!gbCols.has(clean) && !gbCols.has(clean.split('.').pop() ?? '')) {
          // check it's not within an aggregate: count parens between selIdx..c.index with agg
          const upto = selectList.slice(0, c.index);
          const opens = (upto.match(/\(/g) ?? []).length;
          const closes = (upto.match(/\)/g) ?? []).length;
          if (opens > closes) continue; // inside some function — likely aggregated/derived
          bare.push(clean);
        }
      }
      const uniq = [...new Set(bare)].slice(0, 6);
      if (uniq.length > 0) {
        flagged = true;
        push('orange', 'Non-aggregated columns under GROUP BY (nondeterministic)',
          `Columns selected without aggregation and absent from GROUP BY: ${uniq.join(', ')}. With ONLY_FULL_GROUP_BY off, MySQL returns an arbitrary row per group — counts and values can differ between runs. Aggregate them or add them to GROUP BY.`,
          selIdx);
      }
    }
  }

  // ── CREATE TABLE column named after a reserved word ──
  {
    const ctRe = /\bcreate\s+(?:temporary\s+)?table\b/gi;
    let ct: RegExpExecArray | null;
    while ((ct = ctRe.exec(b)) !== null) {
      // the column list opens at the first '(' — unless this is CREATE TABLE …
      // AS SELECT / LIKE, which has no column definitions to check
      const open = b.indexOf('(', ctRe.lastIndex);
      if (open === -1) continue;
      if (/\b(select|like)\b/i.test(b.slice(ctRe.lastIndex, open))) continue;
      let depth = 0, close = -1;
      for (let i = open; i < b.length; i++) {
        if (b[i] === '(') depth++;
        else if (b[i] === ')') { depth--; if (depth === 0) { close = i; break; } }
      }
      if (close === -1) continue;
      // split into definitions at top-level commas (varchar(…), enum(…) nest)
      let d = 0, start = open + 1;
      for (let i = open + 1; i <= close; i++) {
        const ch = b[i];
        if (ch === '(') d++;
        else if (ch === ')') d--;
        if ((ch === ',' && d === 0) || i === close) {
          // structure from the blanked copy, the name from the original —
          // blank() erases the contents of `quoted` identifiers
          const def = sql.slice(start, i);
          const m = /^\s*(?:`([^`]+)`|"([^"]+)"|([A-Za-z_]\w*))/.exec(def);
          start = i + 1;
          if (!m) continue;
          const name = m[1] ?? m[2] ?? m[3];
          // Table-constraint lines, not columns: a constraint introducer NOT
          // followed by a type (`KEY idx (c)`, `PRIMARY KEY (…)`) — a column
          // literally named `key` or `unique` is a column, and a finding.
          const rest = def.slice(m[0].length);
          if (/^(primary|unique|key|index|constraint|foreign|check|fulltext|spatial)$/i.test(name)
              && !/^\s*(?:(?:tiny|small|medium|big)?int|varchar|char|(?:tiny|medium|long)?text|datetime|timestamp|date|time|decimal|numeric|float|double|(?:tiny|medium|long)?blob|json|enum|set|bool(?:ean)?|bit|(?:var)?binary|serial|uuid|year|real)\b/i.test(rest)) continue;
          if (!RESERVED_WORDS.has(name.toLowerCase())) continue;
          // A windowed word is only reserved from some MySQL version — say
          // which, because this lint never sees the server version.
          const win = MYSQL_RESERVED_WINDOWS[name.toLowerCase()];
          const tag = win ? ` — reserved from MySQL ${win.since}${win.until ? ` to ${win.until}` : ''}` : '';
          if (m[3] === undefined) {
            push('yellow', `Column \`${name}\` is named after a reserved word${tag}`,
              'The quoting makes it legal, but every query, ORM mapping, view and dump/restore over this table must remember the quotes forever — and someone will forget. Rename the column while the table does not exist yet (delivery_date, order_status…).',
              ct.index);
          } else {
            push('orange', `Column name ${name} is a reserved word${tag}`,
              `Bare ${name} is a syntax error or a keyword with its own meaning (MySQL and PostgreSQL). It can be forced with quoting (\`${name}\`), but then every future query must remember the quotes — rename the column instead of reaching for backticks.`,
              ct.index);
          }
        }
      }
    }
  }

  // ── SELECT * ──
  {
    const re = /\bselect\s+\*/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(b)) !== null) {
      push('yellow', 'SELECT * — implicit column list',
        'Fetches every column (breaking covering indexes) and silently changes when the table does. List the needed columns.',
        m.index);
    }
  }

  // ── leading-wildcard LIKE ──
  {
    const re = /\blike\s+'%/gi;
    let m: RegExpExecArray | null;
    // run on the ORIGINAL sql (blank() erases string contents)
    while ((m = re.exec(sql)) !== null) {
      push('orange', "LIKE '%…' — leading wildcard cannot use an index",
        'A leading % forces a scan of every candidate row. Consider a fulltext/trigram index or restructuring the predicate.',
        m.index);
    }
  }

  // ── function wrapped around a column in a predicate (non-sargable) ──
  {
    const re = /\b(?:where|and|or|on)\s+(date|year|month|day|lower|upper|substr|substring|left|right|trim|cast|convert|coalesce|ifnull|date_format|from_unixtime)\s*\(\s*[a-z_][\w$]*\.?[\w$]*/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(b)) !== null) {
      push('orange', `Non-sargable predicate: ${m[1].toUpperCase()}() wraps a column`,
        'A function around the column prevents index range access. Rewrite the predicate so the bare column is compared against a computed constant/range.',
        m.index);
    }
  }

  // ── ORDER BY RAND / LIMIT huge offset ──
  if (/\border\s+by\s+rand\s*\(/i.test(b)) {
    push('orange', 'ORDER BY RAND() sorts the entire result',
      'Materializes and sorts every candidate row. Use an indexed random-pick strategy instead.');
  }
  {
    const m = /\blimit\s+(\d{5,})\s*,|\blimit\s+\d+\s+offset\s+(\d{5,})/i.exec(b);
    if (m) {
      push('yellow', `Large LIMIT offset (${m[1] ?? m[2]})`,
        'The server still reads and discards every skipped row. Use keyset (seek) pagination.',
        m.index);
    }
  }

  // ── UNION vs UNION ALL ──
  {
    const re = /\bunion\s+(?!all\b)select|\bunion\s*\(/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(b)) !== null) {
      push('yellow', 'UNION (without ALL) deduplicates via temp table',
        'If duplicates are impossible or acceptable, UNION ALL avoids the dedup pass.',
        m.index);
    }
  }

  // ── plan-stability warning signs (queries whose plan flips with parameters) ──
  {
    // OR across different columns
    const re = /\bwhere\b[\s\S]{0,400}?\bor\b/gi;
    const m = re.exec(b);
    if (m) {
      const seg = b.slice(m.index, m.index + 400);
      const cols = new Set([...seg.matchAll(/([a-z_][\w$]*(?:\.[a-z_][\w$]*)?)\s*(?:=|>|<|like|in\b)/gi)].map(x => x[1].toLowerCase()));
      if (cols.size >= 2 && /\bor\b/i.test(seg)) {
        push('yellow', 'OR across different columns — plan-stability risk',
          'The optimizer must choose between index_merge, one index + filter, or a scan; the choice flips with data distribution. Consider UNION ALL of single-predicate branches.',
          m.index);
      }
    }
  }
  {
    // large IN lists
    const re = /\bin\s*\(([^()]{40,})\)/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(b)) !== null) {
      const items = m[1].split(',').length;
      if (items >= 10) {
        push('yellow', `IN() with ${items} values — threshold-sensitive`,
          'Above eq_range_index_dive_limit MySQL switches from index dives to statistics, and estimates can jump. Watch the plan as this list grows; consider a join against a temp table.',
          m.index);
      }
    }
  }
  {
    // range predicate on a date/time-named column with a parameter/now()
    const re = /([a-z_][\w$]*\.)?((?:created|updated|deleted|expired|fetched|replenished|settled|finished)_at|[a-z_]*date[a-z_]*|[a-z_]*time[a-z_]*)\s*(?:>=?|<=?|between)\s*(\?|:{1}[a-z_]|now\s*\(|date_sub|curdate|current_)/gi;
    const m = re.exec(b);
    if (m) {
      push('info', 'Range predicate on a temporal column with a variable bound',
        'Plan quality depends on how much of the table the window covers — a plan tuned on a narrow window can collapse on a wide one. Verify with worst-case parameters (EXPLAIN ANALYZE below).',
        m.index);
    }
  }
  {
    // subquery in WHERE (IN/EXISTS)
    const re = /\bwhere\b[\s\S]{0,200}?\b(in|exists)\s*\(\s*select\b/gi;
    const m = re.exec(b);
    if (m) {
      push('yellow', `${m[1].toUpperCase()} (SELECT …) inside WHERE`,
        'Semi-join strategy (materialize / duplicate-weedout / first-match) is chosen by estimates and can flip between runs. Check EXPLAIN for the chosen strategy; a JOIN is often more stable.',
        m.index);
    }
  }

  // ── placeholders / no-WHERE info ──
  {
    const qMarks = countPositional(sql);
    if (qMarks > 0) {
      push('info', `${qMarks} positional placeholder${qMarks === 1 ? '' : 's'} (?)`,
        'Server-side analyses substitute the values you provide below; pick values representative of the WORST case (a popular key), not the average.');
    }
  }
  if (!/\bwhere\b/i.test(b) && /\bfrom\b/i.test(b) && !/\bjoin\b/i.test(b)) {
    push('yellow', 'No WHERE clause', 'Full-table read unless LIMITed — confirm that is intended.');
  }

  out.sort((a, b2) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b2.severity]);
  return out;
}

/** Count `?` placeholders outside strings/comments. */
export function countPositional(sql: string): number {
  return (blank(sql).match(/\?/g) ?? []).length;
}

/** Replace `?` placeholders left→right with the given values. */
export function substitutePositional(sql: string, values: string[], engine = 'mysql'): string {
  const b = blank(sql);
  let out = '';
  let last = 0;
  let vi = 0;
  for (let i = 0; i < b.length; i++) {
    if (b[i] === '?') {
      const v = (values[vi] ?? '').trim();
      vi++;
      const literal = v === '' ? 'NULL'
        : /^-?\d+(\.\d+)?$/.test(v) ? v
        : v.toUpperCase() === 'NULL' ? 'NULL'
        : sqlLiteral(v, engine);
      out += sql.slice(last, i) + literal;
      last = i + 1;
    }
  }
  out += sql.slice(last);
  return out;
}
