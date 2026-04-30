import { describe, it, expect, afterEach, vi } from "vitest";
import path from "path";
import { fileURLToPath } from "url";
import { writeFileSync, mkdtempSync, rmSync } from "fs";
import os from "os";

// Lifecycle test for workerHost.ts. Spawns the trivial ping/pong
// worker, exercises spawn → ready → message → stop and the
// crash → respawn path. Phase-2 tests (real watcher in worker)
// will live alongside the watcher tests; this file is scoped to the
// host's lifecycle contract.
//
// We don't test against `workers/ingestWorker.mjs` directly because
// `process.cwd()` in vitest may or may not be the project root
// depending on invocation. Instead we materialise a tiny inline
// worker into tmpdir per-test and pass it in via `workerEntry`.

let tmpDir: string | null = null;
let workerEntry: string | null = null;

function createInlineWorker(body: string): string {
  if (!tmpDir) tmpDir = mkdtempSync(path.join(os.tmpdir(), "pm-worker-host-"));
  const file = path.join(tmpDir, `worker-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`);
  writeFileSync(file, body, "utf8");
  workerEntry = file;
  return file;
}

const TRIVIAL_WORKER = `
import { parentPort } from "node:worker_threads";
parentPort.postMessage({ type: "ready" });
parentPort.on("message", (msg) => {
  if (msg?.type === "ping") parentPort.postMessage({ type: "pong", echo: msg.payload ?? null });
  else if (msg?.type === "stop") process.exit(0);
  else if (msg?.type === "crash") throw new Error("synthetic crash");
});
`;

const SLOW_READY_WORKER = `
import { parentPort } from "node:worker_threads";
// Never send 'ready' — used to test the ready timeout path.
parentPort.on("message", () => {});
`;

const NEVER_READY_NO_HANDLERS_WORKER = `
import { parentPort } from "node:worker_threads";
// Idle worker that never emits ready and never exits on its own.
setInterval(() => {}, 60_000);
`;

async function reloadHost() {
  vi.resetModules();
  delete (globalThis as { __minderWorker?: unknown }).__minderWorker;
  return await import("@/lib/db/workerHost");
}

afterEach(async () => {
  // Best-effort: ensure no orphaned worker survives a test.
  try {
    const mod = (await import("@/lib/db/workerHost")) as typeof import("@/lib/db/workerHost");
    await mod.stopWorker();
  } catch {
    /* fine */
  }
  if (tmpDir) {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    tmpDir = null;
    workerEntry = null;
  }
});

