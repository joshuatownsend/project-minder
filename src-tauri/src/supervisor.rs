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
    pub fn start(cfg: TrayConfig, payload_dir: Option<PathBuf>) -> Arc<Supervisor> {
        let attach_note = Arc::new(Mutex::new(None));
        let mode = decide_mode(&cfg, &attach_note);
        let attached = Arc::new(AtomicBool::new(mode == Mode::Attach));

        let (tx, rx) = channel::<Command>();
        let attached_thread = attached.clone();
        let note_thread = attach_note.clone();
        thread::Builder::new()
            .name("minder-supervisor".into())
            .spawn(move || run_supervisor(cfg, payload_dir, mode, rx, attached_thread, note_thread))
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

/// Decide spawn-vs-attach. Attach if explicitly requested, or if the port is
/// already bound at startup (whether by a Minder or a foreign process — either
/// way we must not spawn a second server and must not kill the incumbent).
fn decide_mode(cfg: &TrayConfig, attach_note: &Arc<Mutex<Option<String>>>) -> Mode {
    if cfg.attach {
        set_note(attach_note, "attach mode (MINDER_TRAY_ATTACH=1)");
        return Mode::Attach;
    }
    if health::port_is_bound(cfg.port) {
        let status = health::probe(cfg.port);
        if status.is_minder() {
            set_note(attach_note, "attached to existing service");
            log(&format!(
                "port {} already serving Minder ({status:?}) — attaching, not spawning",
                cfg.port
            ));
        } else {
            set_note(attach_note, "port in use (foreign) — observing");
            log(&format!(
                "port {} bound by a non-Minder process — observing, not spawning or killing",
                cfg.port
            ));
        }
        return Mode::Attach;
    }
    Mode::Spawn
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
    mode: Mode,
    rx: Receiver<Command>,
    attached: Arc<AtomicBool>,
    attach_note: Arc<Mutex<Option<String>>>,
) {
    log(&format!(
        "supervisor started in {mode:?} mode on :{}",
        cfg.port
    ));
    if mode == Mode::Attach {
        return observe_until_shutdown(&rx);
    }

    let mut backoff = BASE_BACKOFF;
    loop {
        let started = Instant::now();
        let mut child = match spawn_child(&cfg, payload_dir.as_ref()) {
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
                    ServerStatus::Down
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
                        return observe_until_shutdown(&rx);
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
                        return observe_until_shutdown(&rx);
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

/// Observe-only loop: wait for a shutdown command and never touch the server.
/// Used for a startup attach and after a post-crash attach switch alike.
fn observe_until_shutdown(rx: &Receiver<Command>) {
    loop {
        match rx.recv() {
            Ok(Command::Shutdown(ack)) => {
                log("observe mode: quit requested — leaving the existing server untouched");
                let _ = ack.send(());
                return;
            }
            Ok(Command::Restart(ack)) => {
                log("observe mode: restart requested — ignored (not our process)");
                let _ = ack.send(());
            }
            Err(_) => return,
        }
    }
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
}

fn decide_after_crash(port_bound: bool, status: ServerStatus) -> CrashAction {
    if !port_bound {
        CrashAction::Respawn
    } else if status.is_minder() {
        CrashAction::AttachExisting
    } else {
        CrashAction::ObserveForeign
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

fn spawn_child(cfg: &TrayConfig, payload_dir: Option<&PathBuf>) -> Result<Child, String> {
    let dir = payload_dir.ok_or_else(|| {
        "no payload directory: set MINDER_SERVER_DIST (dev) or bundle minder-server as a resource"
            .to_string()
    })?;
    let server_js = dir.join("server.js");
    if !server_js.exists() {
        return Err(format!(
            "server.js not found at {} — run `pnpm build && pnpm package:standalone`",
            server_js.display()
        ));
    }

    let mut cmd = StdCommand::new(&cfg.node_path);
    cmd.arg(&server_js)
        .current_dir(dir)
        .env("PORT", cfg.port.to_string())
        .env("HOSTNAME", HOST)
        // The tray always drives shutdown over stdin (Windows can't signal a
        // console Node) — the TS control channel activates only with this set.
        .env("MINDER_CONTROL_STDIN", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

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
    use super::{decide_after_crash, CrashAction};
    use crate::health::ServerStatus;

    #[test]
    fn free_port_respawns() {
        // Port not bound after the crash → the sidecar just crashed; restart.
        assert_eq!(
            decide_after_crash(false, ServerStatus::Down),
            CrashAction::Respawn
        );
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
        // Bound but the probe can't confirm Minder → observe, don't respawn-hammer.
        assert_eq!(
            decide_after_crash(true, ServerStatus::Down),
            CrashAction::ObserveForeign
        );
    }
}
