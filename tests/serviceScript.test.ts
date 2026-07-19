import { describe, it, expect } from "vitest";
import path from "node:path";
import {
  renderTemplate,
  escapeXml,
  escapeVbsString,
  quoteArg,
  escapeSystemdPercent,
  isAlreadyMissingFailure,
  findFirstStepFailure,
  describeStepFailure,
  isTaskkillAlreadyGone,
  extractLaunchFromVbs,
  parseServiceManifest,
  resolveInstalledLaunch,
  resolveServicePort,
  resolveInstalledPort,
  DEFAULT_SERVICE_PORT,
  SERVICE_MANIFEST_FILENAME,
  resolveServerLaunch,
  NO_BUILD_MESSAGE,
  detectPlatformKind,
  isValidAction,
  planActions,
  parseNetstatListeningPids,
  resolveWindowsUserId,
  buildServerIdentityMarkers,
  commandLineMatchesServer,
  WINDOWS_TASK_NAME,
  LAUNCHD_LABEL,
  SYSTEMD_UNIT_NAME,
} from "../scripts/service/lib.mjs";
import { buildMacArtifacts, buildLinuxArtifacts } from "../scripts/service.mjs";

describe("renderTemplate", () => {
  it("substitutes {{KEY}} tokens", () => {
    expect(renderTemplate("hello {{NAME}}, port {{PORT}}", { NAME: "world", PORT: 4100 })).toBe(
      "hello world, port 4100"
    );
  });

  it("substitutes the same token repeated", () => {
    expect(renderTemplate("{{X}}-{{X}}", { X: "a" })).toBe("a-a");
  });

  it("throws on a missing token", () => {
    expect(() => renderTemplate("hello {{MISSING}}", {})).toThrow(/MISSING/);
  });
});

describe("escapeXml", () => {
  it("escapes the five XML special characters it handles", () => {
    expect(escapeXml(`a & b < c > d "e"`)).toBe("a &amp; b &lt; c &gt; d &quot;e&quot;");
  });

  it("passes through plain text unchanged", () => {
    expect(escapeXml("C:\\dev\\project-minder")).toBe("C:\\dev\\project-minder");
  });
});

describe("escapeVbsString", () => {
  it("doubles embedded double quotes", () => {
    expect(escapeVbsString(`cmd.exe /c "a b"`)).toBe(`cmd.exe /c ""a b""`);
  });

  it("is a no-op with no quotes", () => {
    expect(escapeVbsString("plain")).toBe("plain");
  });
});

describe("quoteArg", () => {
  it("always wraps in double quotes", () => {
    expect(quoteArg("C:/a b/c.exe")).toBe(`"C:/a b/c.exe"`);
    expect(quoteArg("noSpaces")).toBe(`"noSpaces"`);
  });
});

describe("escapeSystemdPercent (F9 review fix)", () => {
  it("doubles literal percent signs", () => {
    expect(escapeSystemdPercent("100%-project")).toBe("100%%-project");
  });

  it("doubles every occurrence, not just the first", () => {
    expect(escapeSystemdPercent("%h/100%/50%")).toBe("%%h/100%%/50%%");
  });

  it("is a no-op with no percent signs", () => {
    expect(escapeSystemdPercent("/home/josh/project")).toBe("/home/josh/project");
  });
});

describe("isAlreadyMissingFailure (F10 review fix: gate uninstall artifact cleanup)", () => {
  it("returns false for a successful result (nothing to classify)", () => {
    expect(isAlreadyMissingFailure("windows", { ok: true, stdout: "SUCCESS", stderr: "" })).toBe(false);
  });

  it("returns false for null/undefined results", () => {
    expect(isAlreadyMissingFailure("windows", null)).toBe(false);
    expect(isAlreadyMissingFailure("windows", undefined)).toBe(false);
  });

  it("returns false when there is no error text at all", () => {
    expect(isAlreadyMissingFailure("windows", { ok: false, stdout: "", stderr: "" })).toBe(false);
  });

  // Windows: exact text observed live in this session for a nonexistent
  // scheduled task (schtasks /query, and per Microsoft's docs also /delete).
  it("windows: classifies schtasks' 'cannot find the file specified' as already-missing", () => {
    const result = { ok: false, stdout: "", stderr: "ERROR: The system cannot find the file specified.\r\n" };
    expect(isAlreadyMissingFailure("windows", result)).toBe(true);
  });

  it("windows: classifies a permissions/access error as a REAL failure", () => {
    const result = { ok: false, stdout: "", stderr: "ERROR: Access is denied.\r\n" };
    expect(isAlreadyMissingFailure("windows", result)).toBe(false);
  });

  it("macos: classifies launchctl's 'No such file or directory' as already-missing", () => {
    const result = { ok: false, stdout: "", stderr: "launchctl unload -w: No such file or directory\n" };
    expect(isAlreadyMissingFailure("macos", result)).toBe(true);
  });

  it("macos: classifies a permissions error as a REAL failure", () => {
    const result = { ok: false, stdout: "", stderr: "launchctl unload -w: Operation not permitted\n" };
    expect(isAlreadyMissingFailure("macos", result)).toBe(false);
  });

  it("linux: classifies systemctl's 'not loaded' / 'could not be found' as already-missing", () => {
    expect(
      isAlreadyMissingFailure("linux", { ok: false, stdout: "", stderr: "Unit minder.service not loaded.\n" })
    ).toBe(true);
    expect(
      isAlreadyMissingFailure("linux", {
        ok: false,
        stdout: "",
        stderr: "Failed to disable unit: Unit file minder.service could not be found.\n",
      })
    ).toBe(true);
  });

  it("linux: classifies a permissions error as a REAL failure", () => {
    const result = { ok: false, stdout: "", stderr: "Failed to disable unit: Access denied\n" };
    expect(isAlreadyMissingFailure("linux", result)).toBe(false);
  });

  // F12 review fix: this used to be a documented KNOWN LIMITATION (dbus's
  // own "No such file or directory" socket-connection text collided with
  // the bare "no such file or directory" pattern this classifier used to
  // have for Linux, misclassifying a genuine bus-connectivity problem as
  // "already missing" and letting artifact cleanup proceed while the
  // unit's real state was actually UNKNOWN). The explicit bus/dbus negative
  // guard now closes this — flipped into a correctness test.
  it("linux: a dbus connectivity failure is ALWAYS a real failure, never already-missing", () => {
    const result = {
      ok: false,
      stdout: "",
      stderr: "Failed to connect to bus: No such file or directory\n",
    };
    expect(isAlreadyMissingFailure("linux", result)).toBe(false);
  });

  it("linux: the bus-connection guard applies even if the text also happens to mention a unit", () => {
    const result = {
      ok: false,
      stdout: "",
      stderr: "Failed to connect to bus: No such file or directory (unit minder.service not loaded)\n",
    };
    expect(isAlreadyMissingFailure("linux", result)).toBe(false);
  });

  it("linux: a bare 'no such file or directory' with no unit context is a REAL failure (not the old bare pattern)", () => {
    const result = { ok: false, stdout: "", stderr: "some/path: No such file or directory\n" };
    expect(isAlreadyMissingFailure("linux", result)).toBe(false);
  });

  it("returns false for an unrecognized platform", () => {
    expect(isAlreadyMissingFailure("plan9", { ok: false, stdout: "", stderr: "whatever" })).toBe(false);
  });
});

