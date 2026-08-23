import { describe, it, expect } from "vitest";
import { isValidSessionId, looksLikeSessionId } from "@/lib/sessionId";

/**
 * The two session-id predicates (#483).
 *
 * These were one regex literal copied across seven sites, answering two
 * different questions. They agreed with each other perfectly, which is exactly
 * why nobody noticed that both answers had gone wrong for `agent-<hex>`
 * subagent ids — measured at 1,268 of 6,656 sessions (19%) listed and
 * unopenable on a real index.
 *
 * So the point of these cases is not that the regexes match some strings. It is
 * that the two predicates are allowed to DISAGREE, and that each enforces the
 * property it actually exists for.
 */
describe("isValidSessionId — path-traversal guard", () => {
  it("accepts the subagent id shape that broke every gate", () => {
    // The regression. `agent-a38db58938dbeea68` is a real id from the index
    // that motivated #483; `g`, `n` and `t` are not in `[a-f0-9-]`.
    expect(isValidSessionId("agent-a38db58938dbeea68")).toBe(true);
  });

  it("still accepts ordinary hex session ids", () => {
    expect(isValidSessionId("3f2a1b44-dead-beef-cafe-000000000001")).toBe(true);
    expect(isValidSessionId("3f2a1b-44")).toBe(true);
  });

  it("rejects every form of path syntax", () => {
    // The property this predicate exists for, and the one that must survive
    // widening it. No `.` at all means `..` is unreachable by construction
    // rather than by a special case.
    for (const bad of [
      "..",
      "../etc/passwd",
      "..\\..\\windows",
      "a/b",
      "a\\b",
      "a.b",
      "C:file",
      "with space",
      "",
      "nul\0byte",
    ]) {
      expect(isValidSessionId(bad), `should reject ${JSON.stringify(bad)}`).toBe(false);
    }
  });
});

describe("looksLikeSessionId — id-vs-slug discriminator", () => {
  it("accepts both id shapes", () => {
    expect(looksLikeSessionId("agent-a38db58938dbeea68")).toBe(true);
    expect(looksLikeSessionId("3f2a1b44-dead-beef")).toBe(true);
  });

  it("still routes word slugs to slug resolution", () => {
    // The reason this could not simply reuse `isValidSessionId`. Widened to the
    // path-safe allowlist, every one of these would read as a session id and
    // `resolveSlugToSessionId` would never run — so `getSessionDetail` would
    // stop accepting slugs entirely.
    for (const slug of [
      "temporal-crane",
      "i-recently-read-this",
      "quiet-harbor-42",
      "agent-crane-temporal",
    ]) {
      expect(looksLikeSessionId(slug), `should treat ${slug} as a slug`).toBe(false);
    }
  });

  it("is deliberately narrower than the traversal guard", () => {
    // Pins the disagreement itself. If a later refactor collapses these two
    // predicates into one, this fails whichever direction it collapses in.
    expect(isValidSessionId("temporal-crane")).toBe(true);
    expect(looksLikeSessionId("temporal-crane")).toBe(false);
  });

  it("cannot separate an agent-prefixed slug from an id, and says so", () => {
    // The collision Copilot found on PR #484, pinned as a KNOWN LIMIT of this
    // predicate rather than papered over. `agent-cafe-deed` is a legitimate
    // slug whose remainder is hex-and-dash, so shape alone reads it as an id.
    //
    // Tightening the pattern only moves the boundary — it would be another
    // guess about id content. The real fix is in `getSessionDetail`, which asks
    // the index first and only falls back to this test; see
    // `dataSessionDetail.test.ts` for the case that pins it.
    expect(looksLikeSessionId("agent-cafe-deed")).toBe(true);
    // Same shape, same limit, pre-dating the `agent-` prefix entirely.
    expect(looksLikeSessionId("cafe-faded-deed")).toBe(true);
  });
});
