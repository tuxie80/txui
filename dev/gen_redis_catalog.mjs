// Generate src/utils/redisCommands.ts from the connected server's own
// COMMAND DOCS + COMMAND INFO. The server is the authoritative source: it
// knows its exact version and any loaded modules.
import { execFileSync } from 'node:child_process';

const cli = (...args) =>
  execFileSync('redis-cli', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });

const docs = JSON.parse(cli('--json', 'COMMAND', 'DOCS'));
const info = JSON.parse(cli('--json', 'COMMAND', 'INFO'));

// COMMAND INFO → arity + flags, keyed by lowercase name.
// A bare `COMMAND INFO` lists only TOP-LEVEL commands, so container
// subcommands ("config|set") come back missing and would ship with arity 0.
// They have to be asked for by name — the server resolves the pipe form.
const meta = new Map();
for (const row of info) {
  if (!Array.isArray(row) || !row[0]) continue;
  meta.set(String(row[0]).toLowerCase(), { arity: row[1], flags: row[2] ?? [] });
}

function fetchSubMeta(names) {
  if (!names.length) return;
  const rows = JSON.parse(cli('--json', 'COMMAND', 'INFO', ...names));
  for (const row of rows) {
    if (!Array.isArray(row) || !row[0]) continue;
    meta.set(String(row[0]).toLowerCase(), { arity: row[1], flags: row[2] ?? [] });
  }
}
{
  const subNames = [];
  for (const d of Object.values(docs)) {
    if (d.subcommands) subNames.push(...Object.keys(d.subcommands));
  }
  // Chunked so the argument list stays a sane size.
  for (let i = 0; i < subNames.length; i += 50) fetchSubMeta(subNames.slice(i, i + 50));
}

/** Render one argument spec the way the Redis docs do. */
function renderArg(a) {
  let s;
  switch (a.type) {
    case 'oneof': {
      const parts = (a.arguments ?? []).map(renderArg);
      s = parts.join(' | ');
      // Only bracket a real choice, and only when it is not already
      // bracketed by its own optional flag below.
      if (parts.length > 1 && !(a.flags ?? []).includes('optional')) s = `<${s}>`;
      break;
    }
    case 'block':
      s = (a.arguments ?? []).map(renderArg).join(' ');
      break;
    case 'pure-token':
      s = a.token ?? a.name;
      break;
    default:
      s = a.display_text ?? a.name;
      if (a.token) s = `${a.token} ${s}`;
      break;
  }
  // Optionality and repetition live in a `flags` ARRAY, not as top-level
  // booleans — reading a.optional/a.multiple silently produced syntax with
  // every bracket missing, e.g. SET rendered its NX/XX group as mandatory.
  const flags = a.flags ?? [];
  if (flags.includes('multiple')) s = `${s} [${s} ...]`;
  if (flags.includes('optional')) s = `[${s}]`;
  return s;
}

const out = [];
for (const [name, d] of Object.entries(docs)) {
  // Container commands expose subcommands as "parent|sub".
  const subs = d.subcommands ? Object.entries(d.subcommands) : [];
  const emit = (full, doc) => {
    const m = meta.get(full.toLowerCase()) ?? {};
    const args = (doc.arguments ?? []).map(renderArg).join(' ');
    out.push({
      name: full.replace('|', ' ').toUpperCase(),
      group: doc.group ?? '',
      since: doc.since ?? '',
      summary: (doc.summary ?? '').trim(),
      complexity: (doc.complexity ?? '').trim(),
      arity: m.arity ?? 0,
      flags: (m.flags ?? []).filter(f =>
        ['write', 'readonly', 'admin', 'blocking', 'fast', 'denyoom', 'loading'].includes(f)),
      syntax: args,
    });
  };
  if (subs.length) {
    for (const [sname, sdoc] of subs) emit(sname, sdoc);
    // The bare container itself is not runnable; skip it.
  } else {
    emit(name, d);
  }
}

out.sort((a, b) => a.name.localeCompare(b.name));

const groups = [...new Set(out.map(c => c.group).filter(Boolean))].sort();
const esc = s => JSON.stringify(s);

const ts = `/**
 * Redis command catalog — every command the editor hints, with its real
 * syntax, arity, summary, complexity and "since" version.
 *
 * GENERATED from a live server's own \`COMMAND DOCS\` + \`COMMAND INFO\`
 * (Redis ${cli('--json','INFO','server').match(/"redis_version:([^\\\\]+)/)?.[1] ?? '8.x'}), not hand-written. That matters: hand-maintained catalogs
 * drift, miss the container subcommands, and cannot know about the commands a
 * given build actually ships. Regenerate with
 * \`node dev/gen_redis_catalog.mjs > src/utils/redisCommands.ts\`.
 *
 * At runtime this is the OFFLINE baseline; useRedisCompletions augments it
 * from the connected server so module commands (RedisJSON, RediSearch,
 * TimeSeries) hint too.
 */

export interface RedisCommand {
  /** "GET", "CONFIG SET" — display form, uppercase. */
  name: string;
  /** Redis docs group: string, hash, list, set, sorted-set, stream, … */
  group: string;
  /** Version the command appeared in. */
  since: string;
  summary: string;
  /** Big-O description straight from the docs. */
  complexity: string;
  /** Positive = exact arg count (incl. the command); negative = minimum. */
  arity: number;
  /** Subset of COMMAND INFO flags that matter to a user. */
  flags: string[];
  /** Rendered argument syntax, e.g. "key value [NX | XX] [EX seconds]". */
  syntax: string;
}

export const REDIS_GROUPS: string[] = ${JSON.stringify(groups)};

export const REDIS_COMMANDS: RedisCommand[] = [
${out.map(c => `  { name: ${esc(c.name)}, group: ${esc(c.group)}, since: ${esc(c.since)}, arity: ${c.arity}, flags: ${JSON.stringify(c.flags)},
    summary: ${esc(c.summary)},
    complexity: ${esc(c.complexity)},
    syntax: ${esc(c.syntax)} },`).join('\n')}
];

/** Lookup by display name, uppercase ("CONFIG SET"). */
export const REDIS_BY_NAME: Map<string, RedisCommand> =
  new Map(REDIS_COMMANDS.map(c => [c.name, c]));
`;

process.stdout.write(ts);
console.error(`generated ${out.length} commands, ${groups.length} groups`);
