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
import { createRequire } from "node:module";
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
 * Escapes a value for embedding in a systemd unit file directive (F9 review
 * fix): `%` starts a "specifier" expansion (`%h` = home dir, `%%` = a
 * literal percent, etc.) in EVERY directive value across an entire unit
 * file — not just `ExecStart=` — so a literal `%` in a path (e.g. a
 * username or directory containing one) must be doubled or systemd will
 * try to expand it as a specifier and likely fail to parse the unit.
 *
 * Deliberately NOT handled here: a literal backslash character inside a
 * path. systemd's `ExecStart=` quoting is C-string-like — backslash starts
 * an escape sequence (`\\`, `\"`, `\t`, ...) inside a quoted argument — so a
 * literal backslash in a Linux filename (legal on that filesystem, but
 * exceedingly rare in practice — no shell or tool set makes this easy to
 * produce by accident) could be misinterpreted. Spaces ARE handled: every
 * `ExecStart=` argument is wrapped in `quoteArg`'s double quotes regardless
 * of whether it needs it, which systemd's own quoting rules accept.
 * `WorkingDirectory=`/`Environment=` take single un-split path/value
 * strings (not an argv vector), so they need percent-escaping but never
 * quoting.
 */
export function escapeSystemdPercent(value) {
  return String(value).replace(/%/g, "%%");
}

/**
 * Resolves the `next` CLI's own JS entry point (not the node_modules/.bin
 * shell shim) via `createRequire` rooted at the target repo's package.json
 * — this walks the SAME resolution pnpm/node would use from that repo,
 * rather than hardcoding a `node_modules/next/dist/bin/next` path that
 * could be wrong under a different pnpm layout or next version.
 *
 * F7 review fix: the fallback launch used to be the `node_modules/.bin/next`
 * (or `.cmd` on Windows) shell shim, spawned via a shell wrapper. That shim
 * starts with `#!/usr/bin/env node` — on macOS/Linux, a login-scoped service
 * environment (launchd/systemd --user) frequently has NO `PATH` entry for a
 * version-managed `node` (nvm/asdf shims live in a shell-rc-sourced PATH that
 * a service manager never sources), so the shim fails immediately. Resolving
 * this repo's own `next` bin JS file and launching it directly as
 * `execPath <resolved bin> start -p 4100` — the exact same shape as the
 * standalone mode's `execPath <server.js>` — sidesteps PATH entirely: the
 * only Node binary involved is the one `service:install` already resolved
 * via `process.execPath` at install time. This also means the fallback mode
 * no longer needs a `.cmd` shell wrapper on Windows (see the former
 * `needsCmdWrapper` field, removed).
 */
function defaultResolveNextBin(root) {
  const requireFromRoot = createRequire(path.join(root, "package.json"));
  return requireFromRoot.resolve("next/dist/bin/next");
}

/**
 * Decides how to launch the server, preferring the standalone package (C0,
 * `dist/minder-server/server.js`) over a from-source `next start` fallback
 * (which needs a completed `pnpm build` — `.next/BUILD_ID` is the marker).
 * Returns null when neither build exists — the caller must refuse to
 * install and tell the user how to build.
 *
 * Both modes launch as `execPath <js entry point> [args]` — no shell, no
 * PATH lookup, no `.cmd`/shebang shim — which is also what makes the
 * fallback launch identifiable by `buildServerIdentityMarkers` /
 * `commandLineMatchesServer` below (the resolved next bin path is a marker
 * candidate the same way the standalone server.js path is).
 *
 * All OS/fs dependencies are injectable so this is unit-testable without
 * touching the real filesystem, `process.execPath`, or the real `next`
 * package.
 *
 * @param {{
 *   root: string,
 *   execPath?: string,
 *   platform?: string,
 *   existsSync?: (path: string) => boolean,
 *   resolveNextBin?: (root: string) => string,
 * }} opts
 */
