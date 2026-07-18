import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("child_process", () => ({
  execFile: vi.fn(),
}));
vi.mock("fs", () => ({
  promises: {
    readdir: vi.fn(),
    stat: vi.fn(),
  },
}));

import { execFile } from "child_process";
import { promises as fs } from "fs";
import {
  decodeWslOutput,
  parseWslDistroList,
  parseWslUncPath,
  listWslDistros,
  checkWslRoot,
  discoverWslSuggestions,
  clearWslCache,
} from "@/lib/wsl";

const mockExecFile = vi.mocked(execFile);
const mockReaddir = vi.mocked(fs.readdir);
const mockStat = vi.mocked(fs.stat);

/** Build the UTF-16LE buffer wsl.exe actually emits (BOM + CRLF). */
function wslBuffer(text: string): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]);
}

const SAMPLE_LIST = [
  "  NAME              STATE           VERSION",
  "* Ubuntu-26.04      Running         2",
  "  docker-desktop    Stopped         2",
  "  Debian            Stopped         1",
].join("\r\n");

function mockWslSuccess(text: string = SAMPLE_LIST) {
  // wsl.ts wraps execFile in a manual promise: (file, args, opts, cb).
  mockExecFile.mockImplementation(((_f: unknown, _a: unknown, _o: unknown, cb: unknown) => {
    (cb as (e: Error | null, stdout: Buffer, stderr: Buffer) => void)(
      null, wslBuffer(text), Buffer.alloc(0)
    );
    return {} as never;
  }) as never);
}

function mockWslFailure() {
  mockExecFile.mockImplementation(((_f: unknown, _a: unknown, _o: unknown, cb: unknown) => {
    (cb as (e: Error | null, stdout: Buffer, stderr: Buffer) => void)(
      new Error("'wsl.exe' is not recognized"), Buffer.alloc(0), Buffer.alloc(0)
    );
    return {} as never;
  }) as never);
}

let platformSpy: { restore: () => void } | null = null;

function setPlatform(platform: NodeJS.Platform) {
  const original = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: platform });
  platformSpy = { restore: () => Object.defineProperty(process, "platform", original) };
}

beforeEach(() => {
  vi.clearAllMocks();
  clearWslCache();
});

afterEach(() => {
  platformSpy?.restore();
  platformSpy = null;
});

describe("decodeWslOutput", () => {
  it("decodes UTF-16LE with BOM", () => {
    expect(decodeWslOutput(wslBuffer("Ubuntu\r\n"))).toBe("Ubuntu\r\n");
  });

  it("decodes BOM-less UTF-16LE via embedded NULs", () => {
    const buf = Buffer.from("Ubuntu", "utf16le");
    expect(decodeWslOutput(buf)).toBe("Ubuntu");
  });

  it("passes plain UTF-8 through unchanged", () => {
    expect(decodeWslOutput(Buffer.from("Ubuntu-26.04 Running 2", "utf8"))).toBe(
      "Ubuntu-26.04 Running 2"
    );
  });
});

describe("parseWslDistroList", () => {
  it("parses names, states, versions and the default marker", () => {
    const distros = parseWslDistroList(SAMPLE_LIST);
    expect(distros).toEqual([
      { name: "Ubuntu-26.04", state: "Running", version: 2, isDefault: true },
      { name: "docker-desktop", state: "Stopped", version: 2, isDefault: false },
      { name: "Debian", state: "Stopped", version: 1, isDefault: false },
    ]);
  });

  it("drops the header row and blank/malformed lines", () => {
    const distros = parseWslDistroList("  NAME STATE VERSION\r\n\r\ngarbage\r\n");
    expect(distros).toEqual([]);
  });

  it("tolerates stray NULs from mis-decoded output", () => {
    const distros = parseWslDistroList("* U\0buntu Running 2");
    expect(distros).toEqual([
      { name: "Ubuntu", state: "Running", version: 2, isDefault: true },
    ]);
  });

  it("keeps names containing spaces intact", () => {
    const distros = parseWslDistroList("  My Custom Distro   Stopped   2");
    expect(distros[0].name).toBe("My Custom Distro");
  });
});

describe("parseWslUncPath", () => {
  it.each([
    ["\\\\wsl.localhost\\Ubuntu-26.04\\home\\josh\\dev", "Ubuntu-26.04"],
    ["\\\\wsl$\\Ubuntu\\home", "Ubuntu"],
    ["//wsl.localhost/Ubuntu-26.04/home/josh/dev", "Ubuntu-26.04"],
    ["\\\\WSL.LOCALHOST\\Debian", "Debian"],
  ])("extracts the distro from %s", (p, distro) => {
    expect(parseWslUncPath(p)).toEqual({ distro });
  });

  it.each(["C:\\dev", "/home/josh/dev", "\\\\server\\share", "wsl.localhost\\Ubuntu"])(
    "returns null for non-WSL path %s",
    (p) => {
      expect(parseWslUncPath(p)).toBeNull();
    }
  );
});

