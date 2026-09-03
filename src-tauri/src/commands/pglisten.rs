//! `LISTEN` / `NOTIFY` — watching a PostgreSQL channel.
//!
//! The only way to observe an application's own eventing from the database
//! side, and the one thing on the gap list with no workaround from a query
//! window: `LISTEN` needs a connection that stays put and a loop that waits on
//! it, which a pooled request-response query cannot provide.
//!
//! So this holds a **dedicated connection** outside the pool — `PgListener`
//! takes one for itself — and pushes notifications to the frontend over a
//! Tauri channel rather than being polled. A poll loop would either miss
//! notifications between polls or need a server-side buffer; the socket
//! already delivers them in order, so the honest thing is to forward them.
//!
//! Every listener is registered so it can be stopped. A held connection that
//! outlives the panel that opened it is a leak the user cannot see, and on a
//! server with a connection limit it is a leak that eventually costs an
//! outage.

use serde::Serialize;
use std::collections::HashMap;
use std::sync::Arc;
use tauri::ipc::Channel;
use tokio::sync::RwLock;
use uuid::Uuid;

use crate::apperror::AppError;
use crate::db::connection::get_session_pub;
use crate::db::types::LiveSession;
use crate::state::AppState;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum ListenEvent {
    /// The listener is connected and watching. Sent once, so the UI can stop
    /// saying "connecting" — a channel that is simply quiet looks identical to
    /// one that never started.
    Listening { channels: Vec<String> },
    Notification { channel: String, payload: String, at_ms: i64 },
    /// The connection died. Terminal — the UI must not keep showing "live".
    Closed { reason: String },
}

/// Running listeners, keyed by the token the frontend generated. The session
/// id rides along so a connection close can abort every listener it owns.
pub struct ListenerEntry {
    pub session_id: Uuid,
    pub handle: tokio::task::JoinHandle<()>,
}
pub type ListenerMap = Arc<RwLock<HashMap<String, ListenerEntry>>>;

