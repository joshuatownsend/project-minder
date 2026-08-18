//! Sidecar supervision: spawn / attach / restart / graceful-stop the packaged
//! Next server (`node server.js`).
//!
//! One dedicated OS thread owns the child process for its whole lifetime, so the
//! `std::process::Child` handle is never shared across threads. The tray talks
//! to that thread through an mpsc channel of [`Command`]s, each carrying an ack
//! back-channel so the caller (e.g. Quit) can block until the stop actually
//! completed before the app exits.
//!
//! ## Graceful stop (Windows can't signal a console Node)
//!
//! A2 established that `taskkill` without `/F` is refused for console apps and
//! `taskkill /F` skips the server's disposers. So we ask nicely first: write
//! `shutdown\n` to the child's stdin (the TS-side control channel, opt-in via
//! `MINDER_CONTROL_STDIN=1`, runs the same disposers as SIGINT) and close the
//! pipe, then wait ~6s. Only if the process is still alive after that grace
//! window do we escalate to `taskkill /F /T /PID` — killing the whole **process
//! tree**, mirroring `src/lib/processManager.ts`. We never kill by port.
//!
//! ## Attach mode
//!
//! When `MINDER_TRAY_ATTACH=1`, or when the port is already bound by a Minder
//! at startup, the supervisor observes only: it never spawns a second server
//! and never kills the existing one. Quit leaves that server untouched.

use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command as StdCommand, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, sync_channel, Receiver, RecvTimeoutError, Sender, SyncSender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use crate::config::{TrayConfig, HOST};
use crate::health::{self, ServerStatus};

/// How long to wait for a graceful stdin-driven shutdown before force-killing
/// the process tree. Comfortably above the server's 5s disposer budget.
const GRACEFUL_STOP_TIMEOUT: Duration = Duration::from_secs(6);
/// Base restart backoff after a crash; doubles up to [`MAX_BACKOFF`].
const BASE_BACKOFF: Duration = Duration::from_millis(500);
/// Cap on the exponential restart backoff.
const MAX_BACKOFF: Duration = Duration::from_secs(30);
/// A child that ran at least this long before crashing is treated as a fresh,
/// unrelated failure — reset the backoff instead of compounding it.
const HEALTHY_UPTIME_RESET: Duration = Duration::from_secs(30);
/// First delay before re-probing a port that is bound but hasn't answered yet.
/// Short, because the common case is a server a second or two from being ready.
const RECLASSIFY_BASE: Duration = Duration::from_secs(2);
/// Cap on the re-probe backoff. The loop never gives up (see
/// [`observe_until_shutdown`]) — it just stops asking so often.
const RECLASSIFY_MAX: Duration = Duration::from_secs(60);

/// Windows `CREATE_NO_WINDOW` process-creation flag. The tray is
/// `windows_subsystem = "windows"` (no console of its own), so a spawned
/// `node.exe` — or a `taskkill` — created with default flags would allocate and
/// flash a visible console window on every spawn/restart/stop. This suppresses
/// it. (0x08000000; see the Win32 process-creation-flags docs.)
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// How the supervisor relates to the server for this run — decided once at
/// startup and never changed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    /// We own the process: spawn it and keep it alive.
    Spawn,
    /// Something else owns it (or `MINDER_TRAY_ATTACH=1`): observe only.
    Attach,
}

enum Command {
    Restart(SyncSender<()>),
    Shutdown(SyncSender<()>),
}

/// Handle the tray holds to talk to the supervision thread.
pub struct Supervisor {
    tx: Mutex<Sender<Command>>,
    /// Runtime attach state — shared with the supervision thread so it can flip
    /// this to `true` if it switches to attach mode AFTER startup (e.g. a Phase
    /// A service binds the port while we're spawning; see the crash re-probe in
    /// [`run_supervisor`]). Read by the tray for the Status line / tooltip.
    attached: Arc<AtomicBool>,
    /// Best-effort human-readable note on the (possibly updated) attach
    /// decision, surfaced in the tray menu (e.g. "attached to existing service").
    attach_note: Arc<Mutex<Option<String>>>,
}

impl Supervisor {
    /// Decide the mode synchronously (so the tray can build its menu with the
    /// right enabled/disabled state), then spawn the supervision thread.
    pub fn start(
        cfg: TrayConfig,
        payload_dir: Option<PathBuf>,
        state_dir: Option<PathBuf>,
    ) -> Arc<Supervisor> {
        let attach_note = Arc::new(Mutex::new(None));
        let (mode, verdict) = decide_mode(&cfg, &attach_note);
        let attached = Arc::new(AtomicBool::new(mode == Mode::Attach));

        let (tx, rx) = channel::<Command>();
        let attached_thread = attached.clone();
        let note_thread = attach_note.clone();
        thread::Builder::new()
            .name("minder-supervisor".into())
            .spawn(move || {
                run_supervisor(
                    cfg,
                    payload_dir,
                    state_dir,
                    mode,
                    verdict,
                    rx,
                    attached_thread,
                    note_thread,
                )
            })
            .expect("failed to spawn supervisor thread");

        Arc::new(Supervisor {
            tx: Mutex::new(tx),
            attached,
            attach_note,
        })
    }

    pub fn is_attached(&self) -> bool {
        self.attached.load(Ordering::SeqCst)
    }

    pub fn attach_note(&self) -> Option<String> {
        self.attach_note.lock().ok().and_then(|n| n.clone())
    }

    /// Restart the spawned server (graceful stop → respawn). No-op in attach
    /// mode. Blocks until the restart has been initiated (bounded).
    pub fn restart(&self) {
        self.send_and_wait(Command::Restart);
    }

