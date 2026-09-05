//! Restart-above-threshold guard for the spawned server (#561).
//!
//! On 2026-08-31 the tray spawned a server that grew to 56 GB of commit over
//! five days and exhausted the machine; the tray polled `/api/health` every
//! 15 s the whole time and, because the route carried no memory figures and
//! the tray had no rule about them, reported "running" until the process was
//! killed by hand. The route now reports `memory.rssMb` and this module is
//! the rule: when the resident set crosses the configured ceiling, ask the
//! supervisor for the same graceful restart the tray menu offers.
//!
//! The decision is a pure function of (reading, ceiling, time since the last
//! restart we triggered) so the poll loop stays a two-line caller and the
//! rule is unit-tested here. Three properties matter:
//!
//!   - **rss, not heap.** The exhausted process had a ~4 GB V8 heap; the
//!     other 50 GB was native. Heap would never have crossed anything.
//!   - **A cooldown.** A restart takes the server through a multi-minute
//!     reconcile whose own working set is not small, and a genuinely huge
//!     corpus could sit above a low ceiling from boot. Without a cooldown a
//!     misconfigured threshold would restart the server every 15 s forever;
//!     with one, it restarts at most once per [`RESTART_COOLDOWN`] and the
//!     tray log makes the pattern obvious.
//!   - **Never in attach mode.** The tray only restarts processes it spawned
//!     (`Supervisor::restart` is a no-op otherwise); the caller checks
//!     `is_attached()` so the log line is not written for a restart that
//!     could not happen.

use std::time::{Duration, Instant};

/// Minimum spacing between two guard-triggered restarts.
pub const RESTART_COOLDOWN: Duration = Duration::from_secs(10 * 60);

#[derive(Debug)]
pub struct MemoryGuard {
    /// Ceiling in MB; `0` disables the guard entirely.
    max_rss_mb: u64,
    last_restart: Option<Instant>,
}

impl MemoryGuard {
    pub fn new(max_rss_mb: u64) -> Self {
        MemoryGuard {
            max_rss_mb,
            last_restart: None,
        }
    }

    pub fn enabled(&self) -> bool {
        self.max_rss_mb > 0
    }

    pub fn max_rss_mb(&self) -> u64 {
        self.max_rss_mb
    }

    /// Feed one health reading. Returns `true` when the caller should restart
    /// the server now — and records that decision, so the next `true` cannot
    /// come before the cooldown elapses. A missing reading (`None`: older
    /// server, degraded body, unreachable) never triggers: absence of a number
    /// is not evidence of growth.
    pub fn observe(&mut self, rss_mb: Option<u64>, now: Instant) -> bool {
        if !self.enabled() {
            return false;
        }
        let Some(rss) = rss_mb else {
            return false;
        };
        if rss <= self.max_rss_mb {
            return false;
        }
        if let Some(last) = self.last_restart {
            if now.duration_since(last) < RESTART_COOLDOWN {
                return false;
            }
        }
        self.last_restart = Some(now);
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn t0() -> Instant {
        Instant::now()
    }

    #[test]
    fn under_the_ceiling_never_fires() {
        let mut g = MemoryGuard::new(8192);
        let now = t0();
        assert!(!g.observe(Some(1500), now));
        assert!(!g.observe(Some(8192), now)); // at, not above
    }

    #[test]
    fn above_the_ceiling_fires_once_then_waits_out_the_cooldown() {
        let mut g = MemoryGuard::new(8192);
        let now = t0();
        assert!(g.observe(Some(56_000), now));
        // Next 15 s poll: still huge (restart in progress or growth resumed),
        // but inside the cooldown — do not hammer it.
        assert!(!g.observe(Some(56_000), now + Duration::from_secs(15)));
        assert!(!g.observe(
            Some(56_000),
            now + RESTART_COOLDOWN - Duration::from_secs(1)
        ));
        assert!(g.observe(Some(56_000), now + RESTART_COOLDOWN));
    }

    #[test]
    fn a_missing_reading_is_not_growth() {
        // Older server build (no `memory` field), a body that failed to parse,
        // or nothing answered at all: none of these say anything about rss.
        let mut g = MemoryGuard::new(8192);
        assert!(!g.observe(None, t0()));
    }

    #[test]
    fn zero_disables_the_guard_entirely() {
        let mut g = MemoryGuard::new(0);
        assert!(!g.enabled());
        assert!(!g.observe(Some(u64::MAX), t0()));
    }

    #[test]
    fn a_reading_that_does_not_fire_does_not_start_a_cooldown() {
        // Dropping below and coming back above must fire immediately, not
        // be gated by a cooldown that a non-restart somehow started.
        let mut g = MemoryGuard::new(8192);
        let now = t0();
        assert!(!g.observe(Some(100), now));
        assert!(g.observe(Some(9000), now + Duration::from_secs(15)));
    }
}