/// Abort every listener belonging to a session (connection close). Aborted,
/// not awaited: the point is to release the pinned connection, not to wait
/// for the task to notice.
pub async fn abort_session_listeners(map: &ListenerMap, session_id: Uuid) {
    let entries: Vec<ListenerEntry> = {
        let mut m = map.write().await;
        let tokens: Vec<String> = m.iter()
            .filter(|(_, e)| e.session_id == session_id)
            .map(|(t, _)| t.clone())
            .collect();
        tokens.into_iter().filter_map(|t| m.remove(&t)).collect()
    };
    for e in entries { e.handle.abort(); }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Start listening. `token` identifies the listener for `pg_listen_stop`.
#[tauri::command]
pub async fn pg_listen_start(
    session_id: Uuid,
    token: String,
    channels: Vec<String>,
    on_event: Channel<ListenEvent>,
    state: tauri::State<'_, AppState>,
) -> Result<(), AppError> {
    if channels.is_empty() {
        return Err(AppError::bad_request("no channel to listen on"));
    }
    // Channel names are identifiers on the wire. `PgListener::listen` quotes
    // them, but a name containing a NUL would still be a protocol problem, and
    // an absurdly long one is a mistake rather than a channel.
    for c in &channels {
        if c.is_empty() || c.len() > 63 || c.contains('\0') {
            return Err(AppError::bad_request(format!("invalid channel name `{c}`")));
        }
    }

    let session = get_session_pub(session_id, &state.sessions).await?;
    let LiveSession::Postgres(pool) = session.as_ref() else {
        return Err(AppError::unsupported("LISTEN / NOTIFY is a PostgreSQL feature"));
    };

    let mut listener = sqlx::postgres::PgListener::connect_with(pool)
        .await
        .map_err(|e| AppError::bad_request(format!("could not open a listening connection: {e}")))?;
    let refs: Vec<&str> = channels.iter().map(String::as_str).collect();
    listener.listen_all(refs)
        .await
        .map_err(|e| AppError::bad_request(format!("LISTEN failed: {e}")))?;

    let _ = on_event.send(ListenEvent::Listening { channels: channels.clone() });

    let listeners = state.pg_listeners.clone();
    let key = token.clone();
    let handle = tokio::spawn(async move {
        loop {
            match listener.recv().await {
                Ok(n) => {
                    let ev = ListenEvent::Notification {
                        channel: n.channel().to_string(),
                        payload: n.payload().to_string(),
                        at_ms: now_ms(),
                    };
                    // A closed channel means the panel is gone. Stop rather
                    // than holding a connection nobody is reading from.
                    if on_event.send(ev).is_err() {
                        break;
                    }
                }
                Err(e) => {
                    let _ = on_event.send(ListenEvent::Closed { reason: e.to_string() });
                    break;
                }
            }
        }
        listeners.write().await.remove(&key);
    });

    state.pg_listeners.write().await.insert(token, ListenerEntry { session_id, handle });
    Ok(())
}

/// Stop a listener and release its connection. Unknown token is not an error —
/// the caller wanted it stopped and it is.
#[tauri::command]
pub async fn pg_listen_stop(
    token: String,
    state: tauri::State<'_, AppState>,
) -> Result<(), AppError> {
    if let Some(e) = state.pg_listeners.write().await.remove(&token) {
        e.handle.abort();
    }
    Ok(())
}

/// Send a notification, so the panel can prove the round trip without a second
/// client. `NOTIFY` takes a literal payload, not a bind parameter.
#[tauri::command]
pub async fn pg_notify(
    session_id: Uuid,
    channel: String,
    payload: String,
    state: tauri::State<'_, AppState>,
) -> Result<(), AppError> {
    let session = get_session_pub(session_id, &state.sessions).await?;
    let LiveSession::Postgres(pool) = session.as_ref() else {
        return Err(AppError::unsupported("LISTEN / NOTIFY is a PostgreSQL feature"));
    };
    if channel.is_empty() || channel.len() > 63 || channel.contains('\0') {
        return Err(AppError::bad_request("invalid channel name"));
    }
    // `pg_notify()` the function, not the `NOTIFY` statement: it takes both
    // arguments as values, so neither the channel nor the payload is ever
    // concatenated into SQL.
    sqlx::query("SELECT pg_notify($1, $2)")
        .bind(&channel)
        .bind(&payload)
        .execute(pool)
        .await
        .map_err(|e| AppError::bad_request(format!("NOTIFY failed: {e}")))?;
    Ok(())
}

#[cfg(test)]
mod live_tests {
    //! Against a local PostgreSQL — see `db::postgres::live_tests` for the
    //! fixture (user/password `root`, ports 5432–5435).
    //!
    //! The command layer needs a Tauri `State`, so these exercise the part that
    //! carries the risk: that a dedicated listening connection can be opened
    //! off the pool, that `LISTEN` and `pg_notify` actually round-trip, and
    //! that dropping the listener releases the connection.

    async fn pool(port: u16) -> sqlx::PgPool {
        let mut c = crate::db::types::ConnectionConfig::new(
            crate::db::types::Engine::Postgres, "t");
        c.host = Some("127.0.0.1".into());
        c.port = Some(port);
        c.user = Some("root".into());
        c.database = Some("postgres".into());
        c.ssl_mode = crate::db::types::SslMode::Disable;
        crate::db::postgres::open_pool(&c, Some("root".into()), None, 2).await.expect("connect")
    }

    /// The whole feature in one assertion: a notification sent on one
    /// connection arrives on the listening one.
    #[tokio::test]
    #[ignore = "needs local PostgreSQL"]
    async fn a_notification_round_trips() {
        let p = pool(5433).await;
        let mut l = sqlx::postgres::PgListener::connect_with(&p).await.expect("listener");
        l.listen_all(vec!["txui_test"]).await.expect("listen");

        sqlx::query("SELECT pg_notify($1, $2)")
            .bind("txui_test").bind(r#"{"hello":"world"}"#)
            .execute(&p).await.expect("notify");

        let n = tokio::time::timeout(std::time::Duration::from_secs(5), l.recv())
            .await.expect("no notification within 5s").expect("recv");
        assert_eq!(n.channel(), "txui_test");
        assert_eq!(n.payload(), r#"{"hello":"world"}"#);
    }

    /// `pg_notify()` takes both arguments as values, so a payload full of
    /// quotes cannot break out — the reason the function is used instead of
    /// the `NOTIFY` statement.
    #[tokio::test]
    #[ignore = "needs local PostgreSQL"]
    async fn a_hostile_payload_is_carried_verbatim() {
        let p = pool(5433).await;
        let mut l = sqlx::postgres::PgListener::connect_with(&p).await.expect("listener");
        l.listen_all(vec!["txui_test2"]).await.expect("listen");

        let nasty = "'; DROP TABLE x; --\" \\ \n ěščř";
        sqlx::query("SELECT pg_notify($1, $2)").bind("txui_test2").bind(nasty)
            .execute(&p).await.expect("notify");

        let n = tokio::time::timeout(std::time::Duration::from_secs(5), l.recv())
            .await.expect("timed out").expect("recv");
        assert_eq!(n.payload(), nasty, "the payload was altered in transit");
    }

    /// Listening on several channels at once is what the panel offers.
    #[tokio::test]
    #[ignore = "needs local PostgreSQL"]
    async fn several_channels_are_watched_at_once() {
        let p = pool(5433).await;
        let mut l = sqlx::postgres::PgListener::connect_with(&p).await.expect("listener");
        l.listen_all(vec!["txui_a", "txui_b"]).await.expect("listen");

        for ch in ["txui_a", "txui_b"] {
            sqlx::query("SELECT pg_notify($1, $2)").bind(ch).bind(ch)
                .execute(&p).await.expect("notify");
        }
        let mut seen = std::collections::HashSet::new();
        for _ in 0..2 {
            let n = tokio::time::timeout(std::time::Duration::from_secs(5), l.recv())
                .await.expect("timed out").expect("recv");
            seen.insert(n.channel().to_string());
        }
        assert_eq!(seen.len(), 2, "did not receive from both channels: {seen:?}");
    }

    /// The listener holds a connection outside the pool. Dropping it must give
    /// that connection back, or every opened panel leaks one until the server
    /// refuses new connections.
    #[tokio::test]
    #[ignore = "needs local PostgreSQL"]
    async fn dropping_the_listener_releases_its_backend() {
        let p = pool(5433).await;
        let count = || async {
            sqlx::query_scalar::<_, i64>(
                "SELECT count(*) FROM pg_stat_activity WHERE query LIKE 'LISTEN%'")
                .fetch_one(&p).await.unwrap()
        };
        let before = count().await;
        {
            let mut l = sqlx::postgres::PgListener::connect_with(&p).await.expect("listener");
            l.listen_all(vec!["txui_drop"]).await.expect("listen");
            assert!(count().await > before, "the listening backend never appeared");
        }
        // The socket closes asynchronously; give the server a moment to reap.
        for _ in 0..20 {
            if count().await <= before { return; }
            tokio::time::sleep(std::time::Duration::from_millis(150)).await;
        }
        panic!("the listening backend was still there after the listener was dropped");
    }
}
