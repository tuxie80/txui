/**
 * The corpus for **find usages** — every piece of SQL the server itself holds.
 *
 * The point of the feature is the definitions nobody has open: a view built on
 * the column, a trigger that writes it, a stored procedure that reads it, a
 * foreign key that depends on it. Those are what break after a `DROP COLUMN`,
 * because they are the ones no editor search covers.
 *
 * One statement per engine rather than one per object type. A `UNION ALL`
 * returning a uniform `(kind, schema, label, sql, owner_table)` is a single round
 * trip and a
 * single failure mode; eight queries would be eight chances for one to fail
 * quietly and leave a gap in the answer that looks exactly like "not used".
 *
 * Pure — builds SQL text, runs nothing.
 */
import { sqlLiteral } from './sqlIdent.ts';
import type { SourceKind } from './findUsages.ts';

export type Engine = 'mysql' | 'postgres' | 'sqlserver';

/** The shape every branch of the UNION returns, in order. */
export const CORPUS_COLUMNS = ['kind', 'schema', 'label', 'sql', 'owner_table'] as const;

/**
 * Object kinds the corpus can contain, per engine.
 *
 * Exported so the panel can say what it looked at. "No usages" is only
 * meaningful next to a list of what was searched.
 */
export function corpusKinds(engine: Engine): SourceKind[] {
  if (engine === 'mysql') {
    return ['view', 'routine', 'trigger', 'event', 'default', 'constraint'];
  }
  if (engine === 'sqlserver') {
    // No 'matview': SQL Server's equivalent is an INDEXED VIEW, which is an
    // ordinary view with a clustered index — already covered by 'view'.
    // 'computed' is SQL-Server-shaped and worth its own kind: a computed
    // column names other columns in its expression, and dropping one of those
    // takes the computed column with it.
    return ['view', 'routine', 'trigger', 'default', 'constraint', 'index', 'computed'];
  }
  return ['view', 'matview', 'routine', 'trigger', 'default', 'constraint', 'index'];
}

/**
 * MySQL's corpus.
 *
 * `CHECK_CONSTRAINTS` is deliberately absent: it arrived in 8.0.16, and a
 * missing table would fail the whole `UNION` — turning a partial answer into no
 * answer, which here reads as "nothing uses this".
 *
 * Foreign keys have no definition text to search, so one is synthesised. The
 * dependency is real and a rename breaks it; it just is not written down
 * anywhere as SQL.
 */
function mysqlCorpus(schema: string): string {
  const s = sqlLiteral(schema, 'mysql');
  return [
    `SELECT 'view' AS kind, TABLE_SCHEMA AS \`schema\`,
            CONCAT(TABLE_SCHEMA, '.', TABLE_NAME) AS label,
            VIEW_DEFINITION AS sql_text, NULL AS owner_table
       FROM information_schema.VIEWS
      WHERE TABLE_SCHEMA = ${s} AND VIEW_DEFINITION IS NOT NULL`,

    `SELECT 'routine', ROUTINE_SCHEMA,
            CONCAT(ROUTINE_SCHEMA, '.', ROUTINE_NAME, ' (', LOWER(ROUTINE_TYPE), ')'),
            ROUTINE_DEFINITION, NULL
       FROM information_schema.ROUTINES
      WHERE ROUTINE_SCHEMA = ${s} AND ROUTINE_DEFINITION IS NOT NULL`,

    `SELECT 'trigger', TRIGGER_SCHEMA,
            CONCAT(TRIGGER_SCHEMA, '.', TRIGGER_NAME, ' on ', EVENT_OBJECT_TABLE),
            ACTION_STATEMENT, EVENT_OBJECT_TABLE
       FROM information_schema.TRIGGERS
      WHERE TRIGGER_SCHEMA = ${s} AND ACTION_STATEMENT IS NOT NULL`,

    `SELECT 'event', EVENT_SCHEMA,
            CONCAT(EVENT_SCHEMA, '.', EVENT_NAME),
            EVENT_DEFINITION, NULL
       FROM information_schema.EVENTS
      WHERE EVENT_SCHEMA = ${s} AND EVENT_DEFINITION IS NOT NULL`,

    // Generated columns and defaults are expressions that can name a column.
    `SELECT 'default', TABLE_SCHEMA,
            CONCAT(TABLE_SCHEMA, '.', TABLE_NAME, '.', COLUMN_NAME),
            CONCAT(COALESCE(GENERATION_EXPRESSION, ''), ' ', COALESCE(COLUMN_DEFAULT, '')),
            TABLE_NAME
       FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = ${s}
        AND (COALESCE(GENERATION_EXPRESSION, '') <> ''
             OR COALESCE(COLUMN_DEFAULT, '') <> '')`,

    `SELECT 'constraint', k.CONSTRAINT_SCHEMA,
            CONCAT(k.CONSTRAINT_SCHEMA, '.', k.CONSTRAINT_NAME),
            -- Shaped as the DDL it stands for, not as prose: that puts each
            -- table after TABLE / REFERENCES, where the matcher can tell it is
            -- a table rather than guessing from a bare name.
            CONCAT('ALTER TABLE ', k.TABLE_NAME,
                   ' ADD CONSTRAINT ', k.CONSTRAINT_NAME,
                   ' FOREIGN KEY (', k.COLUMN_NAME, ')',
                   ' REFERENCES ', k.REFERENCED_TABLE_NAME,
                   ' (', k.REFERENCED_COLUMN_NAME, ')'),
            k.TABLE_NAME
       FROM information_schema.KEY_COLUMN_USAGE k
      WHERE k.CONSTRAINT_SCHEMA = ${s} AND k.REFERENCED_TABLE_NAME IS NOT NULL`,
  ].join('\nUNION ALL\n');
}

