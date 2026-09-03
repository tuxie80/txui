//! Import connections from other tools' config files.
//!
//! Reads the standard client config files from the home directory and turns
//! each entry into a ConnectionConfig the user can review and save:
//!   - `~/.pgpass`            → PostgreSQL host/port/db/user (password skipped)
//!   - `~/.pg_service.conf`   → one PostgreSQL connection per [service]
//!   - `~/.my.cnf`            → MySQL [client] host/port/user/socket
//!
//! Passwords are intentionally NOT imported — the user re-enters them into the
//! encrypted vault. Returns stubs (fresh ids); nothing is saved here.

use crate::apperror::AppError;
use crate::db::types::{ConnectionConfig, Engine};

fn home() -> Option<std::path::PathBuf> {
    std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).map(Into::into)
}

fn read(path: &std::path::Path) -> Option<String> {
    std::fs::read_to_string(path).ok()
}

/// Very small INI reader → Vec<(section, key, value)> in file order.
fn parse_ini(text: &str) -> Vec<(String, String, String)> {
    let mut section = String::new();
    let mut out = Vec::new();
    for raw in text.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') || line.starts_with(';') { continue; }
        if let Some(inner) = line.strip_prefix('[').and_then(|s| s.strip_suffix(']')) {
            section = inner.trim().to_string();
            continue;
        }
        if let Some(eq) = line.find('=') {
            out.push((section.clone(), line[..eq].trim().to_string(), line[eq + 1..].trim().to_string()));
        }
    }
    out
}

fn pgpass(text: &str, out: &mut Vec<ConnectionConfig>) {
    let mut seen = std::collections::HashSet::new();
    for raw in text.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') { continue; }
        // host:port:database:username:password (last field ignored)
        let parts: Vec<&str> = line.splitn(5, ':').collect();
        if parts.len() < 4 { continue; }
        let (host, port, db, user) = (parts[0], parts[1], parts[2], parts[3]);
        if host == "*" { continue; } // a wildcard host isn't a real endpoint to add
        let key = format!("{host}:{port}:{db}:{user}");
        if !seen.insert(key) { continue; }
        let mut c = ConnectionConfig::new(Engine::Postgres, format!("{user}@{host} (pgpass)"));
        c.host = Some(host.to_string());
        c.port = port.parse().ok().filter(|_| port != "*").or(Some(5432));
        c.user = Some(user.to_string());
        if db != "*" { c.database = Some(db.to_string()); }
        c.group = Some("Imported/pgpass".into());
        out.push(c);
    }
}

fn pg_service(text: &str, out: &mut Vec<ConnectionConfig>) {
    let ini = parse_ini(text);
    let mut services: std::collections::BTreeMap<String, ConnectionConfig> = Default::default();
    for (section, key, val) in ini {
        if section.is_empty() { continue; }
        let c = services.entry(section.clone())
            .or_insert_with(|| {
                let mut c = ConnectionConfig::new(Engine::Postgres, format!("{section} (service)"));
                c.group = Some("Imported/pg_service".into());
                c
            });
        match key.as_str() {
            "host" => c.host = Some(val),
            "port" => c.port = val.parse().ok(),
            "dbname" => c.database = Some(val),
            "user" => c.user = Some(val),
            _ => {}
        }
    }
    out.extend(services.into_values());
}

fn my_cnf(text: &str, out: &mut Vec<ConnectionConfig>) {
    let ini = parse_ini(text);
    let mut c = ConnectionConfig::new(Engine::Mysql, "my.cnf (client)");
    c.group = Some("Imported/my.cnf".into());
    let mut found = false;
    for (section, key, val) in ini {
        if section != "client" && section != "mysql" { continue; }
        let v = val.trim_matches(|ch| ch == '"' || ch == '\'').to_string();
        match key.as_str() {
            "host" => { c.host = Some(v); found = true; }
            "port" => { c.port = v.parse().ok(); found = true; }
            "user" => { c.user = Some(v); found = true; }
            "socket" => { c.socket_path = Some(v); found = true; }
            "database" => { c.database = Some(v); found = true; }
            _ => {}
        }
    }
    if found { out.push(c); }
}

/// Discover connections from the local tool config files. Read-only.
#[tauri::command]
pub async fn import_tool_configs() -> Result<Vec<ConnectionConfig>, AppError> {
    let Some(h) = home() else { return Ok(vec![]) };
    let mut out = Vec::new();
    if let Some(t) = read(&h.join(".pgpass")) { pgpass(&t, &mut out); }
    if let Some(t) = read(&h.join(".pg_service.conf")) { pg_service(&t, &mut out); }
    if let Some(t) = read(&h.join(".my.cnf")) { my_cnf(&t, &mut out); }
    Ok(out)
}
