export interface AiRelation {
  label: string;
  type: 'table' | 'view' | 'column' | 'keyword' | 'schema' | 'database';
  kind?: string;
  detail?: string;
  apply?: string;
}

export interface AiColumn {
  label: string;
  detail?: string;
  pk?: boolean;
}

export interface AiFk {
  fromTable: string;
  fromCols: string[];
  toTable: string;
  toCols: string[];
}

export interface AiSchemaContextInput {
  text: string;
  currentDb?: string;
  relations: AiRelation[];
  getColumns: (table: string) => Promise<AiColumn[]>;
  getIndexedColumns: (table: string) => Promise<Set<string>>;
  getFks: (table: string) => Promise<AiFk[]>;
}

export interface AiSchemaContext {
  text: string;
  tables: string[];
  truncated: boolean;
}

export const AI_SCHEMA_MAX_TABLES = 8;
export const AI_SCHEMA_MAX_CHARS = 24_000;

function plainName(value: string): string {
  return value.replace(/[[\]`"]/g, '');
}

function qualifiedName(relation: AiRelation, currentDb = ''): string {
  const applied = plainName(relation.apply ?? '');
  if (applied.includes('.')) return applied;
  const detail = plainName(relation.detail ?? '');
  const schema = detail && !detail.includes(' ') ? detail : currentDb;
  return schema ? `${schema}.${relation.label}` : relation.label;
}

function mentions(text: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[^A-Za-z0-9_$])${escaped}(?:$|[^A-Za-z0-9_$])`, 'i').test(text);
}

export function referencedRelations(
  text: string,
  relations: AiRelation[],
  currentDb = '',
): string[] {
  const candidates = new Map<string, { name: string; bare: string; score: number }>();
  for (const relation of relations) {
    if (relation.type !== 'table' && relation.type !== 'view') continue;
    const name = qualifiedName(relation, currentDb);
    const bare = relation.label;
    const qualifiedHit = mentions(text, name);
    const bareHit = mentions(text, bare);
    if (!qualifiedHit && !bareHit) continue;
    const score = (qualifiedHit ? 2 : 0) + Math.min(bare.length, 100) / 100;
    const previous = candidates.get(name.toLowerCase());
    if (!previous || score > previous.score) candidates.set(name.toLowerCase(), { name, bare, score });
  }
  return [...candidates.values()]
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .map(candidate => candidate.name);
}

export async function buildAiSchemaContext(input: AiSchemaContextInput): Promise<AiSchemaContext> {
  const matches = referencedRelations(input.text, input.relations, input.currentDb);
  const selected = matches.slice(0, AI_SCHEMA_MAX_TABLES);
  const lines: string[] = [];
  if (input.currentDb) lines.push(`Current database/schema: ${input.currentDb}`);
  lines.push('Metadata only — no row values are included.');

  for (const table of selected) {
    const [columns, indexed, fks] = await Promise.all([
      input.getColumns(table).catch(() => []),
      input.getIndexedColumns(table).catch(() => new Set<string>()),
      input.getFks(table).catch(() => []),
    ]);
    lines.push(`\n${table}:`);
    if (columns.length === 0) {
      lines.push('  (column metadata unavailable)');
    } else {
      for (const column of columns) {
        const flags = [column.pk ? 'PRIMARY KEY' : '', indexed.has(column.label) ? 'indexed' : '']
          .filter(Boolean).join(', ');
        lines.push(`  ${column.label} ${column.detail || 'unknown type'}${flags ? ` [${flags}]` : ''}`);
      }
    }
    for (const fk of fks) {
      lines.push(`  FK ${fk.fromTable} (${fk.fromCols.join(', ')}) -> ${fk.toTable} (${fk.toCols.join(', ')})`);
    }
  }

  if (selected.length === 0) {
    const names = [...new Set(input.relations
      .filter(relation => relation.type === 'table' || relation.type === 'view')
      .map(relation => qualifiedName(relation, input.currentDb)))];
    lines.push('\nNo referenced relation was detected. Available relation names; their columns were not supplied:');
    lines.push(names.slice(0, 100).join(', ') || '(no relation metadata available)');
  }

  const truncated = matches.length > selected.length || lines.join('\n').length > AI_SCHEMA_MAX_CHARS;
  let text = lines.join('\n');
  if (text.length > AI_SCHEMA_MAX_CHARS) {
    text = `${text.slice(0, AI_SCHEMA_MAX_CHARS)}\n… context truncated`;
  }
  if (matches.length > selected.length) {
    text += `\n… ${matches.length - selected.length} additional referenced relations omitted`;
  }
  return { text, tables: selected, truncated };
}
