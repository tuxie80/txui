//! ClickHouse driver — HTTP interface (port 8123), not the native protocol.
//!
//! That is deliberate and matches how ClickHouse is actually deployed: the
//! native port is frequently load-balancer-only or closed, while 8123 is what
//! goes through an ingress. HTTP also gives typed results for free via
//! `FORMAT JSONCompact`, which returns column names AND types alongside the
//! rows plus read statistics — richer than what the MySQL/PG wire protocols
//! hand back.
//!
//! ## Read-only is a server-side switch, not a client habit
//!
//! ClickHouse has a `readonly` setting: `readonly=1` makes the SERVER refuse
//! every non-read query, whatever the account's grants say. A read-only
//! connection therefore sends it on every request, so the guarantee does not
//! depend on the UI or on a guard getting the classification right.
//!
//! This matters more than usual here: an account can hold `ALL ON *.*` and
//! still be safe when the client pins `readonly=1` — and is emphatically not
//! safe when it forgets to.

use anyhow::Result;
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use super::types::{ColumnInfo, ConnectionConfig, PingResult, QueryResult, Row, SchemaNode, SslMode};

/// A live ClickHouse "connection". HTTP is stateless, so this is a configured
/// client plus the endpoint — there is no socket to keep alive.
#[derive(Clone)]
pub struct ChSession {
    client:   reqwest::Client,
    base_url: String,
    user:     String,
    password: String,
    database: String,
    /// Pins `readonly=1` on every request when the connection is read-only.
    read_only: bool,
    /// Server-side execution ceiling, seconds.
    max_execution_secs: u32,
    /// Per-query RAM ceiling in bytes (`max_memory_usage`). `None`/0 = no limit.
    /// Time alone won't stop an OOM, so this is the guard that does — but it is
    /// a *setting change*, which a `readonly=1` connection refuses, so it is
    /// only attached when the connection is not read-only.
    max_memory_usage: Option<u64>,
    /// Ceiling on rows scanned before the query is aborted (`max_rows_to_read`).
    /// `None`/0 = no limit. Same readonly caveat as `max_memory_usage`.
    max_rows_to_read: Option<u64>,
    /// Ceiling on bytes read before the query is aborted (`max_bytes_to_read`).
    /// `None`/0 = no limit. Same readonly caveat as `max_memory_usage`.
    max_bytes_to_read: Option<u64>,
}

impl std::fmt::Debug for ChSession {
    // Never let the password reach a log line.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ChSession")
            .field("base_url", &self.base_url)
            .field("user", &self.user)
            .field("database", &self.database)
            .field("read_only", &self.read_only)
            .finish_non_exhaustive()
    }
}

fn base_url(config: &ConnectionConfig, host_override: Option<(&str, u16)>) -> String {
    let (host, port) = host_override.unwrap_or((
        config.host.as_deref().unwrap_or("127.0.0.1"),
        config.port.unwrap_or(8123),
    ));
    // Same macOS ::1-only resolution trap the other drivers guard against.
    let host = if host_override.is_none() { super::util::pin_localhost(host) } else { host };

    format!("{}://{host}:{port}", ch_scheme(&config.ssl_mode, port))
}

/// TLS is the scheme, and the scheme is chosen once — there is no STARTTLS-style
/// negotiation on an HTTP client, so `Preferred` has to commit to one.
///
/// It commits by **port**, because ClickHouse's port convention is unambiguous:
/// 8123 is the plaintext HTTP interface, 8443 the TLS one (9000/9440 likewise
/// for the native protocol we do not speak). Guessing `https` for every
/// non-`Disable` mode — which is what this used to do — meant the default
/// connection to the standard port 8123 died in the TLS handshake with
/// `received corrupt message of type InvalidContentType`: the server had
/// answered in plain HTTP and rustls read it as a broken TLS record.
fn ch_scheme(mode: &SslMode, port: u16) -> &'static str {
    match mode {
        SslMode::Disable => "http",
        // Explicitly asked for TLS — honour it whatever the port.
        SslMode::Require | SslMode::VerifyCa | SslMode::VerifyFull => "https",
        SslMode::Preferred => match port {
            8443 | 9440 => "https",
            _ => "http",
        },
    }
}

/// Parse a PEM CA bundle into one certificate per entry.
///
/// A PEM bundle may hold a chain; reqwest parses one certificate per call, so
/// feed it each in turn or an intermediate is silently lost. The certificates
/// are ADDED to the default roots rather than replacing them, so a deployment
/// behind a private CA can still reach anything with a public certificate.
fn ca_certificates(path: &str) -> Result<Vec<reqwest::Certificate>> {
    let pem = std::fs::read(path)
        .map_err(|e| anyhow::anyhow!("CA certificate {path}: {e}"))?;
    let certs = reqwest::Certificate::from_pem_bundle(&pem)
        .map_err(|e| anyhow::anyhow!("CA certificate {path} is not valid PEM: {e}"))?;
    if certs.is_empty() {
        anyhow::bail!("CA certificate {path} contains no certificates");
    }
    Ok(certs)
}

/// Load the mutual-TLS client identity from the cert/key PEM paths.
///
/// The same two fields MySQL and PostgreSQL use: a path to a PEM client
/// certificate and a path to its PEM private key. The key stays a *file on
/// disk* — only the path is stored in connections.json, nothing goes through
/// the secret store (exactly like the other engines, whose drivers take the
/// same two paths).
///
/// Cert and key must be given together. A lone half was previously dropped
/// silently — the form looked configured and the handshake simply did not
/// authenticate — so it is now a connect-time error, matching sqlx's
/// "key and certs must be given together" on the other engines.
///
/// reqwest's rustls backend wants one PEM buffer holding the private key and
/// the certificate chain, so the two files are concatenated.
fn client_identity(cert: Option<&str>, key: Option<&str>) -> Result<Option<reqwest::Identity>> {
    let cert = cert.filter(|p| !p.is_empty());
    let key = key.filter(|p| !p.is_empty());
    match (cert, key) {
        (None, None) => Ok(None),
        (Some(c), None) => anyhow::bail!(
            "SSL client certificate {c} has no matching client key — \
             mutual TLS needs both the certificate and its private key"),
        (None, Some(k)) => anyhow::bail!(
            "SSL client key {k} has no matching client certificate — \
             mutual TLS needs both the certificate and its private key"),
        (Some(cert), Some(key)) => {
            let mut pem = std::fs::read(key)
                .map_err(|e| anyhow::anyhow!("client key {key}: {e}"))?;
            let cert_pem = std::fs::read(cert)
                .map_err(|e| anyhow::anyhow!("client certificate {cert}: {e}"))?;
            pem.push(b'\n');
            pem.extend_from_slice(&cert_pem);
            let identity = reqwest::Identity::from_pem(&pem)
                .map_err(|e| anyhow::anyhow!("client certificate/key ({cert} + {key}): {e}"))?;
            Ok(Some(identity))
        }
    }
}

pub fn open(
    config: &ConnectionConfig,
    password: Option<String>,
    host_override: Option<(&str, u16)>,
) -> Result<ChSession> {
    let timeout = Duration::from_secs(
        config.connect_timeout_secs
            .map(u64::from)
            .unwrap_or(crate::db::types::DEFAULT_CONNECT_TIMEOUT_SECS)
            .max(1),
    );
    let mut builder = reqwest::Client::builder()
        .connect_timeout(timeout)
        .user_agent("TxUI");
    // A private CA, when the connection names one. Without this the only way
    // to reach an internally-signed ingress was to weaken the mode until
    // certificates stopped being checked at all — the CA field was accepted by
    // the form and then ignored here, which is the worst of both: it looks
    // configured and verifies nothing.
    if let Some(path) = config.ssl_ca_path.as_deref().filter(|p| !p.is_empty()) {
        for cert in ca_certificates(path)? {
            builder = builder.add_root_certificate(cert);
        }
    }
    // Client-certificate (mutual TLS) auth: an internal ClickHouse ingress may
    // authenticate the client by certificate instead of (or as well as) a
    // password.
    if let Some(identity) = client_identity(
        config.ssl_cert_path.as_deref(),
        config.ssl_key_path.as_deref(),
    )? {
        builder = builder.identity(identity);
    }
    // `verify_full` is the default posture. The verification bypass belongs
    // to `Require` ALONE (libpq semantic parity: require = encrypt without
    // verify, the self-signed-ingress escape hatch); `Preferred` — the
    // DEFAULT mode — must verify whenever it lands on TLS, against the OS
    // roots / the CA loaded above. Including Preferred here meant every
    // default-configured HTTPS connection silently skipped all certificate
    // validation.
    if matches!(config.ssl_mode, SslMode::Require) {
        builder = builder.danger_accept_invalid_certs(true);
    }
    let client = builder.build()?;

    Ok(ChSession {
        client,
        base_url: base_url(config, host_override),
        user: config.user.clone().unwrap_or_else(|| "default".into()),
        password: password.unwrap_or_default(),
        database: config.database.clone().unwrap_or_else(|| "default".into()),
        read_only: config.read_only,
        // Bounded by default: an unbounded query against a large ClickHouse
        // table can run for a very long time and there is no cheap cancel over
        // HTTP once it has started.
        // `statement_timeout_secs` is the field that means this. It used to
        // read `pool_acquire_timeout_secs` — a pool-checkout knob — so raising
        // the time TxUI would wait for a free connection silently raised the
        // ceiling on every query. The old field is still honoured as a
        // fallback so existing saved connections keep their behaviour.
        max_execution_secs: config.statement_timeout_secs
            .or(config.pool_acquire_timeout_secs)
            .unwrap_or(60)
            .max(1),
        // Memory / row ceilings live in `extra_params` (the documented home for
        // ad-hoc ClickHouse session settings) so no new config field is needed;
        // the UI writes them there under their ClickHouse names. 0 / blank /
        // unparsable means "no limit" and drops the setting entirely, matching
        // `max_execution_time`'s "unset = server default" contract.
        max_memory_usage:  ch_ceiling(config, "max_memory_usage"),
        max_rows_to_read:  ch_ceiling(config, "max_rows_to_read"),
        max_bytes_to_read: ch_ceiling(config, "max_bytes_to_read"),
    })
}

/// A memory / row ceiling read from `extra_params`. Returns `None` for a
/// missing, blank, zero or non-numeric value — all of which mean "no limit" —
/// so an unset ceiling attaches nothing and leaves behaviour unchanged.
fn ch_ceiling(config: &ConnectionConfig, key: &str) -> Option<u64> {
    config.extra_params.get(key)
        .and_then(|v| v.trim().parse::<u64>().ok())
        .filter(|&n| n > 0)
}

impl ChSession {
    /// The same session pointed at another database. HTTP is stateless and
    /// `reqwest::Client` is internally reference-counted, so this is the
    /// ClickHouse equivalent of MySQL's `USE` — there is no `USE` over HTTP,
    /// the database travels as a query-string parameter on each request.
    pub fn with_database(&self, database: &str) -> ChSession {
        ChSession { database: database.to_string(), ..self.clone() }
    }

    /// The database this session resolves unqualified names against.
    pub fn database(&self) -> &str { &self.database }

    /// Settings sent with every request, as query-string pairs.
    fn settings(&self) -> Vec<(&'static str, String)> {
        let mut s = vec![
            ("database", self.database.clone()),
            ("max_execution_time", self.max_execution_secs.to_string()),
            // Return partial results instead of erroring when a row ceiling
            // is hit. Inert on its own: it takes effect when a per-query
            // `max_result_rows` rides along (post_full attaches one for the
            // editor's execute path).
            ("result_overflow_mode", "break".to_string()),
            // The house row-decoding rules depend on these three: quote 64-bit
            // integers (exactness — JSON numbers are f64), quote decimals
            // (DECIMAL arrives as an exact string, never through f64), and
            // quote denormals (NaN/±Infinity arrive as "nan"/"inf"/"-inf"
            // instead of null, which was indistinguishable from a real NULL).
            // Verified safe under readonly=1 — they are output-format knobs,
            // not behavior changes, and the server accepts them (26.8).
            ("output_format_json_quote_64bit_integers", "1".to_string()),
            ("output_format_json_quote_decimals", "1".to_string()),
            ("output_format_json_quote_denormals", "1".to_string()),
        ];
        // Memory / row ceilings are *setting changes*, and `readonly=1` refuses
        // every setting change — attaching them to a read-only request would
        // make the server reject the whole query with "Cannot modify ... in
        // readonly mode". So they ride only a read-write connection; the form
        // disables the control and says as much when READ-ONLY is on.
        if !self.read_only {
            if let Some(n) = self.max_memory_usage {
                s.push(("max_memory_usage", n.to_string()));
            }
            if let Some(n) = self.max_rows_to_read {
                s.push(("max_rows_to_read", n.to_string()));
            }
            if let Some(n) = self.max_bytes_to_read {
                s.push(("max_bytes_to_read", n.to_string()));
            }
        }
        if self.read_only {
            // The whole point: enforced by the server, not by our guard.
            s.push(("readonly", "1".to_string()));
        }
        s
    }

