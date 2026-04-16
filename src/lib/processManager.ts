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
    if (this.isRunning(slug)) {
      return this.processes.get(slug)!.info;
    }

    const detected = await this.detectDevCommand(projectPath);

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

    this.processes.set(slug, { proc, info });

    await new Promise((resolve) => setTimeout(resolve, 2000));

    if (info.status === "starting" && proc.exitCode === null) {
      info.status = "running";
    }

    return info;
  }

  stop(slug: string): DevServerInfo | undefined {
    const entry = this.processes.get(slug);
    if (!entry) return undefined;

    const { proc, info } = entry;

    if (proc.exitCode === null && proc.pid) {
      killProcessTree(proc.pid);
    }

    info.status = "stopped";
    info.output.push("--- Server stopped ---");
    return info;
  }

  async restart(slug: string, projectPath: string, portOverride?: number): Promise<DevServerInfo> {
    this.stop(slug);
    await new Promise((resolve) => setTimeout(resolve, 2000));
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

      // Detect port from script
      const portMatch = devScript.match(/(?:--port|-p)\s+(\d+)/);
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
