/**
 * Keyword, function, and statement-template catalogs for editor hinting.
 * Curated (not exhaustive) — the goal is that everything a working DBA types
 * daily completes, with signatures as detail text.
 *
 * Functions carry a `snippet` ("COUNT(${})") applied via CodeMirror's snippet
 * support so the caret lands between the parens.
 */
import type { Engine } from '../types';

export interface KeywordItem {
  label: string;
  detail?: string;
  /** snippet text — presence makes this a snippetCompletion */
  snippet?: string;
  type: 'keyword' | 'function' | 'text';
  boost?: number;
}

// ── Keywords (shared core + per-engine extras) ────────────────────────────────

const CORE_KEYWORDS = [
  'SELECT', 'FROM', 'WHERE', 'GROUP BY', 'ORDER BY', 'HAVING', 'LIMIT',
  'JOIN', 'LEFT JOIN', 'RIGHT JOIN', 'INNER JOIN', 'CROSS JOIN',
  'ON', 'USING', 'AS', 'AND', 'OR', 'NOT', 'IN', 'EXISTS', 'BETWEEN',
  'LIKE', 'IS NULL', 'IS NOT NULL', 'DISTINCT', 'UNION', 'UNION ALL',
  'CASE', 'WHEN', 'THEN', 'ELSE', 'END',
  'INSERT INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE FROM',
  'CREATE TABLE', 'CREATE INDEX', 'CREATE VIEW', 'ALTER TABLE',
  'DROP TABLE', 'DROP INDEX', 'PRIMARY KEY', 'FOREIGN KEY', 'REFERENCES',
  'DEFAULT', 'WITH', 'WITH RECURSIVE', 'OVER', 'PARTITION BY',
  'ASC', 'DESC', 'OFFSET', 'EXPLAIN', 'BEGIN', 'COMMIT', 'ROLLBACK',
  'NULL', 'TRUE', 'FALSE', 'INTERVAL', 'CAST',
];

/** Everything the MySQL protocol family shares, MariaDB included. */
const MYSQL_KEYWORDS = [
  'SHOW', 'USE', 'DESCRIBE', 'EXPLAIN FORMAT=JSON',
  'STRAIGHT_JOIN', 'ON DUPLICATE KEY UPDATE', 'INSERT IGNORE INTO',
  // GROUP_CONCAT is a function, and is listed as one below with its
  // signature — having it here too put it in the dropdown twice.
  'REPLACE INTO', 'AUTO_INCREMENT', 'ENGINE=InnoDB',
  'CHARACTER SET', 'COLLATE', 'FOR UPDATE', 'LOCK IN SHARE MODE',
  'SQL_NO_CACHE', 'PARTITION',
];

/**
 * MySQL and Percona, but not MariaDB.
 *
 * `EXPLAIN ANALYZE` is the whole reason this list exists: MariaDB has no such
 * statement — its measured plan is `ANALYZE` — so completing it there offers a
 * syntax error, which is worse than offering nothing.
 */
const MYSQL_ONLY_KEYWORDS = [
  'EXPLAIN ANALYZE',
  // JSON — the `->`/`->>` path operators and array membership read poorly typed
  // from memory; offering them (with the arrow forms) is the quick win.
  'MEMBER OF ()', 'CAST( AS JSON)', "->'$.'", "->>'$.'",
];

/**
 * MariaDB's own vocabulary.
 *
 * All verified against MariaDB 11.8 and, where the version matters, 10.6.
 * These are the statements someone reaches for on MariaDB and finds the editor
 * has never heard of — sequences above all, since MariaDB has real ones and
 * MySQL has none.
 */
const MARIADB_KEYWORDS = [
  // The measured plan. MariaDB spells it ANALYZE, not EXPLAIN ANALYZE.
  'ANALYZE FORMAT=JSON',
  // 10.5+. Turns an insert-then-select into one statement.
  'RETURNING',
  // MariaDB-only, and the thing that makes routine and view edits safe here
  // in a way they are not on MySQL.
  'CREATE OR REPLACE TABLE', 'CREATE OR REPLACE VIEW',
  'CREATE OR REPLACE SEQUENCE',
  // Sequences — 10.3+.
  'CREATE SEQUENCE', 'ALTER SEQUENCE', 'DROP SEQUENCE',
  'NEXT VALUE FOR', 'PREVIOUS VALUE FOR',
  // System-versioned (temporal) tables — 10.3+.
  'WITH SYSTEM VERSIONING', 'FOR SYSTEM_TIME AS OF',
  'FOR SYSTEM_TIME BETWEEN', 'FOR SYSTEM_TIME ALL',
  'WITHOUT SYSTEM VERSIONING',
  // Set operators MariaDB has had since 10.3.
  'EXCEPT', 'INTERSECT',
  'INVISIBLE',
];

const MARIADB_FUNCTIONS: FnDef[] = [
  ['NEXTVAL', 'NEXTVAL(sequence) — take the next value'],
  ['LASTVAL', 'LASTVAL(sequence) — the last value this connection took'],
  ['SETVAL', 'SETVAL(sequence, value [, is_used [, round]])'],
  ['JSON_VALID', 'JSON_VALID(expr) — the check that marks a MariaDB JSON column'],
  ['REGEXP_REPLACE', 'REGEXP_REPLACE(subject, pattern, replace)'],
  ['SYS_GUID', 'SYS_GUID() — a UUID with no dashes'],
];

