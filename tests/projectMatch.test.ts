import { describe, it, expect } from "vitest";
import {
  encodeProjectPath,
  gatherProjectTurns,
  buildProjectTurnsIndex,
  lookupProjectTurns,
  resolveUsageHomeKey,
} from "@/lib/usage/projectMatch";
import { normalizePathKey } from "@/lib/platform";
import type { UsageTurn } from "@/lib/usage/types";
import type { PathMapping } from "@/lib/types";

function makeTurn(sessionId: string, projectSlug: string, projectDirName: string): UsageTurn {
  return {
    timestamp: "2024-01-01T00:00:00.000Z",
    sessionId,
    projectSlug,
    projectDirName,
    model: "claude-opus-4-5",
    role: "assistant",
    inputTokens: 0,
    outputTokens: 0,
    cacheCreateTokens: 0,
    cacheReadTokens: 0,
    toolCalls: [],
  };
}

describe("encodeProjectPath", () => {
  it("encodes a Windows path with colons and backslashes (dots preserved)", () => {
    expect(encodeProjectPath("C:\\dev\\my.project")).toBe("C--dev-my.project");
  });

  it("encodes a POSIX path (slashes become dashes, dots preserved)", () => {
    expect(encodeProjectPath("/home/user/my.proj")).toBe("-home-user-my.proj");
  });

  it("leaves a plain slug-like string unchanged", () => {
    expect(encodeProjectPath("project-minder")).toBe("project-minder");
  });

  it("encodes the full Windows dev path pattern used by Claude Code", () => {
    expect(encodeProjectPath("C:\\dev\\project-minder")).toBe("C--dev-project-minder");
  });
});

describe("resolveUsageHomeKey (#311)", () => {
  const UNC_PROJECT = "\\\\wsl.localhost\\Ubuntu\\home\\me\\dev\\app";
  const MAPPING: PathMapping = {
    from: "/home/me",
    to: "\\\\wsl.localhost\\Ubuntu\\home\\me",
  };
  const WSL_HOME = "\\\\wsl.localhost\\Ubuntu\\home\\me\\.claude";
  const LOCAL_HOME = "C:\\Users\\Me\\.claude";

  it("pins a mapped project to the home under the mapping's `to` prefix", () => {
    const key = resolveUsageHomeKey(UNC_PROJECT, [MAPPING], [LOCAL_HOME, WSL_HOME]);
    expect(key).toBe(normalizePathKey(WSL_HOME));
  });

  it("returns undefined for an unmapped local project — no home pin, no filter", () => {
    expect(resolveUsageHomeKey("C:\\dev\\app", [MAPPING], [LOCAL_HOME, WSL_HOME])).toBeUndefined();
    expect(resolveUsageHomeKey("C:\\dev\\app", [], [LOCAL_HOME])).toBeUndefined();
  });

  it("returns undefined when the mapping applies but no configured home matches", () => {
    expect(resolveUsageHomeKey(UNC_PROJECT, [MAPPING], [LOCAL_HOME])).toBeUndefined();
    expect(resolveUsageHomeKey(UNC_PROJECT, [MAPPING], [])).toBeUndefined();
  });

  it("pins to the home of the FIRST mapping that rewrites the path (mapLocalPath is first-match-wins)", () => {
    const otherMapping: PathMapping = {
      from: "/home/other",
      to: "\\\\wsl.localhost\\Debian\\home\\other",
    };
    const debianHome = "\\\\wsl.localhost\\Debian\\home\\other\\.claude";
    const key = resolveUsageHomeKey(
      UNC_PROJECT,
      [otherMapping, MAPPING],
      [debianHome, WSL_HOME]
    );
    expect(key).toBe(normalizePathKey(WSL_HOME));
  });
});

describe("gatherProjectTurns", () => {
  it("matches sessions by exact slug", () => {
    const map = new Map([
      ["s1", [makeTurn("s1", "my-app", "C--dev-my-app")]],
    ]);
    const turns = gatherProjectTurns(map, "my-app", "C:\\dev\\other");
    expect(turns).toHaveLength(1);
  });

  it("matches sessions by exact encoded dirname", () => {
    const map = new Map([
      ["s1", [makeTurn("s1", "some-other-slug", "C--dev-my-app")]],
    ]);
    const turns = gatherProjectTurns(map, "my-app", "C:\\dev\\my-app");
    expect(turns).toHaveLength(1);
  });

  it("does NOT match on slug substring — api does not pull my-api-server", () => {
    const map = new Map([
      ["s1", [makeTurn("s1", "my-api-server", "C--dev-my-api-server")]],
    ]);
    const turns = gatherProjectTurns(map, "api", "C:\\dev\\api");
    expect(turns).toHaveLength(0);
  });

  it("returns all turns from a matching session", () => {
    const turns = [
      makeTurn("s1", "proj", "C--dev-proj"),
      makeTurn("s1", "proj", "C--dev-proj"),
      makeTurn("s1", "proj", "C--dev-proj"),
    ];
    const map = new Map([["s1", turns]]);
    const result = gatherProjectTurns(map, "proj", "C:\\dev\\proj");
    expect(result).toHaveLength(3);
  });

  it("skips sessions that belong to a different project", () => {
    const map = new Map([
      ["s1", [makeTurn("s1", "proj-a", "C--dev-proj-a")]],
      ["s2", [makeTurn("s2", "proj-b", "C--dev-proj-b")]],
    ]);
    const result = gatherProjectTurns(map, "proj-a", "C:\\dev\\proj-a");
    expect(result).toHaveLength(1);
    expect(result[0].sessionId).toBe("s1");
  });

  it("returns empty array for an empty session map", () => {
    const result = gatherProjectTurns(new Map(), "proj", "C:\\dev\\proj");
    expect(result).toHaveLength(0);
  });

  it("skips sessions with no turns", () => {
    const map = new Map([["s1", []]]);
    const result = gatherProjectTurns(map, "proj", "C:\\dev\\proj");
    expect(result).toHaveLength(0);
  });
});

