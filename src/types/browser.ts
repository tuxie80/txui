export interface TableColumn {
  name:        string;
  type_name:   string;
  nullable:    boolean;
  primary_key: boolean;
  fk_table:    string | null;
  fk_column:   string | null;
}

export interface TableMeta {
  columns:    TableColumn[];
  pk_columns: string[];
  total_rows: number | null;
}

export type FilterOp =
  | 'eq' | 'neq' | 'lt' | 'lte' | 'gt' | 'gte'
  | 'like' | 'not_like' | 'is_null' | 'is_not_null';

export interface FilterClause {
  column: string;
  op:     FilterOp;
  value:  string | null;
}

export type SortDir = 'asc' | 'desc';

export interface SortClause {
  column:    string;
  direction: SortDir;
}

export interface BrowseParams {
  session_id: string;
  table:      string;
  filters:    FilterClause[];
  sort:       SortClause[];
  limit:      number;
  offset:     number;
}

export interface RowChange {
  pk_values:  Record<string, unknown>;
  column:     string;
  new_value:  unknown;
}

/** O(1) pending-edit lookup key shared by FastGrid and DataBrowser. */
export function pendingKey(pkValues: Record<string, unknown>, column: string): string {
  return `${JSON.stringify(pkValues)}|${column}`;
}

export const OP_LABELS: Record<FilterOp, string> = {
  eq:          '=',
  neq:         '≠',
  lt:          '<',
  lte:         '≤',
  gt:          '>',
  gte:         '≥',
  like:        'LIKE',
  not_like:    'NOT LIKE',
  is_null:     'IS NULL',
  is_not_null: 'IS NOT NULL',
};

export const OPS_WITH_VALUE: FilterOp[] = [
  'eq','neq','lt','lte','gt','gte','like','not_like',
];
