// Tray-only app: no window is created at launch, so hide the console on
// release builds (debug keeps it for the supervisor/server log tee).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! Project Minder tray app (Phase C1).
//!
//! A native tray app that spawns, supervises, and exposes the packaged Next
//! server as a sidecar. It has no main window — the dashboard opens in the
//! user's default browser. See docs/superpowers/plans/2026-07-16-service-and-tray.md.

mod config;
mod health;
mod supervisor;
mod tray;

use std::sync::Arc;

use tauri::Manager;

use crate::config::TrayConfig;
use crate::supervisor::Supervisor;

fn main() {
    let cfg = TrayConfig::from_env();

    tauri::Builder::default()
        // Single-instance must be the first plugin registered (plugin docs):
        // a second launch is a no-op — the running instance already owns the
        // tray and the sidecar.
        .plugin(tauri_plugin_single_instance::init(|_app, _args, _cwd| {
            supervisor::log("second instance launched — ignoring (already running)");
        }))
        // Opens the dashboard URL / the logs folder without shelling through a
        // command parser (see tray::open_url / open_logs_dir).
        .plugin(tauri_plugin_opener::init())
        .setup(move |app| {
            // Resolve where the packaged server lives: MINDER_SERVER_DIST (dev)
            // wins inside TrayConfig; otherwise the Tauri resource dir (prod).
            let resource_dir = app.path().resource_dir().ok();
            let payload_dir = cfg.payload_dir(resource_dir.as_ref());

            let supervisor: Arc<Supervisor> = Supervisor::start(cfg.clone(), payload_dir);

            tray::init(app, &cfg, supervisor)?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building the Minder tray app")
        // Keep the process alive with no windows open. Without this the app
        // would exit as soon as setup() returns (no window to keep the loop
        // running); ExitRequested with no windows must be prevented.
        .run(|_app_handle, event| {
            if let tauri::RunEvent::ExitRequested { api, code, .. } = event {
                // An ExitRequested with `code: None` is an implicit request (no
                // windows to keep us alive) — prevent it so the tray keeps
                // running. The tray's Quit item calls `app.exit(0)`, which
                // arrives here with `code: Some(0)`; that one we let through so
                // Tauri tears the tray icon down cleanly (the sidecar was
                // already stopped by supervisor.shutdown() before exit).
                if code.is_none() {
                    api.prevent_exit();
                }
            }
        });
}
