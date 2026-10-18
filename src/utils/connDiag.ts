/**
 * Staged connection diagnostics — the frontend half of `connect_test_staged`
 * (src-tauri/src/commands/conndiag.rs, plan-connections.md W3.1/W3.3).
 *
 * A plain Test answers "ok" or "no"; this shapes the staged answer — DNS →
 * TCP → SSH → TLS → auth → probe, each with ok/fail/skipped + ms + detail —
 * into what the checklist UI (components/ConnDiagChecklist.tsx) renders, and
 * maps a run onto the PingResult the sidebar's status machine already speaks.
 *
 * Pure module: no React/Tauri imports, unit-tested with `node --test`.
 */
import type { PingResult } from '../types';

export type StageId = 'dns' | 'tcp' | 'ssh' | 'tls' | 'auth' | 'probe';
export type StageStatus = 'ok' | 'fail' | 'skipped';

export interface ConnectStage {
  id: StageId;
  label: string;
  status: StageStatus;
  ms: number;
  /** Absent (not null) when there is nothing worth saying. */
  detail?: string;
}

export interface StagedConnectResult {
  /** Always all six stages, in canonical order — a checklist has a stable shape. */
  stages: ConnectStage[];
  total_ms: number;
  verdict: 'ok' | 'fail';
}

/** One glyph per status: passed / failed / not applicable or not reached. */
export function stageGlyph(status: StageStatus): '✓' | '✗' | '–' {
  return status === 'ok' ? '✓' : status === 'fail' ? '✗' : '–';
}

/** The stage that stopped the run, if any. */
export function failingStage(r: StagedConnectResult): ConnectStage | null {
  return r.stages.find(s => s.status === 'fail') ?? null;
}

/**
 * The one-line verdict under a staged run.
 *
 * Failure names the stage and its reason — that is the whole point of staging.
 * Success carries the dial/TLS/auth split, because "it connects" followed by
 * "why is it slow" is answered by which of those three ate the time. Stages
 * that were skipped (a file engine's network half, plaintext-by-config TLS)
 * are left out rather than reported as 0 ms.
 */
export function verdictLine(r: StagedConnectResult): string {
  const fail = failingStage(r);
  if (fail) {
    return `Failed at ${fail.label} after ${fail.ms} ms`
      + `${fail.detail ? ` — ${fail.detail}` : ''} (total ${r.total_ms} ms)`;
  }
  const ran = (id: StageId) => r.stages.find(s => s.id === id && s.status === 'ok');
  const dialMs = (['dns', 'tcp', 'ssh'] as const)
    .map(ran).filter((s): s is ConnectStage => !!s)
    .reduce((sum, s) => sum + s.ms, 0);
  const parts: string[] = [];
  if (ran('dns') || ran('tcp') || ran('ssh')) parts.push(`dial ${dialMs} ms`);
  const tls = ran('tls');
  if (tls) parts.push(`TLS ${tls.ms} ms`);
  const auth = ran('auth');
  if (auth) parts.push(`auth ${auth.ms} ms`);
  const probe = ran('probe');
  if (probe) parts.push(`probe ${probe.ms} ms`);
  return `OK in ${r.total_ms} ms${parts.length ? ` — ${parts.join(' · ')}` : ''}`;
}

/** The server version a successful probe reported, if it did. */
export function probeVersion(r: StagedConnectResult): string | null {
  return r.stages.find(s => s.id === 'probe' && s.status === 'ok')?.detail ?? null;
}

/**
 * Map a staged run onto the PingResult the sidebar's status machine (and its
 * log lines) already speak — the staged result itself rides alongside for the
 * checklist; this is the dot/log projection of it.
 */
export function stagedToPing(r: StagedConnectResult): PingResult {
  const fail = failingStage(r);
  return {
    ok: r.verdict === 'ok',
    latency_ms: r.total_ms,
    server_version: r.verdict === 'ok' ? probeVersion(r) : null,
    error: fail ? `${fail.label}: ${fail.detail ?? 'failed'}` : null,
  };
}

/**
 * How long the UI pretends to wait on a staged run. Each of the six stages is
 * bounded by the connection's connect timeout and a run short-circuits on the
 * first failure, but the worst honest case (a failure at the LAST stage) is
 * six timeouts back to back — the deadline is that plus teardown slack, not
 * the single-connect deadline, or a slow real diagnosis would be reported as
 * a UI timeout instead of the stage that actually failed.
 *
 * An explicit 0 (this connection exempted from timeouts) means no deadline —
 * the same reading connectDeadlineMs gives it.
 */
export function stagedDeadlineMs(cfg: { connect_timeout_secs?: number | null }): number {
  const secs = cfg.connect_timeout_secs ?? 15;
  if (secs === 0) return 0;
  return secs * 6 * 1000 + 10_000;
}