    /// Run a statement and return the raw body. `default_format` decides how
    /// the server renders the result.
    async fn post(&self, sql: &str, format: &str) -> Result<String> {
        self.post_with_params(sql, format, &[]).await
    }

    async fn post_with_params(
        &self, sql: &str, format: &str, query_params: &[(String, String, String)],
    ) -> Result<String> {
        self.post_full(sql, format, query_params, None, None).await
    }

    /// As `post_with_params`, but naming the query so it can be cancelled.
    ///
    /// ClickHouse over HTTP has no connection to signal — each request is
    /// stateless, and dropping the socket does not, by default, stop the query:
    /// the server carries on burning CPU for a result nobody will read. The
    /// only handle is a `query_id` we choose in advance and can later name in
    /// `KILL QUERY`.
    ///
    /// `cancel_http_readonly_queries_on_client_close` is also set, so a dropped
    /// connection stops a read on its own. It covers only read-only queries,
    /// which is why it is a complement to the explicit kill rather than a
    /// replacement for it.
    async fn post_full(
        &self,
        sql: &str,
        format: &str,
        query_params: &[(String, String, String)],
        query_id: Option<&str>,
        max_result_rows: Option<u64>,
    ) -> Result<String> {
        let mut params = self.settings();
        params.push(("default_format", format.to_string()));
        // Pairs with `result_overflow_mode=break` in settings(): without this
        // ceiling the break mode is inert and an unbounded SELECT buffers its
        // whole body. `readonly=1` refuses setting changes, so on read-only
        // sessions the cap is enforced client-side after parse instead (see
        // execute_capped_with_id).
        if let Some(cap) = max_result_rows {
            if !self.read_only {
                params.push(("max_result_rows", cap.to_string()));
            }
        }
        if let Some(id) = query_id {
            params.push(("query_id", id.to_string()));
            params.push(("cancel_http_readonly_queries_on_client_close", "1".to_string()));
            // Live progress: ClickHouse streams `X-ClickHouse-Progress` header
            // lines while the query runs, then a final `X-ClickHouse-Summary`.
            // These are HTTP-interface settings, NOT session settings, so unlike
            // `max_memory_usage` they are accepted even under `readonly=1`
            // (verified against the server) — progress works for read-only
            // analytical connections, which is where it matters most. Attached
            // only on the identified execute path so schema/scalar chatter does
            // not carry the extra headers.
            params.push(("send_progress_in_http_headers", "1".to_string()));
            params.push(("http_headers_progress_interval_ms", "200".to_string()));
        }
        // Server-side parameters: `param_<name>` carries the value, the SQL
        // references `{name:Type}`.
        let owned: Vec<(String, String)> = query_params.iter()
            .map(|(name, _ty, value)| (format!("param_{name}"), value.clone()))
            .collect();

        let resp = self.client
            .post(&self.base_url)
            .query(&params)
            .query(&owned)
            // Credentials go in headers rather than the URL: ClickHouse logs
            // the query string in system.query_log, and a password in the URL
            // would be persisted there.
            .header("X-ClickHouse-User", &self.user)
            .header("X-ClickHouse-Key", &self.password)
            .body(sql.to_string())
            .send()
            .await
            .map_err(|e| anyhow::anyhow!("{}", transport_hint(&self.base_url, &e)))?;

        let status = resp.status();
        // Capture the final read counters from the response headers before the
        // body consumes `resp`. reqwest's buffered `send()` hands back every
        // streamed `X-ClickHouse-Progress` line at once on completion, so this
        // is the *final* figure — the live, mid-flight updates come from polling
        // `system.processes` (see `query_progress`). Stored per `query_id` for
        // the caller to drain once `system.processes` no longer lists the query.
        if let Some(id) = query_id {
            if let Some(p) = progress_from_headers(resp.headers()) {
                record_header_progress(id, p);
            }
        }
        let body = resp.text().await.unwrap_or_default();
        if !status.is_success() {
            // ClickHouse puts a readable "Code: NN. DB::Exception: …" in the
            // body; the HTTP status alone says nothing useful.
            anyhow::bail!("{}", clean_error(&body));
        }
        Ok(body)
    }

    /// Single scalar, as text.
    async fn scalar(&self, sql: &str) -> Result<String> {
        Ok(self.post(sql, "TabSeparated").await?.trim().to_string())
    }

    /// Rows of strings from a TabSeparated result.
    async fn rows(&self, sql: &str) -> Result<Vec<Vec<String>>> {
        let body = self.post(sql, "TabSeparated").await?;
        Ok(body.lines()
            .filter(|l| !l.is_empty())
            .map(|l| l.split('\t').map(unescape_tsv).collect())
            .collect())
    }
}

/// ClickHouse error bodies carry a stack trace after the message; the first
/// line is the part a user can act on.
/// A failure before any ClickHouse response exists — DNS, TCP, or TLS. The
/// raw rustls/hyper text is accurate but says nothing about what to change.
fn transport_hint(base_url: &str, err: &reqwest::Error) -> String {
    let chain = {
        let mut s = err.to_string();
        let mut src = std::error::Error::source(err);
        while let Some(e) = src {
            s.push_str(&format!(": {e}"));
            src = e.source();
        }
        s
    };
    // A plaintext HTTP answer read as a TLS record. This is what a default
    // connection to port 8123 with TLS on looks like.
    let tls_onto_plaintext = chain.contains("InvalidContentType")
        || chain.contains("corrupt message")
        || chain.contains("UnexpectedEof")
        || chain.contains("unexpected end of file");
    if base_url.starts_with("https://") && tls_onto_plaintext {
        return format!(
            "{chain}\n\nThe server answered in plain HTTP but the connection tried TLS. \
             ClickHouse serves HTTP on 8123 and HTTPS on 8443 — set SSL mode to \
             'disable' for a plaintext endpoint, or point the connection at the TLS port."
        );
    }
    format!("{chain}\n\nCould not reach {base_url}.")
}

fn clean_error(body: &str) -> String {
    let first = body.lines().next().unwrap_or(body).trim();
    if first.is_empty() { return "ClickHouse returned an empty error".into(); }
    // Strip the trailing "(version …)" noise.
    let msg = match first.find(" (version ") {
        Some(i) => first[..i].trim_end().to_string(),
        None => first.to_string(),
    };
    // `readonly=1` blocks *setting changes* as well as writes, so a plain
    // SELECT carrying a SETTINGS clause fails with the same code as an INSERT.
    // Without this note the two are indistinguishable and the SELECT looks as
    // though it was refused for being a write.
    if msg.contains("Cannot modify") && msg.contains("in readonly mode") {
        return format!(
            "{msg}\n\nThis connection is READONLY, which also freezes session settings: \
a SETTINGS clause or SET is refused even on a SELECT. \
Clear READONLY on the connection to use per-query settings."
        );
    }
    msg
}

#[cfg(test)]
mod scheme_tests {
    use super::ch_scheme;
    use crate::db::types::SslMode;

    #[test]
    fn preferred_follows_the_port_convention() {
        // The regression: Preferred is the *default* ssl mode, so a connection
        // to the standard HTTP port must not attempt TLS.
        assert_eq!(ch_scheme(&SslMode::Preferred, 8123), "http");
        assert_eq!(ch_scheme(&SslMode::Preferred, 8443), "https");
        assert_eq!(ch_scheme(&SslMode::Preferred, 9440), "https");
        // Anything unconventional gets plaintext, which fails loudly and fast
        // rather than in a TLS handshake.
        assert_eq!(ch_scheme(&SslMode::Preferred, 18123), "http");
    }

    #[test]
    fn explicit_modes_ignore_the_port() {
        for m in [SslMode::Require, SslMode::VerifyCa, SslMode::VerifyFull] {
            assert_eq!(ch_scheme(&m, 8123), "https", "{m:?} on 8123");
        }
        assert_eq!(ch_scheme(&SslMode::Disable, 8443), "http");
    }
}

#[cfg(test)]
mod progress_tests {
    use super::{parse_progress_header, ChProgress};

    #[test]
    fn parses_a_real_progress_header() {
        // Captured verbatim from an X-ClickHouse-Progress header on a live
        // server: the numbers arrive as JSON *strings*, not bare numbers.
        let v = r#"{"read_rows":"67371270","read_bytes":"538970160","total_rows_to_read":"2000000000","elapsed_ns":"794342241","memory_usage":"4096"}"#;
        assert_eq!(parse_progress_header(v), Some(ChProgress {
            read_rows:  67_371_270,
            read_bytes: 538_970_160,
            total_rows: 2_000_000_000,
            elapsed_ns: 794_342_241,
        }));
    }

    #[test]
    fn parses_the_final_summary_header() {
        // X-ClickHouse-Summary carries extra fields we ignore and the exact
        // final totals we keep.
        let v = r#"{"read_rows":"2000000000","read_bytes":"16000000000","written_rows":"0","written_bytes":"0","total_rows_to_read":"2000000000","result_rows":"0","result_bytes":"0","elapsed_ns":"5169822230","memory_usage":"4096"}"#;
        let p = parse_progress_header(v).expect("summary parses");
        assert_eq!(p.read_rows, 2_000_000_000);
        assert_eq!(p.total_rows, 2_000_000_000);
        assert_eq!(p.elapsed_ns, 5_169_822_230);
    }

    #[test]
    fn missing_total_degrades_to_zero() {
        // Older servers / unbounded queries omit the estimate; the UI treats
        // total_rows == 0 as "no percentage available".
        let v = r#"{"read_rows":"10","read_bytes":"80"}"#;
        assert_eq!(parse_progress_header(v), Some(ChProgress {
            read_rows: 10, read_bytes: 80, total_rows: 0, elapsed_ns: 0,
        }));
    }

    #[test]
    fn non_json_is_none() {
        assert_eq!(parse_progress_header("not json"), None);
        assert_eq!(parse_progress_header(""), None);
    }
}

#[cfg(test)]
mod tls_tests {
    use super::{ca_certificates, client_identity};

    // A throwaway self-signed pair generated with openssl purely as a parse
    // fixture: it proves PEM loading and the rustls identity build, not a live
    // handshake (no server exists in the test environment).
    const CERT_PEM: &str = "-----BEGIN CERTIFICATE-----\n\
MIIDFzCCAf+gAwIBAgIUCpR+ms+FiW11b2C+PkAWT8RuSrcwDQYJKoZIhvcNAQEL\n\
BQAwGzEZMBcGA1UEAwwQdHh1aS10ZXN0LWNsaWVudDAeFw0yNjA4MjMxNTMyMDFa\n\
Fw0zNjA4MjAxNTMyMDFaMBsxGTAXBgNVBAMMEHR4dWktdGVzdC1jbGllbnQwggEi\n\
MA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQDiXy777Lhm6wgKhdaQWWZ66Kb2\n\
lvkfLDaN6iwYliffn0FF4Ie+nqeVxPCdwZgvZTBngonBDQ2Nl6hB2J2mQRLekXv0\n\
aUHkLSxxjyWnv6fPwOhYIOrvm8+spwWwsDklOR3khIimcXKCAih5+1WvSuxAHFSQ\n\
h5RHCHgQYd1ZHiO5KAsP6SKLMzFUSREnCS7oBTItNjNAEOaTTm3Zf3bRZNtOzMv7\n\
+BUACd/v+38lFYsFtySVwlQXbtqzDvwRkZXpOA+Geg37+QSzHN9bw0j65jdb0hsO\n\
IAEIvlYU5N+tifvgDBVdAdU6DYDkuaDG0htkS/uQK+XxCs8SGt8YASOO+SaBAgMB\n\
AAGjUzBRMB0GA1UdDgQWBBSZqHh7NRBiafYyw7QwUr5b61SgYTAfBgNVHSMEGDAW\n\
gBSZqHh7NRBiafYyw7QwUr5b61SgYTAPBgNVHRMBAf8EBTADAQH/MA0GCSqGSIb3\n\
DQEBCwUAA4IBAQAkf0dUa4pZ0scaXOR82g5eSL8cVMhnBeMOzRirRoWiQ6Wea7W2\n\
29G04BdsrVxOCnFOGjF/JMDFmMxxIl0BFZYYf+7LkeNFKX+0Ua/Qge7uxhGUxlGR\n\
Su4BhDqMyIKKR4MF+SzqJOtSdnTULmU10IcxOCOfBIQTQOmMA0QFfSGbN4qflvw3\n\
vLvA33MJFvzcoRHe2YvL/l1eXNRJJh+T1WXeMeBbFQv5P8Uhp1I85ItEfVGiV+ew\n\
dxClf5UgLS6Fmt1Ecy7prDJASEghhgD2bNR1QlQwjnx9Q91ht7mTc4natM2jO3ts\n\
G9N0NCuK8QQyBg+D8+hSo22dJuuFtCHO7xv6\n\
-----END CERTIFICATE-----\n";

