import { invoke } from '@tauri-apps/api/core';
import type { QueryResult, SchemaNode, Session } from '../types';

export const QueryStore = {
  // Non-tab callers (SchemaTree probes, the mini QueryEditor): tabId 0 is the
  // shared "no tab" cancellation handle — these call sites never cancel.
  async execute(session: Session, sql: string): Promise<QueryResult> {
    return invoke('execute_query', {
      sessionId: session.sessionId,
      connectionId: session.connectionId,
      engine: session.engine,
      sql,
      tabId: 0,
    });
  },

  async listSchema(sessionId: string, context?: string): Promise<SchemaNode[]> {
    return invoke('list_schema', { sessionId, context: context ?? null });
  },
};