    /// Graceful stop of the spawned server (or a clean no-op in attach mode),
    /// then the supervision thread exits. Blocks until done (bounded) so the
    /// caller can `app.exit()` knowing no orphan child remains.
    pub fn shutdown(&self) {
        self.send_and_wait(Command::Shutdown);
    }

    fn send_and_wait(&self, make: impl FnOnce(SyncSender<()>) -> Command) {
        let (ack_tx, ack_rx) = sync_channel::<()>(1);
        let cmd = make(ack_tx);
        let sent = self
            .tx
            .lock()
            .ok()
            .map(|tx| tx.send(cmd).is_ok())
            .unwrap_or(false);
        if sent {
            // Bounded wait: graceful stop is <= 6s + force-kill; 12s is slack.
            let _ = ack_rx.recv_timeout(Duration::from_secs(12));
        }
    }
}

/// How settled our answer to "who owns this port?" is.
///
/// The distinction exists because a health probe that times out and a health
/// probe that gets a non-Minder answer used to collapse into the same verdict,
/// and they must not: see the `health` module header. `Pending` is the honest
/// third state for "the port is bound, but nobody has told us by whom yet".
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum AttachVerdict {
    /// A Minder server (healthy or degraded) answered.
    Minder,
    /// Something answered and it isn't Minder — a settled, proven verdict.
    Foreign,
    /// Port bound, nothing answered. Unknown — must keep asking.
    Pending,
}

/// Note shown while observing a port that has been released. Distinct from
/// every `AttachVerdict` note because it describes the *absence* of a listener
/// rather than a claim about who owns one.
const PENDING_UNBOUND_NOTE: &str = "port free — observing (server not running)";

impl AttachVerdict {
    /// The tray-menu note for this verdict. `Pending` deliberately does NOT say
    /// "foreign": we have no evidence for that, and claiming it is what made the
    /// old build slander its own still-booting service.
    fn note(self) -> &'static str {
        match self {
            AttachVerdict::Minder => "attached to existing service",
            AttachVerdict::Foreign => "port in use (foreign) — observing",
            AttachVerdict::Pending => "port bound, not responding — observing",
        }
    }
}

fn classify_attach(status: ServerStatus) -> AttachVerdict {
    if status.is_minder() {
        AttachVerdict::Minder
    } else if status.is_conclusive() {
        AttachVerdict::Foreign
    } else {
        AttachVerdict::Pending
    }
}

/// Decide spawn-vs-attach. Attach if explicitly requested, or if the port is
/// already bound at startup (whether by a Minder or a foreign process — either
/// way we must not spawn a second server and must not kill the incumbent).
///
/// Returns the verdict alongside the mode so the observe loop knows whether the
/// question is settled. An unsettled verdict is re-probed there rather than
/// being frozen into the tray menu for the life of the process.
fn decide_mode(
    cfg: &TrayConfig,
    attach_note: &Arc<Mutex<Option<String>>>,
) -> (Mode, AttachVerdict) {
    if cfg.attach {
        set_note(attach_note, "attach mode (MINDER_TRAY_ATTACH=1)");
        return (Mode::Attach, AttachVerdict::Minder);
    }
    if health::port_is_bound(cfg.port) {
        let status = health::probe(cfg.port);
        let verdict = classify_attach(status);
        set_note(attach_note, verdict.note());
        match verdict {
            AttachVerdict::Minder => log(&format!(
                "port {} already serving Minder ({status:?}) — attaching, not spawning",
                cfg.port
            )),
            AttachVerdict::Foreign => log(&format!(
                "port {} bound by a non-Minder process — observing, not spawning or killing",
                cfg.port
            )),
            AttachVerdict::Pending => log(&format!(
                "port {} is bound but did not answer /api/health in time — NOT calling it \
                 foreign; it is most likely our own server still starting up. Observing and \
                 re-probing.",
                cfg.port
            )),
        }
        return (Mode::Attach, verdict);
    }
    (Mode::Spawn, AttachVerdict::Pending)
}

fn set_note(note: &Arc<Mutex<Option<String>>>, msg: &str) {
    if let Ok(mut n) = note.lock() {
        *n = Some(msg.to_string());
    }
}

/// Reason the current child's supervise loop ended.
enum ExitReason {
    Crash,
    Restart(SyncSender<()>),
    Shutdown(SyncSender<()>),
    ChannelClosed,
}

