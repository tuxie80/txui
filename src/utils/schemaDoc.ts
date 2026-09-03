/**
 * Schema documentation.
 *
 * dbForge calls this the Database Documenter. The version that gets used is not
 * the one with the most sections — it is the one whose output can be committed
 * to a repository and diffed, so a schema change shows up in review alongside
 * the code that caused it.
 *
 * That single requirement decides the design:
 *   - **Markdown first**, because it diffs. HTML is offered for reading, not
 *     for storing.
 *   - **Deterministic order** everywhere. A documenter whose output reorders
 *     between runs produces a diff on every regeneration and is abandoned
 *     within a week.
 *   - **No timestamps in the body.** "Generated at 14:03" changes every run and
 *     makes every diff non-empty.
 *
 * Pure and dependency-free — driven by `node --test`.
 */

import { layoutEr, type ErTable, type ErEdge } from './erLayout.ts';
import { diagramToSvg, type ExportTheme } from './erExport.ts';

export interface DocColumn {
  name: string;
  type: string;
  nullable: boolean;
  key?: string;
  default?: string | null;
  comment?: string;
}

export interface DocIndex {
  name: string;
  unique: boolean;
  columns: string[];
  /** Access method, when it is not the default btree. */
  method?: string;
  /** Predicate of a partial index. */
  where?: string;
}

export interface DocForeignKey {
  name: string;
  columns: string[];
  refTable: string;
  refColumns: string[];
}

export interface DocTable {
  schema: string;
  name: string;
  comment?: string;
  engine?: string;
  rows?: number;
  columns: DocColumn[];
  indexes: DocIndex[];
  foreignKeys: DocForeignKey[];
}

export interface DocRoutine {
  schema: string;
  name: string;
  kind: string;
  returns?: string;
  comment?: string;
}

export interface SchemaDoc {
  schema: string;
  engine: string;
  tables: DocTable[];
  routines: DocRoutine[];
}

export interface DocOptions {
  /** Include the row-count column. Off by default — it changes every run. */
  includeRowCounts?: boolean;
  /** Include a Mermaid relationship diagram. */
  includeDiagram?: boolean;
}

/** Sort everything, so two runs over an unchanged schema produce no diff. */
export function normaliseDoc(doc: SchemaDoc): SchemaDoc {
  const byName = <T extends { name: string }>(a: T, b: T) => a.name.localeCompare(b.name);
  return {
    ...doc,
    tables: [...doc.tables]
      .sort(byName)
      .map(t => ({
        ...t,
        // Columns keep their DECLARED order — that is information, and sorting
        // them alphabetically would destroy it. Everything else is sorted.
        indexes: [...t.indexes].sort(byName),
        foreignKeys: [...t.foreignKeys].sort(byName),
      })),
    routines: [...doc.routines].sort((a, b) =>
      a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name)),
  };
}

const esc = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');

/** Markdown, written to be diffed. */
export function toMarkdown(doc: SchemaDoc, opts: DocOptions = {}): string {
  const d = normaliseDoc(doc);
  const out: string[] = [];

  out.push(`# ${d.schema}`);
  out.push('');
  out.push(`${d.tables.length} table${d.tables.length === 1 ? '' : 's'}`
    + (d.routines.length ? ` · ${d.routines.length} routine${d.routines.length === 1 ? '' : 's'}` : ''));
  out.push('');

  if (d.tables.length > 0) {
    out.push('## Tables');
    out.push('');
    for (const t of d.tables) {
      out.push(`### ${t.name}`);
      if (t.comment) { out.push(''); out.push(t.comment); }
      out.push('');

      const cols = ['Column', 'Type', 'Null', 'Key', 'Default'];
      if (t.columns.some(c => c.comment)) cols.push('Comment');
      out.push(`| ${cols.join(' | ')} |`);
      out.push(`| ${cols.map(() => '---').join(' | ')} |`);
      for (const c of t.columns) {
        const row = [
          `\`${esc(c.name)}\``,
          `\`${esc(c.type)}\``,
          c.nullable ? 'yes' : 'no',
          c.key ? esc(c.key) : '',
          c.default === null || c.default === undefined ? '' : `\`${esc(String(c.default))}\``,
        ];
        if (cols.includes('Comment')) row.push(esc(c.comment ?? ''));
        out.push(`| ${row.join(' | ')} |`);
      }
      out.push('');

      if (t.indexes.length > 0) {
        out.push('**Indexes**');
        out.push('');
        for (const i of t.indexes) {
          // Method and predicate are not decoration: a GIN index and a btree
          // on the same column answer different queries, and a partial index
          // that looks total is a wrong conclusion waiting to happen.
          out.push(`- \`${esc(i.name)}\`${i.unique ? ' *(unique)*' : ''}`
            + (i.method ? ` *(${esc(i.method)})*` : '')
            + ` — ${i.columns.map(c => `\`${esc(c)}\``).join(', ')}`
            + (i.where ? ` WHERE \`${esc(i.where)}\`` : ''));
        }
        out.push('');
      }

      if (t.foreignKeys.length > 0) {
        out.push('**References**');
        out.push('');
        for (const f of t.foreignKeys) {
          out.push(`- ${f.columns.map(c => `\`${esc(c)}\``).join(', ')}`
            + ` → \`${esc(f.refTable)}\``
            + ` (${f.refColumns.map(c => `\`${esc(c)}\``).join(', ')})`);
        }
        out.push('');
      }

      if (opts.includeRowCounts && t.rows !== undefined) {
        out.push(`*approximately ${t.rows.toLocaleString()} rows*`);
        out.push('');
      }
    }
  }

  if (d.routines.length > 0) {
    out.push('## Routines');
    out.push('');
    out.push('| Name | Kind | Returns |');
    out.push('| --- | --- | --- |');
    for (const r of d.routines) {
      out.push(`| \`${esc(r.name)}\` | ${esc(r.kind)} | ${r.returns ? `\`${esc(r.returns)}\`` : ''} |`);
    }
    out.push('');
  }

  if (opts.includeDiagram) {
    const diagram = toMermaid(d);
    if (diagram) {
      out.push('## Relationships');
      out.push('');
      out.push('```mermaid');
      out.push(diagram);
      out.push('```');
      out.push('');
    }
  }

  return out.join('\n');
}

