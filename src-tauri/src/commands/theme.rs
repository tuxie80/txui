//! Keeping the native Theme menu in step with the active theme.
//!
//! The choice lives in the frontend (localStorage), which the menu cannot
//! read — so the frontend reports it at startup and whenever it changes, and
//! the tick moves. Without this the menu listed fifteen themes with no
//! indication of which one you were looking at.

/// Move the tick to `id`. Called by the frontend at startup and whenever the
/// theme changes — the choice lives in localStorage, which the menu cannot
/// read, so it has to be told.
///
/// Also persists the scheme ("dark"/"light") to `theme-scheme` in the data
/// dir: `apply_toolkit_theme` reads it on the next launch to set `GTK_THEME`
/// before GTK initializes (native popups follow the toolkit theme, not the
/// page's CSS).
#[tauri::command]
pub fn set_active_theme(id: String, dark: bool, menu: tauri::State<'_, crate::ThemeMenu>) -> Result<(), crate::apperror::AppError> {
    let items = menu.0.lock().map_err(|_| "theme menu is poisoned")?;
    let want = format!("theme:{id}");
    for item in items.iter() {
        let _ = item.set_checked(item.id().0 == want);
    }
    let dir = crate::storage::default_data_dir();
    let _ = std::fs::create_dir_all(&dir);
    let _ = std::fs::write(dir.join("theme-scheme"), if dark { "dark" } else { "light" });
    Ok(())
}

