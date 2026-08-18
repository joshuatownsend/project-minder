//! Releasing a registered logon service's hold on the files an update replaces.
//!
//! ## The interaction this exists for (PR #457, Codex P2)
//!
//! Two independently-correct behaviors combine into a broken update:
//!
//!   * `scripts/service.mjs install --payload <dir>` can register the Phase A
//!     logon service against **the tray app's own bundle**. That is the
//!     recommended arrangement when both are installed — it makes the service
//!     and the app the same server, so which one wins the boot race stops
//!     mattering.
//!   * When that service owns the port, the tray comes up in **attach** mode,
//!     where [`crate::supervisor::observe_until_shutdown`] deliberately never
//!     touches the running server — including at quit.
//!
//! So at update time the service is still running the app's own
//! `resources/minder-server/server.js` under the app's own
//! `resources/node/node.exe`. On Windows the NSIS installer cannot overwrite a
//! file a live process holds open, and the update fails. On macOS/Linux the
//! replacement *succeeds* and the service keeps serving the **old payload it
//! already has in memory** — which presents as an update that reported success
//! and changed nothing, the worse of the two failures.
//!
//! `crate::updater` stops the tray's own sidecar in `on_before_exit`; this
//! module is the same hand-off for a server the tray does **not** own.
//!
//! ## Why it delegates to the bundled service CLI
//!
//! Windows has no signal to send. `schtasks /End` is useless here: Task
//! Scheduler only ever tracked the `wscript.exe` launcher, which exits the
//! instant it fires `WshShell.Run`, so by update time there is nothing left for
//! it to end. Stopping the server means finding whoever is LISTENING on the
//! installed port, proving that process is *this* installation's server, and
//! only then killing it — the identity check that keeps us from taking down an
//! unrelated `pnpm dev` sharing the port.
//!
//! That machinery already exists, in `scripts/service/lib.mjs`, carrying three
//! rounds of review fixes (path-like args only, boundary-delimited matching,
//! `next dev` explicitly excluded). Re-deriving it in Rust would re-earn every
//! one of those bugs in a code path that runs once per update and is the
//! hardest in the app to test. So the app bundles `scripts/service.mjs` and
//! shells it with the Node it already ships, and macOS/Linux get their
//! label-scoped `launchctl`/`systemctl` stop from the same call for free.
//!
//! ## What it deliberately does not do
//!
//! **It never restarts the service.** The registration is logon-triggered on
//! every platform, so it returns by itself at next logon; until then the port
//! is free and the updated tray simply spawns its own sidecar. Starting it back
//! up here would instead race the relaunching tray for the port. One less
//! moving part, on the path least able to be tested.
//!
//! The consequence worth knowing: the stop is a hard kill (that is what
//! `service.mjs stop` does on Windows, by necessity), so it writes no
//! clean-shutdown marker and the first boot after an update pays a full
//! `PRAGMA quick_check`. Expected, self-healing, and documented in
//! `docs/help/service-mode.md`.

