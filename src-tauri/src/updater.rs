//! Auto-updater: periodic check, tray-driven install, and the sidecar-shutdown
//! hand-off that makes a Windows install possible at all (plan task U3/U4).
//!
//! ## Why the `on_before_exit` hook is load-bearing, not cleanup
//!
//! On Windows the NSIS installer cannot overwrite files belonging to a running
//! process, so `download_and_install` quits the app for us. It does that by
//! calling `std::process::exit()` directly — which means:
//!
//!   * it does NOT travel through `RunEvent::ExitRequested`, so `main.rs`'s
//!     `prevent_exit` guard (which keeps this windowless app alive) can neither
//!     see nor swallow it; and
//!   * no destructor, no `Drop`, and no normal shutdown path runs.
//!
//! The second point is the dangerous one. Our Node sidecar is a *child process*,
//! not a resource freed by unwinding: if nothing stops it before that exit, it
//! survives as an orphan holding an open handle on `resources/node/node.exe`,
//! and the installer fails on a locked file. `on_before_exit` is the only hook
//! that runs in that window, so it is where `supervisor.shutdown()` must go.
//!
//! On macOS and Linux the process is not force-exited and control returns to us
//! after the install, so we stop the sidecar and restart explicitly instead.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use tauri::{AppHandle, Runtime};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_updater::UpdaterExt;

use crate::supervisor::Supervisor;

/// Health-loop ticks between automatic update checks.
///
/// The plan calls for reusing the existing 15s health loop rather than adding a
/// second timer, so this is expressed in ticks: 1440 × 15s ≈ 6 hours.
pub const CHECK_EVERY_TICKS: u64 = 1440;

/// Guards against overlapping checks — a user clicking "Check for updates…"
/// while the periodic check happens to be mid-download would otherwise start a
/// second download of the same ~100 MB payload.
static CHECK_IN_FLIGHT: AtomicBool = AtomicBool::new(false);

/// What a completed check found. Returned rather than acted on directly so the
/// decision of *how to report it* stays with the caller.
///
/// There is deliberately no `Installed` variant: a *successful* install never
/// returns on any platform. Windows is force-exited from inside
/// `download_and_install`, and elsewhere we hand off to `app.restart()`, which
/// diverges. Only a failed install produces a value here (as `Err`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    UpToDate,
    /// An update exists and we only looked (the periodic path).
    Available(String),
}

/// Whether a given health-loop tick should trigger an automatic check.
///
/// Tick 0 is deliberately excluded: the app has just launched, the sidecar is
/// still booting, and firing a network check into that is both noisy and the
/// least likely moment for the user to want a restart prompt.
pub fn is_check_tick(tick: u64, every: u64) -> bool {
    every > 0 && tick > 0 && tick % every == 0
}

/// Claim the in-flight slot, or report that a check is already running.
/// Split out from [`spawn_check`] so the mutual-exclusion rule is testable
/// without spawning a runtime or touching the network.
fn try_claim() -> bool {
    CHECK_IN_FLIGHT
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_ok()
}

fn release() {
    CHECK_IN_FLIGHT.store(false, Ordering::SeqCst);
}

/// Kick off an update check on Tauri's async runtime.
///
/// `install: false` only looks and reports (the periodic path); `install: true`
/// downloads and installs (the tray menu path). Tauri bundles its own async
/// runtime, so the plugin's async API needs no extra dependency and no runtime
/// of our own.
pub fn spawn_check<R: Runtime>(app: AppHandle<R>, supervisor: Arc<Supervisor>, install: bool) {
    if !try_claim() {
        crate::supervisor::log("update: a check is already running — ignoring this request");
        return;
    }

    tauri::async_runtime::spawn(async move {
        match run_check(&app, supervisor, install).await {
            Ok(Outcome::UpToDate) => {
                crate::supervisor::log("update: already on the latest version");
            }
            Ok(Outcome::Available(version)) => {
                crate::supervisor::log(&format!("update: version {version} is available"));
                notify_available(&app, &version);
            }
            Err(e) => {
                // A failed check must never be fatal or intrusive: the machine
                // may be offline, behind a proxy, or the release may simply not
                // have a manifest yet. Log and try again on the next tick.
                crate::supervisor::log(&format!("update check failed: {e}"));
            }
        }
        release();
    });
}