describe("findFirstStepFailure (F11 review fix: propagate service:start failures)", () => {
  it("returns null when every step succeeded", () => {
    expect(findFirstStepFailure([{ ok: true }, { ok: true }])).toBeNull();
  });

  it("returns null for an empty or missing results array", () => {
    expect(findFirstStepFailure([])).toBeNull();
    expect(findFirstStepFailure(undefined)).toBeNull();
    expect(findFirstStepFailure(null)).toBeNull();
  });

  it("returns the first failed step, even when a later step also fails", () => {
    const first = { ok: false, exe: "launchctl", args: ["start", "com.minder.dashboard"], stderr: "first error" };
    const second = { ok: false, exe: "launchctl", args: ["start", "com.minder.dashboard"], stderr: "second error" };
    expect(findFirstStepFailure([{ ok: true }, first, second])).toBe(first);
  });

  it("does not mistake a step lacking an explicit ok:true for a failure", () => {
    // Only ok === false counts as a failure — a step object missing the
    // field entirely is not treated as failed.
    expect(findFirstStepFailure([{ exe: "x", args: [] }])).toBeNull();
  });
});

describe("describeStepFailure (F11 review fix)", () => {
  it("prefers stderr when present", () => {
    expect(describeStepFailure({ stderr: "  boom  ", error: "wrapped", stdout: "out" })).toBe("boom");
  });

  it("falls back to the wrapped error message when stderr is empty", () => {
    expect(describeStepFailure({ stderr: "", error: "wrapped message", stdout: "out" })).toBe("wrapped message");
  });

  it("falls back to stdout when both stderr and error are empty", () => {
    expect(describeStepFailure({ stderr: "", error: "", stdout: "  some stdout  " })).toBe("some stdout");
  });

  it("falls back to a generic message when nothing is present", () => {
    expect(describeStepFailure({ stderr: "", error: "", stdout: "" })).toBe("unknown error");
    expect(describeStepFailure(null)).toBe("unknown error");
    expect(describeStepFailure(undefined)).toBe("unknown error");
  });
});

describe("isTaskkillAlreadyGone (F13 review fix: propagate service:stop failures)", () => {
  it("returns false for a successful result", () => {
    expect(isTaskkillAlreadyGone({ ok: true, stdout: "SUCCESS", stderr: "" })).toBe(false);
  });

  it("returns false for null/undefined", () => {
    expect(isTaskkillAlreadyGone(null)).toBe(false);
    expect(isTaskkillAlreadyGone(undefined)).toBe(false);
  });

  it("classifies taskkill's own 'not found' phrasing as the PID having already exited (benign race)", () => {
    const result = { ok: false, stdout: "", stderr: 'ERROR: The process "12345" not found.\n' };
    expect(isTaskkillAlreadyGone(result)).toBe(true);
  });

  it("classifies a real taskkill failure (e.g. access denied) as a REAL failure", () => {
    const result = {
      ok: false,
      stdout: "",
      stderr: "ERROR: The process with PID 12345 could not be terminated.\nReason: Access is denied.\n",
    };
    expect(isTaskkillAlreadyGone(result)).toBe(false);
  });

  it("returns false when there is no error text at all", () => {
    expect(isTaskkillAlreadyGone({ ok: false, stdout: "", stderr: "" })).toBe(false);
  });
});