describe("workerHost lifecycle", () => {
  it("spawns, reaches ready, and reports running", async () => {
    const entry = createInlineWorker(TRIVIAL_WORKER);
    const host = await reloadHost();
    const status = await host.startWorker({ workerEntry: entry });
    expect(status.running).toBe(true);
    expect(status.startedAt).not.toBeNull();
    expect(status.lastReadyAt).not.toBeNull();
  });

  it("delivers ping → pong round-trip via postMessage / onWorkerMessage", async () => {
    const entry = createInlineWorker(TRIVIAL_WORKER);
    const host = await reloadHost();
    await host.startWorker({ workerEntry: entry });

    const messages: any[] = [];
    const unsub = host.onWorkerMessage((m) => messages.push(m));

    expect(host.postMessage({ type: "ping", payload: "hi" })).toBe(true);

    // Poll for the pong rather than racing a fixed sleep.
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      if (messages.some((m) => m?.type === "pong" && m.echo === "hi")) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    unsub();
    expect(messages.some((m) => m?.type === "pong" && m.echo === "hi")).toBe(true);
  });

  it("stopWorker terminates the worker and clears the singleton", async () => {
    const entry = createInlineWorker(TRIVIAL_WORKER);
    const host = await reloadHost();
    await host.startWorker({ workerEntry: entry });
    expect(host.getWorkerStatus().running).toBe(true);
    await host.stopWorker();
    expect(host.getWorkerStatus().running).toBe(false);
    // Idempotent — second stop is a no-op.
    await host.stopWorker();
    expect(host.getWorkerStatus().running).toBe(false);
  });

  it("startWorker is idempotent — second call replaces the worker", async () => {
    const entry = createInlineWorker(TRIVIAL_WORKER);
    const host = await reloadHost();
    const first = await host.startWorker({ workerEntry: entry });
    const second = await host.startWorker({ workerEntry: entry });
    expect(first.running).toBe(true);
    expect(second.running).toBe(true);
    // startedAt advances because the prior worker was terminated and
    // a fresh one was spawned.
    expect(second.startedAt!).toBeGreaterThanOrEqual(first.startedAt!);
  });

  it("respawns after an unexpected crash", async () => {
    const entry = createInlineWorker(TRIVIAL_WORKER);
    const host = await reloadHost();
    await host.startWorker({ workerEntry: entry });

    // Trigger a crash. The host should observe the non-zero exit and
    // schedule a respawn (500 ms backoff for the first crash).
    host.postMessage({ type: "crash" });

    // Wait for the new worker to come up.
    const deadline = Date.now() + 5000;
    let respawned = false;
    while (Date.now() < deadline) {
      const s = host.getWorkerStatus();
      if (s.running && s.crashesLastHour >= 1) {
        respawned = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(respawned).toBe(true);
  }, 10_000);

  it("subscriptions survive crash-respawn (subscriber registry)", async () => {
    const entry = createInlineWorker(TRIVIAL_WORKER);
    const host = await reloadHost();
    await host.startWorker({ workerEntry: entry });

    const messages: any[] = [];
    const unsub = host.onWorkerMessage((m) => messages.push(m));

    // Confirm the subscriber sees the original worker's messages.
    host.postMessage({ type: "ping", payload: "before-crash" });

    // Wait for "before-crash" pong, then crash + respawn, then ping again.
    const deadlineBefore = Date.now() + 2000;
    while (Date.now() < deadlineBefore) {
      if (messages.some((m) => m?.type === "pong" && m.echo === "before-crash")) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(messages.some((m) => m?.type === "pong" && m.echo === "before-crash")).toBe(true);

    host.postMessage({ type: "crash" });

    // Wait for respawn.
    const respawnDeadline = Date.now() + 5000;
    while (Date.now() < respawnDeadline) {
      const s = host.getWorkerStatus();
      if (s.running && s.crashesLastHour >= 1) break;
      await new Promise((r) => setTimeout(r, 50));
    }

    // The new worker may need a beat to be fully ready for messages.
    // Retry the ping until the post lands or we time out.
    const postDeadline = Date.now() + 3000;
    while (Date.now() < postDeadline) {
      if (host.postMessage({ type: "ping", payload: "after-crash" })) break;
      await new Promise((r) => setTimeout(r, 25));
    }

    const deadlineAfter = Date.now() + 3000;
    while (Date.now() < deadlineAfter) {
      if (messages.some((m) => m?.type === "pong" && m.echo === "after-crash")) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    unsub();

    // The original subscription must still receive messages from the
    // post-crash worker — that's the whole point of the registry.
    expect(messages.some((m) => m?.type === "pong" && m.echo === "after-crash")).toBe(true);
  }, 15_000);

  it("rejects when the worker never emits ready (timeout path)", async () => {
    const entry = createInlineWorker(NEVER_READY_NO_HANDLERS_WORKER);
    const host = await reloadHost();
    const result = await host.startWorker({ workerEntry: entry, readyTimeoutMs: 500 }).then(
      () => "resolved",
      (e: Error) => `rejected:${e.message}`
    );
    expect(result).toMatch(/rejected:.*ready timeout/);
  });

  it("stopWorker rejects a pending readyPromise (no 10 s hang on stop-during-startup)", async () => {
    const entry = createInlineWorker(NEVER_READY_NO_HANDLERS_WORKER);
    const host = await reloadHost();

    let resolved: "resolved" | "rejected" | "pending" = "pending";
    const startPromise = host
      .startWorker({ workerEntry: entry, readyTimeoutMs: 30_000 })
      .then(
        () => {
          resolved = "resolved";
        },
        () => {
          resolved = "rejected";
        }
      );

    // Give startWorker enough time to spawn the worker but nowhere near
    // 30 s (the timeout). stopWorker should unstick the pending await.
    await new Promise((r) => setTimeout(r, 200));
    expect(resolved).toBe("pending");

    const stopT0 = Date.now();
    await host.stopWorker();
    await startPromise;
    const stopElapsed = Date.now() - stopT0;

    expect(resolved).toBe("rejected");
    // If readyPromise weren't rejected by stopWorker, this would take
    // ~30 s instead of < 1 s.
    expect(stopElapsed).toBeLessThan(2000);
  });
});
