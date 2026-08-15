/**
 * `GET /api/sessions/search` — the facet parameters (#425).
 *
 * The facets only fix anything if the route actually forwards them: they
 * exist so the retriever's `LIMIT` applies to the FACETED population, and a
 * facet dropped at the boundary silently restores the original bug — a
 * filtered search reporting zero for a filter that has matches.
 *
 * The validation half is deliberately asymmetric, and these tests pin the
 * asymmetry so it is not "tidied" into uniformity later:
 *
 *   - `source` / `entrypoint` accept any non-empty value. Both are OPEN
 *     sets that grow when an adapter or entrypoint is added, so an
 *     allowlist would reject a legitimate new value; an unrecognized one
 *     already yields an empty result that is *true*.
 *   - `starred` is a CLOSED two-value axis, so an unrecognized value there
 *     is meaningless and earns a 400 rather than a coercion. Reading
 *     `?starred=0` as "starred" would answer a different question silently.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const searchSessions = vi.fn();

vi.mock("@/lib/data", () => ({
  searchSessions: (...args: unknown[]) => searchSessions(...args),
}));

// The route also imports `SessionSearchError` from the search module
// directly, and that module reaches `db/connection` — which freezes
// `DB_DIR` to the real `~/.minder` at import time. `dbIsolationGuard`
// caught it (#331/#419), and mocking is the guard's own prescribed cut
// rather than an allowlist entry: these tests are pure request-parsing
// and need no database at all, so severing the edge is more honest than
// standing up an isolated state directory to justify reaching one.
//
// The error class must be REAL, not a stub — the route branches on
// `err instanceof SessionSearchError` to map `fts-parse` to a 400.
vi.mock("@/lib/data/sessionSearch", () => {
  class SessionSearchError extends Error {
    readonly reason: string;
    constructor(reason: string, message: string, cause?: unknown) {
      super(message, cause === undefined ? undefined : { cause });
      this.name = "SessionSearchError";
      this.reason = reason;
    }
  }
  return { SessionSearchError };
});

async function get(url: string) {
  const { GET } = await import("@/app/api/sessions/search/route");
  return GET(new NextRequest(url));
}

const BASE = "http://localhost:4100/api/sessions/search";

beforeEach(() => {
  vi.clearAllMocks();
  searchSessions.mockResolvedValue({ hits: [], meta: { backend: "db" } });
});

describe("GET /api/sessions/search — facets", () => {
  it("forwards all three facets to the data layer", async () => {
    const res = await get(`${BASE}?q=hello&source=codex&entrypoint=cli&starred=1`);
    expect(res.status).toBe(200);
    expect(searchSessions).toHaveBeenCalledWith("hello", "both", 50, {
      source: "codex",
      entrypoint: "cli",
      starredOnly: true,
    });
  });

  it("forwards an empty facet object when none are supplied", async () => {
    await get(`${BASE}?q=hello`);
    // Not `undefined` — but every axis unconstrained, which the data layer
    // treats identically. Pinned so a future "optimisation" that omits the
    // argument entirely still has to keep that equivalence.
    expect(searchSessions).toHaveBeenCalledWith("hello", "both", 50, {});
  });

  it("stores the TRIMMED facet value, not the raw one", async () => {
    // The bug this pins: validating `raw.trim()` for emptiness while
    // filtering on `raw` lets `?source=claude%20` pass validation and then
    // match nothing — a silent empty result from a request that looked
    // well-formed, which is the failure class this endpoint exists to fix.
    await get(`${BASE}?q=hello&source=${encodeURIComponent("claude ")}&entrypoint=${encodeURIComponent("  cli")}`);
    expect(searchSessions).toHaveBeenCalledWith("hello", "both", 50, {
      source: "claude",
      entrypoint: "cli",
    });
  });

  it("400s on an empty or whitespace-only source", async () => {
    for (const v of ["", "%20%20"]) {
      const res = await get(`${BASE}?q=hello&source=${v}`);
      expect(res.status).toBe(400);
      expect(searchSessions).not.toHaveBeenCalled();
    }
  });

  it("400s on an empty or whitespace-only entrypoint", async () => {
    for (const v of ["", "%09"]) {
      const res = await get(`${BASE}?q=hello&entrypoint=${v}`);
      expect(res.status).toBe(400);
      expect(searchSessions).not.toHaveBeenCalled();
    }
  });

  it("accepts any non-empty source or entrypoint — no allowlist", async () => {
    // An adapter or entrypoint added tomorrow must work without a code
    // change here. `zz-future-adapter` is not a real source, and returning
    // nothing for it is the honest answer.
    await get(`${BASE}?q=hello&source=zz-future-adapter&entrypoint=zz-future-entrypoint`);
    expect(searchSessions).toHaveBeenCalledWith("hello", "both", 50, {
      source: "zz-future-adapter",
      entrypoint: "zz-future-entrypoint",
    });
  });

  it("accepts starred=1 and starred=true, and 400s on anything else", async () => {
    for (const v of ["1", "true"]) {
      vi.clearAllMocks();
      searchSessions.mockResolvedValue({ hits: [], meta: { backend: "db" } });
      await get(`${BASE}?q=hello&starred=${v}`);
      expect(searchSessions).toHaveBeenCalledWith("hello", "both", 50, { starredOnly: true });
    }
    // "0" and "false" are the dangerous ones: coercing either to `true`
    // inverts the caller's request. "yes" stands in for the general
    // unrecognized case.
    for (const v of ["0", "false", "yes", ""]) {
      vi.clearAllMocks();
      const res = await get(`${BASE}?q=hello&starred=${v}`);
      expect(res.status).toBe(400);
      expect(searchSessions).not.toHaveBeenCalled();
    }
  });

  it("leaves starredOnly unset when starred is absent", async () => {
    await get(`${BASE}?q=hello&source=claude`);
    // Absent must not become `starredOnly: false` in a way that reads as a
    // deliberate "only unstarred" filter — the axis simply does not apply.
    expect(searchSessions).toHaveBeenCalledWith("hello", "both", 50, { source: "claude" });
  });
});