describe("extractLaunchFromVbs (F14 review fix: stop identity from installed artifacts)", () => {
  const VBS_TEMPLATE =
    'WshShell.CurrentDirectory = "{{WORKING_DIR}}"\n' +
    'WshEnv("PORT") = "{{PORT}}"\n' +
    'WshEnv("HOSTNAME") = "{{HOSTNAME}}"\n' +
    'WshShell.Run "{{COMMAND_LINE}}", 0, False\n';

  // Mirrors exactly what buildWindowsArtifacts (scripts/service.mjs) does —
  // real escaping via the same quoteArg/escapeVbsString primitives, not a
  // hand-rolled approximation — so these tests exercise the real round trip.
  function renderVbs(launch: { exe: string; args: string[]; cwd: string }) {
    const inner = `${quoteArg(launch.exe)} ${launch.args.map(quoteArg).join(" ")}`;
    return renderTemplate(VBS_TEMPLATE, {
      WORKING_DIR: launch.cwd,
      PORT: "4100",
      HOSTNAME: "127.0.0.1",
      COMMAND_LINE: escapeVbsString(inner),
    });
  }

  it("parses a standalone-form vbs and infers mode: standalone", () => {
    const launch = {
      exe: "C:\\Program Files\\nodejs\\node.exe",
      args: ["C:\\repo\\dist\\minder-server\\server.js"],
      cwd: "C:\\repo\\dist\\minder-server",
    };
    expect(extractLaunchFromVbs(renderVbs(launch))).toEqual({ mode: "standalone", ...launch });
  });

  it("parses a fallback-form vbs (node + next bin + start token) and infers mode: fallback", () => {
    const launch = {
      exe: "C:\\Program Files\\nodejs\\node.exe",
      args: ["C:\\repo\\node_modules\\next\\dist\\bin\\next", "start", "-p", "4100", "--hostname", "127.0.0.1"],
      cwd: "C:\\repo",
    };
    expect(extractLaunchFromVbs(renderVbs(launch))).toEqual({ mode: "fallback", ...launch });
  });

  // The core F14 requirement: a parsed fallback identity must still feed
  // the F6 two-part next-start signature correctly — the next bin path
  // alone must NOT be sufficient, `next dev` must still be refused.
  it("the parsed fallback identity still feeds the two-part next-start signature — 'next dev' is still refused", () => {
    const launch = {
      exe: "C:\\Program Files\\nodejs\\node.exe",
      args: ["C:\\repo\\node_modules\\next\\dist\\bin\\next", "start", "-p", "4100", "--hostname", "127.0.0.1"],
      cwd: "C:\\repo",
    };
    const parsed = extractLaunchFromVbs(renderVbs(launch));
    const identity = buildServerIdentityMarkers({ launch: parsed, vbsPath: "C:/x/run-hidden.vbs" });
    const startCmd = `"${launch.exe}" "${launch.args[0]}" start -p 4100 --hostname 127.0.0.1`;
    const devCmd = `"${launch.exe}" "${launch.args[0]}" dev -p 4100 --hostname 127.0.0.1`;
    expect(commandLineMatchesServer(startCmd, identity)).toBe(true);
    expect(commandLineMatchesServer(devCmd, identity)).toBe(false);
  });

  it("returns null for malformed/empty content", () => {
    expect(extractLaunchFromVbs("")).toBeNull();
    expect(extractLaunchFromVbs(null)).toBeNull();
    expect(extractLaunchFromVbs(undefined)).toBeNull();
    expect(extractLaunchFromVbs("this is not a vbs file at all")).toBeNull();
  });

  it("returns null when the Run line doesn't contain a recognizable server.js/start-token shape", () => {
    const vbs =
      'WshShell.CurrentDirectory = "C:\\repo"\n' + 'WshShell.Run """C:\\some\\other.exe"" ""restart""", 0, False\n';
    expect(extractLaunchFromVbs(vbs)).toBeNull();
  });

  it("returns null when there's no WshShell.Run line at all", () => {
    expect(extractLaunchFromVbs('WshShell.CurrentDirectory = "C:\\repo"\n')).toBeNull();
  });
});

describe("parseServiceManifest (F14 review fix)", () => {
  const validManifest = {
    version: 1,
    installedAt: "2026-01-01T00:00:00.000Z",
    mode: "standalone",
    exe: "C:\\Program Files\\nodejs\\node.exe",
    args: ["C:\\repo\\dist\\minder-server\\server.js"],
    cwd: "C:\\repo\\dist\\minder-server",
  };

  it("parses a well-formed manifest into { mode, exe, args, cwd }", () => {
    expect(parseServiceManifest(JSON.stringify(validManifest))).toEqual({
      mode: "standalone",
      exe: validManifest.exe,
      args: validManifest.args,
      cwd: validManifest.cwd,
    });
  });

  it("returns null for invalid JSON", () => {
    expect(parseServiceManifest("{not json")).toBeNull();
  });

  it("returns null for empty/null/undefined input", () => {
    expect(parseServiceManifest("")).toBeNull();
    expect(parseServiceManifest(null)).toBeNull();
    expect(parseServiceManifest(undefined)).toBeNull();
  });

  it("returns null when mode is missing or not one of the two valid values", () => {
    expect(parseServiceManifest(JSON.stringify({ ...validManifest, mode: "bogus" }))).toBeNull();
    const { mode, ...withoutMode } = validManifest;
    expect(parseServiceManifest(JSON.stringify(withoutMode))).toBeNull();
  });

  it("returns null when args is missing or not a string array", () => {
    expect(parseServiceManifest(JSON.stringify({ ...validManifest, args: "not-an-array" }))).toBeNull();
    expect(parseServiceManifest(JSON.stringify({ ...validManifest, args: [1, 2, 3] }))).toBeNull();
  });

  it("returns null when exe is missing or empty", () => {
    expect(parseServiceManifest(JSON.stringify({ ...validManifest, exe: "" }))).toBeNull();
    const { exe, ...withoutExe } = validManifest;
    expect(parseServiceManifest(JSON.stringify(withoutExe))).toBeNull();
  });
});

