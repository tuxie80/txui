/** LCS-based line diff for side-by-side DDL views. */

export interface DiffRow {
  left: string | null;
  right: string | null;
  type: 'same' | 'del' | 'add';
}

export function lineDiff(leftText: string, rightText: string): DiffRow[] {
  const a = leftText.split('\n');
  const b = rightText.split('\n');
  const n = a.length, m = b.length;

  // guard: DP is O(n·m) — beyond ~1000×1000 fall back to naive pairing
  if (n * m > 1_000_000) {
    const out: DiffRow[] = [];
    const len = Math.max(n, m);
    for (let i = 0; i < len; i++) {
      const l = a[i] ?? null, r = b[i] ?? null;
      out.push({ left: l, right: r, type: l === r ? 'same' : l === null ? 'add' : r === null ? 'del' : 'del' });
    }
    return out;
  }

  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: DiffRow[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ left: a[i], right: b[j], type: 'same' }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ left: a[i], right: null, type: 'del' }); i++; }
    else { out.push({ left: null, right: b[j], type: 'add' }); j++; }
  }
  while (i < n) { out.push({ left: a[i], right: null, type: 'del' }); i++; }
  while (j < m) { out.push({ left: null, right: b[j], type: 'add' }); j++; }
  return out;
}

/** Status of a CURRENT line relative to the baseline. */
export type LineChangeStatus = 'added' | 'changed' | 'unchanged';

export interface LineChangeResult {
  /** One status per current line, in order (index 0 = first line). */
  status: LineChangeStatus[];
  /**
   * Current line indices with a deletion gap immediately BEFORE them — the
   * baseline had lines there that no longer exist. A gap trailing the very last
   * line is reported as index `current.length` (one past the end).
   */
  deletedBefore: number[];
}

/**
 * Per-line change status of `current` against `baseline`, LCS-based — the data
 * behind a VS Code / DataGrip change-bar gutter. Distinct from `lineDiff`
 * above, which pairs both sides for a side-by-side view; this one is oriented
 * at the current document: every current line gets a status, and a run of
 * deletions adjacent to insertions is coalesced into `changed` (a hand-patched
 * line) rather than a separate delete + add.
 *
 * Pure and deterministic. The DP is O(baseline·current); beyond ~1M cells it
 * falls back to a positional compare so a huge migration never stalls the UI.
 */
export function lineChangeStatus(baseline: string, current: string): LineChangeResult {
  const b = current.split('\n');
  const status: LineChangeStatus[] = new Array(b.length).fill('unchanged');
  const deletedBefore: number[] = [];

  // An empty baseline means the whole document is new — every line is added.
  if (baseline === '') {
    return { status: status.map(() => 'added'), deletedBefore };
  }
  // Identical documents: everything is unchanged (fast path, and exact).
  if (baseline === current) {
    return { status, deletedBefore };
  }

  const a = baseline.split('\n');
  const n = a.length, m = b.length;

  // Guard: the DP is O(n·m). Beyond ~1000×1000 fall back to a cheap positional
  // compare — same-index lines that differ are 'changed', extra current lines
  // are 'added', a shorter current means a trailing deletion.
  if (n * m > 1_000_000) {
    for (let k = 0; k < m; k++) {
      status[k] = k < n ? (a[k] === b[k] ? 'unchanged' : 'changed') : 'added';
    }
    if (n > m) deletedBefore.push(m);
    return { status, deletedBefore };
  }

  // LCS of the two line arrays, then a forward walk into an ops stream.
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops: ('same' | 'del' | 'add')[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { ops.push('same'); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push('del'); i++; }
    else { ops.push('add'); j++; }
  }
  while (i < n) { ops.push('del'); i++; }
  while (j < m) { ops.push('add'); j++; }

  // Walk the ops, advancing a pointer into the current lines. A run of
  // deletions and additions is a change hunk: pair them so the first
  // min(dels, adds) current lines read as 'changed', the rest as 'added', and
  // any unpaired deletions leave a deletion marker before the next line.
  let bi = 0, k = 0;
  while (k < ops.length) {
    if (ops[k] === 'same') { status[bi] = 'unchanged'; bi++; k++; continue; }
    const addIdx: number[] = [];
    let dels = 0;
    while (k < ops.length && ops[k] !== 'same') {
      if (ops[k] === 'del') dels++;
      else { addIdx.push(bi); bi++; }
      k++;
    }
    const changedCount = Math.min(dels, addIdx.length);
    for (let t = 0; t < addIdx.length; t++) {
      status[addIdx[t]] = t < changedCount ? 'changed' : 'added';
    }
    if (dels > changedCount) deletedBefore.push(bi);
  }
  return { status, deletedBefore };
}