const PG_KEYWORDS = [
  'RETURNING', 'ILIKE', 'EXPLAIN ANALYZE', 'EXPLAIN (ANALYZE, BUFFERS)',
  'ON CONFLICT', 'ON CONFLICT DO NOTHING', 'ON CONFLICT DO UPDATE SET',
  'FULL OUTER JOIN', 'LATERAL', 'TABLESAMPLE', 'FOR UPDATE', 'FOR SHARE',
  'FETCH FIRST', 'WINDOW', 'FILTER (WHERE )', 'VACUUM', 'ANALYZE',
  'ARRAY', 'ANY', 'ALL', 'IS DISTINCT FROM',
  // pgvector — the AI/RAG workload. Types, the ANN index methods + operator
  // classes, the distance operators, and ready-made index / KNN templates.
  'CREATE EXTENSION IF NOT EXISTS vector',
  'vector', 'halfvec', 'sparsevec', 'bit',
  'USING hnsw', 'USING ivfflat',
  'vector_l2_ops', 'vector_cosine_ops', 'vector_ip_ops', 'vector_l1_ops',
  'halfvec_l2_ops', 'halfvec_cosine_ops', 'bit_hamming_ops',
  "<-> /* L2 distance */", "<=> /* cosine distance */", "<#> /* negative inner product */",
  'CREATE INDEX ON t USING hnsw (embedding vector_cosine_ops)',
  'CREATE INDEX ON t USING ivfflat (embedding vector_l2_ops) WITH (lists = 100)',
  'ORDER BY embedding <=> :query LIMIT 10',
  'SET hnsw.ef_search', 'SET ivfflat.probes',
];

// ClickHouse DDL vocabulary: the table-engine family, column CODECs, and the
// MergeTree clauses — the pieces you write inside a CREATE TABLE and that no
// generic SQL keyword list carries. Engines and codecs are the gap #9 items.
const CH_KEYWORDS = [
  // MergeTree family + the other common table engines
  'ENGINE = MergeTree()', 'ENGINE = ReplacingMergeTree()', 'ENGINE = SummingMergeTree()',
  'ENGINE = AggregatingMergeTree()', 'ENGINE = CollapsingMergeTree()',
  'ENGINE = VersionedCollapsingMergeTree()', 'ENGINE = GraphiteMergeTree()',
  'ENGINE = ReplicatedMergeTree()', 'ENGINE = ReplicatedReplacingMergeTree()',
  'ENGINE = Distributed()', 'ENGINE = Memory()', 'ENGINE = Log()', 'ENGINE = TinyLog()',
  'ENGINE = StripeLog()', 'ENGINE = Buffer()', 'ENGINE = Dictionary()', 'ENGINE = Null()',
  'ENGINE = Set()', 'ENGINE = Join()', 'ENGINE = MaterializedView()', 'ENGINE = View()',
  'ENGINE = MySQL()', 'ENGINE = PostgreSQL()', 'ENGINE = S3()', 'ENGINE = Kafka()',
  // MergeTree clauses
  'PARTITION BY', 'ORDER BY', 'PRIMARY KEY', 'SAMPLE BY', 'TTL', 'SETTINGS',
  'ON CLUSTER', 'MATERIALIZED', 'ALIAS', 'DEFAULT', 'EPHEMERAL',
  // Column compression codecs — CODEC(...) wrapper and each codec name
  'CODEC(ZSTD)', 'CODEC(ZSTD(3))', 'CODEC(LZ4)', 'CODEC(LZ4HC)', 'CODEC(NONE)',
  'CODEC(Delta)', 'CODEC(Delta, ZSTD)', 'CODEC(DoubleDelta)', 'CODEC(DoubleDelta, ZSTD)',
  'CODEC(Gorilla)', 'CODEC(T64)', 'CODEC(FPC)', 'CODEC(GCD)',
  'ZSTD', 'LZ4', 'LZ4HC', 'Delta', 'DoubleDelta', 'Gorilla', 'T64', 'FPC', 'GCD',
  // Type wrappers you reach for constantly in CH DDL
  'LowCardinality(', 'Nullable(', 'Array(', 'Map(', 'Tuple(', 'FixedString(', 'Decimal(',
];

// ── Functions (label = name, detail = signature hint) ─────────────────────────

type FnDef = [name: string, sig: string];

const CORE_FUNCTIONS: FnDef[] = [
  ['COUNT', 'COUNT(*) | COUNT(expr)'],
  ['SUM', 'SUM(expr)'],
  ['AVG', 'AVG(expr)'],
  ['MIN', 'MIN(expr)'],
  ['MAX', 'MAX(expr)'],
  ['COALESCE', 'COALESCE(a, b, …)'],
  ['NULLIF', 'NULLIF(a, b)'],
  ['CONCAT', 'CONCAT(a, b, …)'],
  ['CONCAT_WS', 'CONCAT_WS(sep, a, b, …)'],
  ['SUBSTRING', 'SUBSTRING(str, pos, len)'],
  ['LENGTH', 'LENGTH(str)'],
  ['CHAR_LENGTH', 'CHAR_LENGTH(str)'],
  ['LOWER', 'LOWER(str)'],
  ['UPPER', 'UPPER(str)'],
  ['TRIM', 'TRIM(str)'],
  ['REPLACE', 'REPLACE(str, from, to)'],
  ['LEFT', 'LEFT(str, n)'],
  ['RIGHT', 'RIGHT(str, n)'],
  ['LPAD', 'LPAD(str, len, pad)'],
  ['RPAD', 'RPAD(str, len, pad)'],
  ['ROUND', 'ROUND(x, d)'],
  ['FLOOR', 'FLOOR(x)'],
  ['CEIL', 'CEIL(x)'],
  ['ABS', 'ABS(x)'],
  ['MOD', 'MOD(a, b)'],
  ['NOW', 'NOW()'],
  ['ROW_NUMBER', 'ROW_NUMBER() OVER (…)'],
  ['RANK', 'RANK() OVER (…)'],
  ['DENSE_RANK', 'DENSE_RANK() OVER (…)'],
  ['LAG', 'LAG(expr [, n]) OVER (…)'],
  ['LEAD', 'LEAD(expr [, n]) OVER (…)'],
  ['FIRST_VALUE', 'FIRST_VALUE(expr) OVER (…)'],
  ['LAST_VALUE', 'LAST_VALUE(expr) OVER (…)'],
  ['NTILE', 'NTILE(n) OVER (…)'],
  ['MD5', 'MD5(str)'],
];

