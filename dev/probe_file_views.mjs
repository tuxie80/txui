// Dump the SQLite DBA views to /tmp/txui_views.json for the Rust harness.
//
// The views live in TypeScript and the database is opened by Rust, so
// something has to carry the SQL across. This is that something: it writes
// the views out, and `cargo test -- --ignored every_sqlite_dba_view_runs`
// executes each one through the *bundled* SQLite — the same library the app
// uses, which is the only version whose answer counts.
//
// Running them here through the `sqlite3` CLI instead would prove the wrong
// thing: the CLI is whatever the OS ships (3.51 on this Mac), while the app
// carries its own (3.46 via libsqlite3-sys). A view using a pragma or
// table-valued function newer than the bundled library would pass here and
// fail in the app.
//
//   node --experimental-strip-types dev/probe_file_views.mjs
//   (cd src-tauri && cargo test --lib -- --ignored every_sqlite_dba_view_runs --nocapture)
import { writeFileSync } from 'node:fs';
import { DBA_VIEWS } from '../src/utils/dbaViews.ts';

const out = { sqlite: (DBA_VIEWS.sqlite ?? []).map(v => ({ id: v.id, sql: v.sql, label: v.label })) };
writeFileSync('/tmp/txui_views.json', JSON.stringify(out, null, 2));
console.log(`wrote /tmp/txui_views.json — ${out.sqlite.length} SQLite views`);
