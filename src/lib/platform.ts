import { spawn, ChildProcess } from "child_process";
// Namespace import, NOT `import { existsSync }`: a named binding is resolved
// when the module graph loads, so every test that does a partial `vi.mock("fs")`
// without listing existsSync would fail at import time — in a module this
// widely imported that was 13 unrelated test files. Accessing it off the
// namespace defers to call time, and `fsExists` guards the mocked case.
import * as nodeFs from "fs";
import path from "path";
import os from "os";

export const isWindows = process.platform === "win32";

/**
 * The directories to look for projects in, in preference order, when the user
 * has not configured `devRoot`/`devRoots` in `.minder.json`.
 *
 * `C:\dev` leads on Windows because it's this tool's original convention and
 * an existing install must keep resolving there — but it is a convention, not
 * a guarantee, so a home-relative `~/dev` follows it. On POSIX only the
 * home-relative form is meaningful.
 */
export function getDevRootCandidates(): string[] {
  const homeDev = path.join(os.homedir(), "dev");
  return isWindows ? ["C:\\dev", homeDev] : [homeDev];
}

/**
 * Returns the default dev root for the current platform — the FIRST candidate,
 * whether or not it exists on disk.
 *
 * This is the "we must produce a path" answer, used as `MinderConfig.devRoot`'s
 * default so the config shape stays non-nullable for every existing consumer.
 * To ask the different question "is there actually anywhere worth scanning?",
 * use `probeDefaultDevRoot()` — a fresh install where neither candidate exists
 * should onboard the user rather than silently scan a directory that isn't
 * there and render an empty dashboard that looks broken.
 */
export function getDefaultDevRoot(): string {
  return getDevRootCandidates()[0];
}

/**
 * The first candidate dev root that actually EXISTS, or `null` if none do.
 *
 * `null` is the first-run signal: it means this machine has no conventional
 * project directory, so we can't guess, and the UI should ask instead. It is
 * deliberately distinct from "the configured root is currently empty" (a
 * legitimate steady state we must not interrupt).
 *
 * @param exists injectable for tests — defaults to a real filesystem probe.
 */
/**
 * Real-filesystem existence check, tolerant of a partially-mocked `fs`.
 *
 * `config.ts` calls `probeDefaultDevRoot()` at MODULE scope to seed
 * `DEFAULT_DEV_ROOT`, so this runs during import in any test that touches the
 * config module. Under a partial `fs` mock `existsSync` is simply absent —
 * reporting "not found" there yields exactly the pre-probe default, whereas
 * throwing would break unrelated suites.
 */
function fsExists(p: string): boolean {
  return typeof nodeFs.existsSync === "function" ? nodeFs.existsSync(p) : false;
}

export function probeDefaultDevRoot(
  exists: (p: string) => boolean = fsExists
): string | null {
  for (const candidate of getDevRootCandidates()) {
    try {
      if (exists(candidate)) return candidate;
    } catch {
      // An unreadable candidate (permissions, a disconnected drive) is not a
      // usable root — keep probing rather than failing the whole first-run
      // check, which would strand the user with no dashboard at all.
    }
  }
  return null;
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
export function killProcessTree(pid: number): Promise<void> {
  return new Promise<void>((resolve) => {
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
        resolve();
      });
      taskkill.on("close", () => resolve());
      return;
    }
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      // Process may have already exited
    }
    resolve();
  });
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
 *
 * NOTE: this does NOT lowercase — it's also used for display. For
 * case-insensitive Map keying (Windows drive letters/segments can differ in
 * case between what Claude Code recorded and what the scanner sees), use
 * `normalizePathKey` instead.
 */
export function normalizePath(p: string): string {
  return p.replace(/\\/g, "/");
}

/**
 * Case-insensitive variant of `normalizePath`, for Map/Set keys that compare
 * paths recorded by different sources (e.g. Claude Code's history.jsonl vs.
 * a freshly-scanned directory). Windows paths are case-insensitive on disk
 * but `normalizePath` alone doesn't account for that, so a `C:` vs `c:` or
 * `Foo` vs `foo` mismatch silently misses lookups (see B1). Never use this
 * for display — only as a comparison/lookup key.
 */
export function normalizePathKey(p: string): string {
  // \\wsl$\X and \\wsl.localhost\X are aliases for the same distro tree —
  // canonicalize the legacy host so keys built from mixed sources (a legacy
  // config entry vs a Detect-WSL suggestion, a history.jsonl recorded against
  // either form) compare equal. Never used for display, so the rewrite is safe.
  const normalized = normalizePath(p).replace(/^\/\/wsl\$(?=\/)/i, "//wsl.localhost");
  // Only fold case on case-insensitive filesystems (Windows). On POSIX,
  // `/home/me/foo` and `/home/me/Foo` are DIFFERENT directories, so
  // lowercasing would merge distinct projects and misattribute their sessions
  // (PR #251 review). The B1 mismatch this guards against — a history.jsonl
  // drive-letter/segment casing differing from the scanned dir — is a Windows
  // concern to begin with.
  return isWindows ? normalized.toLowerCase() : normalized;
}

/**
 * Derive the normalized key of the Claude home that owns a session JSONL
 * from the file's own path. Every Claude session file lives under
 * `<home>/projects/<encoded-dir>/…` (optionally one `<session-id>/subagents/`
 * level deeper), so the home is the prefix before the LAST `/projects/`
 * segment — last, not first, because a home path may itself contain a
 * `projects` segment (`D:\projects\.claude`), while nothing AFTER the home
 * can: encoded dir names are single dash-encoded segments and the only
 * deeper directories are `<uuid>/subagents/`.
 *
 * Returns the same key space as `normalizePathKey(home)` — the form
 * `UsageTurn.homeKey` and `sessions.home_key` are stamped in — or null for
 * a path with no `/projects/` segment (adapter sessions, test fixtures).
 */
export function sessionFileHomeKey(sessionFilePath: string): string | null {
  const key = normalizePathKey(sessionFilePath);
  const i = key.lastIndexOf("/projects/");
  return i > 0 ? key.slice(0, i) : null;
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
