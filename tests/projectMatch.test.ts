import { describe, it, expect } from "vitest";
import { encodeProjectPath, gatherProjectTurns } from "@/lib/usage/projectMatch";
import type { UsageTurn } from "@/lib/usage/types";

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
