/**
 * TTL / type / encoding classification for the Redis key audit.
 *
 * The browser scans keys with SCAN (never KEYS) and asks the backend for a
 * pipelined TYPE + TTL + OBJECT ENCODING + size per key. This module turns
 * those rows into findings — the rules are pure and live here so they are
 * unit-testable without a server:
 *
 *   - no expiry on a key (the classic cache-turned-leak);
 *   - big strings and oversized collections (the latency cliffs);
 *   - a non-compact encoding on a small collection (hash stored as hashtable
 *     where listpack would do — usually a lowered server threshold or a key
 *     that shrank);
 *   - keys that expired between the scan and the audit (a race worth saying).
 *
 * Thresholds are Redis' own defaults where one exists (listpack 128 entries,
 * embstr 44 bytes), so a finding means "worth a look", not "misconfigured".
 *
 * Pure and dependency-free — driven by `node --test`.
 */

export interface RedisKeyAuditRow {
  key: string;
  /** "string" | "list" | "hash" | "set" | "zset" | "stream" | "none" */
  key_type: string;
  /** -1 = persistent, -2 = key gone. */
  ttl: number;
  /** OBJECT ENCODING, or null when the server returned none. */
  encoding: string | null;
  /** Bytes for strings, item count for collections. */
  size: number;
}

export type AuditKind =
  | 'no-ttl'
  | 'expired'
  | 'big-string'
  | 'big-collection'
  | 'non-compact-encoding';

export interface AuditFinding {
  key: string;
  kind: AuditKind;
  severity: 'warn' | 'info';
  message: string;
}

/** A string payload above this is a per-command latency cliff. */
export const BIG_STRING_BYTES = 100 * 1024;
/** A collection above this many items is slow to read, diff and expire. */
export const BIG_COLLECTION_ITEMS = 10_000;
/** Redis' default *-max-listpack-entries — below it the compact encoding is expected. */
export const COMPACT_ENCODING_MAX = 128;
/** Redis' embstr ceiling — a short string stored `raw` pays an extra allocation. */
export const EMBSTR_MAX = 44;

/** The compact encoding each collection type uses below its threshold. */
const COMPACT_ENCODINGS: Record<string, readonly string[]> = {
  hash: ['listpack'],
  zset: ['listpack'],
  set:  ['intset', 'listpack'],
};

const COLLECTION_TYPES = new Set(['list', 'hash', 'set', 'zset', 'stream']);

function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

/** Findings for one audited key. */
export function auditRedisKey(row: RedisKeyAuditRow): AuditFinding[] {
  const out: AuditFinding[] = [];
  const { key, key_type, ttl, encoding, size } = row;

  if (ttl === -2) {
    // The SCAN saw this key and the audit did not — say so instead of
    // reporting a phantom.
    out.push({ key, kind: 'expired', severity: 'info',
      message: 'expired between the scan and the audit' });
    return out;
  }

  if (ttl === -1) {
    out.push({ key, kind: 'no-ttl', severity: 'warn',
      message: 'no expiry — persists until explicitly deleted' });
  }

  if (key_type === 'string' && size > BIG_STRING_BYTES) {
    out.push({ key, kind: 'big-string', severity: 'warn',
      message: `${formatBytes(size)} string — every GET moves the whole payload` });
  }

  if (COLLECTION_TYPES.has(key_type) && size > BIG_COLLECTION_ITEMS) {
    out.push({ key, kind: 'big-collection', severity: 'warn',
      message: `${size.toLocaleString()} items — full reads and expiry get expensive` });
  }

  if (encoding) {
    const compact = COMPACT_ENCODINGS[key_type];
    if (compact && size > 0 && size <= COMPACT_ENCODING_MAX && !compact.includes(encoding)) {
      out.push({ key, kind: 'non-compact-encoding', severity: 'info',
        message: `${size}-item ${key_type} stored as ${encoding} — below the ${COMPACT_ENCODING_MAX}-entry threshold, ${compact.join('/')} would use less memory` });
    }
    if (key_type === 'string' && encoding === 'raw' && size <= EMBSTR_MAX) {
      out.push({ key, kind: 'non-compact-encoding', severity: 'info',
        message: `${formatBytes(size)} string stored as raw — under the ${EMBSTR_MAX}-byte embstr ceiling, an extra allocation per access` });
    }
  }

  return out;
}

/**
 * Audit a batch of rows; findings come back warnings first, then by key, so
 * the panel's most actionable rows lead.
 */
export function auditRedisKeys(rows: RedisKeyAuditRow[]): AuditFinding[] {
  const all = rows.flatMap(auditRedisKey);
  const rank = (s: AuditFinding['severity']) => (s === 'warn' ? 0 : 1);
  all.sort((a, b) => rank(a.severity) - rank(b.severity) || a.key.localeCompare(b.key));
  return all;
}

/** Per-kind counts for the audit summary line. */
export function summarizeFindings(findings: AuditFinding[]): Partial<Record<AuditKind, number>> {
  const out: Partial<Record<AuditKind, number>> = {};
  for (const f of findings) out[f.kind] = (out[f.kind] ?? 0) + 1;
  return out;
}
