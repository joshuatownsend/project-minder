//! Health probing against the server's `GET /api/health` contract.
//!
//! The route (src/app/api/health/route.ts) returns HTTP 200 with `ok:true`
//! only when the DB state machine reached `success`; every other state returns
//! HTTP 503 with `ok:false` and the full body. Both carry
//! `{ status, version, db: { state }, ... }`. We map that onto three tray
//! states:
//!   - Up: HTTP 200 and `db.state === "success"`.
//!   - Degraded: a Minder-shaped response that isn't fully healthy (HTTP 503,
//!     or 200 with a non-success db state).
//!   - Down: no response at all, or a response that isn't Minder's.

use std::net::{TcpStream, ToSocketAddrs};
use std::time::Duration;

use crate::config::{HOST, PROBE_HOST_HEADER};

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
    let agent = ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(4))
        .build();

    // Present the server's canonical allowed Host (see PROBE_HOST_HEADER) so the
    // probe passes the DNS-rebind allowlist on any bound port, not just 4100.
    match agent.get(&url).set("Host", PROBE_HOST_HEADER).call() {
        Ok(resp) => classify_body(200, resp.into_string().unwrap_or_default()),
        // 4xx/5xx come back as Status(code, resp) — 503 is Minder's own
        // "degraded" contract, so we still read and classify the body.
        Err(ureq::Error::Status(code, resp)) => {
            classify_body(code, resp.into_string().unwrap_or_default())
        }
        // Connection refused / timeout / DNS — nothing is answering.
        Err(_) => ServerStatus::Down,
    }
}

/// Pure classification of an HTTP status + body string. Extracted so the
/// mapping is unit-testable without a live server.
pub fn classify_body(http_status: u16, body: String) -> ServerStatus {
    let json: serde_json::Value = match serde_json::from_str(&body) {
        Ok(v) => v,
        // Something answered but it isn't JSON — not a Minder server.
        Err(_) => return ServerStatus::Down,
    };

    // A Minder health body always carries a `status` string and a `db` object.
    let looks_like_minder =
        json.get("status").and_then(|v| v.as_str()).is_some() && json.get("db").is_some();
    if !looks_like_minder {
        return ServerStatus::Down;
    }

    let ok = json.get("ok").and_then(|v| v.as_bool()).unwrap_or(false);
    let db_success = json
        .get("db")
        .and_then(|db| db.get("state"))
        .and_then(|s| s.as_str())
        == Some("success");

    if http_status == 200 && ok && db_success {
        ServerStatus::Up
    } else {
        // Minder answered but isn't fully healthy (503, or 200 with the DB not
        // yet at `success`).
        ServerStatus::Degraded
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn healthy_body_is_up() {
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
    fn ok_200_but_db_not_success_is_degraded() {
        let body = r#"{"ok":true,"status":"ok","version":"1.2.0","db":{"state":"idle"}}"#;
        assert_eq!(classify_body(200, body.to_string()), ServerStatus::Degraded);
    }

    #[test]
    fn foreign_json_is_down() {
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