describe("resolveInstalledLaunch (F14 review fix: prefer manifest, then vbs, then null)", () => {
  const manifestJson = JSON.stringify({
    version: 1,
    installedAt: "2026-01-01T00:00:00.000Z",
    mode: "standalone",
    exe: "C:\\Program Files\\nodejs\\node.exe",
    args: ["C:\\repo\\dist\\minder-server\\server.js"],
    cwd: "C:\\repo\\dist\\minder-server",
  });

  const vbsLaunch = {
    exe: "C:\\Program Files\\nodejs\\node.exe",
    args: ["C:\\repo\\node_modules\\next\\dist\\bin\\next", "start", "-p", "4100", "--hostname", "127.0.0.1"],
    cwd: "C:\\repo",
  };
  const vbsContent = renderTemplate('WshShell.CurrentDirectory = "{{WORKING_DIR}}"\nWshShell.Run "{{COMMAND_LINE}}", 0, False\n', {
    WORKING_DIR: vbsLaunch.cwd,
    COMMAND_LINE: escapeVbsString(`${quoteArg(vbsLaunch.exe)} ${vbsLaunch.args.map(quoteArg).join(" ")}`),
  });

  it("prefers the manifest when both are present", () => {
    const { launch, source } = resolveInstalledLaunch({ manifestJson, vbsContent });
    expect(source).toBe("manifest");
    expect(launch?.mode).toBe("standalone");
  });

  it("falls back to the vbs when the manifest is absent or unparseable", () => {
    const fromMissing = resolveInstalledLaunch({ manifestJson: null, vbsContent });
    expect(fromMissing.source).toBe("vbs");
    expect(fromMissing.launch?.mode).toBe("fallback");

    const fromBadJson = resolveInstalledLaunch({ manifestJson: "{bad json", vbsContent });
    expect(fromBadJson.source).toBe("vbs");
    expect(fromBadJson.launch?.mode).toBe("fallback");
  });

  it("returns { launch: null, source: null } when neither source is present or parseable", () => {
    expect(resolveInstalledLaunch({ manifestJson: null, vbsContent: null })).toEqual({ launch: null, source: null });
    expect(resolveInstalledLaunch({})).toEqual({ launch: null, source: null });
  });
});

describe("SERVICE_MANIFEST_FILENAME", () => {
  it("is a stable filename", () => {
    expect(SERVICE_MANIFEST_FILENAME).toBe("service-manifest.json");
  });
});

describe("resolveServerLaunch", () => {
  const root = "C:/repo";
  const fakeNextBinPath = "C:/repo/node_modules/next/dist/bin/next";
  const resolveNextBin = () => fakeNextBinPath;

  // F5 review fix: the implementation builds these paths with `path.join`,
  // which resolves against the HOST platform's own separator (backslash on
  // Windows, forward slash on Linux CI). Expected values here are built
  // with the SAME `path.join` calls the implementation uses instead of
  // hardcoded separator literals, so this assertion is construction-
  // symmetric and can't diverge between Windows and Linux CI.
  it("prefers the standalone package when dist/minder-server/server.js exists", () => {
    const launch = resolveServerLaunch({
      root,
      execPath: "C:/nodejs/node.exe",
      existsSync: (p: string) => p.replace(/\\/g, "/").includes("dist/minder-server/server.js"),
    });
    expect(launch).toEqual({
      mode: "standalone",
      exe: "C:/nodejs/node.exe",
      args: [path.join(root, "dist", "minder-server", "server.js")],
      cwd: path.join(root, "dist", "minder-server"),
    });
  });

  // F7 review fix: the fallback launch is now `execPath <resolved next bin
  // JS file> start -p 4100` — the same shape as the standalone mode, no
  // shell/`.cmd` shim/PATH lookup involved — so a login-scoped service
  // environment with no PATH entry for a version-managed node (nvm/asdf on
  // macOS/Linux) still works, since the only node involved is the one
  // resolved via `process.execPath` at install time.
  // F8 review fix: `next start` defaults its hostname to 0.0.0.0 (verified
  // against this repo's own installed Next version's --help output) — an
  // explicit `--hostname 127.0.0.1` is required or the login-scoped service
  // would expose this local-only dashboard on every network interface.
  it("falls back to execPath + the resolved next bin JS file when only .next/BUILD_ID exists", () => {
    const launch = resolveServerLaunch({
      root,
      execPath: "C:/nodejs/node.exe",
      existsSync: (p: string) => p.replace(/\\/g, "/").includes(".next/BUILD_ID"),
      resolveNextBin,
    });
    expect(launch).toEqual({
      mode: "fallback",
      exe: "C:/nodejs/node.exe",
      args: [fakeNextBinPath, "start", "-p", "4100", "--hostname", "127.0.0.1"],
      cwd: root,
    });
  });

  // PR #316 review: `-p` OVERRIDES the PORT env var the generated launcher
  // sets, so a hardcoded 4100 here would pin a custom-port fallback install to
  // 4100 while the manifest, the proxy's Origin allowlist, and service:stop's
  // port scan all used the custom value — a dashboard that 403s its own /api
  // calls, and a service that stop can't find.
  it("threads a custom port into the fallback launch args", () => {
    const launch = resolveServerLaunch({
      root,
      execPath: "C:/nodejs/node.exe",
      existsSync: (p: string) => p.replace(/\\/g, "/").includes(".next/BUILD_ID"),
      resolveNextBin,
      port: 4199,
    });
    expect(launch?.args).toEqual([
      fakeNextBinPath,
      "start",
      "-p",
      "4199",
      "--hostname",
      "127.0.0.1",
    ]);
  });

  it("defaults the fallback port to DEFAULT_SERVICE_PORT when none is given", () => {
    const launch = resolveServerLaunch({
      root,
      execPath: "C:/nodejs/node.exe",
      existsSync: (p: string) => p.replace(/\\/g, "/").includes(".next/BUILD_ID"),
      resolveNextBin,
    });
    expect(launch?.args).toContain(String(DEFAULT_SERVICE_PORT));
  });

  // The standalone server reads process.env.PORT directly, so it takes no port
  // argument — passing one must not start injecting flags into that mode.
  it("does not add a port argument to the standalone launch", () => {
    const launch = resolveServerLaunch({
      root,
      execPath: "C:/nodejs/node.exe",
      existsSync: (p: string) => p.replace(/\\/g, "/").includes("dist/minder-server/server.js"),
      resolveNextBin,
      port: 4199,
    });
    expect(launch?.mode).toBe("standalone");
    expect(launch?.args).not.toContain("-p");
    expect(launch?.args).not.toContain("4199");
  });

  it("degrades to null if resolving the next bin throws, even though .next/BUILD_ID exists", () => {
    const launch = resolveServerLaunch({
      root,
      existsSync: (p: string) => p.replace(/\\/g, "/").includes(".next/BUILD_ID"),
      resolveNextBin: () => {
        throw new Error("MODULE_NOT_FOUND");
      },
    });
    expect(launch).toBeNull();
  });

  it("returns null when neither build artifact exists", () => {
    const launch = resolveServerLaunch({ root, existsSync: () => false, resolveNextBin });
    expect(launch).toBeNull();
  });

  it("prefers standalone over fallback when both exist", () => {
    const launch = resolveServerLaunch({ root, existsSync: () => true, resolveNextBin });
    expect(launch?.mode).toBe("standalone");
  });
});

