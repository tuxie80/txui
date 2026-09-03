/**
 * SQL builders for PostgreSQL extension management (create / drop) and the
 * catalog query behind the "Create extension…" picker.
 *
 * Everything here is **review-only**: the strings are inserted into the editor
 * for the user to run, never executed by the tree. Identifiers are quoted with
 * the shared `sqlIdent.quoteIdent` (never hand-rolled), which double-quotes
 * unconditionally — matching the canonical `CREATE EXTENSION IF NOT EXISTS
 * "name"` form and keeping any embedded quote correctly escaped.
 *
 * Pure module (no React / Tauri imports) — unit-tested with `node --test`.
 */
import { quoteIdent } from './sqlIdent.ts';

/** One row of `pg_available_extensions` offered by the create picker. */
export interface AvailableExtension {
  name: string;
  /** `default_version` — the version a bare CREATE would install. */
  version: string | null;
  comment: string | null;
}

/**
 * Extensions that can still be installed (installed ones filtered out), with
 * the default version and one-line description. Ordered for the picker.
 */
export const AVAILABLE_EXTENSIONS_SQL =
  'SELECT name, default_version, comment FROM pg_available_extensions ' +
  'WHERE installed_version IS NULL ORDER BY name';

/**
 * `CREATE EXTENSION IF NOT EXISTS <name>` — idempotent so re-running against a
 * server that already has it is a no-op rather than an error.
 */
// ── Declarative partitioning ──────────────────────────────────────────────────
// Create/attach/detach partitions of an existing PG-11+ partitioned table.
// `parent`/`child` may be "schema.table" or "table" — each part is quoted.

const qRel = (rel: string): string =>
  rel.split('.').map(p => quoteIdent(p, 'postgres')).join('.');

/** The bounds clause for one partition, by partitioning strategy. */
export type PgPartitionBound =
  | { kind: 'range'; from: string; to: string }
  | { kind: 'list'; values: string }
  | { kind: 'hash'; modulus: number; remainder: number }
  | { kind: 'default' };

function pgForValues(b: PgPartitionBound): string {
  switch (b.kind) {
    case 'range':   return `FOR VALUES FROM (${b.from}) TO (${b.to})`;
    case 'list':    return `FOR VALUES IN (${b.values})`;
    case 'hash':    return `FOR VALUES WITH (MODULUS ${b.modulus}, REMAINDER ${b.remainder})`;
    case 'default': return 'DEFAULT';
  }
}

/** `CREATE TABLE child PARTITION OF parent FOR VALUES …` (a fresh partition). */
export function pgCreatePartitionSql(parent: string, child: string, bound: PgPartitionBound): string {
  return `CREATE TABLE ${qRel(child)} PARTITION OF ${qRel(parent)} ${pgForValues(bound)};`;
}

/** `ALTER TABLE parent ATTACH PARTITION child FOR VALUES …` (adopt an existing table). */
export function pgAttachPartitionSql(parent: string, child: string, bound: PgPartitionBound): string {
  return `ALTER TABLE ${qRel(parent)} ATTACH PARTITION ${qRel(child)} ${pgForValues(bound)};`;
}

/** `ALTER TABLE parent DETACH PARTITION child [CONCURRENTLY]`. */
export function pgDetachPartitionSql(parent: string, child: string, opts: { concurrently?: boolean } = {}): string {
  return `ALTER TABLE ${qRel(parent)} DETACH PARTITION ${qRel(child)}${opts.concurrently ? ' CONCURRENTLY' : ''};`;
}

// ── Logical replication ───────────────────────────────────────────────────────
// Publications / subscriptions / replication slots — the write actions that sit
// on top of the read-only monitoring the DBA views already provide.

export function pgCreatePublicationSql(name: string, spec: { allTables?: boolean; tables?: string[] } = {}): string {
  const n = quoteIdent(name, 'postgres');
  if (spec.allTables) return `CREATE PUBLICATION ${n} FOR ALL TABLES;`;
  if (spec.tables && spec.tables.length) {
    return `CREATE PUBLICATION ${n} FOR TABLE ${spec.tables.map(qRel).join(', ')};`;
  }
  return `CREATE PUBLICATION ${n};`;
}

export function pgDropPublicationSql(name: string): string {
  return `DROP PUBLICATION IF EXISTS ${quoteIdent(name, 'postgres')};`;
}

export function pgRefreshPublicationSql(subscription: string): string {
  return `ALTER SUBSCRIPTION ${quoteIdent(subscription, 'postgres')} REFRESH PUBLICATION;`;
}

/** conninfo is a libpq string; it holds the publisher password, so it is quoted
 *  as a literal and the caller is reminded not to commit it. */
export function pgCreateSubscriptionSql(name: string, conninfo: string, publications: string[]): string {
  const pubs = publications.map(p => quoteIdent(p, 'postgres')).join(', ');
  const conn = `'${conninfo.replace(/'/g, "''")}'`;
  return `CREATE SUBSCRIPTION ${quoteIdent(name, 'postgres')}\n  CONNECTION ${conn}\n  PUBLICATION ${pubs};`;
}

export function pgDropSubscriptionSql(name: string): string {
  return `DROP SUBSCRIPTION IF EXISTS ${quoteIdent(name, 'postgres')};`;
}

export function pgCreateSlotSql(name: string, opts: { logical?: boolean; plugin?: string } = {}): string {
  const n = `'${name.replace(/'/g, "''")}'`;
  return opts.logical
    ? `SELECT pg_create_logical_replication_slot(${n}, '${(opts.plugin ?? 'pgoutput').replace(/'/g, "''")}');`
    : `SELECT pg_create_physical_replication_slot(${n});`;
}

export function pgDropSlotSql(name: string): string {
  return `SELECT pg_drop_replication_slot('${name.replace(/'/g, "''")}');`;
}

export function extensionCreateSql(name: string): string {
  return `CREATE EXTENSION IF NOT EXISTS ${quoteIdent(name, 'postgres')};`;
}

/** `DROP EXTENSION <name>` — plain, so the server refuses if objects depend on it. */
export function extensionDropSql(name: string): string {
  return `DROP EXTENSION ${quoteIdent(name, 'postgres')};`;
}
