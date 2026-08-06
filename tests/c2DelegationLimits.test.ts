import { describe, it, expect } from "vitest";
import {
  assessDelegation,
  delegationBadgeLabel,
  DELEGATION_CAPS,
  APPROACHING_RATIO,
  capApplies,
} from "@/lib/usage/delegationLimits";

// A Claude Code new enough that every cap below exists. The cases here test
// cap arithmetic; the version gate has its own cases at the bottom.
const CAP_ERA_VERSION = "2.1.222";

describe("C2 — delegation caps", () => {
  it("stays quiet for ordinary sessions", () => {
    const a = assessDelegation({ spawns: 3, webSearches: 1, cliVersion: CAP_ERA_VERSION });
    expect(a.worst).toBe("ok");
    // No badge: a marker on every session that used a few subagents is noise,
    // and noise is how a real one gets missed.
    expect(delegationBadgeLabel(a)).toBeUndefined();
  });

  it("flags a session approaching a cap before it lands", () => {
    const a = assessDelegation({
      spawns: Math.ceil(DELEGATION_CAPS.spawns * APPROACHING_RATIO),
      cliVersion: CAP_ERA_VERSION,
    });
    expect(a.worst).toBe("approaching");
    expect(delegationBadgeLabel(a)).toContain("nearing subagents cap");
  });

  it("reports a cap as reached, never as blocked", () => {
    const a = assessDelegation({ spawns: DELEGATION_CAPS.spawns, cliVersion: CAP_ERA_VERSION });
    expect(a.worst).toBe("reached");
    // Wording matters: the caps are configurable, so Minder can see the count
    // but not the ceiling actually in force on that machine.
    const label = delegationBadgeLabel(a)!;
    expect(label).toContain("cap reached");
    expect(label).not.toMatch(/blocked|truncated/i);
  });

  it("picks the worst limit when several are elevated", () => {
    const a = assessDelegation({
      spawns: DELEGATION_CAPS.spawns,
      webSearches: Math.ceil(DELEGATION_CAPS.webSearches * APPROACHING_RATIO),
      cliVersion: CAP_ERA_VERSION,
    });
    expect(a.worst).toBe("reached");
    expect(delegationBadgeLabel(a)).toContain("subagents");
  });

  it("treats a count above the cap as reached rather than overflowing", () => {
    const a = assessDelegation({ spawns: DELEGATION_CAPS.spawns * 3, cliVersion: CAP_ERA_VERSION });
    expect(a.worst).toBe("reached");
  });

  it("reports concurrency and depth as unmeasured, not as zero", () => {
    const a = assessDelegation({ spawns: 5, cliVersion: CAP_ERA_VERSION });
    const concurrent = a.limits.find((l) => l.key === "concurrent")!;
    const depth = a.limits.find((l) => l.key === "depth")!;
    // 0 would render a session nested five deep as comfortably inside a cap of
    // three. `parent_tool_use_id` is NULL on every row of the reference index,
    // so the tree the plan assumed was reconstructible is not.
    expect(concurrent.count).toBeUndefined();
    expect(depth.count).toBeUndefined();
    expect(concurrent.ratio).toBeUndefined();
  });

  it("keeps the web-search noun honest", () => {
    // Codex + Copilot review of #388: the label says "web searches" because the
    // documented cap counts searches. The caller passes only WebSearch — a
    // session with 160 WebFetch calls and no searches is nowhere near this cap.
    const a = assessDelegation({ webSearches: DELEGATION_CAPS.webSearches, cliVersion: CAP_ERA_VERSION });
    expect(delegationBadgeLabel(a)).toContain("web searches cap reached");
  });

  it("says it has no data when nothing was measured", () => {
    const a = assessDelegation({});
    expect(a.hasData).toBe(false);
    expect(delegationBadgeLabel(a)).toBeUndefined();
  });

  it("still reports data when only one signal is present", () => {
    expect(assessDelegation({ webSearches: 0, cliVersion: CAP_ERA_VERSION }).hasData).toBe(true);
  });
});

describe("C2 — caps only apply from the version that introduced them", () => {
  it("does not warn a session that predates the cap", () => {
    // 160 spawns on a 2026-era Claude Code was not near anything: the cap did
    // not exist. The badge does not merely mis-sort here — it says the session
    // may have been silently truncated, which is a claim about an event that
    // never happened (Codex review, #388).
    const a = assessDelegation({ spawns: DELEGATION_CAPS.spawns, cliVersion: "2.1.100" });
    expect(a.worst).toBe("ok");
    expect(delegationBadgeLabel(a)).toBeUndefined();
    expect(a.limits.find((l) => l.key === "spawns")!.count).toBeUndefined();
  });

  it("warns once the recorded version is new enough", () => {
    const a = assessDelegation({ spawns: DELEGATION_CAPS.spawns, cliVersion: "2.1.212" });
    expect(a.worst).toBe("reached");
  });

  it("gates each cap on its own version, not on one wave", () => {
    // Web searches arrived at 2.1.217, spawns at 2.1.212. Between the two, one
    // applies and the other does not.
    const a = assessDelegation({
      spawns: DELEGATION_CAPS.spawns,
      webSearches: DELEGATION_CAPS.webSearches,
      cliVersion: "2.1.213",
    });
    expect(a.limits.find((l) => l.key === "spawns")!.count).toBe(DELEGATION_CAPS.spawns);
    expect(a.limits.find((l) => l.key === "webSearches")!.count).toBeUndefined();
  });

  it("stays silent when the version was never recorded", () => {
    // Same rule the rest of the module runs on: unmeasured is not zero, and it
    // is not "assume the cap applied" either. Minder cannot tell, so it does
    // not assert — the cost is a missing badge, not a false one.
    const a = assessDelegation({ spawns: DELEGATION_CAPS.spawns });
    expect(a.hasData).toBe(false);
    expect(delegationBadgeLabel(a)).toBeUndefined();
  });

  it("compares versions numerically, not as strings", () => {
    // "2.1.9" < "2.1.212" numerically but sorts AFTER it as text.
    expect(capApplies("spawns", "2.1.9")).toBe(false);
    expect(capApplies("spawns", "2.2.0")).toBe(true);
    expect(capApplies("spawns", "3.0.0")).toBe(true);
  });
});