/**
 * PostgreSQL's corpus.
 *
 * `pg_get_*def` throughout rather than `information_schema`: it returns the
 * server's own reconstruction, which is complete where `information_schema`
 * truncates. `VIEW_DEFINITION` there is `NULL` for a view the caller does not
 * own, and a definition that silently becomes NULL is a usage that silently
 * disappears.
 *
 * Indexes are included because an expression index can name a column that
 * appears nowhere else, and dropping that column takes the index with it.
 */
function postgresCorpus(schema: string): string {
  const s = sqlLiteral(schema, 'postgres');
  return [
    `SELECT 'view' AS kind, n.nspname AS schema, n.nspname || '.' || c.relname AS label,
            pg_get_viewdef(c.oid, true) AS sql_text, NULL AS owner_table
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = ${s} AND c.relkind = 'v'`,

    `SELECT 'matview', n.nspname, n.nspname || '.' || c.relname,
            pg_get_viewdef(c.oid, true), NULL
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = ${s} AND c.relkind = 'm'`,

    // prosrc rather than pg_get_functiondef: the latter throws on aggregates
    // and window functions, and one throwing row fails the whole statement.
    `SELECT 'routine', n.nspname,
            n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')',
            p.prosrc, NULL
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = ${s} AND p.prokind IN ('f', 'p')`,

    `SELECT 'trigger', n.nspname,
            n.nspname || '.' || t.tgname || ' on ' || c.relname,
            pg_get_triggerdef(t.oid, true), c.relname
       FROM pg_trigger t
       JOIN pg_class c ON c.oid = t.tgrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = ${s} AND NOT t.tgisinternal`,

    `SELECT 'default', n.nspname,
            n.nspname || '.' || c.relname || '.' || a.attname,
            pg_get_expr(d.adbin, d.adrelid), c.relname
       FROM pg_attrdef d
       JOIN pg_class c ON c.oid = d.adrelid
       JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = ${s}`,

    `SELECT 'constraint', n.nspname,
            n.nspname || '.' || c.relname || '.' || con.conname,
            pg_get_constraintdef(con.oid, true), c.relname
       FROM pg_constraint con
       JOIN pg_class c ON c.oid = con.conrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = ${s}`,

    `SELECT 'index', n.nspname,
            n.nspname || '.' || i.relname,
            pg_get_indexdef(i.oid), c.relname
       FROM pg_index x
       JOIN pg_class i ON i.oid = x.indexrelid
       JOIN pg_class c ON c.oid = x.indrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = ${s}`,
  ].join('\nUNION ALL\n');
}

/**
 * SQL Server's corpus.
 *
 * `OBJECT_DEFINITION()` is the one call that returns the text of a view, a
 * procedure, a function or a trigger, so four of the branches are the same
 * shape with a different `type` filter. It returns NULL for an ENCRYPTED
 * module rather than throwing — the row still appears, with no text, which is
 * the honest answer: the dependency may exist and cannot be read.
 *
 * Foreign keys have no definition text, so one is synthesised, exactly as the
 * MySQL branch does. The dependency is real and a rename breaks it.
 *
 * Two kinds here have no analogue in the other engines and are the reason this
 * is worth doing properly rather than mapping PostgreSQL's query across:
 * **filtered indexes** carry a `WHERE` clause that can name a column appearing
 * nowhere else, and **computed columns** are an expression over other columns
 * that a `DROP COLUMN` silently breaks.
 */