const MYSQL_FUNCTIONS: FnDef[] = [
  ['IFNULL', 'IFNULL(a, b)'],
  ['IF', 'IF(cond, then, else)'],
  ['GROUP_CONCAT', "GROUP_CONCAT(expr SEPARATOR ',')"],
  ['DATE_FORMAT', "DATE_FORMAT(dt, '%Y-%m-%d')"],
  ['STR_TO_DATE', "STR_TO_DATE(str, '%Y-%m-%d')"],
  ['DATE_ADD', 'DATE_ADD(dt, INTERVAL n unit)'],
  ['DATE_SUB', 'DATE_SUB(dt, INTERVAL n unit)'],
  ['DATEDIFF', 'DATEDIFF(a, b) → days'],
  ['TIMESTAMPDIFF', 'TIMESTAMPDIFF(unit, a, b)'],
  ['UNIX_TIMESTAMP', 'UNIX_TIMESTAMP([dt])'],
  ['FROM_UNIXTIME', 'FROM_UNIXTIME(ts)'],
  ['CURDATE', 'CURDATE()'],
  ['YEAR', 'YEAR(dt)'],
  ['MONTH', 'MONTH(dt)'],
  ['DAY', 'DAY(dt)'],
  ['HOUR', 'HOUR(dt)'],
  ['LAST_INSERT_ID', 'LAST_INSERT_ID()'],
  ['JSON_EXTRACT', "JSON_EXTRACT(js, '$.path')"],
  ['JSON_UNQUOTE', 'JSON_UNQUOTE(js)'],
  ['JSON_OBJECT', "JSON_OBJECT('k', v, …)"],
  ['JSON_ARRAYAGG', 'JSON_ARRAYAGG(expr)'],
  ['JSON_OBJECTAGG', "JSON_OBJECTAGG(k, v)"],
  ['JSON_ARRAY', 'JSON_ARRAY(v, …)'],
  ['JSON_VALUE', "JSON_VALUE(js, '$.path' RETURNING type)"],
  ['JSON_TABLE', "JSON_TABLE(js, '$[*]' COLUMNS (…)) AS t"],
  ['JSON_CONTAINS', "JSON_CONTAINS(js, val, '$.path')"],
  ['JSON_CONTAINS_PATH', "JSON_CONTAINS_PATH(js, 'one'|'all', '$.path')"],
  ['JSON_OVERLAPS', 'JSON_OVERLAPS(a, b)'],
  ['JSON_KEYS', "JSON_KEYS(js, '$.path')"],
  ['JSON_LENGTH', "JSON_LENGTH(js, '$.path')"],
  ['JSON_DEPTH', 'JSON_DEPTH(js)'],
  ['JSON_TYPE', 'JSON_TYPE(js)'],
  ['JSON_QUOTE', 'JSON_QUOTE(str)'],
  ['JSON_PRETTY', 'JSON_PRETTY(js)'],
  ['JSON_SEARCH', "JSON_SEARCH(js, 'one'|'all', 'needle')"],
  ['JSON_SET', "JSON_SET(js, '$.path', val)"],
  ['JSON_INSERT', "JSON_INSERT(js, '$.path', val)"],
  ['JSON_REPLACE', "JSON_REPLACE(js, '$.path', val)"],
  ['JSON_REMOVE', "JSON_REMOVE(js, '$.path')"],
  ['JSON_MERGE_PATCH', 'JSON_MERGE_PATCH(a, b)'],
  ['JSON_MERGE_PRESERVE', 'JSON_MERGE_PRESERVE(a, b)'],
  ['CONVERT', 'CONVERT(expr, type)'],
  ['UUID', 'UUID()'],
  ['DATABASE', 'DATABASE()'],
  ['VERSION', 'VERSION()'],
  ['RAND', 'RAND()'],
  ['SLEEP', 'SLEEP(seconds)'],
];

