//! Self-update: check, download, install.
//!
//! The heavy lifting is `tauri-plugin-updater`'s; these two commands are the
//! frontend's typed doorway to it. The endpoint is the signed `latest.json`
//! on the GitHub release (tauri.conf.json `plugins.updater`), overridable
//! with `TXUI_UPDATE_ENDPOINT` for a staging manifest without rebuilding —
//! note the plugin rejects a non-https endpoint in RELEASE builds, so the
//! local http loop is a debug-build affair.
//!
//! The download is NOT cancellable from the frontend: Tauri's Channel has no
//! JS→Rust close signal and a third command just for abort was not worth it.
//! The status-bar "cancel" therefore means "stop telling me" — the store
//! forgets the download while the backend finishes and installs; the new
//! version simply applies on the next natural restart instead of via the
//! relaunch chip.

use serde::Serialize;
use tauri::ipc::Channel;
use tauri_plugin_updater::{Updater, UpdaterExt};

use crate::apperror::{AppError, ErrorCode};

/// What `update_check` reports. `None` (no update) is a success, not an
/// error — the frontend's policy layer (`utils/updatePolicy.ts`) classifies
/// the version delta and decides between auto-download and a passive chip.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub version: String,
    pub date: Option<String>,
    pub body: Option<String>,
}

/// Download progress, streamed over the Channel. Tagged on `event` so the
/// frontend switches exactly like the other streamed commands (`pglisten`'s
/// ListenEvent, datagen's GenEvent).
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "event")]
pub enum UpdateProgress {
    /// First event; `content_length` is None when the server does not say.
    Started { content_length: Option<u64> },
    Progress { downloaded: u64, total: Option<u64> },
    /// Download verified (minisign); install follows before the command
    /// itself resolves.
    Finished,
}

/// Build the updater, honouring `TXUI_UPDATE_ENDPOINT`.
///
/// Read at command level rather than at plugin registration so a staging
/// manifest (a local static server, a test file) needs no rebuild — the
/// plugin's own config endpoint stays the production default.
fn build_updater(app: &tauri::AppHandle) -> Result<Updater, AppError> {
    match std::env::var("TXUI_UPDATE_ENDPOINT") {
        Ok(raw) if !raw.trim().is_empty() => {
            let url = raw.trim().parse().map_err(|e| {
                AppError::new(ErrorCode::BadRequest, format!(
                    "TXUI_UPDATE_ENDPOINT is not a valid URL: {e}"))
            })?;
            app.updater_builder()
                .endpoints(vec![url])
                .map_err(|e| AppError::local(format!("updater endpoint rejected: {e}")))?
                .build()
                .map_err(|e| AppError::local(format!("updater init failed: {e}")))
        }
        _ => app.updater()
            .map_err(|e| AppError::local(format!("updater init failed: {e}"))),
    }
}

/// Is this error the "this install cannot auto-update" class? Linux deb/rpm
/// installs land here (the package manager owns the file), and the frontend
/// must fall back to the notify-only chip — that fallback is the whole point
/// of the dedicated code rather than a generic failure.
fn is_not_updatable(e: &tauri_plugin_updater::Error) -> bool {
    use tauri_plugin_updater::Error as E;
    match e {
        E::InvalidUpdaterFormat
        | E::DebInstallFailed
        | E::PackageInstallFailed
        | E::AuthenticationFailed
        | E::TempDirNotOnSameMountPoint => true,
        E::Io(io) => matches!(
            io.kind(),
            std::io::ErrorKind::PermissionDenied | std::io::ErrorKind::ReadOnlyFilesystem
        ),
        _ => false,
    }
}

fn map_updater_err(what: &str) -> impl Fn(tauri_plugin_updater::Error) -> AppError + '_ {
    move |e| {
        if is_not_updatable(&e) {
            AppError::new(ErrorCode::NotUpdatable, format!(
                "this install cannot update itself ({what}: {e}) — get the new version \
                 from the release page or your package manager"))
            .with_detail(e.to_string())
        } else {
            AppError::local(format!("update {what} failed: {e}"))
                .with_detail(e.to_string())
        }
    }
}

/// Is a newer version available? `Ok(None)` = up to date. Errors are typed
/// and quiet: the scheduled background check treats any failure as "try
/// again next launch" — never a dialog.
#[tauri::command]
pub async fn update_check(app: tauri::AppHandle) -> Result<Option<UpdateInfo>, AppError> {
    let updater = build_updater(&app)?;
    let update = updater.check().await.map_err(map_updater_err("check"))?;
    Ok(update.map(|u| UpdateInfo {
        version: u.version.clone(),
        // The plugin parses the date into `time::OffsetDateTime`; taking it
        // back out of the raw JSON avoids depending on the `time` crate just
        // to format it again.
        date: u.raw_json.get("pub_date")
            .and_then(|v| v.as_str())
            .map(str::to_string),
        body: u.body.clone(),
    }))
}

/// Re-check, then download (streaming progress over `on_event`) and install.
///
/// Resolves once the install has replaced the bundle — the running process is
/// still the OLD version; the frontend's "↻ Restart to X.Y.Z" chip calls
/// `relaunch()` from the process plugin. A non-self-updatable install (Linux
/// deb/rpm) is `not_updatable`, which the frontend turns into the passive
/// "available" chip instead of a failure.
#[tauri::command]
pub async fn update_download_and_install(
    app: tauri::AppHandle,
    on_event: Channel<UpdateProgress>,
) -> Result<(), AppError> {
    let updater = build_updater(&app)?;
    let update = updater.check().await.map_err(map_updater_err("check"))?;
    let Some(update) = update else {
        // The check that opened the chip said there was one; the re-check
        // disagrees (release pulled, endpoint changed). Not an error anyone
        // can act on — say so and let the store settle back to idle.
        return Err(AppError::new(ErrorCode::NotFound,
            "the update is no longer available"));
    };

    let mut downloaded: u64 = 0;
    let mut started = false;
    let ev = &on_event;
    update
        .download_and_install(
            move |chunk_len, content_length| {
                if !started {
                    started = true;
                    let _ = ev.send(UpdateProgress::Started { content_length });
                }
                downloaded += chunk_len as u64;
                let _ = ev.send(UpdateProgress::Progress {
                    downloaded,
                    total: content_length,
                });
            },
            || {
                let _ = on_event.send(UpdateProgress::Finished);
            },
        )
        .await
        .map_err(map_updater_err("download/install"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The wire shape the frontend matches on: `code: "not_updatable"` is the
    /// signal for the notify-only fallback, so its spelling is a contract
    /// (utils/appError.ts lists it).
    #[test]
    fn not_updatable_serializes_to_its_documented_spelling() {
        let e = AppError::new(ErrorCode::NotUpdatable, "x");
        assert_eq!(serde_json::to_value(&e).unwrap()["code"], "not_updatable");
    }

    /// A deb/rpm permission failure on install must classify as NotUpdatable,
    /// not a generic local error — the frontend's fallback depends on it.
    #[test]
    fn a_permission_denied_install_is_not_updatable() {
        let e = tauri_plugin_updater::Error::Io(
            std::io::Error::new(std::io::ErrorKind::PermissionDenied, "cannot write /usr/bin"));
        assert!(is_not_updatable(&e));
    }

    /// A network failure is NOT "not updatable" — it is transient and just
    /// retries next launch.
    #[test]
    fn a_network_error_is_not_not_updatable() {
        let e = tauri_plugin_updater::Error::Network("offline".into());
        assert!(!is_not_updatable(&e));
    }
}
