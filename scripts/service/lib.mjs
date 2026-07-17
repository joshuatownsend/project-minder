// Pure logic for scripts/service.mjs (A3 — per-OS autostart wrappers).
//
// Kept separate from scripts/service.mjs so tests/serviceScript.test.ts can
// exercise template substitution, build detection, and platform/action
// dispatch mapping WITHOUT spawning real `schtasks` / `launchctl` /
// `systemctl` subprocesses (per CLAUDE.md's house rule — subprocess calls
// use execFile with argument arrays, never shell strings — and per this
// task's test scope: "pure parts only... don't spawn real schtasks in
// tests"). scripts/service.mjs imports from here and does the actual file
// writes + subprocess execution.

import { existsSync as fsExistsSync } from "node:fs";
import path from "node:path";

export const WINDOWS_TASK_NAME = "MinderDashboard";
export const LAUNCHD_LABEL = "com.minder.dashboard";
export const SYSTEMD_UNIT_NAME = "minder.service";

/** Substitutes `{{KEY}}` tokens in `template` with `vars[KEY]`. Throws on an unresolved token — a missing var is a bug in the caller, not something to ship half-substituted. */
export function renderTemplate(template, vars) {
  return template.replace(/\{\{(\w+)\}\}/g, (whole, key) => {
    if (!Object.prototype.hasOwnProperty.call(vars, key)) {
      throw new Error(`renderTemplate: missing value for {{${key}}}`);
    }
    return String(vars[key]);
  });
}

