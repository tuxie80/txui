/**
 * What works on which desktop — one table, consulted wherever the UI offers it.
 *
 * `utils/platform.ts` answers "what should this *say* here" (⌘ vs Ctrl, `/` vs
 * `\`). This answers the harder question: **is this feature here at all.**
 *
 * The failure mode it exists to remove: a control that is offered, accepted,
 * and then fails at the moment of use. A Windows user ticking "SSH tunnel"
 * gets `exited immediately (exit code Some(255))` — an error that names
 * nothing, blames the user's bastion, and costs an afternoon. Hiding the
 * control is barely better: absence is indistinguishable from "I cannot find
 * it", and the user goes looking through Settings for a checkbox that was
 * deliberately removed.
 *
 * So an unavailable feature is **shown, greyed, and says why on hover**. That
 * is three pieces of information in one glance — it exists, it is not for you
 * here, and this is the reason.
 *
 * Two reasons are not the same reason, and conflating them is a lie the user
 * will eventually catch:
 *
 *   - `todo` — we have not written it yet. It could exist; nobody has done it.
 *     "Not implemented yet" is honest, and implies a future.
 *   - `na`   — the operating system has no such concept. Unix domain sockets
 *     will never arrive on Windows. Promising "yet" here sends someone back
 *     next release to check.
 *
 * Adding a feature id is deliberately a type-level act: `FeatureId` is derived
 * from this table, so a typo at a call site is a compile error rather than a
 * control that silently stays enabled.
 *
 * Pure and dependency-free apart from `platform()` — driven by `node --test`.
 */
import { platform } from './platform.ts';
import type { Platform } from './platform.ts';

export type Availability = 'ok' | 'todo' | 'na';

export interface PlatformFeature {
  /** Stable id used at the call site. */
  id: string;
  /** What the UI calls this feature — the tooltip leads with it. */
  label: string;
  /** The platforms it works on **today**. */
  on: readonly Platform[];
  /** Why it is missing elsewhere: unwritten, or absent from the OS. */
  kind: 'todo' | 'na';
  /**
   * The actual obstacle, in one clause, lower-case, no trailing stop.
   * Written for someone who will have to decide what to do next, so it names
   * the concrete thing ("the askpass helper is a /bin/sh script"), not a
   * category ("platform limitations").
   */
  why: string;
  /** What to do instead, when there is something. One clause. */
  instead?: string;
}

/**
 * The table.
 *
 * Short by design — this lists what is genuinely platform-bound, not
 * everything that is unfinished. A feature missing on *every* platform is not
 * a platform gap and does not belong here; nor does one that merely needs an
 * external binary the user can install (dump tools resolve at runtime and say
 * so per OS — see `commands/dump.rs`).
 *
 * Every entry is traceable to `docs/PORTABILITY.md`, which is the audit this
 * table was extracted from.
 *
 * **Entries leave when the gap closes.** `ssh-tunnel` was here until 0.49.0,
 * when the Windows branch was written; leaving it would have had the UI say
 * "not implemented yet" about something that is. Written-but-unverified is not
 * a state this table models — the honest home for that is
 * `docs/PORTABILITY.md` §8, and it is recorded there.
 */
export const PLATFORM_FEATURES = [
  {
    id: 'unix-socket',
    label: 'Unix socket connection',
    on: ['mac', 'linux'],
    kind: 'na',
    why: 'the OS has no Unix domain sockets; MySQL uses a named pipe there and PostgreSQL is TCP-only',
    instead: 'connect over host/port',
  },
  {
    id: 'mydumper',
    label: 'mydumper / myloader',
    on: ['mac', 'linux'],
    kind: 'na',
    why: 'upstream ships no Windows build',
    instead: 'use mysqldump / mysql',
  },
] as const satisfies readonly PlatformFeature[];

export type FeatureId = (typeof PLATFORM_FEATURES)[number]['id'];

const BY_ID = new Map<string, PlatformFeature>(PLATFORM_FEATURES.map(f => [f.id, f]));

