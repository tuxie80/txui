/**
 * Galera SST/IST error-log line parser — the signal half of the SSH log tail
 * (`galera_sst_log_tail` streams raw lines; this module decides what each one
 * MEANS). It exists because Galera exposes no SST percentage over SQL: the
 * only place a real percentage — or even the current phase — appears is the
 * server's error log.
 *
 * The line classes below are validated against LIVE captures from a MariaDB
 * 11.8.8 + galera 26.4.27 3-node cluster (tests/fixtures/
 * galera-sst-log-mariadb118.txt — rsync SST, both donor and joiner sides,
 * plus a failed mariabackup SST's [ERROR] lines). Two classes are documented
 * but NOT captured live here: the mariabackup `[01] Copying …` per-file
 * lines (MariaDB/Percona docs) and the pv-style `[sst] progress=1`
 * percentage lines (PXC). Both parse loosely and degrade to null on any
 * deviation — a misparse must cost nothing, because the card falls back to
 * the indeterminate display it already had.
 *
 * Pure: no React/Tauri imports — unit-tested with node --test.
 */

export type SstLogPhase =
  /** An SST script announced itself ("rsync SST started on joiner/donor"). */
  | 'sst-start'
  /** Mid-transfer phase detail ("Transfer of InnoDB data files done", a
   *  mariabackup Copying line, a pv progress line). Carries pct when the
   *  line has one. */
  | 'sst-progress'
  /** "Receiving IST... 64.0% (12345/19200 events) complete." — a REAL
   *  percentage, the only one Galera prints itself. */
  | 'ist-progress'
  /** The transfer finished: "SST received"/"SST succeeded"/"State transfer
   *  … complete"/"total time N sec". IST at 100% also maps here via
   *  ist-progress with pct 1 — the caller treats pct==1 as done. */
  | 'sst-done'
  /** A WSREP_SST [ERROR] line — the transfer may still recover (the scripts
   *  retry), so this is a finding, not a terminal state. */
  | 'sst-failed'
  /** A role/state transition ("Shifting PRIMARY -> JOINER", "SYNCED ->
   *  DONOR/DESYNCED", "Server status change … -> synced"). */
  | 'role';

export interface SstLogSignal {
  phase: SstLogPhase;
  /** 0..1 when the line carries a percentage, else null. */
  pct: number | null;
  /** One line of human-readable detail for the card — the line's own words,
   *  stripped of timestamp/severity noise, never the raw megabyte-long
   *  `--mysqld-args` command lines. */
  detail: string;
  /** IST event counts, when present: (done, total). */
  eventsDone?: number;
  eventsTotal?: number;
}

/** Trim the log prefix down to the payload: drops the
 *  `2026-10-02 13:36:49 0 [Note] WSREP: ` head and the WSREP_SST tag's own
 *  timestamp tail `(20261002 13:36:50.000)`. */
function payload(line: string): string {
  let s = line.trim();
  const m = s.match(/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?\s+\d+\s+\[(?:Note|Warning|ERROR|ERROR)\]\s+/);
  if (m) s = s.slice(m[0].length);
  s = s.replace(/^WSREP_SST:\s*/, '').replace(/^WSREP:\s*/, '');
  s = s.replace(/\s*\(\d{8} \d{2}:\d{2}:\d{2}\.\d+\)\s*$/, '');
  return s.trim();
}

/** Clamp a parsed percentage to 0..1; NaN and out-of-range become null. */
function pct01(n: number): number | null {
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n / 100 : null;
}

/**
 * One line in, one signal out — or null for noise (InnoDB chatter, GCache
 * DEBUG, the WSREP_SST informational wallpaper like "'lsof' is selected as
 * a socket information utility"). Garbage tolerance is the contract: an
 * unrecognized line is a miss, never a wrong answer.
 */
