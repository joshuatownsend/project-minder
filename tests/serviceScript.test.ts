import { describe, it, expect } from "vitest";
import path from "node:path";
import {
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
  WINDOWS_TASK_NAME,
  LAUNCHD_LABEL,
  SYSTEMD_UNIT_NAME,
} from "../scripts/service/lib.mjs";

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
      args: [fakeNextBinPath, "start", "-p", "4100"],
      cwd: root,
    });
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
    args: [nextBinPath, "start", "-p", "4100"],
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