const PG_FUNCTIONS: FnDef[] = [
  ['STRING_AGG', "STRING_AGG(expr, ',')"],
  ['ARRAY_AGG', 'ARRAY_AGG(expr)'],
  ['JSONB_AGG', 'JSONB_AGG(expr)'],
  ['JSON_BUILD_OBJECT', "JSON_BUILD_OBJECT('k', v, …)"],
  ['JSONB_SET', 'JSONB_SET(js, path, val)'],
  ['DATE_TRUNC', "DATE_TRUNC('day', ts)"],
  ['DATE_PART', "DATE_PART('hour', ts)"],
  ['EXTRACT', 'EXTRACT(EPOCH FROM ts)'],
  ['TO_CHAR', "TO_CHAR(ts, 'YYYY-MM-DD')"],
  ['TO_DATE', "TO_DATE(str, 'YYYY-MM-DD')"],
  ['TO_TIMESTAMP', 'TO_TIMESTAMP(epoch)'],
  ['AGE', 'AGE(a [, b])'],
  ['GENERATE_SERIES', 'GENERATE_SERIES(from, to [, step])'],
  ['UNNEST', 'UNNEST(array)'],
  ['ARRAY_LENGTH', 'ARRAY_LENGTH(arr, dim)'],
  ['SPLIT_PART', "SPLIT_PART(str, ',', n)"],
  ['REGEXP_REPLACE', "REGEXP_REPLACE(str, re, to [, 'g'])"],
  ['INITCAP', 'INITCAP(str)'],
  ['POSITION', 'POSITION(sub IN str)'],
  ['GREATEST', 'GREATEST(a, b, …)'],
  ['LEAST', 'LEAST(a, b, …)'],
  ['PERCENTILE_CONT', 'PERCENTILE_CONT(f) WITHIN GROUP (ORDER BY x)'],
  ['GEN_RANDOM_UUID', 'GEN_RANDOM_UUID()'],
  ['CURRENT_DATABASE', 'CURRENT_DATABASE()'],
  ['PG_SLEEP', 'PG_SLEEP(seconds)'],
  ['PG_SIZE_PRETTY', 'PG_SIZE_PRETTY(bytes)'],
  ['PG_TOTAL_RELATION_SIZE', "PG_TOTAL_RELATION_SIZE('tbl')"],
  ['RANDOM', 'RANDOM()'],
  ['VERSION', 'VERSION()'],

  // ── PostGIS (ST_*) — only meaningful with the postgis extension, but the
  //    functions are Postgres-only so they ride the PG catalog. Curated to the
  //    calls that actually show up: construct, reproject, measure, relate.
  ['ST_AsText', 'ST_AsText(geom)'],
  ['ST_GeomFromText', "ST_GeomFromText('WKT' [, srid])"],
  ['ST_SetSRID', 'ST_SetSRID(geom, srid)'],
  ['ST_SRID', 'ST_SRID(geom)'],
  ['ST_Transform', 'ST_Transform(geom, srid)'],
  ['ST_X', 'ST_X(point)'],
  ['ST_Y', 'ST_Y(point)'],
  ['ST_Distance', 'ST_Distance(a, b)'],
  ['ST_DWithin', 'ST_DWithin(a, b, distance)'],
  ['ST_Intersects', 'ST_Intersects(a, b)'],
  ['ST_Contains', 'ST_Contains(a, b)'],
  ['ST_Within', 'ST_Within(a, b)'],
  ['ST_Buffer', 'ST_Buffer(geom, radius)'],
  ['ST_Area', 'ST_Area(geom)'],
  ['ST_Length', 'ST_Length(geom)'],
  ['ST_Centroid', 'ST_Centroid(geom)'],
  ['ST_MakePoint', 'ST_MakePoint(x, y [, z])'],
  ['ST_Point', 'ST_Point(x, y [, srid])'],
  ['ST_AsGeoJSON', 'ST_AsGeoJSON(geom)'],
  ['ST_GeomFromGeoJSON', 'ST_GeomFromGeoJSON(json)'],
  ['ST_Union', 'ST_Union(a, b) | ST_Union(geom_set)'],
  ['ST_Simplify', 'ST_Simplify(geom, tolerance)'],
  ['ST_Envelope', 'ST_Envelope(geom)'],
  ['ST_IsValid', 'ST_IsValid(geom)'],
  ['ST_MakeValid', 'ST_MakeValid(geom)'],
];

/**
 * DuckDB — Postgres-flavoured core plus its own vocabulary: the file readers
 * (the reason half the connections exist), PIVOT, and the catalog functions.
 * pgvector/PG-only DDL deliberately absent.
 */
const DUCKDB_KEYWORDS = [
  'RETURNING', 'ILIKE', 'EXPLAIN ANALYZE', 'ON CONFLICT', 'ON CONFLICT DO NOTHING',
  'EXCEPT', 'INTERSECT', 'QUALIFY', 'EXCLUDE', 'REPLACE',
  'PIVOT', 'UNPIVOT', 'POSITIONAL JOIN', 'ASOF JOIN', 'SEMI JOIN', 'ANTI JOIN',
  'WINDOW', 'FILTER (WHERE )', 'TABLESAMPLE', 'FETCH FIRST', 'IS DISTINCT FROM',
  'ATTACH', 'DETACH', 'USE', 'INSTALL', 'LOAD', 'FORCE INSTALL',
  'CREATE MACRO', 'CREATE OR REPLACE MACRO', 'CREATE SECRET', 'CREATE SEQUENCE',
  'CHECKPOINT', 'VACUUM', 'ANALYZE', 'SUMMARIZE', 'DESCRIBE',
  'COPY TO', 'COPY FROM', 'EXPORT DATABASE', 'IMPORT DATABASE',
];

const DUCKDB_FUNCTIONS: FnDef[] = [
  ['READ_PARQUET', "READ_PARQUET('file.parquet' [, …])"],
  ['READ_CSV', "READ_CSV('file.csv' [, header => true])"],
  ['READ_JSON', "READ_JSON('file.json')"],
  ['STRING_AGG', "STRING_AGG(expr, ',')"],
  ['ARRAY_AGG', 'ARRAY_AGG(expr)'],
  ['LIST_AGG', "LIST_AGG(expr [, ','])"],
  ['UNNEST', 'UNNEST(list)'],
  ['GENERATE_SERIES', 'GENERATE_SERIES(from, to [, step])'],
  ['RANGE', 'RANGE(from, to [, step])'],
  ['DATE_TRUNC', "DATE_TRUNC('day', ts)"],
  ['DATE_PART', "DATE_PART('hour', ts)"],
  ['EPOCH', 'EPOCH(ts)'],
  ['STRFTIME', "STRFTIME(ts, '%Y-%m-%d')"],
  ['STRPTIME', "STRPTIME(str, '%Y-%m-%d')"],
  ['REGEXP_REPLACE', "REGEXP_REPLACE(str, re, to [, 'g'])"],
  ['GREATEST', 'GREATEST(a, b, …)'],
  ['LEAST', 'LEAST(a, b, …)'],
  ['QUANTILE_CONT', 'QUANTILE_CONT(x, q)'],
  ['QUANTILE_DISC', 'QUANTILE_DISC(x, q)'],
  ['MEDIAN', 'MEDIAN(x)'],
  ['APPROX_COUNT_DISTINCT', 'APPROX_COUNT_DISTINCT(x)'],
  ['STRUCT_PACK', "STRUCT_PACK(k := v, …)"],
  ['LIST_VALUE', 'LIST_VALUE(a, b, …)'],
  ['UUID', 'UUID()'],
  ['VERSION', 'VERSION()'],
  ['CURRENT_DATABASE', 'CURRENT_DATABASE()'],
  ['CURRENT_SCHEMA', 'CURRENT_SCHEMA()'],
];

