# Changelog

All notable changes to TxUI. Format: [Keep a Changelog](https://keepachangelog.com);
this project follows semantic versioning.

## [Unreleased]

### Added — geospatial, end to end

- **Geometry is now a first-class citizen: grid badges, cell mini-maps, and a
  real map view.** What used to be a wall of hex in a cell is decoded,
  labelled `⬡ Polygon · 4326`, previewed in the cell viewer, and drawn on a
  vendored 55 KiB Natural Earth basemap (`src/assets/basemap.json`, canvas,
  no tiles, no network). MapView gained a geometry-first mode with hover
  hit-testing; FastGrid badges are header-sniffs (WeakMap-cached), never full
  parses. **Portability: pure canvas — identical on all three desktops.**
- **Decoders for every wire shape the fleet actually emits.** Plain/extended
  WKB, PostGIS EWKB, MySQL's SRID-prefixed framing (now with the **axis swap**
  — MySQL stores geographic SRIDs lat-first per EPSG; 4326/4269/4258 are
  swapped to lon/lat for display, projected SRIDs never touched), GeoPackage
  `GP`-magic blobs, and SpatiaLite GaiaBinary (uncompressed classes only;
  compressed encodings honestly return null rather than decode wrong).
- **GeoParquet, read and write.** The Parquet engine parses the `geo` footer
  (CRS 3-way: absent = CRS84, null = unknown, PROJJSON honoured), labels
  columns `GEOMETRY · GeoParquet WKB`, and ships the footer **bbox through
  `QueryResult.geo_bbox`** so the map opens fit to the whole file — including
  partitioned datasets (union of member footers) — not to page one of the
  rows. New command **`duckdb_export_geoparquet`** writes real GeoParquet 1.1
  server-side via `COPY … (FORMAT PARQUET)` (sqlguard read-guard, write-once
  paths, spatial probed server-side); the Copy/Export menu entry is
  greyed-with-reason when spatial is off. Verified by reopening the produced
  file through the Parquet engine. The entry also appears in **DuckDB
  data-browser tabs** — the export SQL is rebuilt from the browse target,
  filters and sort *without* the page's `LIMIT/OFFSET`, so the whole filtered
  browse exports, not the visible page. The COPY reports over a Tauri
  `Channel` (`validating → running → progress{bytes_written} → done/error`,
  file size polled every 250 ms, surfaced in the status-bar running-tasks
  indicator) — honest liveness, no fake row percentages: duckdb-rs exposes
  no query-progress API. The export still re-runs the statement.
- **DuckDB spatial support.** GEOMETRY columns labelled via logical type; new
  command **`duckdb_enable_spatial`** (LOAD first — free and offline when
  cached — INSTALL only if absent; `networkError` classifies download
  failures); 58 `ST_*` completions gated on the spatial state so they appear
  only when they would run.
- **PostgreSQL/PostGIS: "View in WGS 84".** A projected geometry result gets
  a button that opens a `ST_Transform(..., 4326)` **derived query in a new
  tab** — the original SQL is wrapped verbatim, quoted per identifier, and
  refused with a named reason for anything it cannot wrap safely (multiple
  statements, non-SELECT families, ambiguous column names). Live-verified
  against PostGIS 3.6 / PG 17. SchemaTree badges spatial columns with SRID
  and GiST/no-index from `geometry_columns`/`geography_columns`.
- **MongoDB GeoJSON and ClickHouse geo arrays on the map.** Strict RFC 7946
  GeoJSON detection (objects and JSON strings) and ClickHouse
  `Point`/`Ring`/`Polygon`/`MultiPolygon` decoding gated solely on the
  server-reported `type_name`. `Feature`/`FeatureCollection` wrappers are
  unwrapped: a Feature draws its `geometry` (properties ignored — the
  Geometry struct has no slot), a FeatureCollection draws as a
  GeometryCollection; a Feature nesting a Feature is invalid and refused.
- **Redis "view as geo".** New command **`redis_geo_points`** (capped at
  5,000 members, GEOPOS in batches, missing coordinates counted honestly) and
  a `⬡ View as geo` toggle in the Redis browser with its own graticule
  scatter canvas. The UI carries the caveat the server does not: GEOPOS
  decodes *any* zset score as a geohash, so a leaderboard answers with edge
  coordinates — detection stays user-initiated.
- **SQL Server "⬡ View as geo".** A result with geometry/geography UDT
  columns (the `<udt: N bytes>` placeholders) gets a result-toolbar button
  that wraps them as `STAsBinary()` hex via `buildUdtDerivedQuery` (pure,
  29 tests) — feeding the existing WKB stack — with T-SQL-legal wrapping
  (TOP/OPTION/ORDER BY handled, `wkt` fallback for hierarchyid). The derived
  query opens **in a new tab** through the same honestly-logged derived-query
  path as PG's WGS 84 button; the button is greyed-with-reason (never
  hidden) when the statement can't be wrapped. **Live-verified against a
  SQL Server 2022 container: the full MSSQL live suite — 28 tests across
  driver, tuner, datagen, playground, import, routines, watch and quality —
  is green**, including the derived-query shape the button emits. tiberius
  is now **vendored**
  (`src-tauri/vendor/tiberius/`) with UDT and sql_variant panic guards.

Two new Tauri commands — **171 total**. Frontend 4,588 tests, backend 798.

### Fixed

- MySQL geographic columns displayed transposed (lat/lon swapped) — see the
  axis swap above.
- The grid badge now recognises GeoPackage and GaiaBinary containers, not
  just bare WKB/EWKB headers.
- A Parquet dataset mixing GeoParquet members with bare-BLOB members (or a
  `geo` footer missing `geometry_types`) failed with raw DuckDB engine prose
  at query time. `friendly_dataset_error` now matches that error family and
  answers with a named, actionable message — query the members separately or
  rewrite the plain files with GeoParquet metadata — keeping the raw engine
  text in the error chain.
- A geometry-only result (one numeric column plus the geometry, e.g.
  `SELECT id, name, geom …`) opened the Graphics tab on a chart of nothing:
  the map/chart default gate counted only numeric columns. `mappableResult`
  (`utils/geoDetect.ts`, pure + tested) now also honours a decodable geometry
  column, so such results open on the map.
- First live contact with a real SQL Server 2022 found the vendored
  tiberius UDT guard mis-framing **hierarchyid** values: SQL Server streams
  *every* UDT value as PLP (u64 length prefix) regardless of the declared
  max length, so taking the fixed-size u16 path for hierarchyid (maxlen 892)
  desynced the token stream and any raw `SELECT` over a
  geometry/geography/hierarchyid column died with `invalid token type 0`.
  The vendored `var_len.rs` UDT arm now always takes the PLP path
  (matching SqlClient on TDS 7.2+); NULL UDTs still ride the PLP-null
  sentinel, and the failure mode for anything unforeseen stays a clean
  per-query error, never a `panic=abort`.

## [1.2.0] - 2026-10-13

### Added

- **Self-update, finally: silent check, status-bar progress, restart chip.**
  The updater returns (removed 2026-08-04 for lack of real signing keys —
  now generated, minisign, pubkey in `tauri.conf.json`, private key in
  GitHub secrets + the maintainer's password manager, never the repo). One
  polite background check 10 s after launch and every 6 h against the
  release's signed `latest.json`; a pure semver util
  (`utils/updatePolicy.ts`, fully tested) classifies the delta and two new
  Settings → Updates checkboxes gate auto-download per class — **patch/minor
  ON by default, major OFF** (a major can change behaviour, so it waits for a
  click). An allowed update downloads in the background with a **⇩ chip in
  the status bar** (percent, popover with notes link + cancel); when done it
  becomes **↻ Restart to X.Y.Z** via the process plugin's `relaunch()`. A
  disallowed class gets a passive "⇩ X.Y.Z available" chip opening the
  release page. A failed check renders nothing and retries next launch — the
  updater never opens a dialog. Backend: two new commands (`update_check`,
  `update_download_and_install` — **168 commands**), typed errors, and a
  `TXUI_UPDATE_ENDPOINT` env override for a staging manifest without
  rebuilding (https-only in release builds — the local http loop is a
  debug-build affair, and it must run from inside the built `.app`: the
  install step derives the bundle root from the executable path and would
  swap `target/debug/` itself). `bundle.createUpdaterArtifacts` is on, so
  the bundler emits the `.app.tar.gz` / `.sig` updater artifacts. The download is not abortable mid-flight: the chip's
  Cancel means "stop telling me", the install still lands for the next
  natural restart. CI: both `release.yml` copies pass the signing env to
  tauri-action, which emits `.sig` files and publishes `latest.json` into
  the same draft — **an update goes live only when the release is
  published**, the draft gate is the staging mechanism. **Portability:
  macOS (bundle swap), Windows (passive NSIS) and Linux AppImage
  auto-install; a deb/rpm install is owned by the package manager and gets
  the notify-only chip instead** — the fallback is automatic on the
  backend's typed `not_updatable` error (new `ErrorCode`, wire-spelling
  tested on both sides). No `platformCaps` entry: the gap is package format,
  not OS. **Rollout note: 1.1.0 ships no updater, so 1.1.0 → 1.2.0 still
  happens via brew/curl/manual; auto-update works from the first release
  carrying it onward.**

- **One-line install: `curl -fsSL https://tuxie.eu/txui/install.sh | bash`.**
  `site/install.sh` (deployed with the site) detects the platform, resolves
  the latest release from the GitHub API (or takes a pinned version),
  downloads the right bundle and **verifies it against the release's
  `sha256sums.txt` — fetched from GitHub, not from the web host**, so a
  tampered mirror cannot slip a bad binary past it. macOS: dmg → TxUI.app in
  /Applications (~/Applications fallback) with the quarantine attribute
  removed — no right-click → Open dance on the ad-hoc-signed build. Linux
  x86-64: AppImage into ~/Applications plus a .desktop entry; `--deb`
  installs via apt instead. End-to-end tested against the real 1.1.0 release.
  The release workflow gains a trailing `checksums` job that publishes that
  `sha256sums.txt` (both release.yml copies kept identical).
- **Homebrew tap: `brew install --cask tuxie80/tap/txui`.** New repo
  `tuxie80/homebrew-tap` with the cask (universal dmg, sha256-pinned,
  Gatekeeper caveat documented); `brew upgrade` tracks future releases.
  `dev/bump_tap.sh` updates the cask from a release's checksums file and is
  now a step in the release checklist. The website gains an Install section
  with both commands. Windows stays on the NSIS/MSI download from the
  release page (a PowerShell `irm|iex` installer is the noted follow-up).

- **Rename refactoring in the 🔗 Find usages panel — previewed migration
  scripts, certain-hits-only.** "✏ Rename…" builds a deterministic script —
  drop dependents → the rename → recreate dependents — opened in an editor
  buffer, so running it goes through the normal write path (sqlguard, prod
  ack); no in-place rewrite, no second execution path, no new commands. Only
  `certain` usages are rewritten; `likely`/`possible` hits are listed with
  line numbers and never touched, and an object is dropped only when its full
  CREATE text was fetched AND the rewrite located the reference in it.
  MySQL/MariaDB: views/routines/triggers/events recreated from `SHOW CREATE`
  with quote style preserved, compound bodies wrapped in `DELIMITER //`,
  `RENAME COLUMN` gated on server version (old servers get a warning, not a
  synthesized `CHANGE COLUMN`). PostgreSQL: catalog-referenced objects
  (views, constraints, indexes, trigger bindings) follow the rename by
  themselves — verified live and listed as informational; only routine bodies
  are recreated via `pg_get_functiondef`. Pure core `utils/renameScript.ts`
  (66 tests) over a refactored shared `classifyHits()` in `utils/findUsages.ts`
  so search and rewrite can never drift. Live-verified end to end on MySQL
  8.4 and PostgreSQL 17 — including a planted `likely` hit left unchanged and
  failing loudly at call time exactly as its review item predicted. Engine
  scope: MySQL-family + PostgreSQL; other engines greyed with the reason.
  Portability: identical on all three desktops (pure util + existing query
  paths).

