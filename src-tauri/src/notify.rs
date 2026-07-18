//! Native toast notifications for new `MANUAL_STEPS.md` entries (Phase C3).
//!
//! A std::thread poller — NOT tokio, matching the rest of this synchronous app
//! (see `tray::spawn_poll_loop`) — hits `GET /api/manual-steps/changes?since=<cursor>`
//! every ~30s (the server-side watcher itself batches at up to 60s, so combined
//! worst case is well under the plan's ~90s acceptance window). New entries
//! become OS toasts via `tauri-plugin-notification`, unless muted from the tray
//! menu. The `since` cursor and the mute flag persist to a small JSON file in
//! the same `~/.minder` state dir the sidecar's own state lives in, so a tray
//! restart resumes forward from where it left off instead of either replaying
//! history or re-toasting anything already shown.
//!
//! Click-to-open is intentionally NOT wired up: `NotificationBuilder` (the
//! Rust-side API, docs.rs `tauri-plugin-notification` 2.3.3) only builds and
//! shows a notification — the plugin's action-click listener (`onAction`) is a
//! JS/webview-side API invoked over Tauri's IPC, and this tray has no window or
//! webview at all (see `main.rs`). The tray menu's existing "Open Dashboard"
//! item is the click-to-open equivalent.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tauri::menu::CheckMenuItem;
use tauri::Runtime;
use tauri_plugin_notification::NotificationExt;

use crate::health;

/// How often to re-poll `/api/manual-steps/changes`. The watcher that produces
/// these events batches its own filesystem scan at up to 60s, so this plus that
/// comfortably clears the plan's ~90s worst-case acceptance window.
const POLL_INTERVAL: Duration = Duration::from_secs(30);

/// Name of the small JSON cursor/mute file, alongside the sidecar's other state
/// in `~/.minder`.
const STATE_FILE_NAME: &str = "tray-notify.json";

/// One `MANUAL_STEPS.md` change event, as returned by
/// `GET /api/manual-steps/changes` (`src/app/api/manual-steps/changes/route.ts`,
/// backed by `ManualStepsWatcher.getChanges` in `src/lib/manualStepsWatcher.ts`).
/// The route returns a bare JSON array of these — no `{ data: [...] }` wrapper.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ManualStepChange {
    #[allow(dead_code)] // carried through for completeness/future use, not rendered today
    pub slug: String,
    pub project_name: String,
    pub title: String,
    #[allow(dead_code)] // not surfaced in the toast copy today; kept for future use/diagnostics
    pub changed_at: String,
}

/// Persisted poller state: how far we've read, and whether toasts are muted.
#[derive(Debug, Clone, PartialEq, Eq)]
struct NotifyState {
    last_cursor: String,
    muted: bool,
}

/// Shared handle the tray menu and the poll thread both hold. Mutations always
/// go through the `Mutex`, then get flushed to disk from one place
/// ([`NotifyController::persist`]) — avoids two independent writers racing on
/// the same JSON file.
pub struct NotifyController {
    state: Mutex<NotifyState>,
    /// `None` when the state dir couldn't be resolved (e.g. no home dir) — the
    /// controller still works, just in-memory-only for this run.
    state_path: Option<PathBuf>,
}

impl NotifyController {
    /// Load persisted state (or start fresh from "now") under `state_dir`.
    pub fn new(state_dir: Option<&Path>) -> Arc<NotifyController> {
        let state_path = state_dir.map(|d| d.join(STATE_FILE_NAME));
        let state = match &state_path {
            Some(p) => load_state(p),
            None => {
                crate::supervisor::log(
                    "notify: no state dir resolved — mute/cursor won't persist across restarts",
                );
                NotifyState {
                    last_cursor: now_cursor(),
                    muted: false,
                }
            }
        };
        Arc::new(NotifyController {
            state: Mutex::new(state),
            state_path,
        })
    }

