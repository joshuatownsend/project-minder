import { describe, it, expect, vi, beforeEach } from "vitest";

// The ingest worker is its own isolate, so everything /api/health and
// minder.log know about it arrives as messages. `absorbWorkerMessage` is the
// fold that turns those into host state (#561 memory, #558 watcher mode) and
// forwarded service-log lines (#560 quarantine reasons). Pure over a state
// slice, so no worker thread is spawned here.

vi.mock("@/lib/serviceLog", () => ({ serviceLog: vi.fn() }));

import { serviceLog } from "@/lib/serviceLog";
import { absorbWorkerMessage } from "@/lib/db/workerHost";

function fresh() {
  return { memory: null, watcher: null } as Parameters<typeof absorbWorkerMessage>[0];
}

describe("absorbWorkerMessage", () => {
  beforeEach(() => vi.mocked(serviceLog).mockClear());

  it("records the worker's memory self-report", () => {
    const s = fresh();
    absorbWorkerMessage(s, { type: "memory", heapTotalMb: 40, heapUsedMb: 22, at: 123 });
    expect(s.memory).toEqual({ heapTotalMb: 40, heapUsedMb: 22, at: 123 });
  });

  it("ignores a malformed memory report rather than storing garbage", () => {
    const s = fresh();
    absorbWorkerMessage(s, { type: "memory", heapTotalMb: "lots" });
    expect(s.memory).toBeNull();
  });

  it("takes the initial watcher snapshot from the started ack", () => {
    const s = fresh();
    absorbWorkerMessage(s, {
      type: "started",
      status: { running: true, watcherMode: "arming", initialReconcileMs: null, eventsHandled: 0 },
    });
    expect(s.watcher).toEqual({ watcherMode: "arming", initialReconcileMs: null, eventsHandled: 0 });
  });

  it("flips the mode on a later watcher-mode message, keeping the other fields", () => {
    const s = fresh();
    absorbWorkerMessage(s, {
      type: "started",
      status: { watcherMode: "arming", initialReconcileMs: 745076, eventsHandled: 3 },
    });
    absorbWorkerMessage(s, { type: "watcher-mode", mode: "chokidar" });
    expect(s.watcher).toEqual({ watcherMode: "chokidar", initialReconcileMs: 745076, eventsHandled: 3 });
  });

  it("refreshes the frozen reconcile duration and event count from a later watcher-status (#563)", () => {
    const s = fresh();
    // The `started` ack under deferInitialReconcile: reconcile still in flight.
    absorbWorkerMessage(s, {
      type: "started",
      status: { watcherMode: "chokidar", initialReconcileMs: null, eventsHandled: 0 },
    });
    expect(s.watcher).toMatchObject({ initialReconcileMs: null, eventsHandled: 0 });
    // The completion message alone updates the duration.
    absorbWorkerMessage(s, { type: "initial-reconcile", ms: 12400 });
    expect(s.watcher).toMatchObject({ initialReconcileMs: 12400, eventsHandled: 0 });
    // A later periodic snapshot advances the event count.
    absorbWorkerMessage(s, {
      type: "watcher-status",
      watcherMode: "chokidar",
      initialReconcileMs: 12400,
      eventsHandled: 318,
    });
    expect(s.watcher).toEqual({ watcherMode: "chokidar", initialReconcileMs: 12400, eventsHandled: 318 });
  });

  it("ignores an initial-reconcile before any watcher snapshot exists", () => {
    const s = fresh();
    absorbWorkerMessage(s, { type: "initial-reconcile", ms: 12400 });
    expect(s.watcher).toBeNull();
  });

  it("rejects an unknown mode value", () => {
    const s = fresh();
    absorbWorkerMessage(s, { type: "watcher-mode", mode: "turbo" });
    expect(s.watcher).toBeNull();
  });

  it("writes a forwarded service-log entry stamped with the thread", () => {
    absorbWorkerMessage(fresh(), {
      type: "service-log",
      entry: { level: "warn", subsystem: "db", msg: "quarantined corrupt index", reason: "quick_check returned x" },
    });
    expect(serviceLog).toHaveBeenCalledWith({
      level: "warn",
      subsystem: "db",
      msg: "quarantined corrupt index",
      reason: "quick_check returned x",
      thread: "ingest-worker",
    });
  });

  it("drops a service-log message with no usable entry", () => {
    absorbWorkerMessage(fresh(), { type: "service-log", entry: { level: "warn" } });
    absorbWorkerMessage(fresh(), { type: "service-log" });
    expect(serviceLog).not.toHaveBeenCalled();
  });

  it("leaves state alone for unrelated and non-object messages", () => {
    const s = fresh();
    absorbWorkerMessage(s, { type: "pong" });
    absorbWorkerMessage(s, "ready");
    absorbWorkerMessage(s, null);
    expect(s).toEqual({ memory: null, watcher: null });
  });
});
