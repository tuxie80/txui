//! Safe Environment Refresh specification files. No database connection is used:
//! JSON validation lives in the pure frontend `refreshSpec.ts` contract.

use std::path::{Path, PathBuf};
use uuid::Uuid;

const MAX_REFRESH_SPEC_BYTES: usize = 2 * 1024 * 1024;

#[tauri::command]
pub async fn refresh_spec_load(path: PathBuf) -> Result<String, crate::apperror::AppError> {
    let metadata = tokio::fs::metadata(&path).await.map_err(|error| {
        crate::apperror::AppError::local(format!("could not open refresh spec {}: {error}", path.display()))
    })?;
    if metadata.len() > MAX_REFRESH_SPEC_BYTES as u64 {
        return Err(crate::apperror::AppError::bad_request("refresh spec exceeds the 2 MiB limit"));
    }
    tokio::fs::read_to_string(&path).await.map_err(|error| {
        crate::apperror::AppError::local(format!("refresh spec is not valid UTF-8: {error}"))
    })
}

#[tauri::command]
pub async fn refresh_spec_save(path: PathBuf, contents: String) -> Result<u64, crate::apperror::AppError> {
    if contents.len() > MAX_REFRESH_SPEC_BYTES {
        return Err(crate::apperror::AppError::bad_request("refresh spec exceeds the 2 MiB limit"));
    }
    let dir = path.parent().filter(|parent| !parent.as_os_str().is_empty()).unwrap_or_else(|| Path::new("."));
    let base = path.file_name().and_then(|name| name.to_str()).unwrap_or("refresh.json");
    let tmp = dir.join(format!(".{base}.txui-tmp-{}", Uuid::new_v4().simple()));
    let result: Result<(), std::io::Error> = async {
        use tokio::io::AsyncWriteExt;
        let mut file = tokio::fs::File::create(&tmp).await?;
        file.write_all(contents.as_bytes()).await?;
        file.sync_all().await?;
        drop(file);
        tokio::fs::rename(&tmp, &path).await?;
        Ok(())
    }.await;
    if let Err(error) = result {
        let _ = tokio::fs::remove_file(&tmp).await;
        return Err(crate::apperror::AppError::local(format!("could not save refresh spec {}: {error}", path.display())));
    }
    Ok(contents.len() as u64)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn spec_round_trip_is_atomic_and_replaces_the_previous_good_file() {
        let dir = std::env::temp_dir().join(format!("txui-refresh-spec-{}", Uuid::new_v4()));
        tokio::fs::create_dir_all(&dir).await.unwrap();
        let path = dir.join("refresh.json");
        assert_eq!(refresh_spec_save(path.clone(), "{\"version\":1}\n".into()).await.unwrap(), 14);
        assert_eq!(refresh_spec_load(path.clone()).await.unwrap(), "{\"version\":1}\n");
        refresh_spec_save(path.clone(), "{\"version\":1,\"seed\":\"new\"}\n".into()).await.unwrap();
        assert_eq!(refresh_spec_load(path.clone()).await.unwrap(), "{\"version\":1,\"seed\":\"new\"}\n");
        let leftovers = std::fs::read_dir(&dir).unwrap().filter(|entry| {
            entry.as_ref().unwrap().file_name().to_str()
                .is_some_and(|name| name.contains(".txui-tmp-"))
        }).count();
        assert_eq!(leftovers, 0);
        tokio::fs::remove_dir_all(&dir).await.unwrap();
    }

    #[tokio::test]
    async fn oversized_or_invalid_utf8_specs_are_refused_without_side_effects() {
        let dir = std::env::temp_dir().join(format!("txui-refresh-spec-{}", Uuid::new_v4()));
        tokio::fs::create_dir_all(&dir).await.unwrap();
        let path = dir.join("refresh.json");
        let oversized = "x".repeat(MAX_REFRESH_SPEC_BYTES + 1);
        let error = refresh_spec_save(path.clone(), oversized).await.expect_err("oversized save");
        assert!(error.message.contains("2 MiB"));
        assert!(!path.exists());
        tokio::fs::write(&path, [0xff, 0xfe]).await.unwrap();
        let error = refresh_spec_load(path).await.expect_err("invalid UTF-8");
        assert!(error.message.contains("UTF-8"));
        tokio::fs::remove_dir_all(&dir).await.unwrap();
    }
}
