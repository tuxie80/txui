//! Local process metrics for the app-wide status bar — the TxUI process's own
//! RSS and CPU usage, polled by the frontend at ~1 Hz. Distinct from the
//! server-side DB metrics in `ops.rs`.

use serde::Serialize;
use std::sync::{Mutex, OnceLock};
use sysinfo::{MemoryRefreshKind, Pid, ProcessRefreshKind, ProcessesToUpdate, RefreshKind, System};

#[derive(Serialize, Default)]
pub struct AppMetrics {
    pub rss_bytes: u64,
    pub cpu_percent: f32,
    pub total_mem_bytes: u64,
    pub used_mem_bytes: u64,
}

/// One shared `System`: CPU% is a delta between refreshes, so the instance
/// must persist across polls. sysinfo enforces a ~200ms minimum update
/// interval internally, so 1s polling always yields a real percentage
/// (the very first poll reports 0.0).
static SYSTEM: OnceLock<Mutex<System>> = OnceLock::new();

#[tauri::command]
pub fn app_metrics() -> AppMetrics {
    let mutex = SYSTEM.get_or_init(|| {
        Mutex::new(System::new_with_specifics(
            RefreshKind::nothing().with_memory(MemoryRefreshKind::everything()),
        ))
    });
    let pid = Pid::from_u32(std::process::id());
    let mut sys = match mutex.lock() {
        Ok(s) => s,
        Err(_) => return AppMetrics::default(),
    };
    sys.refresh_memory();
    sys.refresh_processes_specifics(
        ProcessesToUpdate::Some(&[pid]),
        true,
        ProcessRefreshKind::nothing().with_cpu().with_memory(),
    );
    let mut m = AppMetrics {
        total_mem_bytes: sys.total_memory(),
        used_mem_bytes: sys.used_memory(),
        ..AppMetrics::default()
    };
    if let Some(p) = sys.process(pid) {
        m.rss_bytes = p.memory();
        m.cpu_percent = p.cpu_usage();
    }
    m
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn returns_current_process_metrics() {
        let first = app_metrics();
        assert!(first.rss_bytes > 0);
        assert!(first.total_mem_bytes > 0);
        std::thread::sleep(std::time::Duration::from_millis(300));
        let second = app_metrics();
        assert!(second.rss_bytes > 0);
        assert!(second.cpu_percent >= 0.0);
    }
}
