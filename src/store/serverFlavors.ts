/**
 * Which MySQL-protocol server each session is talking to.
 *
 * Probed once per session and cached, the same shape as `sessionPrivileges`:
 * several panels want the answer, none of them should ask again, and the
 * answer cannot change while a session is open.
 *
 * The distinction is not cosmetic. MySQL and MariaDB answer the same DBA
 * questions from different catalogs, and a panel that guesses wrong does not
 * degrade — it shows the server's "table doesn't exist" error, which reads as
 * though the user has broken something.
 *
 * The classification itself is pure and lives in `utils/serverFlavor.ts`.
 */
import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { QueryResult } from '../types';
import { detectFlavor, capabilities } from '../utils/serverFlavor';
import type { ServerFlavor, Capabilities } from '../utils/serverFlavor';

const cache = new Map<string, ServerFlavor>();
const inFlight = new Map<string, Promise<ServerFlavor>>();
const listeners = new Set<() => void>();
const emit = () => listeners.forEach(fn => fn());

/**
 * Until the probe lands, assume plain MySQL of no known version.
 *
 * Deliberately version 0: every capability gated on a version is then off, so
 * the first render cannot offer a feature the server may not have. Being
 * briefly too cautious is recoverable; running MariaDB-only SQL against MySQL
 * because we assumed is not.
 */
const UNKNOWN: ServerFlavor = { flavor: 'mysql', major: 0, minor: 0, patch: 0, raw: '' };

async function probe(sessionId: string): Promise<ServerFlavor> {
  try {
    const r = await invoke<QueryResult>('monitor_query', {
      sessionId,
      sql: 'SELECT VERSION() AS v, @@version_comment AS c',
    });
    const row = r.rows[0] ?? [];
    return detectFlavor(String(row[0] ?? ''), String(row[1] ?? ''));
  } catch {
    // A server that will not answer this is not one to guess about.
    return UNKNOWN;
  }
}

/** The flavour of this session's server. `UNKNOWN` until the probe returns. */
export function useServerFlavor(sessionId: string, engine: string): ServerFlavor {
  const [, force] = useState(0);

  useEffect(() => {
    // Only the MySQL-protocol engines have a flavour question.
    if (engine !== 'mysql') return;
    const fn = () => force(n => n + 1);
    listeners.add(fn);
    if (!cache.has(sessionId) && !inFlight.has(sessionId)) {
      const p = probe(sessionId).then(res => {
        cache.set(sessionId, res);
        inFlight.delete(sessionId);
        emit();
        return res;
      });
      inFlight.set(sessionId, p);
    }
    return () => { listeners.delete(fn); };
  }, [sessionId, engine]);

  return cache.get(sessionId) ?? UNKNOWN;
}

/** The flavour and what it can do, for callers that want both. */
export function useServerCapabilities(
  sessionId: string, engine: string,
): { flavor: ServerFlavor; caps: Capabilities } {
  const flavor = useServerFlavor(sessionId, engine);
  return { flavor, caps: capabilities(flavor) };
}

/** Drop a session's answer — call on disconnect so a reconnect re-probes. */
export function forgetFlavor(sessionId: string): void {
  cache.delete(sessionId);
  inFlight.delete(sessionId);
}
