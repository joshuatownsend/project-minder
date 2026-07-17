import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  onShutdown,
  shutdown,
  registeredDisposerCount,
  isShuttingDown,
  _resetLifecycleForTesting,
} from "@/lib/lifecycle";

let logSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  _resetLifecycleForTesting();
  // Silence the serviceLog console tee that lifecycle emits.
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  logSpy.mockRestore();
  warnSpy.mockRestore();
});

describe("onShutdown registration", () => {
  it("is idempotent by name — re-registering replaces without duplicating", async () => {
    const first = vi.fn();
    const second = vi.fn();
    onShutdown("dup", first);
    onShutdown("dup", second);
    expect(registeredDisposerCount()).toBe(1);
    await shutdown("test");
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
  });

  it("preserves LIFO position when a name is re-registered", async () => {
    const order: string[] = [];
    onShutdown("a", () => void order.push("a"));
    onShutdown("b", () => void order.push("b"));
    // Re-register "a" — it must keep its original (first) slot, so it still
    // disposes LAST under LIFO.
    onShutdown("a", () => void order.push("a2"));
    await shutdown("test");
    expect(order).toEqual(["b", "a2"]);
  });
});

describe("shutdown ordering + isolation", () => {
  it("runs disposers in LIFO (reverse registration) order", async () => {
    const order: string[] = [];
    onShutdown("first", () => void order.push("first"));
    onShutdown("second", () => void order.push("second"));
    onShutdown("third", () => void order.push("third"));

    await shutdown("signal");

    expect(order).toEqual(["third", "second", "first"]);
  });

  it("isolates a failing disposer — the others still run", async () => {
    const before = vi.fn(); // registered last → runs first
    const boom = vi.fn(() => {
      throw new Error("disposer exploded");
    });
    const after = vi.fn(); // registered first → runs last

    onShutdown("after", after);
    onShutdown("boom", boom);
    onShutdown("before", before);

    await expect(shutdown("signal")).resolves.toBeUndefined();

    expect(before).toHaveBeenCalledTimes(1);
    expect(boom).toHaveBeenCalledTimes(1);
    expect(after).toHaveBeenCalledTimes(1);
  });

  it("awaits async disposers", async () => {
    const events: string[] = [];
    onShutdown("async", async () => {
      await new Promise((r) => setTimeout(r, 5));
      events.push("done");
    });
    await shutdown("signal");
    expect(events).toEqual(["done"]);
  });
});

describe("shutdown timeout + budget", () => {
  it("times out a hung disposer and skips the remaining budget-exhausted ones", async () => {
    const late = vi.fn(); // registered first → disposed LAST
    // A disposer that never resolves — must not hang the whole shutdown.
    const hang = vi.fn(() => new Promise<void>(() => {}));

    onShutdown("late", late);
    onShutdown("hang", hang); // disposed FIRST, consumes the whole budget

    const start = Date.now();
    await shutdown("signal", { timeoutMs: 60 });
    const elapsed = Date.now() - start;

    expect(hang).toHaveBeenCalledTimes(1);
    // Budget spent on the hung disposer → the earlier-registered one is skipped.
    expect(late).not.toHaveBeenCalled();
    // Bounded by the overall deadline, not left to hang forever.
    expect(elapsed).toBeGreaterThanOrEqual(50);
    expect(elapsed).toBeLessThan(1000);
  });

  it("still runs fast disposers registered after a (later-disposed) slow one", async () => {
    const fast = vi.fn(); // registered last → disposed first, quick
    const slow = vi.fn(() => new Promise<void>(() => {})); // disposed last, hangs

    onShutdown("slow", slow);
    onShutdown("fast", fast);

    await shutdown("signal", { timeoutMs: 60 });

    expect(fast).toHaveBeenCalledTimes(1);
    expect(slow).toHaveBeenCalledTimes(1);
  });
});

describe("shutdown idempotency", () => {
  it("runs disposers only once across repeated shutdown() calls", async () => {
    const d = vi.fn();
    onShutdown("once", d);

    await shutdown("first");
    await shutdown("second");

    expect(d).toHaveBeenCalledTimes(1);
    expect(isShuttingDown()).toBe(true);
  });

  it("two concurrent shutdown() calls share one run — disposers fire once and both callers await completion", async () => {
    // Simulates a double SIGINT/SIGTERM: the second signal's shutdown() must
    // return the SAME in-flight promise so its handler can't process.exit()
    // before the first run's disposers finish.
    let disposed = false;
    const slow = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 30));
      disposed = true;
    });
    onShutdown("slow", slow);

    const first = shutdown("SIGINT");
    const second = shutdown("SIGTERM");

    // Both callers must observe the disposer as complete when they resolve —
    // the second must not resolve early.
    await Promise.all([
      first.then(() => expect(disposed).toBe(true)),
      second.then(() => expect(disposed).toBe(true)),
    ]);

    expect(slow).toHaveBeenCalledTimes(1);
  });
});
