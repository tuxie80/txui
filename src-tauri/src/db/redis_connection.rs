use std::collections::{HashMap, VecDeque};
use std::sync::Arc;
use std::time::Duration;

use futures_util::FutureExt;
use redis::aio::{ConnectionLike, ConnectionManager, MultiplexedConnection};
use redis::cluster::ClusterClient;
use redis::cluster_async::ClusterConnection;
use redis::cluster_routing::{MultipleNodeRoutingInfo, RoutingInfo, SingleNodeRoutingInfo};
use redis::{Cmd, ConnectionAddr, ConnectionInfo, RedisConnectionInfo, RedisError, RedisFuture, RedisResult, Value};
use tokio::sync::Mutex;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RedisTopology {
    Standalone,
    Cluster,
    Sentinel,
}

pub fn topology_from_info(info: &str) -> RedisTopology {
    for line in info.lines() {
        if let Some(mode) = line.trim().strip_prefix("redis_mode:") {
            return match mode.trim() {
                "cluster" => RedisTopology::Cluster,
                "sentinel" => RedisTopology::Sentinel,
                _ => RedisTopology::Standalone,
            };
        }
    }
    RedisTopology::Standalone
}

#[derive(Clone)]
pub struct SentinelSettings {
    pub sentinels: Vec<ConnectionInfo>,
    pub service_name: String,
    pub master: RedisConnectionInfo,
    pub tls: bool,
    pub connect_timeout: Duration,
    pub db: i64,
}

fn master_address(raw: Value) -> RedisResult<(String, u16)> {
    let Value::Array(parts) = raw else {
        return Err((redis::ErrorKind::MasterNameNotFoundBySentinel,
            "Sentinel did not return a master address").into());
    };
    if parts.len() != 2 {
        return Err((redis::ErrorKind::MasterNameNotFoundBySentinel,
            "Sentinel returned an invalid master address").into());
    }
    let host = value_string(&parts[0]).filter(|host| !host.is_empty()).ok_or_else(|| {
        RedisError::from((redis::ErrorKind::MasterNameNotFoundBySentinel,
            "Sentinel returned an empty master host"))
    })?;
    let port = value_string(&parts[1]).and_then(|port| port.parse().ok()).ok_or_else(|| {
        RedisError::from((redis::ErrorKind::MasterNameNotFoundBySentinel,
            "Sentinel returned an invalid master port"))
    })?;
    Ok((host, port))
}

fn role_is_master(raw: &[Value]) -> bool {
    raw.first().and_then(value_string).is_some_and(|role| role == "master")
}

async fn connect_multiplexed(
    info: ConnectionInfo,
    timeout: Duration,
) -> RedisResult<MultiplexedConnection> {
    let client = redis::Client::open(info)?;
    tokio::time::timeout(timeout, client.get_multiplexed_async_connection())
        .await
        .map_err(|_| RedisError::from((redis::ErrorKind::IoError, "Redis connection timed out")))?
}

async fn discover_master(settings: &SentinelSettings) -> RedisResult<MultiplexedConnection> {
    let mut last_error = None;
    for sentinel in &settings.sentinels {
        let attempt = async {
            let mut control = connect_multiplexed(sentinel.clone(), settings.connect_timeout).await?;
            let raw = redis::cmd("SENTINEL").arg("GET-MASTER-ADDR-BY-NAME")
                .arg(&settings.service_name).query_async(&mut control).await?;
            let (host, port) = master_address(raw)?;
            let addr = if settings.tls {
                ConnectionAddr::TcpTls { host, port, insecure: false, tls_params: None }
            } else {
                ConnectionAddr::Tcp(host, port)
            };
            let info = ConnectionInfo { addr, redis: settings.master.clone() };
            let mut master = connect_multiplexed(info, settings.connect_timeout).await?;
            let role: Vec<Value> = redis::cmd("ROLE").query_async(&mut master).await?;
            if !role_is_master(&role) {
                return Err(RedisError::from((
                    redis::ErrorKind::MasterNameNotFoundBySentinel,
                    "Sentinel returned a node whose ROLE is not master",
                )));
            }
            Ok(master)
        }.await;
        match attempt {
            Ok(master) => return Ok(master),
            Err(error) => {
                log::warn!("Redis Sentinel master discovery failed for {}: {error}", settings.service_name);
                last_error = Some(error);
            }
        }
    }
    Err(last_error.unwrap_or_else(|| RedisError::from((
        redis::ErrorKind::MasterNameNotFoundBySentinel,
        "no Sentinel endpoints configured",
    ))))
}

