/**
 * Result marks — the ✓ / ✗ beside a statement, a job, a history row.
 *
 * These used to be the text glyphs `✓` and `✗`, which meant they rendered in
 * whatever the system font felt like: different weight on every platform,
 * thin and grey next to the UI around them, and vertically off-centre in a
 * table row. These are drawn instead, so they are the same shape everywhere
 * and sit on the text baseline.
 *
 * The tick is a tapered swoosh rather than a constant-width polyline — a
 * uniform stroke reads as a "less than" sign at 12px, while the weight shift
 * from the vertex out to the tip is what makes it read as a tick instantly.
 *
 * Colour comes from `currentColor` unless overridden, so a mark inherits the
 * severity colour of whatever row it sits in.
 *
 * (These are original drawings. JetBrains' DataGrip icon set is proprietary
 * and not licensed for redistribution, so nothing here is derived from it.)
 */

import { Spinner } from './Spinner';

export type StatusKind = 'ok' | 'error' | 'running' | 'skipped' | 'pending';

interface Props {
  kind: StatusKind;
  /** Rendered box in px — the drawing scales from a 24×24 viewBox. */
  size?: number;
  /** Overrides the inherited colour. */
  color?: string;
  title?: string;
  className?: string;
}

/**
 * The swoosh, as a filled outline of a centreline that runs
 * (3.2,12.8) → vertex (9.9,18.9) → tip (20.9,4.6), with the half-width going
 * 0.9 → 1.75 → 0. The outer vertex is rounded and the tip is a sharp point;
 * that asymmetry is the whole character of the mark.
 */
const CHECK_PATH =
  'M2.59 13.47 L8.72 20.20 Q10.65 20.80 11.29 19.97 L20.90 4.60 '
  + 'L9.16 16.99 L3.81 12.13 Q2.31 11.99 2.59 13.47 Z';

export function StatusIcon({ kind, size = 13, color, title, className }: Props) {
  const common = {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    className: ['status-icon', `status-icon-${kind}`, className].filter(Boolean).join(' '),
    // Baseline alignment: without this the mark floats above the row's text.
    style: { verticalAlign: '-0.14em', flex: 'none' as const, color },
    role: title ? 'img' : 'presentation',
    'aria-hidden': title ? undefined : true,
    focusable: 'false' as const,
  };
  const label = title && <title>{title}</title>;

  switch (kind) {
    case 'ok':
      return (
        <svg {...common} fill="currentColor">
          {label}
          <path d={CHECK_PATH} />
        </svg>
      );

    case 'error':
      // Two rounded bars crossed at the centre. Filled rather than stroked so
      // it carries the same visual weight as the tick beside it.
      return (
        <svg {...common} fill="currentColor">
          {label}
          <rect x="10.5" y="3.0" width="3.0" height="18.0" rx="1.5"
                transform="rotate(45 12 12)" />
          <rect x="10.5" y="3.0" width="3.0" height="18.0" rx="1.5"
                transform="rotate(-45 12 12)" />
        </svg>
      );

    case 'running':
      // Three-quarter ring — delegated to the unified <Spinner>. The
      // `status-icon-running` class still tints it yellow; the rotation +
      // reduced-motion handling now live once, in the shared `.spinner-*` CSS.
      return (
        <Spinner
          variant="ring"
          size={size}
          label={title}
          color={color}
          className={['status-icon', 'status-icon-running', className].filter(Boolean).join(' ')}
        />
      );

    case 'skipped':
      return (
        <svg {...common} fill="currentColor">
          {label}
          <rect x="4" y="10.6" width="16" height="2.8" rx="1.4" />
        </svg>
      );

    case 'pending':
    default:
      return (
        <svg {...common} fill="currentColor">
          {label}
          <circle cx="12" cy="12" r="3.1" opacity="0.55" />
        </svg>
      );
  }
}