fn run_supervisor(
    cfg: TrayConfig,
    payload_dir: Option<PathBuf>,
    state_dir: Option<PathBuf>,
    mode: Mode,
    verdict: AttachVerdict,
    rx: Receiver<Command>,
    attached: Arc<AtomicBool>,
    attach_note: Arc<Mutex<Option<String>>>,
) {
    log(&format!(
        "supervisor started in {mode:?} mode on :{}",
        cfg.port
    ));
    if mode == Mode::Attach {
        return observe_until_shutdown(&rx, &cfg, &attach_note, verdict);
    }

    let mut backoff = BASE_BACKOFF;
    loop {
        let started = Instant::now();
        let mut child = match spawn_child(&cfg, payload_dir.as_ref(), state_dir.as_ref()) {
            Ok(c) => c,
            Err(e) => {
                log(&format!("spawn failed: {e}; retrying in {backoff:?}"));
                if wait_backoff(&rx, backoff) {
                    return; // shutdown arrived during backoff
                }
                backoff = next_backoff(backoff);
                continue;
            }
        };
        let pid = child.id();
        let mut stdin = child.stdin.take();
        drain_output(&mut child);
        log(&format!("spawned minder-server pid={pid} on :{}", cfg.port));

        let reason = supervise(&mut child, &rx);
        match reason {
            ExitReason::Shutdown(ack) => {
                graceful_stop(&mut child, stdin.take(), pid);
                let _ = ack.send(());
                return;
            }
            ExitReason::ChannelClosed => {
                // Tray dropped the sender (app tearing down) — stop the child so
                // it isn't orphaned, then exit.
                graceful_stop(&mut child, stdin.take(), pid);
                return;
            }
            ExitReason::Restart(ack) => {
                graceful_stop(&mut child, stdin.take(), pid);
                let _ = ack.send(());
                backoff = BASE_BACKOFF; // intentional — respawn immediately
                continue;
            }
            ExitReason::Crash => {
                // Re-evaluate spawn-vs-attach before respawning. Something (most
                // likely the Phase A logon service) may have bound the port
                // between our startup check and now — our sidecar would then exit
                // with EADDRINUSE, and a blind backoff-respawn would hammer a
                // failing sidecar forever against a port a healthy Minder already
                // owns. Re-probing on EVERY crash (one cached-agent GET) makes
                // the invariant unconditional: the tray never keeps respawning
                // while another server holds the port.
                let bound = health::port_is_bound(cfg.port);
                let status = if bound {
                    health::probe(cfg.port)
                } else {
                    ServerStatus::Unreachable
                };
                match decide_after_crash(bound, status) {
                    CrashAction::AttachExisting => {
                        attached.store(true, Ordering::SeqCst);
                        set_note(
                            &attach_note,
                            "attached to existing service (detected after spawn conflict)",
                        );
                        log(&format!(
                            "port {} is now serving a healthy Minder ({status:?}) after our \
                             sidecar exited — switching to attach mode, no further restarts",
                            cfg.port
                        ));
                        return observe_until_shutdown(
                            &rx,
                            &cfg,
                            &attach_note,
                            AttachVerdict::Minder,
                        );
                    }
                    CrashAction::ObserveForeign => {
                        attached.store(true, Ordering::SeqCst);
                        set_note(
                            &attach_note,
                            "port in use (foreign) — observing after spawn conflict",
                        );
                        log(&format!(
                            "port {} is bound by a non-Minder process after our sidecar exited \
                             — observing, not respawning (would just conflict)",
                            cfg.port
                        ));
                        return observe_until_shutdown(
                            &rx,
                            &cfg,
                            &attach_note,
                            AttachVerdict::Foreign,
                        );
                    }
                    CrashAction::ObservePending => {
                        attached.store(true, Ordering::SeqCst);
                        set_note(&attach_note, AttachVerdict::Pending.note());
                        log(&format!(
                            "port {} was taken while our sidecar was starting (likely the \
                             logon service) and hasn't answered /api/health yet — observing \
                             and re-probing rather than assuming it's foreign",
                            cfg.port
                        ));
                        return observe_until_shutdown(
                            &rx,
                            &cfg,
                            &attach_note,
                            AttachVerdict::Pending,
                        );
                    }
                    CrashAction::Respawn => {
                        let uptime = started.elapsed();
                        if uptime >= HEALTHY_UPTIME_RESET {
                            backoff = BASE_BACKOFF;
                        }
                        log(&format!(
                            "minder-server pid={pid} exited after {uptime:?}; restarting in \
                             {backoff:?}"
                        ));
                        if wait_backoff(&rx, backoff) {
                            return;
                        }
                        backoff = next_backoff(backoff);
                        continue;
                    }
                }
            }
        }
    }
}

/// What a single re-probe tick observed about the port.
///
/// Split from the verdict itself because "nobody is listening" and "somebody
/// answered like this" are different kinds of fact, and [`next_verdict`] treats
/// them differently.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Observation {
    /// The port is no longer bound by anyone.
    Unbound,
    /// Something holds the port; this is how it answered (or failed to).
    Probed(ServerStatus),
}

/// The verdict to hold after a re-probe tick — pure, so the two rules below are
/// testable without a live server.
///
/// 1. **A released port voids whatever we concluded about its previous holder.**
///    The verdict describes *who owns the port*, not the port, so once nobody
///    owns it the answer is unknown again and the next process to bind it is a
///    fresh question.
/// 2. **An inconclusive probe never downgrades a conclusive verdict.** This is
///    the mirror of the rule in [`crate::health`]: a timeout is not evidence of
///    foreignness, and equally it is not evidence *against* a foreignness we
///    already proved. Only an actual answer can overturn an actual answer.
fn next_verdict(current: AttachVerdict, observation: Observation) -> AttachVerdict {
    match observation {
        Observation::Unbound => AttachVerdict::Pending,
        Observation::Probed(status) => match classify_attach(status) {
            AttachVerdict::Pending => current,
            observed => observed,
        },
    }
}

/// How long to wait before re-probing, given the verdict currently on display.
/// `None` means the question is settled for good and the observe loop may block
/// indefinitely on the command channel.
///
/// `Foreign` re-probes — slowly, at the cap — because "foreign" is a fact about
/// who holds the port *right now*, not a property of the port. The foreign
/// server can exit and Minder can take its place, and a verdict that never asks
/// again leaves the tray showing "port in use (foreign) — observing" beside a
/// status line reading "running": the same self-contradicting pair that the
/// `Pending` state was introduced to remove, one path over. Polling at
/// [`RECLASSIFY_MAX`] bounds that disagreement to a minute instead of the life
/// of the process, at one cheap loopback probe a minute.
///
/// `Minder` deliberately does **not** re-probe. It is the steady state of every
/// ordinary attach; blocking there costs zero wakeups, and a stale "attached to
/// existing service" is at worst out of date. It is never an accusation against
/// our own server, which is the failure this whole mechanism exists to prevent.
fn reprobe_interval(verdict: AttachVerdict, pending_delay: Duration) -> Option<Duration> {
    match verdict {
        AttachVerdict::Pending => Some(pending_delay),
        AttachVerdict::Foreign => Some(RECLASSIFY_MAX),
        AttachVerdict::Minder => None,
    }
}

