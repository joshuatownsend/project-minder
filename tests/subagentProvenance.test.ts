import { describe, it, expect } from "vitest";
import { describeSubagentProvenance } from "@/lib/sessions/subagentProvenance";

describe("describeSubagentProvenance", () => {
  it("says nothing for an inferred subagent", () => {
    // The common case. A badge on every row would be noise, and noise is how a
    // real signal gets missed.
    expect(describeSubagentProvenance({ metaSourced: false, metaTurnCount: 5 })).toBeNull();
    expect(describeSubagentProvenance({})).toBeNull();
  });

  // The finding from the #403 review. The SQLite backend — the default — cannot
  // index sidechain entries, so it supplies no `messageCount`. Comparing that
  // absence against Claude Code's count flagged every meta-sourced subagent as
  // an amber disagreement, presenting a documented backend limitation as a
  // data conflict.
  it("does not claim a disagreement when there is only one count", () => {
    const r = describeSubagentProvenance({ metaSourced: true, metaTurnCount: 14 })!;
    expect(r.disagrees).toBe(false);
    expect(r.label).toBe("14 turns recorded");
    // The count is still shown — on the default backend it is the only one that
    // exists, so suppressing it would lose real information.
    expect(r.explanation).toContain("14 turns");
    expect(r.explanation).toContain("no independent count");
  });

  it("claims a disagreement only when two real counts differ", () => {
    const r = describeSubagentProvenance({ metaSourced: true, metaTurnCount: 14, messageCount: 9 })!;
    expect(r.disagrees).toBe(true);
    expect(r.label).toBe("14 turns recorded · 9 counted");
    expect(r.explanation).toContain("14");
    expect(r.explanation).toContain("9");
  });

  it("treats a real zero count as a count, not as absence", () => {
    // The file backend can legitimately observe zero sidechain turns. That is a
    // measurement and must be comparable — the distinction the whole fix turns
    // on, and the one `?? 0` destroyed.
    const r = describeSubagentProvenance({ metaSourced: true, metaTurnCount: 14, messageCount: 0 })!;
    expect(r.disagrees).toBe(true);
    expect(r.label).toBe("14 turns recorded · 0 counted");
  });

  it("reports agreement plainly when the two counts match", () => {
    const r = describeSubagentProvenance({ metaSourced: true, metaTurnCount: 7, messageCount: 7 })!;
    expect(r.disagrees).toBe(false);
    expect(r.label).toBe("from Claude Code's record");
  });

  it("falls back to the provenance note when meta carries no turn count", () => {
    const r = describeSubagentProvenance({ metaSourced: true, messageCount: 3 })!;
    expect(r.disagrees).toBe(false);
    expect(r.label).toBe("from Claude Code's record");
  });
});
