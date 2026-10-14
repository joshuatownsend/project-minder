import { describe, it, expect, vi } from "vitest";

// serviceLog inside the ingest worker forwards each entry to the host instead of writing the
// file. The host logs it whenever its main thread is next free, so the entry has to carry the
// moment it was written: at boot that relay ran seconds late.

const { postMessage } = vi.hoisted(() => ({ postMessage: vi.fn() }));
vi.mock("node:worker_threads", () => ({ isMainThread: false, parentPort: { postMessage } }));

import { serviceLog } from "@/lib/serviceLog";

describe("serviceLog in the ingest worker", () => {
  it("forwards the entry stamped with the time it was written", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const before = Date.now();
    serviceLog({ subsystem: "ingest-watcher", msg: "watcher armed" });
    expect(postMessage).toHaveBeenCalledTimes(1);
    const { type, entry } = postMessage.mock.calls[0][0];
    expect(type).toBe("service-log");
    expect(entry).toMatchObject({ subsystem: "ingest-watcher", msg: "watcher armed", level: "info" });
    const ts = Date.parse(entry.ts);
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(Date.now());
  });
});
