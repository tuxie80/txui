import type { TreeEntry } from '../utils/treeGrouping';
import { Spinner } from './Spinner';
import { OBJECT_ICON_URL } from './iconAssets';

// ── Schema tree icon set ──────────────────────────────────────────────────────
// Crisp 16×16 stroke SVGs, colored via `currentColor` + the `.ti-*` classes in
// App.css (muted per-family hues). No emoji, no raster images.

type SvgProps = { className?: string };

function Stroke({ className, children }: SvgProps & { children: React.ReactNode }) {
  return (
    <svg
      className={className}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.3}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

function Fill({ className, children }: SvgProps & { children: React.ReactNode }) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="currentColor" stroke="none" aria-hidden="true">
      {children}
    </svg>
  );
}

/** Database cylinder. */
export function DatabaseIcon({ className }: SvgProps) {
  return (
    <Stroke className={className}>
      <ellipse cx="8" cy="3.8" rx="5" ry="2.1" />
      <path d="M3 3.8v8.4c0 1.2 2.2 2.1 5 2.1s5-.9 5-2.1V3.8" />
      <path d="M3 8c0 1.2 2.2 2.1 5 2.1s5-.9 5-2.1" />
    </Stroke>
  );
}

/** Schema — stacked layers. */
export function SchemaIcon({ className }: SvgProps) {
  return (
    <Stroke className={className}>
      <path d="M8 1.8l6 3-6 3-6-3 6-3z" />
      <path d="M2 8.3l6 3 6-3" />
      <path d="M2 11.6l6 3 6-3" />
    </Stroke>
  );
}

/** Group container (Tables / Views / …) — folder. */
export function GroupIcon({ className }: SvgProps) {
  return (
    <Stroke className={className}>
      <path d="M2 4.5a1 1 0 011-1h3.2l1.6 1.7H13a1 1 0 011 1v5.3a1 1 0 01-1 1H3a1 1 0 01-1-1V4.5z" />
    </Stroke>
  );
}

/** Table — grid with header row. */
export function TableIcon({ className }: SvgProps) {
  return (
    <Stroke className={className}>
      <rect x="2" y="2.8" width="12" height="10.4" rx="1" />
      <path d="M2 6.4h12" />
      <path d="M6.2 6.4v6.8M10 6.4v6.8" />
    </Stroke>
  );
}

/** View — eye. */
export function ViewIcon({ className }: SvgProps) {
  return (
    <Stroke className={className}>
      <path d="M1.6 8C3 5.2 5.4 3.7 8 3.7S13 5.2 14.4 8C13 10.8 10.6 12.3 8 12.3S3 10.8 1.6 8z" />
      <circle cx="8" cy="8" r="2" />
    </Stroke>
  );
}

/** Function — italic ƒ. */
export function FunctionIcon({ className }: SvgProps) {
  return (
    <Stroke className={className}>
      <path d="M11 2.4c-1.9 0-2.4 1-2.8 2.9L6 12.3c-.3 1.4-.9 2-2.4 2" />
      <path d="M4.6 5.6h6" />
    </Stroke>
  );
}

/** Procedure — gear. */
export function ProcedureIcon({ className }: SvgProps) {
  return (
    <Stroke className={className}>
      <circle cx="8" cy="8" r="2.2" />
      <path d="M8 1.8v1.8M8 12.4v1.8M1.8 8h1.8M12.4 8h1.8M3.6 3.6l1.3 1.3M11.1 11.1l1.3 1.3M12.4 3.6l-1.3 1.3M4.9 11.1l-1.3 1.3" />
    </Stroke>
  );
}

/** Aggregate / window function — sigma. */
export function AggregateIcon({ className }: SvgProps) {
  return (
    <Stroke className={className}>
      <path d="M12 3.2H4l4.4 4.9L4 12.8h8" />
    </Stroke>
  );
}

/** Trigger — lightning bolt (filled reads better at this size). */
export function TriggerIcon({ className }: SvgProps) {
  return (
    <Fill className={className}>
      <path d="M8.8 1.4L3.4 9.1h3l-1 5.5 5.2-7.7h-3l1-5.5z" />
    </Fill>
  );
}

