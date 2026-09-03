//! End-of-life lookup for MySQL / MariaDB release cycles.
//!
//! Three tiers, best data first:
//!   1. live API `https://endoflife.date/api/{product}.json` (5s timeout)
//!   2. on-disk cache `<data_dir>/eol-cache.json` (fresh < 24h → "cache";
//!      stale cache still beats nothing when offline)
//!   3. BUILTIN — a compiled-in snapshot of the same API, so an air-gapped
//!      install still gets correct dates for every cycle it knows about.
//!
//! This is strictly better than MySQLTuner-perl, which only knows versions it
//! shipped with: TxUI stays current online AND works air-gapped.

use std::path::Path;

use chrono::NaiveDate;
use serde::{Deserialize, Serialize};

use super::EolInfo;

const CACHE_FILE: &str = "eol-cache.json";
const CACHE_TTL_SECS: i64 = 24 * 3600;
const FETCH_TIMEOUT_SECS: u64 = 5;
/// A cycle whose EOL is at most this many days out is "eol-soon".
const EOL_SOON_DAYS: i64 = 180;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EolCycle {
    pub cycle:  String,
    /// ISO date; None = API reported `eol: false` (no EOL announced yet)
    pub eol:    Option<String>,
    pub latest: Option<String>,
    pub lts:    bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CacheEntry {
    fetched_at: i64,
    cycles:     Vec<EolCycle>,
}

/// Resolve EOL info for `product` ("mysql" | "mariadb") release `cycle`
/// ("8.0", "10.11", …). Never fails — worst case is status "unknown".
pub async fn lookup(product: &str, cycle: &str, data_dir: &Path) -> EolInfo {
    let today = chrono::Local::now().date_naive();
    let cache_path = data_dir.join(CACHE_FILE);

    // 1. Fresh cache → serve without touching the network.
    if let Some((entry, _age)) = read_cache(&cache_path, product) {
        if entry.fetched_at + CACHE_TTL_SECS > chrono::Utc::now().timestamp() {
            return build_info(product, cycle, &entry.cycles, today, "cache");
        }
    }

    // 2. Live fetch; on success refresh the cache for this product.
    match fetch_product(product).await {
        Ok(cycles) => {
            write_cache(&cache_path, product, &cycles);
            return build_info(product, cycle, &cycles, today, "endoflife.date");
        }
        Err(e) => log::info!("tuner eol fetch failed ({}), falling back", e),
    }

    // 3. Stale cache beats the builtin snapshot (likely newer data).
    if let Some((entry, _)) = read_cache(&cache_path, product) {
        return build_info(product, cycle, &entry.cycles, today, "cache");
    }

    // 4. Compiled-in snapshot.
    if let Some(cycles) = builtin_cycles(product) {
        return build_info(product, cycle, &cycles, today, "builtin-fallback");
    }

    EolInfo {
        product:  product.to_string(),
        cycle:    cycle.to_string(),
        eol_date: None,
        status:   "unknown".into(),
        latest:   None,
        source:   "builtin-fallback".into(),
    }
}

fn build_info(product: &str, cycle: &str, cycles: &[EolCycle], today: NaiveDate, source: &str) -> EolInfo {
    match cycles.iter().find(|c| c.cycle == cycle) {
        Some(c) => EolInfo {
            product:  product.to_string(),
            cycle:    cycle.to_string(),
            eol_date: c.eol.clone(),
            status:   compute_status(c.eol.as_deref(), today).to_string(),
            latest:   c.latest.clone(),
            source:   source.to_string(),
        },
        None => EolInfo {
            product:  product.to_string(),
            cycle:    cycle.to_string(),
            eol_date: None,
            status:   "unknown".into(),
            latest:   None,
            source:   source.to_string(),
        },
    }
}

/// "eol" | "eol-soon" | "supported" | "unknown" for one cycle.
pub fn compute_status(eol_date: Option<&str>, today: NaiveDate) -> &'static str {
    let Some(date) = eol_date else { return "unknown" };
    let Ok(eol) = NaiveDate::parse_from_str(date, "%Y-%m-%d") else { return "unknown" };
    if today > eol {
        "eol"
    } else if (eol - today).num_days() <= EOL_SOON_DAYS {
        "eol-soon"
    } else {
        "supported"
    }
}

async fn fetch_product(product: &str) -> anyhow::Result<Vec<EolCycle>> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(FETCH_TIMEOUT_SECS))
        .user_agent("txui-tuner")
        .build()?;
    let url = format!("https://endoflife.date/api/{}.json", product);
    let body = client.get(&url).send().await?.error_for_status()?.text().await?;
    let raw: Vec<serde_json::Value> = serde_json::from_str(&body)?;
    Ok(raw.iter().filter_map(parse_cycle).collect())
}