pub struct SentinelConnection {
    settings: SentinelSettings,
    connection: Option<MultiplexedConnection>,
}

impl SentinelConnection {
    fn new(settings: SentinelSettings) -> Self {
        Self { settings, connection: None }
    }

    async fn connect(&mut self) -> RedisResult<()> {
        self.connection = Some(discover_master(&self.settings).await?);
        Ok(())
    }

    fn invalidate(&mut self, error: &RedisError) {
        if error.is_connection_dropped()
            || error.is_connection_refusal()
            || matches!(error.code(), Some("READONLY" | "MASTERDOWN"))
        {
            self.connection = None;
        }
    }

    async fn req_command(&mut self, cmd: &Cmd) -> RedisResult<Value> {
        if self.connection.is_none() {
            self.connect().await?;
        }
        let result = self.connection.as_mut().expect("connected").req_packed_command(cmd).await;
        if let Err(error) = &result {
            self.invalidate(error);
        }
        result
    }

    async fn req_commands(
        &mut self,
        pipeline: &redis::Pipeline,
        offset: usize,
        count: usize,
    ) -> RedisResult<Vec<Value>> {
        if self.connection.is_none() {
            self.connect().await?;
        }
        let result = self.connection.as_mut().expect("connected")
            .req_packed_commands(pipeline, offset, count).await;
        if let Err(error) = &result {
            self.invalidate(error);
        }
        result
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct NodeCursor {
    address: String,
    cursor: u64,
}

#[derive(Default)]
pub struct ClusterScanState {
    next_token: u64,
    active: HashMap<u64, Vec<NodeCursor>>,
    oldest: VecDeque<u64>,
}

impl ClusterScanState {
    const CAPACITY: usize = 64;

    fn get(&self, token: u64) -> RedisResult<Vec<NodeCursor>> {
        self.active.get(&token).cloned().ok_or_else(|| RedisError::from((
            redis::ErrorKind::InvalidClientConfig,
            "Redis Cluster scan cursor is unknown or expired; restart SCAN at cursor 0",
        )))
    }

    fn finish(&mut self, token: u64, nodes: Vec<NodeCursor>) -> u64 {
        self.active.remove(&token);
        if nodes.iter().all(|node| node.cursor == 0) {
            return 0;
        }
        self.next_token = self.next_token.wrapping_add(1).max(1);
        while self.active.contains_key(&self.next_token) {
            self.next_token = self.next_token.wrapping_add(1).max(1);
        }
        let next = self.next_token;
        if self.oldest.len() >= Self::CAPACITY {
            if let Some(expired) = self.oldest.pop_front() {
                self.active.remove(&expired);
            }
        }
        self.oldest.push_back(next);
        self.active.insert(next, nodes);
        next
    }
}

pub enum RedisConnection {
    Standalone(ConnectionManager),
    Cluster {
        connection: ClusterConnection,
        scans: Arc<std::sync::Mutex<ClusterScanState>>,
    },
    Sentinel {
        connection: Arc<Mutex<SentinelConnection>>,
        control: ConnectionManager,
        settings: SentinelSettings,
    },
}

impl Clone for RedisConnection {
    fn clone(&self) -> Self {
        match self {
            Self::Standalone(connection) => Self::Standalone(connection.clone()),
            Self::Cluster { connection, scans } => Self::Cluster {
                connection: connection.clone(),
                scans: scans.clone(),
            },
            Self::Sentinel { connection, control, settings } => Self::Sentinel {
                connection: connection.clone(),
                control: control.clone(),
                settings: settings.clone(),
            },
        }
    }
}

impl RedisConnection {
    pub fn standalone(connection: ConnectionManager) -> Self {
        Self::Standalone(connection)
    }

    pub async fn cluster(client: ClusterClient, connect_timeout: Duration) -> RedisResult<Self> {
        let connection = tokio::time::timeout(connect_timeout, client.get_async_connection())
            .await
            .map_err(|_| RedisError::from((
                redis::ErrorKind::IoError,
                "Redis Cluster connection timed out",
            )))??;
        Ok(Self::Cluster {
            connection,
            scans: Arc::new(std::sync::Mutex::new(ClusterScanState::default())),
        })
    }

    pub async fn sentinel(settings: SentinelSettings, control: ConnectionManager) -> RedisResult<Self> {
        let mut connection = SentinelConnection::new(settings.clone());
        connection.connect().await?;
        Ok(Self::Sentinel {
            connection: Arc::new(Mutex::new(connection)),
            control,
            settings,
        })
    }

    pub fn topology(&self) -> RedisTopology {
        match self {
            Self::Standalone(_) => RedisTopology::Standalone,
            Self::Cluster { .. } => RedisTopology::Cluster,
            Self::Sentinel { .. } => RedisTopology::Sentinel,
        }
    }

    pub fn is_cluster(&self) -> bool {
        matches!(self, Self::Cluster { .. })
    }

    pub fn sentinel_control(&self) -> Option<ConnectionManager> {
        match self {
            Self::Sentinel { control, .. } => Some(control.clone()),
            _ => None,
        }
    }

    pub async fn dedicated_connection(&self) -> RedisResult<Option<MultiplexedConnection>> {
        match self {
            Self::Cluster { .. } => Ok(None),
            Self::Standalone(_) => Ok(None),
            Self::Sentinel { settings, .. } => Ok(Some(discover_master(settings).await?)),
        }
    }

    pub async fn all_masters(&mut self, cmd: &Cmd) -> RedisResult<Option<Value>> {
        match self {
            Self::Cluster { connection, .. } => connection.route_command(
                cmd,
                RoutingInfo::MultiNode((MultipleNodeRoutingInfo::AllMasters, None)),
            ).await.map(Some),
            _ => Ok(None),
        }
    }

    pub async fn pipeline_at_slot(
        &mut self,
        pipeline: &redis::Pipeline,
        slot: Option<u16>,
    ) -> RedisResult<Vec<Value>> {
        match (self, slot) {
            (Self::Cluster { connection, .. }, Some(slot)) => {
                let count = pipeline.cmd_iter().count();
                connection.route_pipeline(
                    pipeline,
                    0,
                    count,
                    SingleNodeRoutingInfo::SpecificNode(redis::cluster_routing::Route::new(
                        slot,
                        redis::cluster_routing::SlotAddr::Master,
                    )),
                ).await
            }
            (connection, _) => pipeline.query_async(connection).await,
        }
    }

    fn scan_command(cursor: u64, pattern: &str, count: u64) -> Cmd {
        let mut cmd = redis::cmd("SCAN");
        cmd.arg(cursor).arg("MATCH").arg(pattern).arg("COUNT").arg(count);
        cmd
    }

    pub async fn scan(
        &mut self,
        pattern: &str,
        cursor: u64,
        count: u64,
    ) -> RedisResult<(u64, Vec<String>)> {
        match self {
            Self::Cluster { connection, scans } => {
                let replies = if cursor == 0 {
                    let raw = connection.route_command(
                        &Self::scan_command(0, pattern, count),
                        RoutingInfo::MultiNode((MultipleNodeRoutingInfo::AllMasters, None)),
                    ).await?;
                    parse_cluster_scan_replies(raw)?
                } else {
                    let nodes = scans.lock().expect("cluster scan state").get(cursor)?;
                    let mut replies = Vec::with_capacity(nodes.len());
                    for node in nodes {
                        if node.cursor == 0 {
                            replies.push((node.address, 0, Vec::new()));
                            continue;
                        }
                        let (host, port) = node_address_parts(&node.address)?;
                        let raw = connection.route_command(
                            &Self::scan_command(node.cursor, pattern, count),
                            RoutingInfo::SingleNode(SingleNodeRoutingInfo::ByAddress {
                                host,
                                port,
                            }),
                        ).await?;
                        let (next, keys) = parse_scan_reply(raw)?;
                        replies.push((node.address, next, keys));
                    }
                    replies
                };
                let mut keys = Vec::new();
                let nodes = replies.into_iter().map(|(address, cursor, node_keys)| {
                    keys.extend(node_keys);
                    NodeCursor { address, cursor }
                }).collect();
                let next = scans.lock().expect("cluster scan state").finish(cursor, nodes);
                Ok((next, keys))
            }
            _ => {
                let raw = Self::scan_command(cursor, pattern, count).query_async(self).await?;
                parse_scan_reply(raw)
            }
        }
    }
}

fn value_string(value: &Value) -> Option<String> {
    match value {
        Value::BulkString(bytes) => Some(String::from_utf8_lossy(bytes).into_owned()),
        Value::SimpleString(text) | Value::VerbatimString { text, .. } => Some(text.clone()),
        _ => None,
    }
}

fn parse_scan_reply(raw: Value) -> RedisResult<(u64, Vec<String>)> {
    let Value::Array(items) = raw else {
        return Err((redis::ErrorKind::ResponseError, "SCAN returned a non-array reply").into());
    };
    if items.len() != 2 {
        return Err((redis::ErrorKind::ResponseError, "SCAN returned an unexpected reply shape").into());
    }
    let cursor = match &items[0] {
        Value::Int(value) => *value as u64,
        value => value_string(value).and_then(|text| text.parse().ok()).ok_or_else(|| {
            RedisError::from((redis::ErrorKind::ResponseError, "SCAN returned an invalid cursor"))
        })?,
    };
    let Value::Array(values) = &items[1] else {
        return Err((redis::ErrorKind::ResponseError, "SCAN returned a non-array key list").into());
    };
    Ok((cursor, values.iter().filter_map(value_string).collect()))
}

fn node_address_parts(address: &str) -> RedisResult<(String, u16)> {
    let (host, port) = address.rsplit_once(':').ok_or_else(|| {
        RedisError::from((redis::ErrorKind::ResponseError, "cluster SCAN returned an invalid node address"))
    })?;
    let port = port.parse().map_err(|_| {
        RedisError::from((redis::ErrorKind::ResponseError, "cluster SCAN returned an invalid node port"))
    })?;
    Ok((host.to_string(), port))
}

fn parse_cluster_scan_replies(raw: Value) -> RedisResult<Vec<(String, u64, Vec<String>)>> {
    let Value::Map(replies) = raw else {
        return Err((redis::ErrorKind::ResponseError, "cluster SCAN returned an unexpected reply").into());
    };
    replies.into_iter().map(|(address, raw)| {
        let address = value_string(&address).ok_or_else(|| {
            RedisError::from((redis::ErrorKind::ResponseError, "cluster SCAN returned an invalid node address"))
        })?;
        let (cursor, keys) = parse_scan_reply(raw)?;
        Ok((address, cursor, keys))
    }).collect()
}

impl ConnectionLike for RedisConnection {
    fn req_packed_command<'a>(&'a mut self, cmd: &'a Cmd) -> RedisFuture<'a, Value> {
        async move {
            match self {
                Self::Standalone(connection) => connection.req_packed_command(cmd).await,
                Self::Cluster { connection, .. } => connection.req_packed_command(cmd).await,
                Self::Sentinel { connection, .. } => connection.lock().await.req_command(cmd).await,
            }
        }.boxed()
    }

    fn req_packed_commands<'a>(
        &'a mut self,
        pipeline: &'a redis::Pipeline,
        offset: usize,
        count: usize,
    ) -> RedisFuture<'a, Vec<Value>> {
        async move {
            match self {
                Self::Standalone(connection) => connection.req_packed_commands(pipeline, offset, count).await,
                Self::Cluster { connection, .. } => connection.req_packed_commands(pipeline, offset, count).await,
                Self::Sentinel { connection, .. } => connection.lock().await
                    .req_commands(pipeline, offset, count).await,
            }
        }.boxed()
    }

