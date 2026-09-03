import type { Engine } from '../types';

// ── Engine marks ──────────────────────────────────────────────────────────────
//
// Original silhouettes drawn in each project's brand colour — a dolphin for
// MySQL, an elephant head for PostgreSQL, a key-stack for Redis. They are NOT
// the upstream trademarked logos: those are Oracle / PostgreSQL Community
// Association / Redis Ltd. marks whose files we cannot redistribute inside the
// app, so these are our own renditions used purely to identify the engine.
// Swap the paths if a licensed asset is ever cleared.
//
// SVG, so one definition covers every size. Sizes in use: 14px (sidebar rows),
// 18px (session tab), 22px (connection form), 44px (empty state). Each is
// drawn on a 64×64 grid and stays legible down to ~14px.

export type LogoProps = {
  /** Rendered edge length in px. */
  size?: number;
  className?: string;
  /** Set false when an adjacent text label already names the engine. */
  title?: string | false;
};

function svgProps({ size = 16, className, title }: LogoProps) {
  return {
    width: size,
    height: size,
    viewBox: '0 0 64 64',
    className,
    role: title === false ? undefined : ('img' as const),
    'aria-hidden': title === false ? true : undefined,
    'aria-label': title === false ? undefined : title,
  };
}

/** MySQL / MariaDB / Percona — leaping dolphin. */
export function MysqlLogo(props: LogoProps) {
  const { title = 'MySQL' } = props;
  return (
    <svg {...svgProps({ ...props, title })}>
      {title !== false && <title>{title}</title>}
      {/* one continuous silhouette: snout → back → dorsal fin → tail stalk →
          fluke → belly → pectoral fin → back to the snout */}
      <path
        d="M4.5 44.5 C6 29 16.5 18.5 30.5 16 L37.5 5.2 C38.3 4 40.2 4.4 40.3 5.9 L41 16.6
           C46 17.4 50 19 53.2 21.4 L59.8 17.2 C61 16.4 62.4 17.4 62 18.8 L58.9 30.6
           C58.5 32 56.8 32.4 55.9 31.3 L51.8 26.4 C47.8 31 41.8 34.4 34.6 36.5
           L23 39.9 C19.2 41 16 43.4 14 47 L11.6 51.4 C10.9 52.7 9 52.4 8.7 51 L7 43.6 Z"
        fill="#00758F"
      />
      <circle cx="15.5" cy="33.5" r="2.5" fill="#ffffff" />
    </svg>
  );
}

/** PostgreSQL — elephant head. */
export function PostgresLogo(props: LogoProps) {
  const { title = 'PostgreSQL' } = props;
  return (
    <svg {...svgProps({ ...props, title })}>
      {title !== false && <title>{title}</title>}
      <g fill="#336791">
        {/* ears sit behind the head */}
        <ellipse cx="13.5" cy="27" rx="10" ry="13" transform="rotate(-14 13.5 27)" />
        <ellipse cx="50.5" cy="27" rx="10" ry="13" transform="rotate(14 50.5 27)" />
        {/* trunk, tapering to a rounded tip */}
        <path d="M26.8 34h10.4l-2 19.2a3.2 3.2 0 0 1-6.4 0z" />
        <rect x="15.5" y="6.5" width="33" height="35" rx="15.5" />
      </g>
      <circle cx="24.6" cy="23" r="2.6" fill="#ffffff" />
      <circle cx="39.4" cy="23" r="2.6" fill="#ffffff" />
    </svg>
  );
}

/** Redis (and protocol-compatible forks) — stacked keyspace slabs. */
export function RedisLogo(props: LogoProps) {
  const { title = 'Redis' } = props;
  return (
    <svg {...svgProps({ ...props, title })}>
      {title !== false && <title>{title}</title>}
      <g fill="#D82C20">
        <path d="M32 6 61 17 32 28 3 17z" />
        <path d="M3 25.5 32 36.5 61 25.5 61 31 32 42 3 31z" />
        <path d="M3 39.5 32 50.5 61 39.5 61 45 32 56 3 45z" />
      </g>
    </svg>
  );
}

/** ClickHouse — the stacked bars of its wordmark. */
export function ClickhouseLogo(props: LogoProps) {
  const { title = 'ClickHouse' } = props;
  return (
    <svg {...svgProps({ ...props, title })}>
      {title !== false && <title>{title}</title>}
      {/* Four vertical bars plus the short one — the shape of the
          ClickHouse wordmark, on the same 64x64 grid as the other marks. */}
      <g fill="#FFCC00">
        <rect x="6"  y="6" width="9" height="52" />
        <rect x="20" y="6" width="9" height="52" />
        <rect x="34" y="6" width="9" height="52" />
        <rect x="48" y="6" width="9" height="52" />
        <rect x="6"  y="27" width="51" height="10" />
      </g>
    </svg>
  );
}

/** SQLite — the feather-light file: a stack of pages with a folded corner. */
export function SqliteLogo(props: LogoProps) {
  const { title = 'SQLite' } = props;
  return (
    <svg {...svgProps({ ...props, title })}>
      {title !== false && <title>{title}</title>}
      <g fill="#0F80CC">
        {/* a document with a folded corner — SQLite is a file, and that is
            the whole point of it */}
        <path d="M12 4h26l14 14v42a2 2 0 0 1-2 2H12a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z" />
      </g>
      <path d="M38 4l14 14H40a2 2 0 0 1-2-2z" fill="#7CC3F0" />
      {/* three rows: a table inside the file */}
      <g fill="#ffffff">
        <rect x="17" y="30" width="30" height="4" rx="1" />
        <rect x="17" y="39" width="30" height="4" rx="1" />
        <rect x="17" y="48" width="20" height="4" rx="1" />
      </g>
    </svg>
  );
}

