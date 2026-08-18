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

/// Undo the escaping each registration format applies to the paths inside it,
/// so a path containing a character one of them serializes still matches.
///
/// `service.mjs` writes these paths through `escapeXml` (macOS plists: `&` `<`
/// `>` `"`) and `escapeSystemdPercent` (Linux units: `%` doubled). A resource
/// directory under a home like `/Users/R&D` therefore appears in the plist as
/// `R&amp;D` and never matches the unescaped `resource_dir` — a false negative
/// that skips the hand-off and leaves the old service running through the
/// update, which is the silent failure this whole module exists to prevent.
///
/// **`&amp;` is decoded last, and that ordering is a correctness requirement.**
/// `escapeXml` encodes `&` *first*, so `&lt;` in a real path was written as
/// `&amp;lt;`; decoding `&amp;` first would turn that back into `&lt;` and the
/// next pass would wrongly reduce it to `<`. Decoding in reverse order of
/// encoding is what makes the round trip exact.
///
/// Applied unconditionally rather than per-platform: a false positive would
/// need a directory literally named `x&amp;y` colliding with a bundle at `x&y`,
/// and the boundary check still has to pass afterwards.
fn decode_registration_escapes(text: &str) -> String {
    text.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        // Not emitted by our own escapeXml, but valid XML that a hand-edited or
        // differently-generated plist may carry.
        .replace("&apos;", "'")
        .replace("%%", "%")
        .replace("&amp;", "&")
}

/// True if `registration` names something inside `dir`.
///
/// The match is boundary-delimited (mirroring `commandLineMatchesServer` in
/// `scripts/service/lib.mjs`): a bare substring test would let a bundle at
/// `…/project minder tray` match a registration pointing at `…/project minder
/// tray 2`, and stopping a service on behalf of a *different* installation is
/// exactly the class of mistake the identity machinery exists to prevent.
///
/// Only the registration is un-escaped; `dir` comes from the OS and was never
/// serialized into anything.
pub fn registration_references(registration: &str, dir: &str) -> bool {
    let haystack = normalize_path_text(&decode_registration_escapes(registration));
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

    /// Run the bundled service CLI with one action and report how it ended.
    fn run_helper(&self, action: &str) -> StopExit {
        let mut cmd = StdCommand::new(&self.node);
        cmd.arg(&self.cli)
            .arg(action)
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
            Err(e) => return StopExit::Failed(format!("could not run the helper: {e}")),
        };
        match wait_with_timeout(&mut child, STOP_TIMEOUT) {
            Some(status) if status.success() => StopExit::Ok,
            Some(status) => StopExit::Failed(format!("it exited with {status}")),
            None => {
                let _ = child.kill();
                StopExit::TimedOut
            }
        }
    }

    /// Stop the service, reporting whether it actually stopped.
    ///
    /// The caller decides what a failure means, and the two callers differ: the
    /// pre-download call in `crate::updater` **aborts the update** on `Err`,
    /// because nothing has been downloaded or replaced yet and leaving the
    /// user on their working version is strictly better than installing over a
    /// live process. The two post-download calls can only log — on Windows the
    /// hook runs moments before a hard `std::process::exit()`, and on POSIX the
    /// files are already swapped — so they exist as belt-and-braces, not as the
    /// safety net.
    pub fn stop(&self) -> Result<(), String> {
        log(&format!(
            "update: {} registers the logon service against this app's own bundle — stopping it \
             so the installer can replace those files",
            self.evidence.display()
        ));

        // Decided BEFORE the stop, because afterwards the answer is gone. A
        // Minder answering here is the case where the service really is holding
        // our files, and the port coming free is then meaningful evidence that
        // it let go. If something else answers — or nothing does — the port is
        // not ours to reason about: a foreign server can legitimately hold it
        // while our registered service isn't running at all, and demanding the
        // port come free would abort an update that would have succeeded.
        let expect_release = crate::health::probe(self.port).is_minder();
        let exit = self.run_helper("stop");
        // Only worth asking, and only meaningful, when a Minder was answering
        // and the helper claims to have done its job.
        let port_still_bound = expect_release
            && exit == StopExit::Ok
            && !port_released(self.port, RELEASE_GRACE);

        let verdict = classify_stop(expect_release, exit, port_still_bound, self.port);
        match &verdict {
            Ok(()) => log("update: the logon service is stopped"),
            Err(why) => log(&format!("update: could not stop the logon service — {why}")),
        }
        verdict
    }

    /// Start the service again. Used on exactly one path: an update that
    /// stopped the service and then failed to download, where leaving it
    /// stopped would cost the user their dashboard until the next logon for an
    /// update that never happened.
    ///
    /// Deliberately **not** called after a successful install. There the app is
    /// about to relaunch and would race the service for the port; the
    /// registration is logon-triggered, so it returns on its own.
    pub fn start(&self) {
        match self.run_helper("start") {
            StopExit::Ok => log("update: restarted the logon service after a failed download"),
            other => log(&format!(
                "update: could not restart the logon service after a failed download ({other:?}) \
                 — it will return at the next logon"
            )),
        }
    }
}