/**
 * A Mermaid ER diagram of the foreign keys.
 *
 * Only the relationships, not every column: a diagram with four hundred
 * columns on it is a wall, and the column detail is already in the tables
 * above. Returns empty when there is nothing to draw rather than an empty
 * diagram block.
 */
export function toMermaid(doc: SchemaDoc): string {
  const d = normaliseDoc(doc);
  const lines: string[] = ['erDiagram'];
  let any = false;
  for (const t of d.tables) {
    for (const f of t.foreignKeys) {
      // Mermaid identifiers cannot contain most punctuation.
      const from = t.name.replace(/[^\w]/g, '_');
      const to = f.refTable.split('.').pop()!.replace(/[^\w]/g, '_');
      lines.push(`  ${to} ||--o{ ${from} : "${f.columns.join(', ')}"`);
      any = true;
    }
  }
  return any ? lines.join('\n') : '';
}

/** Light theme for the standalone HTML doc's embedded ER diagram — matches the
 *  document's own light palette (see toHtmlDoc's <style>). */
const DOC_ER_THEME: ExportTheme = {
  bg: '#ffffff', nodeBg: '#ffffff', nodeHead: '#f6f8fa', headText: '#1f2328',
  text: '#1f2328', muted: '#57606a', border: '#d0d7de', edge: '#6e7781', edgeVirtual: '#8c959f',
};

/** Build the ER model (tables + FK edges) from a SchemaDoc, for the diagram. */
function docToErModel(d: SchemaDoc): { tables: ErTable[]; edges: ErEdge[] } {
  const fkCols = (t: DocTable) => new Set(t.foreignKeys.flatMap(f => f.columns));
  const tables: ErTable[] = d.tables.map(t => {
    const fks = fkCols(t);
    return {
      name: t.name,
      columns: t.columns.map(c => {
        const key = (c.key ?? '').toUpperCase();
        return {
          name: c.name,
          type: c.type,
          pk: key.includes('PRI') || key === 'PK',
          fk: fks.has(c.name),
          unique: key.includes('UNI'),
        };
      }),
    };
  });
  const edges: ErEdge[] = [];
  for (const t of d.tables) {
    for (const f of t.foreignKeys) {
      edges.push({
        fromTable: t.name,
        fromCol: f.columns[0] ?? '',
        toTable: f.refTable.split('.').pop()!,
        toCol: f.refColumns[0] ?? '',
        constraint: f.name,
      });
    }
  }
  return { tables, edges };
}

/**
 * A real vector ER diagram of the foreign keys, laid out with the same engine
 * (`layoutEr`) and renderer (`diagramToSvg`) the ER panel uses — so the doc
 * shows the app's actual diagram, not a Mermaid re-render. Returns '' when
 * there is nothing to draw. Pure: `layoutEr`/`diagramToSvg` do no DOM work.
 */
