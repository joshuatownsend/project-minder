//! Tray icon, menu, and the health-poll loop that keeps the menu current.

use std::process::Command;
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use tauri::{
    image::Image,
    menu::{MenuBuilder, MenuItem, MenuItemBuilder, PredefinedMenuItem},
    tray::TrayIconBuilder,
    App, Manager, Runtime,
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
    spawn_poll_loop(cfg.port, supervisor.clone(), status_item, tray);

    Ok(())
}

fn handle_menu_event<R: Runtime>(
    app: &tauri::AppHandle<R>,
    id: &str,
    supervisor: &Arc<Supervisor>,
    dashboard_url: &str,
) {
    match id {
        "open_dashboard" => open_with_os(dashboard_url),
        "restart" => {
            if supervisor.is_attached() {
                return; // menu item is disabled, but guard anyway
            }
            // Restart blocks up to ~6s on the graceful stop — do it off the
            // main thread so the tray menu stays responsive.
            let sup = supervisor.clone();
            thread::spawn(move || sup.restart());
        }
        "view_logs" => open_logs_dir(app),
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
    supervisor: Arc<Supervisor>,
    status_item: MenuItem<R>,
    tray: tauri::tray::TrayIcon<R>,
) {
    thread::spawn(move || {
        // Cache the last rendered (line, tooltip) so steady-state polls are a
        // no-op instead of re-issuing identical set_text/set_tooltip calls.
        let mut last: Option<(String, String)> = None;
        loop {
            let status = health::probe(port);
            let next = describe(status, port, &supervisor);
            if last.as_ref() != Some(&next) {
                let _ = status_item.set_text(&next.0);
                let _ = tray.set_tooltip(Some(&next.1));
                last = Some(next);
            }
            thread::sleep(POLL_INTERVAL);
        }
    });
}

/// Human-readable Status line + tray tooltip for a probe result. Reads attach
/// state straight off the supervisor (no threaded-through flag).
fn describe(status: ServerStatus, port: u16, supervisor: &Arc<Supervisor>) -> (String, String) {
    let suffix = if supervisor.is_attached() {
        match supervisor.attach_note() {
            Some(note) => format!(" — {note}"),
            None => " — attached".to_string(),
        }
    } else {
        String::new()
    };
    let word = match status {
        ServerStatus::Up => "running",
        ServerStatus::Degraded => "degraded",
        ServerStatus::Down => "not responding",
    };
    (
        format!("Status: {word} (:{port}){suffix}"),
        format!("Project Minder — {word} (:{port}){suffix}"),
    )
}

/// The tray icon image, embedded at compile time.
fn tray_icon() -> Image<'static> {
    Image::from_bytes(include_bytes!("../icons/32x32.png"))
        .expect("bundled tray icon (icons/32x32.png) must be a valid PNG")
}

/// Open a URL or a filesystem path with the OS default handler — the browser
/// for a URL, the file manager for a directory. One shared per-OS dispatch:
/// Windows `cmd /C start "" <target>` handles both, so a single branch suffices.
/// No webview is embedded (v1 uses the real browser, per the plan).
fn open_with_os(target: &str) {
    #[cfg(windows)]
    {
        // The empty "" is the window-title arg `start` consumes, so `target`
        // isn't mistaken for it.
        let _ = Command::new("cmd")
            .args(["/C", "start", "", target])
            .spawn();
    }
    #[cfg(target_os = "macos")]
    {
        let _ = Command::new("open").arg(target).spawn();
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let _ = Command::new("xdg-open").arg(target).spawn();
    }
}

/// Open `~/.minder/logs/` in the OS file manager (creating it if absent so the
/// file manager doesn't error on a missing path). Resolves home via Tauri's
/// path API rather than a hand-rolled env lookup.
fn open_logs_dir<R: Runtime>(app: &tauri::AppHandle<R>) {
    let home = match app.path().home_dir() {
        Ok(h) => h,
        Err(e) => {
            crate::supervisor::log(&format!("could not resolve home dir for logs: {e}"));
            return;
        }
    };
    let dir = home.join(".minder").join("logs");
    let _ = std::fs::create_dir_all(&dir);
    open_with_os(&dir.to_string_lossy());
}
