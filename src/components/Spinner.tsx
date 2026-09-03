import type { CSSProperties } from 'react';

// ── Unified spinner ───────────────────────────────────────────────────────────
// One reusable "working" indicator, replacing the ad-hoc spinners that used to
// live in treeIcons.tsx (arc), StatusIcon.tsx (running ring) and elsewhere.
//
// All three variants are dependency-free inline SVG / CSS. Colour comes from
// `currentColor`, so a spinner takes the colour of whatever it sits in (a tree
// row tints it with `.tree-spinner`, a running result mark with
// `.status-icon-running`, everything else inherits the surrounding text).
//
// Motion lives entirely in App.css (`.spinner-*`), which also honours
// `prefers-reduced-motion` in one place for every variant.

export type SpinnerVariant = 'arc' | 'ring' | 'dots';

interface SpinnerProps {
  /** Rendered box — px number, or any CSS size (e.g. "1.1em" to follow text). */
  size?: number | string;
  variant?: SpinnerVariant;
  className?: string;
  /** Accessible name. When present the spinner is announced; otherwise hidden. */
  label?: string;
  /** Overrides the inherited colour. */
  color?: string;
}

/** Six cells of a 2×3 grid, in the pulse order (a rough clockwise sweep). */
const DOT_ORDER = [0, 1, 2, 5, 4, 3];

export function Spinner({ size = 14, variant = 'arc', className, label, color }: SpinnerProps) {
  const cls = ['spinner', `spinner-${variant}`, className].filter(Boolean).join(' ');
  const style: CSSProperties = { width: size, height: size, color };

  // Same a11y convention as StatusIcon: a labelled spinner is an image with a
  // <title>, an unlabelled one is decoration and hidden from the tree.
  const a11y = {
    role: label ? ('img' as const) : ('presentation' as const),
    'aria-hidden': label ? undefined : (true as const),
    focusable: 'false' as const,
  };

  if (variant === 'dots') {
    return (
      <span className={cls} style={style} {...a11y}>
        {DOT_ORDER.map((delayIndex, cell) => (
          <span
            key={cell}
            className="spinner-dot"
            style={{ animationDelay: `${delayIndex * 0.12}s` }}
          />
        ))}
      </span>
    );
  }

  return (
    <svg
      className={cls}
      style={style}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      {...a11y}
    >
      {label && <title>{label}</title>}
      {variant === 'ring' ? (
        <>
          {/* faint full ring + a three-quarter arc that rotates */}
          <circle cx="8" cy="8" r="5.6" opacity="0.25" />
          <path d="M8 2.4A5.6 5.6 0 1 1 2.4 8" />
        </>
      ) : (
        // arc: a broken ring (dash gap) rotated as a whole
        <circle cx="8" cy="8" r="5.6" strokeDasharray="26 10" />
      )}
    </svg>
  );
}
