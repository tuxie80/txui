//! MongoDB-specific commands: `mongo_find` (the find editor's run path),
//! `mongo_explain` (its Explain button), `mongo_aggregate` (the pipeline
//! runner) and `mongo_coll_stats` (the Stats tab). All are READS — the driver
//! has no insert/update/delete path at all (db/mongodb.rs), and the pipeline
//! runner rejects the write-capable stages (`WRITE_STAGES`: $out/$merge)
//! before anything reaches the server, so read-only stays structural.
use tauri::State;
use uuid::Uuid;

use crate::db::connection::get_session_pub;
use crate::db::types::{LiveSession, QueryResult};
use crate::state::AppState;

async fn get_client(
    session_id: Uuid,
    state: &State<'_, AppState>,
) -> Result<mongodb::Client, crate::apperror::AppError> {
    let session = get_session_pub(session_id, &state.sessions)
        .await
        ?;
    match session.as_ref() {
        LiveSession::MongoDb(client) => Ok(client.clone()),
        _ => Err("Not a MongoDB session".into()),
    }
}

/// One find page: filter / projection / sort as JSON documents (extended JSON
/// accepted — `{"$oid": …}`, `{"$date": …}` — so _id predicates typecheck),
/// plus limit/skip paging. Bad JSON is a readable, field-naming error
/// (db/mongodb.rs::parse_doc), never a bare server complaint.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn mongo_find(
    session_id: Uuid,
    db:         String,
    collection: String,
    filter:     Option<String>,
    projection: Option<String>,
    sort:       Option<String>,
    limit:      Option<i64>,
    skip:       Option<u64>,
    state:      State<'_, AppState>,
) -> Result<QueryResult, crate::apperror::AppError> {
    let client = get_client(session_id, &state).await?;
    let args = crate::db::mongodb::FindArgs {
        filter, projection, sort,
        limit: limit.unwrap_or(500),
        skip:  skip.unwrap_or(0),
    };
    crate::db::mongodb::find(&client, &db, &collection, &args)
        .await
        .map_err(Into::into)
}

/// `explain()` for a find — queryPlanner by default, executionStats when
/// `analyze` is set (which EXECUTES the query; the UI warns first, same as
/// EXPLAIN ANALYZE on the SQL engines). Returns the plan as pretty JSON text.
#[tauri::command]
pub async fn mongo_explain(
    session_id: Uuid,
    db:         String,
    collection: String,
    filter:     Option<String>,
    analyze:    Option<bool>,
    state:      State<'_, AppState>,
) -> Result<String, crate::apperror::AppError> {
    let client = get_client(session_id, &state).await?;
    crate::db::mongodb::explain_find(
        &client, &db, &collection, filter.as_deref(), analyze.unwrap_or(false))
        .await
        .map_err(Into::into)
}

/// Run a read-only aggregation pipeline: the pipeline as a JSON array of
/// stage documents (extended JSON accepted), an optional row cap for the
/// trailing `$limit` guard. Write stages ($out/$merge) are rejected in Rust
/// before anything reaches the server (db/mongodb.rs::aggregate).
#[tauri::command]
pub async fn mongo_aggregate(
    session_id: Uuid,
    db:         String,
    collection: String,
    pipeline:   String,
    limit:      Option<i64>,
    state:      State<'_, AppState>,
) -> Result<QueryResult, crate::apperror::AppError> {
    let client = get_client(session_id, &state).await?;
    crate::db::mongodb::aggregate(&client, &db, &collection, &pipeline, limit)
        .await
        .map_err(Into::into)
}

/// Collection stats ($collStats: storageStats + count + latencyStats),
/// flattened into the (section, name, value) grid. Views refuse server-side;
/// that error surfaces readably — the Stats tab shows it as-is.
#[tauri::command]
pub async fn mongo_coll_stats(
    session_id: Uuid,
    db:         String,
    collection: String,
    state:      State<'_, AppState>,
) -> Result<QueryResult, crate::apperror::AppError> {
    let client = get_client(session_id, &state).await?;
    crate::db::mongodb::coll_stats(&client, &db, &collection)
        .await
        .map_err(Into::into)
}
