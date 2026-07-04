import { ChildProcess } from "child_process";
import path from "path";
import { promises as fs } from "fs";
import net from "net";
import {
  getCleanSpawnEnv,
  spawnDevServer,
  killProcessTree,
  getBinPath,
} from "./platform";

export interface DevServerInfo {
  slug: string;
  projectPath: string;
  pid: number;
  port?: number;
  command: string;
  startedAt: string;
  status: "starting" | "running" | "stopped" | "errored";
  output: string[];
}

const MAX_OUTPUT_LINES = 200;

// S2 defense-in-depth: the API route (src/app/api/dev-server/[slug]/route.ts)
// already validates `port` before calling us, but this is the last line of
// defense before an attacker- or bug-controlled value reaches
// `String(portOverride)` in the spawn args below and in platform.ts. Treat
// anything that isn't a plausible TCP port as "no override" rather than
// throwing — portOverride is optional by design, and a confused caller
// shouldn't crash the whole start()/restart() call.
function sanitizePort(port: number | undefined): number | undefined {
  if (port === undefined || port === null) return undefined;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined;
  return port;
}

class ProcessManager {
  private processes = new Map<string, { proc: ChildProcess; info: DevServerInfo }>();

  getAll(): DevServerInfo[] {
    return Array.from(this.processes.values()).map((p) => p.info);
  }

  get(slug: string): DevServerInfo | undefined {
    return this.processes.get(slug)?.info;
  }

  isRunning(slug: string): boolean {
    const entry = this.processes.get(slug);
    return !!entry && (entry.info.status === "running" || entry.info.status === "starting");
  }

  async start(slug: string, projectPath: string, portOverride?: number): Promise<DevServerInfo> {
    portOverride = sanitizePort(portOverride);

    if (this.isRunning(slug)) {
      return this.processes.get(slug)!.info;
    }

    // S4 — reserve the slot synchronously, before the first `await` below.
    // Without this, two overlapping start() calls for the same slug both
    // pass the isRunning() check above (the map entry doesn't exist yet),
    // both proceed to detect a command and spawn, and the first child gets
    // silently overwritten in `this.processes` — orphaned, untracked, and
    // never killed by stop(). Setting a "starting" placeholder here means a
    // concurrent call's isRunning() check sees it and returns early instead
    // of racing. The placeholder's `proc` is a stub — it's replaced
    // wholesale once the real child process spawns below, and removed if we
    // bail out before then (port detection throws, port already in use).
    const placeholderInfo: DevServerInfo = {
      slug,
      projectPath,
      pid: 0,
      port: portOverride,
      command: "",
      startedAt: new Date().toISOString(),
      status: "starting",
      output: [],
    };
    this.processes.set(slug, { proc: {} as ChildProcess, info: placeholderInfo });

    let detected: { command: string; args: string[]; port?: number };
    try {
      detected = await this.detectDevCommand(projectPath);
    } catch (err) {
      // Don't leave a zombie "starting" placeholder behind if detection throws
      // — but only remove it if it's still OURS. A concurrent start() during
      // this await may have superseded our placeholder; deleting unconditionally
      // would drop the newer entry (S4 race).
      if (this.processes.get(slug)?.info === placeholderInfo) {
        this.processes.delete(slug);
      }
      throw err;
    }

    // Apply port override if provided
    const port = portOverride || detected.port;
    let { command, args } = detected;
    if (portOverride && portOverride !== detected.port) {
      // Replace port in args
      const portIdx = args.indexOf("--port");
      if (portIdx !== -1 && portIdx + 1 < args.length) {
        args = [...args];
        args[portIdx + 1] = String(portOverride);
      }
    }

    // Check if port is already in use
    if (port) {
      const inUse = await isPortInUse(port);
      if (inUse) {
        // Clean up the placeholder — but only if it's still OURS. A concurrent
        // stop() then start() during the isPortInUse() await above can replace
        // this entry with a newer start's placeholder (or a spawned child);
        // deleting unconditionally would drop that newer entry and leave its
        // child untracked/unstoppable (S4 race). We still return the errored
        // result — this start() spawned nothing regardless.
        if (this.processes.get(slug)?.info === placeholderInfo) {
          this.processes.delete(slug);
        }
        return {
          slug,
          projectPath,
          pid: 0,
          port,
          command: `${command} ${args.join(" ")}`,
          startedAt: new Date().toISOString(),
          status: "errored",
          output: [`Port ${port} is already in use.`],
        };
      }
    }

    // S4 (race) — pre-spawn guard. detectDevCommand() and isPortInUse() above
    // both yield the event loop, so a stop() (or a superseding start()) can
    // land on the "starting" placeholder we registered before them. stop()
    // mutates that exact object — the one we still hold as `placeholderInfo` —
    // flipping its status to "stopped". If we spawned now, the caller who
    // already received a "stopped" response would be left with a live server
    // running behind their back. Re-check ownership before committing a child.
    const entryBeforeSpawn = this.processes.get(slug);
    if (entryBeforeSpawn?.info !== placeholderInfo) {
      // A concurrent start() superseded us and owns the slot now — report
      // whatever it registered rather than spawning a duplicate.
      return entryBeforeSpawn?.info ?? placeholderInfo;
    }
    if (placeholderInfo.status === "stopped") {
      // A concurrent stop() cancelled us during the awaits above. Clear the
      // slot so it reads as stopped and don't spawn.
      this.processes.delete(slug);
      return placeholderInfo;
    }

    const info: DevServerInfo = {
      slug,
      projectPath,
      pid: 0,
      port,
      command: `${command} ${args.join(" ")}`,
      startedAt: new Date().toISOString(),
      status: "starting",
      output: [],
    };

    // Use the binary directly (not npm run which inherits Node IPC).
    // Minimal env to avoid leaking Next.js/Turbopack runtime state.
    const cleanEnv = getCleanSpawnEnv();
    const proc = spawnDevServer(command, args, projectPath, cleanEnv);

    info.pid = proc.pid || 0;

    const appendOutput = (data: Buffer) => {
      const lines = data.toString().split("\n").filter((l) => l.trim());
      for (const line of lines) {
        info.output.push(line);
        if (info.output.length > MAX_OUTPUT_LINES) {
          info.output.shift();
        }
        if (
          info.status === "starting" &&
          (line.includes("Ready") ||
            line.includes("ready") ||
            line.includes("started") ||
            line.includes("listening") ||
            line.includes("Local:"))
        ) {
          info.status = "running";
        }
      }
    };

    proc.stdout?.on("data", appendOutput);
    proc.stderr?.on("data", appendOutput);

    proc.on("close", (code) => {
      info.status = code === 0 ? "stopped" : "errored";
      if (code !== null && code !== 0) {
        info.output.push(`Process exited with code ${code}`);
      }
    });

    proc.on("error", (err) => {
      info.status = "errored";
      info.output.push(`Error: ${err.message}`);
    });

    // Replace the placeholder with the real process/info now that the
    // process has actually spawned.
    this.processes.set(slug, { proc, info });

    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Only promote to "running" if a concurrent stop() didn't remove/replace
    // our entry (or already flip it to stopped/errored) while we waited.
    if (
      this.processes.get(slug)?.info === info &&
      info.status === "starting" &&
      proc.exitCode === null
    ) {
      info.status = "running";
    }

    return info;
  }

