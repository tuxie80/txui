import { invoke } from '@tauri-apps/api/core';
import type { ConnectionConfig, PingResult } from '../types';
import type { StagedConnectResult } from '../utils/connDiag';
import { forgetConnection } from './virtualFks';

export const ConnectionsStore = {
  async list(): Promise<ConnectionConfig[]> {
    return invoke('list_connections');
  },

  async save(config: ConnectionConfig, password?: string, sshPassword?: string): Promise<string> {
    return invoke('save_connection', {
      config,
      password:    password ?? null,
      sshPassword: sshPassword ?? null,
    });
  },

  async delete(id: string): Promise<void> {
    await invoke('delete_connection', { id });
    // Virtual FKs are scoped to a connection and live only in this browser's
    // storage, so nothing on the server side clears them. Left behind, they
    // would be inherited by whatever connection is created next with a
    // recycled id, and would otherwise accumulate forever unseen.
    forgetConnection(id);
  },

  async test(id: string): Promise<PingResult> {
    return invoke('test_connection', { id });
  },

  /** Test an UNSAVED config. Nothing is persisted; empty password fields mean
   *  "no password" here (the secret store is not consulted). */
  async testAdhoc(config: ConnectionConfig, password?: string, sshPassword?: string): Promise<string> {
    return invoke('test_connection_adhoc', {
      config,
      password:    password || null,
      sshPassword: sshPassword || null,
    });
  },

  /** Staged diagnostics (W3.1): DNS → TCP → SSH → TLS → auth → probe, each
   *  with ok/fail/skipped + ms + detail. A failed run is DATA (verdict
   *  'fail'), not a rejection. Blank passwords on a saved config fall back to
   *  the stored secret backend-side. */
  async testStaged(config: ConnectionConfig, password?: string, sshPassword?: string): Promise<StagedConnectResult> {
    return invoke('connect_test_staged', {
      config,
      password:    password || null,
      sshPassword: sshPassword || null,
    });
  },

  /** Cancel an in-flight open_connection for this connection (W3.2). Returns
   *  whether there was an attempt to cancel; the open itself then rejects
   *  with code 'cancelled'. */
  async cancelConnect(connectionId: string): Promise<boolean> {
    return invoke('cancel_connect', { connectionId });
  },

  /** Round-trip latency (ms) of an OPEN session. */
  async sessionPing(sessionId: string): Promise<number> {
    return invoke('session_ping', { sessionId });
  },

  /** Pool occupancy of an OPEN session (W4.4): total / idle / in-use.
   *  null for the non-sqlx engines (Redis, MongoDB, file engines) — there is
   *  no pool to report. */
  async sessionPoolStats(sessionId: string): Promise<{ size: number; idle: number; in_use: number } | null> {
    return invoke('session_pool_stats', { sessionId });
  },

  /** JSON envelope of all saved connections (no secrets). */
  async exportAll(): Promise<string> {
    return invoke('export_connections', { ids: null });
  },

  /** Import an export envelope; returns the number of connections imported. */
  async importJson(json: string): Promise<number> {
    return invoke('import_connections', { json });
  },

  async open(id: string): Promise<string> {
    return invoke('open_connection', { id });
  },

  /** Open an ephemeral in-memory DuckDB session — no saved connection, no
   *  vault, nothing persisted (the scratch buffer). */
  async openScratch(): Promise<string> {
    return invoke('open_scratch_session');
  },

  /** Returns the DB thread ids (CONNECTION_ID / backend pid) that were closed. */
  async close(sessionId: string): Promise<number[]> {
    return invoke('close_connection', { sessionId });
  },
};