use std::path::{Path, PathBuf};
use std::process::{Child, Command as StdCommand, ExitStatus, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use crate::supervisor::log;

/// Ceiling on the whole stop. Generous because the Windows path shells
/// `netstat` and one PowerShell `Get-CimInstance` per candidate PID, and a cold
/// PowerShell start alone can take seconds. Exceeding it kills the helper
/// rather than hanging an update forever.
const STOP_TIMEOUT: Duration = Duration::from_secs(45);

/// How long to keep checking whether the port actually came free after a stop
/// that reported success. Verification only — nothing is retried.
const RELEASE_GRACE: Duration = Duration::from_secs(5);

/// Windows `CREATE_NO_WINDOW`. Same reason as in `supervisor`: the tray has no
/// console, so a default-flagged child flashes one. (0x08000000.)
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// A registered logon service that is holding files this update will replace,
/// together with everything needed to stop it.
#[derive(Debug)]
pub struct ServiceHandoff {
    /// The Node the app ships — never one from `PATH`, which may not exist.
    node: PathBuf,
    /// Bundled `scripts/service.mjs`.
    cli: PathBuf,
    /// Where the CLI runs, so its own relative lookups resolve inside the app.
    cwd: PathBuf,
    /// Port to verify actually came free. Only ever logged.
    port: u16,
    /// The registration file that referenced our bundle — logged so the reason
    /// we are touching a service at all is in the record.
    evidence: PathBuf,
}

/// Registration files that could name our payload, newest mechanism first.
/// Windows records the resolved launch in a JSON sidecar, with the generated
/// VBS as the fallback for installs predating it; macOS and Linux keep the
/// command in the plist/unit itself.
#[cfg(windows)]
fn registration_files(home: &Path) -> Vec<PathBuf> {
    let dir = home.join(".minder").join("service");
    vec![
        dir.join("service-manifest.json"),
        dir.join("run-hidden.vbs"),
    ]
}

#[cfg(target_os = "macos")]
fn registration_files(home: &Path) -> Vec<PathBuf> {
    vec![home
        .join("Library")
        .join("LaunchAgents")
        .join("com.minder.dashboard.plist")]
}

#[cfg(all(unix, not(target_os = "macos")))]
fn registration_files(home: &Path) -> Vec<PathBuf> {
    vec![home
        .join(".config")
        .join("systemd")
        .join("user")
        .join("minder.service")]
}

/// Collapse every path in `text` to one comparable form: forward slashes, no
/// repeats, lowercase.
///
/// It runs over whole files, not over parsed paths, because the three
/// registration formats quote paths three different ways — JSON doubles the
/// backslashes (`C:\\Users\\…`), VBScript doubles the quotes around them, XML
/// escapes the entities — and normalizing separators in *runs* renders all
/// three identically without a parser for any of them.
///
/// Lowercasing is correct on Windows and over-eager on POSIX, where two paths
/// differing only in case are genuinely different files. The cost of that
/// false positive is stopping a Minder service we did not strictly have to;
/// the cost of the false negative it prevents — on the case-insensitive
/// platform where the whole locked-file problem lives — is a failed update.
pub fn normalize_path_text(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut last_was_sep = false;
    for ch in text.chars() {
        if ch == '\\' || ch == '/' {
            if !last_was_sep {
                out.push('/');
                last_was_sep = true;
            }
        } else {
            last_was_sep = false;
            out.extend(ch.to_lowercase());
        }
    }
    out
}

/// True if `registration` names something inside `dir`.
///
/// The match is boundary-delimited (mirroring `commandLineMatchesServer` in
/// `scripts/service/lib.mjs`): a bare substring test would let a bundle at
/// `…/project minder tray` match a registration pointing at `…/project minder
/// tray 2`, and stopping a service on behalf of a *different* installation is
/// exactly the class of mistake the identity machinery exists to prevent.
pub fn registration_references(registration: &str, dir: &str) -> bool {
    let haystack = normalize_path_text(registration);
    let needle = normalize_path_text(dir);
    let needle = needle.trim_end_matches('/');
    if needle.is_empty() {
        return false;
    }
    let mut from = 0;
    while let Some(hit) = haystack[from..].find(needle) {
        let at = from + hit;
        // Anything inside the directory continues with a separator. A bare
        // reference to the directory itself is not a file we can lock, and a
        // longer name that merely starts with it is a different directory.
        if haystack[at + needle.len()..].starts_with('/') {
            return true;
        }
        from = at + 1;
    }
    false
}

/// Whether a registered logon service points into `resource_dir`, and if so
/// which registration file said so.
fn registration_naming(home: &Path, resource_dir: &Path) -> Option<PathBuf> {
    let dir = resource_dir.to_string_lossy().to_string();
    registration_files(home).into_iter().find(|path| {
        std::fs::read_to_string(path)
            .map(|text| registration_references(&text, &dir))
            .unwrap_or(false)
    })
}

impl ServiceHandoff {
    /// Decide whether this update needs a service stopped, and prove up front
    /// that we could perform one.
    ///
    /// * `Ok(None)` — no logon service is registered, or it runs a payload that
    ///   is not ours. Nothing to do; the update proceeds untouched.
    /// * `Ok(Some(_))` — a service holds our files and we can stop it.
    /// * `Err(_)` — a service holds our files and we **cannot**. The caller must
    ///   abort before downloading, because the install would fail on a locked
    ///   file (Windows) or silently keep serving the old payload (elsewhere).
    ///   Failing here costs the user a message; failing later costs an update.
    pub fn resolve(
        home: Option<&Path>,
        resource_dir: Option<&Path>,
        port: u16,
    ) -> Result<Option<ServiceHandoff>, String> {
        let (Some(home), Some(resource_dir)) = (home, resource_dir) else {
            // A dev build with no resource dir has no bundle to lock.
            return Ok(None);
        };
        let Some(evidence) = registration_naming(home, resource_dir) else {
            return Ok(None);
        };

        let cli = resource_dir.join("scripts").join("service.mjs");
        let node = bundled_node(resource_dir);
        match (cli.is_file(), node.filter(|n| n.is_file())) {
            (true, Some(node)) => Ok(Some(ServiceHandoff {
                node,
                cli,
                cwd: resource_dir.to_path_buf(),
                port,
                evidence,
            })),
            _ => Err(format!(
                "the logon service registered in {} runs this app's own bundle, so it must be \
                 stopped before the update can replace those files — but this build does not \
                 ship the helper needed to stop it. Stop it yourself with `pnpm service:stop` \
                 (or quit the service) and try the update again.",
                evidence.display()
            )),
        }
    }

    /// Stop the service. Best-effort by construction, and reports only to the
    /// log: on Windows it runs moments before a hard `std::process::exit()`
    /// inside the plugin's `on_before_exit`, so there is nobody left to raise an
    /// error to; on macOS and Linux it runs after the files have already been
    /// replaced, so there is nothing left to abort. Everything that can be
    /// refused is refused earlier, in [`ServiceHandoff::resolve`].
    pub fn stop(&self) {
        log(&format!(
            "update: {} registers the logon service against this app's own bundle — stopping it \
             so the installer can replace those files",
            self.evidence.display()
        ));

        let mut cmd = StdCommand::new(&self.node);
        cmd.arg(&self.cli)
            .arg("stop")
            .current_dir(&self.cwd)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }

        let mut child = match cmd.spawn() {
            Ok(child) => child,
            Err(e) => {
                log(&format!("update: could not run the service stop helper: {e}"));
                return;
            }
        };
        match wait_with_timeout(&mut child, STOP_TIMEOUT) {
            Some(status) if status.success() => log("update: service stop helper finished"),
            Some(status) => log(&format!(
                "update: service stop helper exited with {status} — the installer may still find \
                 the payload locked"
            )),
            None => {
                let _ = child.kill();
                log(&format!(
                    "update: service stop helper did not finish within {STOP_TIMEOUT:?} — killed \
                     it and carrying on"
                ));
            }
        }

        // The helper exits 0 when it finds a listener whose identity it cannot
        // confirm — it refuses to kill strangers, which is right, but it means
        // a clean exit is not proof the port came free. Ask the port itself.
        if port_released(self.port, RELEASE_GRACE) {
            log(&format!("update: port {} released", self.port));
        } else {
            log(&format!(
                "update: port {} is STILL bound after the service stop — whatever holds it was \
                 not recognized as this installation's server, so the update may fail on a \
                 locked file",
                self.port
            ));
        }
    }
}

