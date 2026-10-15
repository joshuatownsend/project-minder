//! Stop the server cleanly when Windows signs out, restarts, or shuts down.
//!
//! Tauri surfaces no session-end event: tao's and tray-icon's internal windows
//! are message-only, and message-only windows never receive the
//! `WM_QUERYENDSESSION` / `WM_ENDSESSION` broadcasts. Without this module a
//! reboot (including a Windows Update restart) killed the server without its
//! disposers, so no clean-shutdown marker was written and the next boot paid a
//! full integrity probe of `index.db` (~2 minutes on a 3 GB index).
//!
//! So we own one hidden **top-level** window on a dedicated thread whose only
//! job is to wait for those two messages. On `WM_ENDSESSION` it runs the same
//! [`Supervisor::shutdown`] the tray's Quit item does (stdin `shutdown`, ~150 ms
//! in practice, force-kill after the 6 s grace window) before returning, because
//! Windows ends the process as soon as the handler returns.
//!
//! Ordering matters. The server's `node.exe` also gets told: it has a hidden
//! console, and Node's default answer to `CTRL_SHUTDOWN_EVENT` is to exit on the
//! spot, skipping the disposers. Windows notifies processes from the highest
//! shutdown level to the lowest, so the tray raises itself to the top of the
//! application range and stops the server before Windows reaches it.

use std::sync::mpsc::SyncSender;
use std::sync::{Arc, OnceLock};
use std::thread;

use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::System::Shutdown::{ShutdownBlockReasonCreate, ShutdownBlockReasonDestroy};
use windows_sys::Win32::System::Threading::SetProcessShutdownParameters;
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DispatchMessageW, GetMessageW, RegisterClassW,
    TranslateMessage, ENDSESSION_LOGOFF, MSG, WM_ENDSESSION, WM_QUERYENDSESSION, WNDCLASSW,
    WS_EX_TOOLWINDOW, WS_OVERLAPPED,
};

use crate::supervisor::{self, Supervisor};

/// Highest level in the range Windows reserves for applications (0x100-0x3FF).
/// Higher levels are shut down first, ahead of the default 0x280 that
/// `node.exe` runs at.
const SHUTDOWN_LEVEL: u32 = 0x3FF;
/// `SHUTDOWN_NORETRY`: if the tray ever hangs here, Windows ends it without
/// the "this app is preventing shutdown" retry dialog.
const SHUTDOWN_NORETRY: u32 = 0x1;

type OnEnd = Box<dyn Fn() + Send + Sync>;

/// What `WM_ENDSESSION` runs. Set once per process.
static ON_END: OnceLock<OnEnd> = OnceLock::new();

/// Start watching for session end. Never fails tray startup: any problem is
/// logged and the tray carries on without it.
pub fn watch(supervisor: Arc<Supervisor>) {
    // SAFETY: plain Win32 call with constant arguments.
    if unsafe { SetProcessShutdownParameters(SHUTDOWN_LEVEL, SHUTDOWN_NORETRY) } == 0 {
        supervisor::log("session end: could not raise the shutdown priority");
    }
    start(Box::new(move || supervisor.shutdown()), None);
}