describe("NO_BUILD_MESSAGE", () => {
  it("tells the user exactly how to build", () => {
    expect(NO_BUILD_MESSAGE).toContain("pnpm build");
    expect(NO_BUILD_MESSAGE).toContain("pnpm package:standalone");
    expect(NO_BUILD_MESSAGE).toContain("pnpm service:install");
  });
});

describe("detectPlatformKind", () => {
  it("maps win32/darwin/linux", () => {
    expect(detectPlatformKind("win32")).toBe("windows");
    expect(detectPlatformKind("darwin")).toBe("macos");
    expect(detectPlatformKind("linux")).toBe("linux");
  });

  it("throws for an unsupported platform", () => {
    expect(() => detectPlatformKind("aix")).toThrow(/Unsupported platform/);
  });
});

describe("isValidAction", () => {
  it("accepts the five supported actions", () => {
    for (const action of ["install", "uninstall", "status", "start", "stop"]) {
      expect(isValidAction(action)).toBe(true);
    }
  });

  it("rejects anything else", () => {
    expect(isValidAction("restart")).toBe(false);
    expect(isValidAction(undefined)).toBe(false);
    expect(isValidAction("")).toBe(false);
  });
});

describe("planActions", () => {
  const windowsCtx = { taskName: WINDOWS_TASK_NAME, xmlPath: "C:/x/task.xml" };
  const macCtx = { plistPath: "/Users/x/Library/LaunchAgents/com.minder.dashboard.plist", label: LAUNCHD_LABEL };
  const linuxCtx = { unitPath: "/home/x/.config/systemd/user/minder.service", unitName: SYSTEMD_UNIT_NAME };

  it("windows install imports the XML via schtasks /create", () => {
    expect(planActions("windows", "install", windowsCtx)).toEqual([
      { exe: "schtasks", args: ["/create", "/tn", WINDOWS_TASK_NAME, "/xml", "C:/x/task.xml", "/f"] },
    ]);
  });

  it("windows stop returns no schtasks step (handled via netstat + taskkill instead)", () => {
    expect(planActions("windows", "stop", windowsCtx)).toEqual([]);
  });

  it("windows uninstall/status/start map to the expected schtasks invocations", () => {
    expect(planActions("windows", "uninstall", windowsCtx)).toEqual([
      { exe: "schtasks", args: ["/delete", "/tn", WINDOWS_TASK_NAME, "/f"] },
    ]);
    expect(planActions("windows", "status", windowsCtx)).toEqual([
      { exe: "schtasks", args: ["/query", "/tn", WINDOWS_TASK_NAME, "/fo", "LIST", "/v"] },
    ]);
    expect(planActions("windows", "start", windowsCtx)).toEqual([
      { exe: "schtasks", args: ["/run", "/tn", WINDOWS_TASK_NAME] },
    ]);
  });

  it("macos maps to launchctl load/unload/list/start/stop", () => {
    expect(planActions("macos", "install", macCtx)).toEqual([
      { exe: "launchctl", args: ["load", "-w", macCtx.plistPath] },
    ]);
    expect(planActions("macos", "uninstall", macCtx)).toEqual([
      { exe: "launchctl", args: ["unload", "-w", macCtx.plistPath] },
    ]);
    expect(planActions("macos", "status", macCtx)).toEqual([{ exe: "launchctl", args: ["list", LAUNCHD_LABEL] }]);
    expect(planActions("macos", "start", macCtx)).toEqual([{ exe: "launchctl", args: ["start", LAUNCHD_LABEL] }]);
    expect(planActions("macos", "stop", macCtx)).toEqual([{ exe: "launchctl", args: ["stop", LAUNCHD_LABEL] }]);
  });

  it("linux maps to systemctl --user, with a Restart=on-failure-friendly stop (no forced kill)", () => {
    expect(planActions("linux", "install", linuxCtx)).toEqual([
      { exe: "systemctl", args: ["--user", "daemon-reload"] },
      { exe: "systemctl", args: ["--user", "enable", "--now", SYSTEMD_UNIT_NAME] },
    ]);
    // F4 review fix: daemon-reload is NOT part of this plan — it's issued
    // separately by scripts/service.mjs's runUninstall() AFTER the unit
    // file is removed (reloading while the file still exists and removing
    // it afterward leaves systemd's cache pointing at a deleted unit).
    expect(planActions("linux", "uninstall", linuxCtx)).toEqual([
      { exe: "systemctl", args: ["--user", "disable", "--now", SYSTEMD_UNIT_NAME] },
    ]);
    expect(planActions("linux", "status", linuxCtx)).toEqual([
      { exe: "systemctl", args: ["--user", "status", SYSTEMD_UNIT_NAME, "--no-pager"] },
    ]);
    expect(planActions("linux", "start", linuxCtx)).toEqual([
      { exe: "systemctl", args: ["--user", "start", SYSTEMD_UNIT_NAME] },
    ]);
    expect(planActions("linux", "stop", linuxCtx)).toEqual([
      { exe: "systemctl", args: ["--user", "stop", SYSTEMD_UNIT_NAME] },
    ]);
  });

  it("throws for an unknown action", () => {
    expect(() => planActions("windows", "restart", windowsCtx)).toThrow(/Unknown service action/);
  });
});

