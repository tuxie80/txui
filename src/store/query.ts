import { invoke } from '@tauri-apps/api/core';
import type { QueryResult, SchemaNode } from '../types';

export const QueryStore = {
  async execute(sessionId: string, sql: string): Promise<QueryResult> {
    return invoke('execute_query', { sessionId, sql });
  },

  async listSchema(sessionId: string, context?: string): Promise<SchemaNode[]> {
    return invoke('list_schema', { sessionId, context: context ?? null });
  },
};
