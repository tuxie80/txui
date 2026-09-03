// ── Plugin panel icon set ─────────────────────────────────────────────────────
// Same doctrine as treeIcons.tsx (its header is the canonical statement):
// crisp 16×16 stroke SVGs, colored via `currentColor` + per-panel `.pi-*` hue
// classes in App.css. No emoji, no raster images — emoji render as monochrome
// outlines or tofu boxes on Linux (🩺 and 🩹 came out as empty rectangles).
// The Stroke/Fill wrappers are copied from treeIcons (kept private there),
// extended with a `size` prop so menu and tab-bar slots can ask for 13/14px.

import { PLUGIN_ICON_URL } from './iconAssets';

type IconProps = { size?: number };

function Stroke({ size = 14, children }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
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

function Fill({ size = 14, children }: IconProps & { children: React.ReactNode }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" stroke="none" aria-hidden="true">
      {children}
    </svg>
  );
}

/** Processes — lightning bolt (the processlist is where you kill things). */
function ProcessesIcon(p: IconProps) {
  return (
    <Fill {...p}>
      <path d="M8.8 1.4L3.4 9.1h3l-1 5.5 5.2-7.7h-3l1-5.5z" />
    </Fill>
  );
}

/** Locks — padlock. */
function LocksIcon(p: IconProps) {
  return (
    <Stroke {...p}>
      <rect x="3.5" y="7" width="9" height="6.4" rx="1" />
      <path d="M5.7 7V5.2a2.3 2.3 0 014.6 0V7" />
      <path d="M8 9.6v1.6" />
    </Stroke>
  );
}

/** Watch — stopwatch (also the slow-log analyzer's glyph). */
function LongQueryIcon(p: IconProps) {
  return (
    <Stroke {...p}>
      <circle cx="8" cy="9.2" r="4.9" />
      <path d="M8 6.6v2.6l1.8 1.2" />
      <path d="M6.3 1.6h3.4M8 1.6v2" />
    </Stroke>
  );
}

/** Replication — opposing arrows (⇄). */
function ReplicationIcon(p: IconProps) {
  return (
    <Stroke {...p}>
      <path d="M2 5.2h11M13 5.2l-2.8-2.6M13 5.2l-2.8 2.6" />
      <path d="M14 10.8H3M3 10.8l2.8-2.6M3 10.8l2.8 2.6" />
    </Stroke>
  );
}

/** Statement statistics — declining trend line. */
function StmtStatsIcon(p: IconProps) {
  return (
    <Stroke {...p}>
      <path d="M2.2 13.5h11.6" />
      <path d="M2.2 4.2l3.6 3.2 2.8-2.2 5.2 5.4" />
      <path d="M13.8 7.8v2.8h-2.8" />
    </Stroke>
  );
}

/** Listen / Notify — antenna radiating. */
function PgListenIcon(p: IconProps) {
  return (
    <Stroke {...p}>
      <circle cx="8" cy="11.6" r="1.1" />
      <path d="M4.9 8.7a4.4 4.4 0 016.2 0" />
      <path d="M2.7 6.5a7.5 7.5 0 0110.6 0" />
    </Stroke>
  );
}

/** Server variables & status — "i" in a circle. */
function ServerInfoIcon(p: IconProps) {
  return (
    <Stroke {...p}>
      <circle cx="8" cy="8" r="6.1" />
      <path d="M8 7.3v3.9" />
      <path d="M8 4.5v.3" />
    </Stroke>
  );
}

/** DBA views — pulse trace on a monitor. */
function DbaViewsIcon(p: IconProps) {
  return (
    <Stroke {...p}>
      <rect x="1.8" y="2.8" width="12.4" height="8.8" rx="1" />
      <path d="M3.4 7.4h1.9l1.1-2.4 1.9 4.6 1.1-2.2h3.2" />
      <path d="M6 14h4M8 11.6V14" />
    </Stroke>
  );
}

/** Tuner — equalizer sliders. */
function TunerIcon(p: IconProps) {
  return (
    <Stroke {...p}>
      <path d="M4 2.4v11.2M8 2.4v11.2M12 2.4v11.2" />
      <circle cx="4" cy="9.4" r="1.5" />
      <circle cx="8" cy="5.4" r="1.5" />
      <circle cx="12" cy="10.8" r="1.5" />
    </Stroke>
  );
}