/// Spawn the window thread. `ready` (tests) receives the window handle as an
/// integer, or 0 if the window could not be created.
fn start(on_end: OnEnd, ready: Option<SyncSender<isize>>) {
    if ON_END.set(on_end).is_err() {
        return; // already watching
    }
    let spawned = thread::Builder::new()
        .name("minder-session-end".into())
        .spawn(move || run_window(ready));
    if let Err(e) = spawned {
        supervisor::log(&format!("session end: watcher thread failed to start: {e}"));
    }
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

fn run_window(ready: Option<SyncSender<isize>>) {
    let class = wide("MinderTraySessionEnd");
    // SAFETY: standard window-class registration and creation; every pointer
    // passed outlives the calls (`class` lives for the whole loop below).
    unsafe {
        let instance = GetModuleHandleW(std::ptr::null());
        let mut wc: WNDCLASSW = std::mem::zeroed();
        wc.lpfnWndProc = Some(window_proc);
        wc.hInstance = instance;
        wc.lpszClassName = class.as_ptr();
        let hwnd = if RegisterClassW(&wc) == 0 {
            std::ptr::null_mut()
        } else {
            // Top-level (no parent) and never shown. Not HWND_MESSAGE: a
            // message-only window would miss the session-end broadcast.
            CreateWindowExW(
                WS_EX_TOOLWINDOW,
                class.as_ptr(),
                class.as_ptr(),
                WS_OVERLAPPED,
                0,
                0,
                0,
                0,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                instance,
                std::ptr::null(),
            )
        };
        if let Some(r) = ready {
            let _ = r.send(hwnd as isize);
        }
        if hwnd.is_null() {
            supervisor::log("session end: could not create the watcher window");
            return;
        }
        let mut msg: MSG = std::mem::zeroed();
        while GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) > 0 {
            TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }
}

unsafe extern "system" fn window_proc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    match msg {
        WM_QUERYENDSESSION => {
            // Agree to end, and give Windows a readable reason to show if the
            // stop below runs long.
            let reason = wide("Saving the Project Minder index…");
            ShutdownBlockReasonCreate(hwnd, reason.as_ptr());
            1
        }
        WM_ENDSESSION => {
            // Not gated on having seen WM_QUERYENDSESSION: a forced shutdown
            // can skip the query. Logoff, restart, shutdown, and Restart
            // Manager closes all need the same clean stop.
            if wparam != 0 {
                let kind = if (lparam as u32) & ENDSESSION_LOGOFF != 0 { "sign-out" } else { "shutdown" };
                supervisor::log(&format!("session end ({kind}): stopping the server"));
                if let Some(on_end) = ON_END.get() {
                    on_end();
                }
                supervisor::log("session end: server stopped");
            }
            ShutdownBlockReasonDestroy(hwnd);
            0
        }
        _ => DefWindowProcW(hwnd, msg, wparam, lparam),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::mpsc::sync_channel;
    use std::time::Duration;
    use windows_sys::Win32::Foundation::BOOL;
    use windows_sys::Win32::UI::WindowsAndMessaging::{EnumWindows, SendMessageW};

    static ENDS: AtomicUsize = AtomicUsize::new(0);
    static FOUND: AtomicUsize = AtomicUsize::new(0);

    unsafe extern "system" fn find(hwnd: HWND, target: LPARAM) -> BOOL {
        if hwnd as isize == target {
            FOUND.store(1, Ordering::SeqCst);
            return 0; // stop enumerating
        }
        1
    }

    /// One test, because the window and its action are once per process.
    #[test]
    fn top_level_window_stops_the_server_on_session_end_only() {
        let (tx, rx) = sync_channel(1);
        start(
            Box::new(|| {
                ENDS.fetch_add(1, Ordering::SeqCst);
            }),
            Some(tx),
        );
        let hwnd = rx.recv_timeout(Duration::from_secs(5)).expect("window thread reported");
        assert_ne!(hwnd, 0, "window was created");

        // Session-end broadcasts reach top-level windows, the set EnumWindows
        // walks; message-only windows are left out of both.
        unsafe { EnumWindows(Some(find), hwnd) };
        assert_eq!(FOUND.load(Ordering::SeqCst), 1, "window is top-level, not message-only");

        let h = hwnd as HWND;
        // SAFETY: synchronous sends to a live window on the watcher thread.
        unsafe {
            assert_eq!(SendMessageW(h, WM_QUERYENDSESSION, 0, 0), 1, "agrees to end the session");
            assert_eq!(ENDS.load(Ordering::SeqCst), 0, "the query alone stops nothing");
            SendMessageW(h, WM_ENDSESSION, 0, 0); // shutdown cancelled
            assert_eq!(ENDS.load(Ordering::SeqCst), 0, "a cancelled shutdown stops nothing");
            SendMessageW(h, WM_ENDSESSION, 1, ENDSESSION_LOGOFF as LPARAM);
        }
        assert_eq!(ENDS.load(Ordering::SeqCst), 1, "a real session end stops the server");
    }
}
