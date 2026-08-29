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

/**
 * Is the explanation reachable without a mouse?
 *
 * Two shapes count, and the difference is #391's whole point:
 *
 *  - **`<Tooltip>`** — one element, associated by `aria-describedby`, opened by
 *    hover, focus AND tap. This is the target shape.
 *  - **`.sr-only` + `aria-hidden`** — #390's answer. It reaches screen readers
 *    and leaves sighted keyboard and touch users exactly where they were, so it
 *    is accepted only while the remaining chips are migrated.
 *
 * Accepting both is deliberate: a migration that had to land in one commit
 * across eleven components would be a worse change than one that can go chip by
 * chip with the guard holding the line behind it.
 */
function usesPrimitive(src: string, anchor: string, window = 1400): boolean {
  const i = src.indexOf(anchor);
  if (i === -1) return false;
  return /<Tooltip[\s>]/.test(src.slice(i, i + window));
}

/** Does the region following `anchor` pair `.sr-only` with `aria-hidden`? */
function hasAccessiblePair(src: string, anchor: string, window = 1400): boolean {
  const i = src.indexOf(anchor);
  if (i === -1) return false;
  if (usesPrimitive(src, anchor, window)) return true;
  const region = src.slice(i, i + window);
  // Match the rendered class attribute, not the bare substring: the word
  // "sr-only" now appears in explanatory comments next to several of these
  // chips, so a substring check would keep passing after the actual
  // `<span className="sr-only">` was deleted (Copilot review of #390).
  return /className="sr-only"/.test(region) && region.includes('aria-hidden="true"');
}

/**
 * Offsets of `.sr-only` spans whose immediately following sibling element is
 * not `aria-hidden`.
 *
 * Structural rather than statistical: it walks each `<span className="sr-only">`
 * to its matching `</span>`, then requires the very next element to carry
 * `aria-hidden="true"`. Comparing counts across a whole file cannot distinguish
 * "the visible twin is hidden" from "some unrelated icon happens to be hidden".
 */
function findUnpairedSrOnly(src: string): number[] {
  const unpaired: number[] = [];
  const open = /<span className="sr-only">/g;
  let m: RegExpExecArray | null;

  while ((m = open.exec(src)) !== null) {
    // Walk to the matching close, tolerating nested spans in the sr-only text.
    let depth = 1;
    let i = m.index + m[0].length;
    while (i < src.length && depth > 0) {
      if (src.startsWith("</span>", i)) { depth--; i += 7; continue; }
      if (/^<span[\s>]/.test(src.slice(i, i + 6))) { depth++; i += 5; continue; }
      i++;
    }
    // The next element after the sr-only span is the visible twin.
    const next = src.indexOf("<", i);
    if (next === -1) { unpaired.push(m.index); continue; }
    const tagEnd = src.indexOf(">", next);
    const tag = tagEnd === -1 ? src.slice(next) : src.slice(next, tagEnd + 1);
    if (!tag.includes('aria-hidden="true"')) unpaired.push(m.index);
  }
  return unpaired;
}

