//! Self-update: branch-aware check, explicit-version download, install.
//!
//! The endpoint is the signed `latest.json` on each GitHub release. A check
//! returns both the newest release overall and the newest release in the
//! running app's major branch. A download always names its target version and
//! channel, so the backend cannot re-check "latest" and install a different
//! major than the button the user pressed.
//!
//! `TXUI_UPDATE_ENDPOINT` overrides the latest manifest for staging.
//! `TXUI_UPDATE_BRANCH_ENDPOINT` supplies a branch manifest in the same kind
//! of staging loop. `TXUI_UPDATE_RELEASES_URL` overrides the GitHub release
//! list used to discover an older branch. Release builds still require HTTPS;
//! a local HTTP loop therefore needs a debug build.

use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri_plugin_updater::{Updater, UpdaterExt};

use crate::apperror::{AppError, ErrorCode};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub version: String,
    pub date: Option<String>,
    pub body: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCandidates {
    pub latest: Option<UpdateInfo>,
    pub branch: Option<UpdateInfo>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "event")]
pub enum UpdateProgress {
    Started { content_length: Option<u64> },
    Progress { downloaded: u64, total: Option<u64> },
    Finished,
}

#[derive(Deserialize)]
struct ReleaseRow {
    tag_name: String,
}

fn version_parts(value: &str) -> Option<(u64, u64, u64)> {
    let core = value.trim().trim_start_matches('v').split(['-', '+']).next()?;
    let mut parts = core.split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next()?.parse().ok()?;
    let patch = parts.next()?.parse().ok()?;
    if parts.next().is_some() { return None; }
    Some((major, minor, patch))
}

fn select_branch_version(releases: &[ReleaseRow], current: &str) -> Option<String> {
    let (current_major, ..) = version_parts(current)?;
    releases.iter()
        .filter_map(|release| {
            let version = release.tag_name.trim_start_matches('v');
            let parts = version_parts(version)?;
            (parts.0 == current_major && parts > version_parts(current)?)
                .then(|| (parts, version.to_string()))
        })
        .max_by_key(|(parts, _)| *parts)
        .map(|(_, version)| version)
}

fn custom_updater(app: &tauri::AppHandle, raw: &str) -> Result<Updater, AppError> {
    let url = raw.trim().parse().map_err(|e| {
        AppError::new(ErrorCode::BadRequest, format!("update endpoint is not a valid URL: {e}"))
    })?;
    app.updater_builder()
        .endpoints(vec![url])
        .map_err(|e| AppError::local(format!("updater endpoint rejected: {e}")))?
        .build()
        .map_err(|e| AppError::local(format!("updater init failed: {e}")))
}

fn env_endpoint(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|value| !value.trim().is_empty())
}

fn build_updater(app: &tauri::AppHandle) -> Result<Updater, AppError> {
    match env_endpoint("TXUI_UPDATE_ENDPOINT") {
        Some(raw) => custom_updater(app, &raw),
        None => app.updater()
            .map_err(|e| AppError::local(format!("updater init failed: {e}"))),
    }
}

fn build_version_updater(
    app: &tauri::AppHandle,
    version: &str,
    channel: Option<&str>,
) -> Result<Updater, AppError> {
    let override_url = if channel == Some("branch") {
        env_endpoint("TXUI_UPDATE_BRANCH_ENDPOINT").or_else(|| env_endpoint("TXUI_UPDATE_ENDPOINT"))
    } else {
        env_endpoint("TXUI_UPDATE_ENDPOINT")
    };
    if let Some(raw) = override_url { return custom_updater(app, &raw); }
    if version_parts(version).is_none() {
        return Err(AppError::new(ErrorCode::BadRequest, "invalid update target version"));
    }
    custom_updater(app, &format!(
        "https://github.com/tuxie80/txui/releases/download/v{version}/latest.json"))
}

async fn check_updater(updater: Updater) -> Result<Option<UpdateInfo>, AppError> {
    let update = updater.check().await.map_err(map_updater_err("check"))?;
    Ok(update.map(|u| UpdateInfo {
        version: u.version.clone(),
        date: u.raw_json.get("pub_date")
            .and_then(|v| v.as_str())
            .map(str::to_string),
        body: u.body.clone(),
    }))
}

