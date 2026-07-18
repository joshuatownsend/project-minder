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

    /// Advance the persisted cursor. Defense in depth: validates `new_cursor`
    /// itself (not just what's loaded from disk) before accepting it, so a
    /// malformed `changedAt` from the server — however unlikely — can't poison
    /// the file. An invalid value is dropped silently (logged); the cursor
    /// stays put and the next poll just retries the same window.
    fn advance_cursor(&self, new_cursor: String) {
        if !is_valid_cursor(&new_cursor) {
            crate::supervisor::log(&format!(
                "notify: refusing to advance cursor to malformed value {new_cursor:?} — leaving cursor unchanged"
            ));
            return;
        }
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

    if should_toast(controller.is_muted(), changes.is_empty()) {
        for change in &changes {
            show_toast(app, change);
        }
    }

    // Bind the cursor to server-reported data, never the local clock: the
    // server filters strictly on `changedAt > since` (`ManualStepsWatcher.
    // getChanges`), so advancing to a locally-sampled "now" opens a race — a
    // change appended after the server built this response but before we read
    // the clock would have `changedAt <= our new cursor` and would never be
    // returned by a later poll either. Clock skew between the tray host and
    // the server only widens that hole. Advancing to the latest `changedAt`
    // we actually SAW is always safe, and an empty batch leaves the cursor
    // untouched entirely — the server's strict `>` means a stationary cursor
    // can never cause a re-toast, only a delay until real data arrives.
    if let Some(latest) = latest_changed_at(&changes) {
        controller.advance_cursor(latest.to_string());
    }
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

/// The cursor value to advance to after a poll: the lexicographically
/// greatest `changed_at` among the returned changes, or `None` for an empty
/// batch (the caller must then leave the cursor untouched — see `poll_once`).
/// `changed_at` is always a fixed-width UTC RFC3339 string straight from the
/// server's `Date.toISOString()`, so plain string comparison IS chronological
/// comparison — no parsing back to a numeric time is needed, which also means
/// no reformat drift between what the server sent and what we persist.
fn latest_changed_at(changes: &[ManualStepChange]) -> Option<&str> {
    changes.iter().map(|c| c.changed_at.as_str()).max()
}

/// Structural validation of a cursor string: exactly the fixed-width shape we
/// ever write or accept — `YYYY-MM-DDTHH:MM:SS.mmmZ`, 24 bytes, digits and
/// separators in the right positions. Not full calendar validation (no
/// range-checking of month/day/hour values) — that's unnecessary here. This
/// exists purely to keep a corrupt/empty/truncated value out of the cursor:
/// the server's `new Date(since).getTime()` (`manualStepsWatcher.ts`) turns
/// anything else into `NaN`, which fails every `changedAt > since` comparison
/// and silently filters out EVERY event forever — a state file `lastCursor`
/// like `""` would otherwise wedge notifications until someone manually
/// deletes the file.
fn is_valid_cursor(s: &str) -> bool {
    let b = s.as_bytes();
    let digit_range = |r: std::ops::Range<usize>| r.into_iter().all(|i| b[i].is_ascii_digit());
    b.len() == 24
        && digit_range(0..4)
        && b[4] == b'-'
        && digit_range(5..7)
        && b[7] == b'-'
        && digit_range(8..10)
        && b[10] == b'T'
        && digit_range(11..13)
        && b[13] == b':'
        && digit_range(14..16)
        && b[16] == b':'
        && digit_range(17..19)
        && b[19] == b'.'
        && digit_range(20..23)
        && b[23] == b'Z'
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

/// Current time as an RFC3339 UTC string with millisecond precision, e.g.
/// `"2026-07-18T04:51:07.123Z"` — the same fixed-width, 24-byte shape as the
/// server's own `Date.toISOString()` output (`changedAt`), so a seeded cursor
/// and a server-derived one are never distinguishable-but-differently-shaped
/// (which would otherwise make [`is_valid_cursor`] reject our own seed value).
/// Used ONLY to seed a fresh cursor (first run, or a missing/corrupt state
/// file) — a deliberate "never replay the backlog" choice. Regular
/// poll-to-poll cursor advances are bound to server data instead
/// (`latest_changed_at`), never to this local clock, so a change appended in
/// the race window between the server's response and our next read is never
/// permanently skipped. Falls back to the Unix epoch if the system clock is
/// somehow before 1970 (never in practice; keeps this infallible).
fn now_cursor() -> String {
    let dur = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or(Duration::ZERO);
    rfc3339_from_unix(dur.as_secs() as i64, dur.subsec_millis())
}

/// Convert a Unix timestamp (seconds since epoch, UTC) plus a millisecond
/// remainder into an RFC3339 string. Pure and dependency-free — Howard
/// Hinnant's well-known `civil_from_days` algorithm — so this one conversion
/// doesn't need a date/time crate pulled in just for cursor timestamps.
fn rfc3339_from_unix(secs: i64, millis: u32) -> String {
    let days = secs.div_euclid(86_400);
    let secs_of_day = secs.rem_euclid(86_400);
    let (y, m, d) = civil_from_days(days);
    let hh = secs_of_day / 3600;
    let mm = (secs_of_day % 3600) / 60;
    let ss = secs_of_day % 60;
    format!("{y:04}-{m:02}-{d:02}T{hh:02}:{mm:02}:{ss:02}.{millis:03}Z")
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
/// isn't a well-formed `{ "lastCursor": string, "muted": bool }` object WITH a
/// structurally valid cursor (`is_valid_cursor`) — an empty, truncated, or
/// otherwise malformed `lastCursor` is treated exactly like corrupt JSON, so
/// the caller falls back to a fresh "now" cursor rather than persisting a
/// value the server's `new Date(since)` would silently turn into `NaN` (which
/// would filter out every event, forever, until the file is deleted by hand).
fn parse_state_json(body: &str) -> Option<NotifyState> {
    let value: serde_json::Value = serde_json::from_str(body).ok()?;
    let last_cursor = value.get("lastCursor")?.as_str()?.to_string();
    let muted = value.get("muted")?.as_bool()?;
    if !is_valid_cursor(&last_cursor) {
        return None;
    }
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

    fn change_with_changed_at(changed_at: &str) -> ManualStepChange {
        ManualStepChange {
            slug: "x".to_string(),
            project_name: "x".to_string(),
            title: "x".to_string(),
            changed_at: changed_at.to_string(),
        }
    }

    #[test]
    fn latest_changed_at_is_none_for_an_empty_batch() {
        assert_eq!(latest_changed_at(&[]), None);
    }

    #[test]
    fn latest_changed_at_picks_the_max_of_the_batch() {
        let changes = [
            change_with_changed_at("2026-07-18T04:00:00.000Z"),
            change_with_changed_at("2026-07-18T04:05:00.000Z"),
        ];
        assert_eq!(
            latest_changed_at(&changes),
            Some("2026-07-18T04:05:00.000Z")
        );
    }

    #[test]
    fn latest_changed_at_picks_the_max_even_when_the_batch_is_out_of_order() {
        let changes = [
            change_with_changed_at("2026-07-18T04:10:00.000Z"),
            change_with_changed_at("2026-07-18T04:00:00.000Z"),
            change_with_changed_at("2026-07-18T04:05:00.000Z"),
        ];
        assert_eq!(
            latest_changed_at(&changes),
            Some("2026-07-18T04:10:00.000Z")
        );
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
        assert_eq!(rfc3339_from_unix(0, 0), "1970-01-01T00:00:00.000Z");
    }

    #[test]
    fn a_known_mid_2023_timestamp_formats_correctly() {
        // new Date(1700000000000).toISOString() === "2023-11-14T22:13:20.000Z"
        assert_eq!(
            rfc3339_from_unix(1_700_000_000, 0),
            "2023-11-14T22:13:20.000Z"
        );
    }

    #[test]
    fn a_leap_day_formats_correctly() {
        // new Date(1582934400000).toISOString() === "2020-02-29T00:00:00.000Z"
        assert_eq!(
            rfc3339_from_unix(1_582_934_400, 0),
            "2020-02-29T00:00:00.000Z"
        );
    }

    #[test]
    fn end_of_year_rolls_over_correctly() {
        // new Date(1735689599000).toISOString() === "2024-12-31T23:59:59.000Z"
        assert_eq!(
            rfc3339_from_unix(1_735_689_599, 0),
            "2024-12-31T23:59:59.000Z"
        );
    }

    #[test]
    fn milliseconds_are_included_and_zero_padded() {
        // new Date(1700000000007).toISOString() === "2023-11-14T22:13:20.007Z"
        assert_eq!(
            rfc3339_from_unix(1_700_000_000, 7),
            "2023-11-14T22:13:20.007Z"
        );
    }

    // --- is_valid_cursor ---

    #[test]
    fn is_valid_cursor_accepts_a_well_formed_string() {
        assert!(is_valid_cursor("2026-07-18T04:51:07.123Z"));
    }

    #[test]
    fn is_valid_cursor_rejects_empty_string() {
        assert!(!is_valid_cursor(""));
    }

    #[test]
    fn is_valid_cursor_rejects_garbage() {
        assert!(!is_valid_cursor("not-a-date-at-all-nope!"));
    }

    #[test]
    fn is_valid_cursor_rejects_wrong_length() {
        assert!(!is_valid_cursor("2026-07-18T04:51:07Z")); // no milliseconds (20 bytes)
        assert!(!is_valid_cursor("2026-07-18T04:51:07.1234Z")); // too long (25 bytes)
    }

    #[test]
    fn is_valid_cursor_rejects_missing_trailing_z() {
        assert!(!is_valid_cursor("2026-07-18T04:51:07.123X"));
        assert!(!is_valid_cursor("2026-07-18T04:51:07.123 "));
    }

    #[test]
    fn is_valid_cursor_rejects_non_digit_in_a_digit_position() {
        assert!(!is_valid_cursor("2026-07-18T04:51:0X.123Z"));
    }

    // --- state persistence ---

    #[test]
    fn parse_state_json_round_trips_serialize_state() {
        let state = NotifyState {
            last_cursor: "2026-07-18T04:00:00.000Z".to_string(),
            muted: true,
        };
        let json = serialize_state(&state);
        assert_eq!(parse_state_json(&json), Some(state));
    }

    #[test]
    fn parse_state_json_rejects_missing_fields() {
        assert_eq!(parse_state_json(r#"{"muted":true}"#), None);
        assert_eq!(
            parse_state_json(r#"{"lastCursor":"2026-07-18T04:00:00.000Z"}"#),
            None
        );
    }

    #[test]
    fn parse_state_json_rejects_corrupt_json() {
        assert_eq!(parse_state_json("{not json"), None);
        assert_eq!(parse_state_json(""), None);
    }

    #[test]
    fn parse_state_json_rejects_an_invalid_cursor_even_with_well_formed_json() {
        assert_eq!(parse_state_json(r#"{"lastCursor":"","muted":false}"#), None);
        assert_eq!(
            parse_state_json(r#"{"lastCursor":"garbage","muted":false}"#),
            None
        );
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
        // A fresh cursor should be a well-formed, non-empty cursor.
        assert!(is_valid_cursor(&state.last_cursor));
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
        assert!(is_valid_cursor(&state.last_cursor));
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn load_state_reseeds_when_the_persisted_cursor_is_invalid() {
        let path = std::env::temp_dir().join(format!(
            "minder-tray-notify-test-invalid-cursor-{}.json",
            std::process::id()
        ));
        // Well-formed JSON, well-typed fields — but an empty lastCursor, which
        // is exactly the Codex-flagged case: valid JSON that would otherwise
        // sail through as the live cursor and wedge notifications forever.
        fs::write(&path, r#"{"lastCursor":"","muted":true}"#).unwrap();
        let state = load_state(&path);
        // Reseeded fresh: never the empty value that was on disk, and the mute
        // flag resets too (treated exactly like corrupt state, per the fix).
        assert_ne!(state.last_cursor, "");
        assert!(is_valid_cursor(&state.last_cursor));
        assert!(!state.muted);
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn save_state_then_load_state_round_trips() {
        let path = std::env::temp_dir().join(format!(
            "minder-tray-notify-test-roundtrip-{}.json",
            std::process::id()
        ));
        let state = NotifyState {
            last_cursor: "2026-07-18T05:00:00.000Z".to_string(),
            muted: true,
        };
        save_state(&path, &state).unwrap();
        let loaded = load_state(&path);
        assert_eq!(loaded, state);
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn advance_cursor_rejects_an_invalid_value_and_leaves_the_cursor_unchanged() {
        let controller = NotifyController::new(None);
        let original = controller.cursor();
        controller.advance_cursor("garbage".to_string());
        assert_eq!(controller.cursor(), original);
    }

    #[test]
    fn advance_cursor_accepts_a_valid_value() {
        let controller = NotifyController::new(None);
        controller.advance_cursor("2026-07-18T04:00:00.000Z".to_string());
        assert_eq!(controller.cursor(), "2026-07-18T04:00:00.000Z");
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
