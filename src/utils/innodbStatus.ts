/**
 * Pure parsers for `SHOW ENGINE INNODB STATUS`.
 *
 * The LocksPanel already mines the LATEST DETECTED DEADLOCK slice; this module
 * turns the rest of the monitor output — the sections a DBA actually reaches for
 * during triage — into structured data:
 *   TRANSACTIONS           → history list length + the active transactions
 *   BUFFER POOL AND MEMORY → page counts, dirty pages, hit rate, I/O
 *   ROW OPERATIONS         → DML rates & totals, queries inside/queued
 *   SEMAPHORES             → OS waits, spin rounds, mutex/rw-lock waits
 *
 * MySQL and MariaDB word these sections differently and drop fields between
 * versions, so every extractor is defensive: a missing section or field yields
 * null / [] rather than throwing. Pure — no React/Tauri imports; unit-tested
 * with node --test.
 */

export interface InnodbSection {
  name: string;
  body: string;
}

// A section header is three lines: a rule, the (upper-case) name, another rule.
// Rules are runs of '-' (between sections) or '=' (the trailing END OF block);
// accepting both lets us bound ROW OPERATIONS at the "==== END OF …" banner.
const RULE = /^[-=]{3,}$/;

function isName(s: string): boolean {
  // Section names are all upper-case (e.g. "FILE I/O", "BUFFER POOL AND
  // MEMORY"). The top banner line carries a timestamp/hex ("0x7f…") so its
  // lower-case letters exclude it here.
  return /[A-Z]/.test(s) && !/[a-z]/.test(s);
}

/**
 * Split the raw status text into its named sections by the `-----` header lines.
 * Anything before the first header (the monitor banner) is discarded.
 */
export function splitSections(raw: string | null | undefined): InnodbSection[] {
  if (!raw) return [];
  const lines = raw.replace(/\r\n/g, '\n').split('\n');
  const heads: { name: string; head: number; body: number }[] = [];
  for (let i = 0; i + 2 < lines.length; i++) {
    if (!RULE.test(lines[i].trim())) continue;
    if (!RULE.test(lines[i + 2].trim())) continue;
    const name = lines[i + 1].trim();
    if (!name || RULE.test(name) || !isName(name)) continue;
    heads.push({ name, head: i, body: i + 3 });
    i += 2;
  }
  const out: InnodbSection[] = [];
  for (let h = 0; h < heads.length; h++) {
    const end = h + 1 < heads.length ? heads[h + 1].head : lines.length;
    out.push({ name: heads[h].name, body: lines.slice(heads[h].body, end).join('\n').trim() });
  }
  return out;
}

/** Body text of a section by (case-insensitive) name, or null if absent. */
export function getSection(sections: InnodbSection[], name: string): string | null {
  const s = sections.find(x => x.name.toUpperCase() === name.toUpperCase());
  return s ? s.body : null;
}

function num(body: string, re: RegExp): number | null {
  const m = body.match(re);
  return m ? Number(m[1]) : null;
}

function sumAll(body: string, re: RegExp): number | null {
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
  let total = 0;
  let hit = false;
  for (const m of body.matchAll(g)) { total += Number(m[1]); hit = true; }
  return hit ? total : null;
}

// ── TRANSACTIONS ─────────────────────────────────────────────────────────────

export interface InnodbTxn {
  id: string;
  /** e.g. "ACTIVE 12 sec starting index read" or "ACTIVE (PREPARED) 3 sec" */
  status: string;
  activeSecs: number | null;
  threadId: string | null;
  lockWait: boolean;
  query: string | null;
}

export interface InnodbTransactions {
  historyListLength: number | null;
  transactions: InnodbTxn[];
}

/**
 * Parse the TRANSACTIONS section. Returns the purge history list length and the
 * *active* transactions (idle "not started" sessions are skipped as noise),
 * each with its state, age, owning thread and the statement it is running.
 */
export function parseTransactions(body: string | null): InnodbTransactions {
  if (!body) return { historyListLength: null, transactions: [] };
  const historyListLength = num(body, /History list length\s+(\d+)/i);
  const transactions: InnodbTxn[] = [];
  const parts = body.split(/\n(?=---TRANSACTION )/);
  for (const p of parts) {
    if (!/^---TRANSACTION /.test(p)) continue;
    const lines = p.split('\n');
    const firstLine = lines[0].slice('---TRANSACTION '.length);
    const comma = firstLine.indexOf(',');
    const id = (comma >= 0 ? firstLine.slice(0, comma) : firstLine).trim();
    const status = (comma >= 0 ? firstLine.slice(comma + 1) : '').trim();
    if (/^not started/i.test(status)) continue;   // idle session, nothing to show
    const secM = status.match(/ACTIVE(?:\s*\([^)]*\))?\s+(\d+)\s+sec/i);
    const tid = p.match(/MySQL thread id\s+(\d+)/i);
    let query: string | null = null;
    const ti = lines.findIndex(l => /^MySQL thread id /.test(l));
    if (ti >= 0 && ti + 1 < lines.length) {
      const q = lines.slice(ti + 1).join('\n').trim();
      query = q.length ? q : null;
    }
    transactions.push({
      id,
      status,
      activeSecs: secM ? Number(secM[1]) : null,
      threadId: tid ? tid[1] : null,
      lockWait: /LOCK WAIT/.test(p),
      query,
    });
  }
  return { historyListLength, transactions };
}

// ── BUFFER POOL AND MEMORY ───────────────────────────────────────────────────