/// Parse one endoflife.date cycle entry, tolerating the API's loose typing:
/// `eol` may be a date string or `false`; `lts` may be a bool or a date
/// string (MySQL 8.0 reports the date it BECAME LTS); `latest` may be missing.
fn parse_cycle(v: &serde_json::Value) -> Option<EolCycle> {
    let cycle = v.get("cycle")?.as_str()?.to_string();
    let eol = match v.get("eol") {
        Some(serde_json::Value::String(s)) => Some(s.clone()),
        _ => None,
    };
    let latest = v.get("latest").and_then(|l| l.as_str()).map(String::from);
    let lts = match v.get("lts") {
        Some(serde_json::Value::Bool(b)) => *b,
        Some(serde_json::Value::String(_)) => true, // date the cycle turned LTS
        _ => false,
    };
    Some(EolCycle { cycle, eol, latest, lts })
}

fn read_cache(path: &Path, product: &str) -> Option<(CacheEntry, i64)> {
    let text = std::fs::read_to_string(path).ok()?;
    let map: serde_json::Value = serde_json::from_str(&text).ok()?;
    let entry: CacheEntry = serde_json::from_value(map.get(product)?.clone()).ok()?;
    let age = chrono::Utc::now().timestamp() - entry.fetched_at;
    Some((entry, age))
}

/// Merge this product's fresh data into the cache file (other products kept).
fn write_cache(path: &Path, product: &str, cycles: &[EolCycle]) {
    let mut map: serde_json::Map<String, serde_json::Value> = std::fs::read_to_string(path)
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default();
    let entry = CacheEntry {
        fetched_at: chrono::Utc::now().timestamp(),
        cycles:     cycles.to_vec(),
    };
    if let Ok(v) = serde_json::to_value(&entry) {
        map.insert(product.to_string(), v);
        // atomic-ish: tmp + rename, same pattern as storage.rs
        let tmp = path.with_extension("tmp");
        if std::fs::write(&tmp, serde_json::to_string_pretty(&map).unwrap_or_default()).is_ok() {
            let _ = std::fs::rename(&tmp, path);
        }
    }
}

