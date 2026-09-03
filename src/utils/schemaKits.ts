/**
 * Schema kits — reproducible demo *worlds* for the whole-database generator
 * (roadmap G4). A kit is data, not a dump: tables in FK-topological order,
 * per-column generator specs, referential row ratios and a scale knob. The
 * same kit + seed always produces the identical database, at any size.
 *
 * "database" maps to a MySQL DATABASE and a PostgreSQL SCHEMA.
 */
import type { ColumnSpec, GenParams } from './datagen.ts';
import { DEFAULT_PARAMS, quoteIdent } from './datagen.ts';
import { sqlLiteral } from './sqlIdent.ts';

export interface KitColumn {
  name: string;
  /** MySQL type; mapped for PG by ddlType() */
  type: string;
  pk?: boolean;
  nullable?: boolean;
  unique?: boolean;
  generator: string;
  params?: Partial<GenParams>;
  /** FK to a table earlier in the kit (by bare name) */
  fk?: { table: string; column: string; dist?: 'uniform' | 'zipf' };
  /**
   * A database-computed column: the full DDL fragment after the name, per
   * engine, e.g. a generated spatial POINT from lat/lon. Excluded from inserts
   * — the server derives it — so no ST_GeomFromText is needed in the value
   * path, and no spatial extension either (both forms are built in).
   */
  generated?: { mysql: string; postgres: string; sqlserver: string };
}

export interface KitTable {
  name: string;
  columns: KitColumn[];
  /** extra (non-PK) indexes; FK columns are indexed automatically on MySQL */
  indexes?: string[][];
  /** base row count at scale 1; ratio multiplies the parent table's rows */
  rows: { base: number } | { per: string; ratio: number };
}

export interface SchemaKit {
  id: string;
  title: string;
  description: string;
  defaultName: string;
  tables: KitTable[];  // topological order: parents before children
}

const P = (p: Partial<GenParams>): Partial<GenParams> => p;

/**
 * A single-table fleet-GPS world: one `gps_pings` table whose `ride*` columns
 * all share the same ride params, so each `car_id` is one continuous ride down
 * real streets. `geom` is a server-computed spatial POINT — no PostGIS, no
 * ST_GeomFromText, portable to plain MySQL 8 and plain PostgreSQL.
 */
function gpsPingsTable(): KitTable {
  // Identical ride params on every ride column — they must agree for the track
  // columns of one row to describe the same instant of the same car.
  const rp: Partial<GenParams> = { ridePings: 200, pingSec: 2, dateFrom: '2026-06-01' };
  return {
    name: 'gps_pings',
    rows: { base: 6000 },   // 30 cars × 200 pings
    indexes: [['car_id'], ['captured_at']],
    columns: [
      { name: 'id', type: 'BIGINT', pk: true, generator: 'sequence' },
      { name: 'car_id', type: 'INT', generator: 'rideCarId', params: P(rp) },
      { name: 'captured_at', type: 'TIMESTAMP', generator: 'rideTimestamp', params: P(rp) },
      { name: 'lat', type: 'DOUBLE', generator: 'rideLat', params: P(rp) },
      { name: 'lon', type: 'DOUBLE', generator: 'rideLon', params: P(rp) },
      { name: 'speed_kmh', type: 'DECIMAL(5,1)', generator: 'rideSpeed', params: P(rp) },
      { name: 'heading_deg', type: 'SMALLINT', generator: 'rideHeading', params: P(rp) },
      // Derived by the database from lat/lon — no ST_GeomFromText in the insert
      // path, no spatial extension. Both take (lon, lat): verified on MySQL 8,
      // ST_Latitude/ST_Longitude/ST_Distance_Sphere all read back correctly.
      // The stored POINT is left at SRID 0 on purpose: the two-argument
      // ST_SRID setter only exists on MySQL 8.0+ / MariaDB 10.2+, and older
      // servers answer the CREATE TABLE with error 1582 ("Incorrect parameter
      // count in the call to native function 'ST_SRID'"). ST_Distance_Sphere
      // treats SRID 0 coordinates as degrees on a sphere, so nothing the kit
      // promises is lost.
      { name: 'geom', type: 'POINT', generator: 'constant', generated: {
        mysql: 'POINT GENERATED ALWAYS AS (POINT(lon, lat)) STORED',
        postgres: 'point GENERATED ALWAYS AS (point(lon, lat)) STORED',
        // T-SQL declares a computed column by its expression alone — no type —
        // and PERSISTED is its STORED. `geography::Point` takes an SRID and
        // latitude FIRST, which is the opposite argument order to the other two.
        sqlserver: 'AS (geography::Point(lat, lon, 4326)) PERSISTED',
      } },
    ],
  };
}

