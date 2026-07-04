/**
 * Tests for src/lib/processManager.ts
 *
 * Mocks:
 *   - @/lib/platform (spawnDevServer, killProcessTree, getBinPath, getCleanSpawnEnv)
 *   - fs/promises (package.json reads inside detectDevCommand)
 *   - net (isPortInUse helper)
 *
 * All tests use vi.resetModules() to get a fresh processManager singleton so
 * state from one test cannot bleed into another.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "events";

// ---------------------------------------------------------------------------
// Platform mock — hoisted so the vi.mock factory below can reference it
// ---------------------------------------------------------------------------
const { mockKillProcessTree, mockSpawnDevServer, mockGetBinPath } = vi.hoisted(() => {
  const mockKillProcessTree = vi.fn().mockResolvedValue(undefined as void);
  const mockSpawnDevServer = vi.fn();
  const mockGetBinPath = vi.fn((_projectPath: string, bin: string) =>
    `/fake/${bin}`
  );
  return { mockKillProcessTree, mockSpawnDevServer, mockGetBinPath };
});

vi.mock("@/lib/platform", () => ({
  isWindows: false,
  getCleanSpawnEnv: vi.fn(() => ({})),
  spawnDevServer: mockSpawnDevServer,
  killProcessTree: mockKillProcessTree,
  getBinPath: mockGetBinPath,
}));

// ---------------------------------------------------------------------------
// fs mock — control package.json content per test
// ---------------------------------------------------------------------------
const { mockReadFile } = vi.hoisted(() => {
  const mockReadFile = vi.fn();
  return { mockReadFile };
});

vi.mock("fs", () => {
  // We need to provide both the default export and named exports.
  // processManager.ts uses `import { promises as fs } from "fs"`.
  return {
    promises: {
      readFile: mockReadFile,
    },
  };
});

// ---------------------------------------------------------------------------
// net mock — control isPortInUse() responses per test
// ---------------------------------------------------------------------------
const { netCreateServer } = vi.hoisted(() => {
  // Will be replaced per-test via netServerBehavior
  const netCreateServer = vi.fn();
  return { netCreateServer };
});

vi.mock("net", () => ({
  default: { createServer: netCreateServer },
  createServer: netCreateServer,
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal fake ChildProcess. exitCode=null means "still running". */
function makeFakeProc(pid = 1234, exitCode: number | null = null) {
  const emitter = new EventEmitter();
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  return Object.assign(emitter, { pid, exitCode, stdout, stderr });
}

/**
 * Configure the net.createServer mock so that isPortInUse() behaves as
 * specified.  Each call to createServer() produces a server whose behaviour
 * is driven by the supplied responses array.
 *
 * When `inUse` is true: emit "error" → resolve(true).
 * When `inUse` is false: emit "listening" then call server.close() → resolve(false).
 */
function setupNetMock(responses: boolean[]) {
  let callIndex = 0;
  netCreateServer.mockImplementation(() => {
    const inUse = responses[callIndex] ?? false;
    callIndex++;
    const srv = new EventEmitter() as EventEmitter & {
      listen: (port: number, host: string) => void;
      close: () => void;
    };
    srv.listen = (_port: number, _host: string) => {
      // Emit asynchronously so the Promise chain has time to wire up `.once`.
      setImmediate(() => {
        if (inUse) {
          srv.emit("error", new Error("EADDRINUSE"));
        } else {
          srv.emit("listening");
        }
      });
    };
    srv.close = vi.fn();
    return srv;
  });
}

