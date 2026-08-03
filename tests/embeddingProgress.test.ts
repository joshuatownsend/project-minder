import { describe, it, expect } from "vitest";
import {
  MS_PER_CHUNK,
  coveragePercent,
  formatCount,
  formatEta,
  formatPercent,
  observedMsPerChunk,
  runtimeState,
  shouldContinue,
  type BackfillPass,
} from "@/lib/embeddings/progress";

function pass(over: Partial<BackfillPass> = {}): BackfillPass {
  return { embedded: 2000, remaining: 10_000, total: 100_000, durationMs: 30_000, ...over };
}

describe("shouldContinue", () => {
  it("continues while a pass makes forward progress", () => {
    expect(shouldContinue(pass(), null)).toBe(true);
    expect(shouldContinue(pass({ remaining: 8000 }), 10_000)).toBe(true);
  });

  it("stops when the corpus is fully embedded", () => {
    expect(shouldContinue(pass({ remaining: 0 }), 2000)).toBe(false);
  });

  // Each of these arrives on a 200 or is the tail of an early return; looping
  // on any of them is an unbounded POST storm against the local server.
  it.each(["nothing-to-do", "error", "no-model", "no-chunk-corpus"])(
    "stops on stoppedBecause=%s even with work remaining",
    (code) => {
      expect(shouldContinue(pass({ stoppedBecause: code }), null)).toBe(false);
    }
  );

  it("stops when a pass embedded nothing", () => {
    // No stop code and no progress: the loop would spin at full speed.
    expect(shouldContinue(pass({ embedded: 0 }), null)).toBe(false);
  });

  it("stops when `remaining` failed to decrease", () => {
    // Termination rests on strict monotonic progress, not an iteration cap, so
    // a server reporting embedded>0 while remaining stands still must halt.
    expect(shouldContinue(pass({ remaining: 10_000 }), 10_000)).toBe(false);
    expect(shouldContinue(pass({ remaining: 11_000 }), 10_000)).toBe(false);
  });

  it("terminates: repeated application always reaches a stop", () => {
    let remaining = 20_000;
    let previous: number | null = null;
    let iterations = 0;
    while (shouldContinue(pass({ remaining }), previous)) {
      previous = remaining;
      remaining -= 2000;
      if (++iterations > 100) break;
    }
    expect(iterations).toBeLessThan(100);
    expect(remaining).toBe(0);
  });
});

describe("shouldContinue after a verify pass", () => {
  // A verify pass at full coverage sweeps stale vectors first, so it can find
  // real work where `remaining` had said there was none. Both shapes must be
  // handled: nothing stale (stop cleanly) and stale found (embed and stop).
  it("stops cleanly when a verify pass finds nothing stale", () => {
    expect(
      shouldContinue({ embedded: 0, remaining: 0, total: 100_000, stoppedBecause: "nothing-to-do" }, null)
    ).toBe(false);
  });

  it("stops once a verify pass has re-embedded what the sweep freed", () => {
    expect(shouldContinue({ embedded: 12, remaining: 0, total: 100_000 }, null)).toBe(false);
  });
});

describe("observedMsPerChunk", () => {
  it("derives the rate from a pass", () => {
    expect(observedMsPerChunk(pass({ embedded: 1000, durationMs: 15_000 }))).toBe(15);
  });

  it("returns null rather than dividing by zero", () => {
    expect(observedMsPerChunk(pass({ embedded: 0 }))).toBeNull();
  });

  it("returns null when the pass reported no duration", () => {
    expect(observedMsPerChunk(pass({ durationMs: undefined }))).toBeNull();
    expect(observedMsPerChunk(pass({ durationMs: 0 }))).toBeNull();
  });
});

describe("coveragePercent", () => {
  it("computes a percentage", () => {
    expect(coveragePercent(50, 200)).toBe(25);
  });

  it("is 0 for an empty corpus rather than NaN", () => {
    expect(coveragePercent(0, 0)).toBe(0);
    expect(coveragePercent(5, 0)).toBe(0);
  });

  it("clamps out-of-range inputs", () => {
    expect(coveragePercent(-10, 100)).toBe(0);
    expect(coveragePercent(150, 100)).toBe(100);
  });
});

describe("formatPercent", () => {
  it("shows 100% only when the corpus is actually covered", () => {
    expect(formatPercent(100, 100)).toBe("100%");
  });

  // A bar reading "100%" with chunks outstanding is a small lie that costs
  // trust in every other number on the panel.
  it("never rounds up to 100% while chunks remain", () => {
    expect(formatPercent(99_999, 100_000)).toBe("99%");
    expect(formatPercent(99_500, 100_000)).toBe("99%");
  });

  it("rounds normally below the ceiling", () => {
    expect(formatPercent(0, 100)).toBe("0%");
    expect(formatPercent(504, 1000)).toBe("50%");
  });
});

describe("formatEta", () => {
  it("reports completion when nothing remains", () => {
    expect(formatEta(0)).toBe("complete");
    expect(formatEta(-5)).toBe("complete");
  });

  it("uses the reference rate by default", () => {
    // ~157k chunks at 15.3 ms is the measured ~40 minutes.
    expect(formatEta(157_000)).toBe("about 40 min");
  });

  it("switches to hours past 90 minutes", () => {
    expect(formatEta(600_000, 15)).toBe("about 2 h 30 min");
    // Exactly 2 h — the whole-hours branch drops the trailing "0 min".
    expect(formatEta(480_000, 15)).toBe("about 2 h");
    // 60 min is below the 90-minute threshold, so it stays in minutes.
    expect(formatEta(240_000, 15)).toBe("about 60 min");
  });

  it("collapses sub-minute estimates", () => {
    expect(formatEta(10, 15)).toBe("under a minute");
  });

  it("falls back to the reference rate on a nonsense observed rate", () => {
    expect(formatEta(157_000, 0)).toBe(formatEta(157_000, MS_PER_CHUNK));
    expect(formatEta(157_000, Number.NaN)).toBe(formatEta(157_000, MS_PER_CHUNK));
    expect(formatEta(157_000, -3)).toBe(formatEta(157_000, MS_PER_CHUNK));
  });
});

describe("runtimeState", () => {
  // The distinction the API's two fields make and a single boolean loses:
  // "nobody has loaded it yet" is the normal state after every restart.
  it("is not-loaded when unavailable with no failure reason", () => {
    expect(runtimeState(false, null)).toBe("not-loaded");
    expect(runtimeState(false, undefined)).toBe("not-loaded");
  });

  it("is ready when loaded", () => {
    expect(runtimeState(true, null)).toBe("ready");
  });

  it("is failed whenever a reason is present", () => {
    expect(runtimeState(false, "package not installed")).toBe("failed");
    expect(runtimeState(true, "package not installed")).toBe("failed");
  });
});

describe("formatCount", () => {
  it("groups thousands", () => {
    expect(formatCount(157_000)).toBe("157,000");
    expect(formatCount(0)).toBe("0");
  });

  it("floors and clamps", () => {
    expect(formatCount(1234.7)).toBe("1,234");
    expect(formatCount(-5)).toBe("0");
  });
});