    const KEY_PEM: &str = "-----BEGIN PRIVATE KEY-----\n\
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQDiXy777Lhm6wgK\n\
hdaQWWZ66Kb2lvkfLDaN6iwYliffn0FF4Ie+nqeVxPCdwZgvZTBngonBDQ2Nl6hB\n\
2J2mQRLekXv0aUHkLSxxjyWnv6fPwOhYIOrvm8+spwWwsDklOR3khIimcXKCAih5\n\
+1WvSuxAHFSQh5RHCHgQYd1ZHiO5KAsP6SKLMzFUSREnCS7oBTItNjNAEOaTTm3Z\n\
f3bRZNtOzMv7+BUACd/v+38lFYsFtySVwlQXbtqzDvwRkZXpOA+Geg37+QSzHN9b\n\
w0j65jdb0hsOIAEIvlYU5N+tifvgDBVdAdU6DYDkuaDG0htkS/uQK+XxCs8SGt8Y\n\
ASOO+SaBAgMBAAECggEAAOhQoGDdvEevrPDsdoBtpas9i4JFx75WGyavzDe8FSLj\n\
k8YPetmfUoPbOS5G7KGEF2KJqEj9b4tNH0BA+u/dy9LebqrGQV9wr/70b8O+Zo0V\n\
5imLa5AiBCwL8BFqyNRXaalVQQHC+Hqz/Elmk09Y2yjWtwwcflYbB7Zh7E4pJqaj\n\
CfEUyHOsxQW1h2wu8iR0XutJNJ5OvFRbrSMnVebP5Bs2Cs/LF4zrYeVqqmtRHqhJ\n\
jV115+n+7ZCIPwSWlLOQqxLgwaV8ZcKX/qAMZvEI54eVbXySAzplBRFt3SMcR1KJ\n\
tJU/KjYg4riL1NuvTjyOCPwv3QhBRLWid/o8DsABgQKBgQD0rY7HazPWYOpYml9H\n\
TXdU2vJuX6GRHL1znLJI+sRDsEXyodcCVo27J85nBh4wvGchO/1nuejTjsi3kpjD\n\
jyIgbcKMhDivjmvkmfr4BjY8E7VoARJC6/E8xgIbCCIOfyhOJKotBgsl79dyDo53\n\
hQVw1uBYpCuB/ZN2KfxT+YO4oQKBgQDs2MWpjnyw+ATnb6OHWzewq68ZkosAwFvq\n\
YjB5CGWyX4FSG2qD0hT+1oyr7WLXDzT2zYpK4f3vmYiv4ANrZFhee05D4th6tdyO\n\
F7ULkE/1RmshuS8RZq2gsGZztMDmNX0GURDYKQFDD1szdzs49ZqDq1C3vb0sCKmh\n\
+CAC4HNB4QKBgQDcBbov/2nE7K+vb1ogbzvQtXZt5FcQe8ytSwpTcBTPXZL45anH\n\
83dOBjSoFitN3g3LJ/vuq5H/tBUwZoYyzOJ+UNUysK+cxrClCAZTxJo+meZ2GQiH\n\
3022PcSk9EJT0Oq4omXZSOb7fVq6uPZJ6feDieaCL1bkdNeG2aiLBwP5IQKBgQCU\n\
sg9+wRcln8CscFlxbGJNR6w52NfuE9ZhE14tTolScEVngBDiS62kxJwygGnSbRiq\n\
biaJltJvb6vyByj+blRQlQdw9WVFvRGIH/gpF2QrsBcoZ/PV7+nH/ZeEwxFsNl6U\n\
7aYun6fMK0Ltz8hdnUxxp8eYY8X1dEbTikzGoZWa4QKBgEDjFtt4s6byBx+E9jg7\n\
pq3JKYfAuoEjJqmuEW/NXHJQucfYGycMtXcH9pihkSmA+G7ENE2FWpneQ6P4Bmdg\n\
Lb3KasJQntA3Y1FaMfhr4AKxy6iRn7n4k0xqyfn7D2gY6xFdHEW6JYKCm2mQs/+g\n\
TSnPVkpPKYhqGePtdGJoaXGf\n\
-----END PRIVATE KEY-----\n";