export interface InnodbBufferPool {
  totalPages: number | null;      // Buffer pool size (in pages)
  freePages: number | null;
  databasePages: number | null;
  modifiedPages: number | null;   // dirty pages
  hitRate: string | null;         // e.g. "1000 / 1000"
  pagesRead: number | null;
  pagesCreated: number | null;
  pagesWritten: number | null;
}

export function parseBufferPool(body: string | null): InnodbBufferPool {
  if (!body) {
    return {
      totalPages: null, freePages: null, databasePages: null, modifiedPages: null,
      hitRate: null, pagesRead: null, pagesCreated: null, pagesWritten: null,
    };
  }
  const hr = body.match(/Buffer pool hit rate\s+(\d+\s*\/\s*\d+)/i);
  return {
    // "Buffer pool size, bytes …" won't match — the char after "size" is a comma.
    totalPages: num(body, /Buffer pool size\s+(\d+)/i),
    freePages: num(body, /Free buffers\s+(\d+)/i),
    databasePages: num(body, /Database pages\s+(\d+)/i),
    modifiedPages: num(body, /Modified db pages\s+(\d+)/i),
    hitRate: hr ? hr[1].replace(/\s+/g, ' ') : null,
    pagesRead: num(body, /Pages read\s+(\d+)/i),
    pagesCreated: num(body, /,\s*created\s+(\d+)/i),
    pagesWritten: num(body, /,\s*written\s+(\d+)/i),
  };
}

// ── ROW OPERATIONS ───────────────────────────────────────────────────────────

export interface InnodbRowOps {
  queriesInside: number | null;
  queriesQueued: number | null;
  insertedTotal: number | null;
  updatedTotal: number | null;
  deletedTotal: number | null;
  readTotal: number | null;
  insertsPerSec: number | null;
  updatesPerSec: number | null;
  deletesPerSec: number | null;
  readsPerSec: number | null;
}

export function parseRowOps(body: string | null): InnodbRowOps {
  if (!body) {
    return {
      queriesInside: null, queriesQueued: null,
      insertedTotal: null, updatedTotal: null, deletedTotal: null, readTotal: null,
      insertsPerSec: null, updatesPerSec: null, deletesPerSec: null, readsPerSec: null,
    };
  }
  return {
    queriesInside: num(body, /(\d+)\s+queries inside InnoDB/i),
    queriesQueued: num(body, /(\d+)\s+queries in queue/i),
    insertedTotal: num(body, /Number of rows inserted\s+(\d+)/i),
    updatedTotal: num(body, /,\s*updated\s+(\d+)/i),
    deletedTotal: num(body, /,\s*deleted\s+(\d+)/i),
    readTotal: num(body, /,\s*read\s+(\d+)/i),
    insertsPerSec: num(body, /([\d.]+)\s+inserts\/s/i),
    updatesPerSec: num(body, /([\d.]+)\s+updates\/s/i),
    deletesPerSec: num(body, /([\d.]+)\s+deletes\/s/i),
    readsPerSec: num(body, /([\d.]+)\s+reads\/s/i),
  };
}

// ── SEMAPHORES ───────────────────────────────────────────────────────────────

export interface InnodbSemaphores {
  reservationCount: number | null;
  signalCount: number | null;
  osWaits: number | null;        // total OS waits across mutex/rw-lock lines
  spinRounds: number | null;     // total spin rounds
  mutexSpinWaits: number | null; // "Mutex spin waits N" (older MySQL/MariaDB)
  rwSharedWaits: number | null;  // RW-shared OS waits
  rwExclWaits: number | null;    // RW-excl OS waits
}

export function parseSemaphores(body: string | null): InnodbSemaphores {
  if (!body) {
    return {
      reservationCount: null, signalCount: null, osWaits: null, spinRounds: null,
      mutexSpinWaits: null, rwSharedWaits: null, rwExclWaits: null,
    };
  }
  return {
    reservationCount: num(body, /reservation count\s+(\d+)/i),
    signalCount: num(body, /signal count\s+(\d+)/i),
    osWaits: sumAll(body, /OS waits\s+(\d+)/i),
    spinRounds: sumAll(body, /\brounds\s+(\d+)/i),
    mutexSpinWaits: num(body, /Mutex spin waits\s+(\d+)/i),
    rwSharedWaits: num(body, /RW-shared spins\s+\d+,\s*rounds\s+\d+,\s*OS waits\s+(\d+)/i),
    rwExclWaits: num(body, /RW-excl spins\s+\d+,\s*rounds\s+\d+,\s*OS waits\s+(\d+)/i),
  };
}

// ── Aggregate ────────────────────────────────────────────────────────────────

export interface InnodbStatus {
  sections: InnodbSection[];
  transactions: InnodbTransactions;
  bufferPool: InnodbBufferPool;
  rowOps: InnodbRowOps;
  semaphores: InnodbSemaphores;
}

/** Parse the full monitor output into every high-value section at once. */
export function parseInnodbStatus(raw: string | null | undefined): InnodbStatus {
  const sections = splitSections(raw);
  return {
    sections,
    transactions: parseTransactions(getSection(sections, 'TRANSACTIONS')),
    bufferPool: parseBufferPool(getSection(sections, 'BUFFER POOL AND MEMORY')),
    rowOps: parseRowOps(getSection(sections, 'ROW OPERATIONS')),
    semaphores: parseSemaphores(getSection(sections, 'SEMAPHORES')),
  };
}
