//! Health probing against the server's `GET /api/health` contract.
//!
//! The route (src/app/api/health/route.ts) already computes the verdict: it
//! returns `ok` (true only when the DB state machine reached `success`) and
//! `status` ("ok"/"degraded"), with HTTP 200 when healthy and 503 otherwise —
//! all carrying the full body. We trust those server-computed fields rather
//! than re-deriving health from `db.state` ourselves, and map onto three tray
//! states:
//!   - Up: HTTP 200 and the server's own `ok` is true.
//!   - Degraded: a Minder-shaped response that isn't healthy (503, or `ok:false`).
//!   - Down: no response at all, or a response that isn't Minder's.

use std::net::{TcpStream, ToSocketAddrs};
use std::sync::OnceLock;
use std::time::Duration;

use crate::config::{HOST, PROBE_HOST_HEADER};

/// One process-wide `ureq::Agent`, built once and reused across every ~15s poll
/// (and the startup attach probe). `ureq::Agent` is a cheap `Arc`-backed handle
/// that pools connections; rebuilding it per probe threw that away each time.
fn agent() -> &'static ureq::Agent {
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
    Down,
}

impl ServerStatus {
    /// Whether a Minder server (healthy or degraded) answered — the signal the
    /// startup attach decision keys on.
    pub fn is_minder(self) -> bool {
        matches!(self, ServerStatus::Up | ServerStatus::Degraded)
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

/// Probe `GET /api/health` and classify the result. Never panics; any
/// transport error or unparseable body degrades to `Down`.
pub fn probe(port: u16) -> ServerStatus {
    let url = format!("http://{HOST}:{port}/api/health");

    // Present the server's canonical allowed Host (see PROBE_HOST_HEADER) so the
    // probe passes the DNS-rebind allowlist on any bound port, not just 4100.
    // Both the 2xx and the 503-"degraded" arms carry the same body shape, so
    // normalize to (code, body) and classify once; only a transport failure
    // (connection refused / timeout / DNS) is an outright Down.
    let (code, body) = match agent().get(&url).set("Host", PROBE_HOST_HEADER).call() {
        Ok(resp) => (200u16, resp.into_string().unwrap_or_default()),
        Err(ureq::Error::Status(code, resp)) => (code, resp.into_string().unwrap_or_default()),
        Err(_) => return ServerStatus::Down,
    };
    classify_body(code, body)
}

/// Pure classification of an HTTP status + body string. Extracted so the
/// mapping is unit-testable without a live server. Trusts the server's own
/// `ok` verdict — the health route already folds `db.state` (and anything else)
/// into that boolean, so we don't second-guess it here.
pub fn classify_body(http_status: u16, body: String) -> ServerStatus {
    let json: serde_json::Value = match serde_json::from_str(&body) {
        Ok(v) => v,
        // Something answered but it isn't JSON — not a Minder server.
        Err(_) => return ServerStatus::Down,
    };

    // A Minder health body always carries a boolean `ok` and a string `status`.
    // Anything missing those isn't Minder → treat as Down (a foreign process on
    // the port).
    let has_status = json.get("status").and_then(|v| v.as_str()).is_some();
    let ok = match json.get("ok").and_then(|v| v.as_bool()) {
        Some(ok) if has_status => ok,
        _ => return ServerStatus::Down,
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
    fn foreign_json_is_down() {
        // No `ok`/`status` fields → not Minder.
        let body = r#"{"hello":"world"}"#;
        assert_eq!(classify_body(200, body.to_string()), ServerStatus::Down);
    }

    #[test]
    fn non_json_is_down() {
        assert_eq!(
            classify_body(200, "<html>nginx</html>".to_string()),
            ServerStatus::Down
        );
    }

    #[test]
    fn up_and_degraded_are_minder() {
        assert!(ServerStatus::Up.is_minder());
        assert!(ServerStatus::Degraded.is_minder());
        assert!(!ServerStatus::Down.is_minder());
    }
}
