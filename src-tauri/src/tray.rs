//! Tray icon, menu, and the health-poll loop that keeps the menu current.

use std::path::PathBuf;
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use tauri::{
    image::Image,
    menu::{
        CheckMenuItem, CheckMenuItemBuilder, MenuBuilder, MenuItem, MenuItemBuilder,
        PredefinedMenuItem,
    },
    tray::TrayIconBuilder,
    App, Manager, Runtime,
};
use tauri_plugin_autostart::ManagerExt as _;
use tauri_plugin_opener::OpenerExt;

use crate::config::TrayConfig;
use crate::health::{self, ServerStatus};
use crate::notify::{self, NotifyController};
use crate::supervisor::Supervisor;

/// How often to re-probe `/api/health` and refresh the tray.
const POLL_INTERVAL: Duration = Duration::from_secs(15);

/// Build the tray icon + menu and start the background health poll. Called from
/// the Tauri `setup` hook.
pub fn init<R: Runtime>(
    app: &App<R>,
    cfg: &TrayConfig,
    supervisor: Arc<Supervisor>,
    state_dir: Option<PathBuf>,
) -> tauri::Result<()> {
    let attached = supervisor.is_attached();

    // Manual-steps notification poller (C3) — loads any persisted cursor/mute
    // flag up front so the "Mute notifications" checkbox below starts correct.
    let notify_controller = NotifyController::new(state_dir.as_deref());

    // Initial checked state comes straight from the OS registration (the
    // plugin is the source of truth — Minder doesn't persist this itself).
    // Never fails the whole tray setup on a read error: default to unchecked
    // and log, matching this file's log-and-continue error handling elsewhere.
    let autostart_enabled = app.autolaunch().is_enabled().unwrap_or_else(|e| {
        crate::supervisor::log(&format!("could not read autostart status: {e}"));
        false
    });

    let open_item = MenuItemBuilder::with_id("open_dashboard", "Open Dashboard").build(app)?;
    let status_item = MenuItemBuilder::with_id("status", "Status: starting…")
        .enabled(false)
        .build(app)?;
    let autostart_item = CheckMenuItemBuilder::with_id("autostart", "Start at login")
        .checked(autostart_enabled)
        .build(app)?;
    let mute_item = CheckMenuItemBuilder::with_id("mute_notifications", "Mute notifications")
        .checked(notify_controller.is_muted())
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
            &autostart_item,
            &mute_item,
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
    let menu_autostart_item = autostart_item.clone();
    let menu_mute_item = mute_item.clone();
    let menu_notify_controller = notify_controller.clone();
    let tray = TrayIconBuilder::with_id("minder-tray")
        .icon(tray_icon())
        .tooltip("Project Minder")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(move |app, event| {
            handle_menu_event(
                app,
                event.id().as_ref(),
                &menu_sup,
                &menu_url,
                &menu_autostart_item,
                &menu_mute_item,
                &menu_notify_controller,
            );
        })
        .build(app)?;

    // Health-poll loop: refresh the Status line + tray tooltip every 15s.
    spawn_poll_loop(cfg.port, supervisor.clone(), status_item, tray);

    // Manual-steps notification poll loop (C3): ~30s poll against the
    // watcher's change feed, toasting anything new unless muted.
    notify::spawn_poll_loop(app.handle().clone(), cfg.dashboard_url(), notify_controller);

    Ok(())
}