    fn get_db(&self) -> i64 {
        match self {
            Self::Standalone(connection) => connection.get_db(),
            Self::Cluster { .. } => 0,
            Self::Sentinel { settings, .. } => settings.db,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn topology_detection_is_explicit() {
        assert_eq!(topology_from_info("redis_mode:cluster\r\n"), RedisTopology::Cluster);
        assert_eq!(topology_from_info("redis_mode:sentinel\r\n"), RedisTopology::Sentinel);
        assert_eq!(topology_from_info("redis_mode:standalone\r\n"), RedisTopology::Standalone);
        assert_eq!(topology_from_info("redis_version:2.6.0\r\n"), RedisTopology::Standalone);
    }

    #[test]
    fn sentinel_discovery_requires_a_valid_master_address() {
        let reply = Value::Array(vec![
            Value::BulkString(b"10.0.0.8".to_vec()),
            Value::BulkString(b"6379".to_vec()),
        ]);
        assert_eq!(master_address(reply).unwrap(), ("10.0.0.8".into(), 6379));
        for invalid in [
            Value::Nil,
            Value::Array(vec![]),
            Value::Array(vec![Value::BulkString(b"host".to_vec()), Value::BulkString(b"bad".to_vec())]),
        ] {
            assert!(master_address(invalid).is_err());
        }
    }

    #[test]
    fn sentinel_never_accepts_a_replica_as_the_master() {
        assert!(role_is_master(&[Value::BulkString(b"master".to_vec())]));
        assert!(!role_is_master(&[Value::BulkString(b"slave".to_vec())]));
        assert!(!role_is_master(&[]));
    }

    #[test]
    fn cluster_node_addresses_split_without_losing_the_scheme() {
        assert_eq!(node_address_parts("redis://127.0.0.1:7001").unwrap(),
                   ("redis://127.0.0.1".into(), 7001));
        assert!(node_address_parts("not-an-address").is_err());
    }

    #[test]
    fn scan_replies_are_strictly_decoded() {
        let raw = Value::Array(vec![
            Value::BulkString(b"17".to_vec()),
            Value::Array(vec![Value::BulkString(b"txui:key".to_vec())]),
        ]);
        assert_eq!(parse_scan_reply(raw).unwrap(), (17, vec!["txui:key".into()]));
        assert!(parse_scan_reply(Value::Nil).is_err());
        assert!(parse_scan_reply(Value::Array(vec![])).is_err());
    }

    #[test]
    fn cluster_scan_tokens_track_each_master_independently() {
        let mut state = ClusterScanState::default();
        let token = state.finish(0, vec![
            NodeCursor { address: "redis://a:6379".into(), cursor: 9 },
            NodeCursor { address: "redis://b:6379".into(), cursor: 0 },
        ]);
        assert_ne!(token, 0);
        assert_eq!(state.get(token).unwrap().len(), 2);
        assert_eq!(state.finish(token, vec![
            NodeCursor { address: "redis://a:6379".into(), cursor: 0 },
            NodeCursor { address: "redis://b:6379".into(), cursor: 0 },
        ]), 0);
        assert!(state.get(token).is_err());
    }

    #[test]
    fn abandoned_cluster_scans_are_bounded_and_fail_loudly() {
        let mut state = ClusterScanState::default();
        let mut first = 0;
        for _ in 0..=ClusterScanState::CAPACITY {
            first = state.finish(0, vec![NodeCursor {
                address: "redis://a:6379".into(),
                cursor: 1,
            }]);
        }
        assert_eq!(state.active.len(), ClusterScanState::CAPACITY);
        assert!(state.get(first).is_ok());
        let expired = state.oldest.front().copied().unwrap();
        let replacement = state.finish(0, vec![NodeCursor {
            address: "redis://a:6379".into(),
            cursor: 1,
        }]);
        assert!(state.get(replacement).is_ok());
        assert!(state.get(expired).is_err());
    }
}
