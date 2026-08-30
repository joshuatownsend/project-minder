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
//! **It never restarts the service after a successful install.** The
//! registration is logon-triggered on every platform, so it returns by itself at
//! next logon; until then the port is free and the updated tray simply spawns its
//! own sidecar. Starting it back up there would instead race the relaunching tray
//! for the port. The one exception is a download that failed *after* we stopped
//! the service — that path never relaunches, so it cannot race, and leaving the
//! service down for an update that never happened would be a pure loss.
//!
//! The consequence worth knowing: the stop is a hard kill (that is what
//! `service.mjs stop` does on Windows, by necessity), so it writes no
//! clean-shutdown marker and the first boot after an update pays a full
//! `PRAGMA quick_check`. Expected, self-healing, and documented in
//! `docs/help/service-mode.md`.

use std::path::{Path, PathBuf};
use std::process::{Child, Command as StdCommand, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
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

/// The port `service.mjs stop` scans when the registration records none.
/// Mirrors `DEFAULT_SERVICE_PORT` in `scripts/service/lib.mjs` — if this drifts,
/// we predict a different target than the helper actually scans.
const DEFAULT_SERVICE_PORT: u16 = 4100;

/// The port the stop helper will actually target, which is the only port any of
/// our own checks may reason about. Split out as a free function so the
/// prediction is testable, and so the `None` case cannot quietly become a
/// different rule at each call site.
fn helper_target_port(installed_port: Option<u16>) -> u16 {
    installed_port.unwrap_or(DEFAULT_SERVICE_PORT)
}

/// Windows `CREATE_NO_WINDOW`. Same reason as in `supervisor`: the tray has no
/// console, so a default-flagged child flashes one. (0x08000000.)
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// A service this process stopped and still owes a restart to, if the update
/// does not go through.
///
/// Process-wide rather than held by the update task, because the hole it closes
/// is the task **not finishing**: the tray's Quit item stays clickable during
/// the download and calls `app.exit(0)`, which drops the task mid-await. The
/// recovery in the `Err` branch never runs, and the user is left with both the
/// service and the tray's sidecar down until the next logon — for an update
/// that never happened.
///
/// Armed only when a stop actually stopped something, and disarmed the moment
/// the update commits (a successful install deliberately does *not* restart the
/// service; see this module's header).
static PENDING_RESTORE: Mutex<Option<Arc<ServiceHandoff>>> = Mutex::new(None);

/// A stop that is UNDERWAY, covering the interval `PENDING_RESTORE` cannot.
///
/// `stop()` blocks — up to `STOP_TIMEOUT`, and on Windows really can take
/// seconds, since the helper shells `netstat` plus a PowerShell
/// `Get-CimInstance` per candidate PID. `arm_restore` only runs after it
/// returns. The tray's Quit item stays clickable throughout, so a user quitting
/// inside that window exits a process that has already stopped the service and
/// armed nothing: they lose both the logon service and the sidecar until their
/// next logon, for an update that never happened (#460).
///
/// This slot is armed BEFORE the helper runs, and only when the port was
/// observed bound. That is what keeps the guarantee `StoppedService` exists to
/// enforce — "never start a service the user deliberately left down" — because
/// nothing was left down if something was answering. It is a weaker observation
/// than the token's (a foreign server on that port would also arm it), and
/// deliberately so: a spurious start of a service that was not running is
/// recoverable, losing a running one is not.
static STOP_IN_FLIGHT: Mutex<Option<(Arc<ServiceHandoff>, Arc<AtomicBool>)>> =
    Mutex::new(None);

/// How long a Quit will wait for an in-flight stop to resolve before giving up.
///
/// `stop()` already bounds the helper at `STOP_TIMEOUT` and kills it on expiry,
/// so the flag is set shortly after that in the worst case; the grace is for the
/// bookkeeping in between, not for the helper.
const STOP_JOIN_GRACE: Duration = Duration::from_secs(5);

/// Proof that this process stopped a service that **was running**, and
/// therefore owes it a restart if the update does not go through.
///
/// A type rather than a `bool` because the rule it carries was otherwise
/// untestable and easy to get wrong: the stop helper exits 0 whether it stopped
/// something or found nothing listening, so a caller tracking "did I stop it?"
/// by hand can arm a restore for a service the user deliberately left down —
/// and then start it behind their back. Only [`ServiceHandoff::stop`] can mint
/// one, and only when a Minder was genuinely answering, so the mistake stops
/// being a rule to remember and becomes one the compiler refuses.
#[derive(Debug)]
pub struct StoppedService(Arc<ServiceHandoff>);

/// Record that a stopped service is owed a restart. Takes the token by value:
/// there is no way to call this without having actually stopped something.
///
/// Promotes rather than adds: the in-flight marker this stop set is cleared
/// here, so the debt is recorded exactly once and `restore_if_armed` cannot
/// start the service twice.
pub fn arm_restore(stopped: StoppedService) {
    // The marker is given up ONLY once the debt is actually recorded. Clearing
    // it unconditionally meant a poisoned `PENDING_RESTORE` lock lost both: the
    // restore was never stored AND the in-flight fallback was removed, which
    // reopens the exact "Quit sees nothing armed" hole this marker closes
    // (Copilot, PR #541). Keeping the marker is the safe direction — it fails
    // towards restarting a service that was running.
    let recorded = match PENDING_RESTORE.lock() {
        Ok(mut slot) => {
            *slot = Some(stopped.0);
            true
        }
        Err(_) => false,
    };
    if recorded {
        clear_stop_in_flight();
    }
}

/// Mark a stop as underway. Private, and called only from [`ServiceHandoff::stop`]
/// once the port has been observed bound.
fn mark_stop_in_flight(handoff: &Arc<ServiceHandoff>) -> Arc<AtomicBool> {
    let done = Arc::new(AtomicBool::new(false));
    if let Ok(mut slot) = STOP_IN_FLIGHT.lock() {
        *slot = Some((handoff.clone(), done.clone()));
    }
    done
}

fn take_stop_in_flight() -> Option<(Arc<ServiceHandoff>, Arc<AtomicBool>)> {
    STOP_IN_FLIGHT.lock().ok().and_then(|mut slot| slot.take())
}

fn clear_stop_in_flight() {
    let _ = take_stop_in_flight();
}

/// Claim the outstanding restore, if any. Taking it is what makes this safe to
/// call from both the update task and the Quit handler concurrently: whichever
/// arrives first gets the handoff and the other gets `None`.
fn take_restore() -> Option<Arc<ServiceHandoff>> {
    PENDING_RESTORE.lock().ok().and_then(|mut slot| slot.take())
}

/// Forget any outstanding restore without acting on it. Called once the update
/// is committed, where leaving the service stopped is the intended outcome.
pub fn disarm_restore() {
    let _ = take_restore();
    clear_stop_in_flight();
}

/// Restart a service this process stopped for an update that is not going to
/// happen. Safe to call unconditionally — it is a no-op unless a stop was armed
/// and nobody has claimed it yet.
pub fn restore_if_armed() {
    // The completed stop first: it is the stronger claim, and taking it also
    // means a promoted debt is never also served by the in-flight slot.
    if let Some(handoff) = take_restore() {
        clear_stop_in_flight();
        log("update: abandoning the update — putting the logon service back");
        handoff.start();
        return;
    }
    // Quit landed while the helper was still running.
    //
    // Starting here directly was the first attempt and it raced: `start()` runs
    // `schtasks /run` on Windows, against a `taskkill /F /T` that has not
    // finished (Codex P1, PR #541). So WAIT for the stop to resolve, and then
    // ask the ordinary question again.
    //
    // Waiting also makes the answer exact, which is why this is simpler than
    // what it replaces rather than more machinery. Before, the marker licensed
    // an unconditional start on the theory that a spurious start is recoverable
    // and a lost service is not — a real concession. Afterwards the stop has
    // resolved, so `arm_restore` has recorded a debt if and only if something of
    // ours was genuinely stopped: claim it and start, or find nothing and start
    // nothing. The concession is gone.
    //
    // `take` before the wait, so a concurrent claimant cannot also be here; the
    // debt it may promote into `PENDING_RESTORE` is what the second claim below
    // reads.
    if let Some((_handoff, done)) = take_stop_in_flight() {
        log("update: quit arrived mid-stop — waiting for it to finish before deciding");
        let deadline = Instant::now() + STOP_TIMEOUT + STOP_JOIN_GRACE;
        while !done.load(Ordering::SeqCst) && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(50));
        }
        match take_restore() {
            Some(handoff) => {
                log("update: the stop finished and owed a restart — putting the logon service back");
                handoff.start();
            }
            None => {
                // Either nothing of ours was running, or the stop failed and
                // left it running. Neither owes a start, and inventing one here
                // is what the token type exists to prevent.
                log("update: the stop finished owing nothing — leaving the service as it is");
            }
        }
    }
}

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
    /// The tray's OWN port. Used only to decide whether the helper's target is
    /// a port we already occupy — never as the port to probe or wait on.
    port: u16,
    /// The port the registration declares — what `service.mjs stop` will scan.
    /// `None` when the file did not record one.
    installed_port: Option<u16>,
    /// The registration file that referenced our bundle — logged so the reason
    /// we are touching a service at all is in the record.
    evidence: PathBuf,
}