export function toErSvg(doc: SchemaDoc, theme: ExportTheme = DOC_ER_THEME): string {
  const d = normaliseDoc(doc);
  const { tables, edges } = docToErModel(d);
  if (!tables.length || edges.length === 0) return '';
  const pos = layoutEr(tables, edges);
  return diagramToSvg({ tables, edges, pos, density: 'keys', theme, title: `${d.schema} — relationships` });
}

/** Standalone HTML, for reading rather than storing. */
export function toHtmlDoc(doc: SchemaDoc, opts: DocOptions = {}): string {
  const d = normaliseDoc(doc);
  const h = (s: string) => s
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const tables = d.tables.map(t => `
<section id="t-${h(t.name)}">
  <h3>${h(t.name)}</h3>
  ${t.comment ? `<p class="note">${h(t.comment)}</p>` : ''}
  <table>
    <thead><tr><th>Column</th><th>Type</th><th>Null</th><th>Key</th><th>Default</th></tr></thead>
    <tbody>
      ${t.columns.map(c => `<tr>
        <td><code>${h(c.name)}</code></td>
        <td><code>${h(c.type)}</code></td>
        <td>${c.nullable ? 'yes' : 'no'}</td>
        <td>${h(c.key ?? '')}</td>
        <td>${c.default == null ? '' : `<code>${h(String(c.default))}</code>`}</td>
      </tr>`).join('')}
    </tbody>
  </table>
  ${t.indexes.length ? `<p class="sub">Indexes</p><ul>${t.indexes.map(i =>
    `<li><code>${h(i.name)}</code>${i.unique ? ' (unique)' : ''}${
      i.method ? ` (${h(i.method)})` : ''} — ${
      i.columns.map(c => `<code>${h(c)}</code>`).join(', ')}${
      i.where ? ` WHERE <code>${h(i.where)}</code>` : ''}</li>`).join('')}</ul>` : ''}
  ${t.foreignKeys.length ? `<p class="sub">References</p><ul>${t.foreignKeys.map(f =>
    `<li>${f.columns.map(c => `<code>${h(c)}</code>`).join(', ')} → <code>${h(f.refTable)}</code></li>`)
    .join('')}</ul>` : ''}
  ${opts.includeRowCounts && t.rows !== undefined
    ? `<p class="note">approximately ${t.rows.toLocaleString()} rows</p>` : ''}
</section>`).join('');

  return `<!doctype html>
<meta charset="utf-8">
<title>${h(d.schema)} — schema</title>
<style>
  body { font: 15px/1.6 system-ui, sans-serif; margin: 0; display: flex; }
  nav { width: 220px; flex: none; padding: 20px 14px; border-right: 1px solid #d0d7de;
        position: sticky; top: 0; height: 100vh; overflow: auto; }
  nav a { display: block; padding: 2px 0; color: #0969da; text-decoration: none; font-size: 14px; }
  main { flex: 1; padding: 24px 28px; max-width: 1000px; }
  h1 { margin-top: 0; }
  table { border-collapse: collapse; margin: 8px 0 14px; }
  th, td { border: 1px solid #d0d7de; padding: 4px 9px; text-align: left; font-size: 14px; }
  th { background: #f6f8fa; }
  code { background: #f6f8fa; padding: 1px 4px; border-radius: 3px; }
  .note { color: #57606a; }
  .sub { font-weight: 600; margin: 10px 0 4px; }
  ul { margin: 4px 0 12px; }
  #er-diagram .er { overflow-x: auto; border: 1px solid #d0d7de; border-radius: 6px; padding: 8px; }
  #er-diagram svg { max-width: 100%; height: auto; }
</style>
<nav>
  <b>${h(d.schema)}</b>
  ${d.tables.map(t => `<a href="#t-${h(t.name)}">${h(t.name)}</a>`).join('')}
</nav>
<main>
  <h1>${h(d.schema)}</h1>
  <p class="note">${d.tables.length} tables · ${d.routines.length} routines</p>
  ${opts.includeDiagram ? (() => { const svg = toErSvg(d); return svg
    ? `<section id="er-diagram"><h2>Relationships</h2><div class="er">${svg}</div></section>` : ''; })() : ''}
  ${tables}
  ${d.routines.length ? `<h2>Routines</h2><ul>${d.routines.map(r =>
    `<li><code>${h(r.name)}</code> — ${h(r.kind)}${r.returns ? ` → <code>${h(r.returns)}</code>` : ''}</li>`)
    .join('')}</ul>` : ''}
</main>
`;
}

/** Suggested filename for a generated document. */
export function docFileName(schema: string, format: 'md' | 'html'): string {
  const safe = schema.replace(/[^\w.-]/g, '_') || 'schema';
  return `${safe}-schema.${format}`;
}