- **PostgreSQL plan depth: BUFFERS / WAL / SETTINGS, per-loop estimation
  error, parallel-worker findings.** EXPLAIN for PG now requests
  `(ANALYZE, BUFFERS, WAL, SETTINGS)` on both the plan view and the SQL
  Quality guarded path, with automatic fallback to the old option set on
  PG < 12. The plan view gains: a **"Worst estimate"** banner callout and a
  per-node Estimate-miss stat — now computed **per loop**, so a
  well-estimated 2000-loop inner node no longer reads as a 2500× miss;
  **parallel-worker degradation** findings (`Workers Planned` vs `Launched`
  per Gather node, critical at 0 launched) with a banner chip and a Workers
  tree column; per-node **buffer stats** (hit/read blocks + MB from storage)
  with a `disk reads` finding on self-attributable read-heavy nodes; and a
  `.plan-meta` strip rendering non-default planner settings (overrides like
  `enable_seqscan=off` highlighted) and WAL totals. Live-verified against a
  throwaway PG 17 cluster (settings captured verbatim, degraded-worker plan
  produced exactly the finding, WAL-generating INSERT plan parsed). MySQL
  explain untouched. Portability: identical everywhere.

- **Kill other sessions' ClickHouse queries through the one audited kill
  path.** `kill_processes` gains an optional `queryIds` arm: the Processes
  panel now lists ClickHouse `system.processes` rows (selectable by
  `query_id`, long-query tinting works via `elapsed`), and "Kill query" issues
  a parameter-bound `KILL QUERY … ASYNC` per id — TxUI's own in-flight queries
  are refused ("use the editor's Stop button"). "Kill connection" is greyed
  with the reason (HTTP is stateless; there is no connection to terminate).
  Audit logging, the read-only gate and outcome reporting ride the unchanged
  existing path. Live-verified against ClickHouse 26.9 (listed, killed, victim
  exited `QUERY_WAS_CANCELLED`). No new command.

- **Result charts: scatter type + explicit multi-Y series picker.**
  `ResultChart` gains a scatter plot (numeric X picker, per-point hover,
  ≤2000 points/series sampling with the stride reported) and a series-picker
  popover for line/area/scatter (checkbox list of numeric columns, remembered
  per chart type; inference remains the default). All chart math extracted to
  pure `utils/chartData.ts` (17 tests). PNG/SVG/clipboard export covers the
  new types automatically via the existing ER-export path.

- **Render-smoke harness: every component now mounts in `npm test`.**
  `dev/render-smoke/` (rolldown bundling — this repo's Vite 8 has no esbuild —
  with a programmable Tauri stub, a hand-rolled DOM shim with real event
  bubbling, canvas/ResizeObserver/CodeMirror support, prop auto-probing) plus
  `tests/renderSmoke.test.ts`: **all 120 component files mount with effects
  running, zero failures**, including the previously never-rendered surfaces
  (Map view with painted canvas, Security panel in both vault states, vault
  gate, all 9 Settings tabs clicked through, pre-flight/write-confirm,
  chart presets, native-menu event paths). Wave 6 §1 closed; CLI:
  `node dev/render_smoke.mjs`. Found zero shipping bugs — every failure was a
  fixture or shim gap.

### Changed

- **Pivot hardening**: pivot columns capped at 100 — past the cap the most
  frequent values stay columns and the rest fold into an exact-totals
  `(other)` column with an on-screen note (previously a 100k-distinct-value
  column rendered ~100k `<th>`s and froze the webview); grouped/pivoted
  results gain copy/export in all grid formats (export emits ALL groups, not
  just the 5,000 displayed); DECIMAL-string/NULL aggregate semantics pinned
  by tests. 500k rows group in ~94 ms.
- **Redis live-test seam**: `redis_browser.rs` commands factored into
  `pub(crate)` bodies (the codebase convention) so `#[ignore]`d live tests
  can drive them against standalone/cluster/sentinel fixtures via
  `TXUI_REDIS_TEST_PORT` / `_CLUSTER_PORT` / `_SENTINEL_PORT`.
- **Docs re-aligned with code**: docs/BACKLOG.md is now empty of open items
  (#6 pivot, #7 rename, #8 MySQL debugger all closed — 7 and 8 had partly
  shipped already); docs/NEXT.md Wave 3 object tree, Wave 5 SQLite/ClickHouse
  tuner + Parquet + Redis items, Wave 6 §1 and charting #3 marked done with
  verification notes.

### Fixed

- **Find-usages under-reporting**: a quoted name directly after a keyword
  (`FROM \`orders\``) misclassified as `likely` — `keywordBefore` didn't step
  over the opening quote. Now `certain` (this also feeds rename rewriting).
- **Redis Sentinel status column always blank** — live Redis 8.x Sentinel has
  no `status` field in `SENTINEL MASTERS`/`REPLICAS`; the state lives in
  `flags`. Fixed with a flags fallback, live-verified (master + replica).
- **Cluster MOVED/ASK errors classified as `Unknown`** — now typed
  `Unsupported` (a capability gap, correctly non-retryable). True
  redirect-following needs the redis crate's cluster client — a deliberate
  feature decision, reported not built.
- **Valkey misidentified as "Redis 7.2.4"** — the tuner read only
  `redis_version` (Valkey's compat baseline); it now detects
  `server_name: valkey` + `valkey_version`, reports flavor `valkey`, and does
  the EOL lookup against the valkey product. Live-verified against Valkey
  9.1.2 (the full browser/tuner/write-guard matrix is green; cluster and
  Sentinel topologies verified on Redis 8.10 — see docs/NEXT.md Wave 5).
- **Two literal NUL bytes in `utils/killAnalyze.ts`** (meant to be `\x00`
  escapes in a template literal) — replaced; the bytes blocked text tooling
  on the file.
- **Plan findings silently dropped from zero-self-time nodes** (a Gather with
  0 self time never surfaced its worker findings) and **PG buffer counts
  double-counted up the tree** (per-ancestor findings on cumulative counts;
  findings now judge self-attributable blocks). Both exposed by the new
  live PG 17 plan captures.

### Website & tooling

- **Website redesign** (tuxie.eu/txui): brand blue `#0000cd` with an orange
  contrast secondary; self-hosted Space Grotesk / Inter / JetBrains Mono
  (OFL, no CDN); the dot-particle database icon is now an ambient full-page
  background — several glyphs drifting on slow orbits, mouse-reactive — with
  every card floating over it in blurred glass; gradient buttons throughout.
  Tabbed engines/screenshots, compact layout and terminal install boxes from
  the first pass carry over.

- **Version lives in exactly one place: `package.json`.** The seven other
  carriers (`src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`,
  `src-tauri/tauri.conf.json`, the `README.md` badge, the website's
  `site/index.html` badge + footer, the newest CHANGELOG entry header, the
  AGENTS.md line) are written by `dev/sync_version.mjs` —
  `npm run version:sync -- X.Y.Z` bumps everything in one command (including
  renaming the changelog's `[Unreleased]` section with today's date and
  regenerating `docs/inventory.json`), and a bare `npm run version:sync`
  checks for drift. Enforcement: `tests/versionSync.test.ts` runs the same
  assertions on every `npm test`, so a hand-edit or a forgotten sync fails
  loudly instead of shipping quietly. **The website itself**
  (tuxie.eu/txui) gains the 1.1.0 badge and the Galera cluster suite in the
  engine and feature cards; the generated docs page already embeds the Galera
  guide, deep-dive anchors and the new screenshots.

- **Website deploy is now scripted and part of the release procedure** —
  `dev/deploy_site.sh` publishes `site/` + `docs/` to the Wedos hosting
  (tuxie.eu/txui) over plain FTP in one command; additive mirror (server-only
  files like the demo video survive), markdown sources excluded, password via
  `TXUI_DEPLOY_PASSWORD` or a hidden prompt — never the repo, never argv.
  AGENTS.md's release checklist now has the deploy as step 3, before the
  draft release is published.

## [1.1.0] - 2026-10-12

### Added

- **Kill from the cluster-wide Galera processlist — per-row, routed to the
  row's OWN node** (❖ Galera cluster panel → ▦ Processes; new
  `galera_cluster_kill` command — 166 commands). The merged process view
  merged every node's threads but offered no way to act on one: thread ids
  are node-local and the poll sessions are ephemeral. Every `user` row with a
  numeric id now gets a **Kill** button (applier/rollbacker/system rows never
  do — killing one breaks replication; the predicate is the pure, tested
  `killableRow`), which opens an inline confirm strip naming the node, thread
  id, user@host, age and query, with "Kill query N" / "Kill connection N".
  The backend takes the node's `ConnectionConfig` WHOLE (saved or ad-hoc
  "Monitor once" — the same address join the ⌁ Watch log tail uses), opens a
  short-lived session for it and issues the KILL through `do_kill_processes`
  — the factored body of `kill_processes`, so no kill bypasses the existing
  read-only and self-kill gates, and the ephemeral session is always torn
  down. Logging and audit are the Processes panel's own pieces
  (`killLogLine` + `logAudit`), attributed to the row's node by name.
  **Portability: identical on all three desktops** — one KILL over the
  existing session machinery, no shell, path or OS service anywhere, no
  `platformCaps` entry. **Engine scope: MySQL-family** — the cluster
  processlist is MySQL-only; a non-MySQL config is refused with a typed
  `unsupported` error before any connect attempt. **Privileges:** killing
  others' threads needs CONNECTION_ADMIN/SUPER — unknown-means-allowed, and a
  refusal surfaces inline as the row's outcome; read-only connections are
  refused server-side before a session is even opened; a **prod**-environment
  node additionally requires typing the thread id before the buttons arm (the
  EVICT typed-confirm precedent). Note: `kill_processes` itself still has no
  prod guard (the per-session Processes panel is unchanged by design — a
  server-side prod check there is a separate decision).

- **Galera user documentation — the feature surface finally has pages.** New
  `docs/GALERA_DEEPDIVE.md` (the whole arc: detection-by-VARIABLE, the
  per-session ❖ Galera tab, the cluster panel with write routing and per-node
  log tailing, the background watch, the tuner pack, the Playground scenarios,
  the deliberate non-features and the live-verification record) and a
  task-oriented `docs/user-guide/galera.md` with three generated screenshots
  (52 per-session tab, 53 cluster panel, 54 SST donor card) captured by the
  mock-Tauri pipeline from new wsrep fixtures in `dev/doc-fixtures.mjs` (real
  MariaDB 11.8 rows mined from `tests/fixtures/galera-status-mariadb118-*.txt`,
  with synthetic per-poll counter deltas so rates, write shares and the
  ✎ write target badge have a second poll to diff). The help-site panel sweep
  picks up the previously missing `galera-cluster` panel shot from the same
  fixtures (35/36 — only SQL Server's Query Store is unreachable under the
  mock). Getting the pipeline green surfaced and fixed two real panel bugs
  (see Fixed: the per-poll rate baseline, the StrictMode `mountedRef`) plus
  three dev-tooling breaks: the mock's `search_*` fallback returned `null`
  (HistoryPanel crashed into the full-window ErrorBoundary, silently ending
  the panel sweep mid-menu), and `shoot_userguide.mjs` still addressed the
  pre-regroup menu labels (`Monitor → Processes`, `Server → Tuner`).

