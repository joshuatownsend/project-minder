import { describe, it, expect, afterEach, vi } from "vitest";
import path from "path";
import { writeFileSync, mkdtempSync, rmSync } from "fs";
import os from "os";

// #586 — the ingest worker's start handshake budget, and the trace it leaves
// when it is exhausted.

const serviceLog = vi.hoisted(() => vi.fn());
vi.mock("@/lib/serviceLog", () => ({ serviceLog }));

let tmpDir: string | null = null;

function createInlineWorker(body: string): string {
  if (!tmpDir) tmpDir = mkdtempSync(path.join(os.tmpdir(), "pm-worker-budget-"));
  const file = path.join(tmpDir, `worker-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`);
  writeFileSync(file, body, "utf8");
  return file;
}

const READY_BUT_NEVER_STARTS = `
import { parentPort } from "node:worker_threads";
parentPort.postMessage({ type: "ready" });
parentPort.on("message", (msg) => { if (msg?.type === "stop") process.exit(0); });
`;

// Acks the first `start`, then crashes; every respawned instance never acks.
// The marker file (beside this worker) is how a fresh thread tells it is a respawn.
const ACKS_ONCE_THEN_CRASHES_THEN_SILENT = `
import { parentPort } from "node:worker_threads";
import { existsSync, writeFileSync } from "node:fs";
const marker = new URL("./respawn-marker", import.meta.url);
parentPort.postMessage({ type: "ready" });
parentPort.on("message", (msg) => {
  if (msg?.type === "stop") process.exit(0);
  if (msg?.type !== "start") return;
  if (existsSync(marker)) return;
  writeFileSync(marker, "1");
  parentPort.postMessage({ type: "started" });
  setTimeout(() => process.exit(1), 30);
});
`;

const NEVER_READY = `
setInterval(() => {}, 60_000);
`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// First instance: ready, acks `start`, then crashes. Every respawned instance
// (the marker file beside this worker exists) sits silent and never reports ready.
const CRASHES_THEN_RESPAWNS_NEVER_READY = `
import { parentPort } from "node:worker_threads";
import { existsSync, writeFileSync } from "node:fs";
const marker = new URL("./respawn-ready-marker", import.meta.url);
if (existsSync(marker)) {
  setInterval(() => {}, 60_000);
} else {
  parentPort.postMessage({ type: "ready" });
  parentPort.on("message", (msg) => {
    if (msg?.type === "stop") process.exit(0);
    if (msg?.type !== "start") return;
    writeFileSync(marker, "1");
    parentPort.postMessage({ type: "started" });
    setTimeout(() => process.exit(1), 30);
  });
}
`;

async function loadHost() {
  vi.resetModules();
  const gg = globalThis as { __minderWorker?: unknown; __minderWorkerCrashLog?: unknown };
  delete gg.__minderWorker;
  delete gg.__minderWorkerCrashLog;
  return import("@/lib/db/workerHost");
}

afterEach(async () => {
  serviceLog.mockClear();
  try {
    const mod = await import("@/lib/db/workerHost");
    await mod.stopWorker();
  } catch {
    /* fine */
  }
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  }
});

