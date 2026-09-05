/**
 * Process memory telemetry (#561).
 *
 * On 2026-09-05 the tray-supervised server reached 56 GB of commit charge
 * after five days and exhausted the machine. Nothing had recorded a growth
 * curve: `/api/health` carried no memory figures and `minder.log` held only
 * boot and shutdown lines, so the post-mortem had one data point (the size at
 * death) and could not reproduce the growth. This module is the instrument
 * that was missing:
 *
 *   - {@link sampleMemory} — the snapshot `/api/health` embeds on every poll
 *     (the tray reads `rssMb` for its restart-above-threshold guard).
 *   - {@link startMemoryMonitor} — an hourly `memory` line in the service log,
 *     escalating to `warn` past a soft ceiling, so the next occurrence leaves
 *     a curve to read rather than a corpse to measure.
 *
 * Everything is keyed on **rss**, not heap. The exhausted process had a V8
 * heap capped at ~4 GB per isolate and single-digit-MB externals; the other
 * ~50 GB lived in native allocations V8 does not account for. A heap-based
 * threshold would never have fired.
 *
 * The ingest worker is its own isolate and cannot be sampled from here; it
 * self-reports every minute (`workers/ingestWorker.mjs`, a `memory` message)
 * and the host keeps the last sample, which {@link sampleMemory} folds in.
 */

import { serviceLog } from "@/lib/serviceLog";
import { getWorkerStatus } from "@/lib/db/workerHost";
import type { HealthMemory } from "@/lib/types/init";

/** One line per hour is enough to draw a five-day curve without spamming the ring. */
export const MEMORY_LOG_INTERVAL_MS = 60 * 60 * 1000;
/**
 * Soft ceiling for the hourly line's level. Well above the ~1.5 GB an idle
 * server sits at with the usage file cache warm, well below any point where the
 * machine is in trouble — a `warn` here is "look at this", not "act now".
 */
export const MEMORY_WARN_RSS_MB = 4096;

const MB = 1024 * 1024;
export const toMb = (bytes: number): number => Math.round(bytes / MB);

/** Pure: the shape the health route embeds and the log line carries. */
export function formatMemorySample(
  mu: NodeJS.MemoryUsage,
  worker: HealthMemory["worker"]
): HealthMemory {
  return {
    rssMb: toMb(mu.rss),
    heapTotalMb: toMb(mu.heapTotal),
    heapUsedMb: toMb(mu.heapUsed),
    externalMb: toMb(mu.external),
    arrayBuffersMb: toMb(mu.arrayBuffers),
    worker,
  };
}

/** Pure: the hourly line escalates to `warn` at or above the ceiling. */
export function memoryLogLevel(rssMb: number, warnRssMb: number = MEMORY_WARN_RSS_MB): "info" | "warn" {
  return warnRssMb > 0 && rssMb >= warnRssMb ? "warn" : "info";
}

/** Live snapshot: main-thread `process.memoryUsage()` plus the worker's last self-report. */
export function sampleMemory(): HealthMemory {
  return formatMemorySample(process.memoryUsage(), getWorkerStatus().memory);
}

export interface MemoryMonitorOptions {
  intervalMs?: number;
  warnRssMb?: number;
  /** Injected for tests; production samples the live process. */
  sample?: () => HealthMemory;
}

/**
 * Start the hourly memory line. Logs one sample immediately (so a short-lived
 * process still leaves a baseline), then one per interval. The timer is
 * `unref`'d — it never keeps the process alive — and the returned function
 * stops it (registered as the `memory` lifecycle disposer by the bootstrap).
 * Never throws: a sampler that could take down the process it watches would
 * be worse than none.
 */
export function startMemoryMonitor(options: MemoryMonitorOptions = {}): () => void {
  const intervalMs = options.intervalMs ?? MEMORY_LOG_INTERVAL_MS;
  const warnRssMb = options.warnRssMb ?? MEMORY_WARN_RSS_MB;
  const sample = options.sample ?? sampleMemory;

  const tick = (): void => {
    try {
      const m = sample();
      serviceLog({
        level: memoryLogLevel(m.rssMb, warnRssMb),
        subsystem: "memory",
        msg: "memory sample",
        uptimeSec: Math.round(process.uptime()),
        ...m,
      });
    } catch {
      /* telemetry is best-effort */
    }
  };

  tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