async fn discover_branch_update(
    app: &tauri::AppHandle,
    current_version: &str,
) -> Result<Option<UpdateInfo>, AppError> {
    if let Some(raw) = env_endpoint("TXUI_UPDATE_BRANCH_ENDPOINT") {
        return check_updater(custom_updater(app, &raw)?).await;
    }
    if env_endpoint("TXUI_UPDATE_ENDPOINT").is_some() { return Ok(None); }
    let endpoint = env_endpoint("TXUI_UPDATE_RELEASES_URL").unwrap_or_else(||
        "https://api.github.com/repos/tuxie80/txui/releases?per_page=100".to_string());
    let client = reqwest::Client::builder()
        .user_agent("TxUI-updater")
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| AppError::local(format!("release-list client failed: {e}")))?;
    let releases = client.get(endpoint)
        .send().await
        .map_err(|e| AppError::local(format!("release-list request failed: {e}")))?
        .error_for_status()
        .map_err(|e| AppError::local(format!("release-list response failed: {e}")))?
        .json::<Vec<ReleaseRow>>().await
        .map_err(|e| AppError::local(format!("release-list decode failed: {e}")))?;
    let Some(version) = select_branch_version(&releases, current_version) else {
        return Ok(None);
    };
    check_updater(build_version_updater(app, &version, Some("branch"))?).await
}

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

#[tauri::command]
pub async fn update_check(
    app: tauri::AppHandle,
    current_version: String,
) -> Result<UpdateCandidates, AppError> {
    if version_parts(&current_version).is_none() {
        return Err(AppError::new(ErrorCode::BadRequest, "invalid current version"));
    }
    let latest = check_updater(build_updater(&app)?).await?;
    let branch = match &latest {
        Some(info) if version_parts(&info.version).map(|v| v.0)
            == version_parts(&current_version).map(|v| v.0) => latest.clone(),
        Some(_) => discover_branch_update(&app, &current_version).await?,
        None => None,
    };
    Ok(UpdateCandidates { latest, branch })
}

#[tauri::command]
pub async fn update_download_and_install(
    app: tauri::AppHandle,
    on_event: Channel<UpdateProgress>,
    target_version: String,
    channel: Option<String>,
) -> Result<(), AppError> {
    let updater = build_version_updater(&app, &target_version, channel.as_deref())?;
    let update = updater.check().await.map_err(map_updater_err("check"))?.ok_or_else(|| {
        AppError::new(ErrorCode::NotFound, "the update is no longer available")
    })?;
    if update.version != target_version {
        return Err(AppError::new(ErrorCode::BadRequest, format!(
            "update target changed: requested {target_version}, manifest offers {}",
            update.version)));
    }

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

    #[test]
    fn not_updatable_serializes_to_its_documented_spelling() {
        let e = AppError::new(ErrorCode::NotUpdatable, "x");
        assert_eq!(serde_json::to_value(&e).unwrap()["code"], "not_updatable");
    }

    #[test]
    fn a_permission_denied_install_is_not_updatable() {
        let e = tauri_plugin_updater::Error::Io(
            std::io::Error::new(std::io::ErrorKind::PermissionDenied, "cannot write /usr/bin"));
        assert!(is_not_updatable(&e));
    }

    #[test]
    fn a_network_error_is_not_not_updatable() {
        let e = tauri_plugin_updater::Error::Network("offline".into());
        assert!(!is_not_updatable(&e));
    }

    #[test]
    fn branch_discovery_chooses_only_the_newest_release_in_the_current_major() {
        let rows = ["v1.3.0", "v1.3.2", "v1.4.0", "v2.0.0", "v1.3.1"]
            .map(|tag_name| ReleaseRow { tag_name: tag_name.to_string() });
        assert_eq!(select_branch_version(&rows, "1.3.1").as_deref(), Some("1.4.0"));
        assert_eq!(select_branch_version(&rows, "1.4.0"), None);
        assert_eq!(select_branch_version(&rows, "1.2.9").as_deref(), Some("1.4.0"));
    }

    #[test]
    fn branch_discovery_rejects_bad_versions_and_downgrades() {
        let rows = ["v1.3.0", "garbage", "v2.0.0"]
            .map(|tag_name| ReleaseRow { tag_name: tag_name.to_string() });
        assert_eq!(select_branch_version(&rows, "1.3.1"), None);
        assert_eq!(select_branch_version(&rows, "not-a-version"), None);
    }
}
