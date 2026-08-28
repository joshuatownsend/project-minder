import { describe, it, expect } from "vitest";
import {
  tooltipAbove,
  tooltipLeft,
  VIEWPORT_MARGIN,
  type Rect,
} from "@/lib/ui/tooltipPosition";

// #391 — the arithmetic behind the tooltip primitive.
//
// The component's interaction wiring is asserted at source level, because this
// repo's test environment is `node` with no jsdom and no testing-library. What
// CAN be wrong independently of the DOM is the placement maths, so it lives in
// a pure module and is tested here rather than trusted.

function rect(left: number, width: number, top = 200): Rect {
  return { left, right: left + width, top, bottom: top + 20, width };
}

describe("tooltipLeft", () => {
  it("centres on the trigger when there is room", () => {
    // trigger 100..140, tooltip 200 wide → centred at 120 − 100 = 20
    expect(tooltipLeft(rect(100, 40), 200, 1000)).toBe(20);
  });

  it("clamps to the left margin rather than going negative", () => {
    // A chip at the very left edge would otherwise centre off-screen.
    expect(tooltipLeft(rect(4, 20), 200, 1000)).toBe(VIEWPORT_MARGIN);
  });

  it("clamps to the right margin", () => {
    expect(tooltipLeft(rect(960, 30), 200, 1000)).toBe(1000 - 200 - VIEWPORT_MARGIN);
  });

  it("slides along the axis instead of flipping sides", () => {
    // The property, not an instance: nudging the trigger right never moves the
    // tooltip LEFT. A tooltip that jumped sides near an edge would move out
    // from under the pointer that summoned it.
    let previous = -Infinity;
    for (let left = 0; left <= 980; left += 20) {
      const at = tooltipLeft(rect(left, 20), 200, 1000);
      expect(at).toBeGreaterThanOrEqual(previous);
      previous = at;
    }
  });

  it("pins a tooltip wider than the viewport to the left margin", () => {
    // Negative `left` would push the text off-screen entirely; pinning lets it
    // wrap, which is the readable failure.
    expect(tooltipLeft(rect(100, 40), 900, 400)).toBe(VIEWPORT_MARGIN);
  });

  it("never lets the tooltip start left of the margin", () => {
    for (const width of [40, 200, 320]) {
      for (const left of [0, 5, 500, 995]) {
        expect(tooltipLeft(rect(left, 20), width, 1000)).toBeGreaterThanOrEqual(
          VIEWPORT_MARGIN
        );
      }
    }
  });
});

describe("tooltipAbove", () => {
  it("prefers above when there is room", () => {
    expect(tooltipAbove(rect(0, 20, 200), 40)).toBe(true);
  });

  it("falls below when the trigger is near the top", () => {
    // The case a fixed "always above" choice gets wrong: a chip in a header.
    expect(tooltipAbove(rect(0, 20, 10), 40)).toBe(false);
  });

  it("treats an exact fit as room", () => {
    expect(tooltipAbove(rect(0, 20, 48), 40, 8)).toBe(true);
    expect(tooltipAbove(rect(0, 20, 47), 40, 8)).toBe(false);
  });
});
