import { describe, it, expect, vi } from "vitest";

// Sever the static chain to `src/lib/db/connection.ts` (the DB isolation
// convention, `tests/dbIsolationGuard.test.ts`): only the pure filter is
// under test, and the loader behind it must never touch the real ~/.minder.
vi.mock("@/lib/data", () => ({ getSessionsList: vi.fn() }));

import { filterSessions } from "@/lib/server/queries/sessions";
import type { SessionSummary } from "@/lib/types";

/**
 * `&home=` on `/api/sessions`: two checkouts with the same Linux path layout
 * in different WSL distros encode to the same `projectName`, so the dir-name
 * filter alone lists both locations' sessions on each. The home key is what
 * tells them apart (Codex on #554).
 */
function session(over: Partial<SessionSummary>): SessionSummary {
  return {
    sessionId: "s",
    projectPath: "/home/me/dev/foo",
    projectSlug: "home-me-dev-foo",
    projectName: "-home-me-dev-foo",
    messageCount: 1,
    userMessageCount: 1,
    assistantMessageCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreateTokens: 0,
    costEstimate: 0,
    toolUsage: {},
    modelsUsed: [],
    subagentCount: 0,
    errorCount: 0,
    isActive: false,
    status: "idle",
    skillsUsed: {},
    ...over,
  };
}

const UBUNTU = "//wsl.localhost/ubuntu/home/me/.claude";
const DEBIAN = "//wsl.localhost/debian/home/me/.claude";
const enabledAdapters = new Set(["claude", "codex"]);

const inUbuntu = session({ sessionId: "u", homeKey: UBUNTU });
const inDebian = session({ sessionId: "d", homeKey: DEBIAN });
const unkeyed = session({ sessionId: "x", source: "codex" });

describe("filterSessions home", () => {
  it("keeps only the sessions read from that home, by strict key equality", () => {
    const out = filterSessions([inUbuntu, inDebian, unkeyed], {
      enabledAdapters,
      project: "-home-me-dev-foo",
      home: UBUNTU,
    });
    expect(out.map((s) => s.sessionId)).toEqual(["u"]);
  });

  it("matches a project key written with a trailing separator to the session's separator-free key", () => {
    // A `claudeHomes` entry written with a trailing separator keys the project WITH the
    // trailing separator; `sessionFileHomeKey` never carries one (Codex on #556).
    expect(filterSessions([inUbuntu], { enabledAdapters, home: UBUNTU + "/" }).map((s) => s.sessionId)).toEqual(["u"]);
    expect(filterSessions([inUbuntu], { enabledAdapters, home: UBUNTU + "\\" }).map((s) => s.sessionId)).toEqual(["u"]);
    expect(filterSessions([inUbuntu], { enabledAdapters, home: DEBIAN + "/" })).toEqual([]);
  });

  it("never matches a session without a home key (adapter sources)", () => {
    expect(filterSessions([unkeyed], { enabledAdapters, home: UBUNTU })).toEqual([]);
  });

  it("is a no-op when no home is asked for, so unpinned locations list every home", () => {
    const out = filterSessions([inUbuntu, inDebian, unkeyed], { enabledAdapters, project: "-home-me-dev-foo" });
    expect(out).toHaveLength(3);
    expect(filterSessions([inUbuntu], { enabledAdapters, home: null })).toHaveLength(1);
  });
});
