import { describe, it, expect } from "vitest";
import {
  assessDelegation,
  delegationBadgeLabel,
  DELEGATION_CAPS,
  APPROACHING_RATIO,
} from "@/lib/usage/delegationLimits";

describe("C2 — delegation caps", () => {
  it("stays quiet for ordinary sessions", () => {
    const a = assessDelegation({ spawns: 3, webSearches: 1 });
    expect(a.worst).toBe("ok");
    // No badge: a marker on every session that used a few subagents is noise,
    // and noise is how a real one gets missed.
    expect(delegationBadgeLabel(a)).toBeUndefined();
  });

  it("flags a session approaching a cap before it lands", () => {
    const a = assessDelegation({ spawns: Math.ceil(DELEGATION_CAPS.spawns * APPROACHING_RATIO) });
    expect(a.worst).toBe("approaching");
    expect(delegationBadgeLabel(a)).toContain("nearing subagents cap");
  });

  it("reports a cap as reached, never as blocked", () => {
    const a = assessDelegation({ spawns: DELEGATION_CAPS.spawns });
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
    });
    expect(a.worst).toBe("reached");
    expect(delegationBadgeLabel(a)).toContain("subagents");
  });

  it("treats a count above the cap as reached rather than overflowing", () => {
    const a = assessDelegation({ spawns: DELEGATION_CAPS.spawns * 3 });
    expect(a.worst).toBe("reached");
  });

  it("reports concurrency and depth as unmeasured, not as zero", () => {
    const a = assessDelegation({ spawns: 5 });
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
    const a = assessDelegation({ webSearches: DELEGATION_CAPS.webSearches });
    expect(delegationBadgeLabel(a)).toContain("web searches cap reached");
  });

  it("says it has no data when nothing was measured", () => {
    const a = assessDelegation({});
    expect(a.hasData).toBe(false);
    expect(delegationBadgeLabel(a)).toBeUndefined();
  });

  it("still reports data when only one signal is present", () => {
    expect(assessDelegation({ webSearches: 0 }).hasData).toBe(true);
  });
});
