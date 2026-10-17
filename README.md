# TxUI

![Version](https://img.shields.io/badge/version-1.3.0-blue)
![License](https://img.shields.io/badge/license-MIT-green)
![Platforms](https://img.shields.io/badge/platforms-macOS%20%C2%B7%20Windows%20%C2%B7%20Linux-lightgrey)
![Tauri](https://img.shields.io/badge/Tauri-2-ffc131?logo=tauri&logoColor=white)
![Rust](https://img.shields.io/badge/Rust-1.97.1-orange?logo=rust&logoColor=white)
![React](https://img.shields.io/badge/React-19-61dafb?logo=react&logoColor=white)
![MySQL](https://img.shields.io/badge/MySQL-4479A1?logo=mysql&logoColor=white "Tested: 8.0.46, 8.4.10 (also 8.0.29, 8.0.43-google)")
![MariaDB](https://img.shields.io/badge/MariaDB-003545?logo=mariadb&logoColor=white "Tested: 10.6.27, 10.11.18, 11.4.12, 11.8.8")
![Percona](https://img.shields.io/badge/Percona-F3701F "MySQL 8.0 drop-in - no separate fixture")
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-4169E1?logo=postgresql&logoColor=white "Tested: 14.23, 16.10 (md5), 17.10, 18.4 (TLS) + streaming standby")
![SQL Server](https://img.shields.io/badge/SQL%20Server-CC2927 "Tested: 2022 - 29 live tests")
![Redis](https://img.shields.io/badge/Redis-DC382D?logo=redis&logoColor=white "Tested: 8.10.0")
![ClickHouse](https://img.shields.io/badge/ClickHouse-E0A300?logo=clickhouse&logoColor=white "Tested: 26.7.2.59, 26.8")
![SQLite](https://img.shields.io/badge/SQLite-003B57?logo=sqlite&logoColor=white "Bundled 3.51.3 - reads any 3.x file")
![DuckDB](https://img.shields.io/badge/DuckDB-E5C100?logo=duckdb&logoColor=white "Bundled duckdb-rs (compiled in, pinned)")
![MongoDB](https://img.shields.io/badge/MongoDB-47A248?logo=mongodb&logoColor=white "Tested: 8.0 (8.0.29 fixture)")
![Parquet](https://img.shields.io/badge/Parquet-50ABF1?logo=apacheparquet&logoColor=white "File-format level - any parquet file")

**A fast, DBA-focused desktop database GUI.** Tauri 2 + Rust + React 19. No server, no cloud — nothing leaves the machine.

## Install

**macOS · Linux** — one-liner (checksum-verified, quarantine handled):

```bash
curl -fsSL https://tuxie.eu/txui/install.sh | bash
```

**macOS — Homebrew:**

```bash
brew install --cask tuxie80/tap/txui
```

- **Windows**: NSIS setup / MSI from the [latest release](https://github.com/tuxie80/txui/releases/latest)
- **Older versions**: every release stays on the [releases page](https://github.com/tuxie80/txui/releases)
- **Self-update**: built in — status-bar chip, restart to apply
- macOS is ad-hoc signed (no $99 Apple tax): first open = right-click → Open, or `xattr -cr /Applications/TxUI.app`

**Docs**: [tuxie.eu/txui/docs](https://tuxie.eu/txui/docs/) · [older versions](https://tuxie.eu/txui/docs-archive/) · [unreleased main](https://tuxie.eu/txui/dev/)

## Engines

MySQL / MariaDB / Percona · PostgreSQL · Redis · ClickHouse · SQLite · DuckDB · MongoDB · SQL Server · Parquet files

## What you get

- **FastGrid** — one grid, virtualized both axes; 60 fps at 1M rows; copy/export in 6+ formats (incl. real .xlsx, GeoParquet)
- **Real SQL editor** — CodeMirror 6; schema-aware completion that quotes what it inserts; hover, signature help, live squiggles; formatter profiles; minimap
- **Statement-at-caret runs** — per-statement timing, run-to-cursor, drafts survive restarts, big results stream in pages
- **Geospatial, end to end** — WKB/EWKB/GeoPackage/SpatiaLite decoded client-side; map view on an offline basemap; PostGIS "View in WGS 84"; SQL Server "View as geo"; MongoDB GeoJSON, ClickHouse geo, Redis GEO — all drawable
- **DBA layer** — processlist + kill, lock chains, deadlock graphs, replication, variables/status, monitor with sparklines, 230+ curated DBA views
- **Server tuner** — per-engine rule packs (MySQL, PG, ClickHouse, Redis, SQLite, SQL Server) with health score and generated, never-executed fixes
- **Query Store (SQL Server)** — plan history, regression ranking, plan forcing; EXPLAIN visualized everywhere else, guarded EXPLAIN ANALYZE
- **Schema tooling** — ER diagrams, schema/data compare with migration scripts, documenter (Markdown/HTML + Mermaid)
- **Data in and out** — CSV import wizard (transactional, cancellable; native PG COPY; ClickHouse batches), data generator (schema kits, distributions, up to 10M rows), dump/restore wrappers
- **Fleet ops** — multi-server execution, immutable audit log, query history, saved queries
- **Safety by default** — prod tags with typed confirmations + server-side hard limits, dialect-aware write guard enforced in Rust, read-only at the driver level, SSH tunnels, optional encrypted vault
- **Extras** — Redis browser (console, key TTLs, Sentinel), ClickHouse dictionary editor, PG LISTEN/NOTIFY, Dolphie replay files, TxShell typed pipelines, pivot/charts on any result
- **Same app on all three desktops** — one behavior, native menus everywhere

## Tested versions

| Engine | Versions tested live |
| --- | --- |
| MySQL / Percona | 8.0.46, 8.4.10 (earlier: 8.0.29, 8.0.43-google, Cloud SQL 8.0) |
| MariaDB | 10.6.27, 10.11.18, 11.4.12, 11.8.8 |
| PostgreSQL | 14.23, 16.10 (md5), 17.10, 18.4 (TLS) + streaming standby |
| Redis | 8.10.0 |
| ClickHouse | 26.7.2.59, 26.8 |
| SQLite | 3.51.3 (bundled; reads any 3.x file) |
| DuckDB | bundled duckdb-rs (compiled in, pinned) |
| MongoDB | 8.0 (8.0.29 fixture) |
| SQL Server | 2022 (29 live tests) |
| Parquet | file-format level (any parquet file) |

## Why it exists

*From the author:* TxUI is something I've wanted for a long time — a go-to UI that actually fits how I work. No AI slop, no half-finished dead ends: verified, cross-referenced, tested. Built for high-privilege users — admins and DevOps who live in databases. A one-man hobby show, running on enthusiasm and no shortage of tokens. Feedback, bugs and feature requests welcome!

*The name: Tx = Tuxie (my nickname), and also (database) transaction ;-)*

![TxUI — SQL editor with a live result grid](docs/shots/05-editor-results.png)

## Develop

```bash
npm install                      # once
cd src-tauri && cargo tauri dev  # hot-reload dev app
```

```bash
npx tsc --noEmit -p tsconfig.app.json   # typecheck (the -p is NOT optional)
npm run lint && npm run build
npm test                                # 4,746 unit tests — needs Node ≥ 23 (type stripping)
cd src-tauri && cargo test --lib        # 866 backend unit tests
```

## Release builds

- **CI**: push a `v*.*.*` tag → macOS (universal), Linux (AppImage/deb/rpm), Windows (NSIS/MSI), drafted as a GitHub Release
- **Local**: `crossbuild/build_macos.sh` on the Mac, `build_linux.sh` on Linux, `build_windows.sh` cross-builds from either

Internal design docs are kept out of this repository by design.
