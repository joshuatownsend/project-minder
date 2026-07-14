import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "events";
import path from "path";
import { resolveCommandOnPath, probeMcpServer } from "@/lib/mcpHealth";
import type { McpServer } from "@/lib/types";

vi.mock("fs", () => ({
  promises: {
    access: vi.fn(),
  },
  // resolveCommandOnPath imports `constants` for F_OK / X_OK.
  constants: { F_OK: 0, X_OK: 1 },
}));

import { promises as fs } from "fs";
const mockAccess = vi.mocked(fs.access);

/** Make only the listed absolute paths "exist"; everything else rejects. */
function existsOnly(...paths: string[]) {
  const set = new Set(paths);
  mockAccess.mockImplementation((p: unknown) =>
    set.has(String(p)) ? Promise.resolve() : Promise.reject(new Error("ENOENT")),
  );
}

function server(overrides: Partial<McpServer>): McpServer {
  return {
    name: "srv",
    transport: "stdio",
    source: "user",
    sourcePath: "/x/.claude.json",
    ...overrides,
  };
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.unstubAllGlobals());

describe("resolveCommandOnPath", () => {
  it("returns null for an empty command without touching the FS", async () => {
    expect(await resolveCommandOnPath("")).toBeNull();
    expect(mockAccess).not.toHaveBeenCalled();
  });

  // Build expected paths with the SAME platform-pure implementation the
  // function uses, so these assertions are faithful (and host-independent):
  // path.posix for the POSIX cases, path.win32 for the win32 case.
  it("resolves a bare name against each PATH dir (POSIX)", async () => {
    const binA = path.posix.join("/usr", "bin");
    const binB = path.posix.join("/opt", "bin");
    const target = path.posix.join(binB, "mytool");
    existsOnly(target);

    const env = { PATH: [binA, binB].join(path.posix.delimiter) };
    expect(await resolveCommandOnPath("mytool", env, "linux")).toBe(target);
  });

  it("tries PATHEXT extensions on win32 (with Windows path semantics)", async () => {
    const dir = "C:\\tools";
    const target = path.win32.join(dir, "mytool") + ".EXE";
    existsOnly(target);

    // The drive-letter colon is safe: the function splits PATH by
    // path.win32.delimiter (";"), not the host's ":" — the point of the fix.
    const env = { Path: dir, PATHEXT: ".COM;.EXE;.CMD" };
    expect(await resolveCommandOnPath("mytool", env, "win32")).toBe(target);
  });

  it("resolves an explicit path directly, not against PATH", async () => {
    const explicit = path.posix.join("/abs", "path", "tool");
    existsOnly(explicit);

    // PATH is irrelevant here — the command carries a separator.
    const env = { PATH: path.posix.join("/usr", "bin") };
    expect(await resolveCommandOnPath(explicit, env, "linux")).toBe(explicit);
  });

  it("returns null when the command is nowhere on PATH", async () => {
    existsOnly(/* nothing exists */);
    const env = { PATH: path.posix.join("/usr", "bin") };
    expect(await resolveCommandOnPath("ghost", env, "linux")).toBeNull();
  });
});

describe("probeMcpServer — http/sse", () => {
  it("marks any HTTP response as up (even 401)", async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status: 401, body: { cancel } }));

    const r = await probeMcpServer(server({ transport: "http", command: undefined, url: "https://mcp.example/api" }));
    expect(r.status).toBe("up");
    expect(r.probeKind).toBe("http");
    expect(r.detail).toContain("401");
    expect(cancel).toHaveBeenCalled(); // stream cancelled, not leaked
  });

  it("marks a connection failure as down", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED")));

    const r = await probeMcpServer(server({ transport: "sse", command: undefined, url: "https://down.example" }));
    expect(r.status).toBe("down");
    expect(r.detail).toMatch(/unreachable/i);
  });

  it("classifies a timeout distinctly", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("The operation was aborted due to timeout")));

    const r = await probeMcpServer(server({ transport: "http", command: undefined, url: "https://slow.example" }));
    expect(r.status).toBe("down");
    expect(r.detail).toMatch(/timed out/i);
  });
});

describe("probeMcpServer — stdio", () => {
  it("is up (launchable) when the command resolves on PATH", async () => {
    const target = path.posix.join("/usr", "bin", "node");
    existsOnly(target);

    const r = await probeMcpServer(server({ transport: "stdio", command: "node" }), {
      env: { PATH: path.posix.join("/usr", "bin") },
      platform: "linux",
    });
    expect(r.status).toBe("up");
    expect(r.probeKind).toBe("command");
    expect(r.detail).toMatch(/launchable/i);
  });

  it("is down when the command is missing from PATH", async () => {
    existsOnly(/* nothing */);

    const r = await probeMcpServer(server({ transport: "stdio", command: "does-not-exist" }), {
      env: { PATH: path.posix.join("/usr", "bin") },
      platform: "linux",
    });
    expect(r.status).toBe("down");
    expect(r.probeKind).toBe("command");
    expect(r.detail).toMatch(/not found/i);
  });

  it("routes to the real handshake when stdioHandshake is on", async () => {
    const child = new EventEmitter() as EventEmitter & {
      pid: number;
      stdin: { write: () => void };
      stdout: EventEmitter & { setEncoding: () => void };
      kill: () => void;
    };
    child.pid = 1;
    child.stdin = { write: () => {} };
    const stdout = new EventEmitter() as EventEmitter & { setEncoding: () => void };
    stdout.setEncoding = () => {};
    child.stdout = stdout;
    child.kill = () => {};

    const p = probeMcpServer(server({ transport: "stdio", command: "node" }), {
      stdioHandshake: true,
      spawnFn: (() => child) as never,
      handshakeTimeoutMs: 500,
      handshakeSpawnHelpers: { readEnv: async () => ({}), killFn: () => {} },
    });
    await new Promise((r) => setTimeout(r, 5));
    child.stdout.emit(
      "data",
      JSON.stringify({ jsonrpc: "2.0", id: 1, result: { serverInfo: { name: "n" } } }) + "\n",
    );
    const r = await p;
    expect(r.probeKind).toBe("handshake");
    expect(r.status).toBe("up");
  });
});

describe("probeMcpServer — no probe", () => {
  it("returns unknown for a disabled server", async () => {
    const r = await probeMcpServer(server({ disabled: true, command: "node" }));
    expect(r.status).toBe("unknown");
    expect(r.probeKind).toBe("none");
    expect(r.detail).toMatch(/disabled/i);
  });

  it("returns unknown for an unknown transport", async () => {
    const r = await probeMcpServer(server({ transport: "unknown", command: undefined }));
    expect(r.status).toBe("unknown");
    expect(r.probeKind).toBe("none");
  });
});