// ── Kits ──────────────────────────────────────────────────────────────────────

export const SCHEMA_KITS: SchemaKit[] = [
  {
    id: 'retail',
    title: '🛒 Retail store',
    description: 'Sakila-class web shop: customers, products, orders, order items, payments. Zipf-skewed — a few customers make most orders.',
    defaultName: 'retail_demo',
    tables: [
      {
        name: 'customers',
        rows: { base: 5000 },
        columns: [
          { name: 'id', type: 'BIGINT', pk: true, generator: 'sequence' },
          { name: 'first_name', type: 'VARCHAR(100)', generator: 'firstName' },
          { name: 'last_name', type: 'VARCHAR(100)', generator: 'lastName' },
          { name: 'email', type: 'VARCHAR(255)', unique: true, generator: 'email' },
          { name: 'phone', type: 'VARCHAR(40)', nullable: true, generator: 'phone', params: P({ nullPct: 20 }) },
          { name: 'city', type: 'VARCHAR(100)', generator: 'city' },
          { name: 'country', type: 'VARCHAR(100)', generator: 'country' },
          { name: 'street', type: 'VARCHAR(150)', generator: 'street' },
          { name: 'created_at', type: 'TIMESTAMP', generator: 'timestamp', params: P({ dateFrom: '2023-01-01', dateTo: '2026-07-01' }) },
        ],
      },
      {
        name: 'products',
        rows: { base: 800 },
        columns: [
          { name: 'id', type: 'BIGINT', pk: true, generator: 'sequence' },
          { name: 'name', type: 'VARCHAR(150)', generator: 'product' },
          { name: 'sku', type: 'VARCHAR(20)', unique: true, generator: 'regex', params: P({ list: '[A-Z]{3}-\\d{5}' }) },
          { name: 'price', type: 'DECIMAL(10,2)', generator: 'decimal', params: P({ min: 3, max: 900, dist: 'zipf' }) },
          { name: 'stock', type: 'INT', generator: 'int', params: P({ min: 0, max: 500 }) },
          { name: 'active', type: 'BOOLEAN', generator: 'bool' },
        ],
      },
      {
        name: 'orders',
        rows: { per: 'customers', ratio: 4 },
        indexes: [['customer_id'], ['created_at']],
        columns: [
          { name: 'id', type: 'BIGINT', pk: true, generator: 'sequence' },
          { name: 'customer_id', type: 'BIGINT', generator: 'fk', fk: { table: 'customers', column: 'id', dist: 'zipf' } },
          { name: 'status', type: 'VARCHAR(20)', generator: 'choice', params: P({ list: 'delivered:70, shipped:12, paid:8, pending:6, cancelled:4' }) },
          { name: 'total', type: 'DECIMAL(10,2)', generator: 'decimal', params: P({ min: 5, max: 2500, dist: 'zipf' }) },
          { name: 'created_at', type: 'TIMESTAMP', generator: 'timestamp', params: P({ dateFrom: '2023-01-01', dateTo: '2026-07-01' }) },
        ],
      },
      {
        name: 'order_items',
        rows: { per: 'orders', ratio: 3 },
        indexes: [['order_id'], ['product_id']],
        columns: [
          { name: 'id', type: 'BIGINT', pk: true, generator: 'sequence' },
          { name: 'order_id', type: 'BIGINT', generator: 'fk', fk: { table: 'orders', column: 'id' } },
          { name: 'product_id', type: 'BIGINT', generator: 'fk', fk: { table: 'products', column: 'id', dist: 'zipf' } },
          { name: 'quantity', type: 'INT', generator: 'int', params: P({ min: 1, max: 8, dist: 'zipf' }) },
          { name: 'unit_price', type: 'DECIMAL(10,2)', generator: 'decimal', params: P({ min: 3, max: 900, dist: 'zipf' }) },
        ],
      },
      {
        name: 'payments',
        rows: { per: 'orders', ratio: 1 },
        indexes: [['order_id']],
        columns: [
          { name: 'id', type: 'BIGINT', pk: true, generator: 'sequence' },
          { name: 'order_id', type: 'BIGINT', generator: 'fk', fk: { table: 'orders', column: 'id' } },
          { name: 'method', type: 'VARCHAR(20)', generator: 'choice', params: P({ list: 'card:75, transfer:15, cod:8, voucher:2' }) },
          { name: 'amount', type: 'DECIMAL(10,2)', generator: 'decimal', params: P({ min: 5, max: 2500, dist: 'zipf' }) },
          { name: 'paid_at', type: 'TIMESTAMP', nullable: true, generator: 'timestamp', params: P({ dateFrom: '2023-01-01', dateTo: '2026-07-01', nullPct: 6 }) },
        ],
      },
    ],
  },
  {
    id: 'hr',
    title: '👥 HR / employees',
    description: 'MySQL-employees-style: departments, employees, salaries history, assignments.',
    defaultName: 'hr_demo',
    tables: [
      {
        name: 'departments',
        rows: { base: 12 },
        columns: [
          { name: 'id', type: 'INT', pk: true, generator: 'sequence' },
          { name: 'name', type: 'VARCHAR(100)', generator: 'choice', params: P({ list: 'Engineering,Sales,Marketing,Finance,HR,Operations,Support,Legal,Product,Design,IT,Logistics' }) },
          { name: 'city', type: 'VARCHAR(100)', generator: 'city' },
        ],
      },
      {
        name: 'employees',
        rows: { base: 3000 },
        indexes: [['department_id'], ['hired_at']],
        columns: [
          { name: 'id', type: 'BIGINT', pk: true, generator: 'sequence' },
          { name: 'first_name', type: 'VARCHAR(100)', generator: 'firstName' },
          { name: 'last_name', type: 'VARCHAR(100)', generator: 'lastName' },
          { name: 'email', type: 'VARCHAR(255)', unique: true, generator: 'email' },
          { name: 'department_id', type: 'INT', generator: 'fk', fk: { table: 'departments', column: 'id' } },
          { name: 'title', type: 'VARCHAR(60)', generator: 'choice', params: P({ list: 'Engineer:35, Senior Engineer:20, Manager:12, Analyst:12, Specialist:10, Director:5, Intern:6' }) },
          { name: 'hired_at', type: 'DATE', generator: 'date', params: P({ dateFrom: '2015-01-01', dateTo: '2026-07-01' }) },
        ],
      },
      {
        name: 'salaries',
        rows: { per: 'employees', ratio: 4 },
        indexes: [['employee_id', 'valid_from']],
        columns: [
          { name: 'id', type: 'BIGINT', pk: true, generator: 'sequence' },
          { name: 'employee_id', type: 'BIGINT', generator: 'fk', fk: { table: 'employees', column: 'id' } },
          { name: 'amount', type: 'DECIMAL(10,2)', generator: 'decimal', params: P({ min: 28000, max: 180000, dist: 'normal' }) },
          { name: 'valid_from', type: 'DATE', generator: 'date', params: P({ dateFrom: '2015-01-01', dateTo: '2026-07-01' }) },
        ],
      },
      {
        name: 'assignments',
        rows: { per: 'employees', ratio: 2 },
        indexes: [['employee_id']],
        columns: [
          { name: 'id', type: 'BIGINT', pk: true, generator: 'sequence' },
          { name: 'employee_id', type: 'BIGINT', generator: 'fk', fk: { table: 'employees', column: 'id' } },
          { name: 'project', type: 'VARCHAR(120)', generator: 'product' },
          { name: 'role', type: 'VARCHAR(40)', generator: 'choice', params: P({ list: 'member:70, lead:15, reviewer:10, sponsor:5' }) },
          { name: 'started_at', type: 'DATE', generator: 'date', params: P({ dateFrom: '2018-01-01', dateTo: '2026-07-01' }) },
        ],
      },
    ],
  },
  {
    id: 'library',
    title: '📚 Library',
    description: 'Books, members, loans and reservations — clean lookup ← main ← detail shape, great for JOIN practice.',
    defaultName: 'library_demo',
    tables: [
      {
        name: 'books',
        rows: { base: 2000 },
        columns: [
          { name: 'id', type: 'BIGINT', pk: true, generator: 'sequence' },
          { name: 'title', type: 'VARCHAR(200)', generator: 'words' },
          { name: 'author', type: 'VARCHAR(150)', generator: 'fullName' },
          { name: 'isbn', type: 'VARCHAR(20)', unique: true, generator: 'regex', params: P({ list: '97[89]-\\d{2}-\\d{5}-\\d{2}-\\d' }) },
          { name: 'published_year', type: 'INT', generator: 'int', params: P({ min: 1950, max: 2026 }) },
          { name: 'copies', type: 'INT', generator: 'int', params: P({ min: 1, max: 12 }) },
        ],
      },
      {
        name: 'members',
        rows: { base: 1500 },
        columns: [
          { name: 'id', type: 'BIGINT', pk: true, generator: 'sequence' },
          { name: 'name', type: 'VARCHAR(150)', generator: 'fullName' },
          { name: 'email', type: 'VARCHAR(255)', unique: true, generator: 'email' },
          { name: 'joined_at', type: 'DATE', generator: 'date', params: P({ dateFrom: '2019-01-01', dateTo: '2026-07-01' }) },
        ],
      },
      {
        name: 'loans',
        rows: { per: 'members', ratio: 6 },
        indexes: [['book_id'], ['member_id'], ['loaned_at']],
        columns: [
          { name: 'id', type: 'BIGINT', pk: true, generator: 'sequence' },
          { name: 'book_id', type: 'BIGINT', generator: 'fk', fk: { table: 'books', column: 'id', dist: 'zipf' } },
          { name: 'member_id', type: 'BIGINT', generator: 'fk', fk: { table: 'members', column: 'id', dist: 'zipf' } },
          { name: 'loaned_at', type: 'DATE', generator: 'date', params: P({ dateFrom: '2022-01-01', dateTo: '2026-07-01' }) },
          { name: 'returned_at', type: 'DATE', nullable: true, generator: 'date', params: P({ dateFrom: '2022-01-01', dateTo: '2026-07-01', nullPct: 15 }) },
        ],
      },
      {
        name: 'reservations',
        rows: { per: 'members', ratio: 1 },
        indexes: [['book_id'], ['member_id']],
        columns: [
          { name: 'id', type: 'BIGINT', pk: true, generator: 'sequence' },
          { name: 'book_id', type: 'BIGINT', generator: 'fk', fk: { table: 'books', column: 'id', dist: 'zipf' } },
          { name: 'member_id', type: 'BIGINT', generator: 'fk', fk: { table: 'members', column: 'id' } },
          { name: 'reserved_at', type: 'TIMESTAMP', generator: 'timestamp', params: P({ dateFrom: '2024-01-01', dateTo: '2026-07-01' }) },
          { name: 'state', type: 'VARCHAR(20)', generator: 'choice', params: P({ list: 'fulfilled:60, waiting:25, expired:15' }) },
        ],
      },
    ],
  },
  {
    id: 'saas',
    title: '☁️ SaaS accounts',
    description: 'Accounts, users, subscriptions, invoices and an events stream — the shape of every B2B dashboard.',
    defaultName: 'saas_demo',
    tables: [
      {
        name: 'accounts',
        rows: { base: 600 },
        columns: [
          { name: 'id', type: 'BIGINT', pk: true, generator: 'sequence' },
          { name: 'company', type: 'VARCHAR(150)', generator: 'company' },
          { name: 'plan', type: 'VARCHAR(20)', generator: 'choice', params: P({ list: 'free:45, starter:30, business:20, enterprise:5' }) },
          { name: 'country', type: 'VARCHAR(100)', generator: 'country' },
          { name: 'created_at', type: 'TIMESTAMP', generator: 'timestamp', params: P({ dateFrom: '2021-01-01', dateTo: '2026-07-01' }) },
        ],
      },
      {
        name: 'users',
        rows: { per: 'accounts', ratio: 8 },
        indexes: [['account_id']],
        columns: [
          { name: 'id', type: 'BIGINT', pk: true, generator: 'sequence' },
          { name: 'account_id', type: 'BIGINT', generator: 'fk', fk: { table: 'accounts', column: 'id', dist: 'zipf' } },
          { name: 'email', type: 'VARCHAR(255)', unique: true, generator: 'email' },
          { name: 'name', type: 'VARCHAR(150)', generator: 'fullName' },
          { name: 'role', type: 'VARCHAR(20)', generator: 'choice', params: P({ list: 'member:75, admin:20, owner:5' }) },
          { name: 'last_login', type: 'TIMESTAMP', nullable: true, generator: 'timestamp', params: P({ dateFrom: '2026-01-01', dateTo: '2026-07-16', nullPct: 12 }) },
        ],
      },
      {
        name: 'subscriptions',
        rows: { per: 'accounts', ratio: 2 },
        indexes: [['account_id']],
        columns: [
          { name: 'id', type: 'BIGINT', pk: true, generator: 'sequence' },
          { name: 'account_id', type: 'BIGINT', generator: 'fk', fk: { table: 'accounts', column: 'id' } },
          { name: 'status', type: 'VARCHAR(20)', generator: 'choice', params: P({ list: 'active:70, cancelled:18, past_due:8, trialing:4' }) },
          { name: 'mrr', type: 'DECIMAL(10,2)', generator: 'decimal', params: P({ min: 0, max: 4000, dist: 'zipf' }) },
          { name: 'started_at', type: 'DATE', generator: 'date', params: P({ dateFrom: '2021-01-01', dateTo: '2026-07-01' }) },
        ],
      },
      {
        name: 'invoices',
        rows: { per: 'subscriptions', ratio: 12 },
        indexes: [['subscription_id'], ['issued_at']],
        columns: [
          { name: 'id', type: 'BIGINT', pk: true, generator: 'sequence' },
          { name: 'subscription_id', type: 'BIGINT', generator: 'fk', fk: { table: 'subscriptions', column: 'id' } },
          { name: 'number', type: 'VARCHAR(20)', unique: true, generator: 'regex', params: P({ list: 'INV-\\d{7}' }) },
          { name: 'amount', type: 'DECIMAL(10,2)', generator: 'decimal', params: P({ min: 0, max: 4000, dist: 'zipf' }) },
          { name: 'issued_at', type: 'DATE', generator: 'date', params: P({ dateFrom: '2021-01-01', dateTo: '2026-07-01' }) },
          { name: 'paid', type: 'BOOLEAN', generator: 'bool' },
        ],
      },
      {
        name: 'events',
        rows: { per: 'users', ratio: 25 },
        indexes: [['user_id'], ['created_at']],
        columns: [
          { name: 'id', type: 'BIGINT', pk: true, generator: 'sequence' },
          { name: 'user_id', type: 'BIGINT', generator: 'fk', fk: { table: 'users', column: 'id', dist: 'zipf' } },
          { name: 'kind', type: 'VARCHAR(30)', generator: 'choice', params: P({ list: 'page_view:55, click:25, api_call:12, export:5, login:3' }) },
          { name: 'payload', type: 'JSON', generator: 'json' },
          { name: 'created_at', type: 'TIMESTAMP', generator: 'timestamp', params: P({ dateFrom: '2026-04-01', dateTo: '2026-07-16' }) },
        ],
      },
    ],
  },
  {
    id: 'nyc_taxi',
    title: '🗽 NYC taxi fleet',
    description: 'The classic NYC taxi-trip shape as a gps_pings table — each car_id a continuous ride down real New York streets (JFK, LaGuardia, the bridges, Manhattan). Routes are actual road geometry, so cars follow the street. A server-computed POINT column makes it map- and spatial-query-ready — no PostGIS needed.',
    defaultName: 'nyc_taxi',
    tables: [gpsPingsTable()],
  },
];