    fn fixture(name: &str, pem: &str) -> String {
        let dir = std::env::temp_dir().join(format!("txui-ch-tls-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(name);
        std::fs::write(&path, pem).unwrap();
        path.to_string_lossy().into_owned()
    }

    #[test]
    fn no_paths_means_no_identity() {
        assert!(client_identity(None, None).unwrap().is_none());
        // Blank paths are the form's "field left empty" — same as absent.
        assert!(client_identity(Some(""), Some("")).unwrap().is_none());
    }

    #[test]
    fn a_lone_cert_or_key_is_a_config_error_not_silently_dropped() {
        let err = client_identity(Some("/nonexistent/cert.pem"), None).unwrap_err().to_string();
        assert!(err.contains("client key"), "{err}");
        let err = client_identity(None, Some("/nonexistent/key.pem")).unwrap_err().to_string();
        assert!(err.contains("client certificate"), "{err}");
    }

    #[test]
    fn missing_files_name_which_side_failed() {
        let err = client_identity(
            Some("/nonexistent/cert.pem"), Some("/nonexistent/key.pem"),
        ).unwrap_err().to_string();
        assert!(err.contains("client key /nonexistent/key.pem"), "{err}");
    }

    #[test]
    fn a_valid_pair_builds_an_identity() {
        let cert = fixture("client-cert.pem", CERT_PEM);
        let key = fixture("client-key.pem", KEY_PEM);
        assert!(client_identity(Some(&cert), Some(&key)).unwrap().is_some());
    }

    #[test]
    fn garbage_pem_is_rejected_with_both_paths_named() {
        let cert = fixture("garbage-cert.pem", "not a pem\n");
        let key = fixture("garbage-key.pem", "also not a pem\n");
        let err = client_identity(Some(&cert), Some(&key)).unwrap_err().to_string();
        assert!(err.contains(&cert) && err.contains(&key), "{err}");
    }

    #[test]
    fn ca_bundle_parses_and_empty_bundle_is_an_error() {
        let ca = fixture("ca.pem", CERT_PEM);
        assert_eq!(ca_certificates(&ca).unwrap().len(), 1);

        let empty = fixture("empty-ca.pem", "# just a comment\n");
        assert!(ca_certificates(&empty).unwrap_err().to_string()
            .contains("no certificates"));
        // A block whose body is not base64 fails the PEM armour decode. (A
        // well-armoured but garbage DER block is accepted — rustls wraps the
        // bytes without parsing them; it only fails at handshake time.)
        let corrupt = fixture("corrupt-ca.pem",
            "-----BEGIN CERTIFICATE-----\n!!!\n-----END CERTIFICATE-----\n");
        assert!(ca_certificates(&corrupt).unwrap_err().to_string()
            .contains("not valid PEM"));
    }
}

#[cfg(test)]
mod error_tests {
    use super::clean_error;

    #[test]
    fn strips_version_noise_and_stack_trace() {
        let e = clean_error(
            "Code: 60. DB::Exception: Unknown table expression identifier 'nope' (version 26.7.2.59 (official build))\nstack trace follows",
        );
        assert_eq!(e, "Code: 60. DB::Exception: Unknown table expression identifier 'nope'");
    }

    #[test]
    fn readonly_setting_refusal_is_explained() {
        // A SELECT with a SETTINGS clause fails with the same READONLY code as
        // an INSERT — the user needs to know which of the two happened.
        let e = clean_error(
            "Code: 164. DB::Exception: Cannot modify 'max_threads' setting in readonly mode. (READONLY) (version 26.7.2.59 (official build))",
        );
        assert!(e.starts_with("Code: 164."), "{e}");
        assert!(e.contains("SETTINGS clause"), "{e}");

        // A refused *write* must NOT get the settings explanation.
        let w = clean_error(
            "Code: 164. DB::Exception: dolphie: Cannot execute query in readonly mode. (READONLY) (version 26.7.2.59 (official build))",
        );
        assert!(!w.contains("SETTINGS clause"), "{w}");
        assert_eq!(w, "Code: 164. DB::Exception: dolphie: Cannot execute query in readonly mode. (READONLY)");
    }

    #[test]
    fn empty_body_still_says_something() {
        assert_eq!(clean_error("   "), "ClickHouse returned an empty error");
    }
}

/// TabSeparated escapes \t, \n and \\ inside values.
fn unescape_tsv(s: &str) -> String {
    if !s.contains('\\') { return s.to_string(); }
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars();
    while let Some(c) = chars.next() {
        if c != '\\' { out.push(c); continue; }
        match chars.next() {
            Some('t')  => out.push('\t'),
            Some('n')  => out.push('\n'),
            Some('r')  => out.push('\r'),
            Some('\\') => out.push('\\'),
            // ClickHouse's TabSeparated escaping also covers \' \b \f \0 —
            // without the quote, engine_full of a Distributed table comes
            // back as \'cluster\' and the args parser chokes on it.
            Some('\'') => out.push('\''),
            Some('b')  => out.push('\u{8}'),
            Some('f')  => out.push('\u{c}'),
            Some('0')  => out.push('\0'),
            Some('N')  => out.push_str("\\N"), // NULL marker, kept visible
            Some(other) => { out.push('\\'); out.push(other); }
            None => out.push('\\'),
        }
    }
    out
}

// ── Ping ─────────────────────────────────────────────────────────────────────

pub async fn ping(config: &ConnectionConfig, password: Option<String>) -> PingResult {
    let start = Instant::now();
    let session = match open(config, password, None) {
        Ok(s) => s,
        Err(e) => return PingResult {
            ok: false, latency_ms: 0, server_version: None, error: Some(e.to_string()),
        },
    };
    match session.scalar("SELECT version()").await {
        Ok(v) => PingResult {
            ok: true,
            latency_ms: start.elapsed().as_millis() as u64,
            server_version: Some(v),
            error: None,
        },
        Err(e) => PingResult {
            ok: false,
            latency_ms: start.elapsed().as_millis() as u64,
            server_version: None,
            error: Some(e.to_string()),
        },
    }
}

// ── Live query progress ──────────────────────────────────────────────────────
//
// ClickHouse is the only engine here that can report a running query's read
// counters mid-flight. Two sources feed one struct:
//   * `system.processes` — polled while the query runs, for genuinely live
//     rows/bytes/total (see `query_progress`);
//   * the `X-ClickHouse-Progress` / `X-ClickHouse-Summary` response headers —
//     read once on completion for the exact final figure, since the process
//     row vanishes the instant the query ends.

/// A snapshot of a ClickHouse query's read progress. `total_rows` is `0` when
/// the server cannot estimate the work (e.g. a query with no scan bound) — the
/// UI degrades to rows/bytes only in that case.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, serde::Serialize)]
pub struct ChProgress {
    pub read_rows:  u64,
    pub read_bytes: u64,
    pub total_rows: u64,
    pub elapsed_ns: u64,
}

/// Parse one `X-ClickHouse-Progress` / `X-ClickHouse-Summary` header value.
///
/// ClickHouse encodes the counters as a JSON object whose numbers are *quoted
/// strings* — `{"read_rows":"65409","read_bytes":"523272",…}` — so a plain
/// numeric deserialize would fail; each field is parsed leniently and a missing
/// one reads as 0. Returns `None` only when the value is not JSON at all.
pub fn parse_progress_header(value: &str) -> Option<ChProgress> {
    let v: serde_json::Value = serde_json::from_str(value).ok()?;
    let obj = v.as_object()?;
    let num = |k: &str| -> u64 {
        match obj.get(k) {
            Some(serde_json::Value::String(s)) => s.trim().parse().unwrap_or(0),
            Some(serde_json::Value::Number(n)) => n.as_u64().unwrap_or(0),
            _ => 0,
        }
    };
    Some(ChProgress {
        read_rows:  num("read_rows"),
        read_bytes: num("read_bytes"),
        // `Summary` and `Progress` both name the estimate `total_rows_to_read`.
        total_rows: num("total_rows_to_read"),
        elapsed_ns: num("elapsed_ns"),
    })
}

/// The final progress from a completed response: `X-ClickHouse-Summary` carries
/// the authoritative totals; the last `X-ClickHouse-Progress` line is the
/// fallback on a server/response that omits the summary.
fn progress_from_headers(headers: &reqwest::header::HeaderMap) -> Option<ChProgress> {
    headers.get("X-ClickHouse-Summary")
        .or_else(|| headers.get_all("X-ClickHouse-Progress").iter().next_back())
        .and_then(|v| v.to_str().ok())
        .and_then(parse_progress_header)
}

/// Per-`query_id` store of the final header-reported progress. A query id is a
/// UUID chosen per run, so entries are unique; each is drained exactly once by
/// `take_progress`, and any that is never drained (e.g. a query that errored
/// before completion) is overwritten by the next run's — the map cannot grow
/// without bound because ids are not reused.
fn header_progress_store() -> &'static Mutex<HashMap<String, ChProgress>> {
    static STORE: OnceLock<Mutex<HashMap<String, ChProgress>>> = OnceLock::new();
    STORE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn record_header_progress(query_id: &str, p: ChProgress) {
    if let Ok(mut m) = header_progress_store().lock() {
        m.insert(query_id.to_string(), p);
    }
}

/// Take (and remove) the final header-reported progress for a query id, if the
/// response for it has completed. Used to emit one last, exact update after the
/// live `system.processes` row is gone.
pub fn take_progress(query_id: &str) -> Option<ChProgress> {
    header_progress_store().lock().ok()?.remove(query_id)
}

/// Live progress of an in-flight query, read from `system.processes`.
///
/// Returns `None` when the id is not listed — the query has not started yet, or
/// has already finished (its row is dropped the moment it ends). The id is
/// bound as a server-side parameter, never concatenated, exactly like
/// `kill_query`.
pub async fn query_progress(session: &ChSession, query_id: &str) -> Result<Option<ChProgress>> {
    let body = session.post_with_params(
        "SELECT read_rows, read_bytes, total_rows_approx, toUInt64(elapsed * 1e9) \
         FROM system.processes WHERE query_id = {qid:String} LIMIT 1",
        "TabSeparated",
        &[("qid".to_string(), "String".to_string(), query_id.to_string())],
    ).await?;
    let line = body.lines().next().map(str::trim).unwrap_or("");
    if line.is_empty() { return Ok(None); }
    let cols: Vec<u64> = line.split('\t')
        .map(|s| s.trim().parse().unwrap_or(0))
        .collect();
    Ok(Some(ChProgress {
        read_rows:  cols.first().copied().unwrap_or(0),
        read_bytes: cols.get(1).copied().unwrap_or(0),
        total_rows: cols.get(2).copied().unwrap_or(0),
        elapsed_ns: cols.get(3).copied().unwrap_or(0),
    }))
}

// ── Query execution ──────────────────────────────────────────────────────────

#[derive(serde::Deserialize)]
struct JsonCompactMeta { name: String, #[serde(rename = "type")] ty: String }

#[derive(serde::Deserialize)]
struct JsonCompactBody {
    meta: Vec<JsonCompactMeta>,
    data: Vec<Vec<serde_json::Value>>,
    #[serde(default)]
    statistics: Option<JsonCompactStats>,
}

#[derive(serde::Deserialize)]
struct JsonCompactStats {
    #[serde(default)] elapsed: f64,
    #[serde(default)] rows_read: u64,
    #[serde(default)] bytes_read: u64,
}

pub async fn execute(session: &ChSession, sql: &str) -> Result<QueryResult> {
    execute_with_params(session, sql, &[]).await
}

/// Execute under a caller-chosen `query_id`, so it can be cancelled.
///
/// The id must be unique on the server: ClickHouse rejects a second query
/// carrying an id already in flight (unless `replace_running_query` is set),
/// which is why callers pass a UUID rather than anything derived from the tab.
pub async fn execute_with_id(
    session: &ChSession, sql: &str, query_id: &str,
) -> Result<QueryResult> {
    execute_capped_with_id(session, sql, query_id, None).await
}

/// As `execute_with_id` with a row cap: the server is asked for at most
/// `cap + 1` rows (`max_result_rows` + the `result_overflow_mode=break` the
/// session always sends), and the client truncates to `cap` — receiving the
/// extra row is what distinguishes "truncated" from "exactly cap rows". On
/// read-only sessions the server refuses setting changes, so the body is
/// unbounded there and only the client-side cut applies.
pub async fn execute_capped_with_id(
    session: &ChSession, sql: &str, query_id: &str, max_rows: Option<usize>,
) -> Result<QueryResult> {
    let start = Instant::now();
    let body = session
        .post_full(sql, "JSONCompact", &[], Some(query_id), max_rows.map(|n| n as u64 + 1))
        .await?;
    let mut r = decode_json_compact(body, start)?;
    if let Some(cap) = max_rows {
        if r.rows.len() > cap {
            r.rows.truncate(cap);
            r.truncated = true;
        }
    }
    Ok(r)
}

/// Stop a running query by id. Best effort, like every other cancel here.
///
/// `KILL QUERY` is asynchronous by default — it sets a flag the running query
/// notices at its next interrupt point. `SYNC` is deliberately not used: it
/// blocks until the query actually stops, which for a query stuck in a long
/// merge or a remote read is exactly as long as doing nothing, and it would
/// hold the UI while pretending to be decisive.
///
/// The id is bound as a server-side parameter, never concatenated: a `query_id`
/// is an opaque string that has been round-tripped through the frontend.
pub async fn kill_query(session: &ChSession, query_id: &str) -> Result<()> {
    session.post_with_params(
        "KILL QUERY WHERE query_id = {qid:String} ASYNC",
        "TabSeparated",
        &[("qid".to_string(), "String".to_string(), query_id.to_string())],
    ).await?;
    Ok(())
}

/// Execute with ClickHouse server-side query parameters.
///
/// Each entry is (name, type, value): the SQL references `{name:Type}` and the
/// value travels as `param_<name>`. ClickHouse substitutes it AFTER parsing, so
/// a value can never be interpreted as SQL — this is the equivalent of the
/// bound parameters the SQL drivers get for free.
pub async fn execute_with_params(
    session: &ChSession,
    sql: &str,
    params: &[(String, String, String)],
) -> Result<QueryResult> {
    let start = Instant::now();
    let body = session.post_with_params(sql, "JSONCompact", params).await?;
    decode_json_compact(body, start)
}

/// Turn a `JSONCompact` body into a result set.
///
/// Shared by the plain and the cancellable path — two copies would drift, and
/// the difference between them (how the request was labelled) has nothing to do
/// with how the answer is read.
fn decode_json_compact(body: String, start: Instant) -> Result<QueryResult> {
    // A statement with no result set (DDL, SET, …) returns an empty body.
    if body.trim().is_empty() {
        return Ok(QueryResult {
            columns: vec![],
            rows: vec![],
            rows_affected: Some(0),
            execution_ms: start.elapsed().as_millis() as u64,
            fetch_ms: 0,
            warnings: vec![],
            truncated: false,
        });
    }

    let parsed: JsonCompactBody = serde_json::from_str(&body)
        .map_err(|e| anyhow::anyhow!("could not parse ClickHouse response: {e}"))?;

    let columns: Vec<ColumnInfo> = parsed.meta.iter().map(|m| ColumnInfo {
        name: m.name.clone(),
        type_name: m.ty.clone(),
        // ClickHouse types are non-nullable unless wrapped.
        nullable: m.ty.starts_with("Nullable(") || m.ty.contains("Nullable("),
    }).collect();

    let mut rows: Vec<Row> = parsed.data;
    // The wire format obeys the quoting settings we attach (see settings()):
    // apply the house decoding rules per column type.
    for row in rows.iter_mut() {
        for (cell, col) in row.iter_mut().zip(columns.iter()) {
            normalize_cell(&col.type_name, cell);
        }
    }

    // The server reports its own execution time, which excludes the network
    // hop — more honest than measuring the round trip and calling it execution.
    let (execution_ms, warnings) = match parsed.statistics {
        Some(s) => (
            (s.elapsed * 1000.0) as u64,
            vec![format!("read {} rows / {} bytes", s.rows_read, s.bytes_read)],
        ),
        None => (start.elapsed().as_millis() as u64, vec![]),
    };
    let total = start.elapsed().as_millis() as u64;

    Ok(QueryResult {
        columns,
        rows,
        rows_affected: None,
        execution_ms,
        fetch_ms: total.saturating_sub(execution_ms),
        warnings,
        truncated: false,
    })
}

/// Peel `Nullable(…)` / `LowCardinality(…)` wrappers: the wire value follows
/// the INNER type regardless of how many of these surround it.
fn core_type(mut ty: &str) -> &str {
    loop {
        if ty.starts_with("Nullable(") && ty.ends_with(')') {
            ty = &ty["Nullable(".len()..ty.len() - 1];
        } else if ty.starts_with("LowCardinality(") && ty.ends_with(')') {
            ty = &ty["LowCardinality(".len()..ty.len() - 1];
        } else {
            return ty;
        }
    }
}

/// Bring one JSONCompact cell in line with the house decoding rules, given its
/// column type. With the quoting settings this driver attaches (settings()):
///
/// - 64-bit integers arrive as strings — parsed back into exact JSON numbers
///   (serde_json holds a full u64/i64; only values within ±2^53 survive the
///   webview's own JSON, same as every driver here).
/// - DECIMAL arrives as a string and STAYS a string — never through f64.
/// - NaN/±Infinity arrive as "nan"/"inf"/"-inf" and become the house string
///   sentinels ("NaN"/"Infinity"/"-Infinity", the duckdb.rs spelling), never
///   NULL.
///
/// Anything else passes through untouched, and a parse that fails leaves the
/// original value alone — a weird cell must never masquerade as NULL.
fn normalize_cell(ty: &str, v: &mut serde_json::Value) {
    use serde_json::Value as J;
    let core = core_type(ty);
    // Reborrow — matching on `v` itself would move the &mut.
    match (core, &mut *v) {
        (t, J::String(s))
            if matches!(t, "Int64" | "UInt64" | "Int32" | "UInt32" | "Int16" | "UInt16" | "Int8" | "UInt8" | "Int128" | "UInt128" | "Int256" | "UInt256") =>
        {
            // 128/256-bit integers exceed serde_json's range — keep the string.
            if matches!(t, "Int128" | "UInt128" | "Int256" | "UInt256") { return; }
            if let Ok(u) = s.parse::<u64>() { *v = J::from(u); }
            else if let Ok(i) = s.parse::<i64>() { *v = J::from(i); }
        }
        ("Float32" | "Float64", J::String(s)) => {
            match s.to_ascii_lowercase().as_str() {
                "nan" => *v = J::from("NaN"),
                "inf" | "+inf" | "infinity" | "+infinity" => *v = J::from("Infinity"),
                "-inf" | "-infinity" => *v = J::from("-Infinity"),
                _ => {}
            }
        }
        _ => {}
    }
}

// ── Schema tree ──────────────────────────────────────────────────────────────

fn esc(s: &str) -> String { s.replace('\'', "\\'") }

/// Parse the `(cluster, database, table[, sharding_key, …])` arguments of a
/// `Distributed(...)` engine as it appears in `system.tables.engine_full`.
///
/// Only the first three positional arguments matter, and only top-level commas
/// separate them — so a later `sharding_key` such as `cityHash64(a, b)` never
/// confuses the split (nested parens are tracked, and we stop after three).
/// Surrounding single quotes / backticks are stripped from each.
fn parse_distributed_args(engine_full: &str) -> Option<(String, String, String)> {
    let open = engine_full.find('(')?;
    let close = engine_full.rfind(')')?;
    if close <= open { return None; }
    let inner = &engine_full[open + 1..close];

    let mut args: Vec<String> = Vec::new();
    let mut cur = String::new();
    let mut depth = 0i32;
    let mut in_str = false;
    for c in inner.chars() {
        match c {
            '\'' => { in_str = !in_str; cur.push(c); }
            '(' if !in_str => { depth += 1; cur.push(c); }
            ')' if !in_str => { depth -= 1; cur.push(c); }
            ',' if !in_str && depth == 0 => {
                args.push(cur.trim().to_string());
                cur.clear();
                if args.len() == 3 { break; }
            }
            _ => cur.push(c),
        }
    }
    if args.len() < 3 && !cur.trim().is_empty() { args.push(cur.trim().to_string()); }
    if args.len() < 3 { return None; }

    let unq = |s: &str| s.trim().trim_matches('\'').trim_matches('`').to_string();
    Some((unq(&args[0]), unq(&args[1]), unq(&args[2])))
}

/// Read the target identifier that follows a `TO ` clause: `db`.`tbl`, db.tbl,
/// `tbl` or tbl. Terminates at the first unquoted whitespace or `(` (the column
/// list). Backticks are dropped; a `db.table` split is by the first unquoted
/// dot.
fn read_target_token(s: &str) -> (String, Option<String>) {
    let mut raw = String::new();
    let mut in_bt = false;
    let mut dot: Option<usize> = None;
    for c in s.trim_start().chars() {
        match c {
            '`' => in_bt = !in_bt,
            '.' if !in_bt && dot.is_none() => { dot = Some(raw.len()); raw.push(c); }
            c if !in_bt && (c.is_whitespace() || c == '(') => break,
            c => raw.push(c),
        }
    }
    match dot {
        Some(i) => (raw[..i].to_string(), Some(raw[i + 1..].to_string())),
        None    => (raw, None),
    }
}

/// Resolve the storage table a `MaterializedView` writes into. An explicit
/// `TO db.tbl` in the DDL wins; otherwise ClickHouse uses an implicit inner
/// table — `.inner_id.<uuid>` for an Atomic database (non-zero uuid), or the
/// legacy `.inner.<mv_name>` for an Ordinary one.
fn parse_mv_target(create_query: &str, mv_db: &str, mv_name: &str, uuid: &str) -> (String, String) {
    // The `TO` clause sits in the header, before the `AS SELECT` body — search
    // only there so a `TO` inside the query text can never be mistaken for it.
    let upper = create_query.to_uppercase();
    let head_end = upper.find(" AS SELECT").unwrap_or(create_query.len());
    if let Some(pos) = upper[..head_end].find(" TO ") {
        let (a, b) = read_target_token(&create_query[pos + 4..]);
        if !a.is_empty() {
            return match b {
                Some(tbl) => (a, tbl),
                None      => (mv_db.to_string(), a),
            };
        }
    }
    const ZERO: &str = "00000000-0000-0000-0000-000000000000";
    let inner = if !uuid.is_empty() && uuid != ZERO {
        format!(".inner_id.{uuid}")
    } else {
        format!(".inner.{mv_name}")
    };
    (mv_db.to_string(), inner)
}

/// Top level: databases.
pub async fn list_databases(session: &ChSession) -> Result<Vec<SchemaNode>> {
    let rows = session.rows(
        "SELECT name FROM system.databases \
         WHERE name NOT IN ('INFORMATION_SCHEMA','information_schema') ORDER BY name"
    ).await?;
    Ok(rows.into_iter()
        .filter_map(|r| r.into_iter().next())
        .map(|name| SchemaNode::Database { name })
        .collect())
}

pub async fn list_schema(session: &ChSession, database: Option<&str>) -> Result<Vec<SchemaNode>> {
    match database {
        Some(db) => list_tables(session, db).await,
        None => list_databases(session).await,
    }
}

/// Tables, views and materialized views inside a database.
///
/// ClickHouse's engine IS the object's nature — a `MaterializedView` and a
/// `MergeTree` are both rows in system.tables — so the engine decides which
/// tree node kind each one becomes.
pub async fn list_tables(session: &ChSession, database: &str) -> Result<Vec<SchemaNode>> {
    let rows = session.rows(&format!(
        "SELECT name, engine, engine_full FROM system.tables WHERE database = '{}' ORDER BY engine, name",
        esc(database)
    )).await?;

    let ns = Some(database.to_string());
    Ok(rows.into_iter().filter_map(|r| {
        let name = r.first()?.clone();
        let engine = r.get(1).cloned().unwrap_or_default();
        Some(match engine.as_str() {
            "View"             => SchemaNode::View { name, schema: ns.clone() },
            "MaterializedView" => SchemaNode::MatView { name, schema: ns.clone() },
            "Dictionary"       => SchemaNode::Routine {
                name, schema: ns.clone(), routine_type: "DICTIONARY".into(),
            },
            // A Distributed table is a proxy over a per-shard local table — its
            // engine args name the cluster and that local `db.table`. Falls back
            // to a plain table if the args are unexpectedly unparseable.
            "Distributed" => {
                let engine_full = r.get(2).cloned().unwrap_or_default();
                match parse_distributed_args(&engine_full) {
                    Some((cluster, target_db, target_table)) => {
                        // `currentDatabase()` (or an empty db arg) means the
                        // Distributed table's own database.
                        let target_db = if target_db.is_empty() || target_db.contains("currentDatabase") {
                            database.to_string()
                        } else { target_db };
                        SchemaNode::Distributed {
                            name, schema: ns.clone(), cluster, target_db, target_table,
                        }
                    }
                    None => SchemaNode::Table {
                        name, schema: ns.clone(), row_count: None, partition_of: None, temporal: false,
                    },
                }
            }
            _ => SchemaNode::Table { name, schema: ns.clone(), row_count: None, partition_of: None, temporal: false },
        })
    }).collect())
}

/// Columns and data-skipping indices for one table.
///
/// The column list carries what a ClickHouse user actually needs and no other
/// engine exposes: the compression codec, and whether the column participates
/// in the partition / sorting / primary key.
pub async fn list_columns(session: &ChSession, database: &str, table: &str) -> Result<Vec<SchemaNode>> {
    let cols = session.rows(&format!(
        "SELECT name, type, compression_codec, is_in_partition_key, is_in_sorting_key, is_in_primary_key \
         FROM system.columns WHERE database = '{}' AND table = '{}' ORDER BY position",
        esc(database), esc(table)
    )).await?;

    let mut nodes: Vec<SchemaNode> = cols.into_iter().filter_map(|r| {
        let name = r.first()?.clone();
        let ty = r.get(1).cloned().unwrap_or_default();
        let codec = r.get(2).cloned().unwrap_or_default();
        let in_pk = r.get(5).map(|v| v == "1").unwrap_or(false);
        // Surface the codec next to the type — it is the single most
        // consequential per-column choice in ClickHouse.
        let type_name = if codec.is_empty() { ty } else { format!("{ty} {codec}") };
        Some(SchemaNode::Column {
            name,
            type_name,
            // ClickHouse columns are NOT NULL unless wrapped in Nullable().
            nullable: r.get(1).map(|t| t.contains("Nullable(")).unwrap_or(false),
            primary_key: in_pk,
        })
    }).collect();

    // Data-skipping indices are ClickHouse's equivalent of secondary indexes.
    if let Ok(idx) = session.rows(&format!(
        "SELECT name, type_full, expr FROM system.data_skipping_indices \
         WHERE database = '{}' AND table = '{}'",
        esc(database), esc(table)
    )).await {
        for r in idx {
            let Some(name) = r.first().cloned() else { continue };
            let kind = r.get(1).cloned().unwrap_or_default();
            let expr = r.get(2).cloned().unwrap_or_default();
            nodes.push(SchemaNode::Index {
                name,
                unique: false,           // skip indices are never unique
                columns: vec![expr, format!("[{kind}]")],
            });
        }
    }

    // If this object is a MaterializedView, surface the storage table it writes
    // into as a child so the MV's real bytes/parts are visible and the target
    // is one click away. An MV's own columns describe its SELECT, not its
    // storage — the backing table is where the data actually lands.
    if let Ok(meta) = session.rows(&format!(
        "SELECT engine, create_table_query, toString(uuid) FROM system.tables \
         WHERE database = '{}' AND name = '{}'",
        esc(database), esc(table)
    )).await {
        if let Some(row) = meta.into_iter().next() {
            if row.first().map(|e| e == "MaterializedView").unwrap_or(false) {
                let create_query = row.get(1).cloned().unwrap_or_default();
                let uuid = row.get(2).cloned().unwrap_or_default();
                let (target_db, target_table) =
                    parse_mv_target(&create_query, database, table, &uuid);

                // Size from system.parts — present only for a MergeTree-family
                // target. sum()/count() over no parts is 0, which we normalise
                // to None so the tree shows just the link for a Null target.
                let (bytes, parts) = session.rows(&format!(
                    "SELECT sum(bytes_on_disk), count() FROM system.parts \
                     WHERE database = '{}' AND table = '{}' AND active",
                    esc(&target_db), esc(&target_table)
                )).await.ok()
                    .and_then(|r| r.into_iter().next())
                    .map(|r| (
                        r.first().and_then(|v| v.parse::<i64>().ok()).filter(|b| *b > 0),
                        r.get(1).and_then(|v| v.parse::<i64>().ok()).filter(|p| *p > 0),
                    ))
                    .unwrap_or((None, None));

                nodes.insert(0, SchemaNode::MatViewTarget {
                    name: target_table,
                    schema: Some(target_db),
                    bytes,
                    parts,
                });
            }
        }
    }

    Ok(nodes)
}

/// DDL straight from the server — ClickHouse stores the canonical statement.
pub async fn get_ddl(session: &ChSession, database: &str, object: &str) -> Result<String> {
    let sql = format!(
        "SELECT create_table_query FROM system.tables WHERE database = '{}' AND name = '{}'",
        esc(database), esc(object)
    );
    let ddl = session.post(&sql, "TabSeparatedRaw").await?.trim().to_string();
    if !ddl.is_empty() { return Ok(ddl); }

    // Dictionaries live in their own catalog.
    let dict = session.post(&format!(
        "SELECT create_table_query FROM system.dictionaries WHERE database = '{}' AND name = '{}'",
        esc(database), esc(object)
    ), "TabSeparatedRaw").await.unwrap_or_default().trim().to_string();
    if !dict.is_empty() { return Ok(dict); }

    anyhow::bail!("DDL not found for {}.{}", database, object)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::types::Engine;

    #[test]
    fn decode_applies_the_house_rules_to_quoted_cells() {
        // The wire shape with output_format_json_quote_* = 1: 64-bit ints,
        // decimals and denormals all arrive as strings.
        let body = r#"{
            "meta": [
                {"name": "u", "type": "UInt64"},
                {"name": "i", "type": "Int64"},
                {"name": "big", "type": "UInt128"},
                {"name": "d", "type": "Decimal(38, 4)"},
                {"name": "f", "type": "Float64"},
                {"name": "nf", "type": "Nullable(Float64)"},
                {"name": "lc", "type": "LowCardinality(UInt64)"},
                {"name": "s", "type": "String"},
                {"name": "z", "type": "Nullable(Nothing)"}
            ],
            "data": [[
                "18446744073709551615", "-9223372036854775808",
                "340282366920938463463374607431768211455",
                "123456789012345678.1234", "nan", "-inf", "42", "hello", null
            ]],
            "rows": 1
        }"#;
        let r = decode_json_compact(body.into(), Instant::now()).unwrap();
        let row = &r.rows[0];
        assert_eq!(row[0].as_u64(), Some(u64::MAX), "quoted u64 parses back exact");
        assert_eq!(row[1].as_i64(), Some(i64::MIN), "quoted i64 parses back exact");
        // 128-bit exceeds serde_json's range — the string stays a string.
        assert_eq!(row[2].as_str(), Some("340282366920938463463374607431768211455"));
        // DECIMAL stays a string — never through f64.
        assert_eq!(row[3].as_str(), Some("123456789012345678.1234"));
        // Denormals become the house sentinels, never NULL.
        assert_eq!(row[4].as_str(), Some("NaN"));
        assert_eq!(row[5].as_str(), Some("-Infinity"), "Nullable(Float64) peels for the type check");
        // Wrappers peel for ints too.
        assert_eq!(row[6].as_u64(), Some(42), "LowCardinality(UInt64) peels");
        assert_eq!(row[7].as_str(), Some("hello"));
        assert!(row[8].is_null(), "a real NULL stays null");
    }

    #[test]
    fn decode_leaves_unquoted_legacy_values_alone() {
        // A proxy or an old server without the quoting settings: bare numbers
        // pass through untouched, and a Float64 null (a legacy denormal) is
        // not touched either — we cannot tell it from NULL, so we don't guess.
        let body = r#"{
            "meta": [{"name": "u", "type": "UInt64"}, {"name": "f", "type": "Float64"}],
            "data": [[42, null]],
            "rows": 1
        }"#;
        let r = decode_json_compact(body.into(), Instant::now()).unwrap();
        assert_eq!(r.rows[0][0].as_u64(), Some(42));
        assert!(r.rows[0][1].is_null());
    }

    #[test]
    fn distributed_args_quoted_and_with_sharding_key() {
        // Cluster / db / table as string literals, a sharding_key that itself
        // contains a comma — the split must not be fooled by the nested parens.
        let ef = "Distributed('logs_cluster', 'default', 'hits_local', cityHash64(a, b))";
        assert_eq!(
            parse_distributed_args(ef),
            Some(("logs_cluster".into(), "default".into(), "hits_local".into())),
        );
    }

    #[test]
    fn distributed_args_bare_identifiers_and_three_args() {
        let ef = "Distributed(main, analytics, events)";
        assert_eq!(
            parse_distributed_args(ef),
            Some(("main".into(), "analytics".into(), "events".into())),
        );
        // currentDatabase() is left verbatim for the caller to substitute.
        let ef2 = "Distributed('c', currentDatabase(), 'local')";
        assert_eq!(
            parse_distributed_args(ef2),
            Some(("c".into(), "currentDatabase()".into(), "local".into())),
        );
    }

    #[test]
    fn distributed_args_reject_non_distributed() {
        assert_eq!(parse_distributed_args("MergeTree()"), None);
        assert_eq!(parse_distributed_args("Distributed(only, two)"), None);
    }

    #[test]
    fn mv_target_explicit_to_clause() {
        let q = "CREATE MATERIALIZED VIEW db.mv TO reports.daily (`d` Date) AS SELECT d FROM src";
        assert_eq!(
            parse_mv_target(q, "db", "mv", ""),
            ("reports".into(), "daily".into()),
        );
        // Backtick-quoted target, and a bare (unqualified) target inherits the
        // MV's own database.
        let q2 = "CREATE MATERIALIZED VIEW db.mv TO `reports`.`daily` AS SELECT 1";
        assert_eq!(parse_mv_target(q2, "db", "mv", ""), ("reports".into(), "daily".into()));
        let q3 = "CREATE MATERIALIZED VIEW db.mv TO daily AS SELECT 1";
        assert_eq!(parse_mv_target(q3, "db", "mv", ""), ("db".into(), "daily".into()));
    }

    #[test]
    fn mv_target_implicit_inner_tables() {
        // Atomic database (non-zero uuid) → .inner_id.<uuid>.
        let q = "CREATE MATERIALIZED VIEW db.mv (`x` UInt64) ENGINE = MergeTree ORDER BY x AS SELECT x FROM s";
        let uuid = "12345678-1234-1234-1234-123456789abc";
        assert_eq!(
            parse_mv_target(q, "db", "mv", uuid),
            ("db".into(), format!(".inner_id.{uuid}")),
        );
        // Ordinary database (zero uuid) → legacy .inner.<name>.
        assert_eq!(
            parse_mv_target(q, "db", "mv", "00000000-0000-0000-0000-000000000000"),
            ("db".into(), ".inner.mv".into()),
        );
        // A `to_string`-like token in the SELECT body must not be read as a TO.
        let q2 = "CREATE MATERIALIZED VIEW db.mv (`x` UInt64) ENGINE = MergeTree ORDER BY x AS SELECT toString(x) FROM s";
        assert_eq!(parse_mv_target(q2, "db", "mv", ""), ("db".into(), ".inner.mv".into()));
    }

    fn cfg() -> ConnectionConfig {
        let mut c = ConnectionConfig::new(Engine::Clickhouse, "ch");
        c.host = Some("ch.internal".into());
        c.port = Some(8123);
        c.ssl_mode = SslMode::Disable;
        c
    }

    /// A private CA on the connection must actually reach the HTTP client.
    /// It used to be accepted by the form and dropped here, which reads as
    /// configured while verifying nothing.
    mod custom_ca {
        use super::*;
        use std::io::Write;

        /// Self-signed PEM, generated once per test into a temp file.
        fn write(name: &str, body: &[u8]) -> std::path::PathBuf {
            let mut p = std::env::temp_dir();
            p.push(format!("txui-ca-test-{name}-{}.pem", std::process::id()));
            let mut f = std::fs::File::create(&p).expect("temp pem");
            f.write_all(body).expect("write pem");
            p
        }

        /// A real self-signed CA, inlined so the test needs no openssl and no
        /// network. Generated with a 10-year life; parsing does not check
        /// expiry, but a long life keeps the intent obvious.
        const PEM: &str = concat!(
            "-----BEGIN CERTIFICATE-----\n",
            "MIIDDzCCAfegAwIBAgIULLIXvLub9cSVaFYBX1FMCGZ1uX0wDQYJKoZIhvcNAQEL\n",
            "BQAwFzEVMBMGA1UEAwwMVHhVSSBUZXN0IENBMB4XDTI2MDgxMTA5MDIwNFoXDTM2\n",
            "MDgwODA5MDIwNFowFzEVMBMGA1UEAwwMVHhVSSBUZXN0IENBMIIBIjANBgkqhkiG\n",
            "9w0BAQEFAAOCAQ8AMIIBCgKCAQEAhYpUy35XwxG9ZPPcnpEauvSMGME/ufQGCrwp\n",
            "5k1jXTRa2eaPIt+HqbqGHQmCRKkDzM3FQIjqLK+INQeHrIfKEZ0bhIHvP8tuY7CH\n",
            "6AGxwXdxlSesjuPWCZ8gQxQJclGnnBqdhML+o9zvCy93+mIGzGHdquv7vgxfuV0o\n",
            "wdwq5Hm1CZMkl8RiLdAK1uXk5iEZ7A79WEN+Ne97PpcQ7V/2eoRHzx3QrYlssk+u\n",
            "FXYlJ0vT20agnJOIpCWCu3r7jzMA/lrDeJFGBR7lzTum+j4syRCF7AbcbXuCacaZ\n",
            "gfuwteXOatkW20FXACg4mR0FYyLx6bS2OB4FJJNkxg97VFPapwIDAQABo1MwUTAd\n",
            "BgNVHQ4EFgQUEfsBEfCRtEYU/3jbJuvE8hCvklEwHwYDVR0jBBgwFoAUEfsBEfCR\n",
            "tEYU/3jbJuvE8hCvklEwDwYDVR0TAQH/BAUwAwEB/zANBgkqhkiG9w0BAQsFAAOC\n",
            "AQEAFEsD6yTUbH3wH65ppNImuJyexvJh/30eMMPfoJAmd4dQ3d/P+EuJKTV+t3nX\n",
            "9A7gVG51Q98g4J/pcdytp5t/dZD2n8lyKYtOxOUTyFSZe3hfzSz9zsk4XEGJTn56\n",
            "/jFxOfPOYPv0+eotOSTQcpu0FYiPTIbyfXkGf/grl+OKjtExGKqwv34NVQyOtn3o\n",
            "81YHJ5hPqZbnSjLzLAAuk9MoQz857gy3VjkEu7y1omiG82n/tJbZxYyncgXu87YG\n",
            "eSbmGPwC9sx0WkBaH2kemFEC8bSycMdQ8LgyDK0YdxdkIY8B6NnyBP6zXk/ZP81s\n",
            "x+ij5MBUvQtImnuoYnb/9Gu0Hg==\n",
            "-----END CERTIFICATE-----\n");

        /// Structurally a PEM block but not a decodable certificate.
        const TRUNCATED: &str = concat!(
            "-----BEGIN CERTIFICATE-----\n",
            "MIIBhTCCASugAwIBAgIUKmM8Zf0Y0xM5oQ0m4ZKZ0Q0m4ZAwCgYIKoZIzj0EAwIw\n",
            "-----END CERTIFICATE-----\n");

        #[test]
        fn a_missing_file_fails_with_a_message_naming_the_path() {
            let mut c = cfg();
            c.ssl_ca_path = Some("/nonexistent/txui/ca.pem".into());
            let err = open(&c, None, None).expect_err("a missing CA must not be ignored");
            let msg = err.to_string();
            assert!(msg.contains("/nonexistent/txui/ca.pem"), "path not named: {msg}");
        }

        #[test]
        fn a_file_that_is_not_pem_is_refused() {
            let p = write("garbage", b"not a certificate\n");
            let mut c = cfg();
            c.ssl_ca_path = Some(p.to_string_lossy().into_owned());
            let err = open(&c, None, None).expect_err("garbage must not be accepted");
            let msg = err.to_string();
            assert!(msg.contains("no certificates") || msg.contains("not valid PEM"),
                    "unhelpful message: {msg}");
            let _ = std::fs::remove_file(&p);
        }

        /// An empty path is "not configured", not "configured with nothing" —
        /// it must not turn into an error for every connection that leaves the
        /// field blank.
        #[test]
        fn an_empty_path_is_treated_as_unset() {
            let mut c = cfg();
            c.ssl_ca_path = Some(String::new());
            assert!(open(&c, None, None).is_ok());
        }

        #[test]
        fn no_ca_configured_still_opens() {
            assert!(open(&cfg(), None, None).is_ok());
        }

        /// Truncated PEM: structurally a certificate block, but not decodable.
        /// Must be reported rather than silently yielding zero roots.
        /// The path that actually matters: a valid private CA is accepted and
        /// the client builds. Every other test here proves we reject things.
        #[test]
        fn a_valid_ca_is_accepted() {
            let p = write("valid", PEM.as_bytes());
            let mut c = cfg();
            c.ssl_ca_path = Some(p.to_string_lossy().into_owned());
            c.ssl_mode = SslMode::VerifyFull;
            assert!(open(&c, None, None).is_ok(), "a valid CA was rejected");
            let _ = std::fs::remove_file(&p);
        }

        /// A bundle carrying a chain must load every certificate, not just the
        /// first — dropping an intermediate fails verification in a way that
        /// looks like a server problem.
        #[test]
        fn a_bundle_of_several_certificates_loads() {
            let p = write("bundle", format!("{PEM}{PEM}").as_bytes());
            let mut c = cfg();
            c.ssl_ca_path = Some(p.to_string_lossy().into_owned());
            assert!(open(&c, None, None).is_ok(), "a two-certificate bundle was rejected");
            let _ = std::fs::remove_file(&p);
        }

        #[test]
        fn a_truncated_certificate_is_refused() {
            let p = write("truncated", TRUNCATED.as_bytes());
            let mut c = cfg();
            c.ssl_ca_path = Some(p.to_string_lossy().into_owned());
            let r = open(&c, None, None);
            assert!(r.is_err(), "a malformed certificate was accepted");
            let _ = std::fs::remove_file(&p);
        }
    }

    #[test]
    fn url_uses_http_and_the_clickhouse_port() {
        assert_eq!(base_url(&cfg(), None), "http://ch.internal:8123");
    }

    #[test]
    fn tls_switches_to_https_when_asked_for_explicitly() {
        let mut c = cfg();
        for m in [SslMode::Require, SslMode::VerifyCa, SslMode::VerifyFull] {
            c.ssl_mode = m;
            assert!(base_url(&c, None).starts_with("https://"), "{:?}", c.ssl_mode);
        }
    }

    #[test]
    fn preferred_does_not_force_tls_onto_the_plaintext_port() {
        // This test used to assert the opposite, and the opposite was a bug:
        // Preferred is the DEFAULT ssl mode, so every ClickHouse connection
        // created without touching the SSL dropdown attempted TLS against
        // port 8123 and died in the handshake with
        // "received corrupt message of type InvalidContentType".
        let mut c = cfg();
        c.ssl_mode = SslMode::Preferred;
        assert_eq!(base_url(&c, None), "http://ch.internal:8123");
        c.port = Some(8443);
        assert_eq!(base_url(&c, None), "https://ch.internal:8443");
    }

    #[test]
    fn ssh_tunnel_endpoint_wins_and_localhost_is_pinned() {
        let mut c = cfg();
        c.host = Some("localhost".into());
        assert_eq!(base_url(&c, None), "http://127.0.0.1:8123");
        assert_eq!(base_url(&c, Some(("127.0.0.1", 19000))), "http://127.0.0.1:19000");
    }

    #[test]
    fn read_only_pins_the_server_side_switch() {
        // The guarantee that matters: an account with ALL grants is still
        // refused writes by the SERVER when this setting rides along.
        let mut c = cfg();
        c.read_only = true;
        let s = open(&c, None, None).unwrap();
        let settings = s.settings();
        assert!(settings.iter().any(|(k, v)| *k == "readonly" && v == "1"),
                "read-only connection must send readonly=1: {settings:?}");

        c.read_only = false;
        let rw = open(&c, None, None).unwrap();
        assert!(!rw.settings().iter().any(|(k, _)| *k == "readonly"));
    }

    #[test]
    fn memory_and_row_ceilings_attach_from_extra_params() {
        let mut c = cfg();
        c.extra_params.insert("max_memory_usage".into(), "1000000000".into());
        c.extra_params.insert("max_rows_to_read".into(), "500000".into());
        c.extra_params.insert("max_bytes_to_read".into(), "2000000".into());
        let s = open(&c, None, None).unwrap();
        let settings = s.settings();
        assert!(settings.iter().any(|(k, v)| *k == "max_memory_usage" && v == "1000000000"),
                "memory ceiling must ride the request: {settings:?}");
        assert!(settings.iter().any(|(k, v)| *k == "max_rows_to_read" && v == "500000"));
        assert!(settings.iter().any(|(k, v)| *k == "max_bytes_to_read" && v == "2000000"));
    }

    #[test]
    fn unset_or_zero_ceilings_attach_nothing() {
        // 0 / blank / non-numeric all mean "no limit" — nothing is attached, so
        // behaviour is unchanged for connections that never set a ceiling.
        let mut c = cfg();
        c.extra_params.insert("max_memory_usage".into(), "0".into());
        c.extra_params.insert("max_rows_to_read".into(), "".into());
        c.extra_params.insert("max_bytes_to_read".into(), "not-a-number".into());
        let s = open(&c, None, None).unwrap();
        let settings = s.settings();
        assert!(!settings.iter().any(|(k, _)| *k == "max_memory_usage"), "{settings:?}");
        assert!(!settings.iter().any(|(k, _)| *k == "max_rows_to_read"));
        assert!(!settings.iter().any(|(k, _)| *k == "max_bytes_to_read"));
    }

    #[test]
    fn ceilings_are_withheld_from_a_readonly_connection() {
        // readonly=1 refuses setting changes, so attaching a ceiling would make
        // the server reject the whole query. It must be dropped, not sent.
        let mut c = cfg();
        c.read_only = true;
        c.extra_params.insert("max_memory_usage".into(), "1000000000".into());
        c.extra_params.insert("max_rows_to_read".into(), "500000".into());
        let s = open(&c, None, None).unwrap();
        let settings = s.settings();
        assert!(settings.iter().any(|(k, v)| *k == "readonly" && v == "1"));
        assert!(!settings.iter().any(|(k, _)| *k == "max_memory_usage"),
                "a readonly connection must not attach a setting change: {settings:?}");
        assert!(!settings.iter().any(|(k, _)| *k == "max_rows_to_read"));
    }

    #[test]
    fn every_request_is_bounded() {
        let s = open(&cfg(), None, None).unwrap();
        let settings = s.settings();
        assert!(settings.iter().any(|(k, _)| *k == "max_execution_time"),
                "an unbounded query on ClickHouse cannot be cheaply cancelled over HTTP");
    }

    #[test]
    fn errors_are_reduced_to_the_actionable_line() {
        let body = "Code: 164. DB::Exception: dolphie: Cannot execute query in readonly mode. \
                    (READONLY) (version 26.7.2.59 (official build))\nstack trace:\n  0x1234";
        let msg = clean_error(body);
        assert!(msg.contains("Cannot execute query in readonly mode"));
        assert!(!msg.contains("stack trace"));
        assert!(!msg.contains("official build"), "version noise stripped: {msg}");
    }

    #[test]
    fn empty_error_body_still_says_something() {
        assert!(clean_error("").contains("empty error"));
    }

    #[test]
    fn tsv_escapes_are_decoded() {
        assert_eq!(unescape_tsv("plain"), "plain");
        assert_eq!(unescape_tsv("a\\tb"), "a\tb");
        assert_eq!(unescape_tsv("line\\nbreak"), "line\nbreak");
        assert_eq!(unescape_tsv("back\\\\slash"), "back\\slash");
        // The NULL marker must stay recognisable rather than becoming "N".
        assert_eq!(unescape_tsv("\\N"), "\\N");
        // ClickHouse escapes the single quote too — Distributed engine args
        // arrive as \'cluster\' and must parse as `cluster`.
        assert_eq!(unescape_tsv("\\'txui_test_cluster\\'"), "'txui_test_cluster'");
    }

    #[test]
    fn password_never_appears_in_debug_output() {
        let mut c = cfg();
        c.user = Some("dolphie".into());
        let s = open(&c, Some("super-secret-value".into()), None).unwrap();
        let dbg = format!("{s:?}");
        assert!(!dbg.contains("super-secret-value"), "password leaked into Debug: {dbg}");
        assert!(dbg.contains("dolphie"));
    }

    #[test]
    fn nullable_detection_matches_clickhouse_semantics() {
        // Columns are NOT NULL unless explicitly wrapped — the opposite of SQL.
        for (ty, want) in [
            ("UInt64", false), ("String", false), ("LowCardinality(String)", false),
            ("Nullable(String)", true), ("Array(Nullable(UInt8))", true),
        ] {
            assert_eq!(ty.contains("Nullable("), want, "{ty}");
        }
    }
}

#[cfg(test)]
mod live_tests {
    //! Against a real ClickHouse. Metadata only — the driver is exercised
    //! through system.* so no production business data is read.
    //!
    //!   CH_HOST=… CH_USER=… CH_PASS=… cargo test --lib ch_live -- --ignored --nocapture
    //!
    //! Skipped when CH_PASS is unset, so it never fails a machine without the
    //! endpoint (or without the VPN).
    use crate::db::types::{ConnectionConfig, Engine, SchemaNode, SslMode};

