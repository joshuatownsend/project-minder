//! Environment-driven configuration for the Minder tray supervisor.
//!
//! Everything the tray needs to locate and launch (or attach to) the packaged
//! Next server is resolved from the environment, so the same binary works in a
//! dev checkout (env-pointed payload, custom port to avoid the live service)
//! and in a packaged install (payload under the Tauri resource dir, default
//! port 4100).

use std::env;
use std::path::PathBuf;

/// Default port the packaged Minder server binds — matches `pnpm start` and the
/// Phase A service wrappers. Overridable via `MINDER_TRAY_PORT` (the knob used
/// to test the tray without touching the user's live :4100 service).
pub const DEFAULT_PORT: u16 = 4100;

/// The loopback host the sidecar binds. Never 0.0.0.0 — Minder is a local-only
/// dashboard and must not be reachable off-box.
pub const HOST: &str = "127.0.0.1";

/// The `Host` header the server's DNS-rebind allowlist accepts
/// (`src/proxy.ts` `ALLOWED_HOSTS`, hardcoded to `:4100`). The server 403s any
/// `/api/*` request whose `Host` isn't on that list — so a health probe to a
/// non-4100 `MINDER_TRAY_PORT` would be rejected. The tray's probe is a trusted
/// loopback self-probe (no browser, no DNS-rebind vector), so it presents this
/// canonical served host regardless of the bound port.
///
/// Making the server allowlist port-aware is tracked in GitHub issue #283
/// (the pre-existing CSRF/host allowlist pinned to :4100); this Rust workaround
/// stays until that lands, at which point update this together with `proxy.ts`.
pub const PROBE_HOST_HEADER: &str = "localhost:4100";

#[derive(Clone, Debug)]
pub struct TrayConfig {
    /// Port the sidecar binds / the tray probes and opens.
    pub port: u16,
    /// `node` executable, overridable via `MINDER_NODE_PATH` (resolved from PATH
    /// otherwise).
    pub node_path: String,
    /// `MINDER_TRAY_ATTACH=1` — skip spawning entirely and only observe an
    /// already-running server (dev iteration mode).
    pub attach: bool,
    /// `MINDER_SERVER_DIST` — dev override pointing directly at a
    /// `dist/minder-server` build. Takes precedence over the resource dir.
    pub server_dist_override: Option<PathBuf>,
}

impl TrayConfig {
    /// Read config from the process environment. Never fails — every field has a
    /// safe default.
    pub fn from_env() -> Self {
        let port = env::var("MINDER_TRAY_PORT")
            .ok()
            .and_then(|s| s.trim().parse::<u16>().ok())
            .filter(|p| *p > 0)
            .unwrap_or(DEFAULT_PORT);

        let node_path = env::var("MINDER_NODE_PATH")
            .ok()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| "node".to_string());

        let attach = env::var("MINDER_TRAY_ATTACH").ok().as_deref() == Some("1");

        let server_dist_override = env::var("MINDER_SERVER_DIST")
            .ok()
            .filter(|s| !s.trim().is_empty())
            .map(PathBuf::from);

        TrayConfig {
            port,
            node_path,
            attach,
            server_dist_override,
        }
    }

    /// Resolve the directory that holds `server.js`.
    ///
    /// `MINDER_SERVER_DIST` (dev) wins; otherwise `<resource_dir>/minder-server`
    /// (production — the tray bundles the packaged server as a Tauri resource).
    pub fn payload_dir(&self, resource_dir: Option<&PathBuf>) -> Option<PathBuf> {
        if let Some(dist) = &self.server_dist_override {
            return Some(dist.clone());
        }
        resource_dir.map(|d| d.join("minder-server"))
    }

    /// The dashboard URL a browser should open. `localhost` (not `127.0.0.1`) to
    /// match the plan's copy and the DNS-rebind allowlist the MCP server pins.
    pub fn dashboard_url(&self) -> String {
        format!("http://localhost:{}", self.port)
    }
}