describe("worker start handshake budget (#586)", () => {
  it("outlasts a cold index open plus the watcher's ready cap", async () => {
    const { DEFAULT_START_TIMEOUT_MS } = await loadHost();
    // Measured on the live 2.5 GB index: `initDb` 21 s warm / 95-101 s cold
    // (quick_check is O(size)), then up to 30 s waiting on chokidar `ready`.
    // The old 60 s left 9 s of headroom warm and none cold, so every boot fell
    // back to the in-process watcher. If the index grows or those steps change,
    // re-measure — this is the floor, not the target.
    const COLD_DB_OPEN_MS = 101_000;
    const WATCHER_READY_CAP_MS = 30_000;
    expect(DEFAULT_START_TIMEOUT_MS).toBeGreaterThanOrEqual(2 * (COLD_DB_OPEN_MS + WATCHER_READY_CAP_MS));
  });

  it("records why and how long in the durable log when the handshake fails", async () => {
    const host = await loadHost();
    const onStartFailure = vi.fn();

    await host.startWorker({
      workerEntry: createInlineWorker(READY_BUT_NEVER_STARTS),
      awaitStart: false,
      startTimeoutMs: 150,
      onStartFailure,
    });

    await vi.waitFor(() => expect(onStartFailure).toHaveBeenCalledTimes(1), { timeout: 3000 });

    const entry = serviceLog.mock.calls.map((c) => c[0]).find((e) => e.subsystem === "ingest-worker");
    expect(entry).toBeDefined();
    expect(entry.level).toBe("warn");
    expect(entry.msg).toMatch(/start handshake failed after \d+ ms/);
    expect(entry.msg).toMatch(/start timeout \(150 ms\)/);
    expect(entry.msg).toMatch(/falling back to the in-process watcher/);
    expect(entry.startTimeoutMs).toBe(150);
    expect(entry.elapsedMs).toBeGreaterThanOrEqual(100);
  });

  it("records a failed RESPAWN handshake in the durable log too", async () => {
    // A nonzero worker exit respawns the worker and re-sends `start`; that path
    // has its own rejection handler and used to log to stdout only, so a slow or
    // failed respawn left /api/health on `in-process` with no line in
    // minder.log saying why (Codex, PR #589).
    const host = await loadHost();
    const onStartFailure = vi.fn();

    await host.startWorker({
      workerEntry: createInlineWorker(ACKS_ONCE_THEN_CRASHES_THEN_SILENT),
      awaitStart: false,
      startTimeoutMs: 150,
      onStartFailure,
    });

    await vi.waitFor(() => expect(onStartFailure).toHaveBeenCalledTimes(1), { timeout: 8000 });

    const entry = serviceLog.mock.calls.map((c) => c[0]).find((e) => e.phase === "respawn");
    expect(entry).toBeDefined();
    expect(entry.level).toBe("warn");
    expect(entry.msg).toMatch(/^respawn start handshake failed after \d+ ms/);
    expect(entry.msg).toMatch(/start timeout \(150 ms\)/);
    // The initial handshake succeeded, so the ONLY failure logged is the respawn's.
    expect(serviceLog.mock.calls.map((c) => c[0]).filter((e) => e.phase === "initial")).toHaveLength(0);
  });

  it("logs a failed AWAITED handshake too, without claiming a fallback that will not happen", async () => {
    // `awaitStart` defaults to true, and the durable log used to be attached only
    // to the fire-and-forget branch — so a default caller's failure was a bare
    // rejection with nothing in minder.log (Copilot, PR #589). With no
    // onStartFailure registered nothing falls back, so the line must not say so.
    const host = await loadHost();
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await expect(
        host.startWorker({
          workerEntry: createInlineWorker(READY_BUT_NEVER_STARTS),
          startTimeoutMs: 150,
        })
      ).rejects.toThrow(/start timeout \(150 ms\)/);

      const entry = serviceLog.mock.calls.map((c) => c[0]).find((e) => e.subsystem === "ingest-worker");
      expect(entry).toBeDefined();
      expect(entry.msg).toMatch(/^start handshake failed after \d+ ms \(worker start timeout \(150 ms\)\)$/);
      expect(entry.msg).not.toMatch(/falling back/);

      // serviceLog (mocked here) is what tees to the console in production; a
      // direct console.warn as well printed every failure twice.
      expect(consoleWarn.mock.calls.flat().join(" ")).not.toMatch(/start handshake failed/);
    } finally {
      consoleWarn.mockRestore();
    }
  });

  it("logs a worker that never becomes ready (the failure before the handshake)", async () => {
    // The ready phase ends in the same `ingest.mode: "in-process"`, but its
    // rejection is thrown to the caller rather than routed through
    // onStartFailure, and the caller's own catch writes to stdout only — so it was
    // the one class of start failure still missing from minder.log (Copilot,
    // PR #589).
    const host = await loadHost();
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await expect(
        host.startWorker({ workerEntry: createInlineWorker(NEVER_READY), readyTimeoutMs: 150 })
      ).rejects.toThrow(/ready timeout \(150 ms\)/);

      const entry = serviceLog.mock.calls.map((c) => c[0]).find((e) => e.phase === "ready");
      expect(entry).toBeDefined();
      expect(entry.level).toBe("warn");
      expect(entry.subsystem).toBe("ingest-worker");
      expect(entry.msg).toMatch(/^worker failed before ready after \d+ ms \(worker ready timeout \(150 ms\)\)$/);
      expect(entry.readyTimeoutMs).toBe(150);
    } finally {
      consoleWarn.mockRestore();
    }
  });

  it("does not log a fault when startup is interrupted by our own stopWorker()", async () => {
    // Shutting down mid-boot rejects the ready wait with "worker stopped before
    // ready". That is the server stopping, not the worker failing.
    const host = await loadHost();
    const starting = host
      .startWorker({ workerEntry: createInlineWorker(NEVER_READY), readyTimeoutMs: 30_000 })
      .then(
        () => "resolved",
        (e: Error) => e.message
      );

    await sleep(100);
    await host.stopWorker();

    await expect(starting).resolves.toMatch(/stopped before ready/);
    expect(serviceLog.mock.calls.map((c) => c[0]).filter((e) => e.phase === "ready")).toHaveLength(0);
  });

  it("does not log a fault when the START HANDSHAKE is interrupted by our own stopWorker()", async () => {
    // The handshake's rejection on an intentional stop is a shutdown, not a
    // worker fault. The pre-ready path already withheld the warning; this one
    // logged `start handshake failed` unconditionally (Copilot, PR #589). The
    // rejection must still propagate to onStartFailure.
    const host = await loadHost();
    const onStartFailure = vi.fn();

    await host.startWorker({
      workerEntry: createInlineWorker(READY_BUT_NEVER_STARTS),
      awaitStart: false,
      startTimeoutMs: 30_000,
      onStartFailure,
    });
    await sleep(100);
    await host.stopWorker();

    await vi.waitFor(() => expect(onStartFailure).toHaveBeenCalledTimes(1), { timeout: 3000 });
    expect(serviceLog.mock.calls.map((c) => c[0]).filter((e) => e.phase === "initial")).toHaveLength(0);
  });

  it("logs a respawned worker that never becomes ready", async () => {
    // The respawn's ready wait has no awaiter, and the handshake chain swallowed
    // its rejection, so a respawn that timed out before `ready` left no trace
    // (Copilot, PR #589).
    const host = await loadHost();

    await host.startWorker({
      workerEntry: createInlineWorker(CRASHES_THEN_RESPAWNS_NEVER_READY),
      awaitStart: false,
      readyTimeoutMs: 1500,
      onStartFailure: vi.fn(),
    });

    await vi.waitFor(
      () => expect(serviceLog.mock.calls.map((c) => c[0]).some((e) => e.phase === "respawn-ready")).toBe(true),
      { timeout: 10_000 }
    );

    const entry = serviceLog.mock.calls.map((c) => c[0]).find((e) => e.phase === "respawn-ready");
    expect(entry.level).toBe("warn");
    expect(entry.msg).toMatch(/^respawned worker failed before ready after \d+ ms \(worker ready timeout \(1500 ms\)\)$/);
    expect(entry.readyTimeoutMs).toBe(1500);
    expect(entry.msg).not.toMatch(/falling back/);
  });
});