fn handle_menu_event<R: Runtime>(
    app: &tauri::AppHandle<R>,
    id: &str,
    supervisor: &Arc<Supervisor>,
    dashboard_url: &str,
    autostart_item: &CheckMenuItem<R>,
    mute_item: &CheckMenuItem<R>,
    notify_controller: &Arc<NotifyController>,
) {
    match id {
        "open_dashboard" => open_url(app, dashboard_url),
        "autostart" => sync_autostart(app, autostart_item),
        "mute_notifications" => notify::sync_mute(mute_item, notify_controller),
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

/// Sync the OS "launch at login" registration to the checkbox's new state.
///
/// Tauri toggles a `CheckMenuItem`'s internal checked state before firing the
/// click event, so `is_checked()` here already reflects what the user clicked
/// *to* — this function's job is just to make the OS registration (the
/// plugin handles persistence) match that, and to leave the checkbox
/// reflecting reality if it can't.
fn sync_autostart<R: Runtime>(app: &tauri::AppHandle<R>, item: &CheckMenuItem<R>) {
    let manager = app.autolaunch();

    let want_enabled = match item.is_checked() {
        Ok(checked) => checked,
        Err(e) => {
            // We don't know which direction the user clicked, so there's
            // nothing to sync — but Tauri already flipped the checkbox before
            // this event fired, and it may now disagree with the OS
            // registration (the actual source of truth). Re-anchor it to a
            // fresh read instead of leaving an arbitrary post-toggle value on
            // screen.
            crate::supervisor::log(&format!("could not read autostart checkbox state: {e}"));
            match recovered_checked_state(manager.is_enabled()) {
                Some(actual) => {
                    let _ = item.set_checked(actual);
                }
                None => {
                    crate::supervisor::log(
                        "could not re-read autostart status either — leaving checkbox as-is",
                    );
                }
            }
            return;
        }
    };

    let sync_result = if want_enabled {
        manager.enable()
    } else {
        manager.disable()
    };
    let sync_ok = sync_result.is_ok();

    if let Err(e) = sync_result {
        crate::supervisor::log(&format!(
            "failed to {} autostart: {e}",
            if want_enabled { "enable" } else { "disable" }
        ));
    }

    // Revert failure: OS-side "reality" is not what the checkbox implies. Never
    // panic on a plugin error — just leave the check state honest.
    if let Some(revert_to) = revert_target(want_enabled, sync_ok) {
        let _ = item.set_checked(revert_to);
    }
}

/// Pure decision helper for [`sync_autostart`]: given the state the user just
/// clicked *to* and whether syncing that to the OS succeeded, returns
/// `Some(state)` the checkbox should be forced back to (when the sync
/// failed), or `None` if the checkbox already matches reality.
fn revert_target(want_enabled: bool, sync_ok: bool) -> Option<bool> {
    if sync_ok {
        None
    } else {
        Some(!want_enabled)
    }
}

/// Pure decision helper for [`sync_autostart`]'s `is_checked()`-failure path:
/// given a fresh, direct read of the OS "launch at login" registration (the
/// source of truth), returns the state to force the checkbox to. `None` means
/// the re-read itself failed too, in which case the checkbox is left exactly
/// as Tauri last set it rather than guessed at.
fn recovered_checked_state<E>(fresh_read: Result<bool, E>) -> Option<bool> {
    fresh_read.ok()
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

/// Open a URL in the user's default browser via the opener plugin — never
/// routes the target through a shell/command parser (so a `&` or other
/// metacharacter in the value can't break or inject). No webview is embedded
/// (v1 uses the real browser, per the plan).
fn open_url<R: Runtime>(app: &tauri::AppHandle<R>, url: &str) {
    if let Err(e) = app.opener().open_url(url, None::<&str>) {
        crate::supervisor::log(&format!("failed to open URL {url}: {e}"));
    }
}

/// Open `~/.minder/logs/` in the OS file manager (creating it if absent so the
/// file manager doesn't error on a missing path). Home is resolved via Tauri's
/// path API and the path is opened via the opener plugin — no shell parsing.
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
    if let Err(e) = app.opener().open_path(dir.to_string_lossy(), None::<&str>) {
        crate::supervisor::log(&format!("failed to open logs dir {}: {e}", dir.display()));
    }
}

#[cfg(test)]
mod tests {
    use super::{recovered_checked_state, revert_target};

    #[test]
    fn revert_target_no_op_when_sync_succeeds() {
        assert_eq!(revert_target(true, true), None);
        assert_eq!(revert_target(false, true), None);
    }

    #[test]
    fn revert_target_flips_back_when_sync_fails() {
        assert_eq!(revert_target(true, false), Some(false));
        assert_eq!(revert_target(false, false), Some(true));
    }

    #[test]
    fn recovered_checked_state_forwards_a_successful_fresh_read() {
        assert_eq!(recovered_checked_state::<()>(Ok(true)), Some(true));
        assert_eq!(recovered_checked_state::<()>(Ok(false)), Some(false));
    }

    #[test]
    fn recovered_checked_state_is_none_when_the_fresh_read_also_fails() {
        assert_eq!(recovered_checked_state::<()>(Err(())), None);
    }
}
