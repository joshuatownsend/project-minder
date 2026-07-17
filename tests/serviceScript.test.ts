import { describe, it, expect } from "vitest";
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

  it("prefers the standalone package when dist/minder-server/server.js exists", () => {
    const launch = resolveServerLaunch({
      root,
      platform: "win32",
      execPath: "C:/nodejs/node.exe",
      existsSync: (p: string) => p.replace(/\\/g, "/").includes("dist/minder-server/server.js"),
    });
    expect(launch).toEqual({
      mode: "standalone",
      exe: "C:/nodejs/node.exe",
      args: ["C:\\repo\\dist\\minder-server\\server.js"],
      cwd: "C:\\repo\\dist\\minder-server",
      needsCmdWrapper: false,
    });
  });

  it("falls back to next start when only .next/BUILD_ID exists, needing a cmd wrapper on Windows", () => {
    const launch = resolveServerLaunch({
      root,
      platform: "win32",
      existsSync: (p: string) => p.replace(/\\/g, "/").includes(".next/BUILD_ID"),
    });
    expect(launch?.mode).toBe("fallback");
    expect(launch?.args).toEqual(["start", "-p", "4100"]);
    expect(launch?.needsCmdWrapper).toBe(true);
    expect(launch?.exe.replace(/\\/g, "/")).toMatch(/node_modules\/\.bin\/next\.cmd$/);
  });

  it("does not need a cmd wrapper for the fallback on non-Windows", () => {
    const launch = resolveServerLaunch({
      root,
      platform: "linux",
      existsSync: (p: string) => p.replace(/\\/g, "/").includes(".next/BUILD_ID"),
    });
    expect(launch?.needsCmdWrapper).toBe(false);
    expect(launch?.exe.replace(/\\/g, "/")).toMatch(/node_modules\/\.bin\/next$/);
  });

  it("returns null when neither build artifact exists", () => {
    const launch = resolveServerLaunch({ root, platform: "win32", existsSync: () => false });
    expect(launch).toBeNull();
  });

  it("prefers standalone over fallback when both exist", () => {
    const launch = resolveServerLaunch({ root, platform: "win32", existsSync: () => true });
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
    expect(planActions("linux", "uninstall", linuxCtx)).toEqual([
      { exe: "systemctl", args: ["--user", "disable", "--now", SYSTEMD_UNIT_NAME] },
      { exe: "systemctl", args: ["--user", "daemon-reload"] },
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