/**
 * T-SQL (SQL Server) — the vocabulary that simply does not exist on the other
 * engines: TOP instead of LIMIT, the OUTPUT clause, CROSS/OUTER APPLY, MERGE,
 * TRY/CATCH blocks, and the identity/temp-table idioms.
 */
const TSQL_KEYWORDS = [
  // TOP is T-SQL's LIMIT — the single most-typed difference.
  'TOP', 'SELECT TOP 100 * FROM', 'OFFSET FETCH',
  // The OUTPUT clause (INSERT/UPDATE/DELETE/MERGE) — DML with a result set.
  'OUTPUT INSERTED.*', 'OUTPUT DELETED.*', 'OUTPUT INSERTED.*, DELETED.*',
  // APPLY — LATERAL, T-SQL spelling.
  'CROSS APPLY', 'OUTER APPLY',
  // Upsert.
  'MERGE INTO', 'WHEN MATCHED THEN UPDATE SET', 'WHEN NOT MATCHED THEN INSERT',
  // Identity + sequences.
  'IDENTITY(1,1)', 'NEXT VALUE FOR', 'CREATE SEQUENCE',
  // Temp tables and table variables — everyday T-SQL.
  'CREATE TABLE #', 'DECLARE @', 'SET @', 'DECLARE @t TABLE',
  // Procedural blocks.
  'BEGIN TRY', 'END TRY', 'BEGIN CATCH', 'END CATCH',
  'BEGIN TRANSACTION', 'IF EXISTS', 'IF NOT EXISTS', 'WHILE', 'GOTO',
  'THROW', 'RAISERROR', 'PRINT',
  // DDL flavours.
  'CREATE OR ALTER PROCEDURE', 'CREATE OR ALTER VIEW', 'CREATE OR ALTER FUNCTION',
  'DROP TABLE IF EXISTS', 'DROP PROCEDURE IF EXISTS', 'DROP VIEW IF EXISTS',
  // Execution plans.
  'SET STATISTICS IO ON', 'SET STATISTICS TIME ON', 'SET SHOWPLAN_XML ON',
  'SET NOCOUNT ON', 'SET XACT_ABORT ON',
  // Isolation + locking hints you actually type.
  'WITH (NOLOCK)', 'READ COMMITTED SNAPSHOT', 'SNAPSHOT',
  'SET TRANSACTION ISOLATION LEVEL',
  // Admin.
  'BULK INSERT', 'BACKUP DATABASE', 'RESTORE DATABASE', 'DBCC',
  'EXEC', 'EXEC sp_executesql', 'USE',
  // PIVOT exists here too (very different shape from DuckDB's).
  'PIVOT', 'UNPIVOT', 'FOR SYSTEM_TIME', 'EXCEPT', 'INTERSECT',
];

const TSQL_FUNCTIONS: FnDef[] = [
  ['GETDATE', 'GETDATE() — server clock, datetime'],
  ['SYSDATETIME', 'SYSDATETIME() — server clock, datetime2(7)'],
  ['GETUTCDATE', 'GETUTCDATE()'],
  ['DATEADD', 'DATEADD(day, n, dt)'],
  ['DATEDIFF', 'DATEDIFF(day, from, to) → int'],
  ['DATEDIFF_BIG', 'DATEDIFF_BIG(second, from, to) → bigint'],
  ['DATEPART', 'DATEPART(weekday, dt)'],
  ['DATENAME', "DATENAME(month, dt) → 'January'"],
  ['EOMONTH', 'EOMONTH(dt [, months]) — last day of the month'],
  ['DATEFROMPARTS', 'DATEFROMPARTS(y, m, d)'],
  // ISNULL is two-argument and type-coercing; COALESCE is the standard one.
  // Both complete — you meet both in real code — with the difference in the
  // detail text so picking between them is an informed act.
  ['ISNULL', 'ISNULL(a, b) — 2 args, type of the FIRST argument wins'],
  ['IIF', 'IIF(cond, then, else)'],
  ['CHOOSE', 'CHOOSE(n, v1, v2, …)'],
  ['STRING_AGG', "STRING_AGG(expr, ',') [WITHIN GROUP (ORDER BY x)]"],
  ['STRING_SPLIT', "STRING_SPLIT(str, ',') — table-valued"],
  ['FORMAT', "FORMAT(x, 'yyyy-MM-dd' [, culture]) — slow in bulk; CONVERT for hot paths"],
  ['CONVERT', "CONVERT(varchar(10), dt, 23) — style codes do the formatting"],
  ['TRY_CONVERT', 'TRY_CONVERT(type, expr) — NULL instead of an error'],
  ['TRY_CAST', 'TRY_CAST(expr AS type)'],
  ['PARSE', "PARSE(str AS type [USING culture])"],
  ['LEN', 'LEN(str) — trailing spaces not counted'],
  ['DATALENGTH', 'DATALENGTH(x) — bytes'],
  ['CHARINDEX', "CHARINDEX('needle', str [, start])"],
  ['PATINDEX', "PATINDEX('%pattern%', str)"],
  ['REPLICATE', 'REPLICATE(str, n)'],
  ['STUFF', 'STUFF(str, start, len, replacement)'],
  ['STRING_ESCAPE', "STRING_ESCAPE(str, 'json')"],
  ['QUOTENAME', 'QUOTENAME(name) — brackets, escaped'],
  ['NEWID', 'NEWID() — a random GUID'],
  ['NEWSEQUENTIALID', 'NEWSEQUENTIALID()'],
  ['SCOPE_IDENTITY', 'SCOPE_IDENTITY() — the IDENTITY this statement made'],
  ['IDENT_CURRENT', "IDENT_CURRENT('table')"],
  ['CHECKSUM', 'CHECKSUM(expr, …)'],
  ['HASHBYTES', "HASHBYTES('SHA2_256', expr)"],
  ['COMPRESS', 'COMPRESS(expr) — gzip into varbinary'],
  ['DECOMPRESS', 'DECOMPRESS(bin)'],
  ['JSON_VALUE', "JSON_VALUE(js, '$.path')"],
  ['JSON_QUERY', "JSON_QUERY(js, '$.path') — object/array, not scalar"],
  ['JSON_MODIFY', "JSON_MODIFY(js, '$.path', val)"],
  ['OPENJSON', "OPENJSON(js [, '$.path']) — table-valued"],
  ['ISJSON', 'ISJSON(expr)'],
  ['OBJECT_ID', "OBJECT_ID('schema.table')"],
  ['OBJECT_NAME', 'OBJECT_NAME(id)'],
  ['DB_NAME', 'DB_NAME([id])'],
  ['SCHEMA_NAME', 'SCHEMA_NAME([id])'],
  ['SUSER_NAME', 'SUSER_NAME()'],
  ['HOST_NAME', 'HOST_NAME()'],
  ['APP_NAME', 'APP_NAME()'],
  ['ERROR_MESSAGE', 'ERROR_MESSAGE() — inside a CATCH block'],
  ['ERROR_LINE', 'ERROR_LINE()'],
  ['ERROR_NUMBER', 'ERROR_NUMBER()'],
  ['XACT_STATE', 'XACT_STATE() — -1 doomed, 0 none, 1 committable'],
  ['TRANSLATE', 'TRANSLATE(str, from_chars, to_chars)'],
];

