/**
 * How much of a window the tool-provenance split actually speaks for.
 *
 * `getToolProvenance` computes the built-in / MCP / plugin split only over
 * events carrying `tool_source`. Claude Code began emitting that attribute
 * partway through most indexes — on the reference machine it starts
 * 2026-07-19 while events go back to 2023-11-14 — so a wide window states a
 * source for only part of its calls. Reporting the split without the coverage
 * is a partial answer shaped exactly like a complete one.
 */

export interface SourceCoverageNote {
  /** True when the split describes less than every call in the window. */
  partial: boolean;
  /**
   * Percentage for display, as a string.
   *
   * Truncated rather than rounded, and never rendered as `100` while
   * `partial` is true: 99.6% coverage rounding up to "100% of this window"
   * next to a partial-data warning is a self-contradicting card. `<1` covers
   * the other end, where a real but tiny slice would otherwise print as `0`.
   */
  pctLabel: string;
}

export function describeSourceCoverage(result: {
  total: number;
  callsInWindow: number;
  sourceCoverage?: number;
}): SourceCoverageNote | null {
  const { total, callsInWindow, sourceCoverage } = result;

  // Nothing to divide, so nothing to claim. An empty window is not "fully
  // covered" — there was simply nothing to cover.
  if (typeof sourceCoverage !== "number" || callsInWindow <= 0) return null;

  // `>= 1` rather than `=== 1`: if the attribute ever appears on an event type
  // outside the denominator, coverage exceeds 1 and the honest reading is
  // "nothing missing here", not a percentage above 100.
  if (sourceCoverage >= 1) return { partial: false, pctLabel: "100" };

  const raw = sourceCoverage * 100;
  // Truncate. Math.round would turn 99.6% into "100", contradicting `partial`.
  const truncated = Math.floor(raw);
  return {
    partial: true,
    pctLabel: total > 0 && truncated < 1 ? "<1" : String(truncated),
  };
}