async fn run_check<R: Runtime>(
    app: &AppHandle<R>,
    supervisor: Arc<Supervisor>,
    install: bool,
) -> Result<Outcome, String> {
    // Cloned because the closure below must own one for the whole life of the
    // updater, while the post-install path needs one too.
    let exit_supervisor = supervisor.clone();

    let updater = app
        .updater_builder()
        .on_before_exit(move || {
            // See this module's header: on Windows we are moments from a hard
            // std::process::exit(), and this is the only chance to stop the
            // sidecar before it orphans and locks node.exe. shutdown() blocks
            // (bounded), which is exactly what we want here.
            crate::supervisor::log("update: stopping sidecar before installer hand-off");
            exit_supervisor.shutdown();
        })
        .build()
        .map_err(|e| e.to_string())?;

    let Some(update) = updater.check().await.map_err(|e| e.to_string())? else {
        return Ok(Outcome::UpToDate);
    };
    let version = update.version.clone();

    if !install {
        return Ok(Outcome::Available(version));
    }

    update
        .download_and_install(|_chunk, _total| {}, || {})
        .await
        .map_err(|e| e.to_string())?;

    // Windows never reaches this line — the plugin force-exited us above, and
    // the installer relaunches the app itself. macOS and Linux DO reach it: the
    // bundle has been swapped underneath us but this process is still the old
    // build, still supervising a sidecar. Stop the child first so the restarted
    // instance doesn't collide with an orphan holding the port.
    supervisor.shutdown();
    crate::supervisor::log("update: restarting into the new version");
    app.restart();
}

/// Toast that an update exists. Deliberately informational: the periodic check
/// never installs on its own, because this app supervises a dashboard server the
/// user is actively relying on — an unannounced restart would drop in-flight
/// scans and any dev servers it is managing. Installing stays an explicit
/// choice via the tray menu.
fn notify_available<R: Runtime>(app: &AppHandle<R>, version: &str) {
    if let Err(e) = app
        .notification()
        .builder()
        .title("Project Minder update available")
        .body(format!(
            "Version {version} is ready. Choose \"Check for updates…\" in the tray menu to install."
        ))
        .show()
    {
        crate::supervisor::log(&format!("could not show update notification: {e}"));
    }
}

#[cfg(test)]
mod tests {
    use super::{is_check_tick, release, try_claim, Outcome, CHECK_EVERY_TICKS};

    #[test]
    fn does_not_check_on_the_startup_tick() {
        assert!(!is_check_tick(0, 10));
    }

    #[test]
    fn checks_on_each_multiple_of_the_interval() {
        assert!(is_check_tick(10, 10));
        assert!(is_check_tick(20, 10));
        assert!(is_check_tick(1440, CHECK_EVERY_TICKS));
    }

    #[test]
    fn does_not_check_between_intervals() {
        assert!(!is_check_tick(9, 10));
        assert!(!is_check_tick(11, 10));
        assert!(!is_check_tick(1439, CHECK_EVERY_TICKS));
    }

    /// A zero interval would otherwise make `tick % every` panic on divide by
    /// zero — guard rather than trusting the constant to stay non-zero.
    #[test]
    fn a_zero_interval_never_checks_instead_of_dividing_by_zero() {
        assert!(!is_check_tick(10, 0));
    }

    #[test]
    fn the_default_interval_is_about_six_hours() {
        assert_eq!(CHECK_EVERY_TICKS * 15, 6 * 60 * 60);
    }

    /// The second claim must fail while the first is outstanding — this is what
    /// stops a menu click from starting a duplicate ~100 MB download.
    #[test]
    fn only_one_check_may_be_in_flight_at_a_time() {
        assert!(try_claim());
        assert!(!try_claim());
        release();
        assert!(try_claim());
        release();
    }

    #[test]
    fn outcomes_carry_their_version() {
        assert_eq!(
            Outcome::Available("1.5.0".into()),
            Outcome::Available("1.5.0".into())
        );
        assert_ne!(Outcome::UpToDate, Outcome::Available("1.5.0".into()));
    }
}
