#!/usr/bin/env node
// Per-OS autostart wrapper CLI (service/tray plan, task A3):
// `pnpm service:install | uninstall | status | start | stop`.
//
// Registers Project Minder to start at user LOGON (never machine/boot scope
// — see the plan's locked decision #3: everything Minder reads lives in the
// user profile, so a machine-scoped Windows Service running as LocalSystem
// would break every `~`-relative path). Concretely:
//   Windows -> a Scheduled Task with a LogonTrigger (schtasks)
//   macOS   -> a launchd LaunchAgent in ~/Library/LaunchAgents (launchctl)
//   Linux   -> a systemd --user unit in ~/.config/systemd/user (systemctl)
//
// Prefers the standalone package (C0, dist/minder-server/server.js, run
// under the system Node) over a from-source `next start` fallback (needs a
// completed `pnpm build`) — see resolveServerLaunch() in scripts/service/lib.mjs.
//
// House rule: every subprocess call below uses execFile with an ARGUMENT
// ARRAY — never a shell string.
//
// Windows stop is a documented hard-stop, not a graceful signal: Task
// Scheduler only tracks the wscript.exe launcher, which exits immediately
// after firing WshShell.Run (it doesn't wait), so by the time anyone runs
// `service:stop` Task Scheduler has nothing left to signal. We instead find
// the PID(s) actually LISTENING on port 4100 and `taskkill /F /T` them —
// the same mechanism src/lib/platform.ts's killProcessTree() uses for
// managed dev servers. This is safe because A2's boot-time reconcile +
// SQLite WAL checkpoint-on-open recovery already handle an unclean previous
// exit; the C1 tray app will add a real control channel for a graceful stop.
//
// IDENTITY CHECK, NOT JUST PORT CHECK: "something is listening on 4100" is
// not proof it's THIS installation — an unrelated `pnpm dev` (or literally
// anything else) can hold that port too. An earlier version of this file
// hard-killed whatever it found there unconditionally, and it took down a
// live, unrelated dev server during this task's own verification pass.
// Before killing a candidate PID we now query its actual command line
// (queryWindowsProcessCommandLine, via PowerShell Get-CimInstance) and
// only proceed if it matches this installation's server entry point
// (buildServerIdentityMarkers / commandLineMatchesServer, in
// scripts/service/lib.mjs). If it doesn't match, we refuse to kill it and
// print what was found plus how to stop it manually.
//
// macOS/Linux don't need this: launchctl/systemctl target a specific
// label/unit name, not a port scan, so they can only ever affect the
// process THIS install registered — see runStop()'s macos/linux branches.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  WINDOWS_TASK_NAME,
  LAUNCHD_LABEL,
  SYSTEMD_UNIT_NAME,
  renderTemplate,
  escapeXml,
  escapeVbsString,
  quoteArg,
  resolveServerLaunch,
  NO_BUILD_MESSAGE,
  detectPlatformKind,
  isValidAction,
  planActions,
  parseNetstatListeningPids,
  resolveWindowsUserId,
  buildServerIdentityMarkers,
  commandLineMatchesServer,
  escapeSystemdPercent,
} from "./service/lib.mjs";

const execFileAsync = promisify(execFile);

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const templatesDir = path.join(here, "service", "templates");

// Generated-artifact locations. Windows keeps its generated vbs/xml under
// ~/.minder (alongside the rest of Minder's user-scoped state — index.db,
// logs/); macOS/Linux write directly to the canonical location their
// supervisor reads from (LaunchAgents / systemd user units), since that
// path IS the registration, not just an input to one.
const minderHome = path.join(os.homedir(), ".minder");
const windowsServiceDir = path.join(minderHome, "service");
const logDir = path.join(minderHome, "logs");

function step(message) {
  console.log(`[service] ${message}`);
}

function fail(message) {
  console.error(`[service] ERROR: ${message}`);
  process.exit(1);
}

function readTemplate(name) {
  return readFileSync(path.join(templatesDir, name), "utf8");
}

// --- Artifact builders (one per OS) -----------------------------------

function buildWindowsArtifacts(launch) {
  const userId = escapeXml(resolveWindowsUserId());
  const vbsPath = path.join(windowsServiceDir, "run-hidden.vbs");
  const xmlPath = path.join(windowsServiceDir, "task.xml");

  // Both launch modes are now `execPath <js entry point> [args]` (F7 review
  // fix) — no shell, no `.cmd` shim, no cmd.exe /c wrapper needed either way.
  const commandLine = `${quoteArg(launch.exe)} ${launch.args.map(quoteArg).join(" ")}`;

  const vbsContent = renderTemplate(readTemplate("windows-run-hidden.vbs.tmpl"), {
    WORKING_DIR: launch.cwd,
    PORT: "4100",
    HOSTNAME: "127.0.0.1",
    COMMAND_LINE: escapeVbsString(commandLine),
  });

  const wscriptPath = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "wscript.exe");
  const xmlContent = renderTemplate(readTemplate("windows-task.xml.tmpl"), {
    USER_ID: userId,
    EXEC_COMMAND: escapeXml(wscriptPath),
    EXEC_ARGS: escapeXml(quoteArg(vbsPath)),
    WORKING_DIR: escapeXml(launch.cwd),
  });

  return { vbsPath, vbsContent, xmlPath, xmlContent, taskName: WINDOWS_TASK_NAME };
}

