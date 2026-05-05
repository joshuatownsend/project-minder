import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import path from "path";
import os from "os";
import { promises as fs } from "fs";

// Facets tests use a temp dir as the home so we can control what's in
// ~/.claude/usage-data/facets/ without touching the real user data.

let tmpHome: string;

beforeEach(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "pm-facets-test-"));
  vi.spyOn(os, "homedir").mockReturnValue(tmpHome);
  // Pre-create the facets directory — production code does NOT create it.
  await fs.mkdir(path.join(tmpHome, ".claude", "usage-data", "facets"), { recursive: true });
  // Force module reload so claudeFacets reads the mocked homedir.
  vi.resetModules();
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.resetModules();
  try {
    await fs.rm(tmpHome, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

const FACETS_DIR_SUFFIX = [".claude", "usage-data", "facets"];

async function writeFacet(sessionId: string, data: object) {
  const dir = path.join(tmpHome, ...FACETS_DIR_SUFFIX);
  await fs.writeFile(path.join(dir, `${sessionId}.json`), JSON.stringify(data));
}

describe("getSessionFacets", () => {
  it("returns null for a session with no facets file", async () => {
    const { getSessionFacets } = await import("@/lib/scanner/claudeFacets");
    const result = await getSessionFacets("no-such-session");
    expect(result).toBeNull();
  });

  it("parses a well-formed facets file", async () => {
    await writeFacet("abc-123", {
      session_id: "abc-123",
      underlying_goal: "Fix a bug",
      outcome: "fully_achieved",
      claude_helpfulness: "essential",
    });
    const { getSessionFacets } = await import("@/lib/scanner/claudeFacets");
    const result = await getSessionFacets("abc-123");
    expect(result).not.toBeNull();
    expect(result!.underlying_goal).toBe("Fix a bug");
    expect(result!.outcome).toBe("fully_achieved");
  });

  it("throws on malformed JSON (not silent)", async () => {
    const dir = path.join(tmpHome, ...FACETS_DIR_SUFFIX);
    await fs.writeFile(path.join(dir, "bad-session.json"), "{not valid json");
    const { getSessionFacets } = await import("@/lib/scanner/claudeFacets");
    await expect(getSessionFacets("bad-session")).rejects.toThrow();
  });
});

describe("getFacetsAggregate", () => {
  it("returns zero counts when no sessions have facets", async () => {
    const { getFacetsAggregate } = await import("@/lib/scanner/claudeFacets");
    const agg = await getFacetsAggregate(["s1", "s2"]);
    expect(agg.sessionCount).toBe(0);
    expect(agg.outcomeCounts).toEqual({});
  });

  it("aggregates outcomes and helpfulness across sessions", async () => {
    await writeFacet("s1", {
      outcome: "fully_achieved",
      claude_helpfulness: "essential",
      user_satisfaction_counts: { likely_satisfied: 3 },
      friction_counts: { excessive_changes: 1 },
      session_type: "multi_task",
    });
    await writeFacet("s2", {
      outcome: "fully_achieved",
      claude_helpfulness: "helpful",
      user_satisfaction_counts: { likely_satisfied: 2 },
      session_type: "single_task",
    });
    await writeFacet("s3", {
      outcome: "partially_achieved",
      claude_helpfulness: "essential",
    });
    const { getFacetsAggregate } = await import("@/lib/scanner/claudeFacets");
    const agg = await getFacetsAggregate(["s1", "s2", "s3", "no-file"]);
    expect(agg.sessionCount).toBe(3);
    expect(agg.outcomeCounts["fully_achieved"]).toBe(2);
    expect(agg.outcomeCounts["partially_achieved"]).toBe(1);
    expect(agg.helpfulnessCounts["essential"]).toBe(2);
    expect(agg.helpfulnessCounts["helpful"]).toBe(1);
    expect(agg.satisfactionCounts["likely_satisfied"]).toBe(5);
    expect(agg.frictionCounts["excessive_changes"]).toBe(1);
    expect(agg.sessionTypeCounts["multi_task"]).toBe(1);
    expect(agg.sessionTypeCounts["single_task"]).toBe(1);
  });

  it("throws when any facets file is malformed", async () => {
    const dir = path.join(tmpHome, ...FACETS_DIR_SUFFIX);
    await fs.writeFile(path.join(dir, "broken.json"), "not json");
    const { getFacetsAggregate } = await import("@/lib/scanner/claudeFacets");
    await expect(getFacetsAggregate(["broken"])).rejects.toThrow();
  });
});
