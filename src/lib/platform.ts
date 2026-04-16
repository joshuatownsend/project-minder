import { spawn, ChildProcess } from "child_process";
import path from "path";
import os from "os";

export const isWindows = process.platform === "win32";

/**
 * Returns the default dev root for the current platform.
 * Can be overridden via .minder.json devRoot/devRoots.
 */
export function getDefaultDevRoot(): string {
  return isWindows ? "C:\\dev" : path.join(os.homedir(), "dev");
}

/**
 * Returns a minimal clean environment for spawned dev server processes.
 * Avoids leaking Next.js/Turbopack IPC state from the parent process.
 */
export function getCleanSpawnEnv(): Record<string, string> {
  if (isWindows) {
    return {
      SystemRoot: process.env.SystemRoot || "C:\\Windows",
      PATH: process.env.PATH || "",
      USERPROFILE: process.env.USERPROFILE || "",
      HOME: process.env.HOME || process.env.USERPROFILE || "",
      APPDATA: process.env.APPDATA || "",
      LOCALAPPDATA: process.env.LOCALAPPDATA || "",
      TEMP: process.env.TEMP || "",
      TMP: process.env.TMP || "",
      NODE_ENV: "development",
      FORCE_COLOR: "0",
    };
  }
  return {
    PATH: process.env.PATH || "",
    HOME: process.env.HOME || os.homedir(),
    SHELL: process.env.SHELL || "/bin/sh",
    USER: process.env.USER || "",
    LANG: process.env.LANG || "en_US.UTF-8",
    TERM: process.env.TERM || "xterm",
    TMPDIR: process.env.TMPDIR || "/tmp",
    NODE_ENV: "development",
    FORCE_COLOR: "0",
  };
}

/**
 * Spawns a dev server process in a cross-platform way.
 *
 * On Windows: wraps the command in `cmd.exe /c` because .cmd files cannot
 * be spawned directly when combined with detached mode (EINVAL).
 *
 * On Unix: spawns the binary directly with detached:true to create a new
 * process group. This is required for killProcessTree() to work correctly
 * via negative-PID group signal. These two functions are a matched pair.
 */
export function spawnDevServer(
  command: string,
  args: string[],
  cwd: string,
  env: Record<string, string>
): ChildProcess {
  if (isWindows) {
    return spawn("cmd.exe", ["/c", command, ...args], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: env as NodeJS.ProcessEnv,
    });
  }
  return spawn(command, args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    env: env as NodeJS.ProcessEnv,
    detached: true,
  });
}

/**
 * Kills a process and its entire process tree.
 *
 * On Windows: uses `taskkill /F /T /PID` to force-kill the process tree.
 * On Unix: sends SIGTERM to the process group via negative PID. This only
 * works when the process was spawned with detached:true (see spawnDevServer).
 * These two functions are a matched pair.
 */
export function killProcessTree(pid: number): void {
  if (isWindows) {
    const taskkill = spawn("taskkill", ["/F", "/T", "/PID", String(pid)], {
      stdio: "ignore",
    });
    taskkill.on("error", () => {
      try {
        process.kill(pid);
      } catch {
        // Process may have already exited
      }
    });
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    // Process may have already exited
  }
}

/**
 * Returns the path to a binary in a project's node_modules/.bin/.
 * On Windows, npm creates .cmd shim files; Unix uses extensionless files.
 */
export function getBinPath(projectPath: string, binName: string): string {
  const ext = isWindows ? ".cmd" : "";
  return path.join(projectPath, "node_modules", ".bin", binName + ext);
}

/**
 * Normalizes a filesystem path to forward slashes.
 * Used for consistent Map key comparison — forward slashes work on all
 * platforms in Node.js, and Claude Code's history.jsonl uses them on Unix.
 */
export function normalizePath(p: string): string {
  return p.replace(/\\/g, "/");
}

/**
 * Decodes a Claude Code project directory name back to an absolute path.
 *
 * Claude encodes project paths by replacing separators with dashes:
 *   Windows: C:\dev\foo  →  C--dev-foo   (starts with drive letter + dash)
 *   Unix:    /home/u/dev →  -home-u-dev  (starts with a dash)
 *
 * The two formats are unambiguous: Windows starts with `[A-Z]-`, Unix with `-`.
 */
export function decodeDirName(dirName: string): string {
  if (/^[A-Z]-/.test(dirName)) {
    // Windows format: restore drive colon and convert dashes to backslashes
    return dirName.replace(/^([A-Z])-/, "$1:").replace(/-/g, "\\");
  }
  if (dirName.startsWith("-")) {
    // Unix format: leading dash represents the root slash, rest are path separators
    return dirName.replace(/-/g, "/");
  }
  // Unrecognized format — return unchanged rather than silently corrupting
  return dirName;
}
