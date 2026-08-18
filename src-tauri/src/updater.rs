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

use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_updater::UpdaterExt;

use crate::service_handoff::ServiceHandoff;
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
pub fn spawn_check<R: Runtime>(
    app: AppHandle<R>,
    supervisor: Arc<Supervisor>,
    port: u16,
    install: bool,
) {
    if !try_claim() {
        crate::supervisor::log("update: a check is already running — ignoring this request");
        return;
    }

    tauri::async_runtime::spawn(async move {
        match run_check(&app, supervisor, port, install).await {
            Ok(Outcome::UpToDate) => {
                crate::supervisor::log("update: already on the latest version");
            }
            Ok(Outcome::Available(version)) => {
                crate::supervisor::log(&format!("update: version {version} is available"));
                notify_available(&app, &version);
            }
            Err(e) => {
                // A failed *periodic* check must never be fatal or intrusive:
                // the machine may be offline, behind a proxy, or the release may
                // simply not have a manifest yet. Log and try again next tick.
                crate::supervisor::log(&format!("update check failed: {e}"));
                // An install the user asked for is different — silence there
                // reads as "nothing happened", which is precisely wrong when the
                // reason is a service holding the files we came to replace.
                if install {
                    notify_failed(&app, &e);
                }
            }
        }
        release();
    });
}

async fn run_check<R: Runtime>(
    app: &AppHandle<R>,
    supervisor: Arc<Supervisor>,
    port: u16,
    install: bool,
) -> Result<Outcome, String> {
    // Cloned because the closure below must own one for the whole life of the
    // updater, while the post-install path needs one too.
    let exit_supervisor = supervisor.clone();

    // Resolved BEFORE anything is downloaded. A logon service registered
    // against this app's own bundle holds the very files the installer is about
    // to replace (see crate::service_handoff), and if we have no way to stop it
    // the install cannot succeed — so refuse now, at the cost of a message,
    // rather than after a ~100 MB download and a failed replacement.
    //
    // `Arc` because it is needed in two places that cannot share a borrow: the
    // Windows-only `on_before_exit` hook below, and the post-install path that
    // only macOS and Linux ever reach. See both call sites for why neither can
    // be dropped in favour of the other.
    let handoff = if install {
        ServiceHandoff::resolve(
            app.path().home_dir().ok().as_deref(),
            app.path().resource_dir().ok().as_deref(),
            port,
        )?
        .map(Arc::new)
    } else {
        None
    };
    let exit_handoff = handoff.clone();

    let updater = app
        .updater_builder()
        .on_before_exit(move || {
            // See this module's header: on Windows we are moments from a hard
            // std::process::exit(), and this is the only chance to stop the
            // sidecar before it orphans and locks node.exe. shutdown() blocks
            // (bounded), which is exactly what we want here.
            crate::supervisor::log("update: stopping sidecar before installer hand-off");
            exit_supervisor.shutdown();
            // Our own child first, the borrowed one second — and the ordering is
            // load-bearing, not tidiness. In spawn mode the sidecar we just
            // stopped is itself listening on the installed service's port with a
            // command line matching the service's recorded identity, so running
            // the stop helper first would find OUR child, kill it with
            // `taskkill /F`, skip its disposers and forfeit the clean-shutdown
            // marker that keeps the next boot from re-scanning the whole index.
            // Graceful stop must win the race; by the time the helper looks, the
            // only thing that can still hold the port is the service.
            //
            // This hook is WINDOWS-ONLY, despite the platform-neutral name: the
            // plugin invokes it from exactly one place, inside its `cfg(windows)`
            // `install_inner` (tauri-plugin-updater 2.10.1, updater.rs:837), and
            // the macOS and Linux implementations never call it at all. That is
            // why the same stop is repeated on the post-install path below —
            // which is the one those platforms reach.
            if let Some(handoff) = &exit_handoff {
                let _ = handoff.stop();
            }
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

    // Stop the service HERE, before a byte is downloaded, so its failure can
    // still abort the update. The hooks below cannot: on Windows `on_before_exit`
    // fires after the download with no way to refuse the install, and on POSIX
    // the files are already replaced by the time control returns. A stop that
    // only logs its failure reproduces exactly the silent stale-payload outcome
    // this change exists to remove.
    //
    // Whether to run it is `should_stop_before_download`'s call, not attach
    // mode's: a service installed on its own port runs entirely independently of
    // whether the tray attached, and can hold our files while we are happily
    // spawning on a different port. The one case that must be skipped is the
    // narrow one where our own sidecar is the only thing the helper could find.
    let stopped_before_download = match &handoff {
        Some(handoff) if handoff.should_stop_before_download(supervisor.is_attached()) => {
            handoff.stop()?;
            true
        }
        _ => false,
    };

    if let Err(e) = update
        .download_and_install(|_chunk, _total| {}, || {})
        .await
        .map_err(|e| e.to_string())
    {
        // Nothing was installed, so a service we stopped on the way in is down
        // for an update that never happened — and being logon-triggered, it
        // would stay down until the next logon. Put it back. There is no port
        // race here: this path does not relaunch the app, so the tray simply
        // resumes observing.
        if stopped_before_download {
            if let Some(handoff) = &handoff {
                handoff.start();
            }
        }
        return Err(e);
    }

    // Windows never reaches this line — the plugin force-exited us above, and
    // the installer relaunches the app itself. macOS and Linux DO reach it: the
    // bundle has been swapped underneath us but this process is still the old
    // build, still supervising a sidecar. Stop the child first so the restarted
    // instance doesn't collide with an orphan holding the port.
    supervisor.shutdown();
    // The POSIX counterpart of the hook above, which never fires here. It also
    // matters *more* on these platforms: the file replacement has already
    // succeeded, so a logon service left running keeps serving the payload it
    // loaded into memory before the swap — an update that reports success and
    // changes nothing, which is harder to notice than Windows' loud failure on
    // a locked file. Ordering is the same and for the same reason: our own
    // sidecar stops gracefully first, so the helper cannot mistake it for the
    // service and hard-kill it.
    if let Some(handoff) = &handoff {
        let _ = handoff.stop();
    }
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

/// Toast that an explicitly-requested install did not happen, and why.
///
/// Only the tray-menu path reaches this. The periodic check stays silent on
/// failure by design (see [`spawn_check`]) — but a user who clicked "Check for
/// updates…" and got nothing has no way to tell "already up to date" from
/// "refused because a service is holding the files", and those call for
/// opposite responses.
fn notify_failed<R: Runtime>(app: &AppHandle<R>, reason: &str) {
    if let Err(e) = app
        .notification()
        .builder()
        .title("Project Minder update did not complete")
        .body(reason)
        .show()
    {
        crate::supervisor::log(&format!("could not show update-failure notification: {e}"));
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
