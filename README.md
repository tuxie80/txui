# TxUI

![Version](https://img.shields.io/badge/version-0.65.0-blue)
![License](https://img.shields.io/badge/license-MIT-green)
![Platforms](https://img.shields.io/badge/platforms-macOS%20%C2%B7%20Windows%20%C2%B7%20Linux-lightgrey)
![Tauri](https://img.shields.io/badge/Tauri-2-ffc131?logo=tauri&logoColor=white)
![Rust](https://img.shields.io/badge/Rust-1.97.1-orange?logo=rust&logoColor=white)
![React](https://img.shields.io/badge/React-19-61dafb?logo=react&logoColor=white)

Fast, DBA-focused desktop database GUI — **Tauri 2 + Rust + React 19**.
MySQL / MariaDB / Percona · PostgreSQL · Redis · ClickHouse · SQLite · DuckDB · MongoDB · SQL Server · Parquet.

Starts in under a second, shows you the processlist: virtualized 1M-row grid,
schema-aware SQL editor, processlist + kill, replication, EXPLAIN plans, server
tuner, schema compare, data generator, audit log.

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

- **CI** (`.github/workflows/release.yml`): push a `v*.*.*` tag → builds macOS
  (universal), Linux (AppImage/deb) and Windows (NSIS/MSI), drafts a GitHub Release.
- **Local**: `crossbuild/build_linux.sh` here, `build_macos.sh` on the Mac,
  `build_windows.sh` cross-builds Windows from either.

Internal design docs are kept out of this repository by design.
