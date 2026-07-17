//! Tray icon, menu, and the health-poll loop that keeps the menu current.

use std::process::Command;
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use tauri::{
    image::Image,
    menu::{MenuBuilder, MenuItem, MenuItemBuilder, PredefinedMenuItem},
    tray::TrayIconBuilder,
    App, Runtime,
};

use crate::config::TrayConfig;
use crate::health::{self, ServerStatus};
use crate::supervisor::Supervisor;

/// How often to re-probe `/api/health` and refresh the tray.
const POLL_INTERVAL: Duration = Duration::from_secs(15);

/// Build the tray icon + menu and start the background health poll. Called from
/// the Tauri `setup` hook.
pub fn init<R: Runtime>(
    app: &App<R>,
    cfg: &TrayConfig,
    supervisor: Arc<Supervisor>,
) -> tauri::Result<()> {
    let attached = supervisor.is_attached();

    let open_item = MenuItemBuilder::with_id("open_dashboard", "Open Dashboard").build(app)?;
    let status_item = MenuItemBuilder::with_id("status", "Status: starting…")
        .enabled(false)
        .build(app)?;
    let restart_item = MenuItemBuilder::with_id(
        "restart",
        if attached {
            "Restart server (attached — n/a)"
        } else {
            "Restart server"
        },
    )
    .enabled(!attached)
    .build(app)?;
    let logs_item = MenuItemBuilder::with_id("view_logs", "View logs").build(app)?;
    let quit_item = MenuItemBuilder::with_id("quit", "Quit").build(app)?;

    let menu = MenuBuilder::new(app)
        .items(&[
            &open_item,
            &status_item,
            &PredefinedMenuItem::separator(app)?,
            &restart_item,
            &logs_item,
            &PredefinedMenuItem::separator(app)?,
            &quit_item,
        ])
        .build()?;

    // If a foreign process holds the port (or we attached), reflect it in the
    // status line up front.
    if let Some(note) = supervisor.attach_note() {
        let _ = status_item.set_text(format!("Status: {note}"));
    }

    let menu_sup = supervisor.clone();
    let menu_url = cfg.dashboard_url();
    let tray = TrayIconBuilder::with_id("minder-tray")
        .icon(tray_icon())
        .tooltip("Project Minder")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(move |app, event| {
            handle_menu_event(app, event.id().as_ref(), &menu_sup, &menu_url);
        })
        .build(app)?;

    // Health-poll loop: refresh the Status line + tray tooltip every 15s.
    spawn_poll_loop(cfg.port, attached, supervisor.clone(), status_item, tray);

    Ok(())
}

fn handle_menu_event<R: Runtime>(
    app: &tauri::AppHandle<R>,
    id: &str,
    supervisor: &Arc<Supervisor>,
    dashboard_url: &str,
) {
    match id {
        "open_dashboard" => open_url(dashboard_url),
        "restart" => {
            if supervisor.is_attached() {
                return; // menu item is disabled, but guard anyway
            }
            // Restart blocks up to ~6s on the graceful stop — do it off the
            // main thread so the tray menu stays responsive.
            let sup = supervisor.clone();
            thread::spawn(move || sup.restart());
        }
        "view_logs" => open_logs_dir(),
        "quit" => {
            // Block until the sidecar is cleanly stopped, THEN exit — so Quit
            // never leaves an orphan node process behind.
            supervisor.shutdown();
            app.exit(0);
        }
        _ => {}
    }
}

fn spawn_poll_loop<R: Runtime>(
    port: u16,
    attached: bool,
    supervisor: Arc<Supervisor>,
    status_item: MenuItem<R>,
    tray: tauri::tray::TrayIcon<R>,
) {
    thread::spawn(move || loop {
        let status = health::probe(port);
        let (line, tip) = describe(status, port, attached, &supervisor);
        let _ = status_item.set_text(line);
        let _ = tray.set_tooltip(Some(&tip));
        thread::sleep(POLL_INTERVAL);
    });
}

/// Human-readable Status line + tray tooltip for a probe result.
fn describe(
    status: ServerStatus,
    port: u16,
    attached: bool,
    supervisor: &Arc<Supervisor>,
) -> (String, String) {
    let suffix = if attached {
        match supervisor.attach_note() {
            Some(note) => format!(" — {note}"),
            None => " — attached".to_string(),
        }
    } else {
        String::new()
    };
    let (word, tip_word) = match status {
        ServerStatus::Up => ("running", "running"),
        ServerStatus::Degraded => ("degraded", "degraded"),
        ServerStatus::Down => ("not responding", "not responding"),
    };
    (
        format!("Status: {word} (:{port}){suffix}"),
        format!("Project Minder — {tip_word} (:{port}){suffix}"),
    )
}

/// The tray icon image, embedded at compile time.
fn tray_icon() -> Image<'static> {
    Image::from_bytes(include_bytes!("../icons/32x32.png"))
        .expect("bundled tray icon (icons/32x32.png) must be a valid PNG")
}

/// Open a URL in the user's default browser. No webview is embedded (v1 uses
/// the real browser, per the plan).
fn open_url(url: &str) {
    #[cfg(windows)]
    {
        // `cmd /C start "" <url>` — the empty "" is the window title arg `start`
        // consumes, so the URL isn't mistaken for it.
        let _ = Command::new("cmd").args(["/C", "start", "", url]).spawn();
    }
    #[cfg(target_os = "macos")]
    {
        let _ = Command::new("open").arg(url).spawn();
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let _ = Command::new("xdg-open").arg(url).spawn();
    }
}

/// Open `~/.minder/logs/` in the OS file manager (creating it if absent so the
/// file manager doesn't error on a missing path).
fn open_logs_dir() {
    let dir = logs_dir();
    let _ = std::fs::create_dir_all(&dir);
    let path = dir.to_string_lossy().to_string();
    #[cfg(windows)]
    {
        let _ = Command::new("explorer").arg(&path).spawn();
    }
    #[cfg(target_os = "macos")]
    {
        let _ = Command::new("open").arg(&path).spawn();
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let _ = Command::new("xdg-open").arg(&path).spawn();
    }
}

fn logs_dir() -> std::path::PathBuf {
    home_dir().join(".minder").join("logs")
}

/// Home directory without pulling in an extra crate: `USERPROFILE` on Windows,
/// `HOME` elsewhere.
fn home_dir() -> std::path::PathBuf {
    #[cfg(windows)]
    let key = "USERPROFILE";
    #[cfg(not(windows))]
    let key = "HOME";
    std::env::var_os(key)
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| std::path::PathBuf::from("."))
}
