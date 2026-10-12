/**
 * Aggregation-pipeline validation for the MongoDB runner — the client-side
 * mirror of the Rust guard in src-tauri/src/db/mongodb.rs (`parse_pipeline` /
 * `WRITE_STAGES`), the same two-sided convention as utils/sqlGuard.ts: the
 * pre-flight here catches a bad pipeline without a round-trip, the Rust side
 * enforces it for real.
 *
 * The rules, identically on both sides:
 * - the text must be a JSON ARRAY of stages;
 * - each stage is a single-key object whose key starts with '$';
 * - `$out` and `$merge` are write stages and are rejected — the MongoDB
 *   driver is read-only by design (owner decision: no write path);
 * - error messages name the stage 1-based ("stage 2").
 *
 * Pure and dependency-free — driven by `node --test`
 * (tests/mongoPipeline.test.ts also drift-guards WRITE_STAGES against the
 * Rust literal).
 */

/** Mirrored in src-tauri/src/db/mongodb.rs — drift-guarded by
 *  tests/mongoPipeline.test.ts. Keep both lists in the same order. */
export const WRITE_STAGES = ['$out', '$merge'] as const;

export type PipelineValidation =
  | { ok: true; stageCount: number }
  | { ok: false; error: string; stageIndex?: number };

/**
 * Validate the pipeline editor's text. Stage indexes in errors are 1-based
 * (matching the Rust messages); `stageIndex` carries the 0-based position
 * for callers that want to point at the stage.
 */
export function validatePipeline(text: string): PipelineValidation {
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, error: 'pipeline is empty' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (e) {
    return { ok: false, error: `invalid pipeline JSON: ${(e as Error).message}` };
  }
  if (!Array.isArray(parsed)) {
    return { ok: false, error: 'pipeline must be a JSON array of stages ([ { "$match": … } ])' };
  }
  for (let i = 0; i < parsed.length; i++) {
    const name = stageName(parsed[i]);
    if (name === null) {
      const stage = parsed[i];
      const why = typeof stage !== 'object' || stage === null || Array.isArray(stage)
        ? 'must be a JSON object ({ "$match": … })'
        : Object.keys(stage).length !== 1
          ? 'must have exactly one key (the stage operator)'
          : `key "${Object.keys(stage)[0]}" is not a stage operator — stage keys start with '$'`;
      return { ok: false, error: `stage ${i + 1} ${why}`, stageIndex: i };
    }
    const w = WRITE_STAGES.find(s => s === name);
    if (w) {
      return {
        ok: false,
        error: `write stage ${w} is not allowed — this MongoDB driver is read-only by design`,
        stageIndex: i,
      };
    }
  }
  return { ok: true, stageCount: parsed.length };
}

/** The stage operator of a well-formed stage object, else null. */
export function stageName(stage: unknown): string | null {
  if (typeof stage !== 'object' || stage === null || Array.isArray(stage)) return null;
  const keys = Object.keys(stage);
  return keys.length === 1 && keys[0].startsWith('$') ? keys[0] : null;
}

export interface StageSnippet {
  /** The stage operator, shown in the dropdown. */
  name: string;
  /** One complete, valid stage object as JSON text. */
  snippet: string;
}

/** The stage-snippet dropdown's entries — each snippet parses as exactly one
 *  valid stage (the test asserts the property). */
export const STAGE_SNIPPETS: readonly StageSnippet[] = [
  { name: '$match',     snippet: '{ "$match": { "field": "value" } }' },
  { name: '$group',     snippet: '{ "$group": { "_id": "$field", "count": { "$sum": 1 } } }' },
  { name: '$sort',      snippet: '{ "$sort": { "field": -1 } }' },
  { name: '$limit',     snippet: '{ "$limit": 100 }' },
  { name: '$skip',      snippet: '{ "$skip": 100 }' },
  { name: '$project',   snippet: '{ "$project": { "field": 1 } }' },
  { name: '$addFields', snippet: '{ "$addFields": { "newField": "$field" } }' },
  { name: '$unwind',    snippet: '{ "$unwind": "$arrayField" }' },
  { name: '$lookup',    snippet: '{ "$lookup": { "from": "collection", "localField": "field", "foreignField": "field", "as": "joined" } }' },
  { name: '$count',     snippet: '{ "$count": "total" }' },
  { name: '$facet',     snippet: '{ "$facet": { "byField": [ { "$group": { "_id": "$field", "count": { "$sum": 1 } } } ] } }' },
  { name: '$sample',    snippet: '{ "$sample": { "size": 5 } }' },
];

/** What the pipeline editor opens with. */
export const DEFAULT_PIPELINE = '[\n  { "$match": {} }\n]\n';

/**
 * Append a snippet to the pipeline text, returning the re-serialized whole.
 * The editor replaces its document with the result, so the output must be
 * valid JSON even when the current text is not — a broken pipeline is an
 * error, not a guess at splice points.
 */
export function appendSnippet(
  text: string,
  snippet: string,
): { ok: true; text: string } | { ok: false; error: string } {
  let base: unknown;
  try {
    base = text.trim() ? JSON.parse(text) : [];
  } catch (e) {
    return { ok: false, error: `fix the pipeline JSON before adding a stage: ${(e as Error).message}` };
  }
  if (!Array.isArray(base)) {
    return { ok: false, error: 'the pipeline is not a JSON array — fix it before adding a stage' };
  }
  base.push(JSON.parse(snippet));
  return { ok: true, text: `${JSON.stringify(base, null, 2)}\n` };
}
