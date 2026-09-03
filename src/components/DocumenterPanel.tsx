/**
 * 📘 Schema documenter.
 *
 * dbForge's Database Documenter produces a PDF. That is the wrong artefact:
 * a PDF is read once and then goes stale silently, because nobody notices it
 * disagreeing with the database.
 *
 * The document worth generating is one you **commit next to the migrations**,
 * so a schema change shows up as a diff in review. Everything here serves that:
 * Markdown is the primary format, the output is deterministically ordered, and
 * anything that changes between two runs of an unchanged schema (row estimates,
 * timestamps) is opt-in or absent.
 *
 * Rendering lives in utils/schemaDoc; this introspects and shows it.
 */
import { errorDisplay } from '../utils/appError';
import { can } from '../utils/engineCaps';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { QueryResult, Session } from '../types';
import { StatusIcon } from './StatusIcon';
import { escapeLiteral } from '../utils/sqlIdent';
import { toMarkdown, toHtmlDoc, docFileName } from '../utils/schemaDoc';
import type { SchemaDoc, DocTable, DocRoutine } from '../utils/schemaDoc';
import { saveTextAs } from '../utils/exportersIo';

interface Props {
  session: Session;
  schema: string | null;
  onClose: () => void;
}

type Format = 'md' | 'html';