describe("#380 — load-bearing tooltips are reachable without a mouse", () => {
  it("QualityChip exposes its explanation to assistive tech", async () => {
    const src = await read("SessionsBrowser.tsx");
    // The shared chip renders `compaction loop`, `tool fail streak` and
    // `resume anomaly` — jargon whose entire meaning lived in `title`. Fixing
    // the shared component covers every call site at once.
    // Migrated to the primitive (#391), so this asserts the stronger property:
    // the explanation reaches keyboard and touch users too. Anchored on the
    // function declaration now that the `title` attribute it used to anchor on
    // is gone.
    const at = src.indexOf("function QualityChip(");
    expect(at).toBeGreaterThan(-1);
    expect(src.slice(at, at + 2200)).toMatch(/<Tooltip[\s>]/);
    // The mouse-only attribute is gone rather than merely supplemented.
    expect(src).not.toContain("      title={title}");
  });

  it("the git 'status unavailable' caveat is not mouse-only", async () => {
    const src = await read("GitStatus.tsx");
    // The highest-stakes one: "status unavailable" sits where "N uncommitted"
    // would be, so a reader who cannot reach the tooltip sees no dirty count
    // and concludes the repo is clean. The failure looks like success.
    //
    // Anchored on the call site, not the message text: the explanation is now a
    // shared constant declared at the top of the file, so matching the literal
    // found the declaration and looked at the wrong 900 characters.
    // Migrated to the primitive (#391), so this asserts the stronger property
    // rather than the transitional one: the explanation reaches keyboard and
    // touch users too, not only screen readers.
    expect(src).toMatch(/<Tooltip[\s\S]{0,120}GIT_STATUS_UNKNOWN_EXPLANATION/);
    // And the mouse-only attribute is gone rather than merely supplemented.
    expect(src).not.toContain("title={GIT_STATUS_UNKNOWN_EXPLANATION}");
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
    // Anchored on the call site, not the shared helper's definition — the
    // helper now lives at the top of the file, far from the chip it feeds.
    expect(hasAccessiblePair(src, "title={attributedCostExplanation(")).toBe(true);
    expect(hasAccessiblePair(src, "explicit Skill invocation")).toBe(true);
  });

  it("fixes the Git status variant the app actually renders", async () => {
    // The original #380 fix went into `GitStatus`, which nothing renders:
    // ProjectCard and ProjectDetail both import `GitStatusCompact`. A
    // screen-reader user in every real flow still got a bare "?" (Codex
    // review, #390).
    //
    // Pinned two ways, because the source-level check alone is what missed it:
    // the compact variant must carry the explanation, AND the components that
    // render Git status must be the variant that has it.
    const src = await read("GitStatus.tsx");
    const compactStart = src.indexOf("export function GitStatusCompact");
    expect(compactStart).toBeGreaterThan(-1);
    const compact = src.slice(compactStart);
    // The variant that actually ships must be the migrated one — the #390
    // lesson was that a fix can land in a component nothing renders.
    expect(compact).toMatch(/<Tooltip[\s>]/);
    expect(compact).toContain("GIT_STATUS_UNKNOWN_EXPLANATION");

    for (const consumer of ["ProjectCard.tsx", "ProjectDetail.tsx"]) {
      const c = await read(consumer);
      const rendered = /<GitStatus(Compact)?\b/.exec(c);
      if (!rendered) continue;
      const variant = rendered[1] ? "GitStatusCompact" : "GitStatus";
      const variantStart = src.indexOf(`export function ${variant}`);
      const variantEnd = src.indexOf("\nexport function ", variantStart + 1);
      const body = src.slice(variantStart, variantEnd === -1 ? undefined : variantEnd);
      // Either shape: `<Tooltip>` (the #391 target) or the transitional
      // `.sr-only` pair. What must not happen is a consumer rendering a
      // variant that carries NEITHER — the #390 defect.
      expect(body, `${consumer} renders ${variant}, which must carry the caveat`)
        .toMatch(/<Tooltip[\s>]|className="sr-only"/);
    }
  });

  it("announces the cache-hit value exactly once", async () => {
    // #390: the percentage lived only in `children`, which the #380 fix marked
    // aria-hidden — a screen reader heard "cache hit ratio, >70% is healthy"
    // and never the session's actual ratio. The fix that made the chip
    // accessible removed the one number it existed to report.
    //
    // #391 removed the hiding, so the value is announced as the trigger's own
    // label. The old assertion — that the accessible text INTERPOLATES the
    // value — then ratified a defect: it was satisfied precisely by the
    // duplication that makes a focused chip read "75% cache, 75% cache..."
    // (Codex P2, PR #519).
    //
    // Both halves are asserted, because either alone is satisfied by the
    // other's failure: dropping the visible label passes the no-duplicate
    // check, and restoring the prefix passes the value-is-present check.
    const src = await read("SessionsBrowser.tsx");
    const i = src.indexOf("function CacheHitBadge");
    expect(i).toBeGreaterThan(-1);
    const region = src.slice(i, i + 900);
    // 1. The value is still rendered as the visible, unhidden label.
    expect(region).toMatch(/>\s*\{pct\}% cache/);
    // 2. And it is NOT restated in the accessible description. Matching the
    //    PROP (`srText=`), not the bare word — the region contains a comment
    //    saying why the prop is gone, and a bare-word check would be failed by
    //    the explanation rather than by the defect. That is the same way a
    //    `[data-loading]` mention in a comment silently satisfied a rule in
    //    the #445 guard.
    expect(region).not.toMatch(/srText=/);
  });

  it("does not restate a visible label inside its own description", async () => {
    // The class, not one instance. A `Tooltip` description carries what the
    // visible label CANNOT say; once #391 stopped hiding the label, anything
    // that also restated it made a focused chip announce the same value twice.
    //
    // Both value-carrying chips had it, found one round apart (Codex P2, PR
    // #519): `CacheHitBadge` prefixed its description with the percentage, and
    // `EffortMixChip` appended the whole level/count list. Asserted together so
    // the next one is caught by the rule rather than by a reviewer.
    const effort = await read("EffortMixChip.tsx");
    const explanation = effort.slice(
      effort.indexOf("const explanation ="),
      effort.indexOf("return (")
    );
    expect(explanation).not.toMatch(/entries\.map/);
    // The visible label is still the mix — the fix is not "drop the counts".
    expect(effort).toMatch(/\{entries\.map\(\(\[level, n\]\) =>/);
  });

  it("uses .sr-only rather than aria-label on generic spans", async () => {
    // ARIA does not reliably name a generic element and some screen readers
    // drop it, which is why the issue prescribes `.sr-only` for spans. The
    // pattern is only correct when the visible half is hidden from AT — a
    // bare `.sr-only` beside unhidden text is read twice.
    //
    // Checked pair by pair, NOT by comparing file-wide totals. The counting
    // version could not tell a real pairing from a coincidence: in GitStatus,
    // deleting `aria-hidden` from the visible label left the alert icon's
    // unrelated `aria-hidden` behind, so the totals still balanced and the test
    // passed while a screen reader announced the terse label after the
    // explanation (Codex review, #390).
    for (const file of ["SessionsBrowser.tsx", "EffortMixChip.tsx", "GitStatus.tsx"]) {
      const src = await read(file);
      const unpaired = findUnpairedSrOnly(src);
      expect(unpaired, `${file}: sr-only at offset(s) ${unpaired.join(", ")} have no aria-hidden sibling`)
        .toEqual([]);
    }
  });
});
