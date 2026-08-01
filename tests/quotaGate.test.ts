import { describe, it, expect } from "vitest";
import {
  evaluateQuotaGate,
  DEFAULT_THRESHOLD,
  DEFAULT_MAX_AGE_MS,
  MAX_HOLD_MS,
} from "@/lib/tasks/quotaGate";
import type { QuotaData, QuotaResult, QuotaWindow } from "@/lib/quota";

const NOW = Date.parse("2026-08-01T12:00:00.000Z");
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

function win(over: Partial<QuotaWindow> = {}): QuotaWindow {
  return {
    utilization: 0.2,
    status: "allowed",
    reset: Math.floor((NOW + 3_600_000) / 1000),
    resetAt: iso(3_600_000),
    ...over,
  };
}

function quota(over: Partial<QuotaData> = {}): QuotaResult {
  return {
    configured: true,
    subscriptionType: "max",
    rateLimitTier: "default",
    overallStatus: "allowed",
    representativeClaim: "5h",
    fallbackPercentage: 20,
    windows: { "5h": win(), "7d": win(), overage: win() },
    cachedAt: iso(-60_000),
    ...over,
  };
}

// ─── Fail-open cases ─────────────────────────────────────────────────────────

describe("the gate fails open", () => {
  // A gate that holds on bad data silently stops all background work. That is
  // strictly worse than letting one task fail: the failed task is visible in
  // the queue, the stall is not.

  it("does not hold when disabled", () => {
    const exhausted = quota({ windows: { "5h": win({ status: "throttled" }), "7d": win(), overage: win() } });
    expect(evaluateQuotaGate(exhausted, { enabled: false }, NOW).hold).toBe(false);
  });

  it("does not hold with no reading at all", () => {
    expect(evaluateQuotaGate(null, {}, NOW)).toMatchObject({ hold: false });
  });

  it("does not hold when quota is unconfigured", () => {
    const result = evaluateQuotaGate({ configured: false, reason: "no credentials" }, {}, NOW);
    expect(result.hold).toBe(false);
    expect(result.reason).toContain("not configured");
  });

  it("does not hold on a stale reading", () => {
    // loadQuota() falls back to the on-disk cache when its probe fails, so a
    // QuotaData can be arbitrarily old. An hour-old "throttled" would
    // otherwise hold the queue against a window that already reset.
    const stale = quota({
      cachedAt: iso(-(DEFAULT_MAX_AGE_MS + 60_000)),
      windows: { "5h": win({ status: "throttled" }), "7d": win(), overage: win() },
    });
    const result = evaluateQuotaGate(stale, {}, NOW);
    expect(result.hold).toBe(false);
    expect(result.reason).toContain("stale");
  });

  it("does not hold on a future-dated reading", () => {
    const skewed = quota({
      cachedAt: iso(60_000),
      windows: { "5h": win({ status: "throttled" }), "7d": win(), overage: win() },
    });
    const result = evaluateQuotaGate(skewed, {}, NOW);
    expect(result.hold).toBe(false);
    expect(result.reason).toContain("future-dated");
  });

  it("does not hold when cachedAt is unparseable", () => {
    expect(evaluateQuotaGate(quota({ cachedAt: "not-a-date" }), {}, NOW).hold).toBe(false);
  });

  it("does not hold when an exhausted window carries no reset time", () => {
    // Nothing to wait for. Holding indefinitely is the one outcome worse than
    // a failed task.
    const noReset = quota({
      windows: { "5h": win({ status: "throttled", resetAt: "" }), "7d": win(), overage: win() },
    });
    const result = evaluateQuotaGate(noReset, {}, NOW);
    expect(result.hold).toBe(false);
    expect(result.reason).toContain("no reset time");
  });

  it("does not hold when the reset time has already passed", () => {
    const past = quota({
      windows: { "5h": win({ status: "throttled", resetAt: iso(-1_000) }), "7d": win(), overage: win() },
    });
    expect(evaluateQuotaGate(past, {}, NOW).hold).toBe(false);
  });

  it("does not hold on an implausibly distant reset", () => {
    const absurd = quota({
      windows: {
        "5h": win({ status: "throttled", resetAt: iso(MAX_HOLD_MS + 60_000) }),
        "7d": win(),
        overage: win(),
      },
    });
    const result = evaluateQuotaGate(absurd, {}, NOW);
    expect(result.hold).toBe(false);
    expect(result.reason).toContain("implausibly far out");
  });

  it("does not hold when every window is comfortably under the threshold", () => {
    const result = evaluateQuotaGate(quota(), {}, NOW);
    expect(result.hold).toBe(false);
    expect(result.reason).toBe("quota available");
  });
});

