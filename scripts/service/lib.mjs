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
 * Classifies a FAILED deregistration step (`schtasks /delete`, `launchctl
 * unload`, `systemctl disable`) as either "already missing" — the
 * task/agent/unit simply wasn't registered, a fine and expected outcome for
 * `service:uninstall` — or a REAL failure (permissions, a genuine OS/CLI
 * error) that must block further artifact cleanup (F10 review fix).
 *
 * Before this, `runUninstall` ran the deregistration step, ignored whether
 * it succeeded, and deleted the generated artifacts (vbs/xml on Windows,
 * the plist on macOS, the unit file on Linux) unconditionally — so a real
 * failure (e.g. denied permissions on the Scheduled Tasks store) still
 * reported "uninstalled" and left a REGISTERED task/agent/unit pointing at
 * files that no longer exist.
 *
 * This is pattern-matching against each CLI's own (undocumented, not a
 * stable contract) error text — not a proper structured API — so it is
 * deliberately conservative: an unrecognized error string is treated as a
 * REAL failure (fails safe: abort + keep the artifacts + surface the raw
 * error) rather than risk mis-classifying a genuine failure as "already
 * missing" and deleting artifacts a still-registered entry depends on.
 *
 * @param {string} platformKind — "windows" | "macos" | "linux" expected, but
 *   deliberately typed as a plain string: an unrecognized value has no
 *   registered patterns and simply returns false (never throws), which is
 *   itself part of the fail-safe contract this function provides.
 * @param {{ ok?: boolean, stdout?: string, stderr?: string, error?: string } | null | undefined} result
 */
export function isAlreadyMissingFailure(platformKind, result) {
  if (!result || result.ok) return false;
  const text = `${result.stderr ?? ""} ${result.stdout ?? ""} ${result.error ?? ""}`.toLowerCase();
  if (!text.trim()) return false;

  // F12 review fix: a systemd BUS/DBUS CONNECTION failure ("Failed to
  // connect to bus: No such file or directory") is NOT proof the unit is
  // missing — it means systemctl couldn't even ASK systemd, so the unit's
  // real state is genuinely UNKNOWN. This is exactly the case this module's
  // own tests previously documented as a known misclassification (dbus's
  // socket-missing text collided with the generic "no such file or
  // directory" pattern this used to have for Linux) — this negative guard,
  // checked before any positive pattern below, closes it: any bus/dbus
  // connection failure is ALWAYS a real failure regardless of what else
  // the text contains.
  if (/connect(ing)?\s+to\s+(the\s+)?(bus|dbus)\b/.test(text) || /\bdbus\b[^a-z]{0,20}(connection|socket)/.test(text)) {
    return false;
  }

  const ALREADY_MISSING_PATTERNS = {
    // Observed live in this session: `schtasks /query` (and, per Microsoft's
    // own docs, `/delete`) on a nonexistent task name prints exactly
    // "ERROR: The system cannot find the file specified." regardless of
    // locale-independent exit code 1.
    windows: [/cannot find the file specified/, /the system could not find/],
    // launchctl reads the plist FILE at the given path to determine what to
    // unload — if that file is already gone, common reported text includes
    // "No such file or directory" (reading the path) or "Could not find"/
    // "Not Found" (resolving the label/service).
    macos: [/no such file or directory/, /could not find/, /not found/],
    // Tightened to require "unit"/"unit file" context (F12 review fix) —
    // the previous bare "no such file or directory"/"not found" patterns
    // were broad enough to ALSO match a dbus connection failure (now closed
    // off by the negative guard above regardless, but the positive patterns
    // themselves should still be specific to systemd's own unit-missing
    // phrasing rather than generic OS error text). Matches systemctl's
    // documented phrasing for a genuinely unknown unit: "Unit <name> not
    // loaded.", "Unit <name> could not be found.", "Failed to disable unit:
    // Unit file <name> does not exist."
    linux: [/\bunit\b(?:\s+file)?\s+\S+\s+(could not be found|not loaded|does not exist)\b/],
  };

  return (ALREADY_MISSING_PATTERNS[platformKind] ?? []).some((pattern) => pattern.test(text));
}

