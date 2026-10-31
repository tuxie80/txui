# TxUI

![Version](https://img.shields.io/badge/version-1.5.0-blue)
![License](https://img.shields.io/badge/license-MIT-green)
![Platforms](https://img.shields.io/badge/platforms-macOS%20%C2%B7%20Windows%20%C2%B7%20Linux-lightgrey)
![Tauri](https://img.shields.io/badge/Tauri-2-ffc131?logo=tauri&logoColor=white)
![Rust](https://img.shields.io/badge/Rust-1.97.1-orange?logo=rust&logoColor=white)
![React](https://img.shields.io/badge/React-19-61dafb?logo=react&logoColor=white)
[![Built with Kimi](https://img.shields.io/badge/Built%20with-Kimi-1783FF?logo=data:image/svg+xml;base64,PHN2ZyBmaWxsPSJ3aGl0ZSIgZmlsbC1ydWxlPSJldmVub2RkIiBoZWlnaHQ9IjFlbSIgc3R5bGU9ImZsZXg6bm9uZTtsaW5lLWhlaWdodDoxIiB2aWV3Qm94PSIwIDAgMjQgMjQiIHdpZHRoPSIxZW0iIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+PHRpdGxlPktpbWk8L3RpdGxlPjxwYXRoIGQ9Ik0yMS44NDYgMGExLjkyMyAxLjkyMyAwIDExMCAzLjg0NkgyMC4xNWEuMjI2LjIyNiAwIDAxLS4yMjctLjIyNlYxLjkyM0MxOS45MjMuODYxIDIwLjc4NCAwIDIxLjg0NiAweiI+PC9wYXRoPjxwYXRoIGQ9Ik0xMS4wNjUgMTEuMTk5bDcuMjU3LTcuMmMuMTM3LS4xMzYuMDYtLjQxLS4xMTYtLjQxSDE0LjNhLjE2NC4xNjQgMCAwMC0uMTE3LjA1MWwtNy44MiA3Ljc1NmMtLjEyMi4xMi0uMzAyLjAxMy0uMzAyLS4xNzlWMy44MmMwLS4xMjctLjA4My0uMjMtLjE4NS0uMjNIMy4xODZjLS4xMDMgMC0uMTg2LjEwMy0uMTg2LjIzVjE5Ljc3YzAgLjEyOC4wODMuMjMuMTg2LjIzaDIuNjljLjEwMyAwIC4xODYtLjEwMi4xODYtLjIzdi0zLjI1YzAtLjA2OS4wMjUtLjEzNS4wNjktLjE3OGwyLjQyNC0yLjQwNmEuMTU4LjE1OCAwIDAxLjIwNS0uMDIzbDYuNDg0IDQuNzcyYTcuNjc3IDcuNjc3IDAgMDAzLjQ1MyAxLjI4M2MuMTA4LjAxMi4yLS4wOTUuMi0uMjN2LTMuMDZjMC0uMTE3LS4wNy0uMjEyLS4xNjQtLjIyN2E1LjAyOCA1LjAyOCAwIDAxLTIuMDI3LS44MDdsLTUuNjEzLTQuMDY0Yy0uMTE3LS4wNzgtLjEzMi0uMjc5LS4wMjgtLjM4MXoiPjwvcGF0aD48L3N2Zz4=)](https://www.kimi.com/)

![MySQL](https://img.shields.io/badge/MySQL-4479A1?logo=mysql&logoColor=white "Tested: 8.0.46, 8.4.10 (also 8.0.29, 8.0.43-google)")
![MariaDB](https://img.shields.io/badge/MariaDB-003545?logo=mariadb&logoColor=white "Tested: 10.6.27, 10.11.18, 11.4.12, 11.8.8")
![Percona](https://img.shields.io/badge/Percona-F3701F "MySQL 8.0 drop-in - no separate fixture")
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-4169E1?logo=postgresql&logoColor=white "Tested: 14.23, 16.10 (md5), 17.10, 18.4 (TLS) + streaming standby")
![SQL Server](https://img.shields.io/badge/SQL%20Server-CC2927 "Tested: 2022 - 29 live tests")
![Redis](https://img.shields.io/badge/Redis-DC382D?logo=redis&logoColor=white "Tested: 8.10.0")
![ClickHouse](https://img.shields.io/badge/ClickHouse-E0A300?logo=clickhouse&logoColor=white "Tested: 26.7.2.59, 26.8")
![SQLite](https://img.shields.io/badge/SQLite-003B57?logo=sqlite&logoColor=white "Bundled 3.51.3 - reads any 3.x file")
![DuckDB](https://img.shields.io/badge/DuckDB%202.0-E5C100?logo=duckdb&logoColor=white "Bundled duckdb-rs 1.20000.1 (compiled in, pinned)")
![MongoDB](https://img.shields.io/badge/MongoDB-47A248?logo=mongodb&logoColor=white "Tested: 8.0 (8.0.29 fixture)")
![Parquet](https://img.shields.io/badge/Parquet-50ABF1?logo=apacheparquet&logoColor=white "File-format level - any parquet file")

**A fast, DBA-focused desktop database GUI.** Tauri 2 + Rust + React 19. No server component; database work stays local by default, and optional external integrations are explicit.

**Website: [tuxie.eu/txui](https://tuxie.eu/txui/)**

![TxUI watching a live ALTER TABLE through all seven InnoDB phases](docs/user-guide/screenshots/dark/15-mysql-progress-full.png)

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
- **Self-update**: built in — status-bar chip, restart to apply
- **macOS first open (important)**: the build is ad-hoc signed — no $99 Apple Developer ID — so Gatekeeper may say *"TxUI is damaged"* or *"unidentified developer"* on the first launch. **Do not move the app to Trash.** Copy it to `/Applications`, then use either fix once:
  - right-click the app → **Open** → **Open** in the dialog, or
  - run `xattr -cr /Applications/TxUI.app` in Terminal, then open TxUI normally.

  (The one-liner installer and Homebrew already strip the quarantine flag — this applies to a manual DMG download.)

## Documentation

- [User guide and complete reference](https://tuxie.eu/txui/docs/)
- [Development documentation](https://tuxie.eu/txui/dev/)

## Engines and highlights

- **MySQL / MariaDB / Percona** — full DBA tooling, process/thread progress, replication, Galera and Group Replication dashboards, maintenance, routines and playground scenarios.
- **PostgreSQL** — workload investigations correlating statement deltas, waits and incidents; graphical plans, LISTEN/NOTIFY, COPY, routines, vacuum/bloat and replication tools.
- **Redis** — standalone, Cluster and Sentinel connections; MOVED/ASK routing, cluster-wide scans, master discovery and failover rediscovery; key browser, audits and tuner.
- **ClickHouse** — HTTP SQL sessions, allowlisted session settings, `system.*` DBA views, dictionary editing, tuner and Geo types.
- **DuckDB 2.0** — local files and `:memory:`, explicit file creation, spatial support, plus authenticated **Quack remote** connections with TLS fingerprint pinning and cancellation.
- **SQL Server** — T-SQL editor and full DBA tooling, including Query Store plan history, regression ranking and plan forcing.
- **SQLite and Parquet** — full local SQL on SQLite; deep read-only Parquet file/dataset inspection, page indexes, nested data and GeoParquet.
- **MongoDB** — deliberately scoped: database/collection tree, find editor, aggregation, explain, JSON grid and GeoJSON.

## What you get

- **FastGrid** — one grid, virtualized both axes; 60 fps at 1M rows; precise selection, filtering, aggregates and charts; copy/export in 6+ formats including real `.xlsx` and GeoParquet.
- **Real SQL editor** — CodeMirror 6 with schema-aware completion, quoting, hover, signature help, live diagnostics, formatter profiles, minimap, split editing and a configurable caret.
- **Reliable statement execution** — statement-at-caret and run-to-cursor, exact per-statement wall times in results and gutter markers, timing proofs that survive unrelated edits, and drafts that survive restarts.
- **TxShell** — typed pipelines, connection fan-out, file input/output, captured-result diffs with typed keys, and bounded `$(…)` command substitution.
- **SQL Quality and plans** — static lint, type audits, schema review, graphical EXPLAIN and guarded EXPLAIN ANALYZE; **Change review** checks MySQL/MariaDB/PostgreSQL migrations for type, nullability, index/FK, cascade and lock/rebuild risks.
- **DBA layer** — processlist + kill, on-demand thread progress, lock chains, deadlock graphs, replication, variables/status, monitor with sparklines and 230+ curated DBA views.
- **Workload analysis** — PostgreSQL baseline/after investigations combine statement deltas, optional wait samples and retained incidents without an always-on collector.
- **Server tuner** — per-engine rule packs with health scores and generated, never-executed fixes.
- **Geospatial, end to end** — WKB/EWKB/GeoPackage/SpatiaLite decoding, offline and optional online maps, PostGIS transforms, SQL Server geo, MongoDB GeoJSON, ClickHouse geo, Redis GEO and GeoParquet.
- **Schema tooling** — ER diagrams, schema/data/result/script compare, reviewed migration scripts, documenter, routines, table designer and virtual foreign keys.
- **Data in and out** — CSV/spreadsheet import, native PostgreSQL COPY, a deterministic data generator with schema kits and uniqueness controls, and dump/restore wrappers.
- **Fleet operations** — multi-server execution, replica-set and fleet checks, immutable audit log, query history, saved queries and incident timelines.
- **Safety by default** — production confirmations and server-side hard limits, dialect-aware write guards in Rust, driver-level read-only enforcement, SSH tunnels and an optional encrypted Safe Vault.
- **One app on all three desktops** — native menus and the same behavior on macOS, Windows and Linux.

## Tested versions

| Engine | Versions tested live |
| --- | --- |
| MySQL / Percona | 8.0.46, 8.4.10 (earlier: 8.0.29, 8.0.43-google, Cloud SQL 8.0) |
| MariaDB | 10.6.27, 10.11.18, 11.4.12, 11.8.8 |
| PostgreSQL | 14.23, 16.10 (md5), 17.10, 18.4 (TLS) + streaming standby |
| Redis | 8.10.0; Cluster and Sentinel failover fixtures |
| ClickHouse | 26.7.2.59, 26.8 |
| SQLite | 3.51.3 (bundled; reads any 3.x file) |
| DuckDB | 2.0 through bundled duckdb-rs 1.20000.1; local and two-process Quack checks |
| MongoDB | 8.0 (8.0.29 fixture) |
| SQL Server | 2022 (29 live tests) |
| Parquet | file-format level (any Parquet file) |

## Why it exists

*From the author:* TxUI is something I've wanted for a long time — a go-to UI that actually fits how I work. Built for high-privilege users: admins and DevOps who live in databases.

**Kimi was used almost exclusively as the AI coding model throughout development. Database queries and their tuning are my own work.** Every feature is reviewed, cross-referenced and tested; AI assistance does not replace verification. It remains a one-man hobby project, running on enthusiasm and no shortage of tokens. Feedback, bugs and feature requests are welcome!

*The name: Tx = Tuxie (my nickname), and also (database) transaction ;-)*