// ── Row-count resolution ──────────────────────────────────────────────────────

/** Resolve per-table row counts for a kit at the given scale. */
export function resolveRowCounts(kit: SchemaKit, scale: number): Map<string, number> {
  const counts = new Map<string, number>();
  for (const t of kit.tables) {
    if ('base' in t.rows) {
      counts.set(t.name, Math.max(1, Math.round(t.rows.base * scale)));
    } else {
      const parent = counts.get(t.rows.per) ?? 0;
      counts.set(t.name, Math.max(1, Math.round(parent * t.rows.ratio)));
    }
  }
  return counts;
}

/** Sum of all rows a kit produces at the given scale. */
export function totalRows(kit: SchemaKit, scale: number): number {
  let sum = 0;
  resolveRowCounts(kit, scale).forEach(n => { sum += n; });
  return sum;
}

// ── DDL emission ──────────────────────────────────────────────────────────────

/** Kit column type → engine dialect. Kits use MySQL-flavored names. */
function ddlType(t: string, engine: string): string {
  if (engine === 'sqlserver') {
    // Four of these are not merely spelled differently — they do not exist, or
    // exist as something else entirely:
    //
    //   TIMESTAMP  is a synonym for **rowversion**: a binary version stamp, not
    //              a date. The column is created happily and then every insert
    //              of a date fails with Msg 273. Measured, and by far the worst
    //              of the four because it fails LATE.
    //   BOOLEAN    "Cannot find data type BOOLEAN."
    //   DOUBLE     a syntax error on its own.
    //   JSON       "Cannot find data type json" (before SQL Server 2025).
    return t
      .replace(/^TINYINT\(1\)$/i, 'bit')
      .replace(/^BOOLEAN$/i, 'bit')
      .replace(/^TIMESTAMP$/i, 'datetime2(3)')
      .replace(/^DATETIME$/i, 'datetime2(3)')
      .replace(/^DOUBLE$/i, 'float')
      .replace(/^JSON$/i, 'nvarchar(max)')
      // The demo data is Unicode (Czech names among them), and a `varchar`
      // column silently replaces what its code page cannot hold with `?`.
      .replace(/^VARCHAR\((\d+)\)$/i, 'nvarchar($1)');
  }
  if (engine !== 'postgres') return t;
  return t
    .replace(/^TINYINT\(1\)$/i, 'BOOLEAN')
    .replace(/^DATETIME$/i, 'TIMESTAMP')
    .replace(/^DOUBLE$/i, 'DOUBLE PRECISION')
    .replace(/^JSON$/i, 'JSONB');
}