/// How a given registration file serializes the paths and the port inside it.
///
/// Carried explicitly rather than inferred, because the decoding in
/// [`decode_registration_escapes`] is only correct for the format that applied
/// it: run the XML decoder over a Windows manifest and a directory genuinely
/// named `R&amp;D` silently becomes `R&D`, which then fails to match the real
/// `resource_dir` — the same skipped hand-off, arrived at from the other side.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RegistrationFormat {
    /// Windows `service-manifest.json`.
    Json,
    /// Windows `run-hidden.vbs`.
    Vbs,
    /// macOS LaunchAgent plist (XML).
    Plist,
    /// Linux systemd `--user` unit.
    SystemdUnit,
}

/// Registration files that could name our payload, newest mechanism first.
/// Windows records the resolved launch in a JSON sidecar, with the generated
/// VBS as the fallback for installs predating it; macOS and Linux keep the
/// command in the plist/unit itself.
#[cfg(windows)]
fn registration_files(home: &Path) -> Vec<(PathBuf, RegistrationFormat)> {
    let dir = home.join(".minder").join("service");
    vec![
        (
            dir.join("service-manifest.json"),
            RegistrationFormat::Json,
        ),
        (dir.join("run-hidden.vbs"), RegistrationFormat::Vbs),
    ]
}

#[cfg(target_os = "macos")]
fn registration_files(home: &Path) -> Vec<(PathBuf, RegistrationFormat)> {
    vec![(
        home.join("Library")
            .join("LaunchAgents")
            .join("com.minder.dashboard.plist"),
        RegistrationFormat::Plist,
    )]
}

#[cfg(all(unix, not(target_os = "macos")))]
fn registration_files(home: &Path) -> Vec<(PathBuf, RegistrationFormat)> {
    vec![(
        home.join(".config")
            .join("systemd")
            .join("user")
            .join("minder.service"),
        RegistrationFormat::SystemdUnit,
    )]
}