export function DocumenterPanel({ session, schema, onClose }: Props) {
  const isMysql = session.engine === 'mysql';
  const isMssql = session.engine === 'sqlserver';
  const supported = can(session.engine, 'sqlDba');

  const [doc, setDoc] = useState<SchemaDoc | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [format, setFormat] = useState<Format>('md');
  const [rowCounts, setRowCounts] = useState(false);
  const [diagram, setDiagram] = useState(true);
  const [saved, setSaved] = useState<string | null>(null);

  const run = useCallback(
    (sql: string) => invoke<QueryResult>('monitor_query', { sessionId: session.sessionId, sql }),
    [session.sessionId],
  );

  const load = useCallback(async () => {
    if (!schema || !supported) return;
    setLoading(true);
    setError(null);
    setSaved(null);
    const s = escapeLiteral(schema, session.engine);
    try {
      // Four catalog queries rather than one join: information_schema joins are
      // slow enough on a large instance to look like a hang, and separate
      // queries let a missing privilege lose one section instead of everything.
      const colsSql = isMssql
        // sys.* rather than information_schema: the type keeps its length, and
        // extended properties are where SQL Server puts column comments — the
        // one place a schema's own prose lives.
        ? `SELECT o.name, c.name,
                  t.name + CASE
                    WHEN t.name IN ('varchar','nvarchar','char','nchar','binary','varbinary')
                      THEN '(' + CASE WHEN c.max_length = -1 THEN 'max'
                           ELSE CAST(c.max_length / CASE WHEN t.name LIKE 'n%' THEN 2 ELSE 1 END AS varchar(10))
                           END + ')'
                    WHEN t.name IN ('decimal','numeric')
                      THEN '(' + CAST(c.precision AS varchar(10)) + ',' + CAST(c.scale AS varchar(10)) + ')'
                    ELSE '' END,
                  CASE WHEN c.is_nullable = 1 THEN 'YES' ELSE 'NO' END,
                  CASE WHEN EXISTS (SELECT 1 FROM sys.index_columns ic
                                    JOIN sys.indexes i ON i.object_id = ic.object_id
                                                      AND i.index_id = ic.index_id
                                    WHERE ic.object_id = c.object_id
                                      AND ic.column_id = c.column_id
                                      AND i.is_primary_key = 1)
                       THEN 'PRI' ELSE '' END,
                  ISNULL(dc.definition, ''),
                  ISNULL(CAST(ep.value AS nvarchar(400)), '')
           FROM sys.columns c
           JOIN sys.objects o ON o.object_id = c.object_id AND o.type = 'U'
           JOIN sys.schemas sc ON sc.schema_id = o.schema_id
           JOIN sys.types t ON t.user_type_id = c.user_type_id
           LEFT JOIN sys.default_constraints dc ON dc.object_id = c.default_object_id
           LEFT JOIN sys.extended_properties ep ON ep.major_id = c.object_id
                                               AND ep.minor_id = c.column_id
                                               AND ep.name = 'MS_Description'
           WHERE sc.name = '${s}'
           ORDER BY o.name, c.column_id`
        : isMysql
        ? `SELECT table_name, column_name, column_type, is_nullable, column_key, column_default, column_comment
           FROM information_schema.columns WHERE table_schema = '${s}'
           ORDER BY table_name, ordinal_position`
        // pg_catalog rather than information_schema: format_type gives the
        // declared type (`varchar(50)`, `text[]`, a domain name) where
        // information_schema.data_type flattens it to `character varying`.
        : `SELECT c.relname, a.attname, format_type(a.atttypid, a.atttypmod),
                  CASE WHEN a.attnotnull THEN 'NO' ELSE 'YES' END, '',
                  pg_get_expr(d.adbin, d.adrelid),
                  COALESCE(col_description(c.oid, a.attnum), '')
           FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
           JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
           LEFT JOIN pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
           WHERE n.nspname = '${s}' AND c.relkind IN ('r', 'p')
           ORDER BY c.relname, a.attnum`;

      const tablesSql = isMssql
        ? `SELECT o.name, '',
                  ISNULL((SELECT SUM(p.row_count) FROM sys.dm_db_partition_stats p
                          WHERE p.object_id = o.object_id AND p.index_id IN (0,1)), 0),
                  ISNULL(CAST(ep.value AS nvarchar(400)), '')
           FROM sys.objects o
           JOIN sys.schemas sc ON sc.schema_id = o.schema_id
           LEFT JOIN sys.extended_properties ep ON ep.major_id = o.object_id
                                               AND ep.minor_id = 0
                                               AND ep.name = 'MS_Description'
           WHERE sc.name = '${s}' AND o.type = 'U'`
        : isMysql
        ? `SELECT table_name, engine, table_rows, table_comment
           FROM information_schema.tables WHERE table_schema = '${s}' AND table_type = 'BASE TABLE'`
        // relkind 'p' too, so a partitioned parent is documented rather than
        // appearing only as a scatter of partitions.
        : `SELECT c.relname, '', c.reltuples::bigint, COALESCE(obj_description(c.oid), '')
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = '${s}' AND c.relkind IN ('r', 'p')`;

      const idxSql = isMssql
        // INCLUDE columns are ordered AFTER the key columns and labelled.
        // Sorting by key_ordinal alone puts them first (they carry 0), which
        // documented `(country) INCLUDE (name)` as `(name, country)` — a
        // different index, and one that would not serve the same queries.
        ? `SELECT o.name, i.name,
                  CASE WHEN i.is_unique = 1 THEN 0 ELSE 1 END,
                  c.name + CASE WHEN ic.is_descending_key = 1 THEN ' DESC' ELSE '' END
                         + CASE WHEN ic.is_included_column = 1 THEN ' (included)' ELSE '' END,
                  i.is_primary_key,
                  CASE WHEN i.type_desc = 'CLUSTERED' THEN '' ELSE i.type_desc END,
                  ISNULL(i.filter_definition, '')
           FROM sys.indexes i
           JOIN sys.objects o ON o.object_id = i.object_id AND o.type = 'U'
           JOIN sys.schemas sc ON sc.schema_id = o.schema_id
           JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
           JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
           WHERE sc.name = '${s}' AND i.index_id > 0
           ORDER BY o.name, i.name, ic.is_included_column, ic.key_ordinal, ic.index_column_id`
        : isMysql
        ? `SELECT table_name, index_name, non_unique,
                  CONCAT(COALESCE(expression, column_name),
                         IF(collation = 'D', ' DESC', '')),
                  index_name = 'PRIMARY',
                  IF(index_type = 'BTREE', '', index_type), ''
           FROM information_schema.statistics WHERE table_schema = '${s}'
           ORDER BY table_name, index_name, seq_in_index`
        // pg_get_indexdef per column position rather than joining
        // pg_attribute: an expression index stores attnum 0, so the join would
        // drop `lower(name)` — and with it the whole index — without a word.
        : `SELECT t.relname, i.relname,
                  CASE WHEN ix.indisunique THEN 0 ELSE 1 END,
                  pg_get_indexdef(ix.indexrelid, k.ord::int, true)
                    || CASE WHEN ix.indoption[k.ord - 1] & 1 = 1 THEN ' DESC' ELSE '' END,
                  ix.indisprimary,
                  CASE WHEN am.amname = 'btree' THEN '' ELSE am.amname END,
                  COALESCE(pg_get_expr(ix.indpred, ix.indrelid), '')
           FROM pg_index ix
           JOIN pg_class t ON t.oid = ix.indrelid
           JOIN pg_class i ON i.oid = ix.indexrelid
           JOIN pg_am am ON am.oid = i.relam
           JOIN pg_namespace n ON n.oid = t.relnamespace
           JOIN unnest(ix.indkey) WITH ORDINALITY k(attnum, ord) ON true
           WHERE n.nspname = '${s}'
           ORDER BY t.relname, i.relname, k.ord`;

      const fkSql = isMssql
        // sys.foreign_key_columns pairs the sides directly, so a composite key
        // documents as (a, b) → (a, b) rather than the cartesian product the
        // information_schema route produces.
        ? `SELECT po.name, fk.name, pc.name, ro.name, rc.name
           FROM sys.foreign_keys fk
           JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
           JOIN sys.objects po ON po.object_id = fkc.parent_object_id
           JOIN sys.schemas sc ON sc.schema_id = po.schema_id
           JOIN sys.columns pc ON pc.object_id = fkc.parent_object_id
                              AND pc.column_id = fkc.parent_column_id
           JOIN sys.objects ro ON ro.object_id = fkc.referenced_object_id
           JOIN sys.columns rc ON rc.object_id = fkc.referenced_object_id
                              AND rc.column_id = fkc.referenced_column_id
           WHERE sc.name = '${s}'
           ORDER BY po.name, fk.name, fkc.constraint_column_id`
        : isMysql
        ? `SELECT table_name, constraint_name, column_name, referenced_table_name, referenced_column_name
           FROM information_schema.key_column_usage
           WHERE table_schema = '${s}' AND referenced_table_name IS NOT NULL
           ORDER BY table_name, constraint_name, ordinal_position`
        // pg_constraint, not information_schema: joining key_column_usage to
        // constraint_column_usage is a cartesian product per constraint, so a
        // two-column foreign key comes back as four rows and documents itself
        // as `(a, a, b, b) → (a, b, a, b)`. Zipping conkey against confkey by
        // ordinal is the only way to pair the sides correctly.
        : `SELECT t.relname, c.conname, a.attname, cf.relname, af.attname
           FROM pg_constraint c
           JOIN pg_class t ON t.oid = c.conrelid
           JOIN pg_namespace n ON n.oid = t.relnamespace
           JOIN pg_class cf ON cf.oid = c.confrelid
           JOIN unnest(c.conkey) WITH ORDINALITY k(attnum, ord) ON true
           JOIN unnest(c.confkey) WITH ORDINALITY fk(attnum, ord) ON fk.ord = k.ord
           JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
           JOIN pg_attribute af ON af.attrelid = c.confrelid AND af.attnum = fk.attnum
           WHERE c.contype = 'f' AND n.nspname = '${s}'
           ORDER BY t.relname, c.conname, k.ord`;

      const routSql = isMssql
        ? `SELECT o.name,
                  CASE WHEN o.type = 'P' THEN 'PROCEDURE' ELSE 'FUNCTION' END,
                  ISNULL(TYPE_NAME(r.user_type_id), ''), ''
           FROM sys.objects o
           JOIN sys.schemas sc ON sc.schema_id = o.schema_id
           LEFT JOIN sys.parameters r ON r.object_id = o.object_id
                                     AND r.is_output = 1 AND r.parameter_id = 0
           WHERE sc.name = '${s}' AND o.type IN ('P', 'FN', 'IF', 'TF')`
        : isMysql
        ? `SELECT routine_name, routine_type, dtd_identifier, routine_comment
           FROM information_schema.routines WHERE routine_schema = '${s}'`
        : `SELECT p.proname,
                  CASE WHEN p.prokind = 'p' THEN 'PROCEDURE' ELSE 'FUNCTION' END,
                  pg_get_function_result(p.oid), ''
           FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = '${s}'`;

      // information_schema.statistics.expression is MySQL 8.0.13+. Older
      // servers error on it, and `soft` would then drop every index without
      // saying so — a document that shows no indexes reads as a schema with no
      // indexes. Fall back to the columns every version has.
      const idxFallbackSql =
        `SELECT table_name, index_name, non_unique, column_name,
                index_name = 'PRIMARY', '', ''
         FROM information_schema.statistics WHERE table_schema = '${s}'
         ORDER BY table_name, index_name, seq_in_index`;

      // A missing privilege on one catalog loses that section, not the document.
      const soft = (p: Promise<QueryResult>) =>
        p.catch(() => ({ rows: [] } as unknown as QueryResult));

      const [tblR, colR, idxR, fkR, routR] = await Promise.all([
        run(tablesSql), run(colsSql),
        isMysql ? soft(run(idxSql).catch(() => run(idxFallbackSql))) : soft(run(idxSql)),
        soft(run(fkSql)), soft(run(routSql)),
      ]);

      const tables = new Map<string, DocTable>();
      for (const r of tblR.rows) {
        const name = String(r[0]);
        tables.set(name, {
          schema, name,
          engine: r[1] ? String(r[1]) : undefined,
          rows: r[2] == null ? undefined : Number(r[2]),
          comment: r[3] ? String(r[3]) : undefined,
          columns: [], indexes: [], foreignKeys: [],
        });
      }
      for (const r of colR.rows) {
        const t = tables.get(String(r[0]));
        if (!t) continue;
        t.columns.push({
          name: String(r[1]),
          type: String(r[2]),
          nullable: String(r[3]).toUpperCase() === 'YES',
          key: r[4] ? String(r[4]) : undefined,
          default: r[5] == null ? null : String(r[5]),
          comment: r[6] ? String(r[6]) : undefined,
        });
      }
      // Multi-column indexes and keys arrive one row per column, in order.
      for (const r of idxR.rows) {
        const t = tables.get(String(r[0]));
        if (!t) continue;
        const name = String(r[1]);
        let ix = t.indexes.find(x => x.name === name);
        if (!ix) {
          ix = {
            name, unique: String(r[2]) === '0', columns: [],
            method: r[5] ? String(r[5]) : undefined,
            where: r[6] ? String(r[6]) : undefined,
          };
          t.indexes.push(ix);
        }
        if (r[3] != null) ix.columns.push(String(r[3]));
        // PostgreSQL has no column_key, so the primary key is recovered from
        // its index — without this the Key column is blank on every PG table
        // and the document looks like the schema has no keys.
        if (r[4] === true || r[4] === 1 || String(r[4]) === 'true') {
          const col = t.columns.find(c => c.name === String(r[3]));
          if (col && !col.key) col.key = 'PRI';
        }
      }
      for (const r of fkR.rows) {
        const t = tables.get(String(r[0]));
        if (!t) continue;
        const name = String(r[1]);
        let fk = t.foreignKeys.find(x => x.name === name);
        if (!fk) {
          fk = { name, columns: [], refTable: String(r[3]), refColumns: [] };
          t.foreignKeys.push(fk);
        }
        if (r[2] != null) fk.columns.push(String(r[2]));
        if (r[4] != null) fk.refColumns.push(String(r[4]));
      }

      const routines: DocRoutine[] = routR.rows.map(r => ({
        schema,
        name: String(r[0]),
        kind: String(r[1] ?? 'FUNCTION'),
        returns: r[2] ? String(r[2]) : undefined,
        comment: r[3] ? String(r[3]) : undefined,
      }));

      setDoc({ schema, engine: session.engine, tables: [...tables.values()], routines });
    } catch (e) {
      setError(errorDisplay(e));
      setDoc(null);
    } finally {
      setLoading(false);
    }
  }, [schema, supported, isMysql, isMssql, run, session.engine]);

  useEffect(() => { void load(); }, [load]);

  const text = useMemo(() => {
    if (!doc) return '';
    const opts = { includeRowCounts: rowCounts, includeDiagram: diagram };
    return format === 'md' ? toMarkdown(doc, opts) : toHtmlDoc(doc, opts);
  }, [doc, format, rowCounts, diagram]);

  const save = async () => {
    if (!doc) return;
    const path = await saveTextAs(
      text, docFileName(doc.schema, format),
      format === 'md' ? 'Markdown' : 'HTML', [format]);
    if (path) setSaved(path);
  };

  const copy = async () => {
    await navigator.clipboard.writeText(text);
    setSaved('copied to clipboard');
  };

  const tableCount = doc?.tables.length ?? 0;
  const fkCount = doc?.tables.reduce((n, t) => n + t.foreignKeys.length, 0) ?? 0;

  return (
    <div className="doc">
      <div className="panel-header">
        <span className="panel-title">📘 Documenter</span>
        {schema && <span className="doc-schema">{schema}</span>}
        <div style={{ flex: 1 }} />
        <button className="toolbar-btn" onClick={() => void load()} disabled={loading || !schema}>
          Reload
        </button>
        <button className="icon-btn" onClick={onClose} title="Close">×</button>
      </div>

      {!supported && (
        <div className="doc-note">
          Documenting reads the catalog, so it needs MySQL or PostgreSQL.
        </div>
      )}
      {supported && !schema && <div className="doc-note">Select a database first.</div>}

      <div className="doc-controls">
        <div className="doc-seg" role="group" aria-label="Format">
          {(['md', 'html'] as Format[]).map(f => (
            <button key={f} className={`doc-seg-btn${format === f ? ' active' : ''}`}
                    onClick={() => setFormat(f)}>
              {f === 'md' ? 'Markdown' : 'HTML'}
            </button>
          ))}
        </div>
        <label className="doc-check">
          <input type="checkbox" checked={diagram}
                 onChange={e => setDiagram(e.target.checked)} />
          <span>Relationship diagram</span>
        </label>
        <label className="doc-check" data-tip="Row estimates drift on every write, so the document would diff on every run">
          <input type="checkbox" checked={rowCounts}
                 onChange={e => setRowCounts(e.target.checked)} />
          <span>Row estimates</span>
        </label>
        <div style={{ flex: 1 }} />
        <button className="toolbar-btn" onClick={() => void copy()} disabled={!doc}>Copy</button>
        <button className="primary" onClick={() => void save()} disabled={!doc}>Save…</button>
      </div>

      {/* The reason Markdown is first, stated where the choice is made. */}
      {format === 'md' && (
        <div className="doc-why">
          Ordered deterministically and free of timestamps, so regenerating an
          unchanged schema produces no diff — commit it next to the migrations.
        </div>
      )}

      {error && (
        <div className="doc-error"><StatusIcon kind="error" /> <span>{error}</span></div>
      )}

      {loading && <div className="doc-note">Reading the catalog…</div>}

      {doc && !loading && (
        <>
          <div className="doc-stats">
            <b>{tableCount}</b> table{tableCount === 1 ? '' : 's'}
            {' · '}<b>{doc.routines.length}</b> routine{doc.routines.length === 1 ? '' : 's'}
            {' · '}<b>{fkCount}</b> foreign key{fkCount === 1 ? '' : 's'}
            {saved && <span className="doc-saved"><StatusIcon kind="ok" /> {saved}</span>}
          </div>
          <pre className="doc-preview">{text}</pre>
        </>
      )}
    </div>
  );
}
