//! Environment-driven configuration for the Minder tray supervisor.
//!
//! Everything the tray needs to locate and launch (or attach to) the packaged
//! Next server is resolved from the environment, so the same binary works in a
//! dev checkout (env-pointed payload, custom port to avoid the live service)
//! and in a packaged install (payload under the Tauri resource dir, default
//! port 4100).

use std::env;
use std::path::{Path, PathBuf};

/// Default port the packaged Minder server binds — matches `pnpm start` and the
/// Phase A service wrappers. Overridable via `MINDER_TRAY_PORT` (the knob used
/// to test the tray without touching the user's live :4100 service).
pub const DEFAULT_PORT: u16 = 4100;

/// The loopback host the sidecar binds. Never 0.0.0.0 — Minder is a local-only
/// dashboard and must not be reachable off-box.
pub const HOST: &str = "127.0.0.1";

#[derive(Clone, Debug)]
pub struct TrayConfig {
    /// Port the sidecar binds / the tray probes and opens.
    pub port: u16,
    /// `node` executable the supervisor spawns. Resolved once at startup (see
    /// [`TrayConfig::node_command`]): an explicit `MINDER_NODE_PATH` override, a
    /// Node runtime bundled beside the packaged resources, or `node` from PATH.
    /// `from_env` seeds it with the override-or-`node` default so it is always
    /// valid even before the resource dir is known (dev / tests); `main.rs`
    /// upgrades it to the bundled runtime once the resource dir resolves.
    pub node_path: String,
    /// The raw `MINDER_NODE_PATH` override, if the operator set one. Kept
    /// separate from the resolved `node_path` so [`node_command`] can honour an
    /// explicit override over a bundled runtime without string-sniffing the
    /// default. `None` when unset/blank.
    pub node_path_override: Option<String>,
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

        let node_path_override = env::var("MINDER_NODE_PATH")
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        let node_path = node_path_override
            .clone()
            .unwrap_or_else(|| "node".to_string());

        let attach = env::var("MINDER_TRAY_ATTACH").ok().as_deref() == Some("1");

        let server_dist_override = env::var("MINDER_SERVER_DIST")
            .ok()
            .filter(|s| !s.trim().is_empty())
            .map(PathBuf::from);

        TrayConfig {
            port,
            node_path,
            node_path_override,
            attach,
            server_dist_override,
        }
    }

    /// Resolve the `node` executable the supervisor should spawn, given the
    /// Tauri resource dir (`None` in dev / tests).
    ///
    /// Precedence: an explicit `MINDER_NODE_PATH` override wins; otherwise a
    /// Node runtime bundled beside the packaged resources
    /// (`<resource_dir>/node/…`, laid down by the C4 packaging workflow);
    /// otherwise `node` from PATH (the dev-checkout default). The filesystem
    /// probe is delegated to [`resolve_node_path`] so the precedence is
    /// unit-testable without a real bundle on disk.
    pub fn node_command(&self, resource_dir: Option<&PathBuf>) -> String {
        resolve_node_path(
            self.node_path_override.as_deref(),
            resource_dir.map(|d| d.as_path()),
            |p| p.exists(),
        )
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

/// Candidate absolute paths for a Node runtime bundled as the Tauri `node`
/// resource. The C4 packaging workflow downloads a pinned Node runtime for the
/// target OS and lays it out under `<resource_dir>/node/` so these paths match:
/// `node/node.exe` on Windows, `node/bin/node` on macOS/Linux.
fn bundled_node_candidates(resource_dir: &Path) -> Vec<PathBuf> {
    let base = resource_dir.join("node");
    if cfg!(windows) {
        vec![base.join("node.exe")]
    } else {
        vec![base.join("bin").join("node")]
    }
}

/// Pure Node-path resolution — the filesystem probe is injected via `exists` so
/// the precedence is unit-testable without a real bundle on disk.
///
/// Precedence: explicit override (`MINDER_NODE_PATH`) > a Node runtime bundled
/// beside the packaged resources > `node` from PATH.
fn resolve_node_path(
    override_path: Option<&str>,
    resource_dir: Option<&Path>,
    exists: impl Fn(&Path) -> bool,
) -> String {
    if let Some(o) = override_path {
        let trimmed = o.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    if let Some(rd) = resource_dir {
        if let Some(bundled) = bundled_node_candidates(rd).into_iter().find(|p| exists(p)) {
            return bundled.to_string_lossy().into_owned();
        }
    }
    "node".to_string()
}

#[cfg(test)]
mod node_resolution_tests {
    use super::{bundled_node_candidates, resolve_node_path};
    use std::path::{Path, PathBuf};

    fn rd() -> PathBuf {
        PathBuf::from(if cfg!(windows) {
            r"C:\Program Files\Project Minder Tray\resources"
        } else {
            "/opt/minder/resources"
        })
    }

    #[test]
    fn explicit_override_wins_over_everything() {
        // Even with a bundled runtime present (exists → always true), an
        // explicit MINDER_NODE_PATH takes precedence.
        let got = resolve_node_path(Some("/custom/node"), Some(rd().as_path()), |_| true);
        assert_eq!(got, "/custom/node");
    }

    #[test]
    fn blank_override_is_ignored() {
        // A blank/whitespace override must not shadow the bundled runtime.
        let expected = bundled_node_candidates(rd().as_path())[0].clone();
        let got = resolve_node_path(Some("   "), Some(rd().as_path()), |p| {
            p == expected.as_path()
        });
        assert_eq!(got, expected.to_string_lossy());
    }

    #[test]
    fn bundled_runtime_used_when_present_and_no_override() {
        let expected = bundled_node_candidates(rd().as_path())[0].clone();
        let got = resolve_node_path(None, Some(rd().as_path()), |p| p == expected.as_path());
        assert_eq!(got, expected.to_string_lossy());
    }

    #[test]
    fn falls_back_to_path_when_no_bundle_and_no_override() {
        // Resource dir given but nothing bundled → PATH lookup.
        let got = resolve_node_path(None, Some(rd().as_path()), |_| false);
        assert_eq!(got, "node");
    }

    #[test]
    fn falls_back_to_path_in_dev_with_no_resource_dir() {
        // Dev checkout: no resource dir at all → PATH lookup.
        let got = resolve_node_path(None, None, |_| panic!("must not probe without a dir"));
        assert_eq!(got, "node");
    }

    #[test]
    fn bundled_candidate_layout_matches_workflow() {
        let cands = bundled_node_candidates(Path::new("/res"));
        let joined = cands[0].to_string_lossy().replace('\\', "/");
        if cfg!(windows) {
            assert!(joined.ends_with("/node/node.exe"), "got {joined}");
        } else {
            assert!(joined.ends_with("/node/bin/node"), "got {joined}");
        }
    }
}