// ─── Holding ─────────────────────────────────────────────────────────────────

describe("the gate holds", () => {
  it("holds when a window reports a non-allowed status", () => {
    const throttled = quota({
      windows: { "5h": win({ status: "throttled", resetAt: iso(900_000) }), "7d": win(), overage: win() },
    });
    const result = evaluateQuotaGate(throttled, {}, NOW);
    expect(result.hold).toBe(true);
    expect(result.until).toBe(iso(900_000));
    expect(result.windows).toEqual(["5h"]);
  });

  it("holds at the utilization threshold before the status flips", () => {
    // A long task started at 99% hits the wall mid-run and dies with its work
    // unsaved; the cost of holding is a delay bounded by resetAt.
    const nearlyFull = quota({
      windows: { "5h": win({ utilization: DEFAULT_THRESHOLD }), "7d": win(), overage: win() },
    });
    expect(evaluateQuotaGate(nearlyFull, {}, NOW).hold).toBe(true);

    const justUnder = quota({
      windows: { "5h": win({ utilization: DEFAULT_THRESHOLD - 0.01 }), "7d": win(), overage: win() },
    });
    expect(evaluateQuotaGate(justUnder, {}, NOW).hold).toBe(false);
  });

  it("honours a caller-supplied threshold", () => {
    const half = quota({ windows: { "5h": win({ utilization: 0.5 }), "7d": win(), overage: win() } });
    expect(evaluateQuotaGate(half, { threshold: 0.4 }, NOW).hold).toBe(true);
    expect(evaluateQuotaGate(half, { threshold: 0.6 }, NOW).hold).toBe(false);
  });

  it("waits for the LATEST reset when several windows are exhausted", () => {
    // Releasing at the 5h reset while the 7d window is also exhausted would
    // send the queue straight back into the wall.
    const both = quota({
      windows: {
        "5h": win({ status: "throttled", resetAt: iso(600_000) }),
        "7d": win({ status: "throttled", resetAt: iso(86_400_000) }),
        overage: win(),
      },
    });
    const result = evaluateQuotaGate(both, {}, NOW);
    expect(result.hold).toBe(true);
    expect(result.until).toBe(iso(86_400_000));
    expect(result.windows).toEqual(["5h", "7d"]);
  });

  it("holds on the overage window too, not just the named two", () => {
    const overage = quota({
      windows: { "5h": win(), "7d": win(), overage: win({ status: "throttled", resetAt: iso(120_000) }) },
    });
    const result = evaluateQuotaGate(overage, {}, NOW);
    expect(result.hold).toBe(true);
    expect(result.windows).toEqual(["overage"]);
  });

  it("names the reset time in the reason, which is what the heartbeat shows", () => {
    const throttled = quota({
      windows: { "5h": win({ status: "throttled", resetAt: iso(900_000) }), "7d": win(), overage: win() },
    });
    const result = evaluateQuotaGate(throttled, {}, NOW);
    expect(result.reason).toContain("5h quota exhausted");
    expect(result.reason).toContain(iso(900_000));
  });
});

// ─── Shape ───────────────────────────────────────────────────────────────────

describe("decision shape", () => {
  it("always carries a reason, held or not", () => {
    const cases: (QuotaResult | null)[] = [
      null,
      { configured: false, reason: "x" },
      quota(),
      quota({ windows: { "5h": win({ status: "throttled" }), "7d": win(), overage: win() } }),
    ];
    for (const c of cases) {
      expect(evaluateQuotaGate(c, {}, NOW).reason.length).toBeGreaterThan(0);
    }
  });

  it("never sets `until` when it is not holding", () => {
    expect(evaluateQuotaGate(quota(), {}, NOW).until).toBeUndefined();
  });

  it("tolerates a reading with no windows object", () => {
    const bare = { ...(quota() as QuotaData) } as QuotaData;
    // @ts-expect-error — deliberately modelling a malformed cache entry.
    delete bare.windows;
    expect(evaluateQuotaGate(bare, {}, NOW).hold).toBe(false);
  });
});
