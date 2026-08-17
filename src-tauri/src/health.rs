//! Health probing against the server's `GET /api/health` contract.
//!
//! The route (src/app/api/health/route.ts) already computes the verdict: it
//! returns `ok` (true only when the DB state machine reached `success`) and
//! `status` ("ok"/"degraded"), with HTTP 200 when healthy and 503 otherwise —
//! all carrying the full body. We trust those server-computed fields rather
//! than re-deriving health from `db.state` ourselves, and map onto four tray
//! states:
//!   - Up: HTTP 200 and the server's own `ok` is true.
//!   - Degraded: a Minder-shaped response that isn't healthy (503, or `ok:false`).
//!   - Foreign: something answered over HTTP, but it isn't Minder.
//!   - Unreachable: nothing answered — connection refused, or the request timed out.
//!
//! **Foreign and Unreachable used to be one variant (`Down`), and conflating
//! them was a bug.** They are both "not Minder right now", but they carry
//! opposite amounts of information:
//!
//!   - `Foreign` is *proof*. Some other server owns this port and said so.
//!   - `Unreachable` is the *absence* of information. The most likely cause on a
//!     cold boot is our own server still starting up: the OS completes the TCP
//!     handshake from the listen backlog with no application code involved, so
//!     the port reads as bound while the Node process is still blocked opening a
//!     large SQLite index. A 2.1 GB index measured 2m47s of blocked event loop,
//!     against this agent's 4s timeout — so the tray would time out, conclude
//!     "foreign process", and latch that verdict for the rest of the session
//!     while the perfectly healthy service finished booting behind it.
//!
//! A timeout is not evidence of foreignness. Callers must treat `Unreachable` as
//! "ask again later", never as a settled verdict.

use std::net::{TcpStream, ToSocketAddrs};
use std::sync::OnceLock;
use std::time::Duration;

use crate::config::HOST;

/// One process-wide `ureq::Agent`, built once and reused across every ~15s poll
/// (and the startup attach probe). `ureq::Agent` is a cheap `Arc`-backed handle
/// that pools connections; rebuilding it per probe threw that away each time.
/// `pub(crate)` so the manual-steps notification poller (`notify.rs`) can share
/// it instead of building a second agent for the same loopback host.
pub(crate) fn agent() -> &'static ureq::Agent {
    static AGENT: OnceLock<ureq::Agent> = OnceLock::new();
    AGENT.get_or_init(|| {
        ureq::AgentBuilder::new()
            .timeout(Duration::from_secs(4))
            .build()
    })
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ServerStatus {
    Up,
    Degraded,
    /// Something answered over HTTP, but the body isn't Minder-shaped.
    Foreign,
    /// Nothing answered: connection refused, timed out, or DNS failed.
    Unreachable,
}

impl ServerStatus {
    /// Whether a Minder server (healthy or degraded) answered — the signal the
    /// startup attach decision keys on.
    pub fn is_minder(self) -> bool {
        matches!(self, ServerStatus::Up | ServerStatus::Degraded)
    }

    /// Whether this probe settles the question of who owns the port. Only
    /// `Unreachable` is inconclusive — see the module header. Callers deciding
    /// spawn-vs-attach must keep re-probing while this is false rather than
    /// committing to a verdict they can't support.
    pub fn is_conclusive(self) -> bool {
        !matches!(self, ServerStatus::Unreachable)
    }
}

/// Cheap liveness check: can we open a TCP connection to the port at all?
/// Used before the (more expensive) health GET when deciding spawn-vs-attach.
pub fn port_is_bound(port: u16) -> bool {
    let addr = match (HOST, port).to_socket_addrs() {
        Ok(mut it) => match it.next() {
            Some(a) => a,
            None => return false,
        },
        Err(_) => return false,
    };
    TcpStream::connect_timeout(&addr, Duration::from_millis(500)).is_ok()
}

/// Probe `GET /api/health` and classify the result. Never panics; a transport
/// error yields `Unreachable` and an unparseable body yields `Foreign`.
pub fn probe(port: u16) -> ServerStatus {
    let url = format!("http://{HOST}:{port}/api/health");

    // The probe presents its real Host (`127.0.0.1:<port>`, from the URL) — the
    // server's allowlist is port-aware (src/proxy.ts derives it from the bound
    // PORT), so a loopback host on the bound port is accepted on any port.
    // Both the 2xx and the 503-"degraded" arms carry the same body shape, so
    // normalize to (code, body) and classify once.
    //
    // A transport failure (connection refused / timeout / DNS) is `Unreachable`,
    // NOT `Foreign`: nobody answered, so we've learned nothing about who owns
    // the port. Distinguishing the two is the whole point of the split — see the
    // module header.
    let (code, body) = match agent().get(&url).call() {
        Ok(resp) => (200u16, resp.into_string().unwrap_or_default()),
        Err(ureq::Error::Status(code, resp)) => (code, resp.into_string().unwrap_or_default()),
        Err(_) => return ServerStatus::Unreachable,
    };
    classify_body(code, body)
}