/**
 * Returns the first failed step in a `runSteps()`-shaped results array, or
 * `null` if every step succeeded (or the array is empty/absent). Pure and
 * side-effect-free (never calls `process.exit`) — extracted so
 * scripts/service.mjs's exit-calling wrappers (`requireStepsOk`,
 * `requireDeregistered`) stay thin, and so this bit of result-inspection
 * logic is unit-testable without mocking `process.exit` (F11 review fix:
 * `service:start` on macOS/Linux ran `launchctl start`/`systemctl --user
 * start` and ignored a failed result entirely, reporting success even when
 * the agent/unit wasn't installed or the supervisor rejected it).
 *
 * @typedef {{ exe?: string, args?: string[], ok?: boolean, stdout?: string, stderr?: string, error?: string }} StepResult
 * @param {StepResult[] | null | undefined} results
 */
export function findFirstStepFailure(results) {
  return (results ?? []).find((r) => r && r.ok === false) ?? null;
}

/**
 * Formats a failed step's raw error text for a human-readable message:
 * prefers `stderr` (what the CLI itself printed), then the wrapped
 * `error.message`, then `stdout`, then a generic fallback — never throws,
 * never returns an empty string.
 *
 * @param {StepResult | null | undefined} failure
 */
export function describeStepFailure(failure) {
  if (!failure) return "unknown error";
  return failure.stderr?.trim() || failure.error || failure.stdout?.trim() || "unknown error";
}

/**
 * True if a failed Windows `taskkill` step's error text indicates the
 * target PID had already exited by the time taskkill ran — a benign race
 * between `service:stop`'s own LISTENING-port check and the kill itself
 * (F13 review fix), not a real failure. `taskkill`'s own phrasing for this
 * is "ERROR: The process ... not found." — deliberately a SEPARATE pattern
 * from `isAlreadyMissingFailure`'s Windows patterns (which are specific to
 * `schtasks`' unrelated "cannot find the file specified" text); the two
 * CLIs report a missing target completely differently.
 *
 * @param {StepResult | null | undefined} result
 */
export function isTaskkillAlreadyGone(result) {
  if (!result || result.ok) return false;
  const text = `${result.stderr ?? ""} ${result.stdout ?? ""} ${result.error ?? ""}`.toLowerCase();
  if (!text.trim()) return false;
  return /not found/.test(text);
}

/** The filename the JSON sidecar recording the installed launch is written under (Windows only, in `~/.minder/service/` alongside run-hidden.vbs/task.xml). */
export const SERVICE_MANIFEST_FILENAME = "service-manifest.json";

/**
 * @typedef {{ mode: "standalone" | "fallback", exe: string, args: string[], cwd?: string }} InstalledLaunch
 */

/**
 * Parses `service-manifest.json` (F14 review fix) — a small JSON sidecar
 * `service:install` writes recording the EXACT launch it resolved at
 * install time, so `service:stop` can verify process identity against what
 * was actually installed instead of recomputing `resolveServerLaunch()`
 * against the CURRENT filesystem (which can diverge: install while only
 * `.next` exists, `pnpm package:standalone` later, or the reverse — the
 * live run-hidden.vbs keeps launching the ORIGINAL mode either way, so
 * re-resolving live would refuse to recognize — or worse, misidentify —
 * the very service this tool installed).
 *
 * Returns `null` for anything that isn't valid JSON or doesn't have the
 * expected shape — the caller falls back to `extractLaunchFromVbs`.
 *
 * @param {string | null | undefined} jsonText
 * @returns {InstalledLaunch | null}
 */