describe("parseNetstatListeningPids", () => {
  const sample = [
    "Proto  Local Address          Foreign Address        State           PID",
    "  TCP    0.0.0.0:4100           0.0.0.0:0              LISTENING       12345",
    "  TCP    127.0.0.1:4100         0.0.0.0:0              LISTENING       12345",
    "  TCP    [::]:4100              [::]:0                 LISTENING       6789",
    "  TCP    0.0.0.0:4200           0.0.0.0:0              LISTENING       999",
    "  TCP    0.0.0.0:4100           10.0.0.5:51000         ESTABLISHED     4242",
  ].join("\r\n");

  it("extracts unique PIDs LISTENING on the given port, ignoring other ports/states", () => {
    expect(parseNetstatListeningPids(sample, 4100).sort()).toEqual(["12345", "6789"]);
  });

  it("returns an empty array when nothing matches", () => {
    expect(parseNetstatListeningPids(sample, 9999)).toEqual([]);
  });

  it("returns an empty array for empty input", () => {
    expect(parseNetstatListeningPids("", 4100)).toEqual([]);
  });
});

describe("resolveWindowsUserId", () => {
  it("prefixes with the domain when present", () => {
    expect(resolveWindowsUserId({ env: { USERNAME: "josh", USERDOMAIN: "DESKTOP-ABC" } })).toBe("DESKTOP-ABC\\josh");
  });

  it("falls back to just the username when there is no domain", () => {
    expect(resolveWindowsUserId({ env: { USERNAME: "josh" } })).toBe("josh");
  });

  it("accepts an explicit username override", () => {
    expect(resolveWindowsUserId({ env: {}, username: "override" })).toBe("override");
  });
});

describe("buildServerIdentityMarkers + commandLineMatchesServer (service:stop identity check)", () => {
  const vbsPath = "C:\\Users\\josh\\.minder\\service\\run-hidden.vbs";
  const nextBinPath = "C:\\repo\\node_modules\\next\\dist\\bin\\next";

  const standaloneLaunch = {
    mode: "standalone",
    exe: "C:\\Program Files\\nodejs\\node.exe",
    args: ["C:\\repo\\dist\\minder-server\\server.js"],
    cwd: "C:\\repo\\dist\\minder-server",
  };
  // F7 shape: fallback now launches as execPath + the resolved next bin JS
  // file (no more node_modules/.bin/next(.cmd) shell shim).
  const fallbackLaunch = {
    mode: "fallback",
    exe: "C:\\Program Files\\nodejs\\node.exe",
    args: [nextBinPath, "start", "-p", "4100", "--hostname", "127.0.0.1"], // F8 shape
    cwd: "C:\\repo",
  };

  it("standalone: matches a command line containing the server.js path (sufficient alone)", () => {
    const identity = buildServerIdentityMarkers({ launch: standaloneLaunch, vbsPath });
    const commandLine = `"C:\\Program Files\\nodejs\\node.exe" "C:\\repo\\dist\\minder-server\\server.js"`;
    expect(commandLineMatchesServer(commandLine, identity)).toBe(true);
  });

  it("fallback: matches a next START command line (next bin path + standalone start token)", () => {
    const identity = buildServerIdentityMarkers({ launch: fallbackLaunch, vbsPath });
    const commandLine = `"C:\\Program Files\\nodejs\\node.exe" "${nextBinPath}" start -p 4100`;
    expect(commandLineMatchesServer(commandLine, identity)).toBe(true);
  });

  // F6 review fix (the core requirement): `next dev` from the SAME repo,
  // using the SAME next bin path, must be refused — the whole point of the
  // signature redesign is that the next bin path alone is not entry-point
  // grade (it's shared between `next dev` and `next start`).
  it("F6: refuses `next dev` from the same repo even though it shares the same next bin path", () => {
    const identity = buildServerIdentityMarkers({ launch: fallbackLaunch, vbsPath });
    const commandLine = `"C:\\Program Files\\nodejs\\node.exe" "${nextBinPath}" dev -p 4100`;
    expect(commandLineMatchesServer(commandLine, identity)).toBe(false);
  });

  it("F6: refuses an ordinary `pnpm dev`/next dev command line with no next bin path match at all", () => {
    const identity = buildServerIdentityMarkers({ launch: fallbackLaunch, vbsPath });
    const commandLine = `"C:\\Program Files\\nodejs\\node.exe" "C:\\dev\\some-other-project\\node_modules\\next\\dist\\bin\\next" dev -p 4100`;
    expect(commandLineMatchesServer(commandLine, identity)).toBe(false);
  });

  it("matches case-insensitively and across separator styles (forward vs. back slash)", () => {
    const identity = buildServerIdentityMarkers({ launch: standaloneLaunch, vbsPath });
    const commandLine = `"c:/program files/nodejs/node.exe" "C:/repo/dist/minder-server/SERVER.JS"`;
    expect(commandLineMatchesServer(commandLine, identity)).toBe(true);
  });

  it("refuses an unrelated process's command line (the exact footgun this guards against)", () => {
    const identity = buildServerIdentityMarkers({ launch: standaloneLaunch, vbsPath });
    // An unrelated dev server (e.g. `pnpm dev` in a totally different checkout)
    // that happens to also be bound to port 4100.
    const commandLine = `"C:\\Program Files\\nodejs\\node.exe" "C:\\dev\\some-other-project\\node_modules\\next\\dist\\bin\\next" dev -p 4100`;
    expect(commandLineMatchesServer(commandLine, identity)).toBe(false);
  });

  it("refuses when the command line could not be determined (empty/undefined/null)", () => {
    const identity = buildServerIdentityMarkers({ launch: null, vbsPath });
    expect(commandLineMatchesServer("", identity)).toBe(false);
    expect(commandLineMatchesServer(undefined, identity)).toBe(false);
    expect(commandLineMatchesServer(null, identity)).toBe(false);
  });

  it("falls back to just the vbs path as a sufficient marker when launch is null (build removed after install)", () => {
    const identity = buildServerIdentityMarkers({ launch: null, vbsPath });
    expect(identity.sufficient).toEqual([vbsPath]);
    expect(identity.nextStartSignature).toBeNull();
    expect(commandLineMatchesServer(`wscript.exe "${vbsPath}"`, identity)).toBe(true);
  });

  // F1 review fix: fallback mode's bare CLI args ("start", "-p", "4100")
  // must never become sufficient markers on their own.
  it("never turns bare flags/subcommands/port numbers into markers", () => {
    const identity = buildServerIdentityMarkers({ launch: fallbackLaunch, vbsPath });
    expect(identity.sufficient).not.toContain("start");
    expect(identity.sufficient).not.toContain("-p");
    expect(identity.sufficient).not.toContain("4100");
  });

  it("refuses a command line that only coincidentally contains the port number, with no path marker present", () => {
    // An unrelated process that happens to mention 4100 somewhere in its
    // command line (e.g. a proxy configured to forward that port) but has
    // nothing to do with this Minder installation.
    const identity = buildServerIdentityMarkers({ launch: fallbackLaunch, vbsPath });
    const commandLine = `"C:\\Program Files\\some-proxy\\proxy.exe" --listen 4100 --target 9000`;
    expect(commandLineMatchesServer(commandLine, identity)).toBe(false);
  });

  // F1 + F6 review fix: the repo root/cwd are NEVER markers at all anymore
  // (neither sufficient alone, nor part of the signature) — only
  // entry-point-grade paths (server.js, the next bin file, run-hidden.vbs)
  // are. A bare `pnpm dev` from this exact repo must be refused even though
  // its cwd matches the fallback launch's cwd.
  it("F6: the repo root/cwd alone is never a sufficient identity — an ordinary `next dev` from this checkout is refused", () => {
    const identity = buildServerIdentityMarkers({ launch: fallbackLaunch, vbsPath });
    const commandLine = `"C:\\Program Files\\nodejs\\node.exe" "${nextBinPath}" dev -p 4100`; // cwd would be C:\repo, same as fallbackLaunch.cwd
    expect(commandLineMatchesServer(commandLine, identity)).toBe(false);
  });

  // F2 review fix: an entry-point marker must not match as a prefix of a
  // longer, unrelated sibling path — a match only counts when the character
  // right after the marker is a path separator, quote, whitespace, or
  // end-of-string.
  it("does not treat an entry-point marker as a prefix match against a longer sibling path", () => {
    const identity = buildServerIdentityMarkers({ launch: standaloneLaunch, vbsPath });
    const commandLine = `"C:\\Program Files\\nodejs\\node.exe" "C:\\repo\\dist\\minder-server2\\server.js"`;
    expect(commandLineMatchesServer(commandLine, identity)).toBe(false);
  });

  it("still matches the same marker with a genuine path-separator boundary", () => {
    const identity = buildServerIdentityMarkers({ launch: standaloneLaunch, vbsPath });
    const commandLine = `"C:\\Program Files\\nodejs\\node.exe" "C:\\repo\\dist\\minder-server\\server.js"`;
    expect(commandLineMatchesServer(commandLine, identity)).toBe(true);
  });

  it("matches when the marker is the entire haystack (end-of-string boundary)", () => {
    expect(commandLineMatchesServer("C:\\repo\\dist\\minder-server\\server.js", { sufficient: ["C:\\repo\\dist\\minder-server\\server.js"], nextStartSignature: null })).toBe(true);
  });

  it("matches when the marker is immediately followed by a closing quote", () => {
    expect(
      commandLineMatchesServer(`"C:\\repo\\dist\\minder-server\\server.js"`, {
        sufficient: ["C:\\repo\\dist\\minder-server\\server.js"],
        nextStartSignature: null,
      })
    ).toBe(true);
  });

  it("does not treat a 'start' substring inside a longer word/path segment as a standalone token", () => {
    const identity = buildServerIdentityMarkers({ launch: fallbackLaunch, vbsPath });
    // "restart" and a path segment literally containing "start" as part of
    // a longer name must not satisfy the standalone-token requirement.
    const commandLine = `"C:\\Program Files\\nodejs\\node.exe" "${nextBinPath}" restart -p 4100 --dir C:\\repo\\startup-scripts`;
    expect(commandLineMatchesServer(commandLine, identity)).toBe(false);
  });
});