describe("buildProjectTurnsIndex + lookupProjectTurns", () => {
  it("matches sessions by exact slug (same as gatherProjectTurns)", () => {
    const map = new Map([
      ["s1", [makeTurn("s1", "my-app", "C--dev-my-app")]],
    ]);
    const index = buildProjectTurnsIndex(map);
    const turns = lookupProjectTurns(index, "my-app", "C:\\dev\\other");
    expect(turns).toHaveLength(1);
  });

  it("matches sessions by exact encoded dirname", () => {
    const map = new Map([
      ["s1", [makeTurn("s1", "some-other-slug", "C--dev-my-app")]],
    ]);
    const index = buildProjectTurnsIndex(map);
    const turns = lookupProjectTurns(index, "my-app", "C:\\dev\\my-app");
    expect(turns).toHaveLength(1);
  });

  it("does NOT match on slug substring", () => {
    const map = new Map([
      ["s1", [makeTurn("s1", "my-api-server", "C--dev-my-api-server")]],
    ]);
    const index = buildProjectTurnsIndex(map);
    const turns = lookupProjectTurns(index, "api", "C:\\dev\\api");
    expect(turns).toHaveLength(0);
  });

  it("does not double-count a session that matches both slug AND dirname", () => {
    const map = new Map([
      ["s1", [makeTurn("s1", "proj", "C--dev-proj"), makeTurn("s1", "proj", "C--dev-proj")]],
    ]);
    const index = buildProjectTurnsIndex(map);
    // Both the slug key ("proj") and the dirname key ("C--dev-proj") resolve
    // to the same single session — it must only be counted once.
    const turns = lookupProjectTurns(index, "proj", "C:\\dev\\proj");
    expect(turns).toHaveLength(2); // 2 turns from the one matching session, not 4
  });

  it("preserves original session-map iteration order across multiple matching sessions", () => {
    const map = new Map([
      ["s1", [makeTurn("s1", "proj", "C--dev-proj")]],
      ["other", [makeTurn("other", "unrelated", "C--dev-unrelated")]],
      ["s2", [makeTurn("s2", "proj", "C--dev-proj")]],
    ]);
    const index = buildProjectTurnsIndex(map);
    const turns = lookupProjectTurns(index, "proj", "C:\\dev\\proj");
    expect(turns.map((t) => t.sessionId)).toEqual(["s1", "s2"]);
  });

  it("returns empty for a project with no matching sessions", () => {
    const map = new Map([
      ["s1", [makeTurn("s1", "proj-a", "C--dev-proj-a")]],
    ]);
    const index = buildProjectTurnsIndex(map);
    const turns = lookupProjectTurns(index, "proj-z", "C:\\dev\\proj-z");
    expect(turns).toHaveLength(0);
  });

  it("skips sessions with no turns when building the index", () => {
    const map = new Map([["s1", []]]);
    const index = buildProjectTurnsIndex(map);
    const turns = lookupProjectTurns(index, "proj", "C:\\dev\\proj");
    expect(turns).toHaveLength(0);
  });

  it("produces identical results to gatherProjectTurns across a realistic multi-project map", () => {
    const map = new Map([
      ["s1", [makeTurn("s1", "alpha", "C--dev-alpha")]],
      ["s2", [makeTurn("s2", "beta", "C--dev-beta"), makeTurn("s2", "beta", "C--dev-beta")]],
      ["s3", [makeTurn("s3", "renamed-slug", "C--dev-gamma")]], // matches gamma only by dirname
      ["s4", [] as UsageTurn[]],
      ["s5", [makeTurn("s5", "alpha", "C--dev-alpha-worktree")]], // different dirname, same slug
    ]);
    const index = buildProjectTurnsIndex(map);

    const projects: Array<{ slug: string; path: string }> = [
      { slug: "alpha", path: "C:\\dev\\alpha" },
      { slug: "beta", path: "C:\\dev\\beta" },
      { slug: "gamma", path: "C:\\dev\\gamma" },
      { slug: "does-not-exist", path: "C:\\dev\\does-not-exist" },
    ];

    for (const p of projects) {
      const viaIndex = lookupProjectTurns(index, p.slug, p.path);
      const viaScan = gatherProjectTurns(map, p.slug, p.path);
      expect(viaIndex.map((t) => t.sessionId)).toEqual(viaScan.map((t) => t.sessionId));
      expect(viaIndex).toHaveLength(viaScan.length);
    }
  });
});
