// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
  // Baseline for the TXUI_TRACE_STARTUP trace — first statement, so nothing
  // before `setup` is invisible to it.
  let _ = app_lib::PROC_START.set(std::time::Instant::now());
  app_lib::apply_toolkit_theme();
  app_lib::run();
}