/// Observe-only loop: wait for a shutdown command and never touch the server.
/// Used for a startup attach and after a post-crash attach switch alike.
///
/// While the verdict is anything other than [`AttachVerdict::Minder`] the loop
/// also re-probes the port on the cadence [`reprobe_interval`] gives, updating
/// the tray note in place as the answer changes.
///
/// **The re-probe has no expiry.** An earlier design let a grace period lapse
/// and then declared "foreign", which just moved the original bug down a layer:
/// a server slower than the grace window would be permanently mislabelled, with
/// no way back short of restarting the tray. Waiting longer is free; being
/// confidently wrong is not. The backoff only makes us ask less often, never
/// stop.
fn observe_until_shutdown(
    rx: &Receiver<Command>,
    cfg: &TrayConfig,
    attach_note: &Arc<Mutex<Option<String>>>,
    verdict: AttachVerdict,
) {
    let mut verdict = verdict;
    let mut delay = RECLASSIFY_BASE;
    // Whether the note currently describes an *unbound* port rather than a
    // claim about who owns one. Tracked as state rather than by comparing note
    // strings, so the richer notes the post-crash paths set ("…after spawn
    // conflict") survive until the verdict itself actually changes.
    let mut unbound = false;
    loop {
        // A settled `Minder` has nothing left to ask, so block indefinitely —
        // identical to the pre-existing behavior and free of wakeups.
        let cmd = match reprobe_interval(verdict, delay) {
            Some(wait) => match rx.recv_timeout(wait) {
                Ok(cmd) => Some(cmd),
                Err(RecvTimeoutError::Timeout) => None,
                Err(RecvTimeoutError::Disconnected) => return,
            },
            None => match rx.recv() {
                Ok(cmd) => Some(cmd),
                Err(_) => return,
            },
        };

        match cmd {
            Some(Command::Shutdown(ack)) => {
                log("observe mode: quit requested — leaving the existing server untouched");
                let _ = ack.send(());
                return;
            }
            Some(Command::Restart(ack)) => {
                log("observe mode: restart requested — ignored (not our process)");
                let _ = ack.send(());
            }
            // Re-probe tick.
            None => {
                // A port that has since been released is still not ours to take:
                // this loop is entered only after we've decided not to own the
                // server, and respawning here would race whoever is restarting
                // it. Keep observing — but say so, because "port bound, not
                // responding" describes a port that is no longer bound, and
                // leaving it up is the same stale-note bug in miniature.
                if !health::port_is_bound(cfg.port) {
                    if unbound {
                        delay = next_reclassify_delay(delay);
                    } else {
                        set_note(attach_note, PENDING_UNBOUND_NOTE);
                        log(&format!(
                            "port {} is no longer bound — the server we were observing has \
                             stopped; still not respawning (not our process), still watching",
                            cfg.port
                        ));
                        unbound = true;
                        verdict = next_verdict(verdict, Observation::Unbound);
                        // The delay may be parked at the Foreign cap, and the
                        // next process to bind this port deserves a prompt
                        // answer rather than up to a minute of silence.
                        delay = RECLASSIFY_BASE;
                    }
                    continue;
                }
                // Bound again after a gap: restore the "bound but silent" note
                // before we know any more than that.
                if unbound {
                    set_note(attach_note, AttachVerdict::Pending.note());
                    unbound = false;
                    delay = RECLASSIFY_BASE;
                }
                let status = health::probe(cfg.port);
                let settled = next_verdict(verdict, Observation::Probed(status));
                if settled == verdict {
                    // No new information — ask again later, less often.
                    delay = next_reclassify_delay(delay);
                    continue;
                }
                set_note(attach_note, settled.note());
                match (verdict, settled) {
                    (AttachVerdict::Foreign, AttachVerdict::Minder) => log(&format!(
                        "port {} is now serving Minder ({status:?}) — whatever foreign process \
                         held it has gone; now attached",
                        cfg.port
                    )),
                    (_, AttachVerdict::Minder) => log(&format!(
                        "port {} answered /api/health ({status:?}) after all — it is Minder, \
                         not a foreign process; now attached",
                        cfg.port
                    )),
                    (_, AttachVerdict::Foreign) => log(&format!(
                        "port {} answered with a non-Minder response — confirmed foreign, \
                         observing",
                        cfg.port
                    )),
                    // `next_verdict` only yields `Pending` for an unbound port
                    // (handled above) or when it was already the current
                    // verdict (equal, so returned above).
                    (_, AttachVerdict::Pending) => {
                        unreachable!("Pending never replaces a different verdict")
                    }
                }
                verdict = settled;
            }
        }
    }
}

/// Exponential backoff for the re-probe tick, capped at [`RECLASSIFY_MAX`].
fn next_reclassify_delay(current: Duration) -> Duration {
    std::cmp::min(current.saturating_mul(2), RECLASSIFY_MAX)
}

/// What to do after the supervised sidecar exits, based on a fresh probe of the
/// port. Pure so the mode-transition logic is unit-testable without a live
/// server (the full spawn-conflict race is hard to reproduce deterministically).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CrashAction {
    /// Port is free — normal backoff restart.
    Respawn,
    /// A healthy/degraded Minder now holds the port — attach and observe.
    AttachExisting,
    /// A non-Minder process holds the port — observe without respawn-hammering.
    ObserveForeign,
    /// Port is held by something that hasn't answered yet — observe and keep
    /// re-probing. This is the EADDRINUSE case at logon: our sidecar loses the
    /// race to the Phase A service, which is then mid-bootstrap and cannot
    /// answer a health probe, so treating "no answer" as "foreign" here would
    /// mislabel the very service that just beat us to the port.
    ObservePending,
}