/// The Node the C4 packaging workflow lays down beside the payload. Mirrors the
/// candidate list in `config::bundled_node_candidates` — deliberately not
/// falling back to `PATH`, because a Node that is not ours may not exist and a
/// failed spawn is more useful than a mystery.
fn bundled_node(resource_dir: &Path) -> Option<PathBuf> {
    let base = resource_dir.join("node");
    [
        base.join("node.exe"),
        base.join("bin").join("node"),
        base.join("node"),
    ]
    .into_iter()
    .find(|p| p.is_file())
}

/// Poll until nothing is listening on `port`, or `grace` elapses.
fn port_released(port: u16, grace: Duration) -> bool {
    let deadline = Instant::now() + grace;
    loop {
        if !crate::health::port_is_bound(port) {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        thread::sleep(Duration::from_millis(250));
    }
}

/// `Child::wait` with a ceiling — `std` has no timed wait, and an unbounded one
/// here would hang the update behind a wedged helper.
fn wait_with_timeout(child: &mut Child, timeout: Duration) -> Option<ExitStatus> {
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Some(status),
            Ok(None) => {}
            Err(_) => return None,
        }
        if Instant::now() >= deadline {
            return None;
        }
        thread::sleep(Duration::from_millis(100));
    }
}

#[cfg(test)]
mod tests {
    use super::{normalize_path_text, registration_references, ServiceHandoff};
    use std::path::Path;