// ── Statement templates (statement-start suggestions) ─────────────────────────

export interface TemplateItem {
  label: string;
  detail: string;
  snippet: string;
}

export const STATEMENT_TEMPLATES: TemplateItem[] = [
  { label: 'sel', detail: 'SELECT * FROM … WHERE …',
    snippet: 'SELECT *\nFROM ${table}\nWHERE ${cond}' },
  { label: 'selc', detail: 'SELECT COUNT(*) FROM …',
    snippet: 'SELECT COUNT(*) FROM ${table}' },
  { label: 'ins', detail: 'INSERT INTO … VALUES …',
    snippet: 'INSERT INTO ${table} (${cols})\nVALUES (${vals})' },
  { label: 'upd', detail: 'UPDATE … SET … WHERE …',
    snippet: 'UPDATE ${table}\nSET ${col} = ${val}\nWHERE ${cond}' },
  { label: 'del', detail: 'DELETE FROM … WHERE …',
    snippet: 'DELETE FROM ${table}\nWHERE ${cond}' },
  { label: 'cte', detail: 'WITH … AS (…) SELECT …',
    snippet: 'WITH ${name} AS (\n  SELECT ${cols}\n  FROM ${table}\n)\nSELECT * FROM ${name}' },
  { label: 'topn', detail: 'top-N per group (window)',
    snippet: 'SELECT * FROM (\n  SELECT t.*, ROW_NUMBER() OVER (PARTITION BY ${group} ORDER BY ${metric} DESC) AS rn\n  FROM ${table} t\n) x WHERE rn <= ${n}' },
];

// ── Statement shortcuts (word → whole DBA statement) ──────────────────────────
// Label = the shortcut, so CodeMirror's prefix matching fires mid-word ("pro"
// → "processlist"); apply = the full statement (no trailing semicolon).

export interface StatementShortcut {
  shortcut: string;
  statement: string;
  detail: string;
  /** Engines this shortcut is offered on. Not every entry is SQL —
   *  Parquet's are driver commands (see db/parquet.rs). */
  engines: Engine[];
}

