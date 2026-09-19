# TxUI

![Version](https://img.shields.io/badge/version-1.0.0-blue)
![License](https://img.shields.io/badge/license-MIT-green)
![Platforms](https://img.shields.io/badge/platforms-macOS%20%C2%B7%20Windows%20%C2%B7%20Linux-lightgrey)
![Tauri](https://img.shields.io/badge/Tauri-2-ffc131?logo=tauri&logoColor=white)
![Rust](https://img.shields.io/badge/Rust-1.97.1-orange?logo=rust&logoColor=white)
![React](https://img.shields.io/badge/React-19-61dafb?logo=react&logoColor=white)
![MySQL](https://img.shields.io/badge/MySQL-4479A1?logo=mysql&logoColor=white "Tested: 8.0.46, 8.4.10 (also 8.0.29, 8.0.43-google)")
![MariaDB](https://img.shields.io/badge/MariaDB-003545?logo=mariadb&logoColor=white "Tested: 10.6.27, 10.11.18, 11.4.12, 11.8.8")
![Percona](https://img.shields.io/badge/Percona-F3701F "MySQL 8.0 drop-in - no separate fixture")
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-4169E1?logo=postgresql&logoColor=white "Tested: 14.23, 16.10 (md5), 17.10, 18.4 (TLS) + streaming standby")
![SQL Server](https://img.shields.io/badge/SQL%20Server-CC2927 "Tested: 2022 - 26 live tests")
![Redis](https://img.shields.io/badge/Redis-DC382D?logo=redis&logoColor=white "Tested: 8.10.0")
![ClickHouse](https://img.shields.io/badge/ClickHouse-E0A300?logo=clickhouse&logoColor=white "Tested: 26.7.2.59, 26.8")
![SQLite](https://img.shields.io/badge/SQLite-003B57?logo=sqlite&logoColor=white "Bundled 3.51.3 - reads any 3.x file")
![DuckDB](https://img.shields.io/badge/DuckDB-E5C100?logo=duckdb&logoColor=white "Bundled duckdb-rs (compiled in, pinned)")
![MongoDB](https://img.shields.io/badge/MongoDB-47A248?logo=mongodb&logoColor=white "Tested: 8.0 (8.0.29 fixture)")
![Parquet](https://img.shields.io/badge/Parquet-50ABF1?logo=apacheparquet&logoColor=white "File-format level - any parquet file")

**Intro with no AI bloat**

TxUI is something I've wanted for a long time: a go-to UI that actually fits how I work — at the office, at home, whenever.

The last few years have opened the floodgates to AI slop, half-finished projects, and dead ends. I'm trying to push back against that by leaning on my own experience — verifying things, cross-referencing, testing, and staying genuinely skeptical about what comes out the other end. The result is a fast, smooth querying experience with really good navigation inside the editor and plenty of advanced functionality under the hood. There are plugins for the everyday stuff too, plus a few things you won't find elsewhere: a "special open" for Dolphie files, map and graph views for geo-data, pivot tables, and more. AI models used along the way: Kimi, Claude, DeepSeek, and others.

The UI is built with high-privilege users in mind, so it covers pretty much everything an admin or DevOps engineer needs to do in the database space.

This is a hobby project — a one-man show, running on enthusiasm and no shortage of tokens.

Honestly, I think this version is perfectly usable as it stands right now (September 2026), and it can only get better from here. I'd love to hear your feedback, bug reports, and feature requests!

The name comes from my nickname — Tx is short for Tuxie, and also short for (database) transaction ;-)

Tuxie


![TxUI — SQL editor with a live result grid](docs/shots/05-editor-results.png)

## What it is

- **A fast, DBA-focused desktop database GUI** — Tauri 2 + Rust + React 19; native-speed core, ~40 MB bundle, ~100 MB idle RAM, cold start under a second.
- **Nine engines, one app** — MySQL / MariaDB / Percona, PostgreSQL, Redis, ClickHouse, SQLite, DuckDB, MongoDB, SQL Server, and Parquet files.
- **FastGrid** — one grid virtualized on both axes for every tabular surface; 60 fps at 1M rows, selection-aware copy/export in 6 formats.
- **A real SQL editor** — CodeMirror 6 with schema-aware, alias-aware completion that quotes what it inserts, hover docs, signature help, live squiggles (unknown column, JOIN without ON, WHERE-less write…).
- **Statement-at-caret execution** — multi-statement scripts with per-line timing, run-to-cursor, and drafts that survive a restart.
- **Processlist + kill** — live processlist with a long-query watchdog that detects, tracks and explains runaway queries; lock chains and a deadlock wait-for graph.
- **The DBA layer** — replication dashboard, server variables & status, interval monitor with sparklines, curated sys / performance_schema / pg_stat views.
- **Server tuner** — MySQLTuner-style health score with guided fixes, per engine (MySQL, PostgreSQL, ClickHouse, Redis, SQLite).
- **Query Store (SQL Server)** — plan history, regressions ranked by time wasted, side-by-side plans, one-click plan forcing.
- **EXPLAIN, visualized** — plan tree plus SQL Quality reports: lint, type audit, integer ceilings, guarded EXPLAIN ANALYZE.
- **GIS data on a real map** — MySQL spatial and PostGIS geometries decoded client-side (no `ST_AsGeoJSON` round trip, works on old servers too). The 📈 Graphics tab appears on **any result with rows, on every engine**: plot coordinates on a map with time-scrubbed track playback, or chart the result. The basemap is drawn locally by default — online tiles are a disclosed opt-in, because tile requests leak where your data is.
- **Dolphie replay recordings** — open a Dolphie `daemon.db` (SQLite) and TxUI recognizes it: not four opaque tables but a MySQL server as a time series — per-second processlist, global status, metadata locks, variable changes, ZSTD-dictionary decoded, read-only, with a Raw↔Replay toggle.
- **Schema tooling** — interactive ER diagram, schema/instance comparison with migration-script generation.
- **Data generator** — 76 generators with real distributions and chart-ready presets; server-side INSERT…SELECT up to a billion rows.
- **Fleet operations** — multi-server execution, immutable audit log, saved queries, query history.
- **Safety by default** — prod environment tags with row-count confirmations, server-side write guards, read-only enforced at the driver level, SSH tunnels, optional encrypted vault.
- **Same app on all three desktops** — native File · Edit · View · Tools · Help everywhere, SQLite compiled into the binary so a `.db` behaves identically everywhere.

## Tested versions

| Engine | Versions tested live |
| --- | --- |
| MySQL / Percona | 8.0.46, 8.4.10 (earlier: 8.0.29, 8.0.43-google, Cloud SQL MySQL 8.0) |
| MariaDB | 10.6.27, 10.11.18, 11.4.12, 11.8.8 |
| PostgreSQL | 14.23, 16.10 (md5 auth), 17.10, 18.4 (TLS) + 18.4 streaming standby |
| Redis | 8.10.0 |
| ClickHouse | 26.7.2.59, 26.8 |
| SQLite | 3.51.3 (bundled; reads any 3.x file) |
| DuckDB | bundled duckdb-rs (compiled in, pinned) |
| MongoDB | 8.0 (8.0.29 fixture) |
| SQL Server | 2022 (26 live tests) |
| Parquet | file-format level (any parquet file) |

## Develop

```bash
npm install                      # once
cd src-tauri && cargo tauri dev  # hot-reload dev app
```

## Verify

```bash
npx tsc --noEmit -p tsconfig.app.json   # typecheck (the -p is NOT optional)
npm run lint && npm run build
npm test                                # unit tests — needs Node ≥ 23 (type stripping)
cd src-tauri && cargo test --lib        # backend unit tests
```

## Release builds

- **Mac build info**: I'm not an Apple developer, not keen to pay $99 per year -> the
  macOS app is ad-hoc signed and not notarized, so Gatekeeper refuses to open
  it the first time. Two ways past it:

  - **Right-click way** (no terminal, once per copy): in Finder,
    **Control-click** (or right-click) `TxUI.app` → **Open** → confirm **Open**
    in the dialog. Gatekeeper remembers this for that copy of the app.

  - **CLI way** (strips the quarantine flag): copy the app to `/Applications`,
    then run:

    ```bash
    xattr -cr /Applications/TxUI.app
    ```

    That removes the `com.apple.quarantine` attribute the download stamped on
    it, so it launches like any other app.
- **CI** (Actions → release): push a `v*.*.*` tag → macOS (universal), Linux
  (AppImage/deb) and Windows (NSIS/MSI), drafted as a GitHub Release.
- **Local**: `crossbuild/build_linux.sh` here, `build_macos.sh` on the Mac,
  `build_windows.sh` cross-builds Windows from either.

Internal design docs are kept out of this repository by design.
