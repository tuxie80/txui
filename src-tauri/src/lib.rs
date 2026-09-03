pub mod apperror;
pub mod db;
mod history;
pub mod redisguard;
pub mod sqlguard;
pub mod sync;
pub mod txshell;
pub mod state;
pub mod storage;
pub mod instancedata;
pub mod sqlfile;
pub mod importconv;
pub mod secretstore;
pub mod tuner;
mod commands;

use commands::{ai::*, connections::*, connimport::*, gsheets::*, query::*, schema::*, history::*, browser::*, redis_browser::*, mongo::*, export::*, ops::*, multi_exec::*, saved::*, secrets::*, templates::*, theme::*, import::*, quality::*, audit::*, dump::*, datagen::*, watch::*, kill::*, playground::*, metrics::*, srvlog::*, tuner::*, sqlite::*, ssh::*, routines::*, shell::*, instdata::*, sqlfile::*, pgcopy::*, pglisten::*, pgwait::*};
use state::AppState;
use tauri::Manager;
use tauri::Emitter;
use tauri::menu::{CheckMenuItem, CheckMenuItemBuilder, MenuBuilder, SubmenuBuilder, MenuItemBuilder, IconMenuItemBuilder};

/// The theme menu's check items, so the tick can follow the active theme.
pub struct ThemeMenu(pub std::sync::Mutex<Vec<tauri::menu::CheckMenuItem<tauri::Wry>>>);

/**
 * Give the OS toolkit the app's light/dark scheme before any GUI toolkit
 * initializes.
 *
 * WebKitGTK renders native popups — select dropdowns, file dialogs — with the
 * GTK theme, which page CSS (even `color-scheme`) cannot reach: a dark app
 * theme still popped a white database list. GTK reads `GTK_THEME` once, at
 * init — long before the frontend can report the theme — so the scheme chosen
 * last run is persisted in `theme-scheme` in the data dir (written by
 * `set_active_theme`) and applied here. A changed scheme therefore takes full
 * effect on the next launch; in-page controls already follow instantly via
 * `color-scheme`.
 *
 * No platform branch: the variable is simply never read where GTK does not
 * exist (macOS/Windows), and an explicit `GTK_THEME` from the user's own
 * environment always wins. "dark" is also the no-file default because
 * txui-dark is the app's default theme.
 */
pub fn apply_toolkit_theme() {
    if std::env::var_os("GTK_THEME").is_some() {
        return;
    }
    let scheme = std::fs::read_to_string(storage::default_data_dir().join("theme-scheme"))
        .unwrap_or_else(|_| "dark".into());
    if scheme.trim() == "dark" {
        std::env::set_var("GTK_THEME", "Adwaita:dark");
    }
}

/// Startup stopwatch, printed only when `TXUI_TRACE_STARTUP=1` is set.
///
/// Startup cost is the kind of thing that is argued about and never measured:
/// the frontend does its real work in tens of milliseconds and then waits on a
/// deliberate splash floor, while the Rust side opens SQLite and builds a menu
/// of ~90 items before the webview exists at all. Guessing which half is slow
/// gets it wrong. Off by default and free when off — one env lookup.
pub struct Boot {
    t0: std::time::Instant,
    last: std::time::Instant,
    on: bool,
}

/// Set from `main()` before anything else, so the trace can show how much of
/// startup is spent before `setup` is even reached (process exec, Tauri init).
pub static PROC_START: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();