/** Users & grants — person. */
function UsersIcon(p: IconProps) {
  return (
    <Stroke {...p}>
      <circle cx="8" cy="5.1" r="2.5" />
      <path d="M3 13.6c.6-2.9 2.6-4.2 5-4.2s4.4 1.3 5 4.2" />
    </Stroke>
  );
}

/** Maintenance — wrench. */
function MaintenanceIcon(p: IconProps) {
  return (
    <Stroke {...p}>
      <path d="M14.2 5.4a1 1 0 00-1.4-1.4l-2.3 2.3a1.5 1.5 0 01-2.1-2.1L10.7 1.9a1 1 0 00-1.4-1.4 4.5 4.5 0 00-6 6L1.9 11a1.5 1.5 0 102.1 2.1l4.4-4.4a4.5 4.5 0 005.8-3.3z" transform="translate(0 1.4) scale(0.94)" />
    </Stroke>
  );
}

/** Vacuum & Bloat — broom sweeping dead tuples away. */
function VacuumIcon(p: IconProps) {
  return (
    <Stroke {...p}>
      <path d="M10.6 1.8L6.2 9" />
      <path d="M4.4 7.8l4 2.4-1.8 3.6a1.2 1.2 0 01-1.6.6L2 12.9a1.2 1.2 0 01-.6-1.6l1.8-3.2a1.2 1.2 0 011.2-.3z" />
      <path d="M11.5 12.5h2.5M10.5 14.2h3.5" />
    </Stroke>
  );
}

/** Fleet — label tag (the panel groups servers by label). */
function FleetIcon(p: IconProps) {
  return (
    <Stroke {...p}>
      <path d="M8.4 2.2H13a1 1 0 011 1v4.6L7.6 14.2a1 1 0 01-1.4 0L2 10a1 1 0 010-1.4L8.4 2.2z" />
      <circle cx="10.9" cy="5.3" r="1.1" />
    </Stroke>
  );
}

/** Playground — circus tent with a flag (a place to make a mess on purpose). */
function PlaygroundIcon(p: IconProps) {
  return (
    <Stroke {...p}>
      <path d="M8 1.4v3.2M8 1.7l3 .9-3 .9" />
      <path d="M8 4.6L2.2 13.8h11.6L8 4.6z" />
      <path d="M6.4 13.8L8 10.4l1.6 3.4" />
    </Stroke>
  );
}

/** ER diagram — linked nodes. */
function ErDiagramIcon(p: IconProps) {
  return (
    <Stroke {...p}>
      <rect x="1.5" y="2.2" width="5" height="3.6" rx="0.8" />
      <rect x="9.5" y="2.2" width="5" height="3.6" rx="0.8" />
      <rect x="5.5" y="10.2" width="5" height="3.6" rx="0.8" />
      <path d="M6.5 4h3M5.2 5.8l1.6 4.4M10.8 5.8l-1.6 4.4" />
    </Stroke>
  );
}

/** Table designer — pencil. */
function DesignerIcon(p: IconProps) {
  return (
    <Stroke {...p}>
      <path d="M10.8 2.4l2.8 2.8-7.9 7.9H2.9v-2.8l7.9-7.9z" />
      <path d="M9.4 3.8l2.8 2.8" />
    </Stroke>
  );
}

/** Routines — gear. */
function RoutinesIcon(p: IconProps) {
  return (
    <Stroke {...p}>
      <circle cx="8" cy="8" r="2.2" />
      <path d="M8 1.8v1.8M8 12.4v1.8M1.8 8h1.8M12.4 8h1.8M3.6 3.6l1.3 1.3M11.1 11.1l1.3 1.3M12.4 3.6l-1.3 1.3M4.9 11.1l-1.3 1.3" />
    </Stroke>
  );
}

/** Views — eye. */
function ViewsIcon(p: IconProps) {
  return (
    <Stroke {...p}>
      <path d="M1.6 8C3 5.2 5.4 3.7 8 3.7S13 5.2 14.4 8C13 10.8 10.6 12.3 8 12.3S3 10.8 1.6 8z" />
      <circle cx="8" cy="8" r="2" />
    </Stroke>
  );
}

/** Sequences — ascending steps. */
function SequencesIcon(p: IconProps) {
  return (
    <Stroke {...p}>
      <path d="M2 13h3.2V9.4h3.2V5.8h3.2V2.2H14" />
      <path d="M2 13h12" />
    </Stroke>
  );
}