/// Pure classification of an HTTP status + body string. Extracted so the
/// mapping is unit-testable without a live server. Trusts the server's own
/// `ok` verdict — the health route already folds `db.state` (and anything else)
/// into that boolean, so we don't second-guess it here.
pub fn classify_body(http_status: u16, body: String) -> ServerStatus {
    // Everything below this point has an HTTP answer in hand, so every outcome
    // is conclusive: it's either Minder or it demonstrably isn't.
    let json: serde_json::Value = match serde_json::from_str(&body) {
        Ok(v) => v,
        // Something answered but it isn't JSON — not a Minder server.
        Err(_) => return ServerStatus::Foreign,
    };

    // A Minder health body always carries a boolean `ok` and a string `status`.
    // Anything missing those isn't Minder — and because it *answered*, that's
    // proof of a foreign process rather than a slow one.
    let has_status = json.get("status").and_then(|v| v.as_str()).is_some();
    let ok = match json.get("ok").and_then(|v| v.as_bool()) {
        Some(ok) if has_status => ok,
        _ => return ServerStatus::Foreign,
    };

    if http_status == 200 && ok {
        ServerStatus::Up
    } else {
        // Minder answered but isn't healthy: 503, or a defensive `ok:false`.
        ServerStatus::Degraded
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn healthy_200_ok_is_up() {
        let body = r#"{"ok":true,"status":"ok","version":"1.2.0","db":{"state":"success"}}"#;
        assert_eq!(classify_body(200, body.to_string()), ServerStatus::Up);
    }

    #[test]
    fn degraded_503_body_is_degraded() {
        let body =
            r#"{"ok":false,"status":"degraded","version":"1.2.0","db":{"state":"in-flight"}}"#;
        assert_eq!(classify_body(503, body.to_string()), ServerStatus::Degraded);
    }

    #[test]
    fn trusts_server_ok_not_db_state() {
        // Contradictory synthetic body (ok:true but db idle) the real server
        // would never send — proves we key off `ok`, not `db.state`.
        let body = r#"{"ok":true,"status":"ok","version":"1.2.0","db":{"state":"idle"}}"#;
        assert_eq!(classify_body(200, body.to_string()), ServerStatus::Up);
    }

    #[test]
    fn ok_false_is_degraded_even_on_200() {
        let body = r#"{"ok":false,"status":"degraded","version":"1.2.0","db":{"state":"idle"}}"#;
        assert_eq!(classify_body(200, body.to_string()), ServerStatus::Degraded);
    }

    #[test]
    fn foreign_json_is_foreign() {
        // No `ok`/`status` fields → not Minder. It answered, so this is proof.
        let body = r#"{"hello":"world"}"#;
        assert_eq!(classify_body(200, body.to_string()), ServerStatus::Foreign);
    }

    #[test]
    fn non_json_is_foreign() {
        assert_eq!(
            classify_body(200, "<html>nginx</html>".to_string()),
            ServerStatus::Foreign
        );
    }

    #[test]
    fn partial_minder_body_is_foreign() {
        // `status` present but `ok` missing — shaped like Minder's but isn't.
        let body = r#"{"status":"ok"}"#;
        assert_eq!(classify_body(200, body.to_string()), ServerStatus::Foreign);
    }

    #[test]
    fn up_and_degraded_are_minder() {
        assert!(ServerStatus::Up.is_minder());
        assert!(ServerStatus::Degraded.is_minder());
        assert!(!ServerStatus::Foreign.is_minder());
        assert!(!ServerStatus::Unreachable.is_minder());
    }

    #[test]
    fn only_unreachable_is_inconclusive() {
        // The invariant the whole split exists to encode: a timeout tells us
        // nothing about ownership, so it must never settle the decision. Every
        // other outcome had an HTTP answer behind it.
        assert!(ServerStatus::Up.is_conclusive());
        assert!(ServerStatus::Degraded.is_conclusive());
        assert!(ServerStatus::Foreign.is_conclusive());
        assert!(!ServerStatus::Unreachable.is_conclusive());
    }

    #[test]
    fn classify_body_never_returns_unreachable() {
        // `classify_body` only ever runs when something answered, so it must
        // not be able to produce the "nothing answered" verdict. Guards against
        // a future edit reintroducing the conflation this split removed.
        for (code, body) in [
            (200u16, r#"{"ok":true,"status":"ok"}"#),
            (503, r#"{"ok":false,"status":"degraded"}"#),
            (200, r#"{"hello":"world"}"#),
            (404, "<html>nginx</html>"),
            (500, ""),
        ] {
            assert_ne!(
                classify_body(code, body.to_string()),
                ServerStatus::Unreachable,
                "classify_body({code}, {body:?}) must be conclusive"
            );
        }
    }
}
