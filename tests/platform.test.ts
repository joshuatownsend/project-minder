import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// We test the pure functions by importing them after mocking process.platform.
// Functions that call spawn/process.kill are excluded from unit tests — they
// require integration testing on the target platform.

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
