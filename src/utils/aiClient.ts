/**
 * Backend-only key access, cancellable requests and the three assistant modes.
 * Callers receive the id before awaiting so closing a modal can stop HTTP work.
 */
import { invoke } from '@tauri-apps/api/core';
import { getPref, PREFS } from '../store/preferences';

export interface AiRequest {
  requestId: string;
  promise: Promise<string>;
}

function complete(prompt: string, system: string): AiRequest {
  const requestId = crypto.randomUUID();
  const promise = invoke<string>('ai_complete', {
    requestId,
    provider: getPref(PREFS.aiProvider),
    baseUrl: getPref(PREFS.aiBaseUrl),
    model: getPref(PREFS.aiModel),
    system,
    prompt,
  });
  return { requestId, promise };
}

export const aiCancel = (requestId: string) => invoke<boolean>('ai_cancel', { requestId });

/** Strip a ```sql fenced block down to the SQL, if the model wrapped it. */
export function unfenceSql(text: string): string {
  const m = /```(?:sql)?\s*([\s\S]*?)```/i.exec(text);
  return (m ? m[1] : text).trim();
}

const RULES = (engine: string) =>
  `You are a SQL expert for ${engine}. Output only the SQL, no prose, no markdown fences unless asked. Use ${engine} dialect. Use only schema objects supplied by the user; never invent tables or columns.`;

export function aiGenerateSql(request: string, engine: string, schema?: string): AiRequest {
  const ctx = schema ? `\n\nAvailable schema (name: columns):\n${schema}` : '';
  return complete(`${request}${ctx}`, RULES(engine));
}

export function aiExplainSql(sql: string, engine: string, schema?: string): AiRequest {
  const ctx = schema ? `\n\nRelevant schema:\n${schema}` : '';
  return complete(`${sql}${ctx}`,
    `Explain this ${engine} SQL statement clearly and concisely for a developer. Cover what it returns/does and any performance caveats. Ground caveats in the SQL and supplied schema; say when evidence is missing.`);
}

export function aiFixSql(sql: string, error: string, engine: string, schema?: string): AiRequest {
  const ctx = schema ? `\n\nRelevant schema:\n${schema}` : '';
  return complete(`Statement:\n${sql}\n\nError:\n${error}${ctx}`,
    `${RULES(engine)} The user's statement failed. Return a corrected version of the statement only.`);
}

export function aiExplainPlan(evidence: string, engine: string, schema?: string): AiRequest {
  const ctx = schema ? `\n\nRelevant schema metadata:\n${schema}` : '';
  return complete(`${evidence}${ctx}`,
    `You are a ${engine} database performance expert. Explain this execution plan for a DBA. Start with whether the evidence is measured or estimated. Summarize the main bottlenecks, then explain TxUI's deterministic findings and give practical tuning steps. Ground every claim in the supplied plan and schema. Do not invent indexes, statistics or measurements, do not claim to have run anything, and explicitly name missing evidence that would change the recommendation.`);
}

export function aiTestConnection(): AiRequest {
  return complete('Reply with exactly: OK', 'You are a connectivity check. No other output is needed.');
}

export const aiSetKey = (key: string) => invoke<void>('ai_set_key', { key });
export const aiHasKey = () => invoke<boolean>('ai_has_key');
