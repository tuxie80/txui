/**
 * Reading CHANGELOG.md into something the What's New window can render.
 *
 * The file is the source — the modal imports it with Vite's `?raw` — so this
 * only has to split it. Two rules carry all the meaning:
 *
 *  - **`## [Unreleased]` is dropped.** It describes work that is not in the
 *    binary the reader is holding, and a What's New that lists unshipped
 *    changes is worse than none: the user goes looking for a feature that is
 *    not there.
 *  - **Order is the file's order**, which is newest first. Nothing sorts by
 *    version string, because `0.9.0` and `0.10.0` do not compare the way a
 *    reader expects and the file already has it right.
 *
 * Pure and dependency-free — driven by `node --test`.
 */

export interface Release {
  /** Exactly as written between the brackets, e.g. `0.55.0`. */
  version: string;
  /** Whatever followed it on the heading line; may be empty. */
  date: string;
  /** The lines under the heading, verbatim and untrimmed. */
  body: string[];
}

/** `## [0.55.0] — 2026-08-10`, tolerating an em dash, a hyphen or neither. */
const HEADING = /^##\s*\[([^\]]+)\]\s*[—–-]?\s*(.*)$/;

export function parseChangelog(md: string): Release[] {
  const out: Release[] = [];
  let current: Release | null = null;

  for (const line of md.split('\n')) {
    const head = HEADING.exec(line);
    if (!head) {
      current?.body.push(line);
      continue;
    }
    if (current) out.push(current);
    // Unreleased opens a section that is deliberately collected into nothing:
    // its lines still have to be consumed, or they would be appended to the
    // release *above* it and shown as if they had shipped.
    current = /^unreleased$/i.test(head[1].trim())
      ? null
      : { version: head[1].trim(), date: head[2].trim(), body: [] };
  }
  if (current) out.push(current);
  return out;
}