    #[test]
    fn normalizes_separators_case_and_repeats() {
        assert_eq!(
            normalize_path_text(r"C:\Users\Joshu\AppData"),
            "c:/users/joshu/appdata"
        );
        assert_eq!(normalize_path_text("/Users//Joshu"), "/users/joshu");
    }

    /// The JSON manifest stores `C:\\Users\\…`; collapsing separator *runs* is
    /// what lets one comparison serve JSON, VBScript and plists alike without
    /// parsing any of them.
    #[test]
    fn a_json_escaped_windows_path_matches_the_plain_one() {
        let manifest = r#"{"mode":"standalone","exe":"C:\\App\\node\\node.exe",
            "args":["C:\\App\\minder-server\\server.js"],"port":4100}"#;
        assert!(registration_references(manifest, r"C:\App"));
    }

    #[test]
    fn a_plist_path_matches() {
        let plist = "<key>ProgramArguments</key><array>\
            <string>/Applications/Minder.app/Contents/Resources/node/bin/node</string>\
            <string>/Applications/Minder.app/Contents/Resources/minder-server/server.js</string>\
            </array>";
        assert!(registration_references(
            plist,
            "/Applications/Minder.app/Contents/Resources"
        ));
    }

    /// The whole point of the gate: a service running some *other* payload is
    /// not holding our files and must be left alone.
    #[test]
    fn a_service_pointed_at_another_payload_is_not_ours() {
        let manifest = r#"{"args":["C:\\dev\\project-minder\\dist\\minder-server\\server.js"]}"#;
        assert!(!registration_references(
            manifest,
            r"C:\Users\joshu\AppData\Local\Project Minder Tray"
        ));
    }

    /// Boundary rule: a sibling install whose name merely starts with ours must
    /// not match. Stopping a service on another installation's behalf is the
    /// same class of error as killing an unrelated `pnpm dev`.
    #[test]
    fn a_longer_sibling_directory_does_not_match() {
        let manifest = r#"{"args":["C:\\Apps\\Minder Tray 2\\minder-server\\server.js"]}"#;
        assert!(!registration_references(manifest, r"C:\Apps\Minder Tray"));
        // …while the real thing still does.
        let ours = r#"{"args":["C:\\Apps\\Minder Tray\\minder-server\\server.js"]}"#;
        assert!(registration_references(ours, r"C:\Apps\Minder Tray"));
    }

    /// An earlier occurrence that fails the boundary test must not shadow a
    /// later one that passes — same rule as `hasBoundaryMatch` in lib.mjs.
    #[test]
    fn an_earlier_non_match_does_not_hide_a_later_match() {
        let text = r#"{"note":"C:\\Apps\\Minder Tray 2","args":["C:\\Apps\\Minder Tray\\x.js"]}"#;
        assert!(registration_references(text, r"C:\Apps\Minder Tray"));
    }

    /// A reference to the directory with nothing under it names no file we
    /// could be holding open.
    #[test]
    fn the_bare_directory_alone_is_not_a_reference_to_a_file_in_it() {
        assert!(!registration_references(
            r#"{"cwd":"C:\\Apps\\Minder Tray"}"#,
            r"C:\Apps\Minder Tray"
        ));
    }

    #[test]
    fn an_empty_directory_never_matches_anything() {
        assert!(!registration_references("anything at all", ""));
        assert!(!registration_references("anything at all", "/"));
    }

    /// A dev build has no bundle for a service to lock, so there is nothing to
    /// gate on and nothing to stop.
    #[test]
    fn without_a_resource_dir_there_is_no_hand_off() {
        assert!(ServiceHandoff::resolve(Some(Path::new("/home/x")), None, 4100)
            .expect("must not error")
            .is_none());
        assert!(ServiceHandoff::resolve(None, Some(Path::new("/app")), 4100)
            .expect("must not error")
            .is_none());
    }

    /// No registration file → no service → the update proceeds untouched. Uses
    /// a directory that cannot contain one rather than mocking the filesystem.
    #[test]
    fn no_registration_means_nothing_to_stop() {
        let empty = std::env::temp_dir().join("minder-handoff-no-such-home");
        assert!(
            ServiceHandoff::resolve(Some(&empty), Some(Path::new("/app")), 4100)
                .expect("must not error")
                .is_none()
        );
    }

    /// Where this platform's installer records the launch. Kept beside the test
    /// that uses it so a change to [`super::registration_files`] that the pure
    /// matcher can't see still breaks something.
    fn registration_under(home: &Path) -> std::path::PathBuf {
        #[cfg(windows)]
        return home
            .join(".minder")
            .join("service")
            .join("service-manifest.json");
        #[cfg(target_os = "macos")]
        return home
            .join("Library")
            .join("LaunchAgents")
            .join("com.minder.dashboard.plist");
        #[cfg(all(unix, not(target_os = "macos")))]
        return home
            .join(".config")
            .join("systemd")
            .join("user")
            .join("minder.service");
    }

    /// End-to-end over the real filesystem: a registration that names our
    /// bundle is found at the path this platform actually uses, and — because
    /// the fake bundle ships neither the helper nor a Node to run it — resolve
    /// **refuses the update** instead of proceeding into an install that would
    /// fail on a locked file. The unit tests above cover the matcher; this
    /// covers the wiring around it, which is where a wrong directory name would
    /// hide silently as "no service registered".
    #[test]
    fn a_registration_naming_our_bundle_without_a_usable_helper_refuses_the_update() {
        let base = std::env::temp_dir().join("minder-handoff-gate-test");
        let home = base.join("home");
        let resources = base.join("Project Minder Tray");
        let registration = registration_under(&home);
        std::fs::create_dir_all(registration.parent().expect("has a parent"))
            .expect("create registration dir");
        std::fs::create_dir_all(&resources).expect("create resource dir");
        // Shaped like the real thing on every platform: whatever the format, it
        // is a file naming an entry point inside our bundle.
        let payload = resources.join("minder-server").join("server.js");
        std::fs::write(
            &registration,
            format!("{{\"args\":[{:?}]}}", payload.to_string_lossy()),
        )
        .expect("write registration");

        let err = ServiceHandoff::resolve(Some(&home), Some(&resources), 4100)
            .expect_err("a service holding our bundle with no way to stop it must refuse");
        assert!(
            err.contains("logon service"),
            "the message must say why the update was refused, got: {err}"
        );

        let _ = std::fs::remove_dir_all(&base);
    }
}