export function feature(id: FeatureId): PlatformFeature {
  // Non-null: `FeatureId` is derived from the table, so this cannot miss
  // without a compile error at the call site first.
  return BY_ID.get(id)!;
}

/** The name a user would use for their own desktop. */
export function osName(p: Platform = platform()): string {
  return p === 'mac' ? 'macOS' : p === 'windows' ? 'Windows' : 'Linux';
}

/** Is this feature available on this platform, and if not, which kind of not. */
export function availability(id: FeatureId, p: Platform = platform()): Availability {
  const f = feature(id);
  return (f.on as readonly Platform[]).includes(p) ? 'ok' : f.kind;
}

export function available(id: FeatureId, p: Platform = platform()): boolean {
  return availability(id, p) === 'ok';
}

/**
 * The hover message — `null` when the feature works here, so a call site can
 * write `unavailableTip(id) ?? 'the normal tooltip'`.
 *
 * Two shapes, because the two cases mean different things to the reader:
 *
 *   todo → "SSH tunnel — not implemented on Windows yet (…). Instead: …"
 *   na   → "Unix socket connection — not available on Windows: …. Instead: …"
 *
 * Only `todo` says "yet".
 */
export function unavailableTip(id: FeatureId, p: Platform = platform()): string | null {
  const f = feature(id);
  return (f.on as readonly Platform[]).includes(p) ? null : tipFor(f, p);
}

/**
 * The wording, for a feature that is known to be unavailable here.
 *
 * Split out and exported so the `todo`/`na` distinction stays under test even
 * when the table happens to contain no `todo` entry — which is the state it
 * reached in 0.49.0, and exactly when an untested wording rule would rot.
 */
export function tipFor(f: PlatformFeature, p: Platform): string {
  const head = f.kind === 'todo'
    ? `${f.label} — not implemented on ${osName(p)} yet (${f.why})`
    : `${f.label} — not available on ${osName(p)}: ${f.why}`;
  return f.instead ? `${head}.\n${f.instead[0].toUpperCase()}${f.instead.slice(1)}.` : `${head}.`;
}

export interface UnavailProps {
  className?: string;
  'data-tip'?: string;
  'aria-disabled'?: true;
}

/**
 * Props to spread onto the control that offers the feature — always, whether
 * or not it is available here:
 *
 * ```tsx
 * <div {...unavailableProps('ssh-tunnel', { className: 'form-section' })}>
 * <button {...unavailableProps('mydumper', { className: 'icon-btn', tip: 'Dump with mydumper' })}>
 * ```
 *
 * Taking the base class and base tip rather than returning `null` to be
 * merged by the caller is deliberate: the merge is where this goes wrong.
 * Spreading `{className: 'unavail'}` onto an element that already had a class
 * silently *replaces* it (TypeScript catches the literal case and nothing
 * catches the computed one), and a `data-tip` written after the spread
 * overwrites the reason with the ordinary tooltip — greying the control and
 * then refusing to say why.
 *
 * `aria-disabled`, not `disabled`: a disabled element fires no pointer events
 * in any browser, so the tooltip explaining why it is grey would never appear
 * — the one thing this module exists to deliver. Individual inputs inside may
 * still be `disabled` (the `.unavail` wrapper keeps hovering), and the call
 * site guards its own handler with `available()`.
 */
export function unavailableProps(
  id: FeatureId,
  opts: { className?: string; tip?: string } = {},
  p: Platform = platform(),
): UnavailProps {
  const reason = unavailableTip(id, p);
  const cls = reason === null
    ? opts.className
    : opts.className ? `${opts.className} unavail` : 'unavail';
  const tip = reason ?? opts.tip;
  return {
    ...(cls ? { className: cls } : {}),
    ...(tip ? { 'data-tip': tip } : {}),
    ...(reason === null ? {} : { 'aria-disabled': true as const }),
  };
}

/** Everything unavailable here — for the Settings "platform support" list. */
export function unavailableHere(p: Platform = platform()): PlatformFeature[] {
  return PLATFORM_FEATURES.filter(f => !(f.on as readonly Platform[]).includes(p));
}
