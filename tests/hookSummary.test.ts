import { describe, it, expect } from "vitest";
import { summarizeSessionHooks } from "@/lib/sessions/hookSummary";
import type { SessionHookRun } from "@/lib/types/session";

const run = (command: string, durationMs?: number): SessionHookRun => ({ command, durationMs });

describe("summarizeSessionHooks", () => {
  it("returns an empty summary for no runs", () => {
    for (const input of [undefined, []]) {
      const s = summarizeSessionHooks(input);
      expect(s.groups).toEqual([]);
      expect(s.totalFires).toBe(0);
      expect(s.measuredFires).toBe(0);
      expect(s.totalMs).toBe(0);
    }
  });

  it("groups repeated runs of the same command", () => {
    const s = summarizeSessionHooks([run("a", 10), run("b", 5), run("a", 20)]);
    expect(s.groups).toHaveLength(2);
    const a = s.groups.find((g) => g.command === "a")!;
    expect(a.fires).toBe(2);
    expect(a.totalMs).toBe(30);
    expect(s.totalFires).toBe(3);
  });

  // The load-bearing one. An unmeasured run must count as a fire and be absent
  // from every statistic. Chosen so that the wrong behaviour — treating
  // `undefined` as 0 ms — produces a DIFFERENT p50, not merely a different
  // internal state: measured [100] has p50 100, while [0, 0, 100] has p50 0.
  it("counts an unmeasured run as a fire but excludes it from the statistics", () => {
    const s = summarizeSessionHooks([run("slow", 100), run("slow"), run("slow")]);
    const g = s.groups[0];

    expect(g.fires).toBe(3);
    expect(g.measuredFires).toBe(1);
    expect(g.p50Ms).toBe(100); // would be 0 if undefined were coerced to 0
    expect(g.totalMs).toBe(100); // would still be 100, but the p50 above discriminates
    expect(g.maxMs).toBe(100);
    expect(s.totalFires).toBe(3);
    expect(s.measuredFires).toBe(1);
  });

  it("omits the percentiles entirely when nothing was measured", () => {
    const s = summarizeSessionHooks([run("untimed"), run("untimed")]);
    const g = s.groups[0];

    expect(g.fires).toBe(2);
    expect(g.measuredFires).toBe(0);
    // Absent, not zero — a 0 here would sort this command as the session's
    // fastest hook when in truth nobody timed it.
    expect(g.p50Ms).toBeUndefined();
    expect(g.maxMs).toBeUndefined();
    expect(g.totalMs).toBe(0);
  });

  it("ranks by total measured time, not by fire count", () => {
    // `chatty` fires more often; `heavy` costs more. Total time must win, or
    // the panel answers a different question than the one it claims to.
    const s = summarizeSessionHooks([
      run("chatty", 1), run("chatty", 1), run("chatty", 1), run("chatty", 1),
      run("heavy", 500),
    ]);
    expect(s.groups.map((g) => g.command)).toEqual(["heavy", "chatty"]);
    expect(s.totalMs).toBe(504);
  });

  it("breaks a total-time tie by fire count", () => {
    // Both wholly unmeasured, so both total 0 — without the tiebreak this
    // would fall through to Map insertion order.
    const s = summarizeSessionHooks([run("once"), run("twice"), run("twice")]);
    expect(s.groups.map((g) => g.command)).toEqual(["twice", "once"]);
  });

  it("uses the same nearest-rank rule as the Stats card", () => {
    // otelQueries.percentile: value at 1-based rank ceil(p/100 * n).
    // n=4, p50 -> rank 2 -> the second smallest, 20 (not an interpolated 25).
    const s = summarizeSessionHooks([run("h", 10), run("h", 20), run("h", 30), run("h", 40)]);
    expect(s.groups[0].p50Ms).toBe(20);
    expect(s.groups[0].maxMs).toBe(40);
  });

  it("skips records carrying no command", () => {
    const s = summarizeSessionHooks([
      run("real", 5),
      { command: "", durationMs: 999 },
    ]);
    expect(s.groups).toHaveLength(1);
    expect(s.totalFires).toBe(1);
    // The nameless record's duration must not leak into the total either.
    expect(s.totalMs).toBe(5);
  });

  it("ignores a non-finite duration rather than propagating NaN", () => {
    const s = summarizeSessionHooks([run("h", Number.NaN), run("h", 50)]);
    const g = s.groups[0];
    expect(g.fires).toBe(2);
    expect(g.measuredFires).toBe(1);
    expect(g.totalMs).toBe(50);
    expect(Number.isNaN(g.totalMs)).toBe(false);
  });
});