/** Event — calendar with clock hand. */
export function EventIcon({ className }: SvgProps) {
  return (
    <Stroke className={className}>
      <rect x="2" y="3.4" width="12" height="10" rx="1" />
      <path d="M2 6.8h12" />
      <path d="M5.4 2v2.7M10.6 2v2.7" />
      <path d="M8 8.9v1.9l1.3 1" />
    </Stroke>
  );
}

/** Materialized view — eye over a stored disc (it holds rows, unlike a view). */
export function MatViewIcon({ className }: SvgProps) {
  return (
    <Stroke className={className}>
      <path d="M1.8 6.2C3.1 4 5.3 2.8 8 2.8s4.9 1.2 6.2 3.4C12.9 8.4 10.7 9.6 8 9.6S3.1 8.4 1.8 6.2z" />
      <circle cx="8" cy="6.2" r="1.5" />
      <path d="M3.2 11.2h9.6M4.8 13.6h6.4" />
    </Stroke>
  );
}

/** Distributed table — a hub fanning out to shard nodes. */
export function DistributedIcon({ className }: SvgProps) {
  return (
    <Stroke className={className}>
      <circle cx="8" cy="3.4" r="1.8" />
      <circle cx="3.2" cy="12.4" r="1.8" />
      <circle cx="12.8" cy="12.4" r="1.8" />
      <path d="M7 4.9l-2.8 6M9 4.9l2.8 6M5 12.4h6" />
    </Stroke>
  );
}

/** Materialized-view storage target — a stored disc with an inbound arrow. */
export function StorageTargetIcon({ className }: SvgProps) {
  return (
    <Stroke className={className}>
      <ellipse cx="10" cy="5" rx="3.6" ry="1.6" />
      <path d="M6.4 5v5c0 .9 1.6 1.6 3.6 1.6s3.6-.7 3.6-1.6V5" />
      <path d="M2 8h3.2M5.2 8L3.7 6.6M5.2 8L3.7 9.4" />
    </Stroke>
  );
}

/** Sequence — ascending steps. */
export function SequenceIcon({ className }: SvgProps) {
  return (
    <Stroke className={className}>
      <path d="M2 13h3.2V9.4h3.2V5.8h3.2V2.2H14" />
      <path d="M2 13h12" />
    </Stroke>
  );
}

/** User-defined type — labelled tag. */
export function TypeIcon({ className }: SvgProps) {
  return (
    <Stroke className={className}>
      <path d="M8.4 2.2H13a1 1 0 011 1v4.6L7.6 14.2a1 1 0 01-1.4 0L2 10a1 1 0 010-1.4L8.4 2.2z" />
      <circle cx="10.9" cy="5.3" r="1.1" />
    </Stroke>
  );
}

/** Redis key namespace — a key tag / label with a colon. */
export function KeyPrefixIcon({ className }: SvgProps) {
  return (
    <Stroke className={className}>
      <path d="M2.6 5.2h7.2l3.6 2.8-3.6 2.8H2.6z" />
      <circle cx="5.4" cy="8" r="0.9" />
    </Stroke>
  );
}

/** RLS policy — a shield: this object decides who sees which rows. */
export function PolicyIcon({ className }: SvgProps) {
  return (
    <Stroke className={className}>
      <path d="M8 2.1l4.7 1.8v4.2c0 2.6-1.9 4.6-4.7 5.8-2.8-1.2-4.7-3.2-4.7-5.8V3.9L8 2.1z" />
      <path d="M6 8.1l1.5 1.5L10.3 6.6" />
    </Stroke>
  );
}

/** Extension — a plug-in block joining the server. */
export function ExtensionIcon({ className }: SvgProps) {
  return (
    <Stroke className={className}>
      <path d="M3 4.4h4V3.1a1.4 1.4 0 012.8 0v1.3h3.2v3.2h-1.3a1.4 1.4 0 000 2.8h1.3v3.2H9.8v-1.3a1.4 1.4 0 00-2.8 0v1.3H3V4.4z" />
    </Stroke>
  );
}

