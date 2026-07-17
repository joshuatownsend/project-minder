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

  const inner = `${quoteArg(launch.exe)} ${launch.args.map(quoteArg).join(" ")}`;
  // cmd.exe's own quoting rule when /c's argument starts with a quoted
  // token: wrap the WHOLE thing in one more pair of quotes, or cmd strips
  // the inner quotes as if they were the outer ones and mis-parses a path
  // containing spaces. Harmless (just redundant) when no wrapper is needed.
  const commandLine = launch.needsCmdWrapper ? `cmd.exe /c "${inner}"` : inner;

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
  const programArgumentsXml = [launch.exe, ...launch.args]
    .map((a) => `    <string>${escapeXml(a)}</string>`)
    .join("\n");
  const plistContent = renderTemplate(readTemplate("com.minder.dashboard.plist.tmpl"), {
    LABEL: LAUNCHD_LABEL,
    PROGRAM_ARGUMENTS: programArgumentsXml,
    WORKING_DIR: launch.cwd,
    PORT: "4100",
    HOSTNAME: "127.0.0.1",
    LOG_DIR: logDir,
  });
  const plistPath = path.join(os.homedir(), "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
  return { label: LAUNCHD_LABEL, plistPath, plistContent };
}

function buildLinuxArtifacts(launch) {
  const execStart = [launch.exe, ...launch.args].map(quoteArg).join(" ");
  const unitContent = renderTemplate(readTemplate("minder.service.tmpl"), {
    EXEC_START: execStart,
    WORKING_DIR: launch.cwd,
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
  await runSteps(planActions("linux", "uninstall", { unitName: SYSTEMD_UNIT_NAME }));
  rmSync(unitPath, { force: true });
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

async function runStop(platformKind) {
  if (platformKind === "windows") {
    // See the file-level comment: schtasks has nothing left to signal by
    // now, so find whatever is LISTENING on 4100 and hard-kill it.
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
    for (const pid of pids) {
      step(`Port 4100 is held by PID ${pid} — hard-stopping (taskkill /F /T).`);
      await runSteps([{ exe: "taskkill", args: ["/F", "/T", "/PID", pid] }]);
    }
    return;
  }
  if (platformKind === "macos") {
    await runSteps(planActions("macos", "stop", { label: LAUNCHD_LABEL }));
    return;
  }
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