fn decide_after_crash(port_bound: bool, status: ServerStatus) -> CrashAction {
    if !port_bound {
        return CrashAction::Respawn;
    }
    match classify_attach(status) {
        AttachVerdict::Minder => CrashAction::AttachExisting,
        AttachVerdict::Foreign => CrashAction::ObserveForeign,
        AttachVerdict::Pending => CrashAction::ObservePending,
    }
}

/// Wait on the command channel and the child concurrently until one ends the
/// loop. A single blocking `recv_timeout` handles commands immediately when
/// they arrive and, on each 200ms timeout tick, checks whether the child exited
/// on its own — same crash-detection latency as a poll loop, one blocking
/// primitive instead of a busy-poll (mirrors `wait_backoff`).
fn supervise(child: &mut Child, rx: &Receiver<Command>) -> ExitReason {
    loop {
        match rx.recv_timeout(Duration::from_millis(200)) {
            Ok(Command::Shutdown(ack)) => return ExitReason::Shutdown(ack),
            Ok(Command::Restart(ack)) => return ExitReason::Restart(ack),
            Err(RecvTimeoutError::Disconnected) => return ExitReason::ChannelClosed,
            Err(RecvTimeoutError::Timeout) => {}
        }
        match child.try_wait() {
            Ok(Some(_status)) => return ExitReason::Crash,
            Ok(None) => {}
            Err(_) => return ExitReason::Crash,
        }
    }
}

fn spawn_child(
    cfg: &TrayConfig,
    payload_dir: Option<&PathBuf>,
    state_dir: Option<&PathBuf>,
) -> Result<Child, String> {
    let dir = payload_dir.ok_or_else(|| {
        "no payload directory: set MINDER_SERVER_DIST (dev) or bundle minder-server as a resource"
            .to_string()
    })?;

    // Canonicalize the payload dir to an ABSOLUTE path up front. MINDER_SERVER_DIST
    // may be relative to the tray's cwd, but we spawn the child with
    // current_dir(dir); a still-relative `server.js` argument would then resolve
    // against the child's own cwd (dir/server.js interpreted as dir/dir/server.js)
    // and the sidecar would crash-loop with "cannot find module". Resolving both
    // the dir and the server.js path to absolute up front removes any cwd
    // dependence, and canonicalize also fails loudly here if the dir doesn't
    // exist. The `\\?\` prefix it emits on Windows is then stripped — Node
    // mis-resolves verbatim paths (it rewrites `\\?\C:\…\server.js` to
    // `C:\?\C:\…\server.js` and fails), verified in the tray E2E.
    let canonical_dir = strip_windows_verbatim(std::fs::canonicalize(dir).map_err(|e| {
        format!(
            "payload dir {} does not resolve ({e}) — set MINDER_SERVER_DIST to a valid \
             dist/minder-server (dev) or bundle it as a resource",
            dir.display()
        )
    })?);
    let server_js = canonical_dir.join("server.js");
    if !server_js.exists() {
        return Err(format!(
            "server.js not found at {} — run `pnpm build && pnpm package:standalone`",
            server_js.display()
        ));
    }

    let mut cmd = StdCommand::new(&cfg.node_path);
    cmd.arg(&server_js)
        .current_dir(&canonical_dir)
        .env("PORT", cfg.port.to_string())
        .env("HOSTNAME", HOST)
        // The tray always drives shutdown over stdin (Windows can't signal a
        // console Node) — the TS control channel activates only with this set.
        .env("MINDER_CONTROL_STDIN", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    // Point the sidecar's writable state (`.minder.json` + caches) at a stable,
    // user-writable dir that survives upgrades — NOT the bundle the server
    // chdirs into. Forward an explicit MINDER_STATE_DIR (operator override) if
    // one is already in our env; otherwise default it to ~/.minder. Create the
    // dir first: writeFileAtomic on the TS side does not mkdir its parent.
    match std::env::var("MINDER_STATE_DIR") {
        Ok(existing) if !existing.trim().is_empty() => {
            // Same guarantee as the resolved-default branch below: the sidecar's
            // atomic writes need the directory to exist before first use.
            let _ = std::fs::create_dir_all(existing.trim());
            log(&format!(
                "sidecar state dir: inherited MINDER_STATE_DIR={existing}"
            ));
        }
        _ => match state_dir {
            Some(sd) => {
                let _ = std::fs::create_dir_all(sd);
                cmd.env("MINDER_STATE_DIR", sd);
                log(&format!("sidecar state dir: {}", sd.display()));
            }
            None => log(
                "warning: no state dir resolved (home_dir unavailable) — sidecar \
                 state would fall back to its cwd",
            ),
        },
    }

    // On Unix, put the child in its OWN process group (pgid = child pid) so
    // kill_tree's negative-PID signal (`kill -KILL -<pid>`) reaches the child
    // AND its descendants — without this the child stays in the tray's group,
    // so the negative-PID kill would either no-op or, worse, target the tray's
    // own group. Windows has no equivalent here; it uses `taskkill /F /T` on the
    // PID (the same platform split noted in src/lib/processManager.ts).
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // No flashed/allocated console for the sidecar (see CREATE_NO_WINDOW).
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    cmd.spawn()
        .map_err(|e| format!("failed to launch `{}`: {e}", cfg.node_path))
}

/// Strip the Windows `\\?\` extended-length (verbatim) prefix that
/// `fs::canonicalize` emits, leaving a plain drive-absolute path. Node
/// mis-resolves verbatim paths (rewrites `\\?\C:\…` to `C:\?\C:\…`), so the
/// sidecar's `server.js` argument and cwd must be the plain form. Only the
/// simple `\\?\C:\…` form is stripped; a `\\?\UNC\…` verbatim UNC path is left
/// intact (stripping it would corrupt the UNC form). No-op on non-Windows.
fn strip_windows_verbatim(p: PathBuf) -> PathBuf {
    #[cfg(windows)]
    if let Some(rest) = p.to_str().and_then(|s| s.strip_prefix(r"\\?\")) {
        if !rest.starts_with("UNC\\") {
            return PathBuf::from(rest);
        }
    }
    p
}

/// Drain the child's stdout/stderr on background threads so its pipe buffers
/// never fill and block it. Lines are forwarded with a prefix (visible in a dev
/// console; harmless when the release build has no console).
fn drain_output(child: &mut Child) {
    if let Some(out) = child.stdout.take() {
        thread::spawn(move || {
            for line in BufReader::new(out).lines().map_while(Result::ok) {
                println!("[minder-server] {line}");
            }
        });
    }
    if let Some(err) = child.stderr.take() {
        thread::spawn(move || {
            for line in BufReader::new(err).lines().map_while(Result::ok) {
                eprintln!("[minder-server] {line}");
            }
        });
    }
}

/// Ask the child to stop cleanly over stdin, wait up to [`GRACEFUL_STOP_TIMEOUT`],
/// then force-kill the whole process tree if it hasn't exited.
fn graceful_stop(child: &mut Child, stdin: Option<ChildStdin>, pid: u32) {
    if let Some(mut si) = stdin {
        let _ = si.write_all(b"shutdown\n");
        let _ = si.flush();
        // Dropping `si` here also closes the pipe → EOF, a second graceful
        // trigger on the TS side if the line somehow didn't land.
    }

    let deadline = Instant::now() + GRACEFUL_STOP_TIMEOUT;
    loop {
        if let Ok(Some(_)) = child.try_wait() {
            log(&format!("pid={pid} stopped gracefully"));
            return;
        }
        if Instant::now() >= deadline {
            break;
        }
        thread::sleep(Duration::from_millis(150));
    }

    log(&format!(
        "pid={pid} did not stop within {GRACEFUL_STOP_TIMEOUT:?} — force-killing the process tree"
    ));
    kill_tree(pid);
    let _ = child.wait();
}

/// Force-kill a process and all its descendants. Mirrors
/// `src/lib/processManager.ts`'s `taskkill /F /T` on Windows.
fn kill_tree(pid: u32) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let _ = StdCommand::new("taskkill")
            .args(["/F", "/T", "/PID", &pid.to_string()])
            // No flashed console window for the taskkill helper either.
            .creation_flags(CREATE_NO_WINDOW)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    #[cfg(not(windows))]
    {
        // The child was spawned as its own process-group leader (see
        // spawn_child's `process_group(0)`), so `pgid == pid` and the negative
        // PID targets the child plus every descendant. Fall back to a
        // direct-PID kill as secondary in case the group signal doesn't land.
        let _ = StdCommand::new("kill")
            .args(["-KILL", &format!("-{pid}")])
            .status();
        let _ = StdCommand::new("kill")
            .args(["-KILL", &pid.to_string()])
            .status();
    }
}

fn next_backoff(current: Duration) -> Duration {
    std::cmp::min(current * 2, MAX_BACKOFF)
}

/// Sleep for `backoff`, but wake early and return `true` if a Shutdown/close
/// arrives so we don't respawn into a quit. Restart during backoff is treated
/// as "respawn now" (returns false, ack sent).
fn wait_backoff(rx: &Receiver<Command>, backoff: Duration) -> bool {
    let deadline = Instant::now() + backoff;
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return false;
        }
        match rx.recv_timeout(std::cmp::min(remaining, Duration::from_millis(200))) {
            Ok(Command::Shutdown(ack)) => {
                let _ = ack.send(());
                return true;
            }
            Ok(Command::Restart(ack)) => {
                let _ = ack.send(());
                return false; // fall through to respawn now
            }
            Err(_) => {} // timeout tick — keep waiting
        }
    }
}

