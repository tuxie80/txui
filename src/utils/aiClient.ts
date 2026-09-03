/**
 * Frontend entry to the AI assistant. Reads the non-secret config from prefs
 * and calls the backend, which supplies the vault-stored key. Three shapes —
 * generate (NL→SQL), explain, fix — differ only in the system prompt.
 */
import { invoke } from '@tauri-apps/api/core';
import { getPref, PREFS } from '../store/preferences';

async function complete(prompt: string, system: string): Promise<string> {
  return invoke<string>('ai_complete', {
    provider: getPref(PREFS.aiProvider),
    baseUrl: getPref(PREFS.aiBaseUrl),
    model: getPref(PREFS.aiModel),
    system,
    prompt,
  });
}

/** Strip a ```sql fenced block down to the SQL, if the model wrapped it. */
export function unfenceSql(text: string): string {
  const m = /```(?:sql)?\s*([\s\S]*?)```/i.exec(text);
  return (m ? m[1] : text).trim();
}

const RULES = (engine: string) =>
  `You are a SQL expert for ${engine}. Output only the SQL, no prose, no markdown fences unless asked. Use ${engine} dialect.`;

/** Natural-language request → SQL. `schema` is an optional context summary. */
export function aiGenerateSql(request: string, engine: string, schema?: string): Promise<string> {
  const ctx = schema ? `\n\nAvailable schema (name: columns):\n${schema}` : '';
  return complete(`${request}${ctx}`, RULES(engine));
}

/** Explain what a statement does, in plain language. */
export function aiExplainSql(sql: string, engine: string): Promise<string> {
  return complete(sql, `Explain this ${engine} SQL statement clearly and concisely for a developer. Cover what it returns/does and any performance caveats.`);
}

/** Given a statement and the error it produced, propose a corrected statement. */
export function aiFixSql(sql: string, error: string, engine: string): Promise<string> {
  return complete(`Statement:\n${sql}\n\nError:\n${error}`,
    `${RULES(engine)} The user's statement failed. Return a corrected version of the statement only.`);
}

export const aiSetKey = (key: string) => invoke<void>('ai_set_key', { key });
export const aiHasKey = () => invoke<boolean>('ai_has_key');
