import { spawn, execFile, type ChildProcess } from "child_process";
import { promises as fs } from "fs";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { tryParseJsonc } from "./scanner/util/jsonc";
import type { McpServer } from "./types";

/**
 * Opt-in real health check for stdio MCP servers: spawn the server and perform
 * an MCP `initialize` JSON-RPC handshake, upgrading the verdict from mere
 * "launchable" (command resolves on PATH) to genuine "responds to the
 * protocol". Gated behind the default-off `mcpHealthStdioProbe` flag because it
 * starts the actual server process, which may connect to real backends.
 *
 * Secrets: a stdio server usually needs its `env` block (credentials) to start
 * cleanly, but Minder deliberately never *retains* env values. So we re-read the
 * raw values transiently here, pass them straight to the spawned child, and let
 * them fall out of scope — they are never stored on the health verdict, cached,
 * or logged. This mirrors what Claude Code itself does to launch the server.
 */

const HANDSHAKE_TIMEOUT_MS = 4_000;
// Cap buffered stdout so a command that streams a huge unterminated line (or
// continuous non-JSON noise) can't make Minder retain arbitrary output per
// in-flight probe. An initialize response is tiny; 64 KB is generous.
const MAX_STDOUT_BYTES = 64 * 1024;

// Only these vars are inherited by the spawned server — never all of
// `process.env`. Minder may be launched with unrelated credentials (shell
// tokens, service-manager secrets); passing the whole environment to every
// configured MCP server during a health check would leak them and undermine the
// transient-secret model (the server gets ONLY its own declared env + the
// minimum needed to actually run: PATH, temp dirs, home, and on Windows the
// vars cmd.exe requires).
const INHERITED_ENV_KEYS = [
  "PATH", "Path", "PATHEXT",
  "HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH",
  "SystemRoot", "windir", "ComSpec", "OS", "NUMBER_OF_PROCESSORS",
  "TEMP", "TMP", "APPDATA", "LOCALAPPDATA", "ProgramData",
  "ProgramFiles", "ProgramFiles(x86)", "ProgramW6432",
  "LANG", "LC_ALL", "LC_CTYPE", "TZ", "SHELL", "USER", "LOGNAME", "NODE_ENV",
];

/** A minimal inherited environment — the vars a process needs to launch,
 *  nothing more. Merged with (and overridden by) the server's own env. */
function minimalEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of INHERITED_ENV_KEYS) {
    const v = process.env[key];
    if (typeof v === "string") out[key] = v;
  }
  return out;
}

const INITIALIZE_REQUEST = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    // Advertise the current protocol version from the bundled MCP SDK (not a
    // pinned old revision), so a server that dropped older revisions still
    // negotiates instead of rejecting the handshake as unsupported.
    protocolVersion: LATEST_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "project-minder-health", version: "1.0.0" },
  },
};

export interface StdioProbeResult {
  ok: boolean;
  detail: string;
}

export interface StdioProbeOptions {
  timeoutMs?: number;
  /** Injected for tests. */
  spawnFn?: typeof spawn;
  /** Injected for tests — resolves the server's env values. */
  readEnv?: (server: McpServer) => Promise<Record<string, string>>;
  /** Injected for tests — tears down the spawned child. */
  killFn?: (child: ChildProcess) => void;
}

/**
 * Transiently read the `env` VALUES for one server from its source config file
 * so the spawned handshake process starts with its credentials. The returned
 * map is used only for the spawn and must never be stored or logged. Returns
 * `{}` when the server declares no env or the file can't be read.
 *
 * Only the top-level `mcpServers[name].env` shape is handled — that covers every
 * source the global strip shows (user / settings.json / plugin / desktop /
 * managed); per-project "local" servers aren't on the global strip.
 */