/** Reset mocks and modules before each test. */
beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Suite 1: detectDevCommand port parsing (driven through start())
// ---------------------------------------------------------------------------
describe("detectDevCommand — port parsing via start()", () => {
  it("detects --port N from a next dev script", async () => {
    mockReadFile.mockResolvedValueOnce(
      JSON.stringify({ scripts: { dev: "next dev --port 4100" } })
    );
    // Port is in-use on first check (our fake proc won't actually bind, so
    // we need port to look free so start() proceeds).
    setupNetMock([false]); // port 4100 is free

    const fakeProc = makeFakeProc(111);
    mockSpawnDevServer.mockReturnValue(fakeProc);

    const { processManager } = await import("@/lib/processManager");
    const info = await processManager.start("my-app", "/fake/path");

    expect(info.port).toBe(4100);
    expect(info.command).toContain("--port");
    expect(info.command).toContain("4100");
    expect(info.status).toBe("running");
  });

  it("detects PORT=N env prefix from a script", async () => {
    mockReadFile.mockResolvedValueOnce(
      JSON.stringify({ scripts: { dev: "PORT=3001 node server.js" } })
    );
    setupNetMock([false]); // port 3001 is free

    const fakeProc = makeFakeProc(222);
    mockSpawnDevServer.mockReturnValue(fakeProc);

    const { processManager } = await import("@/lib/processManager");
    const info = await processManager.start("node-app", "/fake/path");

    expect(info.port).toBe(3001);
  });

  it("defaults to port 3000 for a next script with no explicit port", async () => {
    mockReadFile.mockResolvedValueOnce(
      JSON.stringify({ scripts: { dev: "next dev" } })
    );
    setupNetMock([false]); // port 3000 is free

    const fakeProc = makeFakeProc(333);
    mockSpawnDevServer.mockReturnValue(fakeProc);

    const { processManager } = await import("@/lib/processManager");
    const info = await processManager.start("next-app", "/fake/path");

    expect(info.port).toBe(3000);
    expect(info.command).toContain("3000");
  });

  it("detects --port=N (equals form, B6)", async () => {
    mockReadFile.mockResolvedValueOnce(
      JSON.stringify({ scripts: { dev: "next dev --port=4100" } })
    );
    setupNetMock([false]); // port 4100 is free

    const fakeProc = makeFakeProc(444);
    mockSpawnDevServer.mockReturnValue(fakeProc);

    const { processManager } = await import("@/lib/processManager");
    const info = await processManager.start("equals-app", "/fake/path");

    expect(info.port).toBe(4100);
  });

  it("detects -pN (no-space short form, B6)", async () => {
    mockReadFile.mockResolvedValueOnce(
      JSON.stringify({ scripts: { dev: "vite -p4100" } })
    );
    setupNetMock([false]); // port 4100 is free

    const fakeProc = makeFakeProc(445);
    mockSpawnDevServer.mockReturnValue(fakeProc);

    const { processManager } = await import("@/lib/processManager");
    const info = await processManager.start("vite-app", "/fake/path");

    expect(info.port).toBe(4100);
  });
});

