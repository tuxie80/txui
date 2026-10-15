/**
 * Per-session DuckDB spatial-extension state — whether `INSTALL/LOAD spatial`
 * has run on this session, and if it failed, why.
 *
 * GEOMETRY is a core type since DuckDB 1.5 (reading and drawing geometry works
 * offline), but the ST_* functions, the EPSG catalog, ST_Read and GeoParquet
 * writing live in the `spatial` extension, which is NOT bundled — the first
 * INSTALL downloads a per-platform binary from DuckDB's extension repository,
 * afterwards LOAD works offline from ~/.duckdb/extensions. Hence on-demand:
 * a toolbar affordance calls duckdb_enable_spatial, and the answer gates the
 * ST_* completions (offering them before LOAD is offering a catalog error).
 *
 * In-memory per session, like sessionPrivileges: a reconnect re-asks. The
 * state survives nothing else because it means nothing else — LOAD is
 * session-local by definition.
 */
import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { errorDisplay } from '../utils/appError';
import { addLog } from './logStore';

export type DuckdbSpatialState =
  /** Not loaded (initial). The affordance is offered. */
  | { status: 'off' }
  /** INSTALL/LOAD in flight. */
  | { status: 'enabling' }
  /** LOAD spatial succeeded — ST_* functions, ST_Read, GeoParquet COPY work. */
  | { status: 'on' }
  /**
   * INSTALL/LOAD failed. `network` = the failure looked like no network /
   * unreachable extension repository (the one-time download is the only
   * network step) — the UI greys itself and says so.
   */
  | { status: 'failed'; reason: string; network: boolean };

interface SpatialEnableResult {
  enabled: boolean;
  alreadyInstalled: boolean;
  installedNow: boolean;
  error: string | null;
  networkError: boolean;
}

const states = new Map<string, DuckdbSpatialState>();
const listeners = new Set<() => void>();

function emit() { listeners.forEach(fn => fn()); }

export function duckdbSpatialState(sessionId: string): DuckdbSpatialState {
  return states.get(sessionId) ?? { status: 'off' };
}

/** The session's spatial state; re-renders when it changes. */
export function useDuckdbSpatial(sessionId: string): DuckdbSpatialState {
  const [, force] = useState(0);
  useEffect(() => {
    const fn = () => force(n => n + 1);
    listeners.add(fn);
    return () => { listeners.delete(fn); };
  }, [sessionId]);
  return duckdbSpatialState(sessionId);
}

/**
 * Run INSTALL (when needed) + LOAD spatial on the session, reporting progress
 * and the outcome to the session log. Idempotent: a session already `on` is a
 * no-op; `enabling` refuses a second concurrent run.
 */
export async function enableDuckdbSpatial(sessionId: string, label: string): Promise<void> {
  const cur = duckdbSpatialState(sessionId);
  if (cur.status === 'on' || cur.status === 'enabling') return;
  states.set(sessionId, { status: 'enabling' });
  emit();
  addLog(sessionId, {
    level: 'info', action: 'SPATIAL',
    detail: 'LOAD spatial — installing the DuckDB spatial extension if needed (one-time download)',
    line: 'Enabling DuckDB spatial — LOAD spatial (INSTALL first if the binary is not on disk yet; that one step needs the network)',
  });
  try {
    const r = await invoke<SpatialEnableResult>('duckdb_enable_spatial', { sessionId });
    if (r.enabled) {
      states.set(sessionId, { status: 'on' });
      addLog(sessionId, {
        level: 'ok', action: 'SPATIAL',
        detail: r.installedNow ? 'spatial extension installed and loaded' : 'spatial extension already installed — loaded',
        line: `${label}: spatial extension ${r.installedNow ? 'installed (downloaded once from DuckDB\'s extension repository) and loaded' : 'loaded (was already installed)'} — ST_* functions, ST_Read, and GeoParquet writing via COPY (SELECT …) TO 'file.parquet' (FORMAT PARQUET) are available`,
      });
    } else {
      const reason = r.error ?? 'unknown error';
      states.set(sessionId, { status: 'failed', reason, network: r.networkError });
      addLog(sessionId, {
        level: 'err', action: 'SPATIAL',
        detail: reason,
        line: `Spatial extension could not be enabled: ${reason}${r.networkError ? ' — INSTALL downloads from DuckDB\'s extension repository; without network it cannot run' : ''}`,
      });
    }
  } catch (e) {
    const reason = errorDisplay(e);
    states.set(sessionId, { status: 'failed', reason, network: false });
    addLog(sessionId, {
      level: 'err', action: 'SPATIAL', detail: reason,
      line: `Spatial extension could not be enabled: ${reason}`,
    });
  }
  emit();
}

/** Drop a session's state — call on disconnect so a reconnect starts fresh. */
export function forgetDuckdbSpatial(sessionId: string): void {
  states.delete(sessionId);
  emit();
}
