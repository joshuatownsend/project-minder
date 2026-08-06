import { describe, it, expect } from "vitest";
import { promises as fs } from "fs";
import path from "path";

/**
 * Issue #380 — tooltip-only information.
 *
 * `title` is a mouse-only affordance: it is not shown on keyboard focus in any
 * major browser, touch devices have no hover, and screen-reader support is
 * inconsistent. Where the tooltip is the **only** place a piece of information
 * exists, that information is unreachable for keyboard, touch and screen-reader
 * users.
 *
 * The issue is explicit that this is not a sweep of all 269 `title=` usages —
 * most restate visible text and are harmless. These tests pin the load-bearing
 * subset: chips whose tooltip defines a jargon term or supplies a missing unit.
 *
 * Source-level assertions rather than DOM tests because the repo has no
 * component-render harness, and the invariant is genuinely textual: the
 * explanation must appear somewhere other than the `title` attribute.
 */

const COMPONENTS = path.resolve(__dirname, "..", "src", "components");

async function read(rel: string): Promise<string> {
  return fs.readFile(path.join(COMPONENTS, rel), "utf-8");
}

/** Does the region following `anchor` pair `.sr-only` with `aria-hidden`? */
function hasAccessiblePair(src: string, anchor: string, window = 1400): boolean {
  const i = src.indexOf(anchor);
  if (i === -1) return false;
  const region = src.slice(i, i + window);
  return region.includes("sr-only") && region.includes('aria-hidden="true"');
}

describe("#380 — load-bearing tooltips are reachable without a mouse", () => {
  it("QualityChip exposes its explanation to assistive tech", async () => {
    const src = await read("SessionsBrowser.tsx");
    // The shared chip renders `compaction loop`, `tool fail streak` and
    // `resume anomaly` — jargon whose entire meaning lived in `title`. Fixing
    // the shared component covers every call site at once.
    expect(hasAccessiblePair(src, "function QualityChip", 2200)).toBe(true);
  });

  it("the git 'status unavailable' caveat is not mouse-only", async () => {
    const src = await read("GitStatus.tsx");
    // The highest-stakes one: "status unavailable" sits where "N uncommitted"
    // would be, so a reader who cannot reach the tooltip sees no dirty count
    // and concludes the repo is clean. The failure looks like success.
    expect(hasAccessiblePair(src, "git status check failed", 900)).toBe(true);
  });

  it("the effort mix explains why it does not sum to the turn count", async () => {
    const src = await read("EffortMixChip.tsx");
    expect(hasAccessiblePair(src, "Reasoning effort across")).toBe(true);
  });

  it("the project 'live?' badge says what is uncertain", async () => {
    const src = await read("ProjectCard.tsx");
    // "live?" is a question mark and nothing else.
    expect(hasAccessiblePair(src, "Hook events suggest this project was live")).toBe(true);
  });

  it("the skills catalog distinguishes attributed spend from invocation count", async () => {
    const src = await read("SkillsBrowser.tsx");
    // Two adjacent monospace numbers with no visible unit: one is dollars, the
    // other a dispatch count. Telling them apart is the point of the catalog.
    expect(hasAccessiblePair(src, "of spend attributed to this skill")).toBe(true);
    expect(hasAccessiblePair(src, "explicit Skill invocation")).toBe(true);
  });

  it("uses .sr-only rather than aria-label on generic spans", async () => {
    // ARIA does not reliably name a generic element and some screen readers
    // drop it, which is why the issue prescribes `.sr-only` for spans. The
    // pattern is only correct when the visible half is hidden from AT — a
    // bare `.sr-only` beside unhidden text is read twice.
    for (const file of ["SessionsBrowser.tsx", "EffortMixChip.tsx", "GitStatus.tsx"]) {
      const src = await read(file);
      const srCount = (src.match(/className="sr-only"/g) ?? []).length;
      const hiddenCount = (src.match(/aria-hidden="true"/g) ?? []).length;
      expect(srCount, `${file}: every sr-only needs a matching aria-hidden sibling`)
        .toBeLessThanOrEqual(hiddenCount);
    }
  });
});
