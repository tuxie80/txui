//! Cloud SQL IAM database authentication.
//!
//! With IAM auth, the database *username* is the IAM principal (e.g. a user
//! `jane.doe@…` truncated by Cloud SQL, or a service account) and the
//! *password* is a short-lived OAuth2 access token. This mints that token from a
//! service-account JSON key the way Google's own clients do: build a JWT
//! asserting the account and the Cloud SQL login scope, sign it RS256 with the
//! key's private key, and exchange it at the account's `token_uri` for an access
//! token (the JWT-bearer grant).
//!
//! The token is minted fresh at connect time and handed to the driver as the
//! password; it is never stored. It is valid ~1h, which comfortably covers
//! establishing the pool.

use serde::{Deserialize, Serialize};

/// The fields we need from a service-account JSON key.
#[derive(Deserialize)]
struct ServiceAccountKey {
    client_email: String,
    private_key: String,
    token_uri: String,
    #[serde(default)]
    project_id: String,
}

/// The fields we need from gcloud **application-default credentials** — the
/// `authorized_user` JSON `gcloud auth application-default login` leaves
/// behind. This is how a human (not a service account) authenticates: there is
/// no private key to sign with, so the token comes from the OAuth
/// refresh-token grant instead of the JWT-bearer one.
#[derive(Deserialize)]
struct AuthorizedUserKey {
    client_id: String,
    client_secret: String,
    refresh_token: String,
}

/// A credential file is one of the two shapes; `type` tells them apart.
/// Anything else is not something we can turn into a token.
#[derive(Deserialize)]
#[serde(tag = "type")]
enum KeyFile {
    #[serde(rename = "service_account")]
    ServiceAccount(ServiceAccountKey),
    #[serde(rename = "authorized_user")]
    AuthorizedUser(AuthorizedUserKey),
}

/// Cloud SQL Admin scope — for listing instances (discovery), not DB login.
pub const SQL_ADMIN_SCOPE: &str = "https://www.googleapis.com/auth/sqlservice.admin";

/// Google Sheets scope — for exporting grids to a spreadsheet (create + write
/// values). Same service-account JWT-bearer flow as the Cloud SQL scopes.
pub const SHEETS_SCOPE: &str = "https://www.googleapis.com/auth/spreadsheets";

#[derive(Serialize)]
struct Claims<'a> {
    iss: &'a str,
    scope: &'a str,
    aud: &'a str,
    iat: u64,
    exp: u64,
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
}

/// The IAM scope for logging in to a Cloud SQL database (as opposed to the
/// admin API). This is what the token must carry for the DB to accept it.
const SQL_LOGIN_SCOPE: &str = "https://www.googleapis.com/auth/sqlservice.login";

/// Mint an OAuth2 access token from a credential JSON file for `scope`.
/// Returns (access_token, project_id) — the project is empty for
/// authorized-user credentials, which carry no project.
///
/// Two grants, chosen by the file's `type`:
/// - `service_account` — the JWT-bearer grant below (sign claims with the
///   key, exchange at the account's `token_uri`).
/// - `authorized_user` (gcloud ADC) — the OAuth refresh-token grant. No scope
///   is sent: a refresh can only *narrow* the consented scopes, and the ADC
///   consent already carries `cloud-platform`, which Cloud SQL accepts for
///   IAM login (verified live against a Cloud SQL MySQL 8.0 instance).
pub async fn mint_token(key_path: &str, scope: &str) -> anyhow::Result<(String, String)> {
    let raw = std::fs::read_to_string(key_path)
        .map_err(|e| anyhow::anyhow!("credential file {key_path}: {e}"))?;
    let key: KeyFile = serde_json::from_str(&raw).map_err(|e| {
        anyhow::anyhow!("credential file {key_path} is neither a service-account key nor \
            gcloud application-default credentials: {e}")
    })?;

    match key {
        KeyFile::ServiceAccount(key) => mint_service_account(&key, scope).await
            .map(|t| (t, key.project_id.clone())),
        KeyFile::AuthorizedUser(key) => mint_authorized_user(&key).await
            .map(|t| (t, String::new())),
    }
}