/** Types — DNA helix. */
function TypesIcon(p: IconProps) {
  return (
    <Stroke {...p}>
      <path d="M5 2c0 4 6 4 6 6s-6 2-6 6" />
      <path d="M11 2c0 4-6 4-6 6s6 2 6 6" />
      <path d="M6.3 4.6h3.4M6.3 11.4h3.4" />
    </Stroke>
  );
}

/** Dictionary — open book. */
function DictionaryIcon(p: IconProps) {
  return (
    <Stroke {...p}>
      <path d="M2 3.6c2-1.1 4-1.1 6 .4 2-1.5 4-1.5 6-.4v9c-2-1.1-4-1.1-6 .4-2-1.5-4-1.5-6-.4v-9z" />
      <path d="M8 4v9" />
    </Stroke>
  );
}

/** Documenter — page with folded corner and text lines. */
function DocumenterIcon(p: IconProps) {
  return (
    <Stroke {...p}>
      <path d="M4 1.8h5.4L12.6 5v9.2H4z" />
      <path d="M9.4 1.8V5h3.2" />
      <path d="M6 8h4.4M6 10.4h4.4" />
    </Stroke>
  );
}

/** Data generator — die (five face up). */
function DataGenIcon(p: IconProps) {
  return (
    <Stroke {...p}>
      <rect x="2.4" y="2.4" width="11.2" height="11.2" rx="2" />
      <circle cx="5.6" cy="5.6" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="10.4" cy="5.6" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="8" cy="8" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="5.6" cy="10.4" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="10.4" cy="10.4" r="0.9" fill="currentColor" stroke="none" />
    </Stroke>
  );
}

/** CSV import — down arrow into a tray. */
function CsvImportIcon(p: IconProps) {
  return (
    <Stroke {...p}>
      <path d="M8 2.2v7.2M5.1 6.6L8 9.4l2.9-2.8" />
      <path d="M2.4 10.4v2.4a1 1 0 001 1h9.2a1 1 0 001-1v-2.4" />
    </Stroke>
  );
}

/** Find — magnifier over a database cylinder (one panel, three scopes). */
function FindIcon(p: IconProps) {
  return (
    <Stroke {...p}>
      <ellipse cx="6.8" cy="4" rx="4.4" ry="1.8" />
      <path d="M2.4 4v5.6c0 1 2 1.8 4.4 1.8.9 0 1.8-.1 2.5-.4" />
      <circle cx="10.8" cy="10.6" r="2.6" />
      <path d="M12.7 12.5l2 2" />
    </Stroke>
  );
}

/** Column profile — bar chart on an axis. */
function ColProfileIcon(p: IconProps) {
  return (
    <Stroke {...p}>
      <path d="M2.4 2.4v11.2h11.2" />
      <path d="M5.6 13.6V9.6M8.8 13.6V6.4M12 13.6V3.8" transform="translate(0 -0.4)" />
    </Stroke>
  );
}

/** Compare — two panes exchanging rows (one panel, four modes). */
function CompareIcon(p: IconProps) {
  return (
    <Stroke {...p}>
      <rect x="1.6" y="3" width="4.6" height="10" rx="1" />
      <rect x="9.8" y="3" width="4.6" height="10" rx="1" />
      <path d="M6.2 5.9h3.6M8.4 4.7l1.4 1.2-1.4 1.2" />
      <path d="M9.8 10.1H6.2M7.6 8.9L6.2 10.1l1.4 1.2" />
    </Stroke>
  );
}

/** TxShell — shell prompt (❯ + cursor). */
function TxShellIcon(p: IconProps) {
  return (
    <Stroke {...p}>
      <path d="M3.4 3.4l4 4.4-4 4.4" />
      <path d="M8.8 12.4h4.4" />
    </Stroke>
  );
}

/** SQL Quality — magnifier with a check mark. */
function QualityIcon(p: IconProps) {
  return (
    <Stroke {...p}>
      <circle cx="7" cy="7" r="4.3" />
      <path d="M10.1 10.1l3.6 3.6" />
      <path d="M5.1 7.1l1.3 1.3 2.4-2.6" />
    </Stroke>
  );
}