/** Primary-key column — key. */
export function KeyIcon({ className }: SvgProps) {
  return (
    <Stroke className={className}>
      <circle cx="5" cy="8" r="2.6" />
      <path d="M7.6 8H14M11.6 8v2.4M14 8v1.8" />
    </Stroke>
  );
}

/** Plain column — bar. */
export function ColumnIcon({ className }: SvgProps) {
  return (
    <Fill className={className}>
      <rect x="7" y="2.6" width="2" height="10.8" rx="1" />
    </Fill>
  );
}

/** Index — b-tree nodes. */
export function IndexIcon({ className }: SvgProps) {
  return (
    <Stroke className={className}>
      <circle cx="8" cy="3.4" r="1.6" />
      <circle cx="4.2" cy="12.4" r="1.6" />
      <circle cx="11.8" cy="12.4" r="1.6" />
      <path d="M8 5v2.2M8 7.2L4.8 10.9M8 7.2l3.2 3.7" />
    </Stroke>
  );
}

/** Nested (struct / list-of-struct) column — braces, the universal "object". */
export function StructColumnIcon({ className }: SvgProps) {
  return (
    <Stroke className={className}>
      <path d="M6 2.4c-1.6 0-2 .8-2 2.2v1.6c0 1-.5 1.6-1.6 1.8 1.1.2 1.6.8 1.6 1.8v1.6c0 1.4.4 2.2 2 2.2" />
      <path d="M10 2.4c1.6 0 2 .8 2 2.2v1.6c0 1 .5 1.6 1.6 1.8-1.1.2-1.6.8-1.6 1.8v1.6c0 1.4-.4 2.2-2 2.2" />
    </Stroke>
  );
}

/** Expand/collapse chevron — rotated 90° via CSS when the row is open. */
export function ChevronIcon({ className }: SvgProps) {
  return (
    <Stroke className={className}>
      <path d="M6 4.4l3.8 3.6L6 11.6" />
    </Stroke>
  );
}

/** Loading spinner — delegates to the unified <Spinner> (arc variant). The
 *  `className` (e.g. `tree-spinner`) still tints and sizes it via App.css. */
export function SpinnerIcon({ className }: SvgProps) {
  return <Spinner variant="arc" size={12} className={className} />;
}

/**
 * A schema-object icon slot. Prefers the bundled Tabler line icon (`tabler`),
 * pre-tinted to the family hue and drawn as a plain <img> — the same mechanism
 * the plugin icons use, so it needs no CSS `mask-image` support in the webview.
 * When no Tabler asset exists it renders the inline SVG `fallback`, tinted by
 * the `hue` class. Either way the glyph is monochrome — that is what marks the
 * whole schema-object family apart from the colourful plugin icons (see
 * components/iconAssets.ts).
 */
function TIcon({ hue, title, tabler, fallback }: {
  hue: string;
  title?: string;
  tabler?: string;
  fallback: React.ReactNode;
}) {
  const url = tabler ? OBJECT_ICON_URL[tabler] : undefined;
  if (url) {
    return (
      <span className={`tree-icon ${hue}`} title={title}>
        <img src={url} width={14} height={14} alt="" aria-hidden="true" draggable={false} />
      </span>
    );
  }
  return <span className={`tree-icon ${hue}`} title={title}>{fallback}</span>;
}