/** Parquet — columnar: vertical stripes of differing height, one per column. */
export function ParquetLogo(props: LogoProps) {
  const { title = 'Parquet' } = props;
  return (
    <svg {...svgProps({ ...props, title })}>
      {title !== false && <title>{title}</title>}
      {/* Columns, literally — the format stores column by column, not row by
          row, and the mark says so at 14px. */}
      <g fill="#50ABF1">
        <rect x="7"  y="20" width="10" height="38" rx="2" />
        <rect x="21" y="10" width="10" height="48" rx="2" />
        <rect x="35" y="27" width="10" height="31" rx="2" />
        <rect x="49" y="16" width="8"  height="42" rx="2" />
      </g>
      <rect x="5" y="60" width="54" height="3" rx="1.5" fill="#1A6BA8" />
    </svg>
  );
}

/** DuckDB — a sitting duck: body, head, beak. */
export function DuckdbLogo(props: LogoProps) {
  const { title = 'DuckDB' } = props;
  return (
    <svg {...svgProps({ ...props, title })}>
      {title !== false && <title>{title}</title>}
      {/* The brand colour is a pure yellow; the darker wing/eye keep the mark
          readable at 14px and on light backgrounds. */}
      <g fill="#FFD21F">
        {/* body: breast up front, tail flick at the back */}
        <path d="M8 40 C8 30 18 24 30 24 C40 24 48 30 50 38 L60 34 C61.6 33.4 62.8 35 61.8 36.2
                 L54 45 C48 52 38 56 29 56 C17 56 8 49 8 40 Z" />
        {/* neck + head */}
        <circle cx="42" cy="16" r="10" />
        <path d="M34 20 C36 24 38 26 40 27 L44 25 C42 23 41 21 40 19 Z" />
      </g>
      {/* beak */}
      <path d="M51 13 L62 16.5 L51 20 Z" fill="#F08030" />
      <circle cx="45" cy="13.5" r="2.2" fill="#21313C" />
    </svg>
  );
}

/** MongoDB — the leaf mark, simplified: one leaf with a stem and a center vein. */
export function MongodbLogo(props: LogoProps) {
  const { title = 'MongoDB' } = props;
  return (
    <svg {...svgProps({ ...props, title })}>
      {title !== false && <title>{title}</title>}
      {/* Brand green leaf, dark vein — readable at 14px, which is what the
          sidebar and tabs actually render. */}
      <path d="M32 4 C38 14 48 24 48 38 C48 50 41 57 34 59 L33 62 L31 62 L30 59
               C23 57 16 50 16 38 C16 24 26 14 32 4 Z" fill="#47A248" />
      <path d="M32 12 C36 22 42 30 42 39 C42 48 37 53 32 55 C27 53 22 48 22 39
               C22 30 28 22 32 12 Z" fill="#5CAB5E" />
      <path d="M32 8 L33 58 L31 58 Z" fill="#2E6B32" />
    </svg>
  );
}

/** SQL Server — a database cylinder quartered like a window, in brand blue. */
export function SqlserverLogo(props: LogoProps) {
  const { title = 'SQL Server' } = props;
  return (
    <svg {...svgProps({ ...props, title })}>
      {title !== false && <title>{title}</title>}
      {/* The cylinder says "database", the four panes say "Microsoft" — simple
          geometry, same doctrine as the other own-rendition marks above. */}
      <g fill="#A91D22">
        <path d="M32 8 C47 8 56 12 56 17 L56 47 C56 52 47 56 32 56 C17 56 8 52 8 47 L8 17 C8 12 17 8 32 8 Z" />
        <ellipse cx="32" cy="17" rx="24" ry="9" fill="#C9453C" />
      </g>
      {/* window panes cut into the body */}
      <g fill="#ffffff">
        <rect x="19" y="27" width="11" height="9" rx="1" />
        <rect x="34" y="27" width="11" height="9" rx="1" />
        <rect x="19" y="40" width="11" height="9" rx="1" />
        <rect x="34" y="40" width="11" height="9" rx="1" />
      </g>
    </svg>
  );
}

/** Pick the mark for an engine. */
export function EngineLogo({ engine, ...rest }: LogoProps & { engine: Engine }) {
  switch (engine) {
    case 'mysql':    return <MysqlLogo {...rest} />;
    case 'postgres': return <PostgresLogo {...rest} />;
    case 'redis':    return <RedisLogo {...rest} />;
    case 'clickhouse': return <ClickhouseLogo {...rest} />;
    case 'sqlite':   return <SqliteLogo {...rest} />;
    case 'parquet':  return <ParquetLogo {...rest} />;
    case 'duckdb':   return <DuckdbLogo {...rest} />;
    case 'mongodb':  return <MongodbLogo {...rest} />;
    case 'sqlserver': return <SqlserverLogo {...rest} />;
    default:         return null;
  }
}