    fn config() -> Option<ConnectionConfig> {
        let pass = std::env::var("CH_PASS").ok()?;
        let mut c = ConnectionConfig::new(Engine::Clickhouse, "ch-live");
        c.host = Some(std::env::var("CH_HOST").unwrap_or_else(|_| "127.0.0.1".into()));
        c.port = Some(std::env::var("CH_PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(8123));
        c.user = Some(std::env::var("CH_USER").unwrap_or_else(|_| "default".into()));
        c.database = Some(std::env::var("CH_DB").unwrap_or_else(|_| "default".into()));
        c.ssl_mode = SslMode::Disable;
        // Everything below connects READ-ONLY. This is pointed at production.
        c.read_only = true;
        let _ = pass;
        c.into()
    }

    fn session() -> Option<super::ChSession> {
        let c = config()?;
        super::open(&c, std::env::var("CH_PASS").ok(), None).ok()
    }

    #[tokio::test]
    #[ignore]
    async fn ch_live_ping_and_version() {
        let Some(c) = config() else { println!("CH_PASS unset — skipping"); return };
        let r = super::ping(&c, std::env::var("CH_PASS").ok()).await;
        assert!(r.ok, "ping failed: {:?}", r.error);
        let v = r.server_version.expect("version");
        assert!(v.chars().next().is_some_and(|c| c.is_ascii_digit()), "odd version {v}");
        println!("  clickhouse {v} · {} ms", r.latency_ms);
    }

    #[tokio::test]
    #[ignore]
    async fn ch_live_read_only_connection_is_refused_a_write() {
        // The guarantee this driver rests on: with readonly=1 the SERVER
        // refuses writes even for an account holding ALL ON *.*. The target
        // is deliberately a table that does not exist, so a regression here
        // cannot create anything.
        let Some(s) = session() else { return };
        let err = super::execute(&s, "CREATE TABLE system.dbgui_must_never_exist (a UInt8) ENGINE=Memory")
            .await.expect_err("a read-only connection MUST refuse DDL");
        let msg = err.to_string();
        assert!(msg.contains("readonly") || msg.contains("READONLY"),
                "refused, but not by the readonly guard: {msg}");
        println!("  write refused by the server: {msg}");
    }

    #[tokio::test]
    #[ignore]
    async fn ch_live_typed_results_decode() {
        let Some(s) = session() else { return };
        // system.one is ClickHouse's DUAL: one row, no user data.
        let r = super::execute(&s,
            "SELECT toUInt64(1) AS n, 'x' AS s, toFloat64(1.5) AS f, \
                    toDateTime('2020-01-01 00:00:00') AS d, \
                    CAST(NULL AS Nullable(String)) AS nul FROM system.one").await.expect("query");
        assert_eq!(r.rows.len(), 1);
        let types: Vec<&str> = r.columns.iter().map(|c| c.type_name.as_str()).collect();
        println!("  types: {types:?}");
        assert!(types[0].starts_with("UInt"));
        assert!(r.columns.iter().any(|c| c.nullable), "Nullable() must be detected");
        assert!(r.columns.iter().filter(|c| !c.nullable).count() >= 4,
                "ClickHouse columns are NOT NULL unless wrapped");
        // The server reports its own elapsed time.
        assert!(!r.warnings.is_empty(), "read statistics should be surfaced");
    }

    #[tokio::test]
    #[ignore]
    async fn ch_live_schema_tree() {
        let Some(s) = session() else { return };
        let dbs = super::list_databases(&s).await.expect("databases");
        let names: Vec<&str> = dbs.iter().filter_map(|n| match n {
            SchemaNode::Database { name } => Some(name.as_str()), _ => None,
        }).collect();
        println!("  databases: {names:?}");
        assert!(names.contains(&"system"), "system database missing: {names:?}");

        // Expand `system` — always present, and it is metadata by definition.
        let objs = super::list_tables(&s, "system").await.expect("tables");
        assert!(objs.len() > 20, "only {} objects in system", objs.len());
        let has_table = objs.iter().any(|n| matches!(n, SchemaNode::Table { name, .. } if name == "parts"));
        assert!(has_table, "system.parts not listed");
        println!("  system: {} objects", objs.len());

        // Columns of a system table carry the ClickHouse-specific metadata.
        let cols = super::list_columns(&s, "system", "parts").await.expect("columns");
        let col_names: Vec<&str> = cols.iter().filter_map(|n| match n {
            SchemaNode::Column { name, .. } => Some(name.as_str()), _ => None,
        }).collect();
        assert!(col_names.contains(&"database") && col_names.contains(&"table"),
                "system.parts columns look wrong: {col_names:?}");
        println!("  system.parts: {} columns", col_names.len());
    }

    #[tokio::test]
    #[ignore]
    async fn ch_live_ddl_comes_from_the_server() {
        let Some(s) = session() else { return };
        let ddl = super::get_ddl(&s, "system", "parts").await.expect("ddl");
        assert!(ddl.starts_with("CREATE"), "unexpected DDL: {}", &ddl[..ddl.len().min(80)]);
        println!("  DDL: {}…", &ddl[..ddl.len().min(90)]);
    }

    #[tokio::test]
    #[ignore]
    async fn ch_live_errors_are_readable() {
        let Some(s) = session() else { return };
        let err = super::execute(&s, "SELECT this_column_does_not_exist FROM system.one")
            .await.expect_err("should fail");
        let msg = err.to_string();
        assert!(!msg.contains("stack trace"), "stack trace leaked: {msg}");
        assert!(!msg.contains("official build"), "version noise leaked: {msg}");
        assert!(msg.len() < 400, "error not trimmed: {msg}");
        println!("  error: {msg}");
    }
}

#[cfg(test)]
mod cancel_live_tests {
    //! Against a ClickHouse on 127.0.0.1:8123 with `root`/`root`, matching the
    //! credentials the rest of the local test fleet uses.
    //!
    //! There is no fleet entry for it: the Homebrew cask is deprecated (it
    //! fails the macOS Gatekeeper check and is disabled from 2026-09-01), so
    //! these skip unless a server is provided some other way.
    //!
    //! The point of testing this live: over HTTP there is no connection to
    //! signal, so a cancel that quietly does nothing looks exactly like one
    //! that works — the client returns either way. The only proof is asking the
    //! server whether the query is still running.
    use super::*;

    fn session() -> ChSession {
        let mut c = ConnectionConfig::new(crate::db::types::Engine::Clickhouse, "t");
        c.host = Some("127.0.0.1".into());
        c.port = Some(8123);
        // Credentials follow the local server: TXUI_CH_USER / TXUI_CH_PASSWORD
        // override; the defaults match the ~/ai/dbs/clickhouse fixture.
        c.user = Some(std::env::var("TXUI_CH_USER").unwrap_or_else(|_| "default".into()));
        c.ssl_mode = SslMode::Disable;
        // The ceiling must not be what stops the query, or the test proves
        // nothing about the cancel.
        c.statement_timeout_secs = Some(120);
        let pw = std::env::var("TXUI_CH_PASSWORD").unwrap_or_else(|_| "root".into());
        open(&c, Some(pw), None).expect("open")
    }

    async fn is_running(s: &ChSession, query_id: &str) -> bool {
        let out = s.post_with_params(
            "SELECT count() FROM system.processes WHERE query_id = {qid:String}",
            "TabSeparated",
            &[("qid".into(), "String".into(), query_id.into())],
        ).await.expect("processes");
        out.trim() != "0"
    }

    /// The whole feature: a long query is named, found on the server by that
    /// name, killed, and gone.
    #[tokio::test]
    #[ignore = "needs local ClickHouse on 8123"]
    async fn a_named_query_can_be_found_and_killed() {
        let s = session();
        let query_id = uuid::Uuid::new_v4().to_string();

        let running = s.clone();
        let id = query_id.clone();
        let handle = tokio::spawn(async move {
            execute_with_id(&running, "SELECT sleep(3) FROM numbers(20)", &id).await
        });

        // Wait for it to appear rather than sleeping a guessed interval.
        let mut seen = false;
        for _ in 0..40 {
            if is_running(&s, &query_id).await { seen = true; break; }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        assert!(seen, "the query never appeared in system.processes under its id");

        kill_query(&s, &query_id).await.expect("kill");

        let mut gone = false;
        for _ in 0..50 {
            if !is_running(&s, &query_id).await { gone = true; break; }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        assert!(gone, "the query was still running 5s after KILL QUERY");

        // The client sees a killed query as an error, not as an empty success —
        // reporting "0 rows" for a cancelled query would be a lie.
        let r = handle.await.expect("join");
        assert!(r.is_err(), "a killed query must not come back as a result");
    }

    /// Killing something that is not there is not an error. The Stop button
    /// races the query's own completion and loses often.
    #[tokio::test]
    #[ignore = "needs local ClickHouse on 8123"]
    async fn killing_a_finished_query_is_not_an_error() {
        let s = session();
        kill_query(&s, "00000000-0000-0000-0000-000000000000").await
            .expect("killing an absent query must be quiet");
    }

    /// The id is bound as a parameter, so a hostile one cannot become SQL. If
    /// it were concatenated, this would kill every query on the server.
    #[tokio::test]
    #[ignore = "needs local ClickHouse on 8123"]
    async fn a_hostile_query_id_is_not_sql() {
        let s = session();
        let victim = uuid::Uuid::new_v4().to_string();
        let running = s.clone();
        let id = victim.clone();
        let handle = tokio::spawn(async move {
            execute_with_id(&running, "SELECT sleep(3) FROM numbers(10)", &id).await
        });
        for _ in 0..40 {
            if is_running(&s, &victim).await { break; }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }

        kill_query(&s, "' OR 1=1 --").await.expect("kill with a hostile id");

        assert!(is_running(&s, &victim).await,
                "a hostile query_id reached the WHERE clause and killed an unrelated query");
        kill_query(&s, &victim).await.expect("cleanup");
        let _ = handle.await;
    }

    /// A read-only connection can still stop its own query.
    ///
    /// Worth pinning because the opposite was assumed. `readonly=1` refuses
    /// `INSERT`, `CREATE` and even `SET`, so `KILL QUERY` looks like it belongs
    /// on that list — and the plan for this feature said it would have to be
    /// gated off for read-only connections. It is not refused: ClickHouse
    /// treats it as query control, not as a write. Gating it would have
    /// disabled Stop on precisely the connections most likely to be pointed at
    /// production, which is where a runaway query costs the most.
    #[tokio::test]
    #[ignore = "needs local ClickHouse on 8123"]
    async fn a_read_only_connection_can_still_cancel() {
        let mut c = ConnectionConfig::new(crate::db::types::Engine::Clickhouse, "t");
        c.host = Some("127.0.0.1".into());
        c.port = Some(8123);
        // Same env-fed credentials as session() above.
        c.user = Some(std::env::var("TXUI_CH_USER").unwrap_or_else(|_| "default".into()));
        c.ssl_mode = SslMode::Disable;
        c.statement_timeout_secs = Some(120);
        c.read_only = true;
        let pw = std::env::var("TXUI_CH_PASSWORD").unwrap_or_else(|_| "root".into());
        let ro = open(&c, Some(pw), None).expect("open");

        let query_id = uuid::Uuid::new_v4().to_string();
        let running = ro.clone();
        let id = query_id.clone();
        let handle = tokio::spawn(async move {
            execute_with_id(&running, "SELECT sleep(3) FROM numbers(20)", &id).await
        });
        let mut seen = false;
        for _ in 0..40 {
            if is_running(&ro, &query_id).await { seen = true; break; }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        assert!(seen, "the read-only query never started");

        kill_query(&ro, &query_id).await
            .expect("readonly=1 must not refuse KILL QUERY");

        let mut gone = false;
        for _ in 0..50 {
            if !is_running(&ro, &query_id).await { gone = true; break; }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        assert!(gone, "a read-only connection could not stop its own query");
        let _ = handle.await;
    }

    /// Two statements must not collide on an id; the driver generates one per
    /// execution and ClickHouse rejects a duplicate that is still in flight.
    #[tokio::test]
    #[ignore = "needs local ClickHouse on 8123"]
    async fn a_plain_execute_still_works_without_an_id() {
        let s = session();
        let r = execute(&s, "SELECT 1 AS one").await.expect("execute");
        assert_eq!(r.rows.len(), 1);
    }
}

#[cfg(test)]
mod tls_live_tests {
    //! Against the local fixture at ~/ai/dbs/clickhouse: an HTTPS endpoint on
    //! 8443 that REQUIRES a client certificate (openSSL server
    //! `verificationMode=strict`, CA and certs in `etc/ssl/`, overlay
    //! `etc/config.d/txui_tls.xml`). The unit tests above prove PEM parsing
    //! and scheme choice; only a live handshake proves the rustls identity
    //! reqwest builds is one a real server accepts — and that its refusal is
    //! reported readably when the client identity is missing.
    //!
    //!   cargo test --lib ch_tls_live -- --ignored --nocapture
    //!
    //! Skips quietly when the fixture's CA is absent, so a machine without it
    //! (CI, a fresh checkout) is not failed for a server it never had.
    use super::*;

    fn ssl_dir() -> Option<std::path::PathBuf> {
        let dir = std::env::var("TXUI_CH_SSL_DIR").map(std::path::PathBuf::from)
            .unwrap_or_else(|_| std::path::PathBuf::from(std::env::var("HOME").unwrap_or_default())
                .join("ai/dbs/clickhouse/etc/ssl"));
        dir.join("ca.crt").exists().then_some(dir)
    }

    fn config(dir: &std::path::Path) -> ConnectionConfig {
        let mut c = ConnectionConfig::new(crate::db::types::Engine::Clickhouse, "ch-tls");
        c.host = Some("127.0.0.1".into());
        c.port = Some(std::env::var("TXUI_CH_TLS_PORT").ok()
            .and_then(|p| p.parse().ok()).unwrap_or(8443));
        c.user = Some(std::env::var("TXUI_CH_USER").unwrap_or_else(|_| "default".into()));
        // VerifyFull: the fixture server certificate carries 127.0.0.1 in its
        // SAN, so hostname verification must succeed — anything weaker would
        // let a hostname-mismatched certificate through unnoticed.
        c.ssl_mode = SslMode::VerifyFull;
        c.ssl_ca_path = Some(dir.join("ca.crt").to_string_lossy().into_owned());
        c
    }

    fn password() -> String {
        std::env::var("TXUI_CH_PASSWORD").unwrap_or_else(|_| "root".into())
    }

    /// The whole mTLS path end to end: CA verifies the server, the client
    /// certificate authenticates us, and a query comes back.
    #[tokio::test]
    #[ignore = "needs the local ClickHouse mTLS fixture on 8443"]
    async fn ch_tls_live_mtls_handshake_and_query() {
        let Some(dir) = ssl_dir() else { println!("no ssl fixture — skipping"); return };
        let mut c = config(&dir);
        c.ssl_cert_path = Some(dir.join("client.crt").to_string_lossy().into_owned());
        c.ssl_key_path = Some(dir.join("client.key").to_string_lossy().into_owned());

        let r = ping(&c, Some(password())).await;
        assert!(r.ok, "mTLS ping failed: {:?}", r.error);
        println!("  mTLS ping: clickhouse {} · {} ms",
                 r.server_version.unwrap_or_default(), r.latency_ms);

        let s = open(&c, Some(password()), None).expect("open");
        let q = execute(&s, "SELECT toUInt32(1) AS n FROM system.one")
            .await.expect("query over mTLS");
        assert_eq!(q.rows.len(), 1);
        println!("  query over mTLS returned {} row", q.rows.len());
    }

    /// Presenting only the CA (server verification) but no client certificate
    /// must die in the handshake, not return data — the fixture server runs
    /// `verificationMode=strict` for exactly this proof.
    #[tokio::test]
    #[ignore = "needs the local ClickHouse mTLS fixture on 8443"]
    async fn ch_tls_live_no_client_certificate_is_refused() {
        let Some(dir) = ssl_dir() else { println!("no ssl fixture — skipping"); return };
        let c = config(&dir);
        let r = ping(&c, Some(password())).await;
        assert!(!r.ok, "a handshake without a client certificate succeeded");
        let msg = r.error.unwrap_or_default();
        assert!(!msg.is_empty(), "the refusal must say something");
        println!("  refused as expected: {}", &msg[..msg.len().min(120)]);
    }
}

#[cfg(test)]
mod distributed_live_tests {
    //! Against the local fixture: cluster `txui_test_cluster` — one shard
    //! pointing back at the same node, declared in
    //! `etc/config.d/txui_cluster.xml`. One shard on purpose: two shards on
    //! one host would read the same underlying table twice and duplicate
    //! every row, and fan-out correctness is ClickHouse's problem, not the
    //! driver's. What the driver needs proving against a Distributed table:
    //! the schema tree lists it, DDL comes back, INSERT/SELECT pass through
    //! the cluster definition, and EXPLAIN survives.
    //!
    //!   cargo test --lib ch_dist_live -- --ignored --nocapture
    //!
    //! Skips when the cluster is not configured (fixture not applied); the
    //! fixture tables are dropped first and again at the end, so re-runs are
    //! clean.
    use super::*;

    fn session() -> ChSession {
        let mut c = ConnectionConfig::new(crate::db::types::Engine::Clickhouse, "ch-dist");
        c.host = Some("127.0.0.1".into());
        c.port = Some(8123);
        c.user = Some(std::env::var("TXUI_CH_USER").unwrap_or_else(|_| "default".into()));
        c.ssl_mode = SslMode::Disable;
        let pw = std::env::var("TXUI_CH_PASSWORD").unwrap_or_else(|_| "root".into());
        open(&c, Some(pw), None).expect("open")
    }

    async fn cluster_registered(s: &ChSession) -> bool {
        let out = s.post_with_params(
            "SELECT count() FROM system.clusters WHERE cluster = 'txui_test_cluster'",
            "TabSeparated", &[]).await.expect("system.clusters");
        out.trim() == "1"
    }

    #[tokio::test]
    #[ignore = "needs the local ClickHouse cluster fixture"]
    async fn ch_dist_live_distributed_table_roundtrip() {
        let s = session();
        if !cluster_registered(&s).await {
            println!("txui_test_cluster not configured — skipping");
            return;
        }

        // Clean slate, then a MergeTree table with a Distributed twin.
        execute(&s, "CREATE DATABASE IF NOT EXISTS txui_dist").await.expect("create db");
        execute(&s, "DROP TABLE IF EXISTS txui_dist.dist_all").await.expect("drop dist");
        execute(&s, "DROP TABLE IF EXISTS txui_dist.dist_local").await.expect("drop local");
        execute(&s, "CREATE TABLE txui_dist.dist_local (n UInt32, s String) \
                     ENGINE = MergeTree ORDER BY n").await.expect("create local");
        execute(&s, "CREATE TABLE txui_dist.dist_all AS txui_dist.dist_local \
                     ENGINE = Distributed('txui_test_cluster', 'txui_dist', 'dist_local', n)")
            .await.expect("create distributed");

        // INSERT through the Distributed table, synchronously, or the async
        // queue could still be holding the rows when the SELECT runs.
        execute(&s, "INSERT INTO txui_dist.dist_all \
                     SELECT number, concat('row', toString(number)) FROM numbers(100) \
                     SETTINGS insert_distributed_sync = 1").await.expect("insert");

        let out = s.post_with_params(
            "SELECT count(), sum(n) FROM txui_dist.dist_all", "TabSeparated", &[])
            .await.expect("select via distributed");
        assert_eq!(out.trim(), "100\t4950", "distributed roundtrip lost rows: {out}");
        println!("  distributed roundtrip: {out}");

        // The schema tree sees both tables and the DDL names the engine. A
        // Distributed table is its own node kind carrying cluster + target —
        // assert the parse landed, not just the name.
        let objs = list_tables(&s, "txui_dist").await.expect("list tables");
        let mut saw_local = false;
        let mut saw_dist = false;
        for n in &objs {
            match n {
                SchemaNode::Table { name, .. } if name == "dist_local" => saw_local = true,
                SchemaNode::Distributed { name, cluster, target_db, target_table, .. }
                    if name == "dist_all" => {
                    assert_eq!(cluster, "txui_test_cluster");
                    assert_eq!(target_db, "txui_dist");
                    assert_eq!(target_table, "dist_local");
                    saw_dist = true;
                }
                _ => {}
            }
        }
        assert!(saw_local && saw_dist, "schema tree incomplete: {objs:?}");
        let ddl = get_ddl(&s, "txui_dist", "dist_all").await.expect("ddl");
        assert!(ddl.contains("Distributed"), "DDL hides the engine: {ddl}");

        // EXPLAIN over a Distributed table must come back, not error.
        let plan = execute(&s, "EXPLAIN SELECT count() FROM txui_dist.dist_all")
            .await.expect("explain");
        assert!(!plan.rows.is_empty(), "empty EXPLAIN over a distributed table");

        execute(&s, "DROP TABLE txui_dist.dist_all").await.expect("cleanup dist");
        execute(&s, "DROP TABLE txui_dist.dist_local").await.expect("cleanup local");
        println!("  schema tree, DDL and EXPLAIN all fine; fixture cleaned up");
    }
}