/// Structured-ish stdout log line for the tray (visible in a dev console; a
/// no-op sink on the release `windows_subsystem = "windows"` build). Shared so
/// every corner of the app uses the one `[minder-tray]` prefix.
pub(crate) fn log(msg: &str) {
    println!("[minder-tray] {msg}");
}

/// Compile/test-time tethers to the TypeScript side of the shutdown handshake.
/// `include_str!` paths resolve relative to THIS source file and only compile
/// in-repo (never in the packaged binary), so they cost nothing at runtime and
/// don't affect packaging — but a drift on either side of the process boundary
/// that would silently break graceful shutdown fails `cargo test`.
#[cfg(test)]
mod contract_tests {
    use super::GRACEFUL_STOP_TIMEOUT;

    const LIFECYCLE_TS: &str = include_str!("../../src/lib/lifecycle.ts");
    const CONTROL_CHANNEL_TS: &str = include_str!("../../src/lib/controlChannel.ts");

    /// Loosely extract the integer literal (underscores allowed, e.g. `5_000`)
    /// assigned to `name` in TS source.
    fn ts_const_number(src: &str, name: &str) -> Option<u64> {
        let after = &src[src.find(name)? + name.len()..];
        let after_eq = &after[after.find('=')? + 1..];
        let digits: String = after_eq
            .chars()
            .skip_while(|c| c.is_whitespace())
            .take_while(|c| c.is_ascii_digit() || *c == '_')
            .filter(|c| *c != '_')
            .collect();
        digits.parse().ok()
    }

    // Tether 12a: the Rust force-kill grace window must exceed the TS disposer
    // budget, or raising SHUTDOWN_TIMEOUT_MS would let the tray taskkill a
    // server mid-shutdown. Bumping the TS budget past 6s without bumping
    // GRACEFUL_STOP_TIMEOUT fails here.
    #[test]
    fn graceful_stop_window_exceeds_ts_disposer_budget() {
        let budget_ms = ts_const_number(LIFECYCLE_TS, "SHUTDOWN_TIMEOUT_MS")
            .expect("lifecycle.ts must define SHUTDOWN_TIMEOUT_MS = <number>");
        assert!(
            (GRACEFUL_STOP_TIMEOUT.as_millis() as u64) > budget_ms,
            "GRACEFUL_STOP_TIMEOUT ({}ms) must exceed the TS disposer budget \
             SHUTDOWN_TIMEOUT_MS ({budget_ms}ms) so a clean shutdown isn't force-killed \
             mid-disposer",
            GRACEFUL_STOP_TIMEOUT.as_millis()
        );
    }