/// The JWT-bearer grant: sign claims with the service account's private key
/// and exchange the assertion at its `token_uri`.
async fn mint_service_account(key: &ServiceAccountKey, scope: &str) -> anyhow::Result<String> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)?
        .as_secs();
    let claims = Claims {
        iss: &key.client_email,
        scope,
        aud: &key.token_uri,
        iat: now,
        exp: now + 3600,
    };

    let header = jsonwebtoken::Header::new(jsonwebtoken::Algorithm::RS256);
    let enc = jsonwebtoken::EncodingKey::from_rsa_pem(key.private_key.as_bytes())
        .map_err(|e| anyhow::anyhow!("service-account private key is not valid RSA PEM: {e}"))?;
    let assertion = jsonwebtoken::encode(&header, &claims, &enc)
        .map_err(|e| anyhow::anyhow!("signing the assertion failed: {e}"))?;

    token_request(&key.token_uri, &[
        ("grant_type", "urn:ietf:params:oauth:grant-type:jwt-bearer"),
        ("assertion", assertion.as_str()),
    ]).await
}

/// The refresh-token grant for gcloud application-default credentials.
async fn mint_authorized_user(key: &AuthorizedUserKey) -> anyhow::Result<String> {
    token_request("https://oauth2.googleapis.com/token", &[
        ("grant_type", "refresh_token"),
        ("client_id", key.client_id.as_str()),
        ("client_secret", key.client_secret.as_str()),
        ("refresh_token", key.refresh_token.as_str()),
    ]).await
}

/// POST a grant form to a token endpoint and unwrap the access token.
async fn token_request(url: &str, form: &[(&str, &str)]) -> anyhow::Result<String> {
    let client = reqwest::Client::builder().build()?;
    let resp = client
        .post(url)
        .form(form)
        .send()
        .await
        .map_err(|e| anyhow::anyhow!("token request failed: {e}"))?;

    if !resp.status().is_success() {
        let code = resp.status();
        let body = resp.text().await.unwrap_or_default();
        anyhow::bail!("token endpoint returned {code}: {body}");
    }
    let tok: TokenResponse = resp
        .json()
        .await
        .map_err(|e| anyhow::anyhow!("token response was not JSON: {e}"))?;
    Ok(tok.access_token)
}

const ADC_FILE: &str = "application_default_credentials.json";

/// The pure core of credential-file resolution, with the environment injected
/// so every platform's shape is unit-tested without mutating real env vars.
///
/// Order (first hit wins):
/// 1. `GOOGLE_APPLICATION_CREDENTIALS` — Google's own convention; every Google
///    client library honors it, and the file may be either credential shape.
/// 2. `$CLOUDSDK_CONFIG/application_default_credentials.json` — gcloud's
///    config-dir override, same on all three desktops.
/// 3. `%APPDATA%\gcloud\…` — gcloud's default on Windows.
/// 4. `~/.config/gcloud\…` — gcloud's default on macOS and Linux.
///
/// APPDATA before HOME is deliberate, not a guess: on Windows both can exist
/// (git-bash sets HOME), and APPDATA is where gcloud actually writes; on
/// macOS/Linux APPDATA does not exist, so the Windows branch is unreachable
/// there. No `#[cfg]` — the difference is data, so it is resolved at runtime
/// and cannot rot on a platform nobody compiled.
fn credentials_path_from(get: impl Fn(&str) -> Option<std::ffi::OsString>) -> Option<std::path::PathBuf> {
    if let Some(f) = get("GOOGLE_APPLICATION_CREDENTIALS") {
        if !f.is_empty() { return Some(std::path::PathBuf::from(f)); }
    }
    if let Some(dir) = get("CLOUDSDK_CONFIG") {
        if !dir.is_empty() { return Some(std::path::PathBuf::from(dir).join(ADC_FILE)); }
    }
    if let Some(appdata) = get("APPDATA") {
        if !appdata.is_empty() {
            return Some(std::path::PathBuf::from(appdata).join("gcloud").join(ADC_FILE));
        }
    }
    get("HOME").filter(|h| !h.is_empty())
        .map(|h| std::path::PathBuf::from(h).join(".config").join("gcloud").join(ADC_FILE))
}

/// The credential file to mint from when the connection sets no key path —
/// see `credentials_path_from` for the resolution order.
pub fn default_credentials_path() -> Option<std::path::PathBuf> {
    credentials_path_from(|k| std::env::var_os(k))
}

/// Mint a Cloud SQL IAM DB access token (the DB password). Thin wrapper.
pub async fn iam_access_token(key_path: &str) -> anyhow::Result<String> {
    Ok(mint_token(key_path, SQL_LOGIN_SCOPE).await?.0)
}