    pub fn is_muted(&self) -> bool {
        self.state.lock().map(|s| s.muted).unwrap_or(false)
    }

    /// Set the mute flag (from the tray checkbox) and persist immediately.
    pub fn set_muted(&self, muted: bool) {
        if let Ok(mut s) = self.state.lock() {
            s.muted = muted;
        }
        self.persist();
    }

    fn cursor(&self) -> String {
        self.state
            .lock()
            .map(|s| s.last_cursor.clone())
            .unwrap_or_else(|_| now_cursor())
    }

    fn advance_cursor(&self, new_cursor: String) {
        if let Ok(mut s) = self.state.lock() {
            s.last_cursor = new_cursor;
        }
        self.persist();
    }

    fn persist(&self) {
        let Some(path) = &self.state_path else {
            return;
        };
        if let Ok(s) = self.state.lock() {
            if let Err(e) = save_state(path, &s) {
                crate::supervisor::log(&format!("notify: failed to persist state: {e}"));
            }
        }
    }
}

/// Start the background poll thread. Mirrors `tray::spawn_poll_loop`: a plain
/// `std::thread` loop, no tokio/async runtime.
pub fn spawn_poll_loop<R: Runtime>(
    app: tauri::AppHandle<R>,
    dashboard_url: String,
    controller: Arc<NotifyController>,
) {
    thread::spawn(move || loop {
        poll_once(&app, &dashboard_url, &controller);
        thread::sleep(POLL_INTERVAL);
    });
}

/// One poll cycle: fetch changes since the current cursor, toast the new ones
/// (unless muted), then advance the cursor. Network/parse failures are skipped
/// silently — the cursor is left untouched so nothing is lost, and the next
/// poll just retries from the same point.
fn poll_once<R: Runtime>(
    app: &tauri::AppHandle<R>,
    dashboard_url: &str,
    controller: &NotifyController,
) {
    let since = controller.cursor();
    let url = build_changes_url(dashboard_url, &since);

    let body = match health::agent().get(&url).call() {
        Ok(resp) => match resp.into_string() {
            Ok(s) => s,
            Err(_) => return,
        },
        Err(_) => return, // server unreachable / non-2xx — skip silently, no backoff
    };

    let changes = parse_changes(&body);
    let next_cursor = now_cursor();

    if should_toast(controller.is_muted(), changes.is_empty()) {
        for change in &changes {
            show_toast(app, change);
        }
    }

    // Advance regardless of mute state (and even if empty) so a later unmute
    // doesn't dump a backlog, and so a transient empty poll doesn't stall
    // forward progress.
    controller.advance_cursor(next_cursor);
}

/// Build the `GET /api/manual-steps/changes` URL. Pure and unit-testable
/// separately from the network call. `since` is always our own RFC3339 output
/// (digits/`T`/`:`/`Z` only), so no percent-encoding is needed — those
/// characters are all legal, unencoded query characters per RFC 3986.
fn build_changes_url(dashboard_url: &str, since: &str) -> String {
    format!("{dashboard_url}/api/manual-steps/changes?since={since}")
}

/// Parse the bare JSON array the route returns into change events. Tolerant:
/// a response that isn't a JSON array yields no events; an individual element
/// missing/mistyping any of the four string fields is skipped rather than
/// failing the whole batch (mirrors `health::classify_body`'s never-panic
/// style).
fn parse_changes(body: &str) -> Vec<ManualStepChange> {
    let value: serde_json::Value = match serde_json::from_str(body) {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };
    let Some(items) = value.as_array() else {
        return Vec::new();
    };

    items
        .iter()
        .filter_map(|item| {
            let slug = item.get("slug")?.as_str()?.to_string();
            let project_name = item.get("projectName")?.as_str()?.to_string();
            let title = item.get("title")?.as_str()?.to_string();
            let changed_at = item.get("changedAt")?.as_str()?.to_string();
            Some(ManualStepChange {
                slug,
                project_name,
                title,
                changed_at,
            })
        })
        .collect()
}

