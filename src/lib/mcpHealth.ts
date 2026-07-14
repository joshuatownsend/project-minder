import { promises as fs, constants as fsConstants } from "fs";
import path from "path";
import type { spawn } from "child_process";
import { probeStdioHandshake } from "./mcpStdioProbe";
import type { McpServer, McpHealth, McpHealthStatus } from "./types";

export interface ProbeMcpServerOptions {
  /** PATH-resolution env (defaults to process.env). */
  env?: Record<string, string | undefined>;
  /** Platform for PATH semantics (defaults to process.platform). */
  platform?: NodeJS.Platform;
  /** Opt-in: run a real `initialize` handshake for stdio servers instead of the
   *  launchability check. Gated by the `mcpHealthStdioProbe` flag upstream. */
  stdioHandshake?: boolean;
  /** Injected for tests / tuning. */
  handshakeTimeoutMs?: number;
  spawnFn?: typeof spawn;
  handshakeSpawnHelpers?: {
    readEnv?: (server: McpServer) => Promise<Record<string, string>>;
    killFn?: (child: import("child_process").ChildProcess) => void;
  };
}

/**
 * MCP server health probing — the pure, testable half of the live "MCP
 * integrations health strip" (ported from agentic-os-dashboard, but honest
 * about what each transport can actually assert).
 *
 * What "health" means per transport:
 *  - http / sse — a real reachability probe. ANY HTTP response (even 401 /
 *    405 / 406) proves the server is listening, so that's "up". A connection
 *    failure or timeout is "down". `fetch` resolves on response *headers*, so
 *    an SSE endpoint that holds its body open still reads as up in time.
 *  - stdio — we CANNOT verify health without spawning the server (which starts
 *    the real process, with side effects), so the honest signal is "does the
 *    command resolve on PATH": launchable ("up") vs missing ("down"). The
 *    `probeKind: "command"` marker keeps the UI from over-claiming.
 *  - anything else (disabled, unknown transport) — "unknown", no probe.
 */

const HTTP_TIMEOUT_MS = 5_000;

/**
 * Access check for command resolution. On win32 we only need existence
 * (executability there is decided by extension via PATHEXT, not a mode bit);
 * on POSIX we require the execute bit (X_OK), so a file that's on PATH but not
 * executable isn't reported as "launchable" — the real spawn would fail with
 * EACCES.
 */
async function isAccessible(p: string, mode: number): Promise<boolean> {
  try {
    await fs.access(p, mode);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve whether `command` is launchable from PATH WITHOUT spawning it.
 * Pure (env + platform injected) so it's unit-testable. Windows-aware:
 * tries the bare name plus every PATHEXT extension. Returns the resolved
 * path, or null if not found on PATH.
 */
export async function resolveCommandOnPath(
  command: string,
  env: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform,
): Promise<string | null> {
  if (!command) return null;

  const isWin = platform === "win32";
  // Use the platform-pure path implementation matching the injected `platform`,
  // not the host's — so PATH splitting/joining honors `platform: "win32"` even
  // when running on POSIX (and vice-versa), and the unit tests exercise real
  // Windows semantics rather than the host's.
  const p = isWin ? path.win32 : path.posix;
  const mode = isWin ? fsConstants.F_OK : fsConstants.X_OK;
  const exts = isWin
    ? ["", ...(env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").map((e) => e.trim()).filter(Boolean)]
    : [""];
  const withExts = (base: string) => exts.map((e) => base + e);

  // Explicit path (absolute, or relative with a separator): resolve directly,
  // never against PATH.
  if (command.includes("/") || command.includes("\\")) {
    for (const cand of withExts(command)) {
      if (await isAccessible(cand, mode)) return cand;
    }
    return null;
  }

  // Bare name: scan each PATH dir. (Windows populates `Path`; POSIX `PATH`.)
  const raw = env.PATH ?? env.Path ?? "";
  const dirs = raw.split(p.delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const cand of withExts(p.join(dir, command))) {
      if (await isAccessible(cand, mode)) return cand;
    }
  }
  return null;
}

/**
 * Probe an http/sse endpoint for reachability. Any HTTP status is "up"; only a
 * transport-level failure (refused / DNS / timeout) is "down". We never read
 * the body — `fetch` resolving means headers arrived, which is all we need —
 * and we cancel the stream so an SSE endpoint doesn't leak a held-open socket.
 */
async function probeHttp(url: string): Promise<{ status: McpHealthStatus; detail: string }> {
  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      headers: { accept: "text/event-stream, application/json" },
    });
    try {
      await res.body?.cancel();
    } catch {
      /* stream already closed — ignore */
    }
    return { status: "up", detail: `reachable (HTTP ${res.status})` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const timedOut = /timeout|timed out|abort/i.test(msg);
    return {
      status: "down",
      detail: timedOut ? "no response (timed out)" : "unreachable (connection failed)",
    };
  }
}

/**
 * Probe one configured MCP server. Fully defensive — never throws; the caller
 * (the cache) stamps `checkedAt`.
 */
export async function probeMcpServer(
  server: McpServer,
  opts: ProbeMcpServerOptions = {},
): Promise<Omit<McpHealth, "checkedAt">> {
  const { env = process.env, platform = process.platform, stdioHandshake = false } = opts;
  const base = { name: server.name, transport: server.transport, source: server.source };

  if (server.disabled) {
    return { ...base, status: "unknown", detail: "disabled in settings", probeKind: "none" };
  }

  if ((server.transport === "http" || server.transport === "sse") && server.url) {
    const r = await probeHttp(server.url);
    return { ...base, status: r.status, detail: r.detail, probeKind: "http" };
  }

  if (server.transport === "stdio" && server.command) {
    // Opt-in: a real `initialize` handshake (spawns the server) beats the
    // launchability check when the flag is on.
    if (stdioHandshake) {
      const r = await probeStdioHandshake(server, {
        timeoutMs: opts.handshakeTimeoutMs,
        spawnFn: opts.spawnFn,
        readEnv: opts.handshakeSpawnHelpers?.readEnv,
        killFn: opts.handshakeSpawnHelpers?.killFn,
      });
      return {
        ...base,
        status: r.ok ? "up" : "down",
        detail: r.detail,
        probeKind: "handshake",
      };
    }
    const resolved = await resolveCommandOnPath(server.command, env, platform);
    return resolved
      ? {
          ...base,
          status: "up",
          detail: `launchable — '${server.command}' on PATH (not probed)`,
          probeKind: "command",
        }
      : {
          ...base,
          status: "down",
          detail: `command not found on PATH: '${server.command}'`,
          probeKind: "command",
        };
  }

  return { ...base, status: "unknown", detail: "no probe available for this transport", probeKind: "none" };
}
