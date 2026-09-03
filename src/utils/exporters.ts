/**
 * Result-set serializers — PURE (no React/Tauri/store imports, node-testable
 * per the repo's utils contract). All serializers take (columns, rows) so
 * they work on a grid SELECTION (any rectangular slice) as well as a full
 * result — and every format includes the header, even for
 * middle-of-the-result selections.
 *
 * Persistence (save dialog, clipboard, xlsx/parquet writers) lives in
 * `exportersIo.ts`, which is the module allowed to import Tauri.
 */
import { quoteIdent, sqlLiteral, type IdentEngine } from './sqlIdent.ts';

export type Cells = unknown[][];

export function cellText(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/**
 * Neutralize spreadsheet formula injection: a cell that a spreadsheet would
 * evaluate as a formula (leads with = + @, tab or CR, or a non-numeric - / +)
 * is prefixed with a `'` so Excel/Sheets treat it as text. Genuine numbers
 * (`-12`, `+3.5`) are left intact.
 */
function neutralizeFormula(s: string): string {
  if (s === '') return s;
  const c = s[0];
  if (c === '=' || c === '@' || c === '\t' || c === '\r') return `'${s}`;
  if ((c === '-' || c === '+') && !/^[-+]?\d/.test(s)) return `'${s}`;
  return s;
}

function csvEscape(v: unknown): string {
  if (v === null || v === undefined) return '';
  const raw = typeof v === 'object' ? JSON.stringify(v) : String(v);
  const s = neutralizeFormula(raw);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(columns: string[], rows: Cells): string {
  const header = columns.map(csvEscape).join(',');
  const body = rows.map(row => row.map(csvEscape).join(','));
  return [header, ...body].join('\n') + '\n';
}

export function toTsv(columns: string[], rows: Cells): string {
  const cell = (v: unknown) => {
    if (v === null || v === undefined) return '';
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    return neutralizeFormula(s).replace(/[\t\n\r]/g, ' ');
  };
  const header = columns.join('\t');
  const body = rows.map(row => row.map(cell).join('\t'));
  return [header, ...body].join('\n');
}

export function toJson(columns: string[], rows: Cells): string {
  const objects = rows.map(row => {
    const o: Record<string, unknown> = {};
    row.forEach((v, i) => { o[columns[i]] = v; });
    return o;
  });
  return JSON.stringify(objects, null, 2) + '\n';
}

/**
 * mysql-CLI-style ASCII table:
 * +----+-------+
 * | id | name  |
 * +----+-------+
 * |  1 | alice |
 * +----+-------+
 * Numbers right-aligned, text left-aligned, NULL rendered literally.
 */
export function toAsciiTable(columns: string[], rows: Cells): string {
  const texts: string[][] = rows.map(row => row.map(cellText));
  // One pass over the cells for widths + numeric detection. Spreading a
  // column of 100k+ rows into Math.max exceeds V8's argument limit and
  // throws, and rows.every per column walked the table a second time.
  const widths: number[] = columns.map(n => Math.max(n.length, 1));
  const numeric: boolean[] = columns.map(() => rows.length > 0);
  for (let ri = 0; ri < rows.length; ri++) {
    const src = rows[ri], txt = texts[ri];
    for (let ci = 0; ci < columns.length; ci++) {
      if (txt[ci].length > widths[ci]) widths[ci] = txt[ci].length;
      if (numeric[ci]) {
        const v = src[ci];
        if (v !== null && v !== undefined && typeof v !== 'number') numeric[ci] = false;
      }
    }
  }

  const sep = '+' + widths.map(w => '-'.repeat(w + 2)).join('+') + '+';
  const pad = (s: string, w: number, right: boolean) =>
    right ? s.padStart(w) : s.padEnd(w);
  const line = (cells: string[], rightFlags: boolean[]) =>
    '| ' + cells.map((c, i) => pad(c, widths[i], rightFlags[i])).join(' | ') + ' |';

  const out = [
    sep,
    line(columns, columns.map(() => false)),
    sep,
    ...texts.map(t => line(t, numeric)),
  ];
  if (rows.length > 0) out.push(sep);
  return out.join('\n') + '\n';
}

/** GitHub-flavored Markdown table. */
export function toMarkdown(columns: string[], rows: Cells): string {
  const esc = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const header = '| ' + columns.map(esc).join(' | ') + ' |';
  const rule   = '| ' + columns.map(() => '---').join(' | ') + ' |';
  const body   = rows.map(r => '| ' + r.map(v => esc(cellText(v))).join(' | ') + ' |');
  return [header, rule, ...body].join('\n') + '\n';
}

/**
 * INSERT statements — one per row, in the TARGET engine's dialect. The engine
 * decides both identifier quoting (backticks vs double quotes vs brackets)
 * and literal escaping: exporting a PG result with MySQL backslash-doubled
 * strings was silent data corruption (PG treats `\` as literal by default).
 */
export function toInserts(table: string, columns: string[], rows: Cells, engine: IdentEngine = 'mysql'): string {
  const ident = (s: string) => quoteIdent(s, engine);
  const lit = (v: unknown): string => {
    if (v === null || v === undefined) return 'NULL';
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    return sqlLiteral(s, engine);
  };
  const cols = columns.map(ident).join(', ');
  return rows
    .map(r => `INSERT INTO ${ident(table)} (${cols}) VALUES (${r.map(lit).join(', ')});`)
    .join('\n') + '\n';
}


/**
 * XML — one element per row, columns as child elements.
 *
 * Attributes would be shorter but cannot carry a NULL distinctly, and a NULL
 * silently exported as an empty string is how a round-trip loses data. Nulls
 * are marked `xsi:nil` instead.
 */
export function toXml(columns: string[], rows: Cells, root = 'rows'): string {
  const esc = (s: string) => s
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  // An element name cannot start with a digit or contain most punctuation.
  const tag = (name: string) => {
    const t = name.replace(/[^\w.-]/g, '_');
    return /^[A-Za-z_]/.test(t) ? t : `_${t}`;
  };
  const tags = columns.map(tag);
  const body = rows.map(r => {
    const cells = r.map((v, i) => (v === null || v === undefined)
      ? `    <${tags[i]} xsi:nil="true"/>`
      : `    <${tags[i]}>${esc(cellText(v))}</${tags[i]}>`);
    return `  <row>\n${cells.join('\n')}\n  </row>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n`
    + `<${root} xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">\n`
    + `${body.join('\n')}\n</${root}>\n`;
}

/** A standalone HTML table — self-contained so it opens in a browser as-is. */
export function toHtml(columns: string[], rows: Cells, title = 'Result'): string {
  const esc = (s: string) => s
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  const head = columns.map(c => `<th>${esc(c)}</th>`).join('');
  const body = rows.map(r =>
    '<tr>' + r.map(v => (v === null || v === undefined)
      ? '<td class="null">NULL</td>'
      : `<td>${esc(cellText(v))}</td>`).join('') + '</tr>').join('\n');
  return `<!doctype html>
<meta charset="utf-8">
<title>${esc(title)}</title>
<style>
  body { font: 14px/1.5 system-ui, sans-serif; margin: 24px; }
  table { border-collapse: collapse; }
  th, td { border: 1px solid #d0d7de; padding: 4px 9px; text-align: left; }
  th { background: #f6f8fa; }
  td.null { color: #8b949e; font-style: italic; }
  tbody tr:nth-child(even) { background: #fafbfc; }
</style>
<table>
<thead><tr>${head}</tr></thead>
<tbody>
${body}
</tbody>
</table>
`;
}

/**
 * A LaTeX tabular.
 *
 * Every one of `& % $ # _ { } ~ ^ \` changes the meaning of a LaTeX document,
 * so an unescaped export does not merely look wrong — it fails to compile, or
 * worse, compiles into something else.
 */
export function toLatex(columns: string[], rows: Cells): string {
  // One pass with a lookup, not a chain: replacing `\` with a macro that itself
  // contains braces, and THEN escaping braces, mangles the macro. Order-
  // independence is the point.
  const LATEX: Record<string, string> = {
    '\\': '\\textbackslash{}',
    '&': '\\&', '%': '\\%', '$': '\\$', '#': '\\#', '_': '\\_',
    '{': '\\{', '}': '\\}',
    '~': '\\textasciitilde{}', '^': '\\textasciicircum{}',
  };
  const esc = (s: string) => s.replace(/[\\&%$#_{}~^]/g, ch => LATEX[ch] ?? ch);
  const spec = columns.map(() => 'l').join(' ');
  const head = columns.map(c => esc(c)).join(' & ') + ' \\\\';
  const body = rows.map(r => r.map(v => esc(cellText(v))).join(' & ') + ' \\\\');
  return [
    `\\begin{tabular}{${spec}}`,
    '\\hline',
    head,
    '\\hline',
    ...body,
    '\\hline',
    '\\end{tabular}',
  ].join('\n') + '\n';
}

/**
 * A user-defined extractor.
 *
 * DataGrip lets you write JavaScript for this; running arbitrary JS to format a
 * result set is a large surface for a small need. A template covers the cases
 * people actually ask for — a bespoke INSERT dialect, a config-file line, a
 * shell command per row — without executing anything.
 *
 * Placeholders: `{col}` by name, `{1}` by position, `{{` for a literal brace.
 * A name that does not exist is left as written rather than blanked, so a typo
 * is visible in the output instead of producing silently empty rows.
 */
export function applyTemplate(
  template: string, columns: string[], row: unknown[],
): string {
  const byName = new Map(columns.map((c, i) => [c.toLowerCase(), i]));
  return template.replace(/\{\{|\}\}|\{([^{}]*)\}/g, (whole, key: string | undefined) => {
    if (whole === '{{') return '{';
    if (whole === '}}') return '}';
    const k = (key ?? '').trim();
    const idx = /^\d+$/.test(k) ? Number(k) - 1 : byName.get(k.toLowerCase()) ?? -1;
    if (idx < 0 || idx >= row.length) return whole;
    return cellText(row[idx]);
  });
}

/** Render every row through a template, one per line. */
export function toTemplate(template: string, columns: string[], rows: Cells): string {
  return rows.map(r => applyTemplate(template, columns, r)).join('\n') + '\n';
}

export type ExportFormat =
  | 'tsv' | 'csv' | 'json' | 'ascii' | 'markdown' | 'insert'
  | 'html' | 'xml' | 'latex';

export const FORMAT_LABELS: Record<ExportFormat, string> = {
  tsv:      'TSV',
  csv:      'CSV',
  json:     'JSON',
  ascii:    'ASCII table',
  markdown: 'Markdown',
  insert:   'INSERT statements',
  html:     'HTML table',
  xml:      'XML',
  latex:    'LaTeX tabular',
};

export function serialize(
  format: ExportFormat,
  columns: string[],
  rows: Cells,
  table = 'my_table',
  engine: IdentEngine = 'mysql',
): string {
  switch (format) {
    case 'tsv':      return toTsv(columns, rows);
    case 'csv':      return toCsv(columns, rows);
    case 'json':     return toJson(columns, rows);
    case 'ascii':    return toAsciiTable(columns, rows);
    case 'markdown': return toMarkdown(columns, rows);
    case 'insert':   return toInserts(table, columns, rows, engine);
    case 'html':     return toHtml(columns, rows, table);
    case 'xml':      return toXml(columns, rows);
    case 'latex':    return toLatex(columns, rows);
  }
}

export const FORMAT_EXT: Record<ExportFormat, string> = {
  tsv: 'tsv', csv: 'csv', json: 'json', ascii: 'txt', markdown: 'md', insert: 'sql',
  html: 'html', xml: 'xml', latex: 'tex',
};

/** Open native save dialog and write `contents`; returns saved path or null if cancelled. */
/**
 * Rewrite line endings for a file about to be written.
 *
 * Every exporter above joins with `\n`, which Excel and modern Notepad read
 * correctly — and which plenty of older Windows tooling shows as one run-on
 * line. Converting *here* rather than in ten exporters is deliberate: there is
 * one place a file gets written, so there is one place this can be wrong.
 *
 * The clipboard is untouched. Pasting is between two applications that have
 * already agreed on a convention, and rewriting it there breaks as much as it
 * fixes.
 *
 * Normalises to `\n` first, so a string that already contains CRLF (a query
 * pasted from Windows, say) does not become `\r\r\n`.
 */
export function withEol(text: string, eol: '\n' | '\r\n'): string {
  const lf = text.replace(/\r\n/g, '\n');
  return eol === '\n' ? lf : lf.replace(/\n/g, '\r\n');
}