export function parseSstLogLine(line: string): SstLogSignal | null {
  if (!line) return null;
  const s = line.trim();
  if (!s) return null;
  const p = payload(s);

  // IST progress — the real percentage. Both MariaDB and PXC print it.
  const ist = p.match(/^Receiving IST\.{3}\s+([\d.]+|nan)%\s*\((\d+)\/(\d+) events\) complete/i);
  if (ist) {
    const pct = ist[1] === 'nan' ? null : pct01(parseFloat(ist[1]));
    const eventsDone = parseInt(ist[2], 10);
    const eventsTotal = parseInt(ist[3], 10);
    return {
      phase: 'ist-progress', pct,
      detail: pct === null
        ? 'IST starting — no events queued yet'
        : `IST ${(pct * 100).toFixed(1)}% — ${eventsDone.toLocaleString()}/${eventsTotal.toLocaleString()} events`,
      eventsDone, eventsTotal,
    };
  }
  if (/^(Receiving IST|IST receiver|Prepared IST receiver|IST preload)/i.test(p)) {
    return { phase: 'ist-progress', pct: null, detail: p };
  }

  // pv-style progress lines with [sst] progress=1 (PXC; not in our captures —
  // format per Percona docs: "… [===> ] 45% ETA 0:00:15"). Require the ETA or
  // bracket bar so a random "45%" in prose cannot pose as progress.
  const pv = p.match(/\[=*\s*>?\s*\]\s*([\d.]+)%(\s+ETA\s+\S+)?\s*$/)
    ?? p.match(/([\d.]+)%\s+ETA\s+\d+:\d{2}/);
  if (pv) {
    const pct = pct01(parseFloat(pv[1]));
    if (pct !== null) {
      return { phase: 'sst-progress', pct, detail: `SST data stream ${(pct * 100).toFixed(1)}%` };
    }
  }

  // mariabackup per-file copy lines: "[01] 2026-10-02 … Copying ./ibdata1 to …"
  // (docs format; the live capture's mariabackup run failed before copying).
  const copying = p.match(/Copying\s+(\.\/)?(\S+)/i);
  if (/\[\d{2}\]/.test(s) && copying) {
    return { phase: 'sst-progress', pct: null, detail: `Copying ${copying[2]}` };
  }

  // WSREP_SST script lines.
  if (/^WSREP_SST:/.test(s)) {
    if (/^\[ERROR\]/.test(p)) {
      return { phase: 'sst-failed', pct: null, detail: p.replace(/^\[ERROR\]\s*/, '') };
    }
    const info = p.replace(/^\[INFO\]\s*/, '');
    if (/\bSST started on (joiner|donor)/i.test(info)) {
      return { phase: 'sst-start', pct: null, detail: info };
    }
    if (/\b(IST|SST) completed on (joiner|donor)/i.test(info)) {
      return { phase: 'sst-done', pct: 1, detail: info };
    }
    if (/^Total time on (joiner|donor)/i.test(info)) {
      return { phase: 'sst-done', pct: 1, detail: info };
    }
    // Phase lines worth surfacing; the rest of the [INFO] wallpaper
    // ('lsof' selected, cleanup PIDs, SSL config dump, …) is noise.
    const phase = info.match(/^(Streaming the backup to joiner at \S+|Streaming with \S+|Proceeding with SST|Waiting for SST streaming|Transfer of .+ done|Tables flushed|Extracting binlog files|Preparing binlog files for transfer|Sending continue to donor|Cleaning the existing datadir.*)/i);
    if (phase) {
      return { phase: 'sst-progress', pct: null, detail: phase[1] };
    }
    return null;
  }

  // Core WSREP state lines (non-WSREP_SST).
  if (/State transfer (from|to) \S+ \(\S+\) complete/i.test(p)) {
    return { phase: 'sst-done', pct: 1, detail: p };
  }
  if (/^SST (received|succeeded|sent)\b/i.test(p)) {
    return { phase: 'sst-done', pct: 1, detail: p };
  }
  if (/^Joiner monitor thread ended with total time /i.test(p)) {
    return { phase: 'sst-done', pct: 1, detail: p };
  }
  if (/^State transfer required/i.test(p)) {
    return { phase: 'sst-start', pct: null, detail: 'State transfer required — SST script starting' };
  }
  const shift = p.match(/^Shifting (\S+(?:\/\S+)?) -> (\S+(?:\/\S+)?)/);
  if (shift) {
    return { phase: 'role', pct: null, detail: `${shift[1]} → ${shift[2]}` };
  }
  const status = p.match(/^Server status change (\S+) -> (\S+)/);
  if (status) {
    return { phase: 'role', pct: null, detail: `${status[1]} → ${status[2]}` };
  }
  return null;
}

/**
 * Fold a stream of signals into what the transfer card shows. The latest
 * percentage wins (a newer phase line without one never erases it); the
 * detail tracks the most recent signal of any class. Returns null while
 * nothing parseable has arrived — the card then stays indeterminate.
 */
export interface SstLogSummary {
  /** Latest percentage seen, 0..1; survives later pct-less lines. */
  pct: number | null;
  /** Most recent signal's detail text. */
  detail: string;
  /** True once a terminal signal (sst-done, or ist-progress at 100%) arrived. */
  done: boolean;
  /** True once any WSREP_SST [ERROR] line was seen. */
  failed: boolean;
  phase: SstLogPhase;
  eventsDone?: number;
  eventsTotal?: number;
}

export function summarizeSstLog(signals: SstLogSignal[]): SstLogSummary | null {
  return signals.reduce<SstLogSummary | null>((prev, sig) => ({
    pct: sig.pct ?? prev?.pct ?? null,
    detail: sig.detail,
    done: (prev?.done ?? false) || sig.phase === 'sst-done' || sig.pct === 1,
    failed: (prev?.failed ?? false) || sig.phase === 'sst-failed',
    phase: sig.phase,
    eventsDone: sig.eventsDone ?? prev?.eventsDone,
    eventsTotal: sig.eventsTotal ?? prev?.eventsTotal,
  }), null);
}