- **SST/IST server-log tailing in the multi-node Galera cluster panel — the
  transfer card turns determinate on ANY node with SSH, saved or ad-hoc**
  (❖ Galera cluster panel; new `galera_cluster_sst_tail` command — 165
  commands). The per-session Galera tab's v5 "⌁ Watch server log" required a
  live `session_id` plus a SAVED `connection_id` (the SSH lookup went through
  `state.configs`), which the cluster panel's ephemeral per-poll sessions and
  ad-hoc "Monitor once" nodes could never satisfy. The new command takes the
  `ConnectionConfig` WHOLE — saved from the panel's own list, ad-hoc from the
  discovery clone (`buildAdhocConfig` spreads the seed's SSH fields and keeps
  the seed's id, which is what makes the SSH password resolve) — opens an
  ephemeral session for it, and funnels into the same shared `run_sst_tail`
  body the per-session command now calls (a behaviour-preserving refactor:
  log-path discovery, `tail -n 200 -F` over `spawn_ssh_exec`, the Channel
  event stream, the ext-job cancel). When a node's transfer card is active it
  offers **"⌁ Watch log"**; with a percentage in the log the card upgrades
  from the pulse bar to a **determinate fill** ("Receiving SST… 64%") plus the
  last raw log lines, and a **■ Stop** rides the unchanged `cancel_watched`
  oneshot. Tails auto-stop when the transfer resolves, the node leaves the
  poll or the selection, the process view takes over, or the panel unmounts.
  Honest failure by construction: a mid-SST joiner refuses TCP (live-verified
  on MariaDB 11.8 rsync SST), and that connect failure arrives as the terminal
  `ended` event rendered inline on the card — never an error the UI must
  special-case, never a hang. **Portability: identical on macOS, Windows and
  Linux** — the same mechanism as v5: the tail rides the system `ssh` client
  (`db/ssh.rs`) and `tail -F` runs remote-side, so no new client-side OS
  dependency and **no `platformCaps` entry**; the gate is on the CONNECTION
  having SSH configured, shown greyed with the reason, never hidden. **Engine
  scope: MySQL-family Galera nodes** on SSH-configured connections (MariaDB
  Galera / PXC) — non-MySQL configs are refused with a typed `unsupported`
  error before any connect attempt. **No privilege gate beyond v5's** — the
  only SQL is the `SHOW VARIABLES` log-path discovery (read-family, passes on
  read-only configs); the SSH side reuses the connection's own credentials
  (askpass env, never argv).

- **Cluster-aware write routing — the Galera cluster panel now says WHICH
  node writes should go to** (❖ Galera cluster panel; zero new probes, zero
  new Tauri commands — the ranking is the pure, unit-tested
  `utils/galeraWriteRouting.ts` over the summaries and write shares the poll
  already computes). Every poll ranks the live nodes as write targets:
  ineligible when unreachable, non-Galera, not Synced (Donor/Desynced,
  Joiner, Joined, non-Primary — an unreadable state is ineligible, never
  guessed) or mid SST/IST; eligible nodes score +2× their current write share
  (keeping writes where they already land avoids NEW cross-node conflicts)
  and pay for the slow-node signals in the panel's own warn vocabulary (flow
  control −3/−1 at the 10%/1% thresholds, apply-queue average −2 above 1.0,
  instantaneous recv/send queues −1 each above 8), ties broken by share then
  name so the ranking never flickers between polls. The recommended node's
  card head carries an **"✎ write target"** badge (its tooltip lists the
  reasons); the findings strip names the recommendation — and **warns when
  writes land dominantly (≥ half) on a node that is NOT the healthy choice**
  ("Writes land on X but Y is the healthier write target — X is flow-control
  throttled"), the multi-writer advice finally with a name on it. A new
  **"✎ Open writer"** toolbar button opens a session on the recommended node
  with a fresh query tab (the `dbgui:open-connection` drill-in choke point
  gains a `newTab` flag; App dispatches `dbgui:new-tab` once the session
  mounts) — greyed with the reason when no synced, healthy node exists, never
  hidden; ad-hoc "Monitor once" nodes rank and badge but are not open targets
  (they have no saved connection). Deliberately advisory: TxUI recommends,
  the user clicks — no silent re-routing of an existing session.
  **Portability: identical on macOS, Windows and Linux** — pure util plus
  webview wiring over the existing poll; no shell, path, key label, external
  binary or OS service; no `platformCaps` entry. **Engine scope:
  MySQL-family** — lives in the Galera cluster panel, so MariaDB Galera / PXC
  only. **No privilege gate** — reuses the poll's SHOW STATUS/VARIABLES data,
  which needs no grant (unknown-means-allowed); the only action is opening a
  session on a connection the user already saved.

- **Cluster-wide processlist — "what is every node executing right now", in
  one merged view** (❖ Galera cluster panel, "▦ Processes" toolbar toggle;
  new `galera_cluster_processlist` command — 164 commands). The toggle swaps
  the panel's main area between the node grid and the merged process table;
  while it is active the cluster poll pauses (one poll at a time — state
  clocks and rate baselines keep their last values, the same tolerance a
  failed poll already gets) and the process poll runs `SHOW FULL
  PROCESSLIST` on every selected node on the same 5 s cadence, the same
  ephemeral-session fan-out (concurrency cap, 30 s per-node timeout,
  ad-hoc "Monitor once" configs under their synthetic stable event ids) and
  the same read-only-by-construction guarantee. The backend ships raw
  columns + string rows (NULL → `""`); ALL interpretation is the pure,
  unit-tested `utils/galeraProcesslist.ts`: columns are looked up BY NAME
  because order differs across MySQL/MariaDB/Percona versions; threads
  classify as user / wsrep applier / rollbacker / system (grounded on the
  live MariaDB 11.8 processlist — "wsrep aborter idle"); identical
  normalized queries group across nodes ("×3 nodes — writeset apply" vs a
  local read on one; the probe's own SHOW FULL PROCESSLIST is excluded — it
  would always group); applier/system threads collapse per node; rows sort
  longest-running first; unreachable nodes render their error inline. The
  PROCESS-privilege reality is handled honestly: without PROCESS a fresh
  ephemeral session sees only its own thread, so the UI watches for the
  discriminating shape — ≤1 user thread AND 0 applier threads on EVERY
  answering node (an idle cluster keeps applier threads, so it never
  false-positives) — and shows an info bar with the GRANT PROCESS ON *.*
  hint instead of a confusingly empty table. KILL is deliberately not
  offered anywhere in this surface (kill_processes is session-scoped; this
  view observes) and the table footer says so. **Portability: identical on
  macOS, Windows and Linux** — one SHOW per node over the existing session
  machinery; no shell, path, key label, external binary or OS service; no
  `platformCaps` entry. **Engine scope: MySQL-family** — non-MySQL configs
  (saved or ad-hoc) are skipped with a note event, as in the cluster poll.
  **Privileges: optional, degraded mode explained in-UI** — the probe needs
  no grant (every account sees its own threads; unknown-means-allowed), and
  the missing-PROCESS shape is detected and named rather than mistaken for
  an idle cluster.

- **Galera cluster analytics bundle — four readings of the data the cluster
  poll already delivers** (❖ Galera cluster panel; zero new probes, zero new
  Tauri commands, all math in pure unit-tested utils modules).
  **Ghost-member / arbitrator awareness** (`utils/galeraGhosts.ts`): a member
  that appears in every node's `wsrep_incoming_addresses` but is matched by no
  polled or ad-hoc connection config (matched on the discovery module's
  canonical host:port, so `localhost` ≡ `127.0.0.1`) is a "ghost" — seen in
  ≥2 consecutive polls AND with every reachable node reporting
  `cluster_size == ok-nodes + ghosts` it classifies as a *likely arbitrator*
  and renders as a greyed, dashed ghost card ("answers Galera (gcomm), not
  SQL — N polls", tooltip naming garbd and its quorum vote); anything else is
  an *unknown member*, the only shape that earns a finding (info:
  "unreachable and not an arbitrator pattern — investigate"). A polled-but-
  down node is covered by its config and stays the existing unreachable
  finding, never a ghost. **Certification-conflict analytics**
  (`utils/galeraConflicts.ts`): `wsrep_local_cert_failures` (originating
  side) and `wsrep_local_bf_aborts` (victim side) become per-node RATES
  against the previous poll with consecutive-poll streaks — a per-card
  "conflicts: cert 0.3/s · bf 0.0/s" stat plus two sustained-rate (≥2 polls)
  warnings: cert failures rising on >1 node → "multi-writer hotspot", bf
  aborts concentrated on one node → "node C is the conflict victim".
  **Write-source distribution** (`utils/galeraWriteSources.ts`):
  `wsrep_replicated` deltas (parseGaleraStatus now exposes the write-set
  COUNTS beside the bytes) give each node a "writes here: 62%" card stat —
  the share of cluster-originated writes — plus a single-writer info finding
  and, only when certification failures are actually sustained, the
  multi-writer warning ("possible ≠ observed"). **Quorum advisor**
  (`utils/galeraQuorum.ts`): a compact header line, "3 nodes — survives
  losing 1" / "2 nodes — losing ANY node loses quorum" (strict majority of
  the current component), with warnings for even-sized components ("a tie
  has no majority — run an arbitrator or add a node"), elevated split-brain
  wording at size 2, and info at size 1. The #8 payoff: garbd counts toward
  `wsrep_cluster_size`, so 2 nodes + arbitrator reports 3 and correctly does
  NOT warn — and when no size is readable, classified arbitrator ghosts
  count toward the effective size. **Portability: identical on macOS,
  Windows and Linux** — pure presentation math over existing poll rows; no
  shell, path, key label, external binary or OS service; no `platformCaps`
  entry. **Engine scope: MySQL-family Galera only** — the panel's poll is
  wsrep by construction, and ad-hoc/saved non-MySQL configs are already
  skipped with a note. **No privilege gate** — everything derives from the
  `SHOW GLOBAL STATUS/VARIABLES LIKE 'wsrep%'` rows the panel already reads;
  no grant needed beyond connecting. The 3-node test fleet has no garbd, so
  ghost/arbitrator behavior is covered by constructed-snapshot unit tests
  (including the proof that a normal all-ok 3-node poll produces nothing).

- **Galera cluster auto-discovery + one-click adoption — no more hand-creating
  one saved connection per node.** The node you are connected to already knows
  its cluster mates (`wsrep_incoming_addresses`), and the Galera tab's existing
  5 s poll already reads it — discovery needed no new probe anywhere. When the
  tab (❖ Galera in the Replication panel) sees members that no saved MySQL
  connection covers, a banner offers — never forces — three actions.
  **"Add as connections"** runs the new `galera_adopt_members` command: each
  unsaved member becomes a clone of the current connection's config (fresh id,
  member's host/port, name like `db @ 127.0.0.1:3342`, folder named after the
  cluster) with BOTH secrets copied server-side to the new ids' keys
  (`dbgui:{…}` and `dbgui-ssh:{…}` — they never cross to the frontend), so the
  adopted nodes authenticate with the same credentials and SSH settings and a
  later delete cleans up the right keys; the sidebar refreshes via
  `dbgui:connections-changed` and the banner clears itself. **"Monitor once"**
  parks id-preserving ad-hoc config clones in the new in-memory
  `store/galeraAdhoc` (this app run only, deliberately not persisted) and opens
  the ❖ Galera cluster panel, which now ships them as `adhocConfigs` to
  `galera_cluster_poll`: the backend polls each through the exact same
  per-node path as a saved connection — same semaphore, 30 s timeout, cleanup
  — but uses it directly, never touching `state.configs`; the config keeps the
  seed's id (secret resolution keys on it) while its Node events carry a
  synthetic but STABLE per-member `connection_id` (RFC-4122-shaped FNV-1a hash
  of `adhoc:{seed}:{host}:{port}`), so the merge never collides with the
  seed's own node and state clocks/rate baselines survive across polls. Ad-hoc
  nodes merge as ordinary Node events — findings, split-brain detection,
  donor↔joiner pairing and the gcache math all apply — and a slim notice bar
  ("Monitoring N unsaved node(s) — Save all as connections / ×") keeps the
  state visible and offers the same adoption (which then swaps the nodes to
  their new saved ids seamlessly) or a return to saved-only. **Dismiss** hides
  the banner per connection (localStorage) until the unsaved-member count
  grows past the dismissed one. The matching is the pure, unit-tested
  `utils/galeraDiscover.ts`: `localhost` ≡ `127.0.0.1` ≡ `::1`, default port
  3306, IPv6 brackets, duplicates and 'AUTO' all fold — without that, the
  banner would offer to "discover" nodes already saved. Verified live against
  the 3-node MariaDB 11.8 cluster (3341-3343, `galera_discover_live` ignored
  test): both adopted connections open live sessions with the copied secret,
  and an id-preserving ad-hoc config polls a live node — ok, cluster
  `txui-galera`, size 3 — under its synthetic event id while `state.configs`
  gains nothing. One honest caveat that fleet exposed: it runs
  `wsrep_node_incoming_address=AUTO` (the MariaDB default), so its
  `wsrep_incoming_addresses` reads `AUTO,AUTO,AUTO` and the banner stays
  hidden there — AUTO is tolerated by design; the banner appears where real
  host:port tokens are reported (PXC, or MariaDB with the address set).
  **Portability: identical on macOS, Windows and Linux** — SHOW probes and the
  existing poll/event machinery only; no shell, path, key label, external
  binary or OS service; no `platformCaps` entry needed. **Engine scope:
  MySQL-family** — the banner only exists on the Galera tab, which itself only
  renders when `wsrep_on` is ON; non-MySQL ad-hoc configs are skipped with a
  note event, not an error. **No privilege gate** — the discovery data arrives
  on the same SHOWs the tab already runs, and adoption is a local operation on
  the connection store.

- **MySQL Group Replication (MGR) — a third topology tab in the Replication
  panel** (⟡ Group replication, beside ⇄ Async and ❖ Galera; mysql engine
  only). Detection is one tolerant three-way probe through `monitor_query`
  (`information_schema.PLUGINS WHERE PLUGIN_NAME='group_replication'`): no row
  → "Group Replication is not active on this server" (plain MySQL, and every
  MariaDB — GR is MySQL-only, and the empty state says exactly that);
  installed-but-not-ACTIVE named as its own state; ACTIVE with an empty
  members table → "plugin active, but the group is not started" with the
  `START GROUP_REPLICATION` hint. Once running, the tab polls
  `performance_schema.replication_group_members` +
  `replication_group_member_stats` + the identity SELECT every 5 s (the
  Galera tab's pause/watchdog/updated-stamp conventions) and renders the
  group block (name, single/multi-primary, local address, seeds, committed
  GTID set), a member table (host:port, PRIMARY/SECONDARY badge, state badge
  — ONLINE green / RECOVERING pulsing amber / ERROR·UNREACHABLE·OFFLINE red,
  version, "this node" from `@@server_uuid`) and per-member transaction stats
  (certified, conflicts, cert queue, applier queue = the apply-lag signal,
  applied, proposed, rollback). Pure health rules
  (`utils/groupReplication.ts`, 39 unit tests + a live-captured fixture):
  member ERROR/UNREACHABLE → crit, OFFLINE → warn, RECOVERING → info
  (provisioning, links to the clone card), single-primary with no PRIMARY →
  crit, multi-primary → info, conflicts > 0 → warn, applier queue growing or
  deep → warn. **Clone provisioning progress** (MGR's SST equivalent): while
  any member is RECOVERING the poll opportunistically reads
  `performance_schema.clone_status`/`clone_progress` (absent plugin or idle
  tables → nothing renders, the WSREP_INFO convention) and folds the seven
  documented stages into a **determinate byte-level bar** — the percentage
  Galera's SST cannot offer over SQL. Parsing is column-name-driven and
  nullable (8.4's `CHANNEL_NAME` prefix, 5.7/early-8.0 rows without
  `MEMBER_ROLE`/`MEMBER_VERSION` — unknown versions degrade, never crash).
  Zero new Tauri commands (everything through `monitor_query`). Verified live
  against a single-node MGR fixture on the my84 fleet instance
  (`dev/mgr_fixture_setup.sql` — SET PERSIST only, full teardown documented;
  `dbctl start my84` re-bootstraps the group and reports "(MGR ONLINE)";
  `dev/mgr_live.mjs` drives the real parsing/health logic against the live
  rows; `tests/fixtures/mgr-members-single.txt` is the capture). Found and
  fixed along the way: `dbctl`'s catalog still pointed my84/my97 at the brew
  formulas, and `brew services start mysql@8.4` boots the 8.4 binary against
  the WRONG datadir on the WRONG port — both are now the per-instance
  LaunchAgents the fleet actually uses.
  **Portability: identical on macOS, Windows and Linux** — performance_schema
  and information_schema reads only; no shell, path, key label, external
  binary or OS service; no `platformCaps` entry needed. **Engine scope:
  MySQL 8.0/8.4/9.x only** — MariaDB has no Group Replication (the probe
  fails softly to the honest empty state; verified live against MariaDB
  11.8). Clone progress is opportunistic: servers without the clone plugin
  render the tab without the bar. **No privilege gate** — the probe and both
  performance_schema tables are readable by any account that can query at
  all; unknown-means-allowed applies and nothing is greyed.

- **Galera consistency spot-check — proof that every node holds the same
  rows.** The ❖ Galera cluster group view gains "⇄ Spot-check table…": name a
  `schema.table` (prefilled from the current connection's default database),
  pick a sample (1k/10k/100k rows, or *full table* behind an explicit
  "I understand this reads the whole table on every node" checkbox), and every
  selected node computes the same `SUM(CRC32(CONCAT_WS('#', col…)))` +
  `COUNT(*)` over the same PK-ordered sample — ORDER BY pk LIMIT N is
  deterministic exactly when the data is identical, and `CONCAT_WS`'s
  skip-NULLs semantics are the same on every node because the expression is
  byte-identical everywhere (columns in declared order from
  information_schema; NULLs skipped, a documented choice over per-column
  COALESCE). Galera certification is synchronous, but wsrep_on=OFF drift,
  local writes and repair accidents are real — this is the DBA's verification.
  All-equal renders one green line; a difference renders a red card **naming
  the divergent node(s)** (majority vote; a 2-node tie names no villain) with
  a node-by-node rows/checksum/elapsed table, the likely causes and a copyable
  report. New command `galera_consistency_check` (161 → 162), multi_exec-shaped
  (ephemeral per-node sessions, concurrency cap 6, 30 s per-node timeout — a
  failed node is **inconclusive**, never a blocker). Guardrails: read-only by
  construction — the SQL is builder-generated (identifiers backtick-quoted,
  literals quote-doubled so NO_BACKSLASH_ESCAPES cannot break them out, the
  limit a u64) and no typed text ever executes; sample sizes are clamped
  server-side (≤1M); a table with no primary key **refuses sample mode** with
  the deterministic-sampling explanation and offers full-table instead. The
  comparison, verdict and report are the pure `utils/galeraConsistency.ts`
  (14 unit tests); 9 Rust unit tests cover the SQL builders and quoting.
  **Portability: identical on macOS, Windows and Linux** — CRC32 SQL over the
  same ephemeral-session machinery the cluster poll already uses; no shell,
  path, key label, external binary or OS service; no `platformCaps` entry
  needed. **Engine scope: any MySQL-family multi-node set** — built for Galera
  clusters (MariaDB Galera / PXC) but the check is engine-agnostic inside the
  family, so asynchronous primary/replica sets get an honest answer too.
  **Privileges: nothing beyond SELECT on the table** (information_schema
  metadata is every user's own schema view); read-only connections work.
  Live-verified 2026-10-02 against the real 3-node MariaDB 11.8 cluster
  through the actual command path (`cargo test --lib galera_consistency_live
  -- --ignored`): `galera_smoke.cc_test` (5,000 rows) read checksum
  **10690091660391** on all three nodes (8–11 ms per node, sample and full
  mode agreeing); a one-row wsrep_on=OFF drift on galera2 flipped its
  checksum to **10688636831386** while galera1/3 kept 10690091660391 — the
  divergent node named, row counts equal (a changed value, not an insert);
  after repair all three read 10690091660391 again; a no-PK table refused
  sample mode on every node with the explanation. Table dropped; cluster left
  3× Synced, size 3.

- **Background Galera cluster watch — monitor a cluster with no panel open.**
  The ❖ Galera cluster group view gains an opt-in "Watch this cluster in the
  background" toggle bound to the current node selection (the watch's identity
  IS its node set — one loop per cluster): while the app runs, the cluster's
  nodes keep polling every 30 s (15/30/60/120 configurable in the toggle's
  popover), the first feature that polls and writes history without a panel.
  The loop lives in a frontend store (`store/galeraWatch.ts`, the
  logStore/runningTasks pattern — it survives the panel unmounting); every
  decision is the pure `utils/galeraWatch.ts` round processor: per-node
  transitions diffed with the same `galeraEventsFromTransition` rules the open
  tab uses and persisted to each node's Incident timeline via
  `record_galera_event` (plus `reachability` rows once a node has failed 3+
  consecutive polls — one dropped probe is a blip, three is a down node — and
  its recovery), and an **OS notification** fires only on what is worth
  interrupting for: split-brain suspicion (merge CRIT findings, or a node's
  own state-UUID change), a member leaving, a node unreachable for 3+ polls,
  flow control crossing the critical threshold, and an SST starting/finishing
  (donor↔joiner pairing appearing/vanishing). Notifications are rate-limited
  per event key (15 min) and the same incident reported by several nodes
  collapses to one alert; the timeline keeps every transition regardless.
  Conservative by construction: off by default, opt-in per cluster; read-only
  SHOW probes on the same ephemeral per-poll sessions `galera_cluster_poll`
  already opens (works on read-only connections, no session can leak); the
  watch stops itself when every watched connection has been deleted; the off
  switch lives in the panel toggle, in the status bar's "⟳ N running" popover
  (the watch registers with the tab-activity registry, Stop button included),
  and in app shutdown. Enabled watches persist (one localStorage key) and
  resume on the next app run. No new Tauri commands. **Portability: identical
  on macOS, Windows and Linux** — SHOW probes plus the existing in-app OS
  notification plugin, no shell, path, key label, external binary or OS
  service; no `platformCaps` entry needed. **Engine scope: Galera clusters**
  (MariaDB Galera / PXC, the nodes the group view already polls). **Privileges:
  none beyond SHOW STATUS**, unknown-means-allowed — a missing wsrep key
  degrades a rule to silence. Live-verified 2026-10-02 against the real 3-node
  MariaDB 11.8 cluster (dev/galera_watch_live.mjs driving the actual round
  processor against live polls): `dbctl stop galera3` produced the size 3→2
  "a member left" timeline rows and notification on the survivors, the
  3-strikes "unreachable" row + notification, and `dbctl start galera3` the
  reachable-again recovery and 2→3 rejoin rows; a healthy cluster polls in
  silence. Cluster left 3× Synced.

- **Galera tuning advisor — a wsrep rule pack in the Server Tuner.** When the
  session is a Galera node (detected via the `wsrep_on` VARIABLE — MariaDB
  carries no STATUS row for it, verified live on 11.8), `tuner_analyze` gains
  nine checks (`src-tauri/src/tuner/galera_checks.rs`, pure rules over the
  collected maps, 19 unit tests): `galera.node_state` (non-Primary → critical;
  donor → info; Joining/Joined → warn), `galera.cluster_size` (one node →
  warn, two → advice on the missing tiebreaker), `galera.gcache_window`
  (gcache.size vs the observed average burn from `wsrep_replicated_bytes`/
  uptime — "a node down longer than ≈N min needs SST", the average-rate
  assumption stated in the finding; warn under 10 min, advice under an hour),
  `galera.slave_threads` (vs `wsrep_cert_deps_distance`: starved apply →
  advice/warn with a dynamic `SET GLOBAL wsrep_slave_threads` fix,
  overprovisioned → advice), `galera.apply_serial` (deps distance ≈ 0 under
  real write load — parallel apply has no window), `galera.flow_control`
  (paused-ratio ladder 1%/10%/50% → advice/warn/critical, `gcs.fc_limit`/
  `fc_factor` quoted, slowest-node-first advice), `galera.recv_queue` +
  `galera.recv_queue_avg` (the EWMA fires only corroborated by a non-empty
  current queue — it stays hot ~30 min after a rejoin), `galera.write_conflicts`
  (bf_aborts + cert_failures rate ≥ 60/h → warn — hot rows / multi-writer
  advice), `galera.sst_method` (rsync = donor blocked for the whole transfer,
  phrased as a TRADEOFF not an error, with wsrep_sst_donor pinning sanity;
  mysqldump → advice), and `galera.provider_options_readonly` (MariaDB:
  provider options are read-only over SQL — ERROR 1238 — so those fixes are
  config-file lines; PXC gets the `SET GLOBAL` variant). The panel renders
  them in their own **Galera Cluster** section (findings carry a `galera.` id
  prefix; their category stays a real scoring bucket, so the health-score
  math is unchanged). No new Tauri commands: the wsrep keys ride the
  collector's existing `SHOW GLOBAL VARIABLES/STATUS` probes; the collector
  adds only the provider-options parsing. **Portability: identical on macOS,
  Windows and Linux** — pure SQL probes and string math, no shell, path or OS
  dependency; no `platformCaps` entry needed. **Engine scope: MariaDB Galera +
  PXC** (any MySQL-family session with wsrep_on ON); the PXC-only paths (live
  `SET GLOBAL wsrep_provider_options` fix) are unit-tested, not live-verified —
  no PXC fixture exists. **Privileges: read-only probes, unknown-means-allowed**
  — a missing wsrep key degrades its check to silence, never to an error.
  Live-verified 2026-10-02 against the 3-node MariaDB 11.8 cluster (galera1):
  a healthy idle cluster yields only ok/info plus two legitimate advice rows
  (slave_threads=1 vs deps ≈3; 64 MiB gcache ≈ 44 min at the observed 25 KB/s
  average burn) — no false-positive warnings.

- **Galera Playground scenarios — flow-control storm + hot-row certification
  conflict.** The Playground (🎪) grows two Galera-only cards, greyed with the
  reason unless the session is a wsrep node (same `wsrep_on` VARIABLE probe as
  the Galera tab; the backend re-checks on the session's own pool before
  spawning). **🌊 Flow-control storm**: N writers loop small multi-row INSERT
  transactions (`rows per tx` ≤ 1000, optional ≤10 s pause between txs) for
  the duration — write-set pressure the peers must apply; watch recv queues
  and flow control react in the ❖ Galera tab / cluster panel. **💥 Hot-row
  certification conflict**: K writers UPDATE the same hot row(s)
  (`max(1, min(4, threads/4))`) at once; certification losers (error 1213) are
  retried by the worker and counted — retry-on-1213 is the lesson. Both run on
  their own pool under the existing playground clamps (≤64 threads, ≤600 s),
  refuse on read-only sessions and non-Galera sessions, and stay behind the
  playground's outright prod refusal. Unlike the lock table, the storm table
  `txui_playground_galera` is **dropped when the run ends** — its rows
  replicate to every peer, so leaving it would leave the mess. No new Tauri
  commands: `playground_spawn`'s spec gains `rowsPerTx`/`sleepMs` (serde
  defaults keep older payloads valid). **Portability: identical on all three
  desktops** — the scenario is SQL plus tokio timers, no OS surface; the
  greying is engine/session state, not a platform gap. **Engine scope:
  MariaDB Galera + PXC sessions only** (gated server-side); the conflict
  signature matcher (1213/deadlock/certification) is unit-tested for both
  vendors' message shapes, live-verified on MariaDB only. **Privileges:
  writes refused on read-only sessions; prod-tagged sessions refused
  outright** (the existing playground posture). Live-verified 2026-10-02
  against the 3-node MariaDB 11.8 cluster: a 4-thread/10 s/5-rows-per-tx flow
  storm replicated +137,766 write-sets (~690 MB) with peers' recv queues at 0
  — loopback applies faster than the storm generates, so no sustained FC was
  expected on the PEERS; the writer's own `wsrep_flow_control_paused_ns` grew
  3.4 ms → 1.44 s across the storms, so flow control DID throttle the writer.
  The conflict storm (8 threads, 2 hot rows, 10 s) moved
  `wsrep_local_cert_failures` 0 → 2 (`bf_aborts` stays 0 on a single node —
  brute-force aborts need a REMOTE conflicting write-set); both runs dropped
  their table. Cluster left 3× Synced.

- **Galera v5 — SSH error-log tailing: a true SST/IST percentage where SQL
  has none.** The Galera tab's transfer card (❖ Galera, Replication panel)
  gains a **⌁ Watch server log** affordance: when the connection has SSH
  configured, one click runs `tail -n 200 -F <error log>` on the DB host
  through the connection's own SSH settings and streams the lines back on a
  Channel (`galera_sst_log_tail`, commands 160 → 161 — via
  `db/ssh.rs::spawn_ssh_exec`, the sibling of the tunnel's opener: same
  askpass/jump/key machinery, `-T`, no port-forward). The card upgrades from
  the honest "no SST % over SQL" indeterminate display to a **determinate
  bar** the moment the log carries one — `Receiving IST... 64.0%
  (12,345/19,200 events)` is a real percentage on both MariaDB and PXC, and
  PXC's `[sst] progress=1` pv lines parse too — and narrates phases otherwise
  ("rsync SST started on joiner", "Transfer of InnoDB data files done",
  "Streaming the backup to joiner at …"); `WSREP_SST: [ERROR]` lines flash a
  warning without ending the watch (the SST scripts retry). The log path is
  discovered over SQL (`SHOW VARIABLES LIKE 'log_error'` — answered even on a
  wsrep_ready=OFF joiner whose port opens at all; empty → the MariaDB
  `<datadir>/<hostname>.err` fallback, relative values resolved against the
  datadir), then passed through an allowlist validator before it is
  single-quoted into the remote command — a `'` in the path is rejected
  outright, so the quoting cannot be broken out of. Parsing is pure TS
  (`utils/galeraSstLog.ts`, `parseSstLogLine`/`summarizeSstLog`), tested
  against REAL captures from the 3-node MariaDB 11.8 test cluster's error
  logs (`tests/fixtures/galera-sst-log-mariadb118.txt` — a full rsync SST,
  joiner and donor sides, plus a failed mariabackup SST's error lines).
  Cancellation rides the generic ext-job oneshot (`cancel_watched`), which
  kills the ssh child; the tail also stops when the transfer card resolves,
  when the tab hides (panels stay mounted — a hidden tail streams for
  nobody), and on panel/session close. **Portability: identical on macOS,
  Windows and Linux** — (1) the `ssh` binary is already a documented tunnel
  requirement with per-OS install hints, and `tail -F` runs REMOTE-side
  (spelled the same by GNU and BSD tail), so the feature adds no client-side
  OS dependency; (2) no new gap → **no `platformCaps` entry** — gating is on
  the CONNECTION having SSH configured, not the desktop: without SSH the
  control is greyed with "add SSH to this connection to watch the server
  log", handler guarded with the same predicate, backend refuses with a typed
  `unsupported` error; (3) the one shared `CREATE_NO_WINDOW` gate in
  `db/ssh.rs` now covers both spawn sites (tunnel + exec) so the project's
  `xplat-skip` count stays at one. **Engine scope: Galera nodes** on
  SSH-configured connections — PXC with `progress=1` gives percentages,
  MariaDB gives phases plus the real IST percentages. The SSH password path
  is unchanged (askpass env, never argv/script body — `docs/SECRETS.md`).
  ~~Multi-node panel reuse (GaleraClusterPanel) is a noted follow-up: its
  sessions are ephemeral per poll, so the tail does not fit it cheaply~~ —
  shipped 2026-10-12 (1.1.0): `galera_cluster_sst_tail` takes a full
  connection config and holds its own ephemeral session for the tail's
  duration, saved and ad-hoc nodes alike.
  localhost sshd was OFF on the dev machine (Remote Login disabled), so the
  exec path is verified by unit tests (path validation/quoting, event
  serialization), a forced-Windows-profile compile of the shared spawn gate,
  and inspection — not by an end-to-end ssh run.

- **Galera v4 — node operations + bootstrap advisor: the Galera tab's write
  side.** The per-session Galera dashboard (Replication panel, ❖ Galera tab)
  gains a **Node operations** section acting on the node you are connected
  to: **backup mode** (`SET GLOBAL wsrep_desync=ON/OFF` — reflects the polled
  variable, risk copy warns that desyncing ALL nodes leaves flow control with
  nobody to throttle), **maintenance mode** (`wsrep_reject_queries` ALL/NONE —
  ALL_KILL deliberately not a button: it kills existing connections including
  the session that would undo it), an **apply-threads stepper**
  (`wsrep_slave_threads`, clamped to the documented 1..512, hint tied to the
  apply-queue metric), **gcache freeze** and **node eviction**
  (`wsrep_provider_options` `gcache.freeze_purge_at_seqno=now` /
  `evs.evict=<uuid>`, the latter needing the word EVICT typed — the
  VacuumBloatPanel typed-confirmation pattern). Every op shows its own risk
  confirmation and is audit-logged; all run through `monitor_query`, whose
  server-side sqlguard classifies SET GLOBAL as a write — **zero new Tauri
  commands**. **Portability: identical on macOS, Windows and Linux** — SQL
  over the existing session machinery; no shell, paths, key labels or
  external binaries, no `#[cfg]` gate, no `platformCaps` entry. **Engine
  scope: Galera nodes** (MariaDB Galera / PXC), inside the mysql-engine
  Galera tab. **Privilege: SUPER** (MySQL 8's SYSTEM_VARIABLES_ADMIN also
  answers) — a new `server-admin` capability in `utils/privileges.ts` greys
  the ops with the grant to ask for when SHOW GRANTS positively denies it
  (unknown-means-allowed; without the grant the server's ERROR 1227 surfaces
  readably in the result list). Read-only sessions grey the ops naming
  read-only as the obstacle (the backend guard refuses them anyway); prod
  sessions come through the once-per-run ProdAck at open plus the per-op risk
  confirmation. The two provider-option ops are **PXC-only in practice**:
  verified live on MariaDB 11.8 (2026-10-02), `wsrep_provider_options` is
  read-only over SQL (ERROR 1238, and information_schema.SYSTEM_VARIABLES
  agrees) — a tolerant READ_ONLY probe greys them with exactly that reason
  there, while a probe failure (PXC has no such table) leaves them offered.
  Session-scope **causal reads (wsrep_sync_wait)** and **dirty reads
  (wsrep_dirty_reads)** checkboxes need no grant and no confirmation, with
  the pool caveat stated. When the poll says the node is in a **non-Primary
  component**, a **bootstrap advisor** card explains quorum loss, names the
  safe recovery (compare `wsrep_last_committed` across all former members —
  the highest wins — and run
  `SET GLOBAL wsrep_provider_options='pc.bootstrap=1'` on THAT node, shown as
  copyable SQL, deliberately NOT a button: wrong-node bootstrap loses
  transactions), mentions `mariadbd --wsrep-recover` for down nodes, and adds
  the MariaDB path (`galera_new_cluster`) when the probe says provider
  options are read-only. Live-verified against the 3-node MariaDB 11.8 test
  cluster: desync ON/OFF (state flips Donor/Desynced ↔ Synced,
  desync_count=1 accompanies), maintenance ALL (table/transaction statements
  rejected with ERROR 1047 for every account including SUPER; SET/SHOW and
  no-table SELECTs still answer — the mode stays reversible), slave_threads
  1→4→1, session toggles read back via `@@session.*`; the eviction run was
  deliberately not executed live (a real eviction needs a mysqld restart to
  rejoin) and is covered by unit tests; an all-nodes-desynced idle cluster
  still accepted a write — the cluster-wide stall needs flow-control
  pressure, and the risk copy says so honestly. Pure logic and tests in
  `utils/galeraOps.ts` (utils 212→213, pure 207→208, tests 228→229 files).

- **Galera v2 — cluster group view: ALL nodes of a cluster monitored at
  once** (owner-funded: "overall cluster monitoring, statistics and overview
  what nodes are doing"). A new **❖ Galera cluster** panel (session menu bar,
  Server group, next to Fleet — cross-connection like Fleet, so it picks
  SAVED connections, pre-selecting the current connection's folder-mates
  because the nodes of a cluster are usually already one folder). One new
  Tauri command, `galera_cluster_poll` (the count goes 158 → 159), which
  clones the multi_exec shape read-only: an ephemeral session per node
  (concurrency-capped at 6, 30 s per-node timeout), the same two wsrep SHOWs
  the single-node dashboard runs, raw rows streamed back as one event per
  node — a node that fails never fails the poll, and a node answering the
  1047 "WSREP has not yet prepared" signature — or refusing connections
  outright while a peer is Donor/Desynced, the observed rsync-SST joiner
  shape — is reported as "likely mid-SST", not as a mystery error. Everything interpretive is pure and
  unit-tested in `utils/galeraCluster.ts` (on top of `galeraStatus.ts`):
  per-node summaries with **write rates diffed between polls** (commits/s,
  replicated/received bytes/s — the "what are the nodes doing" statistics),
  and the cluster findings no single node can see — **split-brain** (same
  cluster name with differing `wsrep_cluster_state_uuid`, or two Primary
  components over disjoint `wsrep_incoming_addresses` → CRIT), cluster-size
  and membership disagreement, **donor↔joiner SST pairing with elapsed
  time** (manually desynced donors excluded), unreachable nodes, the
  slowest node (unique max on persistent apply backlog / flow control),
  mixed cluster names in the selection, and one OK finding when everything
  agrees. The UI: findings banner on top (split-brain CRIT is unmissable),
  then one card per node — state badge (Synced green / Donor amber /
  Joining pulsing), size-as-seen, FC%, queues, rates, inline SST/IST
  transfer card and gcache window, and an **Open** drill-in that connects
  to the node and lands on its own Galera tab. Poll 5 s, pause-able, hidden
  tab polls nothing; snapshots live in memory only. **Portability:
  identical on macOS, Windows and Linux** — SHOW probes over the existing
  session machinery and a webview; no shell, paths, key labels, external
  binaries or OS services, no `#[cfg]` gate, no `platformCaps` entry.
  **Engine scope: MySQL-family with wsrep** (MariaDB Galera / PXC);
  non-MySQL connections are skipped with a note event, and the picker only
  lists MySQL-family connections. **No privilege gate**: SHOW STATUS needs
  no grant (unknown-means-allowed). Read-only by construction — there is no
  write path. **Live-verified 2026-10-02 against a real 3-node MariaDB 11.8 +
  galera 26.4.27 cluster** (forced rsync SST via gcache overrun, and an IST
  rejoin — captures in `tests/fixtures/galera-status-mariadb118-*.txt`, the
  poll-by-poll record in `tests/fixtures/galera-sst-timeline.log`): a healthy
  cluster yields exactly the OK finding, and the verification corrected three
  assumptions — MariaDB 11.8 has **no `wsrep_on` STATUS row** (detection now
  probes the VARIABLE; the STATUS probe false-negatived the whole tab),
  `wsrep_incoming_addresses` lives in STATUS there (now read from both), and
  an SST donor shows `wsrep_desync=OFF` + `wsrep_desync_count=1`, so the
  count no longer reads as "backup mode" (donor pairing works on MariaDB
  donors now, not just PXC), and the `recv_queue_avg` EWMA stays >1 for
  ~30 minutes after a rejoin's catch-up, so the persistent-backlog and
  slowest-node rules now require a non-empty current queue as corroboration
  (a stale-high average on an idle node is residue, not a bottleneck).

- **Galera v1.1 — SST/IST transfer watch, a prominent card above the Galera
  dashboard the moment a node's local state leaves Synced** (still zero new
  Tauri commands — everything derives from the same two 5 s SHOW polls; the
  count stays 158). Live truth from the 2026-10-02 cluster verification: a
  MariaDB joiner mid-SST/IST refuses TCP connections entirely (its mariadbd
  opens the client port only once Synced) — the 1047 "answers SHOW, rejects
  queries" middle ground was never observed — so on the joiner itself this
  card surfaces via the poll error, while the DONOR's Donor/Desynced state
  (and, in the group view, the joiner's unreachability beside it) carries
  the transfer watch. The card, by phase: **Joining → SST** ("Receiving full
  state transfer (SST)") with elapsed time since the state was first
  observed and an animated indeterminate bar — the copy is honest: *Galera
  does not expose SST progress over SQL — elapsed time shown*; **Joined →
  catch-up** ("Transfer received — catching up on queued write-sets") with
  the recv-queue countdown ("12,340 write-sets left to apply");
  **Donor/Desynced → donor card** that disambiguates a manual desync
  (wsrep_desync=ON → "not necessarily serving a transfer") from a donated
  transfer (wsrep_desync=OFF — verified live: an rsync-SST donor shows
  exactly desync=OFF + wsrep_desync_count=1, so the count is donation
  evidence, not backup-mode evidence). **Determinate IST bar on PXC**: the four
  `wsrep_ist_*` keys give exact progress from the receive-seqno triple
  ("IST 64% — 12,345 of 19,200 events"), with the percentage-string fallback;
  MariaDB does not report these keys, so the bar is simply absent there
  (variant-dependent data, not a gated feature). **Gcache IST-window
  estimator**: "≈ 3 h 40 min of write-sets cached (gcache 128 MB) — a node
  restarted within that window rejoins by IST, not SST", from
  `wsrep_local_cached_downto` and the burn rate measured by the poll's own
  seqno samples (5 min ring buffer; counter resets and flatlines handled —
  "idle cluster: window effectively unbounded"; <2 samples → "collecting burn
  rate…"). **Health rules round 2** (all in the pure `utils/galeraStatus.ts`,
  which now takes the previous poll's snapshot for the rate rules): flow
  control by *rate* — `wsrep_flow_control_paused_ns` growing between samples
  is the primary signal (cumulative, immune to the FLUSH STATUS resets that
  leave the paused ratio stale-high; the ratio rule is the fallback and still
  serves the first sample); persistent apply backlog
  (`wsrep_local_recv_queue_avg` EWMA > 1.0) → warn; manual desync
  (`wsrep_desync_count` > 0) → info "writes on other nodes don't wait for
  it"; non-empty `wsrep_evs_evict_list` → warn "evicted nodes pending —
  cannot rejoin without a mysqld restart"; `wsrep_evs_repl_latency`
  min/avg/max parse with max > 10× avg outlier → warn "inter-node latency
  spiking"; growing `wsrep_local_bf_aborts` → info/warn "brute-force aborts
  (certification conflicts killing local transactions)". **Portability:
  identical on macOS, Windows and Linux** — the same two SHOW queries and a
  webview; no new backend, no shell, paths, external binaries or OS services,
  no `#[cfg]` gate, no `platformCaps` entry. **Engine scope: unchanged** —
  MariaDB Galera Cluster and PXC via the existing wsrep detection; the IST
  bar is PXC-only *data* (absent elsewhere, not gated). **No privilege
  changes**: SHOW STATUS needs no grant. Read-only by construction.

- **Galera cluster support (v1, read-only): a wsrep dashboard as a second
  "❖ Galera" tab of the Replication panel** on the MySQL family — MariaDB
  Galera Cluster and Percona XtraDB Cluster. Detection is one probe,
  `SHOW GLOBAL STATUS LIKE 'wsrep_on'` (the STATUS copy is the reliable one —
  it is ON only when the provider is loaded *and* active): ON starts the
  dashboard; an empty result — every non-Galera server — renders an honest
  "no wsrep provider on this server" empty state and polls nothing further,
  per the detection-inside-the-panel doctrine (no menu entry, so nothing to
  grey). Async-replication detection on the other tab is untouched: a Galera
  node can also be an async primary or replica. The dashboard polls
  `SHOW GLOBAL STATUS/VARIABLES LIKE 'wsrep%'` every 5 s (pause-able, with
  the watchdog) through the existing `monitor_query` read path — **zero new
  Tauri commands** (SHOW is read-family for the write guard; the count stays
  158) — and shows cluster identity (name, state UUID, config ID,
  Primary/Non-Primary), membership (size, incoming addresses, this node),
  node state (Synced/Donor-Desynced/Joined/Joining, ready, connected),
  replication progress (last committed, certification failures, apply/send
  queues, byte counters) and flow control, with `wsrep_flow_control_paused`
  rendered large — the single most actionable Galera signal. Parsing and the
  health rules live in the pure `utils/galeraStatus.ts` (non-Primary
  component → crit "split-brain risk"; ready/connected OFF → crit;
  Donor-Desynced → info "serving SST — expect degraded writes"; paused ratio
  >10 % → warn, >50 % → crit; apply-queue buildup → warn; missing keys on
  MariaDB-vs-PXC variants degrade a rule, never crash it). **Portability:
  identical on macOS, Windows and Linux** — two SHOW queries and a webview;
  no shell, paths, key labels, external binaries or OS services, no `#[cfg]`
  gate, no `platformCaps` entry. **Engine scope: MySQL-family only** —
  detection is by wsrep, not by flavor, so MariaDB Galera and PXC both light
  up and plain MySQL gets the empty state; the Galera tab is not offered on
  other engines. **No privilege gate**: SHOW STATUS needs no special grant
  (unknown-means-allowed). Read-only by construction — no write path exists.
  ~~Follow-ups (not v1): cluster-aware write routing, deeper SST/IST donation
  monitoring, node-management actions (write/admin operations needing the
  prod-ack plumbing).~~ All three have since shipped: node-management actions
  as v4 and deeper SST/IST donation monitoring as v5 (both 2026-10-02,
  entries above), cluster-aware write routing 2026-10-12 (1.1.0).

- **Parquet: nested columns (struct/list/map) render as real JSON.** The grid
  used to show arrow's display text for nested values — `{city: nyc, zip:
  10001}`, which is not JSON and cannot be parsed. `preview`,
  `preview_filtered` and whole-file export now decode nested columns
  recursively into JSON objects/arrays (`db/parquet.rs::cell_json`, hand-rolled
  — no arrow-json dependency — so primitive leaves keep the exact Arrow
  formatter rendering: timestamps stay ISO, decimals stay exact text). The
  grid shows them as compact JSON and the cell viewer opens them as a JSON
  tree (the MongoDB grid's viewer — no frontend change needed); a NULL struct
  and a struct whose fields are all NULL stay distinct, and NULL checks stay
  first per the row-decoding doctrine. In filtered scans a nested cell
  compares against its compact JSON, the same text the grid shows. Whole-file
  export embeds the JSON natively in ndjson and stringifies it in csv/tsv.
  The schema tree's struct expansion is unchanged — it predates this. No
  column-flattening toggle: the cell-viewer tree (with path copy) covers
  inspection, and DuckDB answers flattening-in-SQL better.
  **Portability: identical on macOS, Windows and Linux** — pure Rust over the
  arrow/parquet crates; no shell, paths, external binaries or OS services, no
  `#[cfg]` gate and no `platformCaps` entry. **Engine scope: Parquet only**;
  the connected file stays immutable (reads only).

- **Parquet: create an empty file with a schema you design.** The connection
  form's Parquet section gets a **New…** button (the SQLite precedent) opening
  a schema designer: column rows with name, a type dropdown (string / integer
  / float / boolean / date / timestamp / decimal(p,s) / binary), per-column
  nullability, and add/remove/reorder. Validation lives in the pure
  `utils/parquetSchema.ts` (unique non-empty names ≤128 chars, no control
  characters, decimal precision 1–38 with scale ≤ precision) and is enforced
  again in Rust — new command `create_parquet_file` (the count goes 157 →
  158), whose type allowlist mirrors the frontend list. The file is written by
  the same ArrowWriter settings as Export → Parquet (ZSTD, 128k-row row
  groups, `created_by = TxUI`), zero batches, so it opens as a valid empty
  file with exactly the footer schema asked for. Same rule as
  `create_sqlite_file` and `write_parquet_file`: an existing path is refused
  outright — creating over someone's file is not a thing this app does.
  **Portability: identical on macOS, Windows and Linux** — arrow/parquet
  crates plus the native save dialog; no shell, paths, external binaries or
  OS services, no `#[cfg]` gate and no `platformCaps` entry. **Engine scope:
  Parquet only**; the `writes` capability flag is deliberately unchanged —
  creating a file is a standalone action like `create_sqlite_file`, and the
  connected file stays immutable.

- **Parquet: open a folder as one partitioned dataset.** A Parquet
  connection's path may now be a **directory** (a **Folder…** picker beside
  File… in the connection form; the name defaults to the folder name).
  Opening one walks the tree for `*.parquet`/`*.parq`/`*.pq` (capped at
  10 000 files, the error names the cap), reads every footer, and collects
  hive `key=value` path segments as partition columns. `LiveSession::Parquet`
  now wraps a `ParquetSource` — `Single` keeps the pure arrow/parquet path
  byte-for-byte; `Dataset` additionally holds an in-memory DuckDB session
  with one temp view (`read_parquet(…, hive_partitioning = true,
  union_by_name = true, filename = true)`), used **only** for the row path:
  the data browser's filters and sort become real pushdown SQL instead of an
  in-memory scan, schema drift between files reads through `union_by_name`,
  and the source file rides along as a `filename` column. The 15 footer
  views keep working across the dataset — per-file views gain a leading
  `file` column (path relative to the root), FILEINFO reports file count and
  totals, HEALTH/CODECS aggregate per file; the tree names the directory and
  sums the footer row counts, `list_columns` merges the top-level schema
  first-wins with partition columns appended tagged `VARCHAR · partition`;
  whole-dataset export streams through the view's `COPY … TO`. The SQL
  editor stays refused on dataset sessions in v1 — ad-hoc SQL over Parquet
  already exists via the DuckDB `:memory:` engine (DuckDB cannot launch an
  in-memory database in read-only mode, so the view's session is an ordinary
  scratch one; no user text ever reaches it, only the browser's
  parameterised SELECTs). The view's glob re-expands per query, so files
  added after open appear in the browser automatically; footer forensics are
  from open time — reconnect to re-walk (no RESCAN verb). No new Tauri
  command (the count stays 158) and no `engineCaps` change.
  **Portability: identical on macOS, Windows and Linux** — directory walking
  is `std::fs`, the pickers are `tauri-plugin-dialog`'s native dialogs on all
  three desktops, and the bundled DuckDB already cross-builds on all three
  per `crossbuild/`; no shell, hardcoded paths, external binaries or OS
  services, no `#[cfg]` gate, no `platformCaps` entry,
  `tests/portability.test.ts` untouched. **Engine scope: Parquet only**;
  datasets stay immutable (reads + export only).

- **SQL Quality retargeted for ClickHouse — a third rulebook, not a flag.**
  The 🔍 panel now opens on ClickHouse sessions (`engineCaps.sqlQuality`
  flips to true) and runs its own pure pipeline (`utils/qualityRunCh.ts`)
  with a CH-native rule set (`utils/chQuality.ts`), following the
  PostgreSQL-parity precedent (docs/SQL_QUALITY_DEEPDIVE.md §7): the MySQL
  rules do not translate — ClickHouse has no cost optimizer, no
  rows-examined and no EXPLAIN ANALYZE — so the checks judge the evidence
  ClickHouse actually has. **Static (CH-S1–S8):** unbounded reads, SELECT *
  with the column count + approximate width once metadata resolves, FINAL,
  arrayJoin, cartesian joins, ORDER BY without LIMIT, leading-wildcard LIKE,
  function-wrapped predicate columns (fix = range on the bare column).
  **Metadata (CH-M1–M4):** `ORDER BY tuple()`, predicates that touch neither
  the partition key nor the leading key column on a large table, Distributed
  fan-out, predicates hiding the partition key in a function — read from
  `system.tables` + `system.columns`. **EXPLAIN indexes = 1 (CH-E1/E2):**
  no-pruning detection with the server's own parts/granules counts quoted
  verbatim (red when a WHERE prunes nothing). **EXPLAIN ESTIMATE (CH-T1/T2):**
  >1B-row unbounded reads, whole-table reads, and the many-small-parts smell;
  the Parts/Rows/Marks table is the "Query plan (estimated)" section.
  **EXPLAIN PIPELINE** ships as raw evidence (rules are v1.5 — no honest
  numbers attach to it yet). **system.query_log (CH-Q1):** measured history
  of the query's normalized shape (runs, avg rows / bytes / ms), with an
  honest empty state; the section degrades — never fails the run — when the
  grant is missing. The column map is a `LIMIT 0` describe over the HTTP
  JSONCompact meta (exact types + nullability), so **no new Tauri command
  was needed (the count stays 157)**; `explain_query`'s existing CH `mode`
  parameter serves all three EXPLAIN kinds. The MySQL-only checks (InnoDB
  stats, type audit, integer ceilings, EXPLAIN ANALYZE) stay visible but
  greyed, each naming the ClickHouse mechanism that answers the same
  question or saying there isn't one; schema review stays greyed with a tip
  pointing at the 💊 ClickHouse tuner. **Portability: identical on macOS,
  Windows and Linux** — pure TypeScript rules plus the HTTP driver; no
  shell, paths, external binaries or OS services, no `#[cfg]` gate and no
  `platformCaps` entry. **Engine scope: ClickHouse only** — other engines
  keep their existing pipelines. **Privilege: `system.query_log` is
  grant-gated** — the Recent-executions section reports the restriction
  in-line (unknown-means-allowed) and every other section is unaffected;
  each section degrades on its own, never the run. Live shape test:
  `TXUI_CH_PASSWORD=root cargo test --lib clickhouse_live_quality -- --ignored --nocapture`.


- **PostgreSQL object tree: logical-replication subscriptions + extended
  statistics.** The two remaining pg_catalog kinds from the object-tree plan
  now render: **Subscriptions** (PG 10+, `pg_subscription`) group at the
  connection root beside Publications, each row showing `→ publication, …`
  plus a `· disabled` marker; **Extended statistics** (PG 10+, `CREATE
  STATISTICS` objects from `pg_statistic_ext`) group per schema between RLS
  policies and Extensions, each row showing `on <table> · ndistinct,
  dependencies, …`. Both are DDL-only nodes (double-click or right-click →
  View DDL): statistics DDL comes from `pg_get_statisticsobjdef` (PG 12+, the
  supported floor), and subscription DDL is emitted with
  `CONNECTION '<conninfo withheld>'` — the conninfo is **never read**
  (`subconninfo` is not even selected), because it can embed a password and
  no tree or DDL surface may carry one. Both catalog queries ride the
  existing `unwrap_or_default` tolerance: on PG < 10, on a non-superuser
  (pg_subscription is superuser-only), or on a managed PG that restricts the
  catalog, the query fails quietly and the group simply does not appear.
  **Portability: identical on macOS, Windows and Linux** — pure sqlx queries
  plus a data-driven tree group; no shell, paths, external binaries or OS
  services, no new `#[cfg]` gate and no `platformCaps` entry. **Engine scope:
  PostgreSQL ≥ 10 only** — older servers and other engines never emit the
  node kinds, so the groups never render (unknown-means-allowed, nothing is
  greyed). **No privilege gate** — pg_statistic_ext is world-readable;
  pg_subscription is superuser-only by Postgres itself, and the
  tolerant-empty behaviour turns that restriction into "no group" rather
  than an error.

- **Cancellable VACUUM — the Vacuum & Bloat panel's one-way door is closed.**
  Every action the 🧹 panel executes (VACUUM / ANALYZE / REINDEX …
  CONCURRENTLY / VACUUM FULL / CLUSTER) now runs through a new tracked
  `run_vacuum` command instead of `monitor_query`: the statement executes on a
  connection acquired for the run alone (never the session's pinned
  transaction connection, where VACUUM cannot even run), the backend pid is
  reported up front so the panel's Now section doubles as the run's live
  progress view, and a **■ Cancel** button appears while it runs — running →
  cancelling → cancelled/done. Cancel goes through the shared
  `cancel_watched` ext-job oneshot and issues `pg_cancel_backend(pid)` from a
  second connection, so stopping a run never disturbs the session's other
  work; a cancelled run is reported as **cancelled**, not failed (results
  list, audit row and session log line all say so). The server-side guard is
  unchanged: read-only sessions are refused before anything is dialed (the
  panel greys the action with the reason, as before), and on prod the hard
  limits still reject VACUUM FULL / CLUSTER unless the connection opted in.
  **Portability: identical on macOS, Windows and Linux** — pure sqlx/Tauri
  channel code; no shell, paths, external binaries or OS services, no new
  `#[cfg]` gate and no `platformCaps` entry. **Engine scope: PostgreSQL
  only**, like the panel itself (SQLite VACUUM is not offered by this panel;
  a SQLite VACUUM cannot be cancelled mid-run regardless). **Privileges**:
  VACUUM needs table ownership (or the appropriate role) and cancel needs
  `pg_signal_backend` or ownership of the target backend — the server rejects
  otherwise and the error surfaces readably; unknown-means-allowed, nothing is
  greyed speculatively.

- **Incident timeline — one chronological per-connection view answering "what
  happened on this server between 14:00 and 14:30?"** The new panel (Insights
  menu, or Tools ▸ Insights ▸ Incident timeline) merges the events TxUI already
  captures into a single newest-first list: audit statements and
  connect/disconnect lifecycle, deadlock incidents, digest snapshots,
  multi-server runs, and long-query captures — day-grouped, with a kind badge,
  status colour and humanized duration per row, a density strip across the
  window, kind filter chips, and copy/insert-into-editor drill-in for statement
  rows. Long-query captures now persist at all: the Long query panel's watchdog
  records each threshold crossing to a new `long_query_events` store in
  history.db (100 kept per connection, deduped like the deadlock store) via a
  fire-and-forget `record_long_query_event`. The `incident_timeline` command
  does one small capped query per kind and normalizes the stores' mixed
  UTC/local timestamps to epoch ms in Rust — the frontend never parses a
  timestamp string. Honest edges, named in the panel footer: deadlocks are
  recorded only while the Locks & Deadlocks panel is open; every store is
  capped, so an empty window can mean retention, not a quiet server; and audit
  rows are keyed by connection name, so a rename orphans older rows from this
  view. **Portability: identical on macOS, Windows and Linux** — local SQLite
  reads plus a webview list; no shell, paths, external binaries or OS services,
  no new `#[cfg]` gate and no `platformCaps` entry needed. **No engine gate** —
  the data is engine-agnostic local history. **No privilege gate** — nothing is
  read from the server, so no grant is required.

- **MongoDB depth: aggregation-pipeline runner + collection stats.** The
  MongoDB workspace gains two permanent tabs beside Find. **Aggregate** runs
  read-only aggregation pipelines: one JSON CodeMirror document (an array of
  stage objects, extended JSON accepted), a stage-snippet dropdown ($match,
  $group, $sort, $limit, $skip, $project, $addFields, $unwind, $lookup,
  $count, $facet, $sample) and a limit input; results render in the shared
  JSON grid. Write stages `$out`/`$merge` are rejected client-side before any
  invoke (`utils/mongoPipeline.ts`) and again in Rust before anything reaches
  the server (`WRITE_STAGES` in `db/mongodb.rs`, drift-guarded by a test) —
  MongoDB stays structurally read-only by owner decision; a trailing `$limit`
  guard (default 500, capped at 10 000) is appended last so an unbounded
  pipeline never streams a whole collection, and allowDiskUse is on so big
  `$group`/`$sort` stages spill instead of failing. **Stats** shows collection
  stats from the `$collStats` stage (document count, size/storage, index
  sizes, operation latency) flattened into the (section, name, value) grid —
  on tab entry plus explicit Refresh only, and a view's server-side refusal is
  shown readably rather than pre-hidden. New commands: `mongo_aggregate`,
  `mongo_coll_stats`. **Portability: identical on macOS, Windows and Linux** —
  driver calls plus a webview grid; no shell, paths, external binaries or OS
  services, no new `#[cfg]` gate and no `platformCaps` entry. **No engineCaps
  flag** — both surfaces live only inside the MongoDB workspace. **No
  privilege gate** — MongoDB roles are not modelled, so unknown means allowed;
  the server's own rejection surfaces readably.

- **Galera v3a — wsrep transitions join the Incident timeline.** The Galera
  tab's 5 s poll now diffs consecutive wsrep snapshots (new pure
  `galeraEventsFromTransition` in `utils/galeraStatus.ts`) and persists every
  TRANSITION as a `galera_event` on the Incident timeline — steady state
  records nothing, the first poll only establishes the baseline. What counts
  as an event: local state changes (Synced → Donor/Desynced = "donating SST"
  or "manual desync", cause-disambiguated the same way the transfer card does
  it; → Synced = the recovery, rendered green), cluster size changes
  (shrinking = "a member left", growing = the rejoin), flow-control
  threshold crossings (one event for the highest warn/crit threshold crossed,
  in either direction) and the split-brain signals visible from one node
  (cluster state-UUID change always; a conf_id bump reported only when the
  size did NOT change with it — a routine join/leave is already the size
  event). One new Tauri command, `record_galera_event` (159 → 160), writes
  into a new `galera_events` store in history.db that mirrors the
  deadlock/long-query stores exactly (dedupe against the newest stored
  type+summary, 100 events kept per connection, UTC stamps); the invokes are
  fire-and-forget and never block the poll. The timeline panel gains a
  "galera" kind chip; events with `ok=false` (leaving Synced, member lost,
  FC rising) render as red incidents, recoveries green. **Portability:
  identical on macOS, Windows and Linux** — local SQLite writes plus SHOW
  probes over the existing session; no shell, paths, external binaries or OS
  services, no new `#[cfg]` gate and no `platformCaps` entry. **Engine:
  Galera nodes only** (the tab itself is MySQL-family + wsrep_on-detected).
  **No privilege gate** — SHOW STATUS/VARIABLES need no grant; unknown means
  allowed.

- **Galera v3b — flow-control / queue / commits sparklines.** The Galera tab
  keeps per-poll samples already (the gcache burn-rate precedent); a compact
  three-cell strip above the dashboard now charts the last ~5 minutes of
  **flow-control paused ratio** (turns amber above 1%), **apply queue**
  (amber above the warn threshold) and **commits/s** (the `wsrep_last_committed`
  rate, counter resets skipped rather than charted negative). Same data the
  numbers already show, over time; keys a build does not report just shorten
  their series. **Portability: identical on macOS, Windows and Linux** — the
  samples and the SVG live in the webview. **Engine: Galera nodes only**;
  **no privilege gate** (SHOW STATUS).

- **Galera v3c — WSREP_INFO membership table (opportunistic).** When
  MariaDB's optional WSREP_INFO plugin is installed, the Galera tab probes
  `information_schema.WSREP_MEMBERSHIP` once per session and renders the
  membership table it returns (columns reordered identity-first by pure
  `orderMembershipColumns`). The plugin is SUPER-gated and not installed by
  default, so the probe tolerates failure silently and the table is simply
  absent — variant-dependent data is omitted, never greyed. **Portability:
  identical on macOS, Windows and Linux** — one SELECT through
  `monitor_query`. **Engine: MariaDB Galera with the plugin installed**;
  privilege: needs SUPER, and unknown means allowed — a refusal renders
  nothing, not an error.

### Changed

- **Galera tab restructured into a dense card layout — no scrolling on a
  healthy Synced node at normal panel sizes.** The four full-width kv
  sections (Cluster / Membership / Node state / Replication progress) plus
  Flow control now pack side by side in a `.gal-cards` grid
  (`repeat(auto-fit, minmax(240px, 1fr))`) instead of claiming a full-width
  row each — the dead space to the right of the narrow kv tables is gone.
  Findings moved above the sparkline strip (alert surfaces first), the
  gcache IST-window note is a footer inside the Replication progress card,
  and the Cluster card's trivia (provider + version, state UUID, config ID)
  merged into one muted mono line. Two rarely-used surfaces collapse to
  one-line summaries: the WSREP_INFO membership table ("N members
  (WSREP_INFO) ▸", inside the Membership card) and Node operations (a
  summary bar carrying the live values — desync, maintenance, threads,
  sync_wait, dirty_reads — with desync-ON/maintenance-ALL highlighted even
  while collapsed). Expanding either reveals the previous content unchanged;
  every op gate, confirmation and data-tip is untouched. Pure layout — no
  feature, polling or parsing change, utils/galeraStatus.ts untouched, the
  async tab's `.repl-section` spacing untouched. **Portability: identical on
  macOS, Windows and Linux** — pure CSS grid, no new exceptions.

### Fixed

- **Galera cluster panel: per-node rates/shares only ever rendered for the
  last-answering node.** The poll handler diffed each streaming node event
  against `snapsRef` — which the previous event of the SAME round had already
  updated — so once the second event landed, the first node's rates
  (commits/s, bytes in/out, "writes here", conflict rates) were computed
  against its own fresh snapshot and read "—" until the next event; the
  settled view showed rates on exactly one card. The round now diffs against
  the previous COMPLETE round, captured once per poll. Found by the new
  documentation screenshots (the fixture cluster rendered two of three cards
  rate-less).
- **Galera cluster panel dead under StrictMode (dev builds).** The
  `mountedRef` cleanup-only effect stayed `false` after StrictMode's
  mount/unmount/mount replay, so every Channel event handler early-returned
  and the panel sat at "Polling N nodes…" forever in `cargo tauri dev` (and
  in the screenshot pipeline, which is how it surfaced). The effect now
  re-sets the flag in setup — the DumpRestorePanel idiom. MultiExec carries
  the same cleanup-only pattern; not touched here.

- **Data generator: a UNIQUE string column no longer overflows its declared
  length when the uniqueness tag grows.** Unique strings get a `_rowIdx`
  suffix (before the `@` for emails) — but the suffix was appended without
  regard for the column's size, so the Library kit's 17-char ISBN in a
  `VARCHAR(20)` fit `_99` yet overflowed at row 100, dying mid-run with
  `1406 (22001): Data too long for column 'isbn' at row 101` and zero rows
  committed. The generator now shrinks the base value's left edge (never the
  tag — uniqueness is what the tag is for; emails keep their domain intact)
  so base + tag + domain always fits the declared `VARCHAR(n)`/`CHAR(n)`.
  Regression tests run 2,500 rows through the exact library-ISBN spec and an
  email spec, asserting both the length cap and uniqueness hold.

- **Galera: a real donor no longer falls into "Unrecognized local state".**
  The v1 rules compared `wsrep_local_state_comment` against `Donor-Desynced`
  (hyphen), but the value both MariaDB and Percona actually report is
  `Donor/Desynced` (slash) — so a node donating an SST rendered as an
  unrecognized state instead of the donor notice, and the new transfer card
  would have missed it too. Both spellings are now accepted (the hyphen
  variant shows up in some UIs), with regression tests for each.

## [1.0.0] - 2026-09-19

### Fixed

- **The landing page's activity feed stamped a disconnect at the session's
  START time.** A disconnect row brackets the whole session by design
  (`started_at` = connect, `ended_at` = disconnect), and the feed showed
  `started_at` — so "Disconnected — lasted 5 min 5 s" carried the same
  timestamp as "Connected", reading as though the disconnect had happened at
  connect time. The feed now stamps a disconnect at `ended_at`, the moment it
  actually happened (`utils/welcomeFeed.ts`, regression-tested).

- **The green run-time marker no longer lands on the comment above the
  statement.** A statement preceded by a `--` comment line (a copied log line,
  say) had its statement range start at the comment, and the marker anchor
  skipped only whitespace — so running `select … limit 20000;` drew the
  `✓ · ms` chip on the comment line above it. The new pure
  `firstCodeOffset()` (`utils/sqlSplit.ts`, tested) advances the anchor past
  leading whitespace and `--` / `#` / `/* */` comments — but not past `/*+ */`
  optimizer hints or `/*! */` conditional comments, which execute server-side —
  and the gutter marker, its right-click menu, and next-statement navigation
  all anchor through it. What runs or copies is unchanged; only the line the
  chip sits on moved.
- **Sequences are no longer offered on plain MySQL.** The session plugin menu
  and Tools ▸ Schema ▸ Sequences were gated on the static `mysql` engine flag,
  which must say "ask" because MySQL and MariaDB share an engine id — so Oracle
  MySQL and CloudSQL were offered a panel their server cannot fill. Both menu
  surfaces now consult the per-session flavor probe (`serverFlavors` +
  `capabilities()`): MariaDB 10.3+ keeps Sequences, MySQL/Percona never see it.
- **"Close other tabs" / "Close tabs to the right" clean up what they close.**
  The bulk-close path filtered the tab list directly: closed tabs kept their
  editor refs until disconnect, tabs with running work were closed silently,
  and the active tab id could be left pointing at a closed tab. It now skips
  busy tabs (logging how many stayed open), releases each closed tab's refs,
  and re-targets activation to the newest surviving tab. Disconnect also drops
  the session's cached server flavor (no dead cache entries, reconnect
  re-probes) and any stale schema-scan status line.