// ---------------------------------------------------------------------------
// Suite 2: stop() awaits the kill before mutating status
// ---------------------------------------------------------------------------
describe("stop() awaits killProcessTree before resolving", () => {
  it("resolves only after the deferred kill resolves, then sets status=stopped", async () => {
    // Wire up a deferred kill so we can control when it resolves.
    let resolveKill!: () => void;
    const killPromise = new Promise<void>((res) => { resolveKill = res; });
    mockKillProcessTree.mockReturnValueOnce(killPromise);

    // Port is free so start() proceeds.
    setupNetMock([false]);
    const fakeProc = makeFakeProc(9001, null); // pid=9001, still running
    mockSpawnDevServer.mockReturnValue(fakeProc);

    mockReadFile.mockResolvedValueOnce(
      JSON.stringify({ scripts: { dev: "next dev --port 4200" } })
    );

    const { processManager } = await import("@/lib/processManager");
    await processManager.start("svc", "/fake/path");

    // Now call stop() — should NOT resolve until killPromise resolves.
    let stopResolved = false;
    const stopPromise = processManager.stop("svc").then((info) => {
      stopResolved = true;
      return info;
    });

    // Give microtasks a chance to run; kill hasn't resolved yet.
    await Promise.resolve();
    await Promise.resolve();
    expect(stopResolved).toBe(false);
    expect(mockKillProcessTree).toHaveBeenCalledWith(9001);

    // Now let the kill finish.
    resolveKill();
    const info = await stopPromise;

    expect(stopResolved).toBe(true);
    expect(info?.status).toBe("stopped");
    expect(info?.output).toContain("--- Server stopped ---");
  });

  it("returns undefined for an unknown slug without calling killProcessTree", async () => {
    const { processManager } = await import("@/lib/processManager");
    const result = await processManager.stop("nonexistent-slug");
    expect(result).toBeUndefined();
    expect(mockKillProcessTree).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Suite 2b: start() concurrency guard (S4) — check-then-act race
// ---------------------------------------------------------------------------
describe("start() concurrency guard (S4)", () => {
  it("two overlapping start() calls for the same slug result in exactly one spawn", async () => {
    mockReadFile.mockResolvedValueOnce(
      JSON.stringify({ scripts: { dev: "next dev --port 4300" } })
    );
    setupNetMock([false]); // port 4300 is free (only the winning call checks it)

    const fakeProc = makeFakeProc(555);
    mockSpawnDevServer.mockReturnValue(fakeProc);

    const { processManager } = await import("@/lib/processManager");

    // Fire both calls back-to-back, synchronously, before either can await
    // past its first suspension point — this is exactly the race S4 guards
    // against. Without the synchronous placeholder reservation, both would
    // pass isRunning() and both would spawn.
    const p1 = processManager.start("concurrent-app", "/fake/path");
    const p2 = processManager.start("concurrent-app", "/fake/path");

    const [info1, info2] = await Promise.all([p1, p2]);

    // Only the first call should have ever reached detectDevCommand/spawn.
    expect(mockReadFile).toHaveBeenCalledTimes(1);
    expect(mockSpawnDevServer).toHaveBeenCalledTimes(1);

    // The winning call completes the real start flow.
    expect(info1.pid).toBe(555);
    expect(info1.status).toBe("running");

    // The losing call observed the synchronously-reserved placeholder and
    // returned early without spawning anything of its own.
    expect(info2.pid).toBe(0);
    expect(info2.slug).toBe("concurrent-app");
  });
});

// ---------------------------------------------------------------------------
// Suite 2b: stop() during start()'s pre-spawn awaits (S4 race guard)
// ---------------------------------------------------------------------------
describe("start()/stop() race — pre-spawn guard", () => {
  it("does not spawn a server when stop() lands while start() is detecting the command", async () => {
    // Suspend start() inside detectDevCommand by making the package.json read
    // hang until we release it — this is the window in which the placeholder
    // is registered but no real child has spawned yet.
    let releaseRead!: (value: string) => void;
    const readGate = new Promise<string>((resolve) => {
      releaseRead = resolve;
    });
    mockReadFile.mockReturnValueOnce(readGate);
    setupNetMock([false]); // port free, so start() would otherwise spawn
    mockSpawnDevServer.mockReturnValue(makeFakeProc(222));

    const { processManager } = await import("@/lib/processManager");

    // start() runs synchronously up to the suspended package.json read, so the
    // "starting" placeholder is already registered when we call stop().
    const startPromise = processManager.start("racy", "/fake/path");
    const stopResult = await processManager.stop("racy");
    expect(stopResult?.status).toBe("stopped");

    // Let start() resume past command detection and hit the pre-spawn guard.
    releaseRead(JSON.stringify({ scripts: { dev: "next dev --port 4100" } }));
    const startResult = await startPromise;

    // The guard must have aborted the spawn and surfaced the stopped state,
    // rather than leaving a live server behind a "stopped" response.
    expect(mockSpawnDevServer).not.toHaveBeenCalled();
    expect(startResult.status).toBe("stopped");
    expect(processManager.get("racy")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Suite 3: restart() polls isPortInUse before starting (fake timers)
// ---------------------------------------------------------------------------
describe("restart() polls port before start()", () => {
  // Fake-timer wiring through vi.resetModules() + dynamic import is fiddly
  // because the module loading itself uses timers. Tracking as a follow-up
  // (see plan 004 maintenance notes).
  it.todo(
    "waits for the port to free (isPortInUse: true, true, false) before starting"
  );
});