#[cfg(test)]
mod tests {
    /// The two credential shapes parse into the right grant, and anything
    /// else is rejected with a clear error. No network — the grant itself is
    /// exercised live by `live_iam_mysql_login` below.
    #[test]
    fn parses_service_account_key() {
        let k: super::KeyFile = serde_json::from_str(r#"{
            "type": "service_account",
            "client_email": "sa@proj.iam.gserviceaccount.com",
            "private_key": "-----BEGIN RSA PRIVATE KEY-----\n…\n-----END RSA PRIVATE KEY-----\n",
            "token_uri": "https://oauth2.googleapis.com/token",
            "project_id": "proj"
        }"#).unwrap();
        assert!(matches!(k, super::KeyFile::ServiceAccount(_)));
    }

    #[test]
    fn parses_authorized_user_key() {
        let k: super::KeyFile = serde_json::from_str(r#"{
            "type": "authorized_user",
            "client_id": "123.apps.googleusercontent.com",
            "client_secret": "secret",
            "refresh_token": "refresh"
        }"#).unwrap();
        assert!(matches!(k, super::KeyFile::AuthorizedUser(_)));
    }

    #[test]
    fn rejects_other_credential_types() {
        // (KeyFile deliberately does not derive Debug — it holds secrets.)
        let err = match serde_json::from_str::<super::KeyFile>(r#"{"type": "external_account"}"#) {
            Ok(_) => panic!("external_account must not parse"),
            Err(e) => e.to_string(),
        };
        assert!(err.contains("unknown variant"), "got: {err}");
    }

    // ── credential-file resolution, per platform ─────────────────────────────
    //
    // These simulate each desktop's environment instead of trusting the build
    // machine's: the resolver is runtime code with no #[cfg], so these tables
    // ARE the Windows and Linux proof.

    use std::ffi::OsString;
    use std::path::PathBuf;

