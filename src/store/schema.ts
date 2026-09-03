import { invoke } from '@tauri-apps/api/core';
import type { SchemaNode } from '../types';

export const SchemaStore = {
  async listSchema(sessionId: string, context?: string): Promise<SchemaNode[]> {
    return invoke('list_schema', { sessionId, context: context ?? null });
  },

  async listColumns(sessionId: string, parent: string): Promise<SchemaNode[]> {
    return invoke('list_columns', { sessionId, parent });
  },

  /** Children of a nested Parquet struct column, by its dotted path. */
  async listParquetStruct(sessionId: string, path: string): Promise<SchemaNode[]> {
    return invoke('list_parquet_struct', { sessionId, path });
  },

  async getDdl(sessionId: string, parent: string): Promise<string> {
    return invoke('get_ddl', { sessionId, parent });
  },
};
