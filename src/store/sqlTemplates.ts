/**
 * Stored SQL templates (`?name` editor expansion) — SQLite-backed via the
 * templates commands. Cached in memory; any mutation clears the cache and
 * broadcasts `dbgui:sql-templates-changed` so open editors/lists re-read.
 * The completion source reads through `list()`, so the next keystroke after a
 * save already sees the change.
 */
import { invoke } from '@tauri-apps/api/core';

export interface SqlTemplate {
  id: number;
  name: string;
  /** 'mysql' | 'postgres' | 'redis', or null = any engine */
  engine: string | null;
  description: string;
  body: string;
  builtin: boolean;
  updated_at: string;
}

export interface SqlTemplateInput {
  id?: number | null;
  name: string;
  /** 'any' or '' means every engine */
  engine: string;
  description: string;
  body: string;
}

export const SQL_TEMPLATES_CHANGED = 'dbgui:sql-templates-changed';

let cache: SqlTemplate[] | null = null;
let inflight: Promise<SqlTemplate[]> | null = null;

function changed(): void {
  cache = null;
  window.dispatchEvent(new CustomEvent(SQL_TEMPLATES_CHANGED));
}

export const SqlTemplatesStore = {
  async list(): Promise<SqlTemplate[]> {
    if (cache) return cache;
    if (!inflight) {
      inflight = invoke<SqlTemplate[]>('list_sql_templates')
        .then(rows => { cache = rows; return rows; })
        .finally(() => { inflight = null; });
    }
    return inflight;
  },

  /** Insert (id null/absent) or update; returns the row id. */
  async save(t: SqlTemplateInput): Promise<number> {
    const id = await invoke<number>('save_sql_template', {
      id: t.id ?? null,
      name: t.name,
      engine: !t.engine || t.engine === 'any' ? null : t.engine,
      description: t.description,
      body: t.body,
    });
    changed();
    return id;
  },

  async delete(id: number): Promise<void> {
    await invoke('delete_sql_template', { id });
    changed();
  },
};
