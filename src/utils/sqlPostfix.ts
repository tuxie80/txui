/**
 * Postfix completion, DataGrip-style: type a table (an alias, a dotted
 * `db.table` chain), then a dot, then a postfix keyword — accepting it
 * replaces the WHOLE `chain.postfix` span with a full statement template:
 *
 *   orders.sel       → SELECT * FROM orders            (caret on the column list)
 *   orders.where     → SELECT * FROM orders WHERE |
 *   orders.count     → SELECT COUNT(*) FROM orders
 *   orders.orderby   → SELECT * FROM orders ORDER BY |
 *   orders.join      → SELECT * FROM orders t1 JOIN … t2 ON t2.… = t1.…
 *   orders.ins       → INSERT INTO orders (…) VALUES (…)
 *   orders.desc      → DESCRIBE orders                 (MySQL family & ClickHouse)
 *
 * The chain is inserted verbatim, quoting and all — if you typed an alias, you
 * get the alias. Postfixes are ADDITIONAL options next to the normal column /
 * table dot-completion, ranked below it; they never replace it, and Redis (not
 * SQL) never sees them.
 */
import type { Completion } from '@codemirror/autocomplete';
import { snippet, snippetCompletion } from '@codemirror/autocomplete';
import type { Engine } from '../types';

interface PostfixDef {
  /** the postfix keyword — also the completion label, so `orders.se` finds `sel` */
  label: string;
  /** engines that offer it (Redis is never here — it is not SQL) */
  engines: Engine[];
  /** the expansion with the chain filled in, for the popup's detail column */
  describe: (chain: string) => string;
  /** CM snippet template; `${1:…}` tab-stops land the caret where typing continues */
  template: (chain: string) => string;
}

/** Every SQL engine — the read postfixes are plain SELECT, even on the file-backed ones. */
const ALL_SQL: Engine[] = ['mysql', 'postgres', 'clickhouse', 'sqlite', 'parquet', 'duckdb'];
/** INSERT is a write: Parquet connections are read-only file scans, so no `ins` there. */
const WRITABLE_SQL: Engine[] = ['mysql', 'postgres', 'clickhouse', 'sqlite', 'duckdb'];
/** DESCRIBE exists in the MySQL family and ClickHouse; PG/SQLite/DuckDB describe differently. */
const DESCRIBABLE: Engine[] = ['mysql', 'clickhouse'];

/** `{`/`}` are snippet syntax. The chain regex never admits them — never trust input anyway. */
const escSnippet = (s: string) => s.replace(/[{}]/g, ch => `\\${ch}`);

const POSTFIXES: PostfixDef[] = [
  {
    label: 'sel', engines: ALL_SQL,
    describe: c => `SELECT * FROM ${c}`,
    template: c => `SELECT \${1:*} FROM ${escSnippet(c)}`,
  },
  {
    label: 'where', engines: ALL_SQL,
    describe: c => `SELECT * FROM ${c} WHERE …`,
    template: c => `SELECT * FROM ${escSnippet(c)} WHERE \${1}`,
  },
  {
    label: 'count', engines: ALL_SQL,
    describe: c => `SELECT COUNT(*) FROM ${c}`,
    template: c => `SELECT COUNT(*) FROM ${escSnippet(c)}`,
  },
  {
    label: 'orderby', engines: ALL_SQL,
    describe: c => `SELECT * FROM ${c} ORDER BY …`,
    template: c => `SELECT * FROM ${escSnippet(c)} ORDER BY \${1}`,
  },
  {
    label: 'join', engines: ALL_SQL,
    describe: c => `SELECT * FROM ${c} t1 JOIN … t2 ON …`,
    template: c => `SELECT * FROM ${escSnippet(c)} t1 JOIN \${1:table2} t2 ON t2.\${2:col} = t1.\${3:col}`,
  },
  {
    label: 'ins', engines: WRITABLE_SQL,
    describe: c => `INSERT INTO ${c} (…) VALUES (…)`,
    template: c => `INSERT INTO ${escSnippet(c)} (\${1:cols}) VALUES (\${2:vals})`,
  },
  {
    label: 'desc', engines: DESCRIBABLE,
    describe: c => `DESCRIBE ${c}`,
    template: c => `DESCRIBE ${escSnippet(c)}`,
  },
];

/**
 * Postfix options for a dotted chain, or [] for engines that do not speak SQL.
 *
 * `chainFrom` is where the chain STARTS in the document. The completion result
 * itself spans only the text after the dot (so CodeMirror's fuzzy filter sees
 * `se` and surfaces `sel`), while the apply function reaches back to replace
 * the whole `chain.postfix` span. Tab-stops survive the trip: the machinery is
 * the same `snippet()` the statement templates use, aimed at a wider range.
 */
export function postfixCompletions(chain: string, chainFrom: number, engine: Engine): Completion[] {
  return POSTFIXES
    .filter(p => (p.engines as string[]).includes(engine))
    .map(p => {
      const template = p.template(chain);
      const applySnippet = snippet(template);
      const base = snippetCompletion(template, {
        label: p.label,
        type: 'text',
        detail: `postfix → ${p.describe(chain)}`,
        // below the catalog's columns/tables — postfix is the deliberate pick,
        // never the thing Enter should land on by accident
        boost: -15,
      });
      const apply: Completion['apply'] = (view, completion, _from, to) =>
        applySnippet(view, completion, chainFrom, to);
      return { ...base, apply };
    });
}
