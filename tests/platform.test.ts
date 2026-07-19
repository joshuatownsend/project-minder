import { describe, it, expect, vi, afterEach } from "vitest";
import type { ChildProcess } from "child_process";

// Mock child_process.spawn at module level so it's hoisted before any imports.
// spawnDevServer and killProcessTree tests use this to verify platform-correct arguments.
vi.mock("child_process", () => ({
  spawn: vi.fn(() => ({
    on: vi.fn(),
    stdout: null,
    stderr: null,
    pid: 999,
  })),
}));

// We test the pure functions by importing them after mocking process.platform.
// spawnDevServer and killProcessTree are tested by mocking child_process.spawn
// and process.kill to verify the correct platform branch is taken.

describe("normalizePath", () => {
  it("converts backslashes to forward slashes", async () => {
    const { normalizePath } = await import("@/lib/platform");
    expect(normalizePath("C:\\dev\\project")).toBe("C:/dev/project");
  });

  it("leaves forward slashes unchanged", async () => {
    const { normalizePath } = await import("@/lib/platform");
    expect(normalizePath("/home/user/dev/foo")).toBe("/home/user/dev/foo");
  });

  it("is idempotent", async () => {
    const { normalizePath } = await import("@/lib/platform");
    const p = "C:/dev/project";
    expect(normalizePath(normalizePath(p))).toBe(p);
  });
});

describe("normalizePathKey — case folding gated to Windows", () => {
  const originalPlatform = process.platform;
  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    vi.resetModules();
  });

  it("lowercases on win32 (case-insensitive filesystem)", async () => {
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    vi.resetModules();
    const { normalizePathKey } = await import("@/lib/platform");
    expect(normalizePathKey("C:\\Dev\\MyApp")).toBe("c:/dev/myapp");
  });

  it("preserves case on POSIX (case-sensitive filesystem)", async () => {
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    vi.resetModules();
    const { normalizePathKey } = await import("@/lib/platform");
    // /home/me/Foo and /home/me/foo are DIFFERENT directories — folding them
    // would merge distinct projects and misattribute their sessions (B1 fix
    // must not apply on POSIX).
    expect(normalizePathKey("/home/me/Foo")).toBe("/home/me/Foo");
    expect(normalizePathKey("/home/me/Foo")).not.toBe(normalizePathKey("/home/me/foo"));
  });
});

describe("sessionFileHomeKey — Claude-home derivation from a session file path (#311)", () => {
  const originalPlatform = process.platform;
  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    vi.resetModules();
  });

  async function win32Fn() {
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    vi.resetModules();
    const { sessionFileHomeKey } = await import("@/lib/platform");
    return sessionFileHomeKey;
  }

  it("derives the home from a primary-home session file", async () => {
    const fn = await win32Fn();
    expect(fn("C:\\Users\\Me\\.claude\\projects\\C--dev-app\\abc.jsonl")).toBe(
      "c:/users/me/.claude"
    );
  });

  it("canonicalizes the legacy wsl$ alias like normalizePathKey does", async () => {
    const fn = await win32Fn();
    expect(fn("\\\\wsl$\\Ubuntu\\home\\me\\.claude\\projects\\-home-me-dev-app\\abc.jsonl")).toBe(
      "//wsl.localhost/ubuntu/home/me/.claude"
    );
  });

  it("handles subagent files two levels deeper", async () => {
    const fn = await win32Fn();
    expect(
      fn("C:\\Users\\Me\\.claude\\projects\\C--dev-app\\abc\\subagents\\agent-1.jsonl")
    ).toBe("c:/users/me/.claude");
  });

  it("uses the LAST /projects/ segment so a home path containing one still resolves", async () => {
    const fn = await win32Fn();
    expect(fn("D:\\projects\\.claude\\projects\\C--dev-app\\abc.jsonl")).toBe(
      "d:/projects/.claude"
    );
  });

  it("returns null for paths with no /projects/ segment", async () => {
    const fn = await win32Fn();
    expect(fn("C:\\Users\\Me\\.codex\\sessions\\abc.jsonl")).toBeNull();
    expect(fn("abc.jsonl")).toBeNull();
  });
});

