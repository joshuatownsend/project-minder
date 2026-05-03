import { describe, it, expect } from "vitest";
import { withFileLock } from "@/lib/atomicWrite";

// Reentrancy was added so the apply layer can wrap snapshot+apply in
// withFileLock(target, ...) while the inner apply primitive's own
// withFileLock(target, ...) still works (instead of deadlocking).
// These tests pin both the reentrant fast-path and the still-FIFO
// behavior between independent async chains.

describe("withFileLock reentrancy", () => {
  it("re-acquiring the same path inside a held lock runs inline (no deadlock)", async () => {
    const events: string[] = [];
    const result = await withFileLock("/tmp/reentrant-fixture-1", async () => {
      events.push("outer-start");
      const inner = await withFileLock("/tmp/reentrant-fixture-1", async () => {
        events.push("inner");
        return 42;
      });
      events.push("outer-end");
      return inner;
    });
    expect(result).toBe(42);
    expect(events).toEqual(["outer-start", "inner", "outer-end"]);
  });

  it("re-acquiring with a path that resolves to the same canonical path is reentrant", async () => {
    // The lock is keyed on path.resolve(filePath), so two different
    // input strings that resolve to the same canonical path must share
    // the lock (and the reentrant fast-path).
    let innerRan = false;
    await withFileLock("/tmp/canonical-fixture", async () => {
      await withFileLock("/tmp/./canonical-fixture", async () => {
        innerRan = true;
      });
    });
    expect(innerRan).toBe(true);
  });

  it("two independent chains on the same path still serialize", async () => {
    // Reentrancy must NOT break cross-chain mutex behavior. Without
    // serialization, the snapshot-under-lock fix is meaningless.
    const events: string[] = [];
    const a = withFileLock("/tmp/cross-chain-fixture", async () => {
      events.push("a-start");
      await new Promise((r) => setTimeout(r, 20));
      events.push("a-end");
    });
    const b = withFileLock("/tmp/cross-chain-fixture", async () => {
      events.push("b-start");
      await new Promise((r) => setTimeout(r, 5));
      events.push("b-end");
    });
    await Promise.all([a, b]);
    // a must fully complete before b starts (FIFO order).
    expect(events).toEqual(["a-start", "a-end", "b-start", "b-end"]);
  });

  it("locks on different paths do not block each other", async () => {
    const events: string[] = [];
    const a = withFileLock("/tmp/distinct-a", async () => {
      events.push("a-start");
      await new Promise((r) => setTimeout(r, 20));
      events.push("a-end");
    });
    const b = withFileLock("/tmp/distinct-b", async () => {
      events.push("b-start");
      await new Promise((r) => setTimeout(r, 5));
      events.push("b-end");
    });
    await Promise.all([a, b]);
    // b finishes before a even though it started later — they're on
    // different paths and run concurrently.
    expect(events.indexOf("b-end")).toBeLessThan(events.indexOf("a-end"));
  });

  it("re-entrant inner block sees the outer's writes (no rebuild of mutex)", async () => {
    // If reentrancy were implemented by treating the inner call as a
    // separate acquisition queued behind the outer (current behavior
    // before the fix), this would deadlock — outer waits for fn, inner
    // is part of fn but waits for the lock held by outer.
    let observedInOuter = false;
    let observedInInner = false;
    await withFileLock("/tmp/observed-fixture", async () => {
      observedInOuter = true;
      await withFileLock("/tmp/observed-fixture", async () => {
        observedInInner = observedInOuter;
      });
    });
    expect(observedInInner).toBe(true);
  });
});