export const STATEMENT_SHORTCUTS: StatementShortcut[] = [
  // SQLite — the pragma table-valued functions, which are the whole catalog.
  { shortcut: 'tables',   statement: "SELECT type, name, tbl_name FROM sqlite_master WHERE type IN ('table','view') ORDER BY name", detail: 'every table and view', engines: ['sqlite'] },
  { shortcut: 'columns',  statement: 'SELECT m.name AS "table", p.name AS column, p.type, p."notnull", p.dflt_value, p.pk\n  FROM sqlite_master m JOIN pragma_table_info(m.name) p\n WHERE m.type = \'table\' ORDER BY m.name, p.cid', detail: 'columns of every table', engines: ['sqlite'] },
  { shortcut: 'indexes',  statement: 'SELECT m.name AS "table", i.name AS index_name, i."unique", i.origin, i.partial\n  FROM sqlite_master m JOIN pragma_index_list(m.name) i\n WHERE m.type = \'table\' ORDER BY m.name, i.name', detail: 'indexes of every table', engines: ['sqlite'] },
  { shortcut: 'settings', statement: "SELECT * FROM pragma_journal_mode, pragma_synchronous, pragma_foreign_keys, pragma_page_size", detail: 'the pragmas that decide durability', engines: ['sqlite'] },
  { shortcut: 'space',    statement: 'SELECT name, sum(pgsize) AS bytes, sum(unused) AS unused\n  FROM dbstat GROUP BY name ORDER BY bytes DESC', detail: 'real on-disk size per object', engines: ['sqlite'] },
  { shortcut: 'integrity', statement: 'SELECT * FROM pragma_quick_check', detail: 'check the file for corruption', engines: ['sqlite'] },
  { shortcut: 'analyze',  statement: 'ANALYZE', detail: 'rebuild planner statistics (writes)', engines: ['sqlite'] },
  { shortcut: 'vacuum',   statement: 'VACUUM', detail: 'rewrite the file, reclaiming freelist pages (writes)', engines: ['sqlite'] },

  // Parquet — not SQL: the driver's own command vocabulary.
  { shortcut: 'fileinfo',     statement: 'FILEINFO', detail: 'version, writer, rows, size, indexes', engines: ['parquet'] },
  { shortcut: 'schema',       statement: 'SCHEMA', detail: 'leaf columns, types, repetition', engines: ['parquet'] },
  { shortcut: 'rowgroups',    statement: 'ROWGROUPS', detail: 'rows and size per row group', engines: ['parquet'] },
  { shortcut: 'columnchunks', statement: 'COLUMNCHUNKS', detail: 'codec, encodings, min/max per chunk', engines: ['parquet'] },
  { shortcut: 'stats',        statement: 'STATS', detail: 'per-column totals across row groups', engines: ['parquet'] },
  { shortcut: 'keyvalue',     statement: 'KEYVALUE', detail: 'writer-embedded metadata', engines: ['parquet'] },
  { shortcut: 'preview',      statement: 'PREVIEW 100', detail: 'first N rows', engines: ['parquet'] },

  // DuckDB — the catalog is a set of built-in table functions.
  { shortcut: 'tables',   statement: "SELECT database_name, schema_name, table_name, estimated_size AS rows\n  FROM duckdb_tables() WHERE NOT internal ORDER BY 1, 2, 3", detail: 'every table in every attached database', engines: ['duckdb'] },
  { shortcut: 'columns',  statement: "SELECT schema_name, table_name, column_name, data_type, is_nullable\n  FROM duckdb_columns() WHERE NOT internal ORDER BY 1, 2, column_index", detail: 'columns of every table', engines: ['duckdb'] },
  { shortcut: 'settings', statement: 'SELECT name, value, input_type, scope FROM duckdb_settings() ORDER BY name', detail: 'every engine setting', engines: ['duckdb'] },
  { shortcut: 'databases', statement: 'SELECT database_name, path, type, readonly FROM duckdb_databases() ORDER BY database_name', detail: 'attached databases', engines: ['duckdb'] },
  { shortcut: 'extensions', statement: 'SELECT extension_name, loaded, installed, install_path FROM duckdb_extensions() ORDER BY loaded DESC, extension_name', detail: 'extensions, loaded first', engines: ['duckdb'] },
  { shortcut: 'macros',   statement: "SELECT schema_name, function_name, parameters\n  FROM duckdb_functions()\n  WHERE NOT internal AND function_type IN ('macro','table_macro') ORDER BY 1, 2", detail: 'user-defined macros', engines: ['duckdb'] },
  { shortcut: 'indexes',  statement: 'SELECT schema_name, table_name, index_name, is_unique, sql\n  FROM duckdb_indexes() ORDER BY 1, 2, 3', detail: 'every index', engines: ['duckdb'] },

  // MySQL
  { shortcut: 'processlist', statement: 'SHOW FULL PROCESSLIST', detail: 'who is running what, right now', engines: ['mysql'] },
  { shortcut: 'innodb',      statement: 'SHOW ENGINE INNODB STATUS', detail: 'InnoDB internals: locks, deadlocks, buffer pool', engines: ['mysql'] },
  { shortcut: 'status',      statement: 'SHOW GLOBAL STATUS', detail: 'server-wide counters since startup', engines: ['mysql'] },
  { shortcut: 'variables',   statement: 'SHOW GLOBAL VARIABLES', detail: 'server configuration values', engines: ['mysql'] },
  { shortcut: 'replica',     statement: 'SHOW REPLICA STATUS', detail: 'replication state of this replica', engines: ['mysql'] },
  { shortcut: 'replicas',    statement: 'SHOW REPLICAS', detail: 'replicas registered on this source', engines: ['mysql'] },
  { shortcut: 'binlog',      statement: 'SHOW BINARY LOG STATUS', detail: 'current binlog file/position', engines: ['mysql'] },
  { shortcut: 'binlogs',     statement: 'SHOW BINARY LOGS', detail: 'all binlog files and sizes', engines: ['mysql'] },
  { shortcut: 'engines',     statement: 'SHOW ENGINES', detail: 'storage engines available', engines: ['mysql'] },
  { shortcut: 'grants',      statement: 'SHOW GRANTS', detail: 'privileges of the current user', engines: ['mysql'] },
  { shortcut: 'warnings',    statement: 'SHOW WARNINGS', detail: 'warnings from the last statement', engines: ['mysql'] },
  { shortcut: 'errors',      statement: 'SHOW ERRORS', detail: 'errors from the last statement', engines: ['mysql'] },
  { shortcut: 'charset',     statement: 'SHOW CHARSET', detail: 'character sets available', engines: ['mysql'] },
  { shortcut: 'collation',   statement: 'SHOW COLLATION', detail: 'collations available', engines: ['mysql'] },
  { shortcut: 'opentables',  statement: 'SHOW OPEN TABLES', detail: 'tables currently open in the cache', engines: ['mysql'] },
  { shortcut: 'tablestatus', statement: 'SHOW TABLE STATUS', detail: 'per-table engine/rows/size in the current db', engines: ['mysql'] },
  // PostgreSQL
  { shortcut: 'activity',       statement: 'SELECT * FROM pg_stat_activity', detail: 'every session and its current query', engines: ['postgres'] },
  { shortcut: 'locks',          statement: 'SELECT * FROM pg_locks', detail: 'all locks, granted and waiting', engines: ['postgres'] },
  { shortcut: 'replication',    statement: 'SELECT * FROM pg_stat_replication', detail: 'standby connections and replay lag', engines: ['postgres'] },
  { shortcut: 'settings',       statement: 'SELECT * FROM pg_settings', detail: 'server configuration values', engines: ['postgres'] },
  { shortcut: 'statstatements', statement: 'SELECT * FROM pg_stat_statements', detail: 'needs pg_stat_statements ext', engines: ['postgres'] },
  { shortcut: 'tables',         statement: 'SELECT * FROM pg_stat_user_tables', detail: 'per-table seq/index scan + vacuum stats', engines: ['postgres'] },
  { shortcut: 'indexes',        statement: 'SELECT * FROM pg_stat_user_indexes', detail: 'per-index usage counters', engines: ['postgres'] },
  { shortcut: 'vacuum',         statement: 'SELECT * FROM pg_stat_progress_vacuum', detail: 'running vacuums and their progress', engines: ['postgres'] },
  // ClickHouse — the system tables you check first on a sick MergeTree cluster.
  { shortcut: 'parts',        statement: 'SELECT database, table, partition, active, rows, bytes_on_disk\n  FROM system.parts WHERE active ORDER BY bytes_on_disk DESC LIMIT 100', detail: 'active parts, largest first', engines: ['clickhouse'] },
  { shortcut: 'merges',       statement: 'SELECT database, table, elapsed, progress, is_mutation, total_size_bytes_compressed\n  FROM system.merges ORDER BY elapsed DESC', detail: 'merges and mutations running now', engines: ['clickhouse'] },
  { shortcut: 'mutations',    statement: 'SELECT database, table, mutation_id, command, is_done, create_time\n  FROM system.mutations WHERE NOT is_done ORDER BY create_time', detail: 'unfinished mutations', engines: ['clickhouse'] },
  { shortcut: 'processes',    statement: 'SELECT query_id, user, elapsed, read_rows, memory_usage, query\n  FROM system.processes ORDER BY elapsed DESC', detail: 'queries running right now', engines: ['clickhouse'] },
  { shortcut: 'replicas',     statement: 'SELECT database, table, is_readonly, absolute_delay, queue_size, inserts_in_queue, merges_in_queue\n  FROM system.replicas ORDER BY absolute_delay DESC', detail: 'replication state per table', engines: ['clickhouse'] },
  { shortcut: 'replicationqueue', statement: 'SELECT database, table, type, num_tries, last_exception, create_time\n  FROM system.replication_queue ORDER BY create_time', detail: 'stuck replication tasks', engines: ['clickhouse'] },
  { shortcut: 'detachedparts', statement: 'SELECT database, table, partition_id, name, reason, disk\n  FROM system.detached_parts ORDER BY database, table', detail: 'parts detached and why', engines: ['clickhouse'] },
  { shortcut: 'disks',        statement: 'SELECT name, path, free_space, total_space, type\n  FROM system.disks ORDER BY free_space', detail: 'free space per disk', engines: ['clickhouse'] },
];

