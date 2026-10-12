/**
 * Galera auto-discovery — the matching layer between what the connected node
 * ALREADY knows (`wsrep_incoming_addresses` lists its cluster mates, parsed by
 * the Galera tab's existing 5 s poll — no new probe anywhere) and the user's
 * saved connections.
 *
 * The flow this feeds (all OFFERED, never forced — nothing here polls or
 * saves on its own):
 *
 *   incoming tokens ──findUnsavedMembers──▶ members no saved MySQL
 *     connection covers ──▶ banner in GaleraClusterView ──▶
 *       "Add as connections": `galera_adopt_members` (backend clones the
 *         seed config per member, secrets copied to the new ids)
 *       "Monitor once": buildAdhocConfig per member → store/galeraAdhoc →
 *         the cluster panel polls them via galera_cluster_poll's
 *         adhocConfigs (unsaved, in-memory only)
 *
 * The crux is `normalizeHostPort`: wsrep reports addresses the way the SERVER
 * sees them (`127.0.0.1:3342`), the user saves them the way THEY typed them
 * (`localhost:3342`, maybe `LOCALHOST`, maybe no port at all). Without one
 * canonical form the banner would offer to "discover" nodes that are already
 * saved — the one way an offer becomes noise.
 *
 * Pure: no React/Tauri imports — unit-tested with node --test.
 */
import type { ConnectionConfig } from '../types';

/** MySQL's default port, filled when an address carries none. */
export const DEFAULT_MYSQL_PORT = 3306;

/**
 * One `wsrep_incoming_addresses` token → host + port. Tokens are `host:port`
 * (IPv6 optionally bracketed); a bare host gets the default port. 'AUTO' and
 * blanks — parseIncoming already drops them, this tolerates them anyway —
 * come back null, as does a token with no usable host or a non-numeric port.
 */
export function splitHostPort(token: string): { host: string; port: number } | null {
  const t = token.trim();
  if (!t || t.toUpperCase() === 'AUTO') return null;
  let host: string;
  let port = DEFAULT_MYSQL_PORT;
  if (t.startsWith('[')) {
    // [v6] or [v6]:port
    const close = t.indexOf(']');
    if (close < 0) return null;
    host = t.slice(1, close);
    const rest = t.slice(close + 1);
    if (rest) {
      if (!rest.startsWith(':')) return null;
      const p = Number(rest.slice(1));
      if (!Number.isInteger(p) || p <= 0 || p > 65535) return null;
      port = p;
    }
  } else {
    const colons = t.split(':');
    if (colons.length === 2) {
      // host:port — the only unambiguous single-colon shape
      [host] = colons;
      const p = Number(colons[1]);
      if (!Number.isInteger(p) || p <= 0 || p > 65535) return null;
      port = p;
    } else {
      // Bare hostname, or a bare (unbracketed) IPv6 literal: no port.
      host = t;
    }
  }
  host = host.trim().toLowerCase();
  if (!host) return null;
  return { host, port };
}

/** The loopback spellings that all mean "this machine". */
const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1']);

/**
 * Canonical `host:port` for comparisons: lowercase, IPv6 brackets stripped,
 * every loopback spelling folded to `127.0.0.1`, a missing port filled with
 * the MySQL default. Two addresses that would connect to the same server
 * normalize to the same token.
 */
export function normalizeHostPort(host: string, port: number | null): string {
  let h = host.trim().toLowerCase();
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  if (LOOPBACK.has(h)) h = '127.0.0.1';
  return `${h}:${port ?? DEFAULT_MYSQL_PORT}`;
}

/** A saved MySQL-family connection's address in the canonical form. */
function configToken(c: ConnectionConfig): string | null {
  const host = c.host?.trim();
  if (!host) return null;
  return normalizeHostPort(host, c.port ?? null);
}

/**
 * The discovered members NOT covered by any saved MySQL connection: the
 * banner's "M not in your connections" and the adoption list. The current
 * connection's own address is excluded explicitly (it is normally in `saved`
 * anyway — belt and braces for a renamed/unsaved seed). Duplicates in
 * `incoming` collapse to one entry; the kept host/port pair is the parsed
 * (lowercased) form — what the adopted/ad-hoc connection will dial.
 */
export function findUnsavedMembers(
  incoming: string[],
  saved: ConnectionConfig[],
  selfConnectionId: string,
): { host: string; port: number }[] {
  const covered = new Set<string>();
  for (const c of saved) {
    if (c.engine !== 'mysql') continue;
    const t = configToken(c);
    if (t) covered.add(t);
  }
  const self = saved.find(c => c.id === selfConnectionId);
  if (self) {
    const t = configToken(self);
    if (t) covered.add(t);
  }

  const out: { host: string; port: number }[] = [];
  const seen = new Set<string>();
  for (const token of incoming) {
    const hp = splitHostPort(token);
    if (!hp) continue;
    const norm = normalizeHostPort(hp.host, hp.port);
    if (covered.has(norm) || seen.has(norm)) continue;
    seen.add(norm);
    out.push(hp);
  }
  return out;
}

/**
 * The adopted/monitored member's connection name — short enough for the
 * sidebar and the cluster panel's node cards: `db @ 127.0.0.1:3342` with the
 * cluster name when known, a bare `host:port` otherwise. An over-long cluster
 * name is truncated rather than dropped: the host:port is the part that must
 * never be ambiguous.
 */
export function memberDisplayName(clusterName: string | null, host: string, port: number): string {
  const addr = `${host}:${port}`;
  const name = clusterName?.trim();
  if (!name) return addr;
  const budget = 30 - addr.length - 3; // " @ " between name and address
  const short = name.length > budget && budget >= 4 ? `${name.slice(0, budget - 1)}…` : name;
  return `${short} @ ${addr}`;
}

/**
 * The unsaved "Monitor once" config for one discovered member: a clone of the
 * seed that keeps the seed's ID ON PURPOSE — the backend resolves the
 * password by `dbgui:{id}`, so keeping it is what lets the ephemeral poll
 * authenticate with the seed's credentials (and the SSH password via
 * `dbgui-ssh:{id}`). The id never leaves this object: the backend emits Node
 * events under a synthetic per-member id (adhoc_event_id in
 * commands/galera.rs), so the merge cannot collide with the seed's own node.
 */
export function buildAdhocConfig(
  seed: ConnectionConfig,
  host: string,
  port: number,
  clusterName: string | null = null,
): ConnectionConfig {
  return {
    ...seed,
    host,
    port,
    name: memberDisplayName(clusterName, host, port),
  };
}

/**
 * The banner's dismiss semantics, minus the localStorage: dismissed at count
 * N stays hidden while the unsaved count is ≤ N and REAPPEARS when the
 * cluster grows past it — "you dismissed 2, but now there are 3" is new
 * information, not nagging.
 */
export function shouldShowDiscoverBanner(
  unsavedCount: number,
  dismissedCount: number | null,
): boolean {
  if (unsavedCount <= 0) return false;
  if (dismissedCount === null) return true;
  return unsavedCount > dismissedCount;
}