async function readServerEnvValues(server: McpServer): Promise<Record<string, string>> {
  if (!server.envKeys?.length) return {};
  try {
    const raw = await fs.readFile(server.sourcePath, "utf-8");
    const doc = tryParseJsonc<{
      mcpServers?: Record<string, { env?: Record<string, unknown> }>;
    }>(raw);
    const env = doc?.mcpServers?.[server.name]?.env;
    if (!env || typeof env !== "object") return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(env)) {
      if (typeof v === "string") out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

/** External-process strings (server name / error message) are shown in the UI,
 *  so collapse whitespace and cap length — a malicious/buggy server can't blow
 *  out the popover layout, tooltips, or logs with a huge or newline-filled
 *  value. */
function normalizeDetail(v: unknown): string {
  if (v == null) return "";
  return String(v).replace(/\s+/g, " ").trim().slice(0, 60);
}

/** Redact the server's own transient env values from any text before it's
 *  cached/returned. A server can echo a credential it just received (a bad
 *  token, a DSN) in its initialize error; that text flows into the health
 *  `detail`, so scrub the known secret values first. */
function redactSecrets(text: string, env: Record<string, string>): string {
  let out = text;
  for (const value of Object.values(env)) {
    // Skip trivially short values to avoid over-redacting common substrings.
    if (value && value.length >= 4) out = out.split(value).join("***");
  }
  return out;
}

/** Kill the spawned child AND its tree. The configured command is often a
 *  wrapper (`npx`, `sh -c …`, a `.cmd` shim) that runs the real server as a
 *  grandchild, and a bare `child.kill()` leaves that grandchild running. On
 *  Windows use `taskkill /T`; on POSIX the child is spawned `detached` (its own
 *  process group), so a negative-PID signal reaches the whole group. */
function killChild(child: ChildProcess): void {
  if (!child.pid) {
    try {
      child.kill();
    } catch {
      /* already dead */
    }
    return;
  }
  if (process.platform === "win32") {
    try {
      execFile("taskkill", ["/F", "/T", "/PID", String(child.pid)], () => {});
      return;
    } catch {
      /* fall through to child.kill */
    }
  } else {
    try {
      process.kill(-child.pid, "SIGKILL"); // negative PID → the process group
      return;
    } catch {
      /* fall through to child.kill */
    }
  }
  try {
    child.kill("SIGKILL");
  } catch {
    /* already dead */
  }
}

/**
 * Spawn the stdio server, send `initialize`, and resolve once we see a matching
 * JSON-RPC response (`result` → up, `error` → down), the process exits early, a
 * spawn error occurs, or the timeout elapses. Fully defensive — never throws;
 * always tears down the child.
 */
export async function probeStdioHandshake(
  server: McpServer,
  opts: StdioProbeOptions = {},
): Promise<StdioProbeResult> {
  if (!server.command) return { ok: false, detail: "no command to spawn" };

  const timeoutMs = opts.timeoutMs ?? HANDSHAKE_TIMEOUT_MS;
  const spawnFn = opts.spawnFn ?? spawn;
  const readEnv = opts.readEnv ?? readServerEnvValues;
  const kill = opts.killFn ?? killChild;

  // Transient: server env values live only in this call's scope.
  const serverEnv = await readEnv(server);

  return new Promise<StdioProbeResult>((resolve) => {
    let child: ChildProcess;
    try {
      const isWin = process.platform === "win32";
      child = spawnFn(server.command as string, server.args ?? [], {
        // Minimal inherited env + the server's own env — never all of
        // process.env (would leak Minder's unrelated secrets to the server).
        // Cast: the ProcessEnv augmentation marks NODE_ENV required, which a
        // plain Record<string,string> can't statically satisfy.
        env: { ...minimalEnv(), ...serverEnv } as NodeJS.ProcessEnv,
        // Spawn where the server expects (relative scripts/config resolve
        // correctly) — undefined falls back to the current directory.
        cwd: server.cwd,
        windowsHide: true,
        // Windows: npx/npm/pnpm resolve to `.cmd` shims that Node can't exec
        // directly (must go through cmd.exe) — without this, launchable servers
        // would spuriously report "spawn error". POSIX: run in a fresh process
        // group so killChild can tear down the whole tree, not just a wrapper.
        shell: isWin,
        detached: !isWin,
        stdio: ["pipe", "pipe", "ignore"],
      });
    } catch {
      resolve({ ok: false, detail: "failed to spawn" });
      return;
    }

    let done = false;
    let buf = "";
    let timer: ReturnType<typeof setTimeout>;

    const finish = (result: StdioProbeResult) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      kill(child);
      resolve(result);
    };

    timer = setTimeout(
      () => finish({ ok: false, detail: "no initialize response (timed out)" }),
      timeoutMs,
    );

    child.on("error", (err: NodeJS.ErrnoException) => {
      finish({
        ok: false,
        detail: err.code === "ENOENT" ? "command not found" : "spawn error",
      });
    });
    // The server dying before answering is a failure (crash, bad env, etc.).
    child.on("exit", () => finish({ ok: false, detail: "exited before initialize response" }));

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      buf += chunk;
      if (buf.length > MAX_STDOUT_BYTES) {
        finish({ ok: false, detail: "excessive output before initialize response" });
        return;
      }
      // MCP stdio framing is line-delimited JSON; servers also log non-JSON to
      // stdout sometimes, so parse per line and ignore anything that isn't our
      // response.
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg: unknown;
        try {
          msg = JSON.parse(line);
        } catch {
          continue; // server log line, not a JSON-RPC frame
        }
        const m = msg as { id?: unknown; result?: Record<string, unknown>; error?: { message?: unknown } };
        if (m.id !== 1) continue;
        if (m.result && typeof m.result === "object") {
          // A real MCP initialize result carries protocolVersion + capabilities
          // + serverInfo. Requiring them stops a broken JSON-RPC process that
          // just echoes `{"id":1,"result":{}}` from earning a green dot.
          const result = m.result as {
            protocolVersion?: unknown;
            capabilities?: unknown;
            serverInfo?: { name?: unknown; version?: unknown };
          };
          const info = result.serverInfo;
          const valid =
            typeof result.protocolVersion === "string" &&
            !!result.capabilities &&
            typeof result.capabilities === "object" &&
            !!info &&
            typeof info === "object" &&
            // MCP requires serverInfo.name + serverInfo.version — a real client
            // rejects init without them, so a `serverInfo: {}` isn't healthy.
            typeof info.name === "string" &&
            typeof info.version === "string";
          if (valid) {
            const name = normalizeDetail(info.name);
            finish({ ok: true, detail: `initialize ok${name ? ` — ${name}` : ""}` });
          } else {
            finish({ ok: false, detail: "invalid initialize response (missing required fields)" });
          }
        } else if (m.error) {
          const message = normalizeDetail(redactSecrets(String(m.error.message ?? ""), serverEnv));
          finish({ ok: false, detail: `initialize error${message ? `: ${message}` : ""}` });
        }
        return;
      }
    });

    // A command that closes stdin early (daemonizes, exits after validation)
    // can fail the write ASYNCHRONOUSLY via an 'error'/EPIPE on the stream —
    // without this listener that would be an unhandled error crashing the
    // server, not a down verdict. Attach before writing.
    child.stdin?.on("error", () => finish({ ok: false, detail: "stdin unavailable (closed early)" }));
    try {
      child.stdin?.write(JSON.stringify(INITIALIZE_REQUEST) + "\n");
    } catch {
      finish({ ok: false, detail: "failed to send initialize" });
    }
  });
}