/// How running the bundled service CLI ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StopExit {
    /// It ran to completion and reported success.
    Ok,
    /// It ran and reported failure.
    Failed(String),
    /// It never finished within [`STOP_TIMEOUT`] and was killed.
    TimedOut,
}

/// Decide whether the service is stopped, from the three facts a caller can
/// gather. Pure, because the alternative is untestable: the real path spawns a
/// process and probes a live port, and a rule that only exists inside that path
/// cannot be shown to hold. Mutating this function must break a test.
///
/// The asymmetry is the point. A helper failure is decisive — we asked it to
/// stop the service and it says it did not. But a *clean* exit is not proof:
/// the helper deliberately exits 0 when it finds a listener whose identity it
/// cannot confirm, because refusing to kill strangers is correct. So a clean
/// exit is corroborated by the port, and only when a Minder was answering there
/// to begin with. If something foreign held the port, or nothing did, the port
/// tells us nothing about our service and demanding it come free would abort an
/// update that would have succeeded.
pub fn classify_stop(
    expect_release: bool,
    exit: StopExit,
    port_still_bound: bool,
    port: u16,
) -> Result<(), String> {
    match exit {
        StopExit::Failed(why) => {
            return Err(format!(
                "the helper that stops the logon service failed ({why}), so the service may still \
                 be holding this app's files"
            ))
        }
        StopExit::TimedOut => {
            return Err(format!(
                "the helper that stops the logon service did not finish within {STOP_TIMEOUT:?}"
            ))
        }
        StopExit::Ok => {}
    }
    if expect_release && port_still_bound {
        return Err(format!(
            "port {port} is still served by Minder after stopping the logon service — whatever \
             holds it was not recognized as this installation's server"
        ));
    }
    Ok(())
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

    /// A macOS plist is XML, so `service.mjs` runs the path through `escapeXml`
    /// on the way in. A home directory containing `&` therefore never matched
    /// the unescaped `resource_dir` — the hand-off was skipped and the old
    /// service survived the update, silently. (Codex P2 on #459.)
    #[test]
    fn an_xml_escaped_ampersand_in_a_plist_still_matches() {
        let plist = "<string>/Users/R&amp;D/Minder.app/Contents/Resources/minder-server/server.js\
                     </string>";
        assert!(registration_references(
            plist,
            "/Users/R&D/Minder.app/Contents/Resources"
        ));
    }

    /// The systemd half of the same bug: `escapeSystemdPercent` doubles `%`.
    #[test]
    fn a_doubled_percent_in_a_systemd_unit_still_matches() {
        let unit = "ExecStart=/opt/minder%%20app/node/bin/node /opt/minder%%20app/minder-server/server.js";
        assert!(registration_references(unit, "/opt/minder%20app"));
    }

    /// Ordering rule, tested on the decoder directly because it is invisible
    /// through `registration_references`. `escapeXml` encodes `&` FIRST, so a
    /// literal `&lt;` in a path was written `&amp;lt;`. Decoding `&amp;` first
    /// would yield `&lt;` and the next pass would wrongly reduce it to `<` —
    /// the classic double-decode. Decoding must run in reverse order of
    /// encoding, which puts `&amp;` last.
    #[test]
    fn entity_decoding_runs_in_reverse_order_of_encoding() {
        use super::decode_registration_escapes;
        assert_eq!(decode_registration_escapes("&amp;lt;"), "&lt;");
        assert_eq!(decode_registration_escapes("&amp;"), "&");
        assert_eq!(decode_registration_escapes("&lt;a&gt;"), "<a>");
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

    /// A helper that reports failure must abort the update. Before this was a
    /// gate, the failure only reached the log and the install went ahead —
    /// straight into the locked-file (Windows) or stale-payload (POSIX) outcome
    /// the whole module exists to prevent. (Codex P1 on #459.)
    #[test]
    fn a_failing_stop_helper_aborts_the_update() {
        use super::{classify_stop, StopExit};
        for exit in [
            StopExit::Failed("it exited with exit code: 1".into()),
            StopExit::TimedOut,
        ] {
            assert!(
                classify_stop(true, exit.clone(), false, 4100).is_err(),
                "{exit:?} must not be reported as a successful stop"
            );
            // …and the verdict must not depend on the port having come free:
            // a helper that failed tells us enough on its own.
            assert!(classify_stop(false, exit, false, 4100).is_err());
        }
    }

    /// A clean exit is not proof. The helper exits 0 when it refuses to kill a
    /// process it cannot identify, so when a Minder was answering on the port,
    /// that port still being served is evidence the service never let go.
    #[test]
    fn a_clean_exit_is_not_enough_when_the_port_is_still_served() {
        use super::{classify_stop, StopExit};
        assert!(classify_stop(true, StopExit::Ok, true, 4100).is_err());
        assert!(classify_stop(true, StopExit::Ok, false, 4100).is_ok());
    }

    /// The other half of that rule, and the one that keeps it from becoming a
    /// false alarm: if no Minder was answering, the port says nothing about our
    /// service — a foreign server can hold it while our service isn't running
    /// at all — so a still-bound port must NOT abort a viable update.
    #[test]
    fn a_port_we_never_expected_to_free_does_not_abort() {
        use super::{classify_stop, StopExit};
        assert!(classify_stop(false, StopExit::Ok, true, 4100).is_ok());
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