export function resolveServerLaunch(opts) {
  const {
    root,
    execPath = process.execPath,
    existsSync = fsExistsSync,
    resolveNextBin = defaultResolveNextBin,
  } = opts;
  const standaloneServer = path.join(root, "dist", "minder-server", "server.js");
  if (existsSync(standaloneServer)) {
    const cwd = path.join(root, "dist", "minder-server");
    return {
      mode: "standalone",
      exe: execPath,
      args: [standaloneServer],
      cwd,
    };
  }

  const buildId = path.join(root, ".next", "BUILD_ID");
  if (existsSync(buildId)) {
    let nextBinPath;
    try {
      nextBinPath = resolveNextBin(root);
    } catch {
      // next itself must have run to produce .next/BUILD_ID, so this
      // shouldn't happen in practice — but degrade to "no usable build"
      // rather than throw, so the caller's NO_BUILD_MESSAGE guidance kicks
      // in instead of an uncaught exception.
      return null;
    }
    return {
      mode: "fallback",
      exe: execPath,
      // F8 review fix: `next start` defaults `--hostname`/`-H` to `0.0.0.0`
      // (verified against this repo's own installed Next version via
      // `node node_modules/next/dist/bin/next start --help`) — without an
      // explicit hostname, the login-scoped autostart service would expose
      // this LOCAL-ONLY dashboard on every network interface, not just
      // loopback. `-p`/`--port` DOES fall back to the PORT env var per
      // that same --help output, but `-H`/`--hostname` has no documented
      // env fallback, so it must be passed as an explicit arg here rather
      // than relying on the HOSTNAME env var the templates already set
      // (that env var is for the standalone server.js path, which reads
      // process.env.HOSTNAME directly — "next start" does not).
      args: [nextBinPath, "start", "-p", "4100", "--hostname", "127.0.0.1"],
      cwd: root,
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
          // Deliberately does NOT include daemon-reload here (F4 review
          // fix): scripts/service.mjs's runUninstall() removes the unit
          // FILE after this "disable --now" step runs but BEFORE it issues
          // its own separate daemon-reload — reversing that order (reload
          // while the file still exists, delete it after) leaves systemd's
          // unit cache pointing at a file that's already gone until the
          // next unrelated reload happens to fix it.
          return [{ exe: "systemctl", args: ["--user", "disable", "--now", ctx.unitName] }];
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

/**
 * Process-identity verification for `service:stop` (Windows).
 *
 * "Something is LISTENING on port 4100" is NOT proof it's THIS Minder
 * installation — a `pnpm dev`, another Minder checkout, or literally any
 * other process can hold that port. An earlier version of this script
 * hard-killed whatever it found there unconditionally and took down an
 * unrelated live dev server during this task's own verification pass.
 * These two functions are the fix: build an identity descriptor for the
 * process THIS installation would have started, then check a candidate
 * PID's actual command line against it before anything gets `taskkill`ed.
 *
 * @typedef {{ sufficient: string[], nextStartSignature: { nextBinPath: string } | null }} ServerIdentity
 *
 * `sufficient` markers (F6 review fix — ENTRY-POINT grade only, never a bare
 * directory): matching ANY ONE of these alone is proof enough —
 *   - the standalone server's absolute `dist/minder-server/server.js` path
 *     (the node.exe command line IS `node.exe "<that path>"`).
 *   - the generated run-hidden.vbs path, in case wscript.exe itself is
 *     still the process found (unlikely — it exits immediately after
 *     firing WshShell.Run — but harmless to include).
 *
 * `nextStartSignature` (fallback mode only) requires BOTH halves to match,
 * not either alone: the resolved absolute `next/dist/bin/next` path AND a
 * standalone `start` argument token elsewhere in the same command line.
 * The bin path alone is NOT sufficient (unlike the standalone server.js
 * path above) because `next dev` and `next start` re-exec the EXACT SAME
 * bin script, differing only in that one subcommand argument — treating the
 * bin path as sufficient on its own would match an ordinary `pnpm dev` run
 * from this same checkout, which is exactly the original incident this
 * whole identity check exists to prevent (one step removed). The repo root
 * itself is deliberately NEVER used as a marker for the same reason, one
 * level up: it's even less specific than the bin path.
 *
 * @param {{ root?: string, launch?: { mode?: string, args?: string[] } | null, vbsPath?: string }} [opts]
 * @returns {ServerIdentity}
 */
export function buildServerIdentityMarkers(opts = {}) {
  const { launch, vbsPath } = opts;
  const sufficient = new Set();
  let nextStartSignature = null;

  if (launch) {
    for (const arg of launch.args ?? []) {
      if (!isPathLikeArg(arg)) continue; // F1: never a bare flag/subcommand/port number
      if (launch.mode === "fallback") {
        // The next bin path is the entry point for BOTH `next dev` and
        // `next start` — recorded as a signature requiring an accompanying
        // start token, never added to `sufficient` directly (F6).
        nextStartSignature = { nextBinPath: arg };
      } else {
        // Standalone mode's server.js is THIS installation's own unique
        // entry point — not shared with any dev-mode invocation — so it's
        // safe to treat as sufficient on its own.
        sufficient.add(arg);
      }
    }
  }
  if (vbsPath) sufficient.add(vbsPath);

  return { sufficient: Array.from(sufficient), nextStartSignature };
}

/** True only for args that contain a path separator — excludes bare flags, subcommands, and bare numbers (port numbers) from ever becoming identity markers. */
function isPathLikeArg(arg) {
  return typeof arg === "string" && (arg.includes("/") || arg.includes("\\"));
}

/**
 * True if `commandLine` (as reported by the OS for a candidate PID) matches
 * `identity` — either a boundary-delimited hit against any `sufficient`
 * marker, or (fallback mode) a hit against `nextStartSignature.nextBinPath`
 * COMBINED with a standalone `start` token appearing anywhere else in the
 * same command line (F6: neither half is enough by itself — `next dev`
 * from the same repo must be refused).
 *
 * Boundary matching (F2 review fix): a bare substring match would let a
 * marker like `C:\repo\dist\minder-server` match an unrelated
 * `C:\repo\dist\minder-server2\...` — a match only counts if the character
 * immediately after the marker is a separator, quote, whitespace, or
 * end-of-string.
 *
 * @param {string | null | undefined} commandLine
 * @param {ServerIdentity} identity
 */
export function commandLineMatchesServer(commandLine, identity) {
  if (!commandLine) return false;
  const normalized = String(commandLine).replace(/\\/g, "/").toLowerCase();

  const sufficient = identity?.sufficient ?? [];
  for (const marker of sufficient) {
    if (marker && hasBoundaryMatch(normalized, normalizeForMatch(marker))) return true;
  }

  const nextBinPath = identity?.nextStartSignature?.nextBinPath;
  if (
    nextBinPath &&
    hasBoundaryMatch(normalized, normalizeForMatch(nextBinPath)) &&
    hasStandaloneStartToken(normalized)
  ) {
    return true;
  }

  return false;
}

function normalizeForMatch(value) {
  return String(value).replace(/\\/g, "/").toLowerCase();
}

/** Characters that legitimately terminate a path/token match in a command line. */
const BOUNDARY_CHARS = new Set(["/", '"', "'", " ", "\t"]);

/** Every occurrence of `needle` in `haystack` (both already normalized) is checked — not just the first — since an earlier, boundary-failing occurrence must not shadow a later, genuine one. */
function hasBoundaryMatch(haystack, needle) {
  if (!needle) return false;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    const nextChar = haystack[idx + needle.length];
    if (nextChar === undefined || BOUNDARY_CHARS.has(nextChar)) return true;
    idx = haystack.indexOf(needle, idx + 1);
  }
  return false;
}

/**
 * True if `normalized` (already lowercased/slash-normalized) contains a
 * standalone `start` ARGUMENT token — split only on whitespace/quotes (not
 * `/`), so a whole path segment like `.../start/next` stays one token and
 * can't be confused with the bare word "start". This is deliberately NOT
 * anchored to sit immediately next to the next-bin-path reference: `next
 * start` and `next dev` both place the subcommand right after the bin path
 * in every command line this script itself constructs, but requiring strict
 * adjacency would be brittle against quoting/argv-joining differences in
 * how various OS APIs report a process's command line. Documented limit:
 * this only reduces risk, it doesn't eliminate it — a process that (a)
 * happens to invoke THIS install's own resolved next bin file AND (b)
 * separately has a bare "start" token anywhere in its command line would
 * still match. Combining both conditions makes that a genuine coincidence
 * rather than a generic footgun like the bare-substring or bare-flag issues
 * this whole identity check exists to close.
 */
function hasStandaloneStartToken(normalized) {
  const tokens = normalized.split(/["'\s]+/).filter(Boolean);
  return tokens.includes("start");
}
