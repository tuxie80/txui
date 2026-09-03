/**
 * DDL deep-dive: MySQL 8.0/8.4 table-design audit over SHOW CREATE TABLE.
 * Pattern catalog distilled from the ../schema analyzer (99 patterns) and
 * classic design rules — each finding says WHY and gives the fix direction.
 */
import type { Finding } from './sqlLint';
import { RESERVED_WORDS, MYSQL_RESERVED_WINDOWS } from './sqlIdent.ts';

interface Col { name: string; type: string; line: string }

export function auditDdl(table: string, ddl: string): Finding[] {
  const f: Finding[] = [];
  const push = (id: string, severity: Finding['severity'], title: string, detail: string) =>
    f.push({ id, severity, title: `${table}: ${title}`, detail });

  const cols: Col[] = [];
  // identifiers may be backticked or bare — parse both (a bare-DDL paste must
  // never yield a silent "no findings")
  for (const m of ddl.matchAll(/^\s*(?:`([^`]+)`|([A-Za-z_]\w*))\s+((?:tiny|small|medium|big)?int(?:\([^)]*\))?(?:\s+unsigned)?|varchar\([^)]*\)|(?:tiny|medium|long)?text|decimal\([^)]*\)|float(?:\([^)]*\))?|double(?:\([^)]*\))?|date(?:time)?(?:\(\d\))?|timestamp(?:\(\d\))?|char\([^)]*\)|json|enum\([^)]*\)|boolean|blob)(.*)$/gim)) {
    const name = m[1] ?? m[2];
    // no constraint-line filter needed: the regex only matches when a column
    // TYPE follows the name, so a "column" named `key`/`unique` is genuine —
    // and exactly what the D4 reserved-word rule exists to catch
    cols.push({ name, type: m[3].toLowerCase(), line: m[0].trim() });
  }
  if (cols.length === 0) {
    push('D0', 'orange', 'DDL parser matched no columns',
      'The design audit could not parse this definition — findings below are incomplete. (Report this DDL shape so the parser learns it.)');
  }

  for (const c of cols) {
    const n = c.name.toLowerCase();
    // signed INT ids — half the range wasted, negative ids are meaningless
    if (/^(?:big|medium|small)?int(?:\(\d+\))?$/.test(c.type) && !c.type.includes('unsigned')
        && (n === 'id' || n.endsWith('_id'))) {
      push('D1', 'yellow', `\`${c.name}\` is signed ${c.type.toUpperCase()}`,
        `Ids are never negative — UNSIGNED doubles the usable range (INT: 2.1B → 4.3B) for free. Fix: MODIFY \`${c.name}\` ${c.type.toUpperCase().replace(/\(\d+\)/, '')} UNSIGNED${c.line.includes('NOT NULL') ? ' NOT NULL' : ''}. Plan it before the ceiling, not after (see AUTO_INCREMENT check).`);
    }
    // unix timestamps in signed INT → Y2038 + unreadable + no date arithmetic
    if (/^int(?:\(\d+\))?$/.test(c.type) && !c.type.includes('unsigned')
        && /(_till|_at|_from|_until|departure|arrival)$/.test(n)) {
      push('D2', 'orange', `\`${c.name}\` stores a unix timestamp in signed INT`,
        `Signed INT unix time overflows on 2038-01-19 (Y2038), is unreadable in queries, blocks date functions and partition pruning. Fix: TIMESTAMP (UTC, auto-conversion) or DATETIME; during migration INT UNSIGNED buys time but keeps the readability cost.`);
    }
    // temporal data in TEXT/VARCHAR
    if (/^(?:tiny|medium|long)?text$/.test(c.type) && /date|time|day/.test(n)) {
      push('D3', 'red', `\`${c.name}\` ${c.type.toUpperCase()} holds date-like data`,
        `Dates in TEXT: no validation, string comparison order only works for ISO format, 3–10× wider than DATE(3 bytes)/DATETIME(5), and TEXT can't be fully indexed (see prefix-index finding). Fix: DATE/DATETIME + STR_TO_DATE migration.`);
    }
    // keyword / reserved-word identifiers (full MySQL ∪ PostgreSQL reserved set)
    if (RESERVED_WORDS.has(n)) {
      const win = MYSQL_RESERVED_WINDOWS[n];
      push('D4', 'yellow', `column name \`${c.name}\` is a reserved SQL word`,
        `Works only while everyone remembers the backticks — ORMs, replication tooling and hand-written queries regularly break on it (\`rank\` is fully reserved since 8.0). Prefer a domain name: \`delivery_date\`, \`order_status\`…`
        + (win ? ` (Reserved from MySQL ${win.since}${win.until ? `, non-reserved again from ${win.until}` : ''}.)` : ''));
    }
    // money in floats
    if (/^(float|double)/.test(c.type) && /(price|amount|cost|total|fee)/.test(n)) {
      push('D5', 'red', `\`${c.name}\` ${c.type.toUpperCase()} for money`,
        `Binary floats can't represent 0.1 exactly — rounding errors accumulate. Fix: DECIMAL(12,2) (exact, still fast).`);
    }
  }

  // prefix index on TEXT columns
  for (const m of ddl.matchAll(/KEY\s+`([^`]+)`\s*\(([^)]*`([^`]+)`\((\d+)\)[^)]*)\)/gi)) {
    const col = cols.find(c => c.name === m[3]);
    if (col && /text/.test(col.type)) {
      push('D6', 'red', `prefix index \`${m[1]}\` on TEXT column \`${m[3]}\`(${m[4]})`,
        `A ${m[4]}-char prefix over TEXT: can never be covering, unusable for ORDER BY/GROUP BY, and every comparison still touches the row. With date-like content the real fix is a typed column; otherwise VARCHAR(n) fully indexed, or a generated column + index. Composite keys ending in a TEXT prefix (as in \`${m[2].trim()}\`) inherit all of it.`);
    }
  }

  if (!/PRIMARY KEY/i.test(ddl)) {
    push('D7', 'red', 'no PRIMARY KEY',
      'InnoDB builds a hidden 6-byte key; row-based replication degrades to full-table scans per changed row, and 8.0.30+ GIPK exists precisely because this hurts. Add a real PK.');
  }
  const cs = /DEFAULT CHARSET=(\w+)/i.exec(ddl)?.[1]?.toLowerCase();
  if (cs === 'utf8' || cs === 'utf8mb3') {
    push('D8', 'orange', `legacy charset ${cs}`,
      'utf8mb3 (3-byte "utf8") is deprecated in 8.0 and on the removal path — no emoji/4-byte chars, and mixing with utf8mb4 tables causes index-killing collation coercion in joins. Migrate: CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci.');
  }
  const eng = /ENGINE=(\w+)/i.exec(ddl)?.[1];
  if (eng && eng.toLowerCase() !== 'innodb') {
    push('D9', 'red', `ENGINE=${eng}`, 'Non-InnoDB: no row locks / MVCC / crash recovery; MyISAM is effectively frozen. Convert to InnoDB.');
  }
  const ssp = /STATS_SAMPLE_PAGES=(\d+)/i.exec(ddl)?.[1];
  if (ssp && Number(ssp) > 500) {
    push('D10', 'yellow', `STATS_SAMPLE_PAGES=${ssp}`,
      `Every implicit/explicit ANALYZE reads ${ssp} pages per index — heavier DDL/stats maintenance. Fine if set deliberately for estimate stability (large skewed table); otherwise the 8.0 default (20) + histograms (ANALYZE TABLE … UPDATE HISTOGRAM) is cheaper and smarter.`);
  }
  // explicit charset missing → inherits the database default (utf8mb3 on legacy DBs)
  if (!/CHARSET=|CHARACTER SET/i.test(ddl)) {
    push('D11', 'yellow', 'no explicit CHARSET/COLLATE',
      'The table inherits the database default — on legacy schemas that is still utf8mb3, and cross-charset joins kill index use. Pin it: DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci.');
  }
  // *_id columns with no index — fine for audit-only fields, deadly if queried
  const indexedCols = new Set([...ddl.matchAll(/(?:KEY|PRIMARY KEY|UNIQUE)[^(]*\(\s*`?(\w+)`?/gi)].map(m => m[1].toLowerCase()));
  for (const c of cols) {
    const n = c.name.toLowerCase();
    // the "255 reflex": oversized VARCHARs, worst when indexed — index bytes
    // = chars × 4 (utf8mb4); memory, buffer pool and temp tables all pay it
    const vc = /^varchar\((\d+)\)/.exec(c.type);
    if (vc) {
      const chars = Number(vc[1]);
      const inIndex = indexedCols.has(n);
      if (chars >= 255 && inIndex) {
        push('D14', 'orange', `\`${c.name}\` VARCHAR(${chars}) inside an index`,
          `Index entries reserve up to ${chars * 4} bytes each (utf8mb4) — sort buffers, temp tables and memory engines allocate the FULL declared width. Right-size to the real domain (measure: SELECT MAX(CHAR_LENGTH(${c.name})) …) — e.g. VARCHAR(128) halves the index footprint. Declared width is a promise, not padding: shrinking later is an in-place ALTER when no data exceeds it.`);
      } else if (chars >= 255) {
        push('D14', 'yellow', `\`${c.name}\` VARCHAR(${chars}) — the 255 reflex`,
          `If the real values are far shorter, temp tables/sorts still budget ${chars * 4} bytes per row for it. Right-size to the domain; keep ≥255 only when the data genuinely needs it.`);
      }
    }
    if (n.endsWith('_id') && !indexedCols.has(n)) {
      push('D12', 'yellow', `\`${c.name}\` has no index`,
        'Any lookup or join on it is a full scan. If it is audit-only data, fine — otherwise add an index (and if it references another table, consider the FK).');
    }
    // time-based housekeeping: *_at DATETIME without index → purge jobs scan
    if (/^(datetime|timestamp)/.test(c.type) && /_at$/.test(n) && !indexedCols.has(n) && /idempoten|guard|log|history|event/i.test(ddl)) {
      push('D13', 'yellow', `\`${c.name}\` unindexed on an append-only/guard table`,
        'Tables like this grow forever — the eventual retention job (DELETE WHERE ' + c.name + ' < …) will full-scan. Add an index on it now, and plan the purge policy.');
    }
  }

  // ── index-structure patterns (Q4 / ../schema-derived) ──────────────────────
  // parse every index into (name, ordered columns), and FK definitions
  interface Idx { name: string; cols: string[] }
  const indexes: Idx[] = [];
  const isPrimary: boolean[] = [];
  for (const m of ddl.matchAll(/(PRIMARY\s+KEY|UNIQUE(?:\s+KEY)?|KEY|INDEX)\s*(?:`([^`]+)`|([A-Za-z_]\w*))?\s*\(([^)]+)\)/gi)) {
    const cols = m[4].split(',').map(c => {
      const mm = /`([^`]+)`|([A-Za-z_]\w*)/.exec(c.trim());
      return (mm?.[1] ?? mm?.[2] ?? '').toLowerCase();
    }).filter(Boolean);
    if (!cols.length) continue;
    const primary = /^primary/i.test(m[1]);
    indexes.push({ name: primary ? '(primary/unnamed)' : (m[2] ?? m[3] ?? '(unnamed)'), cols });
    isPrimary.push(primary);
  }

  // FK columns lacking a supporting index (leftmost) → join/cascade full scans
  for (const m of ddl.matchAll(/FOREIGN KEY\s*\(\s*`?(\w+)`?\s*\)/gi)) {
    const fk = m[1].toLowerCase();
    const supported = indexes.some(ix => ix.cols[0] === fk);
    if (!supported) {
      push('D15', 'orange', `FK column \`${m[1]}\` has no leading index`,
        'InnoDB requires (and auto-creates) an index for a FK, but if you rely on that auto-index it may not match your query/JOIN order. Every parent DELETE/UPDATE also checks children — without a good index that is a full scan per parent row. Add an explicit index leading with this column.');
    }
  }

  // redundant index: one index is a leftmost prefix of another
  for (let a = 0; a < indexes.length; a++) {
    for (let b = 0; b < indexes.length; b++) {
      if (a === b) continue;
      const short = indexes[a], long = indexes[b];
      if (short.cols.length < long.cols.length
          && short.cols.every((c, k) => long.cols[k] === c)
          && short.name !== '(primary/unnamed)') {
        push('D16', 'yellow', `redundant index \`${short.name}\` (${short.cols.join(', ')})`,
          `It is a leftmost prefix of \`${long.name}\` (${long.cols.join(', ')}), which already serves the same lookups. Every write maintains both — drop \`${short.name}\` unless it is UNIQUE or covers a different query.`);
        break;
      }
    }
  }

  // wide composite key: PRIMARY KEY over many/large columns bloats every
  // secondary index (InnoDB appends the PK to each)
  const pk = indexes.find((_, i) => isPrimary[i]);
  if (pk && pk.cols.length >= 4) {
    push('D17', 'orange', `wide PRIMARY KEY (${pk.cols.length} columns)`,
      `InnoDB stores the full PRIMARY KEY inside every secondary index, so a ${pk.cols.length}-column PK inflates all of them and slows writes. Consider a narrow surrogate key (BIGINT UNSIGNED AUTO_INCREMENT) with a UNIQUE constraint on the natural key.`);
  }

  // nullable-heavy: many columns with no NOT NULL and no explicit default
  const nullable = cols.filter(c => !/not null/i.test(c.line));
  if (cols.length >= 5 && nullable.length >= Math.ceil(cols.length * 0.7)) {
    push('D18', 'yellow', `${nullable.length}/${cols.length} columns are nullable`,
      'Pervasive NULLs push validation into every query (IS NULL / COALESCE), complicate indexes, and often signal missing NOT NULL + DEFAULT. Tighten the columns that are genuinely required.');
  }

  return f;
}
