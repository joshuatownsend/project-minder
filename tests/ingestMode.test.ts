/**
 * #431 / PR #435 — the packaged worker default and the two opt-outs it must
 * not trample. Both interactions below were review findings, not hypotheticals:
 * the first shipped in the PR as written and would have re-enabled ingest for
 * an operator who had switched it off.
 */
import { describe, it, expect } from "vitest";
import { resolveIngestMode } from "@/lib/db/ingestMode";

describe("resolveIngestMode", () => {
  it("defaults a source checkout to the in-process watcher", () => {
    expect(resolveIngestMode({})).toBe("in-process");
  });

  it("defaults a packaged install to the worker", () => {
    // The whole point of #431: an in-process reconcile blocks every HTTP
    // request for as long as it runs.
    expect(resolveIngestMode({ MINDER_PACKAGED: "1" })).toBe("worker");
  });

  it("honours an explicit opt-in from a source checkout", () => {
    expect(resolveIngestMode({ MINDER_INDEXER_WORKER: "1" })).toBe("worker");
  });

  it("honours MINDER_INDEXER_WORKER=0 against the packaged default", () => {
    // Codex P2: deciding this in the server.js wrapper ran BEFORE Next loaded
    // .env files, and Next never overwrites an existing process.env value — so
    // a .env.local opt-out was masked by the default it meant to disable.
    expect(resolveIngestMode({ MINDER_PACKAGED: "1", MINDER_INDEXER_WORKER: "0" })).toBe(
      "in-process"
    );
  });

  it("lets MINDER_INDEXER=0 beat the packaged worker default", () => {
    // Codex P1. The worker starts its watcher with `bypassEnvFlag: true`
    // (workers/ingestWorker.mjs), which skips the MINDER_INDEXER === "0" guard
    // in ingestWatcher.ts — so without this precedence the packaged default
    // silently re-enabled ingest that an operator had disabled.
    expect(resolveIngestMode({ MINDER_PACKAGED: "1", MINDER_INDEXER: "0" })).toBe("off");
  });

  it("lets MINDER_INDEXER=0 beat even an explicit worker opt-in", () => {
    // "No automatic index updates" is the stronger statement of intent; the
    // bypass inside the worker makes deferring to it the only safe reading.
    expect(resolveIngestMode({ MINDER_INDEXER: "0", MINDER_INDEXER_WORKER: "1" })).toBe("off");
  });

  it("treats MINDER_INDEXER=0 as off in a source checkout too", () => {
    expect(resolveIngestMode({ MINDER_INDEXER: "0" })).toBe("off");
  });

  it("ignores values other than an exact \"0\" / \"1\"", () => {
    // Guards the `!== "0"` and `=== "1"` comparisons against being loosened to
    // truthiness later: "false" and "no" are not opt-outs, and only "1" opts in.
    expect(resolveIngestMode({ MINDER_PACKAGED: "1", MINDER_INDEXER_WORKER: "false" })).toBe(
      "worker"
    );
    expect(resolveIngestMode({ MINDER_INDEXER_WORKER: "yes" })).toBe("in-process");
    expect(resolveIngestMode({ MINDER_INDEXER: "false", MINDER_PACKAGED: "1" })).toBe("worker");
  });
});