// ── Assembly ──────────────────────────────────────────────────────────────────

function fnSnippet(name: string): string {
  // NOW() and friends complete with the caret AFTER the parens
  return /^(NOW|CURDATE|UUID|RANDOM|RAND|VERSION|DATABASE|CURRENT_DATABASE|LAST_INSERT_ID|GEN_RANDOM_UUID|FOUND_ROWS|GETDATE|SYSDATETIME|GETUTCDATE|NEWID|NEWSEQUENTIALID|SCOPE_IDENTITY|ERROR_MESSAGE|ERROR_LINE|ERROR_NUMBER|XACT_STATE)$/.test(name)
    ? `${name}()`
    : `${name}(\${})`;
}

/**
 * Keyword/function case for completion. The catalog is written in upper case;
 * a lower-case preference maps both the label and the inserted snippet, so the
 * editor writes SQL in the style you asked for.
 */
export function applyKeywordCase(items: KeywordItem[], upper: boolean): KeywordItem[] {
  if (upper) return items;
  return items.map(k => ({
    ...k,
    label: k.label.toLowerCase(),
    snippet: k.snippet?.toLowerCase(),
    detail: k.detail,          // signatures stay readable as written
  }));
}

/**
 * Completions for an engine, and — for the MySQL family — its flavour.
 *
 * `flavor` is optional and defaults to plain MySQL, because most callers do not
 * know it yet: it comes from an async probe. Defaulting the other way would
 * offer MariaDB-only syntax on MySQL for the first render, which is the more
 * expensive mistake of the two.
 */
export function keywordCatalog(
  engine: Engine | string, flavor: 'mysql' | 'mariadb' | 'percona' = 'mysql',
): KeywordItem[] {
  const maria = engine === 'mysql' && flavor === 'mariadb';
  const kws = [...CORE_KEYWORDS,
    ...(engine === 'mysql'
      ? [...MYSQL_KEYWORDS, ...(maria ? MARIADB_KEYWORDS : MYSQL_ONLY_KEYWORDS)]
      : engine === 'postgres' ? PG_KEYWORDS
      : engine === 'clickhouse' ? CH_KEYWORDS
      : engine === 'duckdb' ? DUCKDB_KEYWORDS
      : engine === 'sqlserver' ? TSQL_KEYWORDS : [])];
  const fns = [...CORE_FUNCTIONS,
    ...(engine === 'mysql'
      ? [...MYSQL_FUNCTIONS, ...(maria ? MARIADB_FUNCTIONS : [])]
      : engine === 'postgres' ? PG_FUNCTIONS
      : engine === 'duckdb' ? DUCKDB_FUNCTIONS
      : engine === 'sqlserver' ? TSQL_FUNCTIONS : [])];
  const items: KeywordItem[] = kws.map(k => ({ label: k, type: 'keyword' as const }));
  for (const [name, sig] of fns) {
    items.push({ label: name, detail: sig, snippet: fnSnippet(name), type: 'function' });
  }
  return items;
}