/// Pure "should we toast this poll" decision: never while muted, never for an
/// empty batch (nothing to say).
fn should_toast(muted: bool, changes_is_empty: bool) -> bool {
    !muted && !changes_is_empty
}

/// Notification (title, body) copy for one change event. Pure so the exact
/// wording is unit-tested without a live notification backend.
fn toast_text(change: &ManualStepChange) -> (String, String) {
    (
        "Manual step added".to_string(),
        format!("{}: {}", change.project_name, change.title),
    )
}

/// Show one OS toast. Never panics — a notification failure (e.g. permission
/// denied, or the dev-mode "shows powershell name & icon" Windows quirk noted
/// in the plugin's own docs) is logged and otherwise ignored, matching this
/// app's log-and-continue error handling everywhere else.
fn show_toast<R: Runtime>(app: &tauri::AppHandle<R>, change: &ManualStepChange) {
    let (title, body) = toast_text(change);
    if let Err(e) = app.notification().builder().title(title).body(body).show() {
        crate::supervisor::log(&format!("notify: failed to show toast: {e}"));
    }
}

/// Sync the mute `CheckMenuItem`'s new checked state (Tauri already flipped it
/// before this event fired) into the controller. Unlike autostart's checkbox,
/// there's no external OS registration to reconcile against — our own
/// controller state IS the source of truth — so an `is_checked()` read failure
/// just leaves the checkbox and controller state as they were, logged.
pub fn sync_mute<R: Runtime>(item: &CheckMenuItem<R>, controller: &NotifyController) {
    match item.is_checked() {
        Ok(checked) => controller.set_muted(checked),
        Err(e) => {
            crate::supervisor::log(&format!("could not read mute checkbox state: {e}"));
        }
    }
}

/// Current time as an RFC3339 UTC string with second precision, e.g.
/// `"2026-07-18T04:51:07Z"` — what the server's `new Date(since)` (in
/// `route.ts`) expects. Falls back to the Unix epoch string if the system
/// clock is somehow before 1970 (never in practice; keeps this infallible).
fn now_cursor() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    rfc3339_from_unix(secs)
}

/// Convert a Unix timestamp (seconds since epoch, UTC) to an RFC3339 string.
/// Pure and dependency-free — Howard Hinnant's well-known `civil_from_days`
/// algorithm — so this one conversion doesn't need a date/time crate pulled in
/// just for cursor timestamps.
fn rfc3339_from_unix(secs: i64) -> String {
    let days = secs.div_euclid(86_400);
    let secs_of_day = secs.rem_euclid(86_400);
    let (y, m, d) = civil_from_days(days);
    let hh = secs_of_day / 3600;
    let mm = (secs_of_day % 3600) / 60;
    let ss = secs_of_day % 60;
    format!("{y:04}-{m:02}-{d:02}T{hh:02}:{mm:02}:{ss:02}Z")
}

/// Days-since-epoch (1970-01-01) -> (year, month, day). See
/// <https://howardhinnant.github.io/date_algorithms.html#civil_from_days>.
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468; // shift epoch to 0000-03-01
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365; // [0, 399]
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32; // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32; // [1, 12]
    let y = if m <= 2 { y + 1 } else { y };
    (y, m, d)
}

/// Parse a persisted state file's contents. Returns `None` for anything that
/// isn't a well-formed `{ "lastCursor": string, "muted": bool }` object, so the
/// caller can fall back to a fresh "now" cursor rather than guessing at partial
/// data.
fn parse_state_json(body: &str) -> Option<NotifyState> {
    let value: serde_json::Value = serde_json::from_str(body).ok()?;
    let last_cursor = value.get("lastCursor")?.as_str()?.to_string();
    let muted = value.get("muted")?.as_bool()?;
    Some(NotifyState { last_cursor, muted })
}