/** Escapes text for use inside XML element content (attribute-safe too). */
export function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Escapes a string for embedding inside a VBScript double-quoted string literal (doubling embedded quotes is VBScript's own escape rule). */
export function escapeVbsString(value) {
  return String(value).replace(/"/g, '""');
}

/**
 * Quotes a single command-line argument by wrapping it in double quotes
 * (always-quote is simplest and safe for paths that may contain spaces).
 * Used both for Windows command lines (WshShell.Run / cmd.exe /c) and
 * systemd's `ExecStart=` (which accepts C-style double-quoted arguments) —
 * NOT for POSIX shell strings in general.
 */
export function quoteArg(arg) {
  return `"${String(arg)}"`;
}

/**
 * Decides how to launch the server, preferring the standalone package (C0,
 * `dist/minder-server/server.js`) over a from-source `next start` fallback
 * (which needs a completed `pnpm build` — `.next/BUILD_ID` is the marker).
 * Returns null when neither build exists — the caller must refuse to
 * install and tell the user how to build.
 *
 * All OS/fs dependencies are injectable so this is unit-testable without
 * touching the real filesystem or `process.execPath`.
 *
 * @param {{
 *   root: string,
 *   execPath?: string,
 *   platform?: string,
 *   existsSync?: (path: string) => boolean,
 * }} opts
 */
export function resolveServerLaunch(opts) {
  const {
    root,
    execPath = process.execPath,
    platform = process.platform,
    existsSync = fsExistsSync,
  } = opts;
  const standaloneServer = path.join(root, "dist", "minder-server", "server.js");
  if (existsSync(standaloneServer)) {
    const cwd = path.join(root, "dist", "minder-server");
    return {
      mode: "standalone",
      exe: execPath,
      args: [standaloneServer],
      cwd,
      needsCmdWrapper: false,
    };
  }

  const buildId = path.join(root, ".next", "BUILD_ID");
  if (existsSync(buildId)) {
    const isWindows = platform === "win32";
    const nextBin = path.join(root, "node_modules", ".bin", isWindows ? "next.cmd" : "next");
    return {
      mode: "fallback",
      exe: nextBin,
      args: ["start", "-p", "4100"],
      cwd: root,
      // .cmd shims can't be spawned directly by CreateProcess-style APIs
      // (Task Scheduler, WshShell.Run) — they need a shell interpreter.
      // Mirrors src/lib/platform.ts's spawnDevServer for the same reason.
      needsCmdWrapper: isWindows,
    };
  }

  return null;
}

/** Human-readable instructions printed when resolveServerLaunch() returns null. */
export const NO_BUILD_MESSAGE = [
  "No build found. Build first, then retry:",
  "  pnpm build && pnpm package:standalone   (recommended: self-contained standalone server)",
  "  pnpm build                              (fallback: runs via next start)",
  "then: pnpm service:install",
].join("\n");

/** Maps process.platform to the three OS kinds this module supports. Throws for anything else (no autostart wrapper exists for it). */
export function detectPlatformKind(platform = process.platform) {
  if (platform === "win32") return "windows";
  if (platform === "darwin") return "macos";
  if (platform === "linux") return "linux";
  throw new Error(`Unsupported platform for service install: ${platform}`);
}

const VALID_ACTIONS = new Set(["install", "uninstall", "status", "start", "stop"]);

export function isValidAction(action) {
  return VALID_ACTIONS.has(action);
}

/**
 * Pure platform/action -> subprocess dispatch mapping. Returns an ordered
 * array of `{ exe, args }` steps to execFile (argument arrays only — never a
 * shell string). `ctx` supplies the paths/names resolved by the caller
 * (taskName, xmlPath, label, plistPath, unitName).
 *
 * Windows `stop` returns an empty array on purpose: Task Scheduler loses
 * track of the node process the moment the wscript.exe launcher exits
 * (WshShell.Run doesn't wait — see windows-run-hidden.vbs.tmpl), so
 * `schtasks /end` has nothing to kill. scripts/service.mjs instead finds the
 * PID(s) listening on port 4100 (parseNetstatListeningPids, below) and hard-
 * kills them via `taskkill /F /T` — the same mechanism src/lib/platform.ts's
 * killProcessTree() uses for managed dev servers, and safe per A2's boot
 * reconcile + WAL recovery. This is a documented Windows limitation, not an
 * oversight — see the comment in scripts/service.mjs's runStop().
 */
export function planActions(platformKind, action, ctx = {}) {
  if (!isValidAction(action)) {
    throw new Error(`Unknown service action: ${action}`);
  }
  switch (platformKind) {
    case "windows":
      switch (action) {
        case "install":
          return [{ exe: "schtasks", args: ["/create", "/tn", ctx.taskName, "/xml", ctx.xmlPath, "/f"] }];
        case "uninstall":
          return [{ exe: "schtasks", args: ["/delete", "/tn", ctx.taskName, "/f"] }];
        case "status":
          return [{ exe: "schtasks", args: ["/query", "/tn", ctx.taskName, "/fo", "LIST", "/v"] }];
        case "start":
          return [{ exe: "schtasks", args: ["/run", "/tn", ctx.taskName] }];
        case "stop":
          return [];
      }
      break;
    case "macos":
      switch (action) {
        case "install":
          return [{ exe: "launchctl", args: ["load", "-w", ctx.plistPath] }];
        case "uninstall":
          return [{ exe: "launchctl", args: ["unload", "-w", ctx.plistPath] }];
        case "status":
          return [{ exe: "launchctl", args: ["list", ctx.label] }];
        case "start":
          return [{ exe: "launchctl", args: ["start", ctx.label] }];
        case "stop":
          return [{ exe: "launchctl", args: ["stop", ctx.label] }];
      }
      break;
    case "linux":
      switch (action) {
        case "install":
          return [
            { exe: "systemctl", args: ["--user", "daemon-reload"] },
            { exe: "systemctl", args: ["--user", "enable", "--now", ctx.unitName] },
          ];
        case "uninstall":
          return [
            { exe: "systemctl", args: ["--user", "disable", "--now", ctx.unitName] },
            { exe: "systemctl", args: ["--user", "daemon-reload"] },
          ];
        case "status":
          return [{ exe: "systemctl", args: ["--user", "status", ctx.unitName, "--no-pager"] }];
        case "start":
          return [{ exe: "systemctl", args: ["--user", "start", ctx.unitName] }];
        case "stop":
          return [{ exe: "systemctl", args: ["--user", "stop", ctx.unitName] }];
      }
      break;
    default:
      throw new Error(`Unsupported platform: ${platformKind}`);
  }
  throw new Error(`Unknown service action: ${action}`);
}

/**
 * Parses `netstat -ano` output for PIDs LISTENING on `port` (Windows only;
 * IPv4 and IPv6 `[::]:port` / `0.0.0.0:port` forms). Pure string parsing —
 * exported so tests can feed it captured sample output instead of the real
 * netstat binary.
 */
export function parseNetstatListeningPids(output, port) {
  const pids = new Set();
  const portSuffix = `:${port}`;
  for (const rawLine of String(output).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith("TCP")) continue;
    if (!/LISTENING/i.test(line)) continue;
    const cols = line.split(/\s+/);
    // Expected columns: Proto  LocalAddress  ForeignAddress  State  PID
    if (cols.length < 5) continue;
    const localAddress = cols[1];
    const state = cols[cols.length - 2];
    const pid = cols[cols.length - 1];
    if (!/^LISTENING$/i.test(state)) continue;
    if (!localAddress.endsWith(portSuffix)) continue;
    if (/^\d+$/.test(pid)) pids.add(pid);
  }
  return Array.from(pids);
}

/**
 * Builds the Windows Task Scheduler user identity string (DOMAIN\username,
 * or just username when no domain is known).
 *
 * @param {{ env?: Record<string, string | undefined>, username?: string }} [opts]
 */
export function resolveWindowsUserId(opts = {}) {
  const { env = process.env, username } = opts;
  const user = username ?? env.USERNAME ?? "";
  const domain = env.USERDOMAIN;
  return domain ? `${domain}\\${user}` : user;
}
