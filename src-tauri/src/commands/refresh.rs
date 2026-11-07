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

    async fn refresh_live_node(args: &[String], input: Option<serde_json::Value>) -> serde_json::Value {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
        let mut command = tokio::process::Command::new("node");
        command
            .arg(root.join("dev/refresh_catalog_live.mjs"))
            .args(args)
            .current_dir(root)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        if input.is_some() {
            command.stdin(std::process::Stdio::piped());
        }
        let mut child = command.spawn().unwrap();
        if let Some(input) = input {
            tokio::io::AsyncWriteExt::write_all(child.stdin.as_mut().unwrap(), input.to_string().as_bytes()).await.unwrap();
            drop(child.stdin.take());
        }
        let output = child.wait_with_output().await.unwrap();
        assert!(output.status.success(), "refresh live proof failed: {}\n{}", String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
        serde_json::from_slice(&output.stdout).unwrap()
    }

    #[tokio::test]
    #[ignore = "requires dbctl tmp mysql@8.4 or mariadb@11.8 and node"]
    async fn dbctl_mysql_refresh_catalog_graph_and_compatibility() {
        let url = std::env::var("DATABASE_URL").expect("run through dbctl tmp");
        let pool = sqlx::mysql::MySqlPoolOptions::new().max_connections(2).connect(&url).await.unwrap();
        let suffix = &Uuid::new_v4().simple().to_string()[..8];
        let source = format!("txui_refresh_source_{suffix}");
        let target = format!("txui_refresh_target_{suffix}");
        for schema in [&source, &target] {
            crate::db::mysql::execute(&pool, &format!("CREATE DATABASE `{schema}`")).await.unwrap();
            for sql in [
                "CREATE TABLE parents (id INT NOT NULL, seq INT NOT NULL, code VARCHAR(20) NOT NULL, computed VARCHAR(21) GENERATED ALWAYS AS (CONCAT(code,'!')) STORED, PRIMARY KEY(id,seq), UNIQUE KEY uq_code(code)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
                "CREATE TABLE children (id INT PRIMARY KEY, parent_id INT NULL, parent_seq INT NOT NULL, self_parent INT NULL, created_on DATE NOT NULL, CONSTRAINT fk_composite FOREIGN KEY(parent_id,parent_seq) REFERENCES parents(id,seq), CONSTRAINT fk_self FOREIGN KEY(self_parent) REFERENCES children(id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
                "CREATE TABLE cyc_a (id INT PRIMARY KEY, b_id INT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
                "CREATE TABLE cyc_b (id INT PRIMARY KEY, a_id INT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
                "ALTER TABLE cyc_a ADD CONSTRAINT fk_a_b FOREIGN KEY(b_id) REFERENCES cyc_b(id)",
                "ALTER TABLE cyc_b ADD CONSTRAINT fk_b_a FOREIGN KEY(a_id) REFERENCES cyc_a(id)",
                "CREATE TABLE no_key (id INT NOT NULL, note VARCHAR(40) NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
            ] {
                let qualified = if sql.starts_with("CREATE TABLE ") {
                    sql.replacen("CREATE TABLE ", &format!("CREATE TABLE `{schema}`."), 1)
                } else {
                    sql.replacen("ALTER TABLE ", &format!("ALTER TABLE `{schema}`."), 1)
                };
                crate::db::mysql::execute(&pool, &qualified).await.unwrap();
            }
        }
        let request = refresh_live_node(&["--queries".into(), source.clone(), target.clone()], None).await;
        let mut grids = Vec::new();
        for query in request["queries"].as_array().unwrap() {
            let sql = query["sql"].as_str().unwrap();
            let result = crate::db::mysql::execute(&pool, sql).await.unwrap();
            assert!(!result.truncated, "catalog query was truncated: {sql}");
            grids.push(serde_json::json!({
                "sessionId": query["sessionId"],
                "sql": sql,
                "grid": {
                    "columns": result.columns.iter().map(|column| &column.name).collect::<Vec<_>>(),
                    "rows": result.rows,
                    "truncated": result.truncated,
                },
            }));
        }
        let evidence = refresh_live_node(&[], Some(serde_json::json!({
            "spec": request["spec"], "grids": grids,
        }))).await;
        assert_eq!(evidence["sourceTables"], 5);
        assert_eq!(evidence["targetTables"], 5);
        assert_eq!(evidence["foreignKeys"], 4);
        assert_eq!(evidence["selfReferences"], 1);
        assert_eq!(evidence["cycles"], 2);
        assert_eq!(evidence["generatedColumns"], 1);
        assert_eq!(evidence["missingKeyBlocked"], true);
        assert_eq!(evidence["incompatibleTargetBlocked"], true);
        assert_eq!(evidence["metadataQueries"], 12);
        assert_eq!(evidence["executionPlanExecutable"], true);
        let explain_sql = evidence["explainSql"].as_str().unwrap();
        assert!(!explain_sql.contains("OFFSET"));
        let explain = crate::db::mysql::execute(&pool, &format!("EXPLAIN {explain_sql}")).await.unwrap();
        assert!(!explain.rows.is_empty(), "EXPLAIN returned no plan rows");
        for schema in [&source, &target] {
            crate::db::mysql::execute(&pool, &format!("DROP DATABASE `{schema}`")).await.unwrap();
        }
        pool.close().await;
    }
}
