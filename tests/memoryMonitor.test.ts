import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// #561: the memory telemetry the tray-server exhaustion post-mortem lacked.
// serviceLog is mocked so the sampler's output is asserted directly; the
// worker host is mocked so the worker-heap fold-in can be driven from here.

vi.mock("@/lib/serviceLog", () => ({ serviceLog: vi.fn() }));
vi.mock("@/lib/db/workerHost", () => ({ getWorkerStatus: vi.fn() }));

import { serviceLog } from "@/lib/serviceLog";
import { getWorkerStatus } from "@/lib/db/workerHost";
import {
  formatMemorySample,
  memoryLogLevel,
  sampleMemory,
  startMemoryMonitor,
  MEMORY_WARN_RSS_MB,
  MEMORY_LOG_INTERVAL_MS,
} from "@/lib/memoryMonitor";

const MB = 1024 * 1024;

function mu(overrides: Partial<NodeJS.MemoryUsage> = {}): NodeJS.MemoryUsage {
  return {
    rss: 1500 * MB,
    heapTotal: 900 * MB,
    heapUsed: 850 * MB,
    external: 6 * MB,
    arrayBuffers: 1 * MB,
    ...overrides,
  };
}

const idleWorker = {
  running: false,
  startedAt: null,
  lastReadyAt: null,
  lastMessageAt: null,
  crashesLastHour: 0,
  workerEntry: "",
  memory: null,
  watcher: null,
};

describe("formatMemorySample", () => {
  it("reports every figure in whole megabytes and carries the worker sample through", () => {
    const worker = { heapTotalMb: 40, heapUsedMb: 12, at: 1 };
    expect(formatMemorySample(mu(), worker)).toEqual({
      rssMb: 1500,
      heapTotalMb: 900,
      heapUsedMb: 850,
      externalMb: 6,
      arrayBuffersMb: 1,
      worker,
    });
  });

  it("rounds rather than truncates", () => {
    expect(formatMemorySample(mu({ rss: 1.6 * MB }), null).rssMb).toBe(2);
  });
});

describe("memoryLogLevel", () => {
  it("is info below the ceiling and warn at or above it", () => {
    expect(memoryLogLevel(MEMORY_WARN_RSS_MB - 1)).toBe("info");
    expect(memoryLogLevel(MEMORY_WARN_RSS_MB)).toBe("warn");
    expect(memoryLogLevel(56_000)).toBe("warn");
  });

  it("keys on rss, so a heap-sized number under the ceiling never warns", () => {
    // The exhausted process had ~4 GB of heap and 56 GB of rss: the ceiling
    // must be compared against the figure that actually grew.
    expect(memoryLogLevel(4000, 4096)).toBe("info");
  });

  it("a zero ceiling disables the escalation", () => {
    expect(memoryLogLevel(100_000, 0)).toBe("info");
  });
});

describe("sampleMemory", () => {
  it("folds in the worker's last self-report", () => {
    vi.mocked(getWorkerStatus).mockReturnValue({
      ...idleWorker,
      running: true,
      memory: { heapTotalMb: 33, heapUsedMb: 20, at: 5 },
    });
    expect(sampleMemory().worker).toEqual({ heapTotalMb: 33, heapUsedMb: 20, at: 5 });
    expect(sampleMemory().rssMb).toBeGreaterThan(0);
  });

  it("reports null for the worker when none is running", () => {
    vi.mocked(getWorkerStatus).mockReturnValue(idleWorker);
    expect(sampleMemory().worker).toBeNull();
  });
});

describe("startMemoryMonitor", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(serviceLog).mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("logs a baseline immediately, then one line per interval, and stops on dispose", () => {
    const sample = vi.fn(() => formatMemorySample(mu(), null));
    const stop = startMemoryMonitor({ intervalMs: 1000, sample });

    expect(serviceLog).toHaveBeenCalledTimes(1);
    expect(serviceLog).toHaveBeenLastCalledWith(
      expect.objectContaining({ level: "info", subsystem: "memory", msg: "memory sample", rssMb: 1500 })
    );

    vi.advanceTimersByTime(2500);
    expect(serviceLog).toHaveBeenCalledTimes(3);

    stop();
    vi.advanceTimersByTime(5000);
    expect(serviceLog).toHaveBeenCalledTimes(3);
  });

  it("escalates the line to warn once rss crosses the ceiling", () => {
    let rss = 1000;
    const sample = vi.fn(() => formatMemorySample(mu({ rss: rss * MB }), null));
    const stop = startMemoryMonitor({ intervalMs: 1000, warnRssMb: 4096, sample });
    expect(vi.mocked(serviceLog).mock.calls.at(-1)?.[0].level).toBe("info");

    rss = 9000;
    vi.advanceTimersByTime(1000);
    expect(vi.mocked(serviceLog).mock.calls.at(-1)?.[0]).toMatchObject({ level: "warn", rssMb: 9000 });
    stop();
  });

  it("survives a sampler that throws", () => {
    const sample = vi.fn(() => {
      throw new Error("boom");
    });
    const stop = startMemoryMonitor({ intervalMs: 1000, sample });
    expect(() => vi.advanceTimersByTime(3000)).not.toThrow();
    expect(serviceLog).not.toHaveBeenCalled();
    stop();
  });

  it("defaults to an hourly cadence", () => {
    expect(MEMORY_LOG_INTERVAL_MS).toBe(60 * 60 * 1000);
  });
});
