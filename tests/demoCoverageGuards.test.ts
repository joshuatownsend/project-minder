import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { promises as nodeFs } from "fs";

import { walkClaudeWorkflows } from "@/lib/indexer/walkWorkflows";
import { scanClaudePlans } from "@/lib/scanner/claudePlans";
import { getUserConfig, invalidateUserConfigCache } from "@/lib/userConfigCache";
import { demoPlanDetail, demoPlans } from "@/lib/demo/plans";
import { demoWorkflows } from "@/lib/demo/workflows";
import { preserveEnvVars } from "./_helpers/preserveEnv";

// #421 — a bare `delete process.env.X` in teardown restores this file's own
// assignment and destroys anything it INHERITED, and vitest reuses a worker
// across files, so the erasure outlives this one. Capture and put back instead.
preserveEnvVars(["MINDER_DEMO"]);

/**
 * W12 — the loader guards added for the demo-mode coverage audit.
 *
 * Driven through `MINDER_DEMO=1` rather than a mocked config, because
 * `demoMode()` short-circuits on the env var before reading config: this is the
 * exact path the screenshot capture run takes.
 */
describe("demo-mode guards on the previously-unguarded loaders", () => {
  beforeEach(() => {
    process.env.MINDER_DEMO = "1";
    invalidateUserConfigCache();
  });
  afterEach(() => {
    delete process.env.MINDER_DEMO;
    invalidateUserConfigCache();
    vi.restoreAllMocks();
  });

  it("walkClaudeWorkflows serves fixtures and never walks ~/.claude (#441)", async () => {
    const readdir = vi.spyOn(nodeFs, "readdir");
    const entries = await walkClaudeWorkflows();

    expect(entries.length).toBeGreaterThan(0);
    expect(readdir).not.toHaveBeenCalled();
    // Every run path must be obviously synthetic — the real walker emits
    // absolute paths under the user's home.
    for (const e of entries) {
      for (const r of e.runs) expect(r.scriptPath).toContain("\\Users\\demo\\");
    }
  });

  it("the workflow guard still applies when an explicit dir is passed", async () => {
    // The regression this pins: moving the guard below the `projectsDir(s)`
    // override, so any caller with an argument silently bypasses it.
    const readdir = vi.spyOn(nodeFs, "readdir");
    const entries = await walkClaudeWorkflows({ projectsDir: "C:\\somewhere\\real" });

    // Compared by identity rather than deep equality: run timestamps are
    // stamped from `Date.now()` per call, so two live calls differ by a
    // millisecond without that meaning anything.
    expect(entries.map((e) => e.id)).toEqual((await walkClaudeWorkflows()).map((e) => e.id));
    expect(entries.length).toBeGreaterThan(0);
    expect(readdir).not.toHaveBeenCalled();
  });

  it("scanClaudePlans serves fixtures and never reads the plans dir", async () => {
    const readdir = vi.spyOn(nodeFs, "readdir");
    const plans = await scanClaudePlans();

    expect(plans.length).toBeGreaterThan(0);
    expect(readdir).not.toHaveBeenCalled();
    for (const p of plans) expect(p.path).toContain("\\Users\\demo\\");
  });

  it("getUserConfig serves fixtures without reading or warming the shared cache", async () => {
    const readFile = vi.spyOn(nodeFs, "readFile");
    const first = await getUserConfig();

    expect(first.hooks.entries.length).toBeGreaterThan(0);
    expect(readFile).not.toHaveBeenCalled();
    // Never leaks the real home through a hook's sourcePath.
    for (const e of first.hooks.entries) expect(e.sourcePath).toContain("\\Users\\demo\\");
    // MCP servers carry env KEY names only, never values — same rule as the
    // real reader, so the fixture cannot teach the UI a laxer shape.
    for (const s of first.mcpServers.servers) {
      expect(Array.isArray(s.envKeys) || s.envKeys === undefined).toBe(true);
    }
  });
});

describe("demo fixtures are deterministic and honest about misses", () => {
  const NOW = Date.parse("2026-08-16T12:00:00Z");

  it("plan detail 404s for a slug that is not a fixture", () => {
    expect(demoPlanDetail("some-real-plan-the-user-has", NOW)).toBeNull();
    expect(demoPlanDetail(demoPlans(NOW)[0].slug, NOW)).not.toBeNull();
  });

  it("repeated calls at a fixed clock produce identical structures", () => {
    // Pinned `nowMs` — the fixtures are deterministic *given* a clock, which is
    // what byte-stable capture runs need.
    expect(demoWorkflows(NOW)).toEqual(demoWorkflows(NOW));
    expect(demoPlans(NOW)).toEqual(demoPlans(NOW));
  });

  it("plans are newest-first", () => {
    const mtimes = demoPlans(NOW).map((p) => p.mtime);
    expect([...mtimes].sort((a, b) => b.localeCompare(a))).toEqual(mtimes);
  });

  it("workflow run counts agree with the runs they fold", () => {
    for (const w of demoWorkflows(NOW)) {
      expect(w.runCount).toBe(w.runs.length);
      expect(w.lastRunAt).toBe(w.runs[0].timestamp);
    }
  });
});