### Changed

- **Plugin menus open under the first letter of their title, and are noticeably
  slimmer.** Every dropdown was anchored to its title button's right edge, so a
  menu's list appeared shifted left of the word that opened it. Now the list's
  left edge sits under the "A" of "Activity" for the first five menus; the last
  two (Find & Compare, SQL) keep the right-edge anchor because they sit at the
  window's right edge, where opening under the word would push the list
  off-screen. The chrome also went on a diet: popup min-width 220 → 170 px,
  tighter item/header padding, smaller icon column and caret gap.
- **The data generator follows the panel convention: actions in the toolbar,
  no bottom bar.** It was the only panel with a footer action bar; Back, the
  COPY fast-path checkbox, and the step's primary action now live in the panel
  toolbar next to the step pills, like Data Compare and friends. The column
  list and target form are correspondingly tighter (name column 200 → 160 px,
  generator select 180 → 150 px, slimmer paddings throughout). The freed
  `.dg-actions` styling survives as the shared `.row-actions` used by five
  other panels.

## [0.65.0] - 2026-09-03

**Maintenance runs you can watch.** Table upkeep used to batch every table
into one statement (`CHECK TABLE a, b, c …`) and answer in one lump; now every
table is its own statement, with a live progress line and per-table timing.

### Changed

- **Maintenance operations run one statement per table, with live progress.**
  MySQL's batched table list (`CHECK TABLE a, b, c`) returned a single lump:
  no per-table timing, no progress while it ran, a cancel that could only land
  mid-statement, and a failure buried in one row of a multi-row answer. Every
  op on every engine now emits one statement per table and the 🩹 Maintenance
  run shows it: a progress line (`7 / 47 · reporting.orders · running…`), the
  results list scrolling itself to the newest line as tables land, and **a
  milliseconds column per table** — plus the timestamped, copyable run log
  from before. Failures are per-table by construction: one bad table reads as
  one red line with the server's message, and the queue continues. Cancel
  still aborts the in-flight statement and skips the rest — now always at a
  table boundary. `statementSubject()` (pure, tested) names the table of every
  generated statement shape for the progress line. Audit gets one row per
  table too, which is the honest accounting.

_Older releases (0.64.0 and earlier) are kept in the maintainer's local full-history file, not part of this repo._

