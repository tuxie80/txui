# Changelog

All notable changes to TxUI. Format: [Keep a Changelog](https://keepachangelog.com);
this project follows semantic versioning.

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

_Older releases (0.64.0 and earlier) live in `CHANGELOG_FULL.md` — kept local, not part of this repo._

