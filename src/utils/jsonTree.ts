/**
 * A parsed JSON value as a tree of nodes, each carrying the path that reaches
 * it. Pure and dependency-free: the cell viewer already holds the parsed
 * value, so this only has to describe it — build the nodes, format a path.
 *
 * Bounded on purpose. A jsonb column can be a megabyte of deeply nested
 * document, and eagerly walking it into React elements would freeze the
 * modal. So the walk stops at `maxDepth` and each container keeps at most
 * `maxChildren` entries, flagging `truncated` when it dropped the rest — the
 * viewer is an inspection surface, not a full renderer.
 */

export type JsonNodeType = 'object' | 'array' | 'string' | 'number' | 'bool' | 'null';

export type PathPart = string | number;

export interface JsonNode {
  /** Key within the parent; `null` at the root. */
  key: PathPart | null;
  /** Full path from the root, e.g. `['user', 'tags', 0]`. */
  path: PathPart[];
  type: JsonNodeType;
  /** One-line summary shown when the node is collapsed or is a leaf. */
  preview: string;
  /** The raw value at this node (containers included). */
  value: unknown;
  /** Present for objects and arrays; absent for primitives. */
  children?: JsonNode[];
  /** True when children were dropped by the `maxChildren` cap. */
  truncated?: boolean;
}

export interface BuildOptions {
  /** How deep to walk before leaving a container's children unbuilt. */
  maxDepth?: number;
  /** How many entries of any one container to build. */
  maxChildren?: number;
  /** Characters before a string preview is elided. */
  previewLen?: number;
}

const DEFAULTS = { maxDepth: 100, maxChildren: 1000, previewLen: 80 };

/** Classify a parsed JSON value into a node type. */
export function jsonType(value: unknown): JsonNodeType {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return 'array';
  switch (typeof value) {
    case 'boolean': return 'bool';
    case 'number': return 'number';
    case 'string': return 'string';
    default: return 'object';
  }
}

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * Format a path as a JSONPath-ish string: `$.a.b[0].c`. Array indices and
 * keys that are not plain identifiers use bracket notation with a quoted,
 * JSON-escaped key (`$["odd key"]`, `$["a.b"]`).
 */
export function jsonPath(parts: PathPart[]): string {
  let out = '$';
  for (const part of parts) {
    if (typeof part === 'number') {
      out += `[${part}]`;
    } else if (IDENT.test(part)) {
      out += `.${part}`;
    } else {
      out += `[${JSON.stringify(part)}]`;
    }
  }
  return out;
}

/** A short, single-line preview of a value for a collapsed/leaf node. */
export function preview(value: unknown, previewLen = DEFAULTS.previewLen): string {
  switch (jsonType(value)) {
    case 'null': return 'null';
    case 'bool': return String(value);
    case 'number': return String(value);
    case 'array': return `[${(value as unknown[]).length}]`;
    case 'object': return `{${Object.keys(value as object).length}}`;
    case 'string': {
      const s = value as string;
      const clipped = s.length > previewLen ? s.slice(0, previewLen) + '…' : s;
      return JSON.stringify(clipped);
    }
  }
}

/** Build a single node (with children up to the depth/count caps). */
function build(
  key: PathPart | null,
  value: unknown,
  path: PathPart[],
  depth: number,
  opt: Required<BuildOptions>,
): JsonNode {
  const type = jsonType(value);
  const node: JsonNode = { key, path, type, preview: preview(value, opt.previewLen), value };

  if ((type === 'object' || type === 'array') && depth < opt.maxDepth) {
    const entries: [PathPart, unknown][] = type === 'array'
      ? (value as unknown[]).map((v, i) => [i, v])
      : Object.entries(value as Record<string, unknown>);

    const shown = entries.slice(0, opt.maxChildren);
    node.children = shown.map(([k, v]) =>
      build(k, v, [...path, k], depth + 1, opt));
    if (entries.length > shown.length) node.truncated = true;
  }
  return node;
}

/**
 * Build the root node for a parsed JSON value. The root has `key: null` and an
 * empty path; its `jsonPath` is `$`.
 */
export function buildTree(value: unknown, options: BuildOptions = {}): JsonNode {
  const opt: Required<BuildOptions> = { ...DEFAULTS, ...options };
  return build(null, value, [], 0, opt);
}

/** Whether a node can be expanded (is a non-empty container). */
export function isExpandable(node: JsonNode): boolean {
  return !!node.children && node.children.length > 0;
}