describe("buildMacArtifacts (F9 review fix: escape every plist substitution)", () => {
  const standaloneLaunch = {
    mode: "standalone",
    exe: "/usr/local/bin/node",
    // A path containing an XML-significant character — the F9 scenario
    // (e.g. a "Projects/R&D" directory) — deliberately used for BOTH an
    // argument (already covered by the pre-existing escapeXml call) and
    // the working directory (previously substituted RAW).
    args: ["/Users/josh/Projects/R&D/dist/minder-server/server.js"],
    cwd: "/Users/josh/Projects/R&D/dist/minder-server",
  };

  it("escapes an XML-significant character in WorkingDirectory, not just ProgramArguments", () => {
    const { plistContent } = buildMacArtifacts(standaloneLaunch);
    expect(plistContent).toContain("R&amp;D");
    // No raw, unescaped "&" should reach the XML — every "&" present must
    // be the start of an entity reference (&amp; here).
    expect(plistContent).not.toMatch(/&(?!amp;|lt;|gt;|quot;|apos;)/);
  });

  it("produces well-formed XML (parseable, no bare ampersands)", () => {
    const { plistContent } = buildMacArtifacts(standaloneLaunch);
    // A minimal well-formedness smoke check without pulling in an XML
    // parser dependency: every "<string>...</string>" pair balances, and
    // there is no unescaped "&".
    const opens = (plistContent.match(/<string>/g) ?? []).length;
    const closes = (plistContent.match(/<\/string>/g) ?? []).length;
    expect(opens).toBe(closes);
    expect(plistContent).not.toMatch(/&(?!amp;|lt;|gt;|quot;|apos;)/);
  });
});