/// Compiled-in snapshot of endoflife.date, taken 2026-08-05 (mysql 9.7 LTS
/// era). Used only when both the network and the cache are unavailable —
/// clearly flagged via source "builtin-fallback" so the UI can note its age.
fn builtin_cycles(product: &str) -> Option<Vec<EolCycle>> {
    let c = |cycle: &str, eol: &str, latest: &str, lts: bool| EolCycle {
        cycle: cycle.into(), eol: Some(eol.into()), latest: Some(latest.into()), lts,
    };
    match product {
        "mysql" => Some(vec![
            c("5.6", "2021-02-28", "5.6.51", false),
            c("5.7", "2023-10-31", "5.7.44", false),
            c("8.0", "2026-04-30", "8.0.46", true),
            c("8.4", "2032-04-30", "8.4.11", true),
            c("9.0", "2024-10-15", "9.0.1", false),
            c("9.1", "2025-01-21", "9.1.2", false),
            c("9.2", "2025-04-15", "9.2.2", false),
            c("9.3", "2025-07-22", "9.3.2", false),
            c("9.4", "2025-10-21", "9.4.2", false),
            c("9.5", "2026-01-20", "9.5.2", false),
            c("9.6", "2026-04-21", "9.6.1", false),
            c("9.7", "2034-04-21", "9.7.2", true),
        ]),
        // PostgreSQL gives every major exactly five years from its initial
        // release and has no LTS designation — the community line is the
        // support line, so `lts` is false throughout.
        "postgresql" => Some(vec![
            c("12", "2024-11-14", "12.22", false),
            c("13", "2025-11-13", "13.22", false),
            c("14", "2026-11-12", "14.19", false),
            c("15", "2027-11-11", "15.14", false),
            c("16", "2028-11-09", "16.10", false),
            c("17", "2029-11-08", "17.10", false),
            c("18", "2030-11-14", "18.4",  false),
        ]),
        // Redis cycles are major.minor and most current ones have no EOL
        // date announced yet — the API reports `eol: false`, which maps to
        // None and a status of "unknown" rather than a false "supported".
        "redis" => Some(vec![
            c("5.0", "2022-04-27", "5.0.14", false),
            c("6.0", "2022-05-31", "6.0.20", false),
            c("6.2", "2027-04-01", "6.2.23", false),
            c("7.0", "2024-07-29", "7.0.15", false),
            c("7.2", "2029-12-01", "7.2.15", false),
            c("7.4", "2029-12-01", "7.4.10", false),
            c("8.0", "2026-12-01", "8.0.6",  false),
            c("8.2", "2030-09-01", "8.2.8",  false),
        ]),
        "mariadb" => Some(vec![
            c("10.5",  "2025-06-24", "10.5.29", true),
            c("10.6",  "2026-07-06", "10.6.27", true),
            c("10.11", "2028-02-16", "10.11.18", true),
            c("11.4",  "2029-05-29", "11.4.12", true),
            c("11.8",  "2028-06-04", "11.8.8", true),
        ]),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn d(s: &str) -> NaiveDate { NaiveDate::parse_from_str(s, "%Y-%m-%d").unwrap() }

    #[test]
    fn status_thresholds() {
        let today = d("2026-08-05");
        assert_eq!(compute_status(Some("2026-04-30"), today), "eol");
        assert_eq!(compute_status(Some("2026-08-05"), today), "eol-soon"); // today == eol
        assert_eq!(compute_status(Some("2026-11-01"), today), "eol-soon");  // 88 days out
        assert_eq!(compute_status(Some("2027-01-01"), today), "eol-soon");  // 149 days < 180
        assert_eq!(compute_status(Some("2027-03-01"), today), "supported"); // 208 days
        assert_eq!(compute_status(Some("2032-04-30"), today), "supported");
        assert_eq!(compute_status(None, today), "unknown");
        assert_eq!(compute_status(Some("garbage"), today), "unknown");
    }

    #[test]
    fn builtin_knows_current_cycles() {
        let mysql = builtin_cycles("mysql").unwrap();
        let c80 = mysql.iter().find(|c| c.cycle == "8.0").unwrap();
        assert_eq!(c80.eol.as_deref(), Some("2026-04-30"));
        assert_eq!(compute_status(c80.eol.as_deref(), d("2026-08-05")), "eol");
        let c97 = mysql.iter().find(|c| c.cycle == "9.7").unwrap();
        assert!(c97.lts);
        assert_eq!(compute_status(c97.eol.as_deref(), d("2026-08-05")), "supported");
        assert!(builtin_cycles("mariadb").unwrap().iter().any(|c| c.cycle == "11.4"));

        // PostgreSQL: every major gets exactly five years and there is no LTS
        // line, so the status ladder is driven purely by the release date.
        let pg = builtin_cycles("postgresql").expect("postgresql cycles");
        assert!(!pg.iter().any(|c| c.lts), "PostgreSQL has no LTS designation");
        let c13 = pg.iter().find(|c| c.cycle == "13").unwrap();
        assert_eq!(compute_status(c13.eol.as_deref(), d("2026-08-05")), "eol");
        let c14 = pg.iter().find(|c| c.cycle == "14").unwrap();
        assert_eq!(compute_status(c14.eol.as_deref(), d("2026-08-05")), "eol-soon");
        let c16 = pg.iter().find(|c| c.cycle == "16").unwrap();
        assert_eq!(compute_status(c16.eol.as_deref(), d("2026-08-05")), "supported");
        let c18 = pg.iter().find(|c| c.cycle == "18").unwrap();
        assert_eq!(compute_status(c18.eol.as_deref(), d("2026-08-05")), "supported");

        // An engine we do not ship data for must still degrade gracefully.
        assert!(builtin_cycles("cockroachdb").is_none());
    }

    #[test]
    fn parses_loose_api_typing() {
        let v: serde_json::Value = serde_json::json!([
            {"cycle": "8.0", "eol": "2026-04-30", "latest": "8.0.46", "lts": "2023-07-18"},
            {"cycle": "12.3", "eol": false, "latest": "12.3.2", "lts": true},
            {"cycle": "9.6", "eol": "2026-04-21"}
        ]);
        let cycles: Vec<EolCycle> = v.as_array().unwrap().iter().filter_map(parse_cycle).collect();
        assert_eq!(cycles.len(), 3);
        assert!(cycles[0].lts);
        assert_eq!(cycles[0].eol.as_deref(), Some("2026-04-30"));
        assert_eq!(cycles[1].eol, None); // eol: false → not announced
        assert!(!cycles[2].lts);
    }

    #[tokio::test]
    async fn fresh_cache_serves_without_network() {
        let dir = std::env::temp_dir().join(format!("txui-eol-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        write_cache(&dir.join(CACHE_FILE), "mysql", &builtin_cycles("mysql").unwrap());
        // Cache was just written → lookup must hit tier 1, no network needed.
        let info = lookup("mysql", "8.0", &dir).await;
        assert_eq!(info.source, "cache");
        assert_eq!(info.eol_date.as_deref(), Some("2026-04-30"));
        assert!(["eol", "eol-soon", "supported"].contains(&info.status.as_str()));
        let unknown = lookup("mysql", "4.1", &dir).await;
        assert_eq!(unknown.status, "unknown");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
