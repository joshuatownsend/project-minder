import { readFile } from "node:fs/promises";
import { describe, it, expect } from "vitest";
import {
  tooltipTop,
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

describe("tooltipTop", () => {
  const VIEWPORT = 800;
  /** A chip with plenty of room on both sides. */
  const mid = { left: 100, right: 160, top: 400, bottom: 420, width: 60 };

  it("prefers above when the tooltip fits there", () => {
    expect(tooltipTop(mid, 40, VIEWPORT)).toBe(400 - 40 - 8);
  });

  it("goes below when there is no room above", () => {
    const high = { ...mid, top: 10, bottom: 30 };
    expect(tooltipTop(high, 40, VIEWPORT)).toBe(30 + 8);
  });

  it("never places the tooltip past the bottom edge", () => {
    // The case that shipped unclamped: no room above, and not enough below
    // either, on a short or zoomed viewport. `trigger.bottom + margin` put the
    // lower half of a wrapped explanation off-screen.
    const short = { left: 10, right: 60, top: 20, bottom: 40, width: 50 };
    const top = tooltipTop(short, 120, 150);
    expect(top + 120).toBeLessThanOrEqual(150 - 8);
    expect(top).toBeGreaterThanOrEqual(8);
  });

  it("picks the roomier side when the tooltip fits on neither", () => {
    // Near the bottom of a short viewport: above has more space than below, so
    // clipping should happen upward rather than always downward.
    const low = { left: 10, right: 60, top: 100, bottom: 120, width: 50 };
    expect(tooltipTop(low, 90, 140)).toBeLessThan(120);
  });

  it("pins a tooltip taller than the viewport to the top margin", () => {
    // Matches `tooltipLeft`'s behaviour for one wider than the viewport: losing
    // the END of the text is the readable failure, losing the start is not.
    //
    // POSITION only. This case is not survivable by arithmetic alone — a 900px
    // box in an 800px viewport overflows wherever it is put — so the component
    // pairs this with `maxHeight: calc(100vh - 16px)` and `overflowY: auto`,
    // and becomes pointer-interactive while open so the overflow can actually
    // be scrolled. A test that accepted this number WITHOUT that pairing was
    // ratifying clipped, unreadable text (Codex P2, PR #519).
    expect(tooltipTop(mid, 900, VIEWPORT)).toBe(8);
  });

  it("has ONE discontinuity, and it is the side flip", () => {
    // `tooltipLeft` is monotonic — nudging the trigger right never moves the
    // tooltip left — and the obvious vertical analogue is FALSE, deliberately.
    // As the trigger descends past the point where the tooltip fits above, the
    // placement flips from below to above and the top jumps upward. Asserting
    // monotonicity here would have been asserting that the side-choice does not
    // work; what is worth pinning is that the flip happens exactly once.
    let flips = 0;
    let previous = -Infinity;
    for (let top = 0; top < 700; top += 5) {
      const t = tooltipTop({ left: 10, right: 60, top, bottom: top + 20, width: 50 }, 60, 800);
      if (t < previous) flips++;
      previous = t;
    }
    expect(flips).toBe(1);
  });
});

describe("the component pairs clamping with a bound", () => {
  // `tooltipTop` can only choose a POSITION. A tooltip taller than the viewport
  // overflows wherever it is placed, so the arithmetic is only half the promise
  // this primitive makes — the other half is a bounded, scrollable box, and it
  // lives in the component's style object where no unit test naturally looks.
  // Asserted here rather than left implicit, because the position test above
  // reads as complete on its own and is exactly what let the gap ship.
  it("bounds the height, scrolls the overflow, and can be pointed at", async () => {
    const src = await readFile("src/components/ui/tooltip.tsx", "utf-8");
    expect(src).toMatch(/maxHeight:/);
    expect(src).toMatch(/overflowY:\s*"auto"/);
    // A scrollable box behind `pointerEvents: "none"` is not scrollable.
    expect(src).toMatch(/pointerEvents:\s*open \? "auto" : "none"/);
  });

  it("makes the overflow reachable by pointer AND by keyboard", async () => {
    // Being scrollable is not the same as being scrollABLE BY SOMEONE. Two
    // separate ways to reach it, and each was missing on its own review round
    // (Codex P2 x2, PR #519):
    //
    //  - the pointer has to cross an 8px gap to a PORTALED element, so the
    //    hover hold must survive the trip;
    //  - a keyboard user cannot enter the tip at all, so the trigger has to
    //    scroll it in place.
    const src = await readFile("src/components/ui/tooltip.tsx", "utf-8");
    // The hover bridge: a delayed exit, cancelled on re-entry.
    expect(src).toMatch(/HOVER_EXIT_MS/);
    expect(src).toMatch(/onMouseLeave=\{beginHoverExit\}/);
    // And the tip itself counts as hover, or crossing the gap arrives nowhere.
    expect(src.match(/onMouseEnter=\{enterHover\}/g)?.length).toBe(2);
    // The keyboard path, scrolling the tip without moving focus into it.
    expect(src).toMatch(/tipEl\.scrollTop \+= step/);
    // Guarded on real overflow, so a focused chip never swallows page scroll.
    expect(src).toMatch(/scrollHeight <= tipEl\.clientHeight/);
    // And a touch drag ON the tooltip is not an "outside" pointer. The tip is
    // portaled, so a trigger-only containment test dismissed it on the very
    // gesture meant to scroll it — and touch has no hover hold to fall back on.
    expect(src).toMatch(/tipRef\.current\?\.contains\(target\)/);
  });
});
