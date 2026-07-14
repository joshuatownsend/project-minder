import { spawn, execFile, type ChildProcess } from "child_process";
import { promises as fs } from "fs";
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

const INITIALIZE_REQUEST = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2024-11-05",
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
        env: { ...process.env, ...serverEnv },
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
          const info = m.result.serverInfo as { name?: string } | undefined;
          const name = normalizeDetail(info?.name);
          finish({ ok: true, detail: `initialize ok${name ? ` — ${name}` : ""}` });
        } else if (m.error) {
          const message = normalizeDetail(m.error.message);
          finish({ ok: false, detail: `initialize error${message ? `: ${message}` : ""}` });
        }
        return;
      }
    });

    try {
      child.stdin?.write(JSON.stringify(INITIALIZE_REQUEST) + "\n");
    } catch {
      finish({ ok: false, detail: "failed to send initialize" });
    }
  });
}