describe("decodeDirName", () => {
  it("decodes Windows format: C--dev-project-minder (lossy — hyphens in name become backslashes)", async () => {
    const { decodeDirName } = await import("@/lib/platform");
    // Claude's encoding is lossy: project-minder hyphens are indistinguishable
    // from path-separator hyphens, so C--dev-project-minder → C:\dev\project\minder
    expect(decodeDirName("C--dev-project-minder")).toBe("C:\\dev\\project\\minder");
  });

  it("decodes Windows format with multiple segments", async () => {
    const { decodeDirName } = await import("@/lib/platform");
    expect(decodeDirName("C--Users-josh-dev-foo")).toBe("C:\\Users\\josh\\dev\\foo");
  });

  it("decodes Unix format: -home-user-dev-project", async () => {
    const { decodeDirName } = await import("@/lib/platform");
    expect(decodeDirName("-home-user-dev-project")).toBe("/home/user/dev/project");
  });

  it("decodes Unix format for macOS: -Users-josh-dev-foo", async () => {
    const { decodeDirName } = await import("@/lib/platform");
    expect(decodeDirName("-Users-josh-dev-foo")).toBe("/Users/josh/dev/foo");
  });

  it("does not confuse Unix uppercase segment with Windows drive letter", async () => {
    const { decodeDirName } = await import("@/lib/platform");
    // Unix path starting with dash — NOT a drive letter
    const result = decodeDirName("-Adam-dev-foo");
    expect(result).toBe("/Adam/dev/foo");
    expect(result).not.toContain(":");
  });

  it("Windows format starts with drive letter followed by colon, no leading slash", async () => {
    const { decodeDirName } = await import("@/lib/platform");
    const result = decodeDirName("D--projects-myapp");
    expect(result).toBe("D:\\projects\\myapp");
    expect(result).toMatch(/^[A-Z]:/);
  });
});

describe("getBinPath (platform-branched)", () => {
  // We mock process.platform by re-importing after vi.stubGlobal.
  // Vitest caches modules, so we need to clear the module cache between tests.

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("appends .cmd on Windows", async () => {
    vi.stubGlobal("process", { ...process, platform: "win32" });
    vi.resetModules();
    const { getBinPath } = await import("@/lib/platform");
    const result = getBinPath("C:\\dev\\myapp", "next");
    expect(result).toContain("next.cmd");
  });

  it("no extension on macOS", async () => {
    vi.stubGlobal("process", { ...process, platform: "darwin" });
    vi.resetModules();
    const { getBinPath } = await import("@/lib/platform");
    const result = getBinPath("/home/user/dev/myapp", "next");
    expect(result).toMatch(/[/\\]next$/);
    expect(result).not.toContain(".cmd");
  });

  it("no extension on Linux", async () => {
    vi.stubGlobal("process", { ...process, platform: "linux" });
    vi.resetModules();
    const { getBinPath } = await import("@/lib/platform");
    const result = getBinPath("/home/user/dev/myapp", "vite");
    expect(result).toMatch(/[/\\]vite$/);
    expect(result).not.toContain(".cmd");
  });
});

describe("getCleanSpawnEnv (platform-branched)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("includes Windows-specific vars on win32", async () => {
    vi.stubGlobal("process", { ...process, platform: "win32" });
    vi.resetModules();
    const { getCleanSpawnEnv } = await import("@/lib/platform");
    const env = getCleanSpawnEnv();
    expect(env).toHaveProperty("SystemRoot");
    expect(env).toHaveProperty("APPDATA");
    expect(env).toHaveProperty("LOCALAPPDATA");
    expect(env).toHaveProperty("USERPROFILE");
    expect(env).toHaveProperty("NODE_ENV", "development");
    expect(env).not.toHaveProperty("SHELL");
    expect(env).not.toHaveProperty("LANG");
  });

  it("includes Unix-specific vars on darwin", async () => {
    vi.stubGlobal("process", { ...process, platform: "darwin" });
    vi.resetModules();
    const { getCleanSpawnEnv } = await import("@/lib/platform");
    const env = getCleanSpawnEnv();
    expect(env).toHaveProperty("HOME");
    expect(env).toHaveProperty("SHELL");
    expect(env).toHaveProperty("LANG");
    expect(env).toHaveProperty("TMPDIR");
    expect(env).toHaveProperty("NODE_ENV", "development");
    expect(env).not.toHaveProperty("SystemRoot");
    expect(env).not.toHaveProperty("APPDATA");
  });

  it("always includes PATH and NODE_ENV", async () => {
    for (const platform of ["win32", "darwin", "linux"] as const) {
      vi.stubGlobal("process", { ...process, platform });
      vi.resetModules();
      const { getCleanSpawnEnv } = await import("@/lib/platform");
      const env = getCleanSpawnEnv();
      expect(env).toHaveProperty("PATH");
      expect(env).toHaveProperty("NODE_ENV", "development");
      vi.unstubAllGlobals();
    }
  });
});