/** CREATE DATABASE (MySQL) / CREATE SCHEMA (PG) — the kit's namespace. */
export function buildKitPreDdl(dbName: string, engine: string): string[] {
  const q = quoteIdent(dbName, engine);
  if (engine === 'sqlserver') {
    // No `IF NOT EXISTS`, and `CREATE SCHEMA` must lead its own batch — so the
    // existence test has to execute it as a string. Same shape as
    // utils/schemaObjSql.
    const inner = `CREATE SCHEMA ${q}`;
    return [`IF SCHEMA_ID(${sqlLiteral(dbName, engine)}) IS NULL `
      + `EXEC(${sqlLiteral(inner, engine)})`];
  }
  return engine === 'mysql'
    ? [`CREATE DATABASE IF NOT EXISTS ${q} DEFAULT CHARACTER SET utf8mb4`]
    : [`CREATE SCHEMA IF NOT EXISTS ${q}`];
}

/** CREATE TABLE with PK + FKs, plus separate CREATE INDEX statements on PG
 *  (MySQL indexes go inline). One SQL statement per array entry. */
export function buildKitTableDdl(dbName: string, t: KitTable, engine: string): string[] {
  const qn = (s: string) => quoteIdent(s, engine);
  const qualified = `${qn(dbName)}.${qn(t.name)}`;
  const lines: string[] = [];
  for (const c of t.columns) {
    if (c.generated) {
      // Emitted verbatim per engine — it carries its own type and the
      // GENERATED … STORED clause, and never takes NOT NULL/UNIQUE here.
      lines.push('  ' + qn(c.name) + ' ' + (
        engine === 'mysql' ? c.generated.mysql
        : engine === 'sqlserver' ? c.generated.sqlserver
        : c.generated.postgres));
      continue;
    }
    const parts = [qn(c.name), ddlType(c.type, engine)];
    if (!c.nullable) parts.push('NOT NULL');
    if (c.unique && !c.pk) parts.push('UNIQUE');
    lines.push('  ' + parts.join(' '));
  }
  const pks = t.columns.filter(c => c.pk).map(c => qn(c.name));
  if (pks.length) lines.push(`  PRIMARY KEY (${pks.join(', ')})`);
  for (const c of t.columns) {
    if (!c.fk) continue;
    lines.push(`  FOREIGN KEY (${qn(c.name)}) REFERENCES ${qn(dbName)}.${qn(c.fk.table)} (${qn(c.fk.column)})`);
  }
  // MySQL allows INDEX inside CREATE TABLE; PG needs separate statements —
  // keep it simple and emit MySQL-style inline, PG appended via ';'-joined DDL.
  const inlineIdx: string[] = [];
  const pgIdx: string[] = [];
  (t.indexes ?? []).forEach((cols, i) => {
    const idxCols = cols.map(qn).join(', ');
    // SQL Server takes an inline INDEX in CREATE TABLE too (2014+), so it
    // joins MySQL here rather than needing separate statements.
    if (engine === 'mysql' || engine === 'sqlserver') {
      inlineIdx.push(`  INDEX ${qn(`ix_${t.name}_${i}`)} (${idxCols})`);
    } else {
      pgIdx.push(`CREATE INDEX IF NOT EXISTS ${qn(`ix_${t.name}_${i}`)} ON ${qualified} (${idxCols})`);
    }
  });
  const body = [...lines, ...inlineIdx].join(',\n');
  const create = `CREATE TABLE ${qualified} (\n${body}\n)`;
  return [create, ...pgIdx];
}

/** Column specs for the generator engine, FK params pre-quoted per engine. */
export function kitTableSpecs(dbName: string, t: KitTable, engine: string): ColumnSpec[] {
  const qn = (s: string) => quoteIdent(s, engine);
  // Generated columns are computed by the server, never inserted.
  return t.columns.filter(c => !c.generated).map(c => ({
    name: c.name,
    typeName: c.type,
    generator: c.generator,
    unique: !!c.unique || !!c.pk,
    params: {
      ...DEFAULT_PARAMS,
      ...(c.params ?? {}),
      ...(c.fk ? {
        fkTable: `${qn(dbName)}.${qn(c.fk.table)}`,
        fkColumn: qn(c.fk.column),
        dist: c.fk.dist ?? 'uniform',
      } : {}),
    },
  }));
}