function sqlserverCorpus(schema: string): string {
  const s = sqlLiteral(schema, 'sqlserver');
  return [
    `SELECT 'view' AS kind, sc.name AS [schema], sc.name + '.' + o.name AS label,
            OBJECT_DEFINITION(o.object_id) AS sql_text, NULL AS owner_table
       FROM sys.objects o JOIN sys.schemas sc ON sc.schema_id = o.schema_id
      WHERE sc.name = ${s} AND o.type = 'V'`,

    // P = procedure, FN = scalar function, IF/TF = inline / multi-statement
    // table-valued function.
    `SELECT 'routine', sc.name, sc.name + '.' + o.name,
            OBJECT_DEFINITION(o.object_id), NULL
       FROM sys.objects o JOIN sys.schemas sc ON sc.schema_id = o.schema_id
      WHERE sc.name = ${s} AND o.type IN ('P', 'FN', 'IF', 'TF')`,

    `SELECT 'trigger', sc.name, sc.name + '.' + t.name + ' on ' + p.name,
            OBJECT_DEFINITION(t.object_id), p.name
       FROM sys.triggers t
       JOIN sys.objects p ON p.object_id = t.parent_id
       JOIN sys.schemas sc ON sc.schema_id = p.schema_id
      WHERE sc.name = ${s} AND t.is_ms_shipped = 0`,

    `SELECT 'default', sc.name, sc.name + '.' + p.name + '.' + c.name,
            d.definition, p.name
       FROM sys.default_constraints d
       JOIN sys.objects p ON p.object_id = d.parent_object_id
       JOIN sys.columns c ON c.object_id = d.parent_object_id
                         AND c.column_id = d.parent_column_id
       JOIN sys.schemas sc ON sc.schema_id = p.schema_id
      WHERE sc.name = ${s}`,

    `SELECT 'constraint', sc.name, sc.name + '.' + p.name + '.' + k.name,
            k.definition, p.name
       FROM sys.check_constraints k
       JOIN sys.objects p ON p.object_id = k.parent_object_id
       JOIN sys.schemas sc ON sc.schema_id = p.schema_id
      WHERE sc.name = ${s}`,

    // No text to search, so it is written out — same reasoning as MySQL's.
    `SELECT 'constraint', sc.name, sc.name + '.' + p.name + '.' + fk.name,
            'FOREIGN KEY REFERENCES ' + rs.name + '.' + r.name, p.name
       FROM sys.foreign_keys fk
       JOIN sys.objects p ON p.object_id = fk.parent_object_id
       JOIN sys.objects r ON r.object_id = fk.referenced_object_id
       JOIN sys.schemas sc ON sc.schema_id = p.schema_id
       JOIN sys.schemas rs ON rs.schema_id = r.schema_id
      WHERE sc.name = ${s}`,

    // Only FILTERED indexes have text; an ordinary index names its columns in
    // the catalog, which the schema tree already shows.
    `SELECT 'index', sc.name, sc.name + '.' + p.name + '.' + i.name,
            i.filter_definition, p.name
       FROM sys.indexes i
       JOIN sys.objects p ON p.object_id = i.object_id AND p.type = 'U'
       JOIN sys.schemas sc ON sc.schema_id = p.schema_id
      WHERE sc.name = ${s} AND i.filter_definition IS NOT NULL`,

    `SELECT 'computed', sc.name, sc.name + '.' + p.name + '.' + cc.name,
            cc.definition, p.name
       FROM sys.computed_columns cc
       JOIN sys.objects p ON p.object_id = cc.object_id
       JOIN sys.schemas sc ON sc.schema_id = p.schema_id
      WHERE sc.name = ${s}`,
  ].join('\nUNION ALL\n');
}

/**
 * The one statement that collects everything searchable in a schema.
 *
 * Read-only throughout — every branch reads a catalog. This is what makes the
 * panel safe to open against production, which is the only place the question
 * is ever urgent.
 */
export function corpusSql(schema: string, engine: Engine): string {
  return engine === 'mysql' ? mysqlCorpus(schema)
    : engine === 'sqlserver' ? sqlserverCorpus(schema)
    : postgresCorpus(schema);
}