/** Pick the icon for a tree entry; color comes from the `.ti-*` class. */
export function ObjectIcon({ entry }: { entry: TreeEntry }) {
  switch (entry.kind) {
    case 'group':    return <TIcon hue="ti-group" fallback={<GroupIcon />} />;
    case 'database': return <TIcon hue="ti-database" tabler="database" fallback={<DatabaseIcon />} />;
    case 'schema':   return <TIcon hue="ti-schema" tabler="schema" fallback={<SchemaIcon />} />;
    case 'table':    return <TIcon hue="ti-table" tabler="table" fallback={<TableIcon />} />;
    case 'view':     return <TIcon hue="ti-view" tabler="view" fallback={<ViewIcon />} />;
    case 'mat_view': return <TIcon hue="ti-matview" title="materialized view" fallback={<MatViewIcon />} />;
    // CH Distributed table. Reuse the table hue (no App.css edit); the glyph
    // and title carry the distinction.
    case 'distributed':
      return (
        <TIcon
          hue="ti-table"
          title={`distributed table on cluster '${entry.cluster}' → ${entry.target_db}.${entry.target_table}`}
          fallback={<DistributedIcon />}
        />
      );
    // CH materialized-view storage target — borrows the matview hue.
    case 'mat_view_target':
      return (
        <TIcon
          hue="ti-matview"
          title={`storage table → ${entry.schema ? `${entry.schema}.` : ''}${entry.name}`}
          fallback={<StorageTargetIcon />}
        />
      );
    case 'sequence': return <TIcon hue="ti-sequence" title="sequence" tabler="sequence" fallback={<SequenceIcon />} />;
    case 'key_prefix': return <TIcon hue="ti-keyprefix" title="key namespace" fallback={<KeyPrefixIcon />} />;
    case 'type':     return <TIcon hue="ti-type" title={entry.type_kind.toLowerCase()} tabler="type" fallback={<TypeIcon />} />;
    case 'routine': {
      const rt = entry.routine_type.toUpperCase();
      if (rt === 'AGGREGATE' || rt === 'WINDOW') {
        return <TIcon hue="ti-aggregate" title={rt.toLowerCase()} fallback={<AggregateIcon />} />;
      }
      return rt === 'FUNCTION'
        ? <TIcon hue="ti-function" title="function" tabler="function" fallback={<FunctionIcon />} />
        : <TIcon hue="ti-procedure" title="procedure" fallback={<ProcedureIcon />} />;
    }
    case 'trigger':  return <TIcon hue="ti-trigger" title="trigger" tabler="trigger" fallback={<TriggerIcon />} />;
    case 'policy':
      return <TIcon hue="ti-policy" title={`row-level security policy (${entry.command})`} fallback={<PolicyIcon />} />;
    case 'extension':
      return <TIcon hue="ti-extension" title={`extension ${entry.version}`} fallback={<ExtensionIcon />} />;
    case 'event':    return <TIcon hue="ti-event" title="scheduled event" fallback={<EventIcon />} />;
    // PostgreSQL cluster-global objects + foreign tables. No bespoke glyphs —
    // reuse the closest existing icon; the title carries the exact kind.
    case 'publication':   return <TIcon hue="ti-extension" title="publication" fallback={<ExtensionIcon />} />;
    case 'event_trigger': return <TIcon hue="ti-trigger" title="event trigger" tabler="trigger" fallback={<TriggerIcon />} />;
    case 'tablespace':    return <TIcon hue="ti-database" title="tablespace" tabler="database" fallback={<DatabaseIcon />} />;
    case 'foreign_server': return <TIcon hue="ti-schema" title={`foreign server (${entry.fdw})`} tabler="server" fallback={<SchemaIcon />} />;
    case 'foreign_table':  return <TIcon hue="ti-table" title={`foreign table → ${entry.server}`} tabler="table" fallback={<TableIcon />} />;
    case 'column':
      return entry.primary_key
        ? <TIcon hue="ti-pk" title={entry.type_name} tabler="pk" fallback={<KeyIcon />} />
        : <TIcon hue="ti-column" title={entry.type_name} tabler="column" fallback={<ColumnIcon />} />;
    case 'index':
      return <TIcon hue="ti-index" title={entry.unique ? 'unique index' : 'index'} tabler="index" fallback={<IndexIcon />} />;
    case 'struct_column':
      return <span className="tree-icon ti-type" title={entry.type_name}><StructColumnIcon /></span>;
  }
}

/**
 * Object icon for surfaces that have only a bare kind, not a full TreeEntry —
 * e.g. the command palette's "open anything" list. Builds the minimal entry
 * ObjectIcon needs and delegates, so palette rows get the exact same Tabler
 * icons as the schema tree. Only the kinds those surfaces emit are supported
 * (table / view / routine); other kinds would need their extra entry fields.
 */
export function ObjectKindIcon({ kind, routineType }: { kind: string; routineType?: string }) {
  const entry = { kind, routine_type: routineType ?? 'FUNCTION' } as unknown as TreeEntry;
  return <ObjectIcon entry={entry} />;
}