/// The port the registration declares its server should bind, which is the port
/// `service.mjs stop` will scan. Mirrors `resolveInstalledPort` in
/// `scripts/service/lib.mjs`, deliberately tolerantly: the marker locates the
/// field and the first digits after it are the value, so a template whitespace
/// change doesn't turn into a silent `None`.
fn extract_declared_port(text: &str, format: RegistrationFormat) -> Option<u16> {
    let marker = match format {
        RegistrationFormat::Json => "\"port\"",
        RegistrationFormat::Vbs => "WshEnv(\"PORT\")",
        RegistrationFormat::Plist => "<key>PORT</key>",
        RegistrationFormat::SystemdUnit => "Environment=PORT=",
    };
    let after = &text[text.find(marker)? + marker.len()..];
    let start = after.find(|c: char| c.is_ascii_digit())?;
    after[start..]
        .chars()
        .take_while(char::is_ascii_digit)
        .collect::<String>()
        .parse()
        .ok()
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
pub fn starts_at_boundary(haystack: &str, at: usize) -> bool {
    if at == 0 {
        return true;
    }
    let Some(prev) = haystack[..at].chars().next_back() else {
        return true;
    };
    // Reject only characters that make the match a continuation of a longer
    // path — a separator, or any character a path segment is spelled with.
    // Everything else (a quote, `=`, `>`, whitespace, `[`) is a container the
    // path is embedded in, and those are how every registration format we read
    // actually delimits it. Deliberately permissive in that direction: a false
    // negative here skips the hand-off entirely and breaks the update, which is
    // strictly worse than the false positive it guards against.
    !(prev == '/' || prev.is_alphanumeric() || matches!(prev, '.' | '-' | '_' | '~'))
}

fn normalize_path_text(text: &str) -> String {
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
/// Each decoder is applied **only to the format that produced it**. Decoding
/// unconditionally corrupts formats that never encoded: a Windows manifest
/// naming a directory literally called `R&amp;D` would be rewritten to `R&D`
/// and stop matching the real `resource_dir`, and a Windows path containing a
/// literal `%%` would collapse to `%` — both of them false negatives that skip
/// the hand-off and let a live service break the update, which is the failure
/// this module exists to prevent, reached from the opposite direction.
fn decode_registration_escapes(text: &str, format: RegistrationFormat) -> String {
    match format {
        // JSON escapes `\` as `\\`, which the separator-run collapsing in
        // `normalize_path_text` already handles; nothing else in a Windows path
        // is escaped by `JSON.stringify`.
        RegistrationFormat::Json => text.to_string(),
        // VBScript's only escape is a doubled `"`, and a Windows path cannot
        // contain a quote — so there is nothing here to undo either.
        RegistrationFormat::Vbs => text.to_string(),
        RegistrationFormat::Plist => text
            .replace("&lt;", "<")
            .replace("&gt;", ">")
            .replace("&quot;", "\"")
            // Not emitted by our own escapeXml, but valid XML that a
            // hand-edited or differently-generated plist may carry.
            .replace("&apos;", "'")
            .replace("&amp;", "&"),
        RegistrationFormat::SystemdUnit => text.replace("%%", "%"),
    }
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
pub fn registration_references(registration: &str, dir: &str, format: RegistrationFormat) -> bool {
    let haystack = normalize_path_text(&decode_registration_escapes(registration, format));
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
        //
        // The START boundary matters just as much as the end, and checking only
        // the end was wrong: `/opt/Minder` occurs inside
        // `/backup/opt/Minder/server.js`, so a backup copy's registration read
        // as our own bundle. We would then stop that unrelated service — and,
        // since a committed update deliberately does not restart it, leave it
        // down until the user's next logon.
        if starts_at_boundary(&haystack, at) && haystack[at + needle.len()..].starts_with('/') {
            return true;
        }
        // Advance by one CHARACTER, not one byte. `at` is a char boundary (both
        // `find` and the previous step land on one) but `at + 1` need not be,
        // and slicing a `String` off a boundary panics rather than failing — so
        // a home directory with any non-ASCII character in it (`C:\Users\José`)
        // would take the whole update check down with it the first time a
        // candidate match failed the separator test above.
        from = at + haystack[at..].chars().next().map_or(1, char::len_utf8);
    }
    false
}

/// The first registration file that points into `resource_dir`, with the port
/// it declares — the port `service.mjs stop` will scan, which the pre-download
/// gate needs in order to tell "the service could be running elsewhere" from
/// "the only thing on that port is our own sidecar".
fn find_registration(home: &Path, resource_dir: &Path) -> Option<(PathBuf, Option<u16>)> {
    let dir = resource_dir.to_string_lossy().to_string();
    let files: Vec<(PathBuf, RegistrationFormat, String)> = registration_files(home)
        .into_iter()
        .filter_map(|(path, format)| {
            let text = std::fs::read_to_string(&path).ok()?;
            Some((path, format, text))
        })
        .collect();

    let (evidence, _, _) = files
        .iter()
        .find(|(_, format, text)| registration_references(text, &dir, *format))?;

    // The port is resolved across ALL registration files, in the same order and
    // with the same precedence as `resolveInstalledPort` in
    // `scripts/service/lib.mjs` — manifest first, then the VBS — and
    // deliberately NOT restricted to whichever file matched the path.
    //
    // A Windows manifest written before the `port` field existed still names
    // the bundle, so it matches; reading the port from it alone yields `None`,
    // we fall back to the default 4100, and a service actually installed on
    // 4199 (recorded only in run-hidden.vbs) gets predicted as 4100. With the
    // tray holding 4100 and unattached, the gate then skips the one stop whose
    // failure can abort the update — the round-2 bug, reopened for exactly the
    // older installs the VBS fallback exists to support.
    let port = files
        .iter()
        .find_map(|(_, format, text)| extract_declared_port(text, *format));

    Some((evidence.clone(), port))
}

/// Whether the pre-download stop — the only one whose failure can still abort
/// the update — should run.
///
/// It must run whenever a registered service could be holding our files, and
/// must **not** run when the only thing the helper could find on its target
/// port is our own sidecar.
///
/// * **Attached** — the port-holder is not ours and our supervisor has no child
///   at all, so the helper cannot reach one. Stop.
/// * **Not attached, service registered on a different port** — the service can
///   be running entirely independently of the tray's attach state, holding our
///   files while the helper's target port is one we do not own. Stop. (This is
///   the case the first version of this gate missed: it assumed a service that
///   holds our files must also own our port.)
/// * **Not attached, same port** — our sidecar bound that port, so the service
///   cannot be running on it and cannot be holding anything. There is nothing to
///   stop, and running the helper anyway would find only our own child and
///   hard-kill it. Skip.
/// `target_port` is what the helper will actually scan — [`helper_target_port`],
/// not the raw registration field. That is what folds the "no port recorded"
/// case in without a rule of its own: an unrecorded port means the helper falls
/// back to the default, so comparing the default is exactly right.
pub fn should_stop_before_download(attached: bool, target_port: u16, our_port: u16) -> bool {
    attached || target_port != our_port
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
        let Some((evidence, installed_port)) = find_registration(home, resource_dir) else {
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
                installed_port,
                evidence,
            })),
            // Phrased for whoever actually reads it: this string is surfaced in
            // a tray notification on an end-user machine, which has the app but
            // need not have pnpm, Node, or a checkout of this repo — so naming a
            // repo script as the remedy would be advice they cannot follow.
            _ => Err(format!(
                "the logon service registered in {} runs this app's own bundle, so it must be \
                 stopped before the update can replace those files — but this build does not \
                 ship the helper needed to stop it. Stop the Project Minder logon service, then \
                 try the update again.",
                evidence.display()
            )),
        }
    }

    /// Whether the pre-download stop should run for this handoff. See
    /// [`should_stop_before_download`] for why the port comparison is the
    /// discriminator rather than attach state alone.
    pub fn should_stop_before_download(&self, attached: bool) -> bool {
        should_stop_before_download(attached, helper_target_port(self.installed_port), self.port)
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
    ///
    /// `Ok(true)` means a Minder really was answering on the helper's port and
    /// is now stopped, and the restore debt HAS ALREADY BEEN ARMED — see the
    /// note at the end of this function for why the caller cannot be trusted to
    /// do it. `Ok(false)` means there was nothing to stop, which the helper also
    /// reports as success, and which must never lead to *starting* a service the
    /// user deliberately left down.
    pub fn stop(self: &Arc<Self>) -> Result<bool, String> {
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
        // Every check below is about the port the HELPER targets, never the
        // tray's own. Round 2 conflated them, and the two differ in precisely
        // the configuration round 2 existed to support: with the service on
        // 4199 and our sidecar on 4100, probing 4100 sees our own healthy
        // Minder, then waits for a port that correctly never frees — failing
        // every update. The mirror error is as bad: a quiet tray port would let
        // a genuinely failed stop of 4199 pass unverified.
        let target = helper_target_port(self.installed_port);
        // Two questions, two primitives — a distinction this codebase has
        // already paid to learn (see `crate::health`). A TCP connect answers
        // "was something running?" even for a server that is bound but not yet
        // responding; only an actual health answer licenses demanding that the
        // port come free.
        let was_listening = crate::health::port_is_bound(target);
        let served_minder = crate::health::probe(target).is_minder();
        // Armed BEFORE the helper, which blocks for as long as it takes and
        // stays racing a clickable Quit the whole time (#460). Gated on
        // `was_listening` so this can only ever put back something that was
        // observed up — the invariant `StoppedService` protects, held one
        // observation earlier.
        let stop_done = if was_listening {
            Some(mark_stop_in_flight(self))
        } else {
            None
        };
        let exit = self.run_helper("stop");
        // Short-circuits: only worth the wait when something was there to go
        // away and the helper claims to have done its job.
        let port_came_free =
            was_listening && exit == StopExit::Ok && port_released(target, RELEASE_GRACE);
        let verdict = classify_stop(
            StopObservations {
                was_listening,
                served_minder,
                exit,
                port_came_free,
            },
            target,
        );
        match &verdict {
            Ok(true) => log("update: the logon service is stopped"),
            // Reached whenever nothing was listening — an already stopped
            // service, or one that never ran. Nothing changed, so nothing may
            // be put back later.
            Ok(false) => log("update: no logon service was running — nothing to stop"),
            Err(why) => log(&format!("update: could not stop the logon service — {why}")),
        }
        // Nothing is owed on these paths, so the in-flight marker must not
        // outlive the call — otherwise a later Quit would start a service this
        // stop found already down. The owed path deliberately leaves it set:
        // `arm_restore` clears it as it promotes, so there is no instant
        // between `stop()` returning and the debt being recorded in which a
        // Quit would find nothing.
        if !matches!(verdict, Ok(true)) {
            clear_stop_in_flight();
        }
        // The debt is armed HERE, not by the caller, and the flag is released
        // only afterwards.
        //
        // Signalling completion first left a smaller copy of the very window
        // this change closes (Codex P1, PR #541): the caller arms in
        // `updater.rs` AFTER `stop()` returns, so a Quit waiting on the flag
        // could wake in between, find `PENDING_RESTORE` empty, conclude nothing
        // was owed and exit — and the updater would then record the debt too
        // late for anything to act on it.
        //
        // `stop()` is the only thing that can mint a `StoppedService`, so it is
        // also the only place that can close that gap. The token type still
        // does its job: nothing else can record a debt, and this records one
        // only when the verdict says a running service really was stopped.
        let stopped = verdict.as_ref().is_ok_and(|v| *v);
        if stopped {
            arm_restore(StoppedService(self.clone()));
        }
        // Released on EVERY path, including the error ones: a Quit blocked on
        // this flag must never outlive the stop it is waiting for. By here the
        // debt, if any, is already recorded — which is the point.
        if let Some(done) = &stop_done {
            done.store(true, Ordering::SeqCst);
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
/// The facts a caller can gather around a stop, kept as a struct because two
/// of them look interchangeable and are not.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StopObservations {
    /// Something held the helper's target port before the stop — a plain TCP
    /// connect, which is true for a service that is running but has not begun
    /// answering yet. This, not `served_minder`, is what "was it running?"
    /// means.
    pub was_listening: bool,
    /// A Minder *answered* on that port before the stop. Strictly stronger than
    /// `was_listening`, and the only thing that licenses demanding a release.
    pub served_minder: bool,
    /// How the helper itself ended.
    pub exit: StopExit,
    /// The port was observed to come free afterwards. Only ever set when it was
    /// worth asking — see [`ServiceHandoff::stop`].
    pub port_came_free: bool,
}

pub fn classify_stop(obs: StopObservations, port: u16) -> Result<bool, String> {
    let StopObservations {
        was_listening,
        served_minder,
        exit,
        port_came_free,
    } = obs;
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
    // A Minder that *was answering* must have let go. Only that case: something
    // foreign holding the port, or nothing holding it at all, tells us nothing
    // about our service, and demanding a release there would abort an update
    // that would have succeeded.
    if served_minder && !port_came_free {
        return Err(format!(
            "port {port} is still served by Minder after stopping the logon service — whatever \
             holds it was not recognized as this installation's server"
        ));
    }
    // Whether we owe a restart is a DIFFERENT question, and answering it with
    // `served_minder` was wrong. A registered service that is running but still
    // booting — blocked opening a large index, which is the exact state this
    // app's tray was rewritten to stop misreading — never answers a health
    // probe. It minted no token, so a failed download or a Quit mid-download
    // could not put it back, and the user lost it until the next logon. The
    // honest signal is that something WAS on that port and is now gone.
    Ok(was_listening && port_came_free)
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
    use super::{
        classify_stop, normalize_path_text, registration_references, RegistrationFormat,
        ServiceHandoff, StopExit, StopObservations,
    };

    const JSON: RegistrationFormat = RegistrationFormat::Json;
    const PLIST: RegistrationFormat = RegistrationFormat::Plist;
    const UNIT: RegistrationFormat = RegistrationFormat::SystemdUnit;
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
        assert!(registration_references(manifest, r"C:\App", JSON));
    }

    #[test]
    fn a_plist_path_matches() {
        let plist = "<key>ProgramArguments</key><array>\
            <string>/Applications/Minder.app/Contents/Resources/node/bin/node</string>\
            <string>/Applications/Minder.app/Contents/Resources/minder-server/server.js</string>\
            </array>";
        assert!(registration_references(
            plist,
            "/Applications/Minder.app/Contents/Resources",
            PLIST
        ));
    }

    /// The whole point of the gate: a service running some *other* payload is
    /// not holding our files and must be left alone.
    #[test]
    fn a_service_pointed_at_another_payload_is_not_ours() {
        let manifest = r#"{"args":["C:\\dev\\project-minder\\dist\\minder-server\\server.js"]}"#;
        assert!(!registration_references(
            manifest,
            r"C:\Users\joshu\AppData\Local\Project Minder Tray",
            JSON
        ));
    }

    /// Boundary rule: a sibling install whose name merely starts with ours must
    /// not match. Stopping a service on another installation's behalf is the
    /// same class of error as killing an unrelated `pnpm dev`.
    #[test]
    fn a_longer_sibling_directory_does_not_match() {
        let manifest = r#"{"args":["C:\\Apps\\Minder Tray 2\\minder-server\\server.js"]}"#;
        assert!(!registration_references(manifest, r"C:\Apps\Minder Tray", JSON));
        // …while the real thing still does.
        let ours = r#"{"args":["C:\\Apps\\Minder Tray\\minder-server\\server.js"]}"#;
        assert!(registration_references(ours, r"C:\Apps\Minder Tray", JSON));
    }

    /// An earlier occurrence that fails the boundary test must not shadow a
    /// later one that passes — same rule as `hasBoundaryMatch` in lib.mjs.
    #[test]
    fn an_earlier_non_match_does_not_hide_a_later_match() {
        let text = r#"{"note":"C:\\Apps\\Minder Tray 2","args":["C:\\Apps\\Minder Tray\\x.js"]}"#;
        assert!(registration_references(text, r"C:\Apps\Minder Tray", JSON));
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
            "/Users/R&D/Minder.app/Contents/Resources",
            PLIST
        ));
    }

    /// The systemd half of the same bug: `escapeSystemdPercent` doubles `%`.
    #[test]
    fn a_doubled_percent_in_a_systemd_unit_still_matches() {
        let unit = "ExecStart=/opt/minder%%20app/node/bin/node /opt/minder%%20app/minder-server/server.js";
        assert!(registration_references(unit, "/opt/minder%20app", UNIT));
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
        assert_eq!(decode_registration_escapes("&amp;lt;", PLIST), "&lt;");
        assert_eq!(decode_registration_escapes("&amp;", PLIST), "&");
        assert_eq!(decode_registration_escapes("&lt;a&gt;", PLIST), "<a>");
    }

    /// Round 4, Copilot: the scan advanced one BYTE past a failed match, and a
    /// byte step off a char boundary panics rather than failing.
    ///
    /// **Latent, not live** — and worth stating precisely, because the obvious
    /// reading of the finding is wrong. The index it steps from is where the
    /// *needle* starts, and the needle is a normalized absolute path, which
    /// always begins `c:` or `/`. So an accented **home directory** never
    /// triggers it: `C:\Users\José\Apps` still starts with an ASCII `c`. It
    /// takes a needle whose FIRST character is multi-byte, which
    /// `resource_dir()` cannot currently produce.
    ///
    /// Fixed anyway: this is a public function, the correction is free, and
    /// "unreachable through today's only caller" is a property of the caller,
    /// not of the loop. The input below is therefore deliberately synthetic —
    /// the first occurrence fails the separator test, forcing the advance to
    /// step through the multi-byte `é`. It panics without the fix.
    #[test]
    fn the_scan_steps_by_characters_so_it_cannot_split_a_codepoint() {
        assert!(registration_references("éax éa/server.js", "éa", JSON));
    }

    /// The same loop must also terminate cleanly — returning false, not
    /// panicking — when the non-ASCII near-match is the only occurrence.
    #[test]
    fn a_non_ascii_near_match_returns_false_instead_of_panicking() {
        assert!(!registration_references("éax", "éa", JSON));
    }

    /// Round 6, Codex P2 (missed on an earlier round): the end-only boundary
    /// check let our bundle path match as a SUFFIX of an unrelated absolute
    /// path. A backup copy's registration would then read as our own, and we
    /// would stop that service — and, since a committed update deliberately
    /// never restarts it, leave someone else's service down until next logon.
    #[test]
    fn our_bundle_path_appearing_inside_another_absolute_path_is_not_ours() {
        let unit = "ExecStart=/usr/bin/node /backup/opt/Minder/minder-server/server.js";
        assert!(!registration_references(unit, "/opt/Minder", UNIT));
        // …while the genuine article still matches.
        let ours = "ExecStart=/usr/bin/node /opt/Minder/minder-server/server.js";
        assert!(registration_references(ours, "/opt/Minder", UNIT));
    }

    /// The start-boundary rule must stay permissive about the *containers* a
    /// path is embedded in, or it would reject every real registration: each
    /// format wraps the path in quotes, `=` or XML tags. A false negative here
    /// skips the hand-off and breaks the update, which is worse than the false
    /// positive the rule guards against.
    #[test]
    fn the_start_boundary_still_accepts_every_real_registration_wrapper() {
        assert!(registration_references(
            r#"{"args":["C:\\Apps\\Minder\\server.js"]}"#,
            r"C:\Apps\Minder",
            JSON
        ));
        assert!(registration_references(
            "<string>/opt/Minder/server.js</string>",
            "/opt/Minder",
            PLIST
        ));
        assert!(registration_references(
            "ExecStart=/opt/Minder/server.js",
            "/opt/Minder",
            UNIT
        ));
    }

    /// A reference to the directory with nothing under it names no file we
    /// could be holding open.
    #[test]
    fn the_bare_directory_alone_is_not_a_reference_to_a_file_in_it() {
        assert!(!registration_references(
            r#"{"cwd":"C:\\Apps\\Minder Tray"}"#,
            r"C:\Apps\Minder Tray",
            JSON
        ));
    }

    #[test]
    fn an_empty_directory_never_matches_anything() {
        assert!(!registration_references("anything at all", "", JSON));
        assert!(!registration_references("anything at all", "/", JSON));
    }

    /// Build observations for the common shapes, so each test below reads as
    /// the situation it describes rather than four positional booleans.
    fn obs(was_listening: bool, served_minder: bool, exit: StopExit, came_free: bool) -> StopObservations {
        StopObservations {
            was_listening,
            served_minder,
            exit,
            port_came_free: came_free,
        }
    }

    /// A helper that reports failure must abort the update. Before this was a
    /// gate, the failure only reached the log and the install went ahead —
    /// straight into the locked-file (Windows) or stale-payload (POSIX) outcome
    /// the whole module exists to prevent. (Codex P1 on #459.)
    #[test]
    fn a_failing_stop_helper_aborts_the_update() {
        for exit in [
            StopExit::Failed("it exited with exit code: 1".into()),
            StopExit::TimedOut,
        ] {
            assert!(
                classify_stop(obs(true, true, exit.clone(), false), 4100).is_err(),
                "{exit:?} must not be reported as a successful stop"
            );
            // …and it must not depend on anything else being observed: a helper
            // that failed tells us enough on its own.
            assert!(classify_stop(obs(false, false, exit, false), 4100).is_err());
        }
    }

    /// A clean exit is not proof. The helper exits 0 when it refuses to kill a
    /// process it cannot identify, so when a Minder was answering on the port,
    /// that port still being served is evidence the service never let go.
    #[test]
    fn a_clean_exit_is_not_enough_when_the_port_is_still_served() {
        assert!(classify_stop(obs(true, true, StopExit::Ok, false), 4100).is_err());
        assert!(classify_stop(obs(true, true, StopExit::Ok, true), 4100).is_ok());
    }

    /// The other half of that rule, and the one that keeps it from becoming a
    /// false alarm: if no Minder was answering, the port says nothing about our
    /// service — a foreign server can hold it while our service isn't running
    /// at all — so a still-bound port must NOT abort a viable update.
    #[test]
    fn a_port_we_never_expected_to_free_does_not_abort() {
        assert!(classify_stop(obs(true, false, StopExit::Ok, false), 4100).is_ok());
    }

    /// Round 7, Codex P2 — the inverse case the restore token created. A
    /// registered service that is running but still BOOTING never answers a
    /// health probe: it is bound, and silent, which is the exact state the tray
    /// was rewritten to stop misreading. Keying the token on "a Minder
    /// answered" meant the helper killed it, no restart was owed, and a failed
    /// download or a Quit left the user's dashboard down until the next logon.
    ///
    /// Liveness is `was_listening`; `served_minder` only ever licenses
    /// demanding a release.
    #[test]
    fn a_running_but_unresponsive_service_is_still_owed_a_restart() {
        let stopped = classify_stop(obs(true, false, StopExit::Ok, true), 4100)
            .expect("a silent holder that went away is a clean stop");
        assert!(
            stopped,
            "something was on the port and is now gone — that debt must be recorded"
        );
    }

    /// …and the converse, which is what stops it becoming a licence to restart
    /// anything: nothing listening means nothing was stopped, so nothing may be
    /// started later behind the user's back.
    #[test]
    fn a_service_that_was_not_running_is_owed_nothing() {
        let stopped = classify_stop(obs(false, false, StopExit::Ok, false), 4100)
            .expect("nothing to stop is a successful stop");
        assert!(!stopped);
        // Even if the port somehow reads as free afterwards, it was never ours
        // to have stopped.
        let stopped = classify_stop(obs(false, false, StopExit::Ok, true), 4100).expect("clean");
        assert!(!stopped);
    }

    /// A holder that never went away was not stopped by us, so no restart is
    /// owed for it either — the foreign-process case, which must neither abort
    /// the update nor arm a restore.
    #[test]
    fn a_holder_that_never_let_go_is_owed_nothing() {
        let stopped = classify_stop(obs(true, false, StopExit::Ok, false), 4100)
            .expect("a foreign holder must not abort a viable update");
        assert!(!stopped);
    }


    /// Round 2, Codex P2: decoding must be chosen by format, not applied to
    /// everything. A Windows directory genuinely named `R&amp;D` is legal, and
    /// running the XML decoder over its manifest rewrites the haystack to `R&D`
    /// — which then fails to match the real `resource_dir`, skipping the
    /// hand-off and letting the live service break the update.
    #[test]
    fn a_literal_entity_in_a_windows_manifest_is_not_decoded() {
        let manifest = r#"{"args":["C:\\Apps\\R&amp;D\\minder-server\\server.js"]}"#;
        assert!(registration_references(manifest, r"C:\Apps\R&amp;D", JSON));
        // …and it must NOT be mistaken for the different directory `R&D`.
        assert!(!registration_references(manifest, r"C:\Apps\R&D", JSON));
    }

    /// The systemd half of the same rule: `%%` is only doubled in units, so a
    /// Windows path containing a literal `%%` must survive intact.
    #[test]
    fn a_literal_double_percent_in_a_windows_manifest_is_not_collapsed() {
        let manifest = r#"{"args":["C:\\Apps\\a%%b\\minder-server\\server.js"]}"#;
        assert!(registration_references(manifest, r"C:\Apps\a%%b", JSON));
        assert!(!registration_references(manifest, r"C:\Apps\a%b", JSON));
    }

    /// The VBS fallback (installs predating the JSON manifest) is a Windows
    /// format too, so neither decoder may touch it either. Tested separately
    /// from the manifest because they are separate match arms — covering only
    /// one leaves the other free to rot.
    #[test]
    fn a_vbs_registration_decodes_neither_entities_nor_percents() {
        use super::RegistrationFormat;
        let vbs = r#"WshShell.Run "C:\Apps\a%%b&amp;c\minder-server\server.js", 0, False"#;
        assert!(registration_references(
            vbs,
            r"C:\Apps\a%%b&amp;c",
            RegistrationFormat::Vbs
        ));
        assert!(!registration_references(
            vbs,
            r"C:\Apps\a%b&amp;c",
            RegistrationFormat::Vbs
        ));
        assert!(!registration_references(
            vbs,
            r"C:\Apps\a%%b&c",
            RegistrationFormat::Vbs
        ));
    }

    /// Round 2, Codex P1: a service registered on its OWN port runs entirely
    /// independently of whether the tray attached. The first version of this
    /// gate keyed on attach state alone and therefore skipped the only stop
    /// whose failure can abort the update.
    #[test]
    fn a_service_on_another_port_is_stopped_even_when_we_are_not_attached() {
        use super::should_stop_before_download;
        assert!(should_stop_before_download(false, 4199, 4100));
    }

    /// The one case that must be skipped: our own sidecar bound this port, so
    /// the service cannot be running on it — and the helper would find only our
    /// child and hard-kill it, costing the clean-shutdown marker.
    #[test]
    fn our_own_sidecar_on_the_registered_port_is_never_handed_to_the_helper() {
        use super::should_stop_before_download;
        assert!(!should_stop_before_download(false, 4100, 4100));
    }

    /// Attached means the port-holder is not ours and our supervisor has no
    /// child at all, so there is nothing the helper could mistake for one.
    #[test]
    fn an_attached_tray_always_stops_regardless_of_port() {
        use super::should_stop_before_download;
        assert!(should_stop_before_download(true, 4100, 4100));
        assert!(should_stop_before_download(true, 4199, 4100));
    }

    /// A registration recording no port does not get a rule of its own: the
    /// helper falls back to the default, so predicting the default is what
    /// makes our checks agree with what it will actually scan.
    #[test]
    fn an_unrecorded_port_resolves_to_the_helper_default() {
        use super::{helper_target_port, should_stop_before_download, DEFAULT_SERVICE_PORT};
        assert_eq!(helper_target_port(None), DEFAULT_SERVICE_PORT);
        assert_eq!(helper_target_port(Some(4199)), 4199);
        // …so an unrecorded port on a tray already holding the default is the
        // skip case, not a stop: the helper would find only our own sidecar.
        assert!(!should_stop_before_download(
            false,
            helper_target_port(None),
            DEFAULT_SERVICE_PORT
        ));
        // …while a tray on some other port still needs the default stopped.
        assert!(should_stop_before_download(false, helper_target_port(None), 4199));
    }

    /// Round 3, Codex P1 — a bug introduced by round 2's own fix. Every check
    /// in `stop()` must follow the port the HELPER targets, never the tray's.
    /// With the service on 4199 and our sidecar on 4100 — the exact
    /// configuration round 2 added support for — probing the tray's port sees
    /// our own healthy Minder and then waits for a port that correctly never
    /// frees, failing every update.
    #[test]
    fn the_stop_is_verified_against_the_helpers_port_not_the_trays() {
        use super::{helper_target_port, ServiceHandoff};
        use std::path::PathBuf;
        let handoff = ServiceHandoff {
            node: PathBuf::from("node"),
            cli: PathBuf::from("service.mjs"),
            cwd: PathBuf::from("."),
            port: 4100,
            installed_port: Some(4199),
            evidence: PathBuf::from("manifest.json"),
        };
        assert_eq!(
            helper_target_port(handoff.installed_port),
            4199,
            "the verified port must be the service's, not the tray's"
        );
        assert_ne!(helper_target_port(handoff.installed_port), handoff.port);
        // And this configuration must still be stopped at all — the round-2 rule.
        assert!(handoff.should_stop_before_download(false));
    }

    /// The gate is only as good as the port it reads, and each format records
    /// it differently.
    #[test]
    fn the_declared_port_is_read_from_every_registration_format() {
        use super::{extract_declared_port, RegistrationFormat};
        assert_eq!(
            extract_declared_port(r#"{"mode":"standalone","port":4199}"#, JSON),
            Some(4199)
        );
        assert_eq!(
            extract_declared_port(
                "WshEnv(\"PORT\") = \"4199\"\nWshEnv(\"HOSTNAME\") = \"127.0.0.1\"",
                RegistrationFormat::Vbs
            ),
            Some(4199)
        );
        assert_eq!(
            extract_declared_port("<key>PORT</key>\n    <string>4199</string>", PLIST),
            Some(4199)
        );
        assert_eq!(
            extract_declared_port("Environment=PORT=4199\nEnvironment=HOSTNAME=127.0.0.1", UNIT),
            Some(4199)
        );
        // A registration with no port recorded must report absence, not a
        // guess — the gate treats the two differently.
        assert_eq!(extract_declared_port(r#"{"mode":"standalone"}"#, JSON), None);
    }

    fn fake_handoff(port: u16, installed_port: Option<u16>) -> ServiceHandoff {
        use std::path::PathBuf;
        ServiceHandoff {
            node: PathBuf::from("node"),
            cli: PathBuf::from("service.mjs"),
            cwd: PathBuf::from("."),
            port,
            installed_port,
            evidence: PathBuf::from("manifest.json"),
        }
    }

    /// Round 5, Codex P2: the outstanding-restore slot, exercised as one
    /// sequence rather than three tests.
    ///
    /// It is process-global state, and `cargo test` runs tests on parallel
    /// threads — so three separate tests sharing it would interleave and fail
    /// intermittently. A flaky test in the harness that is supposed to *prove*
    /// this module is worse than no test: it trains you to re-run rather than
    /// read. The ordering matters here anyway, which makes one sequence the
    /// honest shape.
    #[test]
    fn the_outstanding_restore_slot_is_armed_claimed_once_and_disarmable() {
        use super::{
            arm_restore, clear_stop_in_flight, disarm_restore, mark_stop_in_flight,
            restore_if_armed, take_restore, take_stop_in_flight, StoppedService,
        };
        use std::sync::atomic::Ordering;
        use std::sync::Arc;

        // Nothing armed — the state after every update that never stopped a
        // running service. Restoring must be a no-op, or a failed download
        // would START a service the user had deliberately left down.
        assert!(take_restore().is_none());
        restore_if_armed();
        assert!(take_restore().is_none());

        // Claiming is destructive, and that is precisely what makes the update
        // task and the Quit handler safe to race: exactly one of them gets the
        // handoff, so the service can never be started twice.
        arm_restore(StoppedService(Arc::new(fake_handoff(4100, Some(4199)))));
        assert!(take_restore().is_some(), "the first claim wins it");
        assert!(take_restore().is_none(), "a second claim must find nothing");

        // Committing the update gives the restore up rather than performing it:
        // a successful install leaves the service down until the next logon by
        // design, and a Quit racing the hand-off must not resurrect it onto the
        // port the updated tray is about to take.
        arm_restore(StoppedService(Arc::new(fake_handoff(4100, Some(4199)))));
        disarm_restore();
        assert!(
            take_restore().is_none(),
            "a committed update must leave nothing to put back"
        );

        // --- the interval the completed-stop slot cannot cover (#460) ---
        //
        // `stop()` blocks while the helper runs, and Quit stays clickable
        // throughout. Before this, quitting there exited a process that had
        // already taken the service down and armed nothing, costing the user
        // both the service and the sidecar until their next logon.
        //
        // Asserted through the slots rather than by calling `restore_if_armed`
        // with something armed — that would spawn a real service off a fake
        // handoff. The claim semantics are the behaviour under test; `start()`
        // is not.
        let handoff = Arc::new(fake_handoff(4100, Some(4199)));

        clear_stop_in_flight();
        assert!(
            take_stop_in_flight().is_none(),
            "no stop underway means Quit has nothing to put back"
        );

        mark_stop_in_flight(&handoff);
        assert!(
            take_stop_in_flight().is_some(),
            "a Quit landing mid-stop must find the handoff"
        );
        assert!(
            take_stop_in_flight().is_none(),
            "claiming it is destructive, so update and Quit cannot both act"
        );

        // Promotion, not accumulation. Arming the real debt consumes the
        // marker, so the two slots can never start the same service twice.
        mark_stop_in_flight(&handoff);
        arm_restore(StoppedService(handoff.clone()));
        assert!(
            take_stop_in_flight().is_none(),
            "arming the completed stop must consume the in-flight marker"
        );
        assert!(take_restore().is_some(), "the real debt is what remains");

        // A committed update gives up both, for the same reason it gives up
        // the first: the service is meant to stay down until the next logon,
        // and a Quit racing the hand-off must not resurrect it onto the port
        // the updated tray is about to take.
        mark_stop_in_flight(&handoff);
        arm_restore(StoppedService(handoff.clone()));
        disarm_restore();
        assert!(take_restore().is_none());
        assert!(
            take_stop_in_flight().is_none(),
            "a committed update must not leave a mid-stop marker behind either"
        );

        // --- and Quit no longer starts anything on faith (#541 P1) ---
        //
        // The first version of this marker licensed an UNCONDITIONAL start: it
        // knew the port had been bound, not what the helper had done. That
        // raced `schtasks /run` against a `taskkill /F /T` still in progress,
        // and conceded a possible spurious start as the lesser evil.
        //
        // Waiting makes the answer exact instead. With the stop resolved and no
        // debt recorded — the helper found nothing of ours — `restore_if_armed`
        // must consume the marker and start NOTHING. Safe to call for real here
        // precisely because nothing is owed: starting needs a `StoppedService`,
        // and there is none.
        assert!(take_restore().is_none(), "nothing owed before this case");
        let done = mark_stop_in_flight(&handoff);
        done.store(true, Ordering::SeqCst); // the stop has already resolved
        restore_if_armed();
        assert!(
            take_stop_in_flight().is_none(),
            "the marker is consumed even when the stop turned out to owe nothing"
        );
        assert!(
            take_restore().is_none(),
            "and no debt is invented on the way out"
        );

        // Leave the globals as they were found — these slots are process-wide
        // and this is the only test that touches them.
        clear_stop_in_flight();
        restore_if_armed();
    }

    /// Round 6, Codex P1 (missed on an earlier round): the port must be
    /// resolved with the helper's own precedence — manifest, then VBS — and not
    /// only from whichever file happened to match the path.
    ///
    /// A Windows manifest written before the `port` field existed still names
    /// the bundle, so it matches; reading the port from it alone gives `None`,
    /// which falls back to 4100. A service actually installed on 4199, recorded
    /// only in `run-hidden.vbs`, is then predicted as 4100 — and with the tray
    /// holding 4100 unattached, the gate skips the one stop whose failure can
    /// abort the update. Windows-only because it is the only platform with two
    /// registration files to disagree.
    #[cfg(windows)]
    #[test]
    fn the_port_falls_through_a_portless_manifest_to_the_vbs() {
        use super::{find_registration, should_stop_before_download};
        let base = std::env::temp_dir().join("minder-handoff-vbs-port-test");
        let home = base.join("home");
        let resources = base.join("Project Minder Tray");
        let dir = home.join(".minder").join("service");
        std::fs::create_dir_all(&dir).expect("create service dir");
        std::fs::create_dir_all(&resources).expect("create resource dir");

        let server = resources.join("minder-server").join("server.js");
        // Pre-`port` manifest: names the bundle, records no port.
        std::fs::write(
            dir.join("service-manifest.json"),
            format!(
                "{{\"mode\":\"standalone\",\"args\":[{:?}]}}",
                server.to_string_lossy()
            ),
        )
        .expect("write manifest");
        // …while the VBS the task actually launches records 4199.
        std::fs::write(
            dir.join("run-hidden.vbs"),
            format!(
                "WshEnv(\"PORT\") = \"4199\"\r\nWshShell.Run \"{}\", 0, False\r\n",
                server.to_string_lossy()
            ),
        )
        .expect("write vbs");

        let (_, port) = find_registration(&home, &resources).expect("the manifest names our bundle");
        assert_eq!(
            port,
            Some(4199),
            "the port must fall through to the VBS, as resolveInstalledPort does"
        );
        // …which is what keeps the gate from skipping the stop on a tray that
        // holds the default port.
        assert!(should_stop_before_download(
            false,
            super::helper_target_port(port),
            4100
        ));

        let _ = std::fs::remove_dir_all(&base);
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

/// Compile-time tether to the JavaScript side of the port contract.
///
/// `helper_target_port` predicts what `service.mjs stop` will scan when the
/// registration records no port. That prediction is only correct while both
/// sides agree on the default — and nothing at runtime would notice if they
/// stopped agreeing: the tray would probe one port, the helper would stop
/// another, and every verification would silently answer about the wrong
/// thing. `include_str!` resolves relative to this file and only compiles
/// in-repo, so it costs nothing in the packaged binary. Mirrors the same
/// pattern in `supervisor::contract_tests`.
#[cfg(test)]
mod contract_tests {
    use super::DEFAULT_SERVICE_PORT;

    const LIB_MJS: &str = include_str!("../../scripts/service/lib.mjs");

    #[test]
    fn the_default_port_matches_the_service_cli() {
        const NAME: &str = "export const DEFAULT_SERVICE_PORT =";
        let at = LIB_MJS
            .find(NAME)
            .expect("lib.mjs must still export DEFAULT_SERVICE_PORT");
        let digits: String = LIB_MJS[at + NAME.len()..]
            .chars()
            .skip_while(|c| c.is_whitespace())
            .take_while(char::is_ascii_digit)
            .collect();
        let from_js: u16 = digits.parse().expect("a numeric default port");
        assert_eq!(
            from_js, DEFAULT_SERVICE_PORT,
            "scripts/service/lib.mjs defaults to port {from_js} but service_handoff.rs \
             predicts {DEFAULT_SERVICE_PORT} — the tray would verify a different port than \
             the stop helper actually targets"
        );
    }
}
