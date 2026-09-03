/**
 * What the connected role may do, probed once per session and cached.
 *
 * The rules live in the pure `utils/privileges.ts`; this is the part that
 * talks to the server and holds the answer. One probe per session, on first
 * use, because:
 *
 *  - it is one cheap statement (`SHOW GRANTS`, or a single-row PostgreSQL
 *    SELECT of five booleans) and the answer cannot change under us without a
 *    reconnect — grants take effect on the next session anyway;
 *  - every consumer is a toolbar button that renders dozens of times.
 *
 * A failed probe is not an error the user should see. It leaves every
 * capability `unknown`, which the UI treats exactly like granted — so a server
 * that refuses the probe loses the greying, not the features.
 */
import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { QueryResult } from '../types';
import {
  MYSQL_PROBE, PG_PROBE, MSSQL_PROBE,
  mysqlPrivileges, pgPrivileges, pgProbeFromRow,
  mssqlPrivileges, mssqlProbeFromRow, unknownPrivileges,
} from '../utils/privileges';
import type { Privileges } from '../utils/privileges';

const cache = new Map<string, Privileges>();
const inFlight = new Map<string, Promise<Privileges>>();
const listeners = new Set<() => void>();

function emit() { listeners.forEach(fn => fn()); }

async function probe(sessionId: string, engine: string): Promise<Privileges> {
  // Only the engines with a privilege model TxUI can read. Redis ACLs,
  // ClickHouse grants and the file engines are deliberately absent rather than
  // guessed at: no model means `unknown` means nothing is greyed.
  const PROBES: Record<string, string> = {
    mysql: MYSQL_PROBE, postgres: PG_PROBE, sqlserver: MSSQL_PROBE,
  };
  const sql = PROBES[engine];
  if (!sql) return unknownPrivileges();
  try {
    const r = await invoke<QueryResult>('panel_query', {
      sessionId, sql, token: `privileges-${sessionId}`,
    });
    if (engine === 'mysql') {
      // SHOW GRANTS is one column, one line per grant.
      return mysqlPrivileges(r.rows.map(row => String(row[0] ?? '')));
    }
    const row = r.rows[0];
    if (!row) return unknownPrivileges();
    const names = r.columns.map(c => c.name);
    if (engine === 'sqlserver') return mssqlPrivileges(mssqlProbeFromRow(names, row));
    return pgPrivileges(pgProbeFromRow(names, row));
  } catch {
    // No privileges to read privileges, server too old, connection dropped —
    // all the same answer: we do not know, so we grey nothing.
    return unknownPrivileges();
  }
}

/**
 * The capabilities of a session, starting as `unknown` and settling once the
 * probe returns. Safe to call from any number of components.
 */
export function useSessionPrivileges(sessionId: string, engine: string): Privileges {
  const [, force] = useState(0);

  useEffect(() => {
    const fn = () => force(n => n + 1);
    listeners.add(fn);
    if (!cache.has(sessionId) && !inFlight.has(sessionId)) {
      const p = probe(sessionId, engine).then(res => {
        cache.set(sessionId, res);
        inFlight.delete(sessionId);
        emit();
        return res;
      });
      inFlight.set(sessionId, p);
    }
    return () => { listeners.delete(fn); };
  }, [sessionId, engine]);

  return cache.get(sessionId) ?? unknownPrivileges();
}

/** Drop a session's answer — call on disconnect so a reconnect re-probes. */
export function forgetPrivileges(sessionId: string): void {
  cache.delete(sessionId);
  inFlight.delete(sessionId);
}
