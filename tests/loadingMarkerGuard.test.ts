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
 * ## Branch-local, not file-level
 *
 * The first version asked whether the FILE mentioned the marker anywhere.
 * Codex pointed out on PR #517 that this waves through a component with two
 * loading states where only one is marked — `MemoryTab` was exactly that — and
 * that it only recognised `if (loading)`, missing `loading ? (…)` and
 * `loading && (…)`, and only the capitalised spelling. Three genuinely
 * unmarked states passed it on the day it was written.
 *
 * It now looks for the marker in a WINDOW after each condition, which is where
 * that branch's JSX lives. Still a regex over source — matching a branch to its
 * element needs a JSX parse — but local to the branch rather than the file,
 * which is the difference between "coarse" and "wrong".
 *
 * ## What it deliberately does not match
 *
 * A condition only counts when something is RENDERED after it: `(` then `<`, or
 * `<` directly. Without that tail the patterns also caught styling ternaries
 * (`cursor: loading ? "not-allowed" : "pointer"`, `opacity: loading ? 0.6 : 1`)
 * and button labels — not loading views, with no element to mark. A draft
 * without the tail reported 58 sites, mostly noise, and a guard that cries wolf
 * on correct code is worse than one with a stated limit: it teaches people to
 * route around it.
 *
 * ## What it cannot see
 *
 * Whether the attribute survives to the DOM. `HarnessConfigView` passed
 * `data-loading` to a local `Note` that did not forward props, so React dropped
 * it while the source read correctly (Codex + Copilot, PR #517). This catches
 * the absent marker, not the swallowed one.
 */

const ROOTS = ["src/components", "src/app"];

/** How much source after a loading condition counts as "its branch". */
const BRANCH_WINDOW = 700;

/**
 * Loading branches that legitimately render no marker, each with the reason.
 * An allowlist rather than a cleverer regex, so an exemption is a decision
 * someone wrote down instead of a pattern silently not matching.
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

/** "…and then it renders something." */
const RENDERS = String.raw`\s*\(?\s*<`;
const FLAG = String.raw`(?:loading|isLoading|[a-z]\w*Loading|isConnecting)`;
/**
 * Further `&&` terms between the flag and the element. `{loading && !status
 * && <div>…}` is one condition, not two, and requiring the element to sit
 * immediately after the flag left it unmatched (Codex, PR #517).
 */
const MORE_TERMS = String.raw`(?:[^<>{}]{0,80}&&)*`;
const NOT_LOADED = String.raw`!\s*(?:loaded|[a-z]\w*Loaded)`;

/**
 * `lookBack` is not decoration. For a CONDITION the branch's JSX follows the
 * match, so zero is right. For the SENTENCE the marker sits on the opening
 * tag that PRECEDES it — `<p data-loading="true">Loading…</p>` — so a
 * forward-only window reports every correctly-marked site in the codebase.
 * A draft without it flagged 50, most of them already fixed.
 */
const BRANCH_PATTERNS: Array<{ re: RegExp; lookBack: number }> = [
  // `loading ? <…` / `loading && (<…`
  {
    // The negative lookbehinds matter: `{data && !loading && (<>` is the
    // LOADED branch, and without them the flag matches inside it and the
    // guard demands a marker on content that has finished arriving.
    re: new RegExp(
      String.raw`(?<!!)(?<!!\s)\b` +
        FLAG +
        String.raw`\b\s*(?:\?|&&)` +
        MORE_TERMS +
        RENDERS,
      "g"
    ),
    lookBack: 0,
  },
  {
    re: new RegExp(NOT_LOADED + String.raw`\b\s*(?:\?|&&)` + RENDERS, "g"),
    lookBack: 0,
  },
  // `if (loading) return <…`
  {
    re: new RegExp(
      String.raw`\bif\s*\(\s*(?:` +
        FLAG +
        "|" +
        NOT_LOADED +
        String.raw`)\b[^)]*\)\s*\{?\s*return` +
        RENDERS,
      "g"
    ),
    lookBack: 0,
  },
  // the sentence itself, in either spelling and either case
  // Only as JSX CONTENT (`>` then the word), never as a string literal.
  // Quoted forms are button labels and prop values -- `sub={x === null ?
  // "loading…" : …}`, `{bodyLoading ? "loading…" : "View full body"}` --
  // which indicate a pending FETCH but are not a loading VIEW and have no
  // element of their own to mark. Policing them would force a marker onto
  // whatever element happened to contain the label.
  {
    // The subject may sit BETWEEN the word and the ellipsis — "Loading
    // quota…", "Loading adapters…", "loading projects…". Requiring them
    // adjacent left four visible unmarked states green (Codex, PR #517).
    // Bounded to 40 chars and no tag/brace between, so it stays a
    // SENTENCE rather than swallowing the rest of a component.
    // The ellipsis is OPTIONAL when the word is the whole content:
    // `<p>Loading</p>` is as much a loading state as `<p>Loading…</p>`,
    // and four of them were live (Codex, PR #517). Requiring the closing
    // `<` keeps it to a sentence rather than any prose containing the word.
    re: />\s*(?:[Ll]oading|[Cc]onnecting)\b[^<>{}\n]{0,40}?(?:…|\.\.\.)?\s*</g,
    lookBack: 600,
  },
];

/**
 * What counts as "this branch is marked".
 *
 * `<LoadingSkeleton` is here because four components define a local one
 * that marks its OWN root — which is the right shape, since a component
 * that IS a loading state should not depend on every caller remembering to
 * say so, and a propless one silently drops an attribute passed to it
 * anyway (Codex, PR #517). The convention is verified below rather than
 * trusted: a `LoadingSkeleton` that stopped marking its root would fail.
 */
// `data-loading=` with the EQUALS, not the bare word. A comment mentioning
// `[data-loading]` satisfied the bare form, and this file is full of such
// comments — including the one explaining the fix. Caught by mutation: the
// rule stayed green with the real attribute deleted.
const MARKER = /data-loading=|<\w*Skeleton/;

describe("every loading state carries a queryable marker (#445)", () => {
  const files = ROOTS.flatMap(tsxFiles);

  it("finds the components it is about to check", () => {
    // Without this the suite passes by vacuity if the roots ever move — the
    // failure mode a repo-scanning guard has and an ordinary test does not.
    expect(files.length).toBeGreaterThan(100);
  });

  it("matches the branch shapes it claims to", () => {
    // The guard's own discriminating test: without it, a pattern that stopped
    // matching would turn this file green rather than red.
    const samples = [
      `if (loading) return <div>x</div>;`,
      `{loading ? <Spinner /> : <List />}`,
      `{loading && (<div>x</div>)}`,
      `{!loaded && <div>x</div>}`,
      `<p>Loading…</p>`,
      `<p>loading...</p>`,
      `<div>Loading quota…</div>`,
      `<span>loading projects…</span>`,
      `<p>Loading</p>`,
      `{loading && !status && <div>x</div>}`,
      `<span>Connecting to live session stream…</span>`,
    ];
    for (const s of samples) {
      const hit = BRANCH_PATTERNS.some(({ re }) => {
        re.lastIndex = 0;
        return re.test(s);
      });
      expect(hit, `no pattern matched: ${s}`).toBe(true);
    }

    // ...and the shapes it must NOT match, which is what keeps it usable.
    const ignored = [
      `cursor: loading ? "not-allowed" : "pointer",`,
      `opacity: loading ? 0.6 : 1,`,
      `{loading ? "Distilling…" : "Distill"}`.replace("…", ""),
      `{data && !loading && (<><Panel /></>)}`,
    ];
    for (const s of ignored) {
      const hit = BRANCH_PATTERNS.some(({ re }) => {
        re.lastIndex = 0;
        return re.test(s);
      });
      expect(hit, `should not have matched: ${s}`).toBe(false);
    }
  });

  it("no loading branch renders without a marker beside it", () => {
    const violations: string[] = [];
    for (const file of files) {
      if (EXEMPT[file]) continue;
      const code = fs.readFileSync(file, "utf-8");
      for (const { re, lookBack } of BRANCH_PATTERNS) {
        re.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = re.exec(code)) !== null) {
          const window = code.slice(
            Math.max(0, m.index - lookBack),
            m.index + BRANCH_WINDOW
          );
          if (MARKER.test(window)) continue;
          const line = code.slice(0, m.index).split("\n").length;
          violations.push(
            `${file}:${line} — a loading branch with no \`data-loading\` and ` +
              `no <Skeleton> within ${BRANCH_WINDOW} chars.`
          );
          break; // one report per pattern per file is enough to act on
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("no SETTLED branch carries the marker", () => {
    // The inverse defect, and the more damaging one (Codex P1, PR #517). A
    // marker on a `!loading &&` branch mounts permanently once the fetch
    // finishes, so `[data-loading]` reports a finished page as busy forever —
    // and the capture pipeline then waits its full 60s budget and SKIPS the
    // shot rather than publishing a stale one. A missing marker publishes the
    // wrong image; an inverted one publishes nothing.
    //
    // Seven of these were introduced by the mechanical sweep in this very PR,
    // which matched the first `<` after a condition without checking whether
    // the condition was negated. Worth a rule rather than a memory.
    const NEGATED = /!\s*(?:loading|isLoading|[a-z]\w*Loading)\b[^<]{0,140}<[A-Za-z][\w.]*([^>]{0,160})/g;
    const violations: string[] = [];
    for (const file of files) {
      const code = fs.readFileSync(file, "utf-8");
      NEGATED.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = NEGATED.exec(code)) !== null) {
        if (!m[1].includes("data-loading")) continue;
        const line = code.slice(0, m.index).split("\n").length;
        violations.push(
          `${file}:${line} — \`data-loading\` on a branch guarded by a ` +
            `NEGATED loading flag. That element renders when loading is DONE, ` +
            `so the marker mounts permanently and every consumer reads the ` +
            `page as busy forever.`
        );
      }
    }
    expect(violations).toEqual([]);
  });

  it("no component declares a loading flag and marks nothing", () => {
    // The class the branch rules structurally cannot see: a component whose
    // ONLY conditional UI is the settled `!flag` branch renders NOTHING while
    // pending (Codex, PR #517). There is no element to find, so requiring one
    // to be rendered after the condition passes it — and the view reads as
    // "no data" to a person and as "settled" to `[data-loading]`.
    //
    // File-level, unavoidably: the question is about an ABSENCE. It is narrow
    // enough to be safe — it fires only when a `…Loading` flag is declared and
    // the file has no marker of any kind, which was true of exactly one
    // component when this was written.
    // Declared as state OR received as a prop. `ItemUsageBreakdown` takes
    // `loading?: boolean` and only dims its body with it, which no
    // branch rule can see (Codex, PR #517).
    const DECLARES =
      /const \[\s*[a-z]\w*[Ll]oading\s*,|^\s*loading\??:\s*boolean/m;
    const violations: string[] = [];
    for (const file of files) {
      if (EXEMPT[file]) continue;
      const code = fs.readFileSync(file, "utf-8");
      if (!DECLARES.test(code)) continue;
      if (MARKER.test(code)) continue;
      violations.push(
        `${file} declares a loading flag but renders no marker anywhere. If ` +
          `the pending state shows nothing, give it a marked placeholder — a ` +
          `blank section reads as "no data" rather than "not known yet".`
      );
    }
    expect(violations).toEqual([]);
  });

  it("no marker is driven by an emptiness or nullness test", () => {
    // The single most repeated defect in this PR — six instances, found one at
    // a time. `rows === null`, `adapters.length === 0`, `!library`,
    // `fx === null`, `recentProjects.length === 0`, `usageAll === null`: all of
    // them read as "still loading" AND as "the request failed", because a
    // failed fetch leaves the state exactly as empty as a pending one. A marker
    // driven by one never clears, and every `[data-loading]` consumer then
    // treats the page as busy until it times out — which for the capture
    // pipeline means the shot is SKIPPED, not stale.
    //
    //   A loading marker needs a flag that is definitively CLEARED.
    //
    // Matches the emptiness test immediately guarding a marked element, and
    // the conditional form. Deliberately narrow: it is looking for a specific
    // mistake, not auditing every condition in the tree.
    const EMPTY_GUARD =
      /\{\s*(!\s*[A-Za-z_$][\w.$]*|[A-Za-z_$][\w.$]*(?:\.length)?\s*===?\s*(?:0|null|undefined))\s*&&[^<]{0,80}<[A-Za-z][\w.]*\s+data-loading="true"/g;
    const EMPTY_COND =
      /data-loading=\{[^}]{0,120}?(?:\.length\s*===?\s*0|===?\s*null|===?\s*undefined)/g;

    const violations: string[] = [];
    for (const file of files) {
      const code = fs.readFileSync(file, "utf-8");
      for (const re of [EMPTY_GUARD, EMPTY_COND]) {
        re.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = re.exec(code)) !== null) {
          // A proper flag inside the matched span means the emptiness test
          // is not what drives the marker — `{!collapsed && (loading ? …)}`
          // is a layout gate wrapping a real condition.
          // Only the part BEFORE the attribute: `m[0]` ends with
          // `data-loading`, which contains "loading", so testing the whole
          // match disabled this rule entirely. Caught by mutation.
          const guardExpr = m[0].slice(0, m[0].indexOf("data-loading"));
          if (/[Pp]ending|[Ll]oading|[Cc]onnecting/.test(guardExpr)) continue;
          const line = code.slice(0, m.index).split("\n").length;
          violations.push(
            `${file}:${line} — the marker is driven by an emptiness/nullness ` +
              `test (\`${(m[1] ?? m[0]).trim().slice(0, 40)}\`). A failed request ` +
              `leaves that state empty too, so the marker would never clear. ` +
              `Track a pending flag and settle it in a \`finally\`.`
          );
        }
      }
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
      const hasBranch =
        /\b(?:loading|isLoading|loaded)\b/.test(code) ||
        /[Ll]oading(?:…|\.\.\.)/.test(code);
      if (!hasBranch) {
        stale.push(`${file} is exempt (${reason}) but has no loading branch`);
      }
    }
    expect(stale).toEqual([]);
  });

  it("every bespoke skeleton component marks its own root", () => {
    // The guard treats `<LoadingSkeleton` as a marker at the call site, so
    // that trust has to be earned at the definition. Without this, one of them
    // losing its attribute would turn four call sites silently green.
    const violations: string[] = [];
    for (const file of files) {
      const code = fs.readFileSync(file, "utf-8");
      // ANY `…Skeleton` component, not the one name. `ProjectTileSkeleton`
      // was unmarked and invisible to a check that only knew `LoadingSkeleton`
      // (Codex, PR #517).
      const DEF = /function\s+(\w*Skeleton)\s*\(/g;
      DEF.lastIndex = 0;
      let d: RegExpExecArray | null;
      while ((d = DEF.exec(code)) !== null) {
        const body = code.slice(d.index, d.index + 400);
        // `LOADING_ATTR` counts: `ui/skeleton.tsx` spreads the shared
        // constant rather than writing the attribute out.
        if (!/data-loading=|LOADING_ATTR/.test(body)) {
          violations.push(
            `${file} defines ${d[1]} whose root carries no \`data-loading\`, ` +
              `while the guard credits its callers for rendering it.`
          );
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("Skeleton itself carries the marker, since 24 components rely on it", () => {
    // Either spelling: the shared constant, or the attribute written out. The
    // contract is the attribute reaching the DOM, not which identifier
    // produced it (Copilot, PR #517).
    const code = fs.readFileSync("src/components/ui/skeleton.tsx", "utf-8");
    expect(code).toMatch(/LOADING_ATTR|data-loading/);
  });
});