describe("listWslDistros", () => {
  it("returns null off Windows without spawning wsl.exe", async () => {
    setPlatform("linux");
    expect(await listWslDistros()).toBeNull();
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it("parses distros on Windows and caches the result", async () => {
    setPlatform("win32");
    mockWslSuccess();
    const first = await listWslDistros();
    expect(first).toHaveLength(3);
    await listWslDistros();
    expect(mockExecFile).toHaveBeenCalledTimes(1);
  });

  it("returns null (and caches it) when wsl.exe fails", async () => {
    setPlatform("win32");
    mockWslFailure();
    expect(await listWslDistros()).toBeNull();
    expect(await listWslDistros()).toBeNull();
    expect(mockExecFile).toHaveBeenCalledTimes(1);
  });
});

describe("checkWslRoot", () => {
  it("returns null for non-WSL roots (no wsl.exe spawn)", async () => {
    setPlatform("win32");
    expect(await checkWslRoot("C:\\dev")).toBeNull();
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it("approves a running distro's root", async () => {
    setPlatform("win32");
    mockWslSuccess();
    expect(await checkWslRoot("\\\\wsl.localhost\\Ubuntu-26.04\\home\\josh\\dev")).toEqual({
      ok: true,
      distro: "Ubuntu-26.04",
    });
  });

  it("rejects a stopped distro's root with wsl-stopped", async () => {
    setPlatform("win32");
    mockWslSuccess();
    expect(await checkWslRoot("\\\\wsl.localhost\\Debian\\home")).toEqual({
      ok: false,
      distro: "Debian",
      reason: "wsl-stopped",
    });
  });

  it("matches distro names case-insensitively", async () => {
    setPlatform("win32");
    mockWslSuccess();
    const check = await checkWslRoot("\\\\wsl.localhost\\ubuntu-26.04\\home");
    expect(check?.ok).toBe(true);
  });

  it("rejects unknown distros with wsl-distro-not-found", async () => {
    setPlatform("win32");
    mockWslSuccess();
    expect(await checkWslRoot("\\\\wsl.localhost\\Fedora\\home")).toEqual({
      ok: false,
      distro: "Fedora",
      reason: "wsl-distro-not-found",
    });
  });

  it("rejects WSL roots when WSL is unavailable", async () => {
    setPlatform("linux");
    expect(await checkWslRoot("\\\\wsl.localhost\\Ubuntu\\home")).toEqual({
      ok: false,
      distro: "Ubuntu",
      reason: "wsl-unavailable",
    });
  });
});

describe("discoverWslSuggestions", () => {
  it("reports unavailable when WSL is missing", async () => {
    setPlatform("linux");
    expect(await discoverWslSuggestions()).toEqual({ available: false, distros: [] });
  });

  it("probes running distros only, skips docker-desktop, lists stopped untouched", async () => {
    setPlatform("win32");
    mockWslSuccess();
    mockReaddir.mockResolvedValue([
      { name: "josh", isDirectory: () => true },
      { name: "lost+found", isDirectory: () => true },
    ] as never);
    mockStat.mockImplementation((async (p: string) => {
      const exists = p.endsWith("josh\\dev") || p.endsWith("josh\\.claude");
      if (!exists) throw new Error("ENOENT");
      return { isDirectory: () => true };
    }) as never);

    const result = await discoverWslSuggestions();
    expect(result.available).toBe(true);
    // docker-desktop filtered; Ubuntu (running) + Debian (stopped) listed.
    expect(result.distros.map((d) => d.name)).toEqual(["Ubuntu-26.04", "Debian"]);

    const ubuntu = result.distros[0];
    expect(ubuntu.suggestedRoots).toEqual([
      "\\\\wsl.localhost\\Ubuntu-26.04\\home\\josh\\dev",
    ]);
    expect(ubuntu.claudeHomes).toEqual([
      "\\\\wsl.localhost\\Ubuntu-26.04\\home\\josh\\.claude",
    ]);

    // Stopped distro: listed, but its filesystem was never touched.
    const debian = result.distros[1];
    expect(debian.suggestedRoots).toEqual([]);
    const touchedDebian = [
      ...mockReaddir.mock.calls.map((c) => String(c[0])),
      ...mockStat.mock.calls.map((c) => String(c[0])),
    ].some((p) => p.includes("Debian"));
    expect(touchedDebian).toBe(false);
  });

  it("keeps a running distro with unreadable /home, minus suggestions", async () => {
    setPlatform("win32");
    mockWslSuccess("* Alpine  Running  2");
    mockReaddir.mockRejectedValue(new Error("EACCES"));
    const result = await discoverWslSuggestions();
    expect(result.distros).toEqual([
      { name: "Alpine", state: "Running", isDefault: true, suggestedRoots: [], claudeHomes: [] },
    ]);
  });
});
