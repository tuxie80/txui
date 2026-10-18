/**
 * Local service auto-discovery (W5.3) — the pure half.
 *
 * The backend's `discover_local_services` probes the well-known ports on this
 * machine and reports what answered. This module turns one answer into a
 * connection-form prefill, and filters out services that already have a saved
 * connection (scanning to rediscover what you already have is noise).
 *
 * Only the engine, host and port are prefilled — user/database stay blank so
 * the engine defaults show as placeholder text and resolve at save time
 * (utils/connDefaults), exactly as if the fields were never touched.
 *
 * Pure module: no React/Tauri imports, unit-tested with `node --test`.
 */
import type { ConnectionConfig, Engine } from '../types';

/** One answer from `discover_local_services` — mirrors the Rust struct. */
export interface DiscoveredService {
  /** The backend only probes client/server engines — never the file engines. */
  engine: Engine;
  port: number;
  /** What the probe learned, e.g. a version banner; display-only. */
  detail: string;
}

/** Suggested connection name for a discovered service. */
export function discoveryName(s: DiscoveredService): string {
  return `${s.engine} on localhost:${s.port}`;
}

/**
 * Service → connection-form prefill. Host is pinned to 127.0.0.1 (the probe
 * only scans this machine); everything else is left to the placeholders.
 */
export function discoveryPrefill(s: DiscoveredService): Partial<ConnectionConfig> {
  return {
    engine: s.engine,
    host: '127.0.0.1',
    port: s.port,
    name: discoveryName(s),
  };
}

/** True when a saved connection already points at this engine+port on this machine. */
export function alreadySaved(s: DiscoveredService, conns: ConnectionConfig[]): boolean {
  return conns.some(c =>
    c.engine === s.engine && c.port === s.port &&
    (c.host === null || c.host === '' || c.host === 'localhost' || c.host === '127.0.0.1' || c.host === '::1'));
}