/** Saved queries — star. */
function SavedIcon(p: IconProps) {
  return (
    <Fill {...p}>
      <path d="M8 1.7l1.9 3.9 4.3.6-3.1 3 .7 4.3L8 11.6l-3.8 1.9.7-4.3-3.1-3 4.3-.6z" />
    </Fill>
  );
}

/** Query history — clock. */
function HistoryIcon(p: IconProps) {
  return (
    <Stroke {...p}>
      <circle cx="8" cy="8" r="6.1" />
      <path d="M8 4.4V8l2.5 1.6" />
    </Stroke>
  );
}

/** Scheduled run — a clock over a calendar (a query that runs on a cadence). */

/** Binary logs — stacked log segments with a bookmark (a position in the log). */
function BinlogIcon(p: IconProps) {
  return (
    <Stroke {...p}>
      <rect x="2.2" y="2.4" width="11.6" height="3" rx="0.8" />
      <rect x="2.2" y="6.6" width="11.6" height="3" rx="0.8" />
      <rect x="2.2" y="10.8" width="7" height="3" rx="0.8" />
      <path d="M11 10.8v3.4l1.4-1 1.4 1v-3.4z" fill="currentColor" stroke="none" />
    </Stroke>
  );
}

/** Query Store — a card-file drawer with a plan trend in it (an archive of plans). */
function QueryStoreIcon(p: IconProps) {
  return (
    <Stroke {...p}>
      <rect x="2.2" y="2.4" width="11.6" height="11.2" rx="1" />
      <path d="M2.2 7.8h11.6" />
      <path d="M6.6 5h2.8" />
      <path d="M4.6 11.4l1.8-1.4 1.6 1 3.4-2.4" />
    </Stroke>
  );
}

// querystore / vacuum / find / compare / binlog / slowlog are ALSO baked to
// src/assets/icons/plugins/<panel>.png by dev/rasterize_panel_icons.mjs —
// the native Tools menu (muda IconMenuItem) cannot draw an inline SVG and
// needs the raster copy. Edit an icon here, edit it there, re-run the script.
const PANEL_ICONS: Record<string, (p: IconProps) => React.JSX.Element> = {
  querystore: QueryStoreIcon,
  slowlog: LongQueryIcon,
  binlog: BinlogIcon,
  processes: ProcessesIcon,
  locks: LocksIcon,
  watch: LongQueryIcon,
  replication: ReplicationIcon,
  stmtstats: StmtStatsIcon,
  pglisten: PgListenIcon,
  serverinfo: ServerInfoIcon,
  dbaviews: DbaViewsIcon,
  tuner: TunerIcon,
  users: UsersIcon,
  maintenance: MaintenanceIcon,
  vacuum: VacuumIcon,
  fleet: FleetIcon,
  playground: PlaygroundIcon,
  erdiagram: ErDiagramIcon,
  designer: DesignerIcon,
  routines: RoutinesIcon,
  views: ViewsIcon,
  sequences: SequencesIcon,
  types: TypesIcon,
  dictionary: DictionaryIcon,
  find: FindIcon,
  documenter: DocumenterIcon,
  datagen: DataGenIcon,
  csvimport: CsvImportIcon,
  colprofile: ColProfileIcon,
  compare: CompareIcon,
  txshell: TxShellIcon,
  quality: QualityIcon,
  saved: SavedIcon,
  history: HistoryIcon,
};

/**
 * Icon for a plugin panel (key of PANEL_META in QueryTabs.tsx).
 *
 * A plugin is a tool, so it gets a colourful Noto emoji glyph (bundled in
 * src/assets/icons/plugins) that stands apart from the monochrome schema-object
 * icons — see components/iconAssets.ts for the plugin/database-object split.
 * When no raster asset exists for a panel we fall back to the inline stroke SVG,
 * tinted by the `.pi-<panel>` hue class. Unknown panels render nothing, matching
 * the old behaviour where an unknown panel had no icon to show.
 */
export function PanelIcon({ panel, size = 14 }: { panel: string; size?: number }) {
  const url = PLUGIN_ICON_URL[panel];
  if (url) {
    return (
      <span className={`pi pi-img pi-${panel}`}>
        <img src={url} width={size} height={size} alt="" aria-hidden="true" draggable={false} />
      </span>
    );
  }
  const Icon = PANEL_ICONS[panel];
  if (!Icon) return null;
  return <span className={`pi pi-${panel}`}><Icon size={size} /></span>;
}