describe("buildLinuxArtifacts (F9 review fix: systemd quoting/percent-escaping)", () => {
  it("quotes an ExecStart argument containing spaces", () => {
    const launch = {
      mode: "standalone",
      exe: "/usr/bin/node",
      args: ["/home/josh/My Projects/dist/minder-server/server.js"],
      cwd: "/home/josh/My Projects/dist/minder-server",
    };
    const { unitContent } = buildLinuxArtifacts(launch);
    expect(unitContent).toContain('"/home/josh/My Projects/dist/minder-server/server.js"');
  });

  it("doubles a literal percent sign in both ExecStart and WorkingDirectory (specifier-expansion escape)", () => {
    const launch = {
      mode: "standalone",
      exe: "/usr/bin/node",
      args: ["/home/josh/100%-project/dist/minder-server/server.js"],
      cwd: "/home/josh/100%-project/dist/minder-server",
    };
    const { unitContent } = buildLinuxArtifacts(launch);
    expect(unitContent).toContain("100%%-project");
    // The single-percent form must not appear anywhere — every "%" must be doubled.
    expect(unitContent).not.toMatch(/100%-project/);
  });
});

describe("buildMacArtifacts / buildLinuxArtifacts (F15 review fix: install-time PATH capture)", () => {
  const launch = {
    mode: "standalone",
    exe: "/usr/local/bin/node",
    args: ["/Users/josh/dist/minder-server/server.js"],
    cwd: "/Users/josh/dist/minder-server",
  };

  function withPath(value: string, fn: () => void) {
    const original = process.env.PATH;
    process.env.PATH = value;
    try {
      fn();
    } finally {
      process.env.PATH = original;
    }
  }

  it("captures the installing process's PATH into the plist's EnvironmentVariables", () => {
    withPath("/opt/homebrew/bin:/usr/local/bin:/usr/bin", () => {
      const { plistContent } = buildMacArtifacts(launch);
      expect(plistContent).toContain("<key>PATH</key>");
      expect(plistContent).toContain("<string>/opt/homebrew/bin:/usr/local/bin:/usr/bin</string>");
    });
  });

  it("captures the installing process's PATH into the systemd unit's Environment= directive", () => {
    withPath("/opt/homebrew/bin:/usr/local/bin:/usr/bin", () => {
      const { unitContent } = buildLinuxArtifacts(launch);
      expect(unitContent).toContain("Environment=PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin");
    });
  });

  it("percent-escapes a literal % in a captured PATH for the systemd unit", () => {
    withPath("/home/josh/100%-tools/bin:/usr/bin", () => {
      const { unitContent } = buildLinuxArtifacts(launch);
      expect(unitContent).toContain("100%%-tools");
      expect(unitContent).not.toMatch(/100%-tools/); // no un-doubled "%" survives
    });
  });

  it("XML-escapes an XML-significant character in a captured PATH for the plist", () => {
    withPath("/Users/josh/R&D/bin:/usr/bin", () => {
      const { plistContent } = buildMacArtifacts(launch);
      expect(plistContent).toContain("R&amp;D");
      expect(plistContent).not.toMatch(/&(?!amp;|lt;|gt;|quot;|apos;)/);
    });
  });
});

describe("resolveServicePort (install-time)", () => {
  it("defaults to 4100 when neither MINDER_PORT nor PORT is set", () => {
    expect(resolveServicePort({})).toBe(DEFAULT_SERVICE_PORT);
  });

  it("prefers MINDER_PORT over PORT so the service port is independent of the shell's PORT", () => {
    expect(resolveServicePort({ MINDER_PORT: "4199", PORT: "3000" })).toBe(4199);
  });

  it("falls back to PORT when MINDER_PORT is absent", () => {
    expect(resolveServicePort({ PORT: "3000" })).toBe(3000);
  });

  it.each([["garbage"], ["0"], ["-5"], ["65536"], [""]])(
    "rejects the invalid port %s and uses the default",
    (raw) => {
      expect(resolveServicePort({ MINDER_PORT: raw })).toBe(DEFAULT_SERVICE_PORT);
    }
  );
});

describe("resolveInstalledPort (stop-time)", () => {
  const vbsWithPort = (p: string) => `WshEnv("PORT") = "${p}"\nWshShell.Run "x", 0, False`;

  it("prefers the manifest's recorded port", () => {
    const manifestJson = JSON.stringify({ mode: "standalone", exe: "node", args: [], port: 4199 });
    expect(resolveInstalledPort({ manifestJson, vbsContent: vbsWithPort("3000") })).toEqual({
      port: 4199,
      source: "manifest",
    });
  });

  it("falls back to the vbs for installs predating the manifest port field", () => {
    const manifestJson = JSON.stringify({ mode: "standalone", exe: "node", args: [] });
    expect(resolveInstalledPort({ manifestJson, vbsContent: vbsWithPort("4199") })).toEqual({
      port: 4199,
      source: "vbs",
    });
  });

  it("falls back to the default when neither source is present", () => {
    expect(resolveInstalledPort({})).toEqual({ port: DEFAULT_SERVICE_PORT, source: "default" });
  });

  it("tolerates a corrupt manifest by falling through to the vbs", () => {
    expect(resolveInstalledPort({ manifestJson: "{not json", vbsContent: vbsWithPort("4199") })).toEqual({
      port: 4199,
      source: "vbs",
    });
  });

  it("ignores an out-of-range manifest port rather than scanning an impossible port", () => {
    const manifestJson = JSON.stringify({ port: 99999 });
    expect(resolveInstalledPort({ manifestJson })).toEqual({
      port: DEFAULT_SERVICE_PORT,
      source: "default",
    });
  });

  // The regression this whole path exists to prevent: installing on a custom
  // port and then stopping from a shell with no MINDER_PORT set must still
  // find the running service.
  it("recovers a custom install port with no environment help at all", () => {
    const manifestJson = JSON.stringify({ mode: "standalone", exe: "node", args: [], port: 4199 });
    expect(resolveInstalledPort({ manifestJson }).port).toBe(4199);
  });
});