impl Boot {
    pub fn start() -> Self {
        let on = std::env::var("TXUI_TRACE_STARTUP").is_ok_and(|v| v != "0");
        let now = std::time::Instant::now();
        let t0 = *PROC_START.get_or_init(|| now);
        if on {
            eprintln!("[boot] tracing startup (TXUI_TRACE_STARTUP)");
        }
        Self { t0, last: t0, on }
    }
    /// Time since the previous mark, and since process start.
    pub fn mark(&mut self, what: &str) {
        if !self.on { return; }
        let now = std::time::Instant::now();
        eprintln!(
            "[boot] {:>7.1} ms  (+{:>6.1})  {what}",
            self.t0.elapsed().as_secs_f64() * 1000.0,
            (now - self.last).as_secs_f64() * 1000.0,
        );
        self.last = now;
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // History DB is opened during setup once we know the app data dir.
    // We create a placeholder and swap it in via a once-cell pattern.
    tauri::Builder::default()
        // No updater: plugin, commands and banner were removed together — see
        // CHANGELOG; reintroduce all three plus real signing keys to re-enable.
        .plugin(tauri_plugin_dialog::init())
        // OS notifications: "long query finished" pings when the window is
        // unfocused (utils/notify.ts decides WHEN, this just delivers).
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            let mut boot = Boot::start();
            boot.mark("tauri builder → setup entered");
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            // Resolve data directory and open history SQLite. Neither may
            // panic: a failure here happens before any window exists, so the
            // app would just vanish. Degrade instead and tell the user once
            // the window is up.
            let (data_dir, data_dir_err) = match app.handle().path().app_data_dir() {
                Ok(dir) => (dir, None),
                Err(e) => {
                    log::error!("could not resolve app data dir: {e}");
                    (std::env::temp_dir().join("com.dbgui.app"),
                     Some(format!("Could not resolve the app data directory ({e}). \
                                   Running out of a temporary directory — settings and history will not persist.")))
                }
            };
            std::fs::create_dir_all(&data_dir)?;
            boot.mark("data dir resolved + created");

            let (history_store, history_err) = match tauri::async_runtime::block_on(
                history::open(&data_dir)
            ) {
                Ok(s) => (s, None),
                Err(e) => {
                    // Corrupt file, stale WAL from a crashed second instance…
                    // — run with an in-memory store (history/audit work but do
                    // not persist) rather than dying wordlessly.
                    log::error!("could not open history database: {e:#}");
                    let mem = tauri::async_runtime::block_on(history::open_in_memory())
                        .expect("in-memory SQLite must open");
                    (mem, Some(format!(
                        "Could not open the history database ({e:#}). \
                         Query history and the audit log will not persist this session. \
                         Check {} for a corrupt history.db or a stale history.db-wal.",
                        data_dir.display())))
                }
            };

            boot.mark("history.db opened + migrated");

            // Deferred degradation notice: shown once a window can exist so
            // it lands in front of the user, not before the app has a face.
            if data_dir_err.is_some() || history_err.is_some() {
                let msg = [data_dir_err, history_err].into_iter().flatten()
                    .collect::<Vec<_>>().join("\n\n");
                let dialog_handle = app.handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_secs(2));
                    use tauri_plugin_dialog::DialogExt;
                    dialog_handle.dialog()
                        .message(msg)
                        .title("TxUI started in degraded mode")
                        .show(|_| {});
                });
            }

            // Load persisted connection configs (empty map on first run)
            let configs = storage::load(&data_dir).unwrap_or_else(|_| {
                // Expected on every start: the vault is locked until the user
                // enters the password, and the gate takes it from here. Not a
                // warning, and definitely not about connections.json.
                log::info!("vault is locked; waiting for the password before loading connections");
                Default::default()
            });

            boot.mark("connection configs loaded");

            app.handle().manage(AppState::new(history_store, data_dir, configs));
            boot.mark("AppState managed");

            // The window starts hidden (tauri.conf.json "visible": false) so the
            // OS never presents a bare white native frame or the maximize/center
            // shuffle; the frontend shows it once the app has painted. This is
            // the wedged-app safety net: if 5 s pass and nothing showed the
            // window, show whatever is there rather than leave a running
            // process with no window at all.
            let reveal_handle = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_secs(5));
                if let Some(win) = reveal_handle.get_webview_window("main") {
                    if !win.is_visible().unwrap_or(true) {
                        let _ = win.show();
                    }
                }
            });

            // The menu is shaped per platform, because the conventions genuinely
            // differ rather than merely looking different.
            //
            // macOS: the FIRST submenu becomes the application menu — bold,
            // named after the app — and About / Settings / Quit belong in it.
            // Windows and Linux have no such thing: the same structure renders
            // as a literal "TxUI" menu with no File menu anywhere, and Quit
            // nowhere near where anyone looks for it (File → Exit).
            let about = MenuItemBuilder::with_id("about", "About TxUI").build(app)?;
            let settings = MenuItemBuilder::with_id("settings", "Settings…")
                .accelerator("CmdOrCtrl+,")
                .build(app)?;

            // On macOS the first submenu IS the application menu, and About /
            // Settings / Quit belong there by convention. That is where they
            // stay — but it used to be the *only* place, which left macOS with
            // no File menu at all. A File menu is not a macOS-less idea; the
            // platform simply puts a few specific items elsewhere.
            #[cfg(target_os = "macos")]
            let app_menu = SubmenuBuilder::new(app, "TxUI")
                .item(&about)
                .separator()
                .item(&settings)
                .separator()
                .quit()
                .build()?;

            // ── File ────────────────────────────────────────────────────────
            // Every item here emits an event the frontend already understands
            // or one added alongside it; nothing in this menu is decorative.
            //
            // Settings and Exit appear only off macOS, where the app menu does
            // not exist to hold them. `.quit()` renders as the platform's own
            // wording, so it reads "Exit" on Windows without hardcoding it.
            let f_new_conn = MenuItemBuilder::with_id("file:new-connection", "New Connection…")
                .accelerator("CmdOrCtrl+Shift+N").build(app)?;
            let f_new_tab = MenuItemBuilder::with_id("file:new-tab", "New Query Tab")
                .accelerator("CmdOrCtrl+T").build(app)?;
            let f_open = MenuItemBuilder::with_id("file:open-sql", "Open SQL File…")
                .accelerator("CmdOrCtrl+O").build(app)?;
            // Save writes back to the file the tab is bound to; Save As always
            // asks. Until the open handler kept the path there was only one of
            // these, and ⌘S re-prompted on every save.
            let f_save = MenuItemBuilder::with_id("file:save-sql", "Save SQL")
                .accelerator("CmdOrCtrl+S").build(app)?;
            let f_save_as = MenuItemBuilder::with_id("file:save-sql-as", "Save SQL As…")
                .accelerator("CmdOrCtrl+Shift+S").build(app)?;
            let f_export = MenuItemBuilder::with_id("file:export", "Export Results…")
                .accelerator("CmdOrCtrl+Shift+E").build(app)?;
            let f_close_tab = MenuItemBuilder::with_id("file:close-tab", "Close Tab")
                .accelerator("CmdOrCtrl+W").build(app)?;
            let f_close_session = MenuItemBuilder::with_id("file:close-session", "Close Connection")
                .build(app)?;

            let file_menu = {
                let b = SubmenuBuilder::new(app, "File")
                    .item(&f_new_conn)
                    .item(&f_new_tab)
                    .separator()
                    .item(&f_open)
                    .item(&f_save)
                    .item(&f_save_as)
                    .item(&f_export)
                    .separator()
                    .item(&f_close_tab)
                    .item(&f_close_session);
                #[cfg(not(target_os = "macos"))]
                let b = b.separator().item(&settings).separator().quit();
                b.build()?
            };
            let edit_menu = SubmenuBuilder::new(app, "Edit")
                .undo().redo().separator().cut().copy().paste().select_all()
                .build()?;

            // View → Theme: standardized color schemes (mirrors utils/themes.ts).
            // Selecting one emits `dbgui:set-theme <id>` to the frontend.
            const DARK_THEMES: &[(&str, &str)] = &[
                ("txui-dark", "TxUI Dark"), ("one-dark", "One Dark"), ("dracula", "Dracula"),
                ("nord", "Nord"), ("gruvbox-dark", "Gruvbox Dark"), ("monokai", "Monokai"),
                ("solarized-dark", "Solarized Dark"), ("tomorrow-night", "Tomorrow Night"),
                ("tokyo-night", "Tokyo Night"), ("github-dark", "GitHub Dark"), ("ayu-dark", "Ayu Dark"),
            ];
            const LIGHT_THEMES: &[(&str, &str)] = &[
                ("solarized-light", "Solarized Light"), ("github-light", "GitHub Light"),
                ("one-light", "One Light"), ("ayu-light", "Ayu Light"),
            ];
            // Check items, not plain ones: a list of fifteen themes with no
            // mark on the current one gives no way to tell what you are
            // looking at. The frontend owns the choice (localStorage), so it
            // reports it via `set_active_theme` at startup and on change.
            let build_checks = |themes: &[(&str, &str)]| -> tauri::Result<Vec<CheckMenuItem<_>>> {
                themes.iter()
                    .map(|(id, name)| {
                        CheckMenuItemBuilder::with_id(format!("theme:{}", id), *name)
                            .checked(false)
                            .build(app)
                    })
                    .collect()
            };
            let dark_items = build_checks(DARK_THEMES)?;
            let light_items = build_checks(LIGHT_THEMES)?;
            let mut tb = SubmenuBuilder::new(app, "Theme");
            for it in &dark_items { tb = tb.item(it); }
            tb = tb.separator();
            for it in &light_items { tb = tb.item(it); }
            let theme_menu = tb.build()?;
            // Kept so the tick can be moved when the theme changes.
            let all_theme_items: Vec<CheckMenuItem<_>> =
                dark_items.iter().chain(light_items.iter()).cloned().collect();
            app.handle().manage(ThemeMenu(std::sync::Mutex::new(all_theme_items)));
            let wrap_item = MenuItemBuilder::with_id("wrap", "Toggle Word Wrap")
                .accelerator("Alt+Z")
                .build(app)?;
            let copyhdr_item = MenuItemBuilder::with_id("copyheaders", "Toggle Copy With Headers")
                .accelerator("Shift+CmdOrCtrl+H")
                .build(app)?;
            // Zen mode: the accelerator matches the frontend's Mod-Alt-0
            // fallback chord (App.tsx); both paths land on the same toggle.
            let zen_item = MenuItemBuilder::with_id("zen", "Zen Mode")
                .accelerator("CmdOrCtrl+Alt+0")
                .build(app)?;
            let view_menu = SubmenuBuilder::new(app, "View")
                .item(&wrap_item)
                .item(&copyhdr_item)
                .item(&zen_item)
                .separator()
                .item(&theme_menu)
                .build()?;


            // ── Tools ───────────────────────────────────────────────────────
            // Every plugin, by name, in one place — grouped into the same
            // seven submenus (Activity / Insights / Server / Schema / Data /
            // Find & Compare / SQL) the frontend plugin bar uses
            // (utils/pluginMenu.ts — PLUGIN_MENU). The plugin bar along the
            // tab strip is a row of unlabelled glyphs — fine once you know
            // them, useless the first week — and several panels were reachable
            // only from there. A menu is the one surface a user is entitled to
            // assume lists everything.
            //
            // Each item emits the panel id; the frontend opens it exactly as a
            // click on the bar would, so a panel already open is focused rather
            // than duplicated (utils/tabModel.panelToggle).
            //
            // The list is duplicated from PANEL_META in the frontend — Tauri
            // builds menus in Rust at startup, so there is nowhere shared to
            // put it. `tests/toolsMenu.test.ts` asserts the two agree, because
            // a menu that silently lacks a plugin is exactly the drift this
            // menu exists to fix.
            //
            // The icons are the SAME PNGs the frontend's <PanelIcon> shows
            // (src/assets/icons/plugins — the bundled Noto set plus the
            // rasterized stroke fallbacks, dev/rasterize_panel_icons.mjs),
            // embedded with include_bytes!. The labels used to carry an emoji
            // instead; a system emoji font renders as monochrome outlines or
            // tofu boxes on Linux GTK (🩺 and 🩹 came out as empty rectangles),
            // which is the bug this replaces. A raster icon renders identically
            // on all three desktops because no font is involved.
            //
            // The scratch buffer is NOT a plugin and deliberately carries no
            // `tool:` id: it opens a new session, not a panel in the active
            // one, so it gets its own event (`dbgui:new-scratch`) rather than
            // the toggle-panel path — and toolsMenu.test.ts, which scans
            // `tool:` ids only, is right to ignore it.
            let t_scratch = IconMenuItemBuilder::with_id("scratch", "New Scratch Buffer (in-memory DuckDB)")
                .icon(tauri::image::Image::from_bytes(
                    include_bytes!("../../src/assets/icons/plugins/scratch.png"))?)
                .build(app)?;
            let t_processes = IconMenuItemBuilder::with_id("tool:processes", "Processes")
                .icon(tauri::image::Image::from_bytes(
                    include_bytes!("../../src/assets/icons/plugins/processes.png"))?)
                .build(app)?;
            let t_locks = IconMenuItemBuilder::with_id("tool:locks", "Locks & Deadlocks")
                .icon(tauri::image::Image::from_bytes(
                    include_bytes!("../../src/assets/icons/plugins/locks.png"))?)
                .build(app)?;
            let t_querystore = IconMenuItemBuilder::with_id("tool:querystore", "Query Store")
                .icon(tauri::image::Image::from_bytes(
                    include_bytes!("../../src/assets/icons/plugins/querystore.png"))?)
                .build(app)?;
            let t_replication = IconMenuItemBuilder::with_id("tool:replication", "Replication")
                .icon(tauri::image::Image::from_bytes(
                    include_bytes!("../../src/assets/icons/plugins/replication.png"))?)
                .build(app)?;
            let t_serverinfo = IconMenuItemBuilder::with_id("tool:serverinfo", "Server variables & status")
                .icon(tauri::image::Image::from_bytes(
                    include_bytes!("../../src/assets/icons/plugins/serverinfo.png"))?)
                .build(app)?;
            let t_watch = IconMenuItemBuilder::with_id("tool:watch", "Watch")
                .icon(tauri::image::Image::from_bytes(
                    include_bytes!("../../src/assets/icons/plugins/watch.png"))?)
                .build(app)?;
            let t_dbaviews = IconMenuItemBuilder::with_id("tool:dbaviews", "DBA views")
                .icon(tauri::image::Image::from_bytes(
                    include_bytes!("../../src/assets/icons/plugins/dbaviews.png"))?)
                .build(app)?;
            let t_tuner = IconMenuItemBuilder::with_id("tool:tuner", "Server tuner")
                .icon(tauri::image::Image::from_bytes(
                    include_bytes!("../../src/assets/icons/plugins/tuner.png"))?)
                .build(app)?;
            let t_users = IconMenuItemBuilder::with_id("tool:users", "Users & grants")
                .icon(tauri::image::Image::from_bytes(
                    include_bytes!("../../src/assets/icons/plugins/users.png"))?)
                .build(app)?;
            let t_maintenance = IconMenuItemBuilder::with_id("tool:maintenance", "Maintenance")
                .icon(tauri::image::Image::from_bytes(
                    include_bytes!("../../src/assets/icons/plugins/maintenance.png"))?)
                .build(app)?;
            let t_vacuum = IconMenuItemBuilder::with_id("tool:vacuum", "Vacuum & Bloat")
                .icon(tauri::image::Image::from_bytes(
                    include_bytes!("../../src/assets/icons/plugins/vacuum.png"))?)
                .build(app)?;
            let t_routines = IconMenuItemBuilder::with_id("tool:routines", "Routines")
                .icon(tauri::image::Image::from_bytes(
                    include_bytes!("../../src/assets/icons/plugins/routines.png"))?)
                .build(app)?;
            let t_erdiagram = IconMenuItemBuilder::with_id("tool:erdiagram", "ER diagram")
                .icon(tauri::image::Image::from_bytes(
                    include_bytes!("../../src/assets/icons/plugins/erdiagram.png"))?)
                .build(app)?;
            let t_documenter = IconMenuItemBuilder::with_id("tool:documenter", "Documenter")
                .icon(tauri::image::Image::from_bytes(
                    include_bytes!("../../src/assets/icons/plugins/documenter.png"))?)
                .build(app)?;
            let t_find = IconMenuItemBuilder::with_id("tool:find", "Find")
                .icon(tauri::image::Image::from_bytes(
                    include_bytes!("../../src/assets/icons/plugins/find.png"))?)
                .build(app)?;
            let t_colprofile = IconMenuItemBuilder::with_id("tool:colprofile", "Column profile")
                .icon(tauri::image::Image::from_bytes(
                    include_bytes!("../../src/assets/icons/plugins/colprofile.png"))?)
                .build(app)?;
            let t_sequences = IconMenuItemBuilder::with_id("tool:sequences", "Sequences")
                .icon(tauri::image::Image::from_bytes(
                    include_bytes!("../../src/assets/icons/plugins/sequences.png"))?)
                .build(app)?;
            let t_types = IconMenuItemBuilder::with_id("tool:types", "Types")
                .icon(tauri::image::Image::from_bytes(
                    include_bytes!("../../src/assets/icons/plugins/types.png"))?)
                .build(app)?;
            let t_views = IconMenuItemBuilder::with_id("tool:views", "Views")
                .icon(tauri::image::Image::from_bytes(
                    include_bytes!("../../src/assets/icons/plugins/views.png"))?)
                .build(app)?;
            let t_dictionary = IconMenuItemBuilder::with_id("tool:dictionary", "Dictionary")
                .icon(tauri::image::Image::from_bytes(
                    include_bytes!("../../src/assets/icons/plugins/dictionary.png"))?)
                .build(app)?;
            let t_designer = IconMenuItemBuilder::with_id("tool:designer", "Table designer")
                .icon(tauri::image::Image::from_bytes(
                    include_bytes!("../../src/assets/icons/plugins/designer.png"))?)
                .build(app)?;
            let t_compare = IconMenuItemBuilder::with_id("tool:compare", "Compare")
                .icon(tauri::image::Image::from_bytes(
                    include_bytes!("../../src/assets/icons/plugins/compare.png"))?)
                .build(app)?;
            let t_pglisten = IconMenuItemBuilder::with_id("tool:pglisten", "Listen / Notify")
                .icon(tauri::image::Image::from_bytes(
                    include_bytes!("../../src/assets/icons/plugins/pglisten.png"))?)
                .build(app)?;
            let t_stmtstats = IconMenuItemBuilder::with_id("tool:stmtstats", "Statement statistics")
                .icon(tauri::image::Image::from_bytes(
                    include_bytes!("../../src/assets/icons/plugins/stmtstats.png"))?)
                .build(app)?;
            let t_binlog = IconMenuItemBuilder::with_id("tool:binlog", "Binary logs")
                .icon(tauri::image::Image::from_bytes(
                    include_bytes!("../../src/assets/icons/plugins/binlog.png"))?)
                .build(app)?;
            let t_slowlog = IconMenuItemBuilder::with_id("tool:slowlog", "Slow-log analyzer")
                .icon(tauri::image::Image::from_bytes(
                    include_bytes!("../../src/assets/icons/plugins/slowlog.png"))?)
                .build(app)?;
            let t_quality = IconMenuItemBuilder::with_id("tool:quality", "SQL Quality")
                .icon(tauri::image::Image::from_bytes(
                    include_bytes!("../../src/assets/icons/plugins/quality.png"))?)
                .build(app)?;
            let t_datagen = IconMenuItemBuilder::with_id("tool:datagen", "Data generator")
                .icon(tauri::image::Image::from_bytes(
                    include_bytes!("../../src/assets/icons/plugins/datagen.png"))?)
                .build(app)?;
            let t_csvimport = IconMenuItemBuilder::with_id("tool:csvimport", "CSV import")
                .icon(tauri::image::Image::from_bytes(
                    include_bytes!("../../src/assets/icons/plugins/csvimport.png"))?)
                .build(app)?;
            let t_playground = IconMenuItemBuilder::with_id("tool:playground", "Playground")
                .icon(tauri::image::Image::from_bytes(
                    include_bytes!("../../src/assets/icons/plugins/playground.png"))?)
                .build(app)?;
            let t_fleet = IconMenuItemBuilder::with_id("tool:fleet", "Fleet")
                .icon(tauri::image::Image::from_bytes(
                    include_bytes!("../../src/assets/icons/plugins/fleet.png"))?)
                .build(app)?;
            let t_txshell = IconMenuItemBuilder::with_id("tool:txshell", "TxShell")
                .icon(tauri::image::Image::from_bytes(
                    include_bytes!("../../src/assets/icons/plugins/txshell.png"))?)
                .build(app)?;
            let t_saved = IconMenuItemBuilder::with_id("tool:saved", "Saved queries")
                .icon(tauri::image::Image::from_bytes(
                    include_bytes!("../../src/assets/icons/plugins/saved.png"))?)
                .build(app)?;
            let t_history = IconMenuItemBuilder::with_id("tool:history", "Query history")
                .icon(tauri::image::Image::from_bytes(
                    include_bytes!("../../src/assets/icons/plugins/history.png"))?)
                .build(app)?;

            // The seven submenus mirror PLUGIN_MENU one for one (same labels,
            // same order, same `tool:<panelId>` ids) so the two surfaces
            // cannot drift apart in shape, only in membership — and
            // tests/toolsMenu.test.ts guards the membership.
            let m_activity = SubmenuBuilder::new(app, "Activity")
                .item(&t_processes)
                .item(&t_locks)
                .item(&t_watch)
                .item(&t_replication)
                .item(&t_pglisten)
                .item(&t_playground)
                .build()?;
            let m_insights = SubmenuBuilder::new(app, "Insights")
                .item(&t_stmtstats)
                .item(&t_querystore)
                .item(&t_slowlog)
                .item(&t_binlog)
                .item(&t_history)
                .build()?;
            let m_server = SubmenuBuilder::new(app, "Server")
                .item(&t_serverinfo)
                .item(&t_dbaviews)
                .item(&t_tuner)
                .item(&t_users)
                .item(&t_maintenance)
                .item(&t_vacuum)
                .item(&t_fleet)
                .build()?;
            let m_schema = SubmenuBuilder::new(app, "Schema")
                .item(&t_erdiagram)
                .item(&t_designer)
                .item(&t_routines)
                .item(&t_views)
                .item(&t_sequences)
                .item(&t_types)
                .item(&t_dictionary)
                .item(&t_documenter)
                .build()?;
            let m_data = SubmenuBuilder::new(app, "Data")
                .item(&t_datagen)
                .item(&t_csvimport)
                .item(&t_colprofile)
                .build()?;
            let m_findcompare = SubmenuBuilder::new(app, "Find & Compare")
                .item(&t_find)
                .item(&t_compare)
                .build()?;
            let m_sql = SubmenuBuilder::new(app, "SQL")
                .item(&t_txshell)
                .item(&t_quality)
                .item(&t_saved)
                .build()?;

            let tools_menu = SubmenuBuilder::new(app, "Tools")
                .item(&t_scratch)
                .separator()
                .item(&m_activity)
                .item(&m_insights)
                .item(&m_server)
                .item(&m_schema)
                .item(&m_data)
                .item(&m_findcompare)
                .item(&m_sql)
                .build()?;

            // ── Help ────────────────────────────────────────────────────────
            // Help used to exist only off macOS, on the reasoning that About
            // already lives in the macOS app menu and a one-item Help menu is
            // an empty gesture. The reasoning was right and the conclusion was
            // wrong: the fix is to give Help something to hold, not to delete
            // it. macOS has a Help menu on every application in the system.
            //
            // About stays in the app menu on macOS as the platform requires,
            // so it is listed here only where that menu does not exist.
            // Three items, all of which do something. A Help menu padded with
            // "Documentation" pointing nowhere and "Check for Updates" that
            // cannot check is worse than the one-item menu this replaces —
            // every dead entry teaches the user that this menu is decorative.
            // A log-folder item and real docs both want a way to open a path
            // in the desktop shell, which is a dependency this does not add
            // for the sake of filling a menu.
            let h_shortcuts = MenuItemBuilder::with_id("help:shortcuts", "Keyboard Shortcuts")
                .accelerator("CmdOrCtrl+/").build(app)?;
            let h_changelog = MenuItemBuilder::with_id("help:changelog", "What's New").build(app)?;

            let help_menu = {
                let b = SubmenuBuilder::new(app, "Help")
                    .item(&h_shortcuts)
                    .item(&h_changelog);
                #[cfg(not(target_os = "macos"))]
                let b = b.separator().item(&about);
                b.build()?
            };

            // File, Edit, View, Tools, Help — the order every desktop app has
            // used for thirty years, on all three platforms. macOS keeps its
            // application menu in front of it, which is the platform's rule
            // rather than an exception to this one.
            let mb = MenuBuilder::new(app);
            #[cfg(target_os = "macos")]
            let mb = mb.item(&app_menu);
            let mb = mb
                .item(&file_menu)
                .item(&edit_menu)
                .item(&view_menu)
                .item(&tools_menu)
                .item(&help_menu);
            app.set_menu(mb.build()?)?;
            boot.mark("native menu built + installed");

            // End-to-end mark: everything above is over in single-digit ms,
            // but what the USER waits for is the window appearing — webview
            // creation, WKWebView/WebView2 init, the frontend loading and
            // painting, and the splash floor, none of which `setup` can see.
            // Poll for the window actually becoming visible so the trace
            // covers the whole launch instead of stopping at the part that was
            // already fast. Tracing only; no thread at all when it is off.
            if std::env::var("TXUI_TRACE_STARTUP").is_ok_and(|v| v != "0") {
                let h = app.handle().clone();
                let t0 = *PROC_START.get_or_init(std::time::Instant::now);
                std::thread::spawn(move || {
                    let mut webview_seen = false;
                    loop {
                        if let Some(win) = h.get_webview_window("main") {
                            if !webview_seen {
                                webview_seen = true;
                                eprintln!("[boot] {:>7.1} ms  webview window created",
                                    t0.elapsed().as_secs_f64() * 1000.0);
                            }
                            if win.is_visible().unwrap_or(false) {
                                eprintln!(
                                    "[boot] {:>7.1} ms  WINDOW VISIBLE — user sees the app (maximized: {})",
                                    t0.elapsed().as_secs_f64() * 1000.0,
                                    win.is_maximized().map(|m| m.to_string())
                                        .unwrap_or_else(|_| "unknown".into()),
                                );
                                return;
                            }
                        }
                        if t0.elapsed().as_secs() > 30 { return; }
                        std::thread::sleep(std::time::Duration::from_millis(2));
                    }
                });
            }

            Ok(())
        })
        .on_menu_event(|app, event| {
            let id = event.id().as_ref();
            if id == "about" {
                let _ = app.emit("dbgui:about", ());
            } else if id == "settings" {
                let _ = app.emit("dbgui:settings", ());
            } else if id == "wrap" {
                let _ = app.emit("dbgui:menu-wrap", ());
            } else if id == "copyheaders" {
                let _ = app.emit("dbgui:menu-copyheaders", ());
            } else if id == "zen" {
                let _ = app.emit("dbgui:menu-zen", ());
            } else if id == "scratch" {
                let _ = app.emit("dbgui:new-scratch", ());
            } else if let Some(panel) = id.strip_prefix("tool:") {
                let _ = app.emit("dbgui:open-tool", panel.to_string());
            } else if let Some(theme) = id.strip_prefix("theme:") {
                let _ = app.emit("dbgui:set-theme", theme.to_string());
            } else if let Some(action) = id.strip_prefix("file:").or_else(|| id.strip_prefix("help:")) {
                // One event carrying the action, rather than an arm per item.
                // The frontend owns what "save the SQL" means — it is the side
                // that knows which tab is in front — and adding an item here
                // then needs no second edit in this match.
                let _ = app.emit("dbgui:menu-action", format!("{}:{action}",
                    if id.starts_with("file:") { "file" } else { "help" }));
            }
        })
        .invoke_handler(tauri::generate_handler![
            // connections
            save_connection,
            import_tool_configs,
            gsheets_export,
            list_connections,
            delete_connection,
            duplicate_connection,
            test_connection,
            set_connect_timeout,
            set_query_timeout,
            instance_data_get,
            instance_data_set,
            instance_data_remove,
            sqlfile_open,
            sqlfile_save,
            sqlfile_stat,
            sqlfile_encodings,
            find_in_files,
            import_convert,
            pg_listen_start,
            pg_listen_stop,
            pg_wait_sample_start,
            pg_wait_sample_stop,
            pg_notify,
            set_active_theme,
            test_connection_adhoc,
            session_ping,
            export_connections,
            import_connections,
            open_connection,
            open_scratch_session,
            close_connection,
            // query
            execute_query,
            cancel_query,
            begin_transaction,
            commit_transaction,
            tx_status,
            tx_exec,
            rollback_transaction,
            set_session_db,
            vault_status,
            vault_create,
            vault_unlock,
            vault_lock,
            vault_change_password,
            vault_disable,
            vault_export,
            vault_import,
            list_folder_meta,
            save_folder_meta,
            create_sqlite_file,
            write_parquet_file,
            panel_query,
            cancel_panel_query,
            kill_panel_query,
            // schema
            list_schema,
            ai_complete,
            ai_set_key,
            ai_has_key,
            list_columns,
            list_parquet_struct,
            pg_copy_import,
            pg_copy_export,
            get_ddl,
            // history
            search_history,
            delete_history_entry,
            clear_connection_history,
            history_digest_stats,
            // digest snapshots (QAN-style persistent store)
            save_digest_snapshot,
            list_digest_snapshots,
            get_digest_snapshot,
            diff_digest_snapshots,
            delete_digest_snapshot,
            // deadlock events (analyzer history)
            record_deadlock_event,
            list_deadlock_events,
            get_deadlock_event,
            delete_deadlock_event,
            // data browser
            get_table_meta,
            browse_table,
            column_value_counts,
            // redis browser
            redis_scan,
            redis_key_info,
            redis_get_value,
            redis_set_string,
            redis_set_ttl,
            redis_delete_keys,
            redis_server_info,
            redis_key_audit,
            redis_sentinel_overview,
            // mongo browser (find editor)
            mongo_find,
            mongo_explain,
            // export
            write_text_file,
            export_parquet_file,
            read_slow_log,
            write_binary_file,
            read_text_file,
            // DBA ops
            list_processes,
            explain_query,
            optimizer_trace,
            server_info,
            monitor_query,
            replication_status,
            // multi-server execution
            multi_execute,
            list_multi_runs,
            get_multi_run,
            // saved queries
            list_saved_queries,
            save_query,
            delete_saved_query,
            // SQL templates (`?name` editor expansion)
            list_routines,
            get_routine,
            save_routine,
            drop_routine,
            debug_routine,
            debug_routine_mysql,
            run_os_command,
            list_sql_templates,
            save_sql_template,
            delete_sql_template,
            // CSV import
            csv_preview,
            csv_import,
            cancel_import,
            // SQL quality
            explain_with_warnings,
            column_map,
            explain_analyze_guarded,
            // audit log
            audit_insert,
            audit_list,
            // dump / restore (external tools)
            probe_dump_tools,
            run_dump_tool,
            cancel_dump_tool,
            // data generator (chunked streaming pipeline)
            generate_preview,
            generate_data,
            generate_database,
            cancel_datagen,
            resolve_sequence_start,
            run_watched,
            cancel_watched,
            // kill hinting (the `kill …` / `killall` editor popup)
            kill_candidates,
            kill_processes,
            // playground scenario generator ("spawn mess")
            playground_spawn,
            playground_stop,
            // local process metrics (status bar)
            app_metrics,
            commands::replay::replay_probe,
            commands::replay::replay_open,
            commands::replay::replay_series,
            commands::replay::replay_snapshot,
            commands::replay::replay_variable_changes,
            commands::replay::replay_close,
            commands::replay::replay_evict,
            // per-connection server activity log
            append_server_log,
            // config tuner (read-only analysis, MySQL-family)
            tuner_analyze,
            sqlite_attach,
            sqlite_detach,
            ssh_agent_status,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // Graceful shutdown: close pools + kill SSH tunnels like a manual
            // disconnect, so the DB sees clean connection teardown.
            if let tauri::RunEvent::ExitRequested { .. } = event {
                if let Some(state) = app.try_state::<AppState>() {
                    let st = state.inner().clone();
                    tauri::async_runtime::block_on(async move {
                        crate::db::connection::close_all(&st).await;
                    });
                }
            }
        });
}