export function parseServiceManifest(jsonText) {
  if (typeof jsonText !== "string" || !jsonText.trim()) return null;
  let data;
  try {
    data = JSON.parse(jsonText);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object") return null;
  const { mode, exe, args, cwd } = data;
  if (mode !== "standalone" && mode !== "fallback") return null;
  if (typeof exe !== "string" || !exe) return null;
  if (!Array.isArray(args) || !args.every((a) => typeof a === "string")) return null;
  return { mode, exe, args, cwd: typeof cwd === "string" ? cwd : undefined };
}

/**
 * Parses the INSTALLED `run-hidden.vbs` (F14 review fix, fallback path for
 * installs made before the JSON sidecar existed, or if it's manually
 * deleted) to recover the exact launch it was generated for — rather than
 * trusting a freshly recomputed `resolveServerLaunch()` against whatever
 * the filesystem looks like NOW. The template (windows-run-hidden.vbs.tmpl)
 * has a fixed, known shape:
 *   WshShell.CurrentDirectory = "<cwd>"
 *   WshShell.Run "<command line>", 0, False
 * where `<command line>` is `escapeVbsString(quoteArg(exe) + " " +
 * quoteArg(arg1) + " " + ...)` — i.e. every original double-quote is
 * DOUBLED (VBScript's own quoting rule). Decoding reverses that (`""` ->
 * `"`), then every `"...".` run is one token: `[exe, ...args]`.
 *
 * The launch `mode` isn't stored in the vbs text itself, so it's inferred
 * from the recovered args: standalone's args always end in an absolute
 * `server.js` path; fallback's always include a bare `start` token (see
 * resolveServerLaunch). An unrecognized shape (a hand-edited or
 * differently-versioned vbs) returns `null` rather than guessing.
 *
 * @param {string | null | undefined} vbsContent
 * @returns {InstalledLaunch | null}
 */
export function extractLaunchFromVbs(vbsContent) {
  if (typeof vbsContent !== "string" || !vbsContent.trim()) return null;

  const cwdMatch = vbsContent.match(/WshShell\.CurrentDirectory\s*=\s*"([^"]*)"/);
  const runMatch = vbsContent.match(/WshShell\.Run\s+"([\s\S]*?)",\s*0,\s*False/);
  if (!runMatch) return null;

  const decoded = runMatch[1].replace(/""/g, '"');
  const tokens = [];
  const tokenPattern = /"([^"]*)"/g;
  let m;
  while ((m = tokenPattern.exec(decoded)) !== null) {
    tokens.push(m[1]);
  }
  if (tokens.length === 0) return null;

  const [exe, ...args] = tokens;
  const mode = args.some((a) => /server\.js$/i.test(a)) ? "standalone" : args.includes("start") ? "fallback" : null;
  if (!mode) return null; // unrecognized shape — caller falls back further

  return { mode, exe, args, cwd: cwdMatch ? cwdMatch[1] : undefined };
}

/**
 * Resolves the launch identity to use for `service:stop` — preferring what
 * was ACTUALLY INSTALLED over a freshly recomputed `resolveServerLaunch()`
 * (F14 review fix). Order: the JSON manifest, then the vbs (older
 * installs), then `{ launch: null, source: null }` so the caller falls
 * back to recomputing from the current filesystem (with a printed note,
 * since that fallback can diverge from what's actually installed).
 *
 * @param {{ manifestJson?: string | null, vbsContent?: string | null }} [sources]
 * @returns {{ launch: InstalledLaunch | null, source: "manifest" | "vbs" | null }}
 */
export function resolveInstalledLaunch(sources = {}) {
  const { manifestJson, vbsContent } = sources;
  const fromManifest = parseServiceManifest(manifestJson);
  if (fromManifest) return { launch: fromManifest, source: "manifest" };
  const fromVbs = extractLaunchFromVbs(vbsContent);
  if (fromVbs) return { launch: fromVbs, source: "vbs" };
  return { launch: null, source: null };
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