describe("getDefaultDevRoot (platform-branched)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("returns C:\\dev on Windows", async () => {
    vi.stubGlobal("process", { ...process, platform: "win32" });
    vi.resetModules();
    const { getDefaultDevRoot } = await import("@/lib/platform");
    expect(getDefaultDevRoot()).toBe("C:\\dev");
  });

  it("returns a home-relative path on macOS (not the hardcoded Windows value)", async () => {
    vi.stubGlobal("process", { ...process, platform: "darwin" });
    vi.resetModules();
    const { getDefaultDevRoot } = await import("@/lib/platform");
    const result = getDefaultDevRoot();
    // Should end with /dev or \dev (os.homedir() joins platform-appropriately)
    // but crucially is NOT the hardcoded Windows "C:\\dev"
    expect(result).toContain("dev");
    expect(result).not.toBe("C:\\dev");
  });

  it("returns a home-relative path on Linux (not the hardcoded Windows value)", async () => {
    vi.stubGlobal("process", { ...process, platform: "linux" });
    vi.resetModules();
    const { getDefaultDevRoot } = await import("@/lib/platform");
    const result = getDefaultDevRoot();
    expect(result).toContain("dev");
    expect(result).not.toBe("C:\\dev");
  });
});

describe("spawnDevServer (platform-branched)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("wraps command in cmd.exe /c on Windows", async () => {
    vi.stubGlobal("process", { ...process, platform: "win32" });
    vi.resetModules();
    const spawnMock = vi.mocked((await import("child_process")).spawn);
    spawnMock.mockClear();

    const { spawnDevServer } = await import("@/lib/platform");
    spawnDevServer("next", ["dev", "--port", "3000"], "C:\\dev\\myapp", { NODE_ENV: "development" });

    expect(spawnMock).toHaveBeenCalledOnce();
    const [cmd, args] = spawnMock.mock.calls[0];
    expect(cmd).toBe("cmd.exe");
    expect(args).toEqual(["/c", "next", "dev", "--port", "3000"]);
  });

  it("spawns command directly with detached:true on Unix", async () => {
    vi.stubGlobal("process", { ...process, platform: "darwin" });
    vi.resetModules();
    const spawnMock = vi.mocked((await import("child_process")).spawn);
    spawnMock.mockClear();

    const { spawnDevServer } = await import("@/lib/platform");
    spawnDevServer("next", ["dev", "--port", "3000"], "/home/user/dev/myapp", { NODE_ENV: "development" });

    expect(spawnMock).toHaveBeenCalledOnce();
    const [cmd, args, opts] = spawnMock.mock.calls[0];
    expect(cmd).toBe("next");
    expect(args).toEqual(["dev", "--port", "3000"]);
    expect((opts as Record<string, unknown>)?.detached).toBe(true);
  });
});

describe("killProcessTree (platform-branched)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("calls taskkill /F /T /PID on Windows", async () => {
    vi.stubGlobal("process", { ...process, platform: "win32", kill: vi.fn() });
    vi.resetModules();
    const spawnMock = vi.mocked((await import("child_process")).spawn);
    spawnMock.mockClear();

    const { killProcessTree } = await import("@/lib/platform");
    killProcessTree(1234);

    expect(spawnMock).toHaveBeenCalledOnce();
    const [cmd, args] = spawnMock.mock.calls[0];
    expect(cmd).toBe("taskkill");
    expect(args).toContain("/F");
    expect(args).toContain("/T");
    expect(args).toContain("1234");
  });

  it("sends SIGTERM to negative PID (process group) on Unix", async () => {
    const killMock = vi.fn();
    vi.stubGlobal("process", { ...process, platform: "darwin", kill: killMock });
    vi.resetModules();

    const { killProcessTree } = await import("@/lib/platform");
    killProcessTree(5678);

    expect(killMock).toHaveBeenCalledWith(-5678, "SIGTERM");
  });
});
