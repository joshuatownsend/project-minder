import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "events";
import { probeStdioHandshake } from "@/lib/mcpStdioProbe";
import type { McpServer } from "@/lib/types";

function server(overrides: Partial<McpServer>): McpServer {
  return {
    name: "srv",
    transport: "stdio",
    source: "user",
    sourcePath: "/x/.claude.json",
    command: "node",
    ...overrides,
  };
}

/** Minimal ChildProcess stand-in the tests drive by hand. */
function makeChild() {
  const child = new EventEmitter() as EventEmitter & {
    pid: number;
    stdin: { write: ReturnType<typeof vi.fn> };
    stdout: EventEmitter & { setEncoding: ReturnType<typeof vi.fn> };
    kill: ReturnType<typeof vi.fn>;
  };
  child.pid = 4242;
  child.stdin = { write: vi.fn() };
  const stdout = new EventEmitter() as EventEmitter & { setEncoding: ReturnType<typeof vi.fn> };
  stdout.setEncoding = vi.fn();
  child.stdout = stdout;
  child.kill = vi.fn();
  return child;
}

// Common injected helpers: no real env read, no real process kill.
const helpers = { readEnv: async () => ({}), killFn: () => {} };

// Let the awaited readEnv microtask + the Promise executor (spawn + stdin.write)
// run. setImmediate is a macrotask, so it always fires after those microtasks —
// no wall-clock dependency (unlike a fixed setTimeout, which can flake on slow CI).
const tick = () => new Promise((r) => setImmediate(r));

describe("probeStdioHandshake", () => {
  it("is up on a valid initialize result (and reports serverInfo name)", async () => {
    const child = makeChild();
    const p = probeStdioHandshake(server({}), { spawnFn: (() => child) as never, timeoutMs: 500, ...helpers });
    await tick();
    expect(child.stdin.write).toHaveBeenCalled(); // sent initialize
    child.stdout.emit(
      "data",
      JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2024-11-05", serverInfo: { name: "my-mcp" } } }) + "\n",
    );
    const r = await p;
    expect(r.ok).toBe(true);
    expect(r.detail).toContain("my-mcp");
    expect(child.kill).not.toHaveBeenCalled(); // killFn injected, real kill untouched
  });

  it("normalizes and truncates a hostile serverInfo.name", async () => {
    const child = makeChild();
    const p = probeStdioHandshake(server({}), { spawnFn: (() => child) as never, timeoutMs: 500, ...helpers });
    await tick();
    const nasty = "evil\n\n" + "x".repeat(200); // newlines + very long
    child.stdout.emit("data", JSON.stringify({ jsonrpc: "2.0", id: 1, result: { serverInfo: { name: nasty } } }) + "\n");
    const r = await p;
    expect(r.ok).toBe(true);
    expect(r.detail).not.toContain("\n");
    expect(r.detail.length).toBeLessThan(80); // "initialize ok — " + capped name
  });

  it("is down on a JSON-RPC error response", async () => {
    const child = makeChild();
    const p = probeStdioHandshake(server({}), { spawnFn: (() => child) as never, timeoutMs: 500, ...helpers });
    await tick();
    child.stdout.emit("data", JSON.stringify({ jsonrpc: "2.0", id: 1, error: { message: "bad protocol" } }) + "\n");
    const r = await p;
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/initialize error/i);
  });

  it("ignores non-JSON log lines before the response", async () => {
    const child = makeChild();
    const p = probeStdioHandshake(server({}), { spawnFn: (() => child) as never, timeoutMs: 500, ...helpers });
    await tick();
    child.stdout.emit("data", "starting up...\n[info] listening\n"); // noise, not our frame
    child.stdout.emit("data", JSON.stringify({ jsonrpc: "2.0", id: 1, result: { serverInfo: {} } }) + "\n");
    const r = await p;
    expect(r.ok).toBe(true);
  });

  it("is down when the process exits before responding", async () => {
    const child = makeChild();
    const p = probeStdioHandshake(server({}), { spawnFn: (() => child) as never, timeoutMs: 500, ...helpers });
    await tick();
    child.emit("exit", 1, null);
    const r = await p;
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/exited/i);
  });

  it("is down (command not found) on an ENOENT spawn error", async () => {
    const child = makeChild();
    const p = probeStdioHandshake(server({}), { spawnFn: (() => child) as never, timeoutMs: 500, ...helpers });
    await tick();
    const err = Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
    child.emit("error", err);
    const r = await p;
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/not found/i);
  });

  it("times out when the server never answers", async () => {
    const child = makeChild();
    const r = await probeStdioHandshake(server({}), { spawnFn: (() => child) as never, timeoutMs: 30, ...helpers });
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/timed out/i);
  });

  it("passes the configured cwd to spawn", async () => {
    const child = makeChild();
    let capturedOpts: { cwd?: string } | undefined;
    const spawnFn = ((_cmd: string, _args: string[], opts: { cwd?: string }) => {
      capturedOpts = opts;
      return child;
    }) as never;
    const p = probeStdioHandshake(server({ command: "node", args: ["server.js"], cwd: "/path/to/server" }), {
      spawnFn,
      timeoutMs: 500,
      ...helpers,
    });
    await tick();
    expect(capturedOpts?.cwd).toBe("/path/to/server");
    child.stdout.emit("data", JSON.stringify({ jsonrpc: "2.0", id: 1, result: { serverInfo: {} } }) + "\n");
    await p;
  });

  it("is down without spawning when there's no command", async () => {
    const spawnFn = vi.fn();
    const r = await probeStdioHandshake(server({ command: undefined }), { spawnFn: spawnFn as never, ...helpers });
    expect(r.ok).toBe(false);
    expect(spawnFn).not.toHaveBeenCalled();
  });
});