function buildMacArtifacts(launch) {
  // F9 review fix: EVERY substitution lands inside a plist <string>
  // element — a path containing an XML-significant character (`&`, `<`,
  // e.g. `~/Projects/R&D/...`) written in raw produces invalid XML that
  // launchd will refuse to load. escapeXml() (already used for the Windows
  // task XML) is applied to every value here, not just the arguments.
  const programArgumentsXml = [launch.exe, ...launch.args]
    .map((a) => `    <string>${escapeXml(a)}</string>`)
    .join("\n");
  const plistContent = renderTemplate(readTemplate("com.minder.dashboard.plist.tmpl"), {
    LABEL: escapeXml(LAUNCHD_LABEL),
    PROGRAM_ARGUMENTS: programArgumentsXml,
    WORKING_DIR: escapeXml(launch.cwd),
    PORT: escapeXml("4100"),
    HOSTNAME: escapeXml("127.0.0.1"),
    LOG_DIR: escapeXml(logDir),
  });
  const plistPath = path.join(os.homedir(), "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
  return { label: LAUNCHD_LABEL, plistPath, plistContent };
}

function buildLinuxArtifacts(launch) {
  // F9 review fix: `%` starts a specifier expansion (`%h`, `%%`, ...)
  // anywhere in a systemd unit file, so every directive value is percent-
  // escaped via escapeSystemdPercent() before substitution. ExecStart='s
  // arguments are ALSO quoted (quoteArg) since that directive is word-split
  // like a shell command line — WorkingDirectory=/Environment= take a
  // single un-split value and need only the percent-escape, never quoting.
  // Deliberately not handled: a literal backslash inside a path (systemd's
  // ExecStart quoting is C-string-like and would treat it as an escape
  // sequence start) — legal on Linux filesystems but exceedingly rare in
  // practice; see escapeSystemdPercent's doc comment.
  const execStart = [launch.exe, ...launch.args]
    .map((a) => quoteArg(escapeSystemdPercent(a)))
    .join(" ");
  const unitContent = renderTemplate(readTemplate("minder.service.tmpl"), {
    EXEC_START: execStart,
    WORKING_DIR: escapeSystemdPercent(launch.cwd),
    PORT: "4100",
    HOSTNAME: "127.0.0.1",
  });
  const unitPath = path.join(os.homedir(), ".config", "systemd", "user", SYSTEMD_UNIT_NAME);
  return { unitName: SYSTEMD_UNIT_NAME, unitPath, unitContent };
}

// --- Subprocess execution ----------------------------------------------

async function runSteps(steps) {
  const results = [];
  for (const { exe, args } of steps) {
    step(`Running: ${exe} ${args.join(" ")}`);
    try {
      const { stdout, stderr } = await execFileAsync(exe, args, { windowsHide: true });
      if (stdout?.trim()) console.log(stdout.trim());
      if (stderr?.trim()) console.error(stderr.trim());
      results.push({ exe, args, ok: true, stdout, stderr });
    } catch (err) {
      const stdout = err && typeof err === "object" ? err.stdout : undefined;
      const stderr = err && typeof err === "object" ? err.stderr : undefined;
      if (stdout?.trim()) console.log(stdout.trim());
      if (stderr?.trim()) console.error(stderr.trim());
      results.push({ exe, args, ok: false, stdout, stderr, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return results;
}

// --- Actions -------------------------------------------------------------

function resolveLaunchOrFail() {
  const launch = resolveServerLaunch({ root });
  if (!launch) {
    console.error(`[service] ${NO_BUILD_MESSAGE}`);
    process.exit(1);
  }
  step(
    `Using ${launch.mode === "standalone" ? "standalone package (dist/minder-server)" : "from-source build (next start)"}: ` +
      `${launch.exe} ${launch.args.join(" ")} (cwd: ${launch.cwd})`
  );
  return launch;
}

async function runInstall(platformKind) {
  const launch = resolveLaunchOrFail();

  if (platformKind === "windows") {
    const { vbsPath, vbsContent, xmlPath, xmlContent, taskName } = buildWindowsArtifacts(launch);
    mkdirSync(windowsServiceDir, { recursive: true });
    writeFileSync(vbsPath, vbsContent, "utf8");
    // schtasks' XML import wants a UTF-16 file matching the <?xml
    // encoding="UTF-16"?> declaration in the template — a BOM makes that
    // unambiguous rather than relying on schtasks sniffing it.
    writeFileSync(xmlPath, "﻿" + xmlContent, "utf16le");
    step(`Wrote ${vbsPath}`);
    step(`Wrote ${xmlPath}`);
    const results = await runSteps(planActions("windows", "install", { taskName, xmlPath }));
    if (results.some((r) => !r.ok)) fail(`Failed to register scheduled task "${taskName}".`);
    step(`Installed scheduled task "${taskName}" (logon trigger). Verify: schtasks /query /tn ${taskName}`);
    return;
  }

  if (platformKind === "macos") {
    const { plistPath, plistContent, label } = buildMacArtifacts(launch);
    mkdirSync(path.dirname(plistPath), { recursive: true });
    mkdirSync(logDir, { recursive: true });
    writeFileSync(plistPath, plistContent, "utf8");
    step(`Wrote ${plistPath}`);
    const results = await runSteps(planActions("macos", "install", { plistPath, label }));
    if (results.some((r) => !r.ok)) fail(`Failed to load LaunchAgent "${label}".`);
    step(`Loaded LaunchAgent "${label}" (RunAtLoad + KeepAlive). Verify: launchctl list ${label}`);
    return;
  }

  // linux
  const { unitPath, unitContent, unitName } = buildLinuxArtifacts(launch);
  mkdirSync(path.dirname(unitPath), { recursive: true });
  writeFileSync(unitPath, unitContent, "utf8");
  step(`Wrote ${unitPath}`);
  const results = await runSteps(planActions("linux", "install", { unitName }));
  if (results.some((r) => !r.ok)) fail(`Failed to enable systemd --user unit "${unitName}".`);
  step(`Enabled + started systemd --user unit "${unitName}". Verify: systemctl --user status ${unitName}`);
}

async function runUninstall(platformKind) {
  if (platformKind === "windows") {
    // Deliberately does NOT auto-stop first. runStop("windows") hard-kills
    // whatever is LISTENING on port 4100 (see the file-level comment) —
    // there is no PID we recorded at install time to confirm that's actually
    // OUR registered task's process rather than, say, a `pnpm dev` the
    // operator is running by hand. An earlier version of this function did
    // call runStop() automatically here and it killed a live, unrelated
    // dev server during this task's own verification. If you also want the
    // running server stopped, run `pnpm service:stop` yourself first (after
    // confirming port 4100 is actually this service) — uninstall only
    // removes the registration + generated files.
    await runSteps(planActions("windows", "uninstall", { taskName: WINDOWS_TASK_NAME }));
    rmSync(windowsServiceDir, { recursive: true, force: true });
    step(`Removed scheduled task "${WINDOWS_TASK_NAME}" and ${windowsServiceDir}.`);
    step(
      "Note: uninstall does NOT stop a currently-running server — it only removes the " +
        "logon registration. Run `pnpm service:stop` first if one is running and you want it stopped."
    );
    return;
  }

  if (platformKind === "macos") {
    const plistPath = path.join(os.homedir(), "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
    await runSteps(planActions("macos", "uninstall", { plistPath, label: LAUNCHD_LABEL }));
    rmSync(plistPath, { force: true });
    step(`Unloaded LaunchAgent "${LAUNCHD_LABEL}" and removed ${plistPath}.`);
    return;
  }

  const unitPath = path.join(os.homedir(), ".config", "systemd", "user", SYSTEMD_UNIT_NAME);
  // F4 review fix: disable --now first (stops + unlinks the .wants symlink,
  // doesn't need the unit file gone to do that), THEN remove the unit file,
  // THEN daemon-reload — reloading before the file is removed leaves
  // systemd's unit cache pointing at a file that's already deleted by the
  // time anything next notices. planActions("linux","uninstall") only
  // returns the disable step for exactly this reason.
  await runSteps(planActions("linux", "uninstall", { unitName: SYSTEMD_UNIT_NAME }));
  rmSync(unitPath, { force: true });
  await runSteps([{ exe: "systemctl", args: ["--user", "daemon-reload"] }]);
  step(`Disabled systemd --user unit "${SYSTEMD_UNIT_NAME}" and removed ${unitPath}.`);
}

async function runStatus(platformKind) {
  if (platformKind === "windows") {
    await runSteps(planActions("windows", "status", { taskName: WINDOWS_TASK_NAME }));
    return;
  }
  if (platformKind === "macos") {
    await runSteps(planActions("macos", "status", { label: LAUNCHD_LABEL }));
    return;
  }
  await runSteps(planActions("linux", "status", { unitName: SYSTEMD_UNIT_NAME }));
}

async function runStart(platformKind) {
  if (platformKind === "windows") {
    const results = await runSteps(planActions("windows", "start", { taskName: WINDOWS_TASK_NAME }));
    if (results.some((r) => !r.ok)) fail(`Failed to run scheduled task "${WINDOWS_TASK_NAME}". Is it installed? (pnpm service:install)`);
    return;
  }
  if (platformKind === "macos") {
    await runSteps(planActions("macos", "start", { label: LAUNCHD_LABEL }));
    return;
  }
  await runSteps(planActions("linux", "start", { unitName: SYSTEMD_UNIT_NAME }));
}

// Queries a Windows PID's full command line via PowerShell's Get-CimInstance
// (no shell string — execFile passes each element of the array as its own
// argument to powershell.exe directly). Returns "" if the PID has already
// exited or the query otherwise fails, rather than throwing — a stop should
// degrade to "couldn't verify, so don't kill it" rather than crash.
async function queryWindowsProcessCommandLine(pid) {
  try {
    const { stdout } = await execFileAsync(
      "powershell",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`,
      ],
      { windowsHide: true }
    );
    return stdout.trim();
  } catch {
    return "";
  }
}

async function runStop(platformKind) {
  if (platformKind === "windows") {
    // See the file-level comment: schtasks has nothing left to signal by
    // now, so find whatever is LISTENING on 4100 — but LISTENING alone
    // isn't proof it's ours. Verify each candidate PID's command line
    // against this installation's own server entry point before killing it.
    let stdout = "";
    try {
      ({ stdout } = await execFileAsync("netstat", ["-ano"], { windowsHide: true }));
    } catch (err) {
      fail(`Failed to run netstat: ${err instanceof Error ? err.message : String(err)}`);
    }
    const pids = parseNetstatListeningPids(stdout, 4100);
    if (pids.length === 0) {
      step("Nothing is listening on port 4100 — server is not running.");
      return;
    }

    const launch = resolveServerLaunch({ root });
    const vbsPath = path.join(windowsServiceDir, "run-hidden.vbs");
    const identity = buildServerIdentityMarkers({ root, launch, vbsPath });

    for (const pid of pids) {
      const commandLine = await queryWindowsProcessCommandLine(pid);
      if (!commandLineMatchesServer(commandLine, identity)) {
        step(
          `Port 4100 is held by PID ${pid}, but its command line doesn't match this Minder ` +
            `installation — NOT killing it.`
        );
        step(`  Command line: ${commandLine || "(could not be determined — process may have already exited)"}`);
        step(`  If you're certain this IS Minder, stop it manually: taskkill /F /T /PID ${pid}`);
        continue;
      }
      step(`Port 4100 is held by PID ${pid} (verified as this installation) — hard-stopping (taskkill /F /T).`);
      await runSteps([{ exe: "taskkill", args: ["/F", "/T", "/PID", pid] }]);
    }
    return;
  }
  if (platformKind === "macos") {
    // Safe by construction: launchctl targets a specific label, never a
    // port — it can only affect the job THIS install registered.
    step(`Stopping via launchctl label "${LAUNCHD_LABEL}" (scoped by label, not by port — safe).`);
    await runSteps(planActions("macos", "stop", { label: LAUNCHD_LABEL }));
    return;
  }
  // Safe by construction: systemctl --user targets a specific unit name,
  // never a port — it can only affect the unit THIS install registered.
  step(`Stopping via systemctl --user unit "${SYSTEMD_UNIT_NAME}" (scoped by unit name, not by port — safe).`);
  await runSteps(planActions("linux", "stop", { unitName: SYSTEMD_UNIT_NAME }));
}

// --- CLI entry -------------------------------------------------------------

async function main() {
  const action = process.argv[2];
  if (!isValidAction(action)) {
    console.error(
      `Usage: node scripts/service.mjs <install|uninstall|status|start|stop>\n` +
        `(or: pnpm service:install | service:uninstall | service:status | service:start | service:stop)`
    );
    process.exit(1);
  }

  let platformKind;
  try {
    platformKind = detectPlatformKind();
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
    return;
  }
  step(`Platform: ${platformKind}`);

  switch (action) {
    case "install":
      await runInstall(platformKind);
      break;
    case "uninstall":
      await runUninstall(platformKind);
      break;
    case "status":
      await runStatus(platformKind);
      break;
    case "start":
      await runStart(platformKind);
      break;
    case "stop":
      await runStop(platformKind);
      break;
  }
}

const isMain =
  typeof process !== "undefined" &&
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  main().catch((err) => {
    fail(err instanceof Error ? (err.stack ?? err.message) : String(err));
  });
}

export { root, windowsServiceDir, logDir, buildWindowsArtifacts, buildMacArtifacts, buildLinuxArtifacts };