  async stop(slug: string): Promise<DevServerInfo | undefined> {
    const entry = this.processes.get(slug);
    if (!entry) return undefined;

    const { proc, info } = entry;

    if (proc.exitCode === null && proc.pid) {
      await killProcessTree(proc.pid);
    }

    info.status = "stopped";
    info.output.push("--- Server stopped ---");
    return info;
  }

  async restart(slug: string, projectPath: string, portOverride?: number): Promise<DevServerInfo> {
    portOverride = sanitizePort(portOverride);
    const prevPort = this.processes.get(slug)?.info.port;
    await this.stop(slug);
    // Wait for the OS to release the port the old process held, instead of a
    // blind fixed sleep. Bounded so a stuck port can't hang the request.
    const targetPort = portOverride ?? prevPort;
    if (targetPort) {
      const deadlineMs = 5000;
      const stepMs = 200;
      let waited = 0;
      while (waited < deadlineMs && (await isPortInUse(targetPort))) {
        await new Promise((r) => setTimeout(r, stepMs));
        waited += stepMs;
      }
    }
    this.processes.delete(slug);
    return this.start(slug, projectPath, portOverride);
  }

  private async detectDevCommand(
    projectPath: string
  ): Promise<{ command: string; args: string[]; port?: number }> {
    try {
      const raw = await fs.readFile(
        path.join(projectPath, "package.json"),
        "utf-8"
      );
      const pkg = JSON.parse(raw);
      const scripts = pkg.scripts || {};
      const devScript = scripts.dev || scripts.start || "";

      // Detect port from script. Matches --port N, --port=N, -p N, -pN (B6).
      const portMatch = devScript.match(/(?:--port[= ]|-p ?)(\d+)/);
      const envMatch = devScript.match(/PORT=(\d+)/);
      let port: number | undefined;

      if (portMatch) port = parseInt(portMatch[1], 10);
      else if (envMatch) port = parseInt(envMatch[1], 10);

      // Detect the tool and build a direct command with explicit port.
      // We call the binary directly (not npm run) to avoid inheriting
      // Node.js IPC channels from the parent Turbopack server.
      if (devScript.includes("next")) {
        if (!port) port = 3000;
        return {
          command: getBinPath(projectPath, "next"),
          args: ["dev", "--port", String(port)],
          port,
        };
      }

      if (devScript.includes("vite")) {
        if (!port) port = 5173;
        return {
          command: getBinPath(projectPath, "vite"),
          args: ["--port", String(port)],
          port,
        };
      }

      // Fallback: use npx to run the dev script
      if (!port) port = 3000;
      return {
        command: "npm",
        args: ["run", scripts.dev ? "dev" : "start"],
        port,
      };
    } catch {
      // No package.json
    }

    return { command: "npm", args: ["run", "dev"], port: undefined };
  }
}

function isPortInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(true));
    server.once("listening", () => {
      server.close();
      resolve(false);
    });
    server.listen(port, "127.0.0.1");
  });
}

/**
 * Find the next free port starting at startPort.
 * The checker parameter is injectable for testability.
 */
export async function findFreePort(
  startPort: number,
  maxAttempts = 10,
  checker: (port: number) => Promise<boolean> = isPortInUse
): Promise<number | null> {
  for (let i = 0; i < maxAttempts; i++) {
    const port = startPort + i;
    if (!(await checker(port))) return port;
  }
  return null;
}

// Singleton — persist across hot reloads in dev
const globalForPM = globalThis as unknown as { __processManager?: ProcessManager };
export const processManager =
  globalForPM.__processManager || (globalForPM.__processManager = new ProcessManager());