    // Tether 12b: the byte string the supervisor writes (`shutdown\n`) must match
    // the command the TS control channel recognizes. A rename on either side
    // fails here.
    #[test]
    fn shutdown_command_string_matches_ts() {
        assert!(
            CONTROL_CHANNEL_TS.contains(r#"CONTROL_SHUTDOWN_COMMAND = "shutdown""#),
            "controlChannel.ts must define CONTROL_SHUTDOWN_COMMAND = \"shutdown\" to match \
             the bytes graceful_stop() writes to the child's stdin"
        );
    }
}

#[cfg(test)]
mod crash_decision_tests {
    use super::{classify_attach, decide_after_crash, AttachVerdict, CrashAction};
    use crate::health::ServerStatus;

    #[test]
    fn free_port_respawns() {
        // Port not bound after the crash → the sidecar just crashed; restart.
        assert_eq!(
            decide_after_crash(false, ServerStatus::Unreachable),
            CrashAction::Respawn
        );
    }

    #[test]
    fn free_port_respawns_regardless_of_status() {
        // `port_bound` short-circuits: an unbound port is ours to retake even if
        // a stale status says otherwise.
        for status in [
            ServerStatus::Up,
            ServerStatus::Degraded,
            ServerStatus::Foreign,
            ServerStatus::Unreachable,
        ] {
            assert_eq!(decide_after_crash(false, status), CrashAction::Respawn);
        }
    }

    #[test]
    fn healthy_minder_holding_port_attaches() {
        // Phase A service bound the port and answers healthy → attach, stop
        // respawning (this is the EADDRINUSE race the review flagged).
        assert_eq!(
            decide_after_crash(true, ServerStatus::Up),
            CrashAction::AttachExisting
        );
    }

    #[test]
    fn degraded_minder_holding_port_attaches() {
        assert_eq!(
            decide_after_crash(true, ServerStatus::Degraded),
            CrashAction::AttachExisting
        );
    }

    #[test]
    fn foreign_process_holding_port_observes() {
        // Something ANSWERED and it wasn't Minder → proven foreign. Observe,
        // don't respawn-hammer.
        assert_eq!(
            decide_after_crash(true, ServerStatus::Foreign),
            CrashAction::ObserveForeign
        );
    }

    #[test]
    fn unreachable_holder_is_pending_not_foreign() {
        // The regression this split exists to prevent. Our sidecar lost the
        // EADDRINUSE race to the logon service, which is now mid-bootstrap and
        // can't answer a health probe. Calling that "foreign" mislabels our own
        // server; the only honest verdict is "don't know yet — keep asking".
        assert_eq!(
            decide_after_crash(true, ServerStatus::Unreachable),
            CrashAction::ObservePending
        );
    }

    #[test]
    fn classify_attach_maps_every_status() {
        assert_eq!(classify_attach(ServerStatus::Up), AttachVerdict::Minder);
        assert_eq!(
            classify_attach(ServerStatus::Degraded),
            AttachVerdict::Minder
        );
        assert_eq!(
            classify_attach(ServerStatus::Foreign),
            AttachVerdict::Foreign
        );
        assert_eq!(
            classify_attach(ServerStatus::Unreachable),
            AttachVerdict::Pending
        );
    }

    #[test]
    fn pending_note_does_not_claim_foreign() {
        // The user-visible half of the bug: the old build told the user its own
        // booting server was a foreign process. Whatever this string becomes, it
        // must not assert something a timeout cannot prove.
        let note = AttachVerdict::Pending.note();
        assert!(
            !note.contains("foreign"),
            "pending note must not claim foreignness, got: {note:?}"
        );
        assert!(
            AttachVerdict::Foreign.note().contains("foreign"),
            "the proven-foreign note should still say so"
        );
    }

    #[test]
    fn the_unbound_note_describes_absence_not_ownership() {
        use super::PENDING_UNBOUND_NOTE;
        // While observing, a port can be released under us. Leaving up
        // "port bound, not responding" would describe a port that is no longer
        // bound — the same stale-note failure this PR exists to remove, just
        // smaller. It must also not claim foreignness, having proved nothing.
        assert_ne!(PENDING_UNBOUND_NOTE, AttachVerdict::Pending.note());
        assert!(!PENDING_UNBOUND_NOTE.contains("foreign"));
        assert!(
            !PENDING_UNBOUND_NOTE.contains("bound,"),
            "the unbound note must not assert the port is bound, got: {PENDING_UNBOUND_NOTE:?}"
        );
    }

    #[test]
    fn reclassify_backoff_grows_and_caps() {
        use super::{next_reclassify_delay, RECLASSIFY_BASE, RECLASSIFY_MAX};
        let mut d = RECLASSIFY_BASE;
        for _ in 0..20 {
            let next = next_reclassify_delay(d);
            assert!(next >= d, "backoff must be monotonic");
            assert!(next <= RECLASSIFY_MAX, "backoff must stay capped");
            d = next;
        }
        assert_eq!(d, RECLASSIFY_MAX, "backoff should reach the cap");
    }

