import { describe, it, expect, afterEach } from "vitest";

// Pins the `afterEach` ordering that `tests/_helpers/isolatedState.ts` and its
// callers depend on (raised on PR #419).
//
// Four files — agentCost, preparedCache, subagentMetrics, dbIngestWatcher —
// call `installIsolatedState()` at module scope and then register an
// `afterEach` of their own that closes a SQLite handle or stops a chokidar
// watcher. The helper's teardown drops the globalThis slot and removes the
// temp directory. Those must happen in that order: cleanup first, removal
// second. On Windows an open `.db` blocks the directory removal outright, and
// a watcher whose global has already been cleared cannot be stopped at all —
// `stopIngestWatcher()` finds no state, returns, and leaves a live watcher on
// a directory that is about to disappear.
//
// `sequence.hooks: "stack"` gives exactly that: `afterEach` hooks run in
// reverse registration order, each awaited before the next. It is vitest's
// default AND now set explicitly in vitest.config.ts — this test is what makes
// the pair meaningful, since a config edit or an upstream default change would
// otherwise break four files silently and in a way that looks like flakiness.

const order: string[] = [];

// Registered FIRST — stands in for the helper's teardown, so it must run LAST.
afterEach(async () => {
  order.push("helper-start");
  await new Promise((resolve) => setTimeout(resolve, 20));
  order.push("helper-end");
});

// Registered SECOND — stands in for a caller's own cleanup, so it must run
// FIRST, and must finish before the helper's begins.
afterEach(async () => {
  order.push("caller-start");
  await new Promise((resolve) => setTimeout(resolve, 5));
  order.push("caller-end");
});

describe("afterEach ordering", () => {
  it("primes the hooks", () => {
    expect(order).toEqual([]);
  });

  it("runs teardown in reverse registration order, serialized", () => {
    // Written as one exact sequence rather than a pair of ordering assertions,
    // because the three ways this can be wrong are distinguishable and the
    // failure output should say which one happened:
    //   stack (correct) → caller-start, caller-end, helper-start, helper-end
    //   list            → helper-start, helper-end, caller-start, caller-end
    //   parallel        → interleaved, starting helper-start, caller-start
    expect(order).toEqual(["caller-start", "caller-end", "helper-start", "helper-end"]);
  });
});