/// Serialize state for persistence. Pure; the actual `fs::write` lives in
/// [`save_state`].
fn serialize_state(state: &NotifyState) -> String {
    serde_json::json!({
        "lastCursor": state.last_cursor,
        "muted": state.muted,
    })
    .to_string()
}

/// Load state from `path`. Missing file, unreadable file, or corrupt/partial
/// JSON all fall back to a fresh state (cursor = now, unmuted) — this is the
/// "never re-toast history" guarantee: a broken state file must never resolve
/// to an old cursor.
fn load_state(path: &Path) -> NotifyState {
    match fs::read_to_string(path) {
        Ok(body) => parse_state_json(&body).unwrap_or_else(|| NotifyState {
            last_cursor: now_cursor(),
            muted: false,
        }),
        Err(_) => NotifyState {
            last_cursor: now_cursor(),
            muted: false,
        },
    }
}

/// Persist state to `path`, creating the parent dir if needed (mirrors
/// `supervisor::spawn_child`'s `create_dir_all` before first write).
fn save_state(path: &Path, state: &NotifyState) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(path, serialize_state(state))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_well_formed_change_array() {
        let body = r#"[
            {"slug":"my-app","projectName":"my-app","title":"Set env vars","changedAt":"2026-07-18T04:00:00.000Z"},
            {"slug":"other","projectName":"other (feature/x)","title":"Run migration","changedAt":"2026-07-18T04:05:00.000Z"}
        ]"#;
        let changes = parse_changes(body);
        assert_eq!(changes.len(), 2);
        assert_eq!(changes[0].slug, "my-app");
        assert_eq!(changes[0].project_name, "my-app");
        assert_eq!(changes[0].title, "Set env vars");
        assert_eq!(changes[0].changed_at, "2026-07-18T04:00:00.000Z");
        assert_eq!(changes[1].project_name, "other (feature/x)");
    }

    #[test]
    fn empty_array_yields_no_changes() {
        assert_eq!(parse_changes("[]"), Vec::new());
    }

    #[test]
    fn non_array_json_yields_no_changes() {
        assert_eq!(
            parse_changes(r#"{"error":"since parameter required"}"#),
            Vec::new()
        );
    }

    #[test]
    fn malformed_json_yields_no_changes() {
        assert_eq!(parse_changes("not json"), Vec::new());
    }

    #[test]
    fn an_entry_missing_a_field_is_skipped_not_fatal() {
        let body = r#"[
            {"slug":"a","projectName":"a","title":"ok","changedAt":"2026-07-18T04:00:00.000Z"},
            {"slug":"b","projectName":"b","title":"missing changedAt"}
        ]"#;
        let changes = parse_changes(body);
        assert_eq!(changes.len(), 1);
        assert_eq!(changes[0].slug, "a");
    }

    #[test]
    fn should_toast_is_false_when_muted() {
        assert!(!should_toast(true, false));
    }

    #[test]
    fn should_toast_is_false_when_no_changes() {
        assert!(!should_toast(false, true));
    }

    #[test]
    fn should_toast_is_true_for_unmuted_nonempty() {
        assert!(should_toast(false, false));
    }

    #[test]
    fn toast_text_combines_project_and_title() {
        let change = ManualStepChange {
            slug: "my-app".to_string(),
            project_name: "my-app".to_string(),
            title: "Set env vars".to_string(),
            changed_at: "2026-07-18T04:00:00.000Z".to_string(),
        };
        let (title, body) = toast_text(&change);
        assert_eq!(title, "Manual step added");
        assert_eq!(body, "my-app: Set env vars");
    }

    #[test]
    fn build_changes_url_appends_since_query_param() {
        assert_eq!(
            build_changes_url("http://localhost:4100", "2026-07-18T04:00:00Z"),
            "http://localhost:4100/api/manual-steps/changes?since=2026-07-18T04:00:00Z"
        );
    }

    // --- rfc3339_from_unix / civil_from_days ---
    // Reference values cross-checked against `new Date(<ms>).toISOString()`.

    #[test]
    fn unix_epoch_formats_correctly() {
        assert_eq!(rfc3339_from_unix(0), "1970-01-01T00:00:00Z");
    }

    #[test]
    fn a_known_mid_2023_timestamp_formats_correctly() {
        // new Date(1700000000000).toISOString() === "2023-11-14T22:13:20.000Z"
        assert_eq!(rfc3339_from_unix(1_700_000_000), "2023-11-14T22:13:20Z");
    }

    #[test]
    fn a_leap_day_formats_correctly() {
        // new Date(1582934400000).toISOString() === "2020-02-29T00:00:00.000Z"
        assert_eq!(rfc3339_from_unix(1_582_934_400), "2020-02-29T00:00:00Z");
    }

    #[test]
    fn end_of_year_rolls_over_correctly() {
        // new Date(1735689599000).toISOString() === "2024-12-31T23:59:59.000Z"
        assert_eq!(rfc3339_from_unix(1_735_689_599), "2024-12-31T23:59:59Z");
    }

    // --- state persistence ---

    #[test]
    fn parse_state_json_round_trips_serialize_state() {
        let state = NotifyState {
            last_cursor: "2026-07-18T04:00:00Z".to_string(),
            muted: true,
        };
        let json = serialize_state(&state);
        assert_eq!(parse_state_json(&json), Some(state));
    }

    #[test]
    fn parse_state_json_rejects_missing_fields() {
        assert_eq!(parse_state_json(r#"{"muted":true}"#), None);
        assert_eq!(parse_state_json(r#"{"lastCursor":"x"}"#), None);
    }

    #[test]
    fn parse_state_json_rejects_corrupt_json() {
        assert_eq!(parse_state_json("{not json"), None);
        assert_eq!(parse_state_json(""), None);
    }

    #[test]
    fn load_state_falls_back_to_fresh_now_on_missing_file() {
        let path = std::env::temp_dir().join(format!(
            "minder-tray-notify-test-missing-{}.json",
            std::process::id()
        ));
        let _ = fs::remove_file(&path); // ensure it doesn't exist
        let state = load_state(&path);
        assert!(!state.muted);
        // A fresh cursor should parse as a plausible RFC3339 string, not be empty.
        assert!(state.last_cursor.ends_with('Z'));
    }

    #[test]
    fn load_state_falls_back_to_fresh_now_on_corrupt_file() {
        let path = std::env::temp_dir().join(format!(
            "minder-tray-notify-test-corrupt-{}.json",
            std::process::id()
        ));
        fs::write(&path, "{ not valid json").unwrap();
        let state = load_state(&path);
        assert!(!state.muted);
        assert!(state.last_cursor.ends_with('Z'));
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn save_state_then_load_state_round_trips() {
        let path = std::env::temp_dir().join(format!(
            "minder-tray-notify-test-roundtrip-{}.json",
            std::process::id()
        ));
        let state = NotifyState {
            last_cursor: "2026-07-18T05:00:00Z".to_string(),
            muted: true,
        };
        save_state(&path, &state).unwrap();
        let loaded = load_state(&path);
        assert_eq!(loaded, state);
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn controller_set_muted_persists_and_is_muted_reflects_it() {
        let dir = std::env::temp_dir().join(format!(
            "minder-tray-notify-test-dir-{}",
            std::process::id()
        ));
        let _ = fs::create_dir_all(&dir);
        let controller = NotifyController::new(Some(&dir));
        assert!(!controller.is_muted());
        controller.set_muted(true);
        assert!(controller.is_muted());

        // A fresh controller reading the same dir picks up the persisted mute flag.
        let reloaded = NotifyController::new(Some(&dir));
        assert!(reloaded.is_muted());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn controller_without_a_state_dir_still_works_in_memory() {
        let controller = NotifyController::new(None);
        assert!(!controller.is_muted());
        controller.set_muted(true);
        assert!(controller.is_muted());
    }
}
