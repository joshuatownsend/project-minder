import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

/**
 * #445 — every visible loading state must be detectable from outside the
 * component.
 *
 * The app had three unrelated loading idioms with no shared marker: `<Skeleton>`
 * (findable via `.animate-pulse`), a plain "Loading…" sentence, and bespoke
 * inline-styled placeholder boxes. Nothing outside a component could answer
 * "is this view still loading?".
 *
 * That is not merely inconsistent. The screenshot pipeline gates on
 * `.animate-pulse`, so it was blind to the other two and **published**
 * `status.png` as four empty grey bars, `config.png` with every tab count
 * reading `0`, and four more shots mid-load — all live on the public landing
 * page until someone noticed by eye. The capture scripts now wait on
 * `[data-loading]`, which is only as good as this guard.
 *
 * The check is FILE-LEVEL and deliberately coarse: a file with a loading branch
 * must mention the marker somewhere. Matching a specific branch to a specific
 * element needs a JSX parse, and a regex that tried would be confidently wrong
 * on the cases that matter. Coarse-and-honest beats precise-and-fictional; the
 * same reasoning is written at `dbIsolationGuard`'s own limits.
 */

const ROOTS = ["src/components", "src/app"];

/**
 * Files with a loading branch that legitimately renders NO marker, each with
 * the reason. An allowlist rather than a cleverer regex, so an exemption is a
 * decision someone wrote down instead of a pattern silently not matching.
 */
const EXEMPT: Record<string, string> = {
  "src/components/DisabledHooksSection.tsx":
    "returns null while loading — the section is absent, not pending, so there " +
    "is no element to mark and nothing on screen to photograph mid-load",
  "src/components/SessionTimeline.tsx":
    "its `if (loading)` returns a STRING from a label helper, not a rendered " +
    "branch; the surrounding component has its own state",
};

function tsxFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...tsxFiles(full));
    else if (entry.name.endsWith(".tsx")) out.push(full.replace(/\\/g, "/"));
  }
  return out;
}

const LOADING_BRANCH =
  /\bif\s*\(\s*(?:loading|isLoading|!loaded|![A-Za-z]*[Ll]oaded)\b[^)]*\)\s*\{?\s*(?:return)?/;

/** The literal sentence, in both spellings that existed before this landed. */
const LOADING_TEXT = /Loading(?:…|\.\.\.)/;

describe("every loading state carries a queryable marker (#445)", () => {
  const files = ROOTS.flatMap(tsxFiles);

  it("finds the components it is about to check", () => {
    // Without this the suite passes by vacuity if the roots ever move — the
    // failure mode a repo-scanning guard has and an ordinary test does not.
    expect(files.length).toBeGreaterThan(100);
  });

  it("no component renders a loading branch without data-loading", () => {
    const violations: string[] = [];
    for (const file of files) {
      const code = fs.readFileSync(file, "utf-8");
      if (!LOADING_BRANCH.test(code) && !LOADING_TEXT.test(code)) continue;
      if (code.includes("data-loading") || code.includes("<Skeleton")) continue;
      if (EXEMPT[file]) continue;
      violations.push(
        `${file} has a loading state with no \`data-loading\` marker and no ` +
          `<Skeleton>. Anything outside the component — the screenshot ` +
          `pipeline, a test, a11y tooling — cannot tell it apart from a ` +
          `finished view. Mark the element it renders while loading, or add ` +
          `it to EXEMPT in this file with the reason.`
      );
    }
    expect(violations).toEqual([]);
  });

  it("keeps the exemption list honest", () => {
    // An exemption for a file that no longer has a loading branch is a stale
    // licence, and the next file to take that name inherits it silently.
    const stale: string[] = [];
    for (const [file, reason] of Object.entries(EXEMPT)) {
      if (!fs.existsSync(file)) {
        stale.push(`${file} is exempt but does not exist`);
        continue;
      }
      const code = fs.readFileSync(file, "utf-8");
      if (!LOADING_BRANCH.test(code) && !LOADING_TEXT.test(code)) {
        stale.push(`${file} is exempt (${reason}) but has no loading branch`);
      }
    }
    expect(stale).toEqual([]);
  });

  it("Skeleton itself carries the marker, since 23 components rely on it", () => {
    const code = fs.readFileSync("src/components/ui/skeleton.tsx", "utf-8");
    expect(code).toContain("LOADING_ATTR");
  });
});
