import { describe, it, expect } from "vitest";
import { describeSourceCoverage } from "@/lib/telemetry/provenanceCoverage";

describe("describeSourceCoverage", () => {
  it("says nothing when there is nothing to divide", () => {
    // An empty window is not "fully covered" — there was nothing to cover, and
    // a 100% badge over no data is a claim the window cannot support.
    expect(describeSourceCoverage({ total: 0, callsInWindow: 0 })).toBeNull();
    expect(describeSourceCoverage({ total: 0, callsInWindow: 0, sourceCoverage: undefined })).toBeNull();
  });

  it("reports full coverage without a warning", () => {
    const r = describeSourceCoverage({ total: 5849, callsInWindow: 5849, sourceCoverage: 1 })!;
    expect(r.partial).toBe(false);
    expect(r.pctLabel).toBe("100");
  });

  // The measured shape of the reference index: `tool_source` starts 2026-07-19
  // while events go back to 2023-11-14, so wide windows are partial.
  it("flags the partial windows the reference index actually produces", () => {
    const d30 = describeSourceCoverage({ total: 20392, callsInWindow: 27866, sourceCoverage: 20392 / 27866 })!;
    expect(d30.partial).toBe(true);
    expect(d30.pctLabel).toBe("73");

    const all = describeSourceCoverage({ total: 20392, callsInWindow: 35423, sourceCoverage: 20392 / 35423 })!;
    expect(all.partial).toBe(true);
    expect(all.pctLabel).toBe("57");
  });

  // The self-contradiction this helper exists to prevent: rounding 99.6% up
  // renders "(100% of this window)" immediately after saying the split does
  // not describe the whole window. Truncation keeps the two consistent.
  it("never prints 100 while calling the window partial", () => {
    const r = describeSourceCoverage({ total: 996, callsInWindow: 1000, sourceCoverage: 0.996 })!;
    expect(r.partial).toBe(true);
    expect(r.pctLabel).toBe("99");
    expect(r.pctLabel).not.toBe("100");
  });

  it("shows a real but tiny slice as <1 rather than 0", () => {
    // "0% of this window" next to a non-zero event count reads as a bug.
    const r = describeSourceCoverage({ total: 3, callsInWindow: 10_000, sourceCoverage: 3 / 10_000 })!;
    expect(r.partial).toBe(true);
    expect(r.pctLabel).toBe("<1");
  });

  // Guards the denominator assumption rather than the arithmetic: `tool_source`
  // is only counted against `tool_decision`. If Claude Code starts emitting it
  // on another event type, coverage exceeds 1 — and "nothing missing" is a
  // better reading than a percentage above 100.
  it("does not report above 100 when the denominator is too narrow", () => {
    const r = describeSourceCoverage({ total: 120, callsInWindow: 100, sourceCoverage: 1.2 })!;
    expect(r.partial).toBe(false);
    expect(r.pctLabel).toBe("100");
  });
});