    fn env_of(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<OsString> {
        let map: std::collections::HashMap<String, OsString> = pairs.iter()
            .map(|(k, v)| (k.to_string(), OsString::from(v))).collect();
        move |k| map.get(k).cloned()
    }

    #[test]
    fn resolves_macos_and_linux_default() {
        let p = super::credentials_path_from(env_of(&[("HOME", "/home/j")]));
        assert_eq!(p, Some(PathBuf::from("/home/j/.config/gcloud/application_default_credentials.json")));
        let p = super::credentials_path_from(env_of(&[("HOME", "/Users/j")]));
        assert_eq!(p, Some(PathBuf::from("/Users/j/.config/gcloud/application_default_credentials.json")));
    }

    #[test]
    fn resolves_windows_default() {
        let p = super::credentials_path_from(env_of(&[
            ("APPDATA", r"C:\Users\j\AppData\Roaming"),
            ("SystemRoot", r"C:\Windows"),
        ]));
        // Component comparison, not string: path separators render per host OS.
        let p = p.unwrap();
        let comps: Vec<_> = p.components().map(|c| c.as_os_str().to_string_lossy().into_owned()).collect();
        assert_eq!(comps[..comps.len() - 2].join("/"), r"C:\Users\j\AppData\Roaming");
        assert_eq!(comps[comps.len() - 2..], ["gcloud", "application_default_credentials.json"]);
    }

    #[test]
    fn windows_with_gitbash_home_still_picks_appdata() {
        // Both base variables exist (git-bash sets HOME on Windows) — APPDATA
        // is where gcloud really writes, so it must win.
        let p = super::credentials_path_from(env_of(&[
            ("APPDATA", r"C:\Users\j\AppData\Roaming"),
            ("HOME", r"C:\Users\j"),
        ]));
        let s = p.unwrap().to_string_lossy().into_owned();
        assert!(s.starts_with(r"C:\Users\j\AppData\Roaming"), "got: {s}");
        assert!(s.contains("gcloud"), "got: {s}");
    }

    #[test]
    fn cloudsdk_config_overrides_the_platform_default() {
        // macOS/Linux shape
        let p = super::credentials_path_from(env_of(&[
            ("CLOUDSDK_CONFIG", "/custom/gcloud"), ("HOME", "/home/j"),
        ])).unwrap();
        assert_eq!(p, PathBuf::from("/custom/gcloud/application_default_credentials.json"));
        // Windows shape (components compared — separators render per host OS)
        let p = super::credentials_path_from(env_of(&[
            ("CLOUDSDK_CONFIG", r"D:\gcloud"), ("APPDATA", r"C:\Users\j\AppData\Roaming"),
        ])).unwrap();
        let s = p.to_string_lossy().into_owned();
        assert!(s.starts_with(r"D:\gcloud"), "got: {s}");
        assert!(s.ends_with("application_default_credentials.json"), "got: {s}");
    }

    #[test]
    fn google_application_credentials_wins_over_everything() {
        let p = super::credentials_path_from(env_of(&[
            ("GOOGLE_APPLICATION_CREDENTIALS", "/keys/sa.json"),
            ("CLOUDSDK_CONFIG", "/custom/gcloud"),
            ("HOME", "/home/j"),
            ("APPDATA", r"C:\x"),
        ]));
        assert_eq!(p, Some(PathBuf::from("/keys/sa.json")));
        // …and it may point at either credential shape — mint_token branches
        // on the file's `type`, so a service-account key here is fine.
    }

    #[test]
    fn empty_and_missing_environment_resolves_nothing() {
        assert_eq!(super::credentials_path_from(env_of(&[])), None);
        assert_eq!(super::credentials_path_from(env_of(&[
            ("GOOGLE_APPLICATION_CREDENTIALS", ""), ("CLOUDSDK_CONFIG", ""),
            ("APPDATA", ""), ("HOME", ""),
        ])), None);
    }
    /// Live end-to-end check of IAM token-as-password against a real Cloud SQL
    /// MySQL instance. Opt-in, env-driven, never runs in the default suite:
    ///
    /// ```sh
    /// TXUI_LIVE_IAM=127.0.0.1:36070 TXUI_LIVE_IAM_USER='user@example.com' \
    /// TXUI_LIVE_IAM_TOKEN="$(gcloud sql generate-login-token)" \
    /// cargo test --lib live_iam_mysql_login -- --ignored --nocapture
    /// ```
    ///
    /// The token comes from the environment because minting is a separate
    /// concern: `mint_token` needs a *service-account* key, while the machine
    /// this test was written for authenticates as a user account via gcloud.
    #[tokio::test]
    #[ignore]
    async fn live_iam_mysql_login() {
        let addr = std::env::var("TXUI_LIVE_IAM").expect("TXUI_LIVE_IAM=host:port");
        let user = std::env::var("TXUI_LIVE_IAM_USER").expect("TXUI_LIVE_IAM_USER");
        let token = std::env::var("TXUI_LIVE_IAM_TOKEN").expect("TXUI_LIVE_IAM_TOKEN");
        let (host, port) = addr.split_once(':').expect("host:port");

        let mut cfg = crate::db::types::ConnectionConfig::new(crate::db::types::Engine::Mysql, "live-iam");
        cfg.host = Some(host.to_string());
        cfg.port = Some(port.parse().expect("port"));
        cfg.user = Some(user);

        let session = crate::db::mysql::open(&cfg, Some(token), None).await
            .expect("mysql::open with IAM token");
        let crate::db::types::LiveSession::Mysql(pool) = session else { panic!("not mysql") };
        let version: String = sqlx::query_scalar("SELECT VERSION()").fetch_one(&pool).await.unwrap();
        let who: String = sqlx::query_scalar("SELECT CURRENT_USER()").fetch_one(&pool).await.unwrap();
        println!("CONNECTED — server {version}, authenticated as {who}");
        pool.close().await;
    }

    /// The shipped path, whole: `open_session` with `use_iam_auth` and NO key
    /// path → resolves this machine's gcloud ADC → mints via the
    /// refresh-token grant → connects with the token as the password.
    ///
    /// ```sh
    /// TXUI_LIVE_IAM=127.0.0.1:36070 TXUI_LIVE_IAM_USER='jane.doe' \
    /// cargo test --lib live_iam_mysql_via_adc -- --ignored --nocapture
    /// ```
    #[tokio::test]
    #[ignore]
    async fn live_iam_mysql_via_adc() {
        let addr = std::env::var("TXUI_LIVE_IAM").expect("TXUI_LIVE_IAM=host:port");
        let user = std::env::var("TXUI_LIVE_IAM_USER").expect("TXUI_LIVE_IAM_USER");
        let (host, port) = addr.split_once(':').expect("host:port");

        let mut cfg = crate::db::types::ConnectionConfig::new(crate::db::types::Engine::Mysql, "live-iam-adc");
        cfg.host = Some(host.to_string());
        cfg.port = Some(port.parse().expect("port"));
        cfg.user = Some(user);
        cfg.use_iam_auth = true; // iam_key_path stays None → ADC fallback

        let sessions: crate::db::connection::SessionMap = Default::default();
        let id = crate::db::connection::open_session(&cfg, None, &sessions, None)
            .await.expect("open_session via ADC-minted IAM token");
        let session = crate::db::connection::get_session_pub(id, &sessions).await.unwrap();
        let version = crate::db::connection::probe_session(&session).await.unwrap();
        println!("CONNECTED via ADC — server {version:?}");
    }
}
