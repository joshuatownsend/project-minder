/**
 * #395 — the tree roll-up, and the gate that keeps it honest.
 *
 * The behaviour under test is as much "when does this REFUSE to answer" as
 * "what does it add up". A roll-up that falls back to the root-only count when
 * it cannot see the tree is the original bug with a new field name on it, and
 * nothing downstream could tell the difference.
 */
import { describe, it, expect } from "vitest";
import {
  rollUpTreeDelegation,
  delegationUsageForSession,
  TREE_DELEGATION_MIN_DERIVED_VERSION as MIN_V,
  type DelegationTreeSource,
} from "@/lib/usage/delegationTree";

const ROOT = "root-1";
const KID_A = "kid-a";
const KID_B = "kid-b";

function source(over: Partial<DelegationTreeSource> = {}): DelegationTreeSource {
  return {
    derivedVersion: new Map([
      [ROOT, MIN_V],
      [KID_A, MIN_V],
      [KID_B, MIN_V],
    ]),
    childrenByParent: new Map([[ROOT, [KID_A, KID_B]]]),
    primaryTools: new Map([[ROOT, { Agent: 10, WebSearch: 4, Read: 99 }]]),
    sidechainTools: new Map<string, Record<string, number>>([
      [KID_A, { Agent: 3, WebSearch: 20 }],
      [KID_B, { WebSearch: 7 }],
    ]),
    ...over,
  };
}

describe("rollUpTreeDelegation", () => {
  it("sums the root's own calls with every child transcript's", () => {
    const got = rollUpTreeDelegation(ROOT, source());
    // 10 root + 3 in kid-a; the whole point is that the nested 3 were
    // previously invisible to the cap comparison.
    expect(got).toEqual({ spawns: 13, webSearches: 31, sessionCount: 3 });
  });

  it("includes sidechain calls recorded against the root itself", () => {
    // The legacy transcript layout inlines a subagent's turns into the parent
    // file, where they land as sidechain turns of the root. Same sum, no second
    // code path — and a corpus with only the modern layout simply contributes 0
    // from this term.
    const got = rollUpTreeDelegation(
      ROOT,
      source({
        childrenByParent: new Map(),
        sidechainTools: new Map([[ROOT, { Agent: 5, WebSearch: 2 }]]),
      })
    );
    expect(got).toEqual({ spawns: 15, webSearches: 6, sessionCount: 1 });
  });

  it("counts `Task` as a spawn and does NOT count `WebFetch` as a search", () => {
    // Two separate decisions, pinned together because both are about the tool
    // NAME set rather than the tree. `Task` is the documented spelling and
    // appears in older transcripts; `WebFetch` is deliberately excluded so this
    // change moves the tree dimension only — see `WEB_SEARCH_TOOL_NAMES`.
    const got = rollUpTreeDelegation(
      ROOT,
      source({
        childrenByParent: new Map(),
        primaryTools: new Map([[ROOT, { Task: 6, WebFetch: 40, WebSearch: 1 }]]),
        sidechainTools: new Map(),
      })
    );
    expect(got).toEqual({ spawns: 6, webSearches: 1, sessionCount: 1 });
  });

  it("returns undefined when the root session predates the derivation", () => {
    const got = rollUpTreeDelegation(
      ROOT,
      source({
        derivedVersion: new Map([
          [ROOT, MIN_V - 1],
          [KID_A, MIN_V],
          [KID_B, MIN_V],
        ]),
      })
    );
    expect(got).toBeUndefined();
  });

  it("returns undefined when even one child is stale", () => {
    // The sharpest case. A stale child still contributes its (empty) counts, so
    // a roll-up that ignored the version would return a number that looks
    // complete and is short by that branch. Undefined is the only honest answer.
    const got = rollUpTreeDelegation(
      ROOT,
      source({
        derivedVersion: new Map([
          [ROOT, MIN_V],
          [KID_A, MIN_V],
          [KID_B, MIN_V - 1],
        ]),
      })
    );
    expect(got).toBeUndefined();
  });

  it("returns undefined for a session absent from the version map", () => {
    expect(rollUpTreeDelegation("nobody", source())).toBeUndefined();
  });

  it("accepts a version ahead of the minimum", () => {
    // `>=`, never `===`: an unrelated DERIVED_VERSION bump must not make every
    // session read as unmeasured, and a non-directional comparison is what once
    // let an older build refresh newer rows backwards.
    const got = rollUpTreeDelegation(
      ROOT,
      source({
        derivedVersion: new Map([
          [ROOT, MIN_V + 7],
          [KID_A, MIN_V + 7],
          [KID_B, MIN_V + 7],
        ]),
      })
    );
    expect(got?.spawns).toBe(13);
  });

  it("reports zeroes rather than undefined for a re-derived session with no delegation", () => {
    // Measured zero and unmeasured are different claims; only the first should
    // let the badge logic run.
    const got = rollUpTreeDelegation(
      ROOT,
      source({
        childrenByParent: new Map(),
        primaryTools: new Map(),
        sidechainTools: new Map(),
      })
    );
    expect(got).toEqual({ spawns: 0, webSearches: 0, sessionCount: 1 });
  });
});

describe("delegationUsageForSession", () => {
  const TREE = { spawns: 190, webSearches: 12, sessionCount: 4 };

  it("feeds the cap comparison the TREE totals, not the root-only counts", () => {
    // The regression this exists to catch: `spawns: session.subagentCount`
    // looks right, type-checks, renders, and silently restores the root-only
    // comparison #395 removed. The call site is an untested component, so
    // without this assertion nothing would fail.
    expect(
      delegationUsageForSession({
        cliVersion: "2.1.220",
        treeDelegation: TREE,
        // Deliberately present and deliberately different: a reversion to
        // either of these fields produces the wrong number here.
        ...({ subagentCount: 3, toolUsage: { WebSearch: 1 } } as object),
      })
    ).toEqual({ spawns: 190, webSearches: 12, cliVersion: "2.1.220" });
  });

  it("passes undefined counts through when the tree is unmeasured", () => {
    // Not zero, and not a fallback — `assessDelegation` reports the caps as
    // unmeasured, which is the whole contract.
    expect(delegationUsageForSession({ cliVersion: "2.1.220" })).toEqual({
      spawns: undefined,
      webSearches: undefined,
      cliVersion: "2.1.220",
    });
  });

  it("suppresses everything for a non-Claude session", () => {
    // Codex and Gemini sessions run under no such caps; a tool named `Agent`
    // in their transcripts must not produce a Claude Code cap warning.
    expect(
      delegationUsageForSession({ source: "codex", cliVersion: "2.1.220", treeDelegation: TREE })
    ).toEqual({});
  });

  it("treats a missing source as Claude", () => {
    expect(
      delegationUsageForSession({ cliVersion: "2.1.220", treeDelegation: TREE }).spawns
    ).toBe(190);
  });
});