    /// The residual this rework closes: a proven-`Foreign` verdict used to end
    /// the re-probing for the life of the tray process, so a foreign server
    /// that later exited and was replaced by Minder left the note reading
    /// "port in use (foreign) — observing" beside a status line reading
    /// "running". `Foreign` must keep asking.
    #[test]
    fn a_settled_foreign_verdict_keeps_re_probing() {
        use super::{reprobe_interval, RECLASSIFY_BASE, RECLASSIFY_MAX};
        assert_eq!(
            reprobe_interval(AttachVerdict::Foreign, RECLASSIFY_BASE),
            Some(RECLASSIFY_MAX),
            "Foreign must re-probe — slowly, but it must not latch"
        );
    }

    /// …and it does so at the slow end only. The fast backoff belongs to
    /// `Pending`, where an answer is expected imminently; `Foreign` has an
    /// answer already and is only watching for it to stop being true.
    #[test]
    fn foreign_re_probes_at_the_cap_not_the_pending_backoff() {
        use super::{reprobe_interval, RECLASSIFY_BASE, RECLASSIFY_MAX};
        assert_ne!(RECLASSIFY_BASE, RECLASSIFY_MAX, "test would be vacuous");
        assert_eq!(
            reprobe_interval(AttachVerdict::Pending, RECLASSIFY_BASE),
            Some(RECLASSIFY_BASE),
            "Pending re-probes on its own backoff"
        );
        assert_eq!(
            reprobe_interval(AttachVerdict::Foreign, RECLASSIFY_BASE),
            Some(RECLASSIFY_MAX),
            "Foreign ignores the fast backoff even when it is passed one"
        );
    }

    /// `Minder` is the deliberate exception: the steady state of every ordinary
    /// attach blocks forever on the command channel, costing zero wakeups.
    #[test]
    fn an_attached_minder_blocks_instead_of_polling() {
        use super::{reprobe_interval, RECLASSIFY_BASE};
        assert_eq!(reprobe_interval(AttachVerdict::Minder, RECLASSIFY_BASE), None);
    }

    /// A released port voids whatever we had proved about its previous holder —
    /// the verdict is a claim about an owner, and that owner is gone. Without
    /// this, a foreign process exiting would leave `Foreign` in place to be
    /// re-applied to whoever binds the port next.
    #[test]
    fn an_unbound_port_voids_every_settled_verdict() {
        use super::{next_verdict, Observation};
        for current in [
            AttachVerdict::Minder,
            AttachVerdict::Foreign,
            AttachVerdict::Pending,
        ] {
            assert_eq!(
                next_verdict(current, Observation::Unbound),
                AttachVerdict::Pending,
                "{current:?} must revert to Pending once nobody holds the port"
            );
        }
    }

    /// The mirror of `health`'s rule. A timeout is not evidence of foreignness;
    /// equally it is not evidence against a foreignness already proved. Only an
    /// answer can overturn an answer — otherwise one slow response would flip a
    /// settled verdict back to "not responding" and churn the tray note.
    #[test]
    fn an_inconclusive_probe_never_downgrades_a_settled_verdict() {
        use super::{next_verdict, Observation};
        for current in [AttachVerdict::Minder, AttachVerdict::Foreign] {
            assert_eq!(
                next_verdict(current, Observation::Probed(ServerStatus::Unreachable)),
                current,
                "{current:?} must survive a probe that told us nothing"
            );
        }
    }

    /// The fix's payload: a foreign holder replaced by Minder is noticed, and
    /// the note stops accusing our own server.
    #[test]
    fn a_conclusive_answer_does_overturn_a_settled_verdict() {
        use super::{next_verdict, Observation};
        for status in [ServerStatus::Up, ServerStatus::Degraded] {
            assert_eq!(
                next_verdict(AttachVerdict::Foreign, Observation::Probed(status)),
                AttachVerdict::Minder,
                "a Minder answering on a port we had called foreign must re-attach"
            );
        }
        assert_eq!(
            next_verdict(
                AttachVerdict::Pending,
                Observation::Probed(ServerStatus::Foreign)
            ),
            AttachVerdict::Foreign,
            "and an unknown holder that answers as non-Minder still settles"
        );
    }

    /// Every note the observe loop can display must describe what it actually
    /// knows. `Pending` claiming foreignness is the original bug; the unbound
    /// note claiming an owner would be the same bug on a port with none.
    #[test]
    fn no_polling_verdict_outlives_the_evidence_for_it() {
        use super::{next_verdict, reprobe_interval, Observation, RECLASSIFY_BASE};
        // Anything the loop still polls is, by definition, revisable — so no
        // note it shows can be permanent. Only Minder is allowed to be final.
        for verdict in [AttachVerdict::Pending, AttachVerdict::Foreign] {
            assert!(
                reprobe_interval(verdict, RECLASSIFY_BASE).is_some(),
                "{verdict:?} must remain open to revision"
            );
            assert_eq!(
                next_verdict(verdict, Observation::Probed(ServerStatus::Up)),
                AttachVerdict::Minder,
                "{verdict:?} must yield to a Minder that answers"
            );
        }
    }
}

#[cfg(all(test, windows))]
mod verbatim_path_tests {
    use super::strip_windows_verbatim;
    use std::path::PathBuf;

    #[test]
    fn strips_simple_verbatim_drive_prefix() {
        // Node mis-resolves `\\?\C:\…`; the plain drive form is what it accepts.
        let p = PathBuf::from(r"\\?\C:\dev\minder\dist\minder-server");
        assert_eq!(
            strip_windows_verbatim(p),
            PathBuf::from(r"C:\dev\minder\dist\minder-server")
        );
    }

    #[test]
    fn leaves_verbatim_unc_intact() {
        let p = PathBuf::from(r"\\?\UNC\server\share\x");
        assert_eq!(strip_windows_verbatim(p.clone()), p);
    }

    #[test]
    fn leaves_a_plain_path_unchanged() {
        let p = PathBuf::from(r"C:\dev\minder");
        assert_eq!(strip_windows_verbatim(p.clone()), p);
    }
}
