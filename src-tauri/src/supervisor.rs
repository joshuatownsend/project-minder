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
use std::sync::mpsc::{channel, sync_channel, Receiver, Sender, SyncSender, TryRecvError};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use crate::config::{TrayConfig, HOST};
use crate::health;

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
    mode: Mode,
    /// Best-effort human-readable note on the startup decision, surfaced in the
    /// tray menu (e.g. "attached to existing service").
    attach_note: Arc<Mutex<Option<String>>>,
    // Kept alive for the lifetime of the supervisor so the thread isn't detached
    // into oblivion on drop; the thread also exits on Shutdown.
    _running: Arc<AtomicBool>,
}

impl Supervisor {
    /// Decide the mode synchronously (so the tray can build its menu with the
    /// right enabled/disabled state), then spawn the supervision thread.
    pub fn start(cfg: TrayConfig, payload_dir: Option<PathBuf>) -> Arc<Supervisor> {
        let attach_note = Arc::new(Mutex::new(None));
        let mode = decide_mode(&cfg, &attach_note);

        let (tx, rx) = channel::<Command>();
        let running = Arc::new(AtomicBool::new(true));
        let running_thread = running.clone();

        thread::Builder::new()
            .name("minder-supervisor".into())
            .spawn(move || {
                run_supervisor(cfg, payload_dir, mode, rx);
                running_thread.store(false, Ordering::SeqCst);
            })
            .expect("failed to spawn supervisor thread");

        Arc::new(Supervisor {
            tx: Mutex::new(tx),
            mode,
            attach_note,
            _running: running,
        })
    }

    pub fn is_attached(&self) -> bool {
        self.mode == Mode::Attach
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
) {
    log(&format!(
        "supervisor started in {mode:?} mode on :{}",
        cfg.port
    ));
    if mode == Mode::Attach {
        // Observe only: wait for a shutdown command and never touch the server.
        loop {
            match rx.recv() {
                Ok(Command::Shutdown(ack)) => {
                    log("attach mode: quit requested — leaving the existing server untouched");
                    let _ = ack.send(());
                    return;
                }
                Ok(Command::Restart(ack)) => {
                    log("attach mode: restart requested — ignored (not our process)");
                    let _ = ack.send(());
                }
                Err(_) => return,
            }
        }
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
                let uptime = started.elapsed();
                if uptime >= HEALTHY_UPTIME_RESET {
                    backoff = BASE_BACKOFF;
                }
                log(&format!(
                    "minder-server pid={pid} exited after {uptime:?}; restarting in {backoff:?}"
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

/// Poll the child and the command channel until one of them ends the loop.
fn supervise(child: &mut Child, rx: &Receiver<Command>) -> ExitReason {
    loop {
        match child.try_wait() {
            Ok(Some(_status)) => return ExitReason::Crash,
            Ok(None) => {}
            Err(_) => return ExitReason::Crash,
        }
        match rx.try_recv() {
            Ok(Command::Shutdown(ack)) => return ExitReason::Shutdown(ack),
            Ok(Command::Restart(ack)) => return ExitReason::Restart(ack),
            Err(TryRecvError::Empty) => {}
            Err(TryRecvError::Disconnected) => return ExitReason::ChannelClosed,
        }
        thread::sleep(Duration::from_millis(200));
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

    StdCommand::new(&cfg.node_path)
        .arg(&server_js)
        .current_dir(dir)
        .env("PORT", cfg.port.to_string())
        .env("HOSTNAME", HOST)
        // The tray always drives shutdown over stdin (Windows can't signal a
        // console Node) — the TS control channel activates only with this set.
        .env("MINDER_CONTROL_STDIN", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
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
        let _ = StdCommand::new("taskkill")
            .args(["/F", "/T", "/PID", &pid.to_string()])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    #[cfg(not(windows))]
    {
        // Negative PID targets the process group (best effort on non-Windows,
        // which isn't the primary target).
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

fn log(msg: &str) {
    println!("[minder-tray] {msg}");
}
