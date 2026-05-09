import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("fs", () => ({
  promises: {
    stat: vi.fn(),
    readFile: vi.fn(),
    readdir: vi.fn(),
  },
}));

import { promises as fs } from "fs";
import { scanGsdPlanning, applyStateOverrides } from "@/lib/scanner/gsdPlanning";
import type { GsdPhaseEntry } from "@/lib/types";

// Use any-cast shims so TypeScript overload resolution doesn't fight us on
// fs.readFile (returns string | Buffer union) and fs.readdir (returns Dirent[]).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockStat = fs.stat as unknown as { mockImplementation: (fn: any) => void; mockRejectedValue: (v: any) => void };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockReadFile = fs.readFile as unknown as { mockImplementation: (fn: any) => void; mockRejectedValue: (v: any) => void };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockReaddir = fs.readdir as unknown as { mockResolvedValue: (v: any) => void; mockRejectedValue: (v: any) => void };

beforeEach(() => vi.clearAllMocks());

const PROJECT_PATH = "/home/dev/my-project";

function stubPlanningDir() {
  mockStat.mockImplementation(async (p: unknown) => {
    if (String(p).includes(".planning")) return { isDirectory: () => true };
    throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  });
}

function stubReadFile(handler: (p: string) => string | null) {
  mockReadFile.mockImplementation(async (p: unknown) => {
    const result = handler(String(p));
    if (result === null) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    return result;
  });
}

function stubReaddir(files: string[]) {
  mockReaddir.mockResolvedValue(files);
}

// ── Gate: no .planning/ dir ──────────────────────────────────────────────────

describe("scanGsdPlanning", () => {
  it("returns undefined when .planning/ does not exist", async () => {
    mockStat.mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
    const result = await scanGsdPlanning(PROJECT_PATH);
    expect(result).toBeUndefined();
  });

  it("returns undefined when .planning/ stat is not a directory", async () => {
    mockStat.mockImplementation(async () => ({ isDirectory: () => false }));
    const result = await scanGsdPlanning(PROJECT_PATH);
    expect(result).toBeUndefined();
  });

  // ── Minimal: phases from ROADMAP.md only ────────────────────────────────

  it("uses ROADMAP.md checkbox count when no phases/ dir", async () => {
    stubPlanningDir();
    stubReadFile((p) => {
      if (p.includes("ROADMAP.md")) return "- [x] Phase 1\n- [x] Phase 2\n- [ ] Phase 3\n";
      return null;
    });
    mockReaddir.mockRejectedValue(new Error("ENOENT"));

    const result = await scanGsdPlanning(PROJECT_PATH);
    expect(result).toBeDefined();
    expect(result!.completedPhases).toBe(2);
    expect(result!.totalPhases).toBe(3);
    expect(result!.phases).toHaveLength(0);
  });

  // ── Full fixture: PROJECT.md + STATE.md + phases/ ───────────────────────

  it("parses PROJECT.md name and description", async () => {
    stubPlanningDir();
    stubReadFile((p) => {
      if (p.includes("PROJECT.md")) return "# My Cool Project\n\nBest project ever.\n";
      if (p.includes("ROADMAP.md")) return "- [x] Phase 1\n- [ ] Phase 2\n";
      if (p.includes("STATE.md")) return "";
      return null;
    });
    stubReaddir([]);

    const result = await scanGsdPlanning(PROJECT_PATH);
    expect(result!.projectName).toBe("My Cool Project");
    expect(result!.description).toBe("Best project ever.");
  });

  it("parses phases from phases/*.md sorted by leading number", async () => {
    stubPlanningDir();
    stubReadFile((p) => {
      if (p.includes("PROJECT.md")) return "# Test\n";
      if (p.includes("ROADMAP.md")) return "";
      if (p.includes("STATE.md")) return "";
      if (p.includes("2-build-PLAN.md")) return "# Build Phase\nToken budget: 50000\n";
      if (p.includes("1-design-PLAN.md")) return "# Design Phase\nToken budget: 20000\n";
      return null;
    });
    stubReaddir(["2-build-PLAN.md", "1-design-PLAN.md"]);

    const result = await scanGsdPlanning(PROJECT_PATH);
    expect(result!.phases).toHaveLength(2);
    expect(result!.phases[0].number).toBe(1);
    expect(result!.phases[0].name).toBe("Design Phase");
    expect(result!.phases[0].tokenBudget).toBe(20000);
    expect(result!.phases[1].number).toBe(2);
    expect(result!.phases[1].name).toBe("Build Phase");
    expect(result!.phases[1].tokenBudget).toBe(50000);
  });

  it("applies STATE.md status and timing overrides to phases", async () => {
    const stateYaml = [
      "---",
      "projectName: Override Name",
      "status: in-progress",
      "milestone: Wave 11",
      "phases:",
      "  - number: 1",
      "    status: completed",
      '    startedAt: "2026-01-01T00:00:00Z"',
      '    endedAt: "2026-01-02T00:00:00Z"',
      "  - number: 2",
      "    status: in-progress",
      "---",
    ].join("\n");

    stubPlanningDir();
    stubReadFile((p) => {
      if (p.includes("PROJECT.md")) return "# Test\n";
      if (p.includes("ROADMAP.md")) return "";
      if (p.includes("STATE.md")) return stateYaml;
      if (p.includes("1-design-PLAN.md")) return "# Design Phase\n";
      if (p.includes("2-build-PLAN.md")) return "# Build Phase\n";
      return null;
    });
    stubReaddir(["1-design-PLAN.md", "2-build-PLAN.md"]);

    const result = await scanGsdPlanning(PROJECT_PATH);
    // PROJECT.md heading ("Test") takes priority over STATE.md projectName
    expect(result!.projectName).toBe("Test");
    expect(result!.status).toBe("in-progress");
    expect(result!.milestone).toBe("Wave 11");
    expect(result!.completedPhases).toBe(1);
    expect(result!.totalPhases).toBe(2);

    const phase1 = result!.phases[0];
    expect(phase1.status).toBe("completed");
    expect(phase1.startedAt).toBe("2026-01-01T00:00:00Z");
    expect(phase1.endedAt).toBe("2026-01-02T00:00:00Z");

    const phase2 = result!.phases[1];
    expect(phase2.status).toBe("in-progress");
    expect(phase2.startedAt).toBeUndefined();
    expect(phase2.endedAt).toBeUndefined();
  });

  it("returns undefined when totalPhases is 0", async () => {
    stubPlanningDir();
    mockReadFile.mockRejectedValue(new Error("ENOENT"));
    mockReaddir.mockRejectedValue(new Error("ENOENT"));

    const result = await scanGsdPlanning(PROJECT_PATH);
    expect(result).toBeUndefined();
  });

  it("malformed STATE.md YAML does not throw and still returns phases", async () => {
    stubPlanningDir();
    stubReadFile((p) => {
      if (p.includes("PROJECT.md")) return "# Test\n";
      if (p.includes("ROADMAP.md")) return "";
      if (p.includes("STATE.md")) return "---\n: bad: yaml: [\n---\n";
      if (p.includes("1-phase-PLAN.md")) return "# Phase One\n";
      return null;
    });
    stubReaddir(["1-phase-PLAN.md"]);

    const result = await scanGsdPlanning(PROJECT_PATH);
    expect(result).toBeDefined();
    expect(result!.phases).toHaveLength(1);
    expect(result!.phases[0].status).toBe("pending");
    expect(result!.phases[0].startedAt).toBeUndefined();
  });

  // ── No mtime fallback guarantee ──────────────────────────────────────────

  it("phases without STATE.md timestamps have undefined startedAt/endedAt", async () => {
    const stateYaml = "---\nphases:\n  - number: 1\n    status: completed\n---\n";

    stubPlanningDir();
    stubReadFile((p) => {
      if (p.includes("PROJECT.md")) return "# Test\n";
      if (p.includes("ROADMAP.md")) return "";
      if (p.includes("STATE.md")) return stateYaml;
      if (p.includes("1-phase-PLAN.md")) return "# Phase One\n";
      return null;
    });
    stubReaddir(["1-phase-PLAN.md"]);

    const result = await scanGsdPlanning(PROJECT_PATH);
    expect(result!.phases[0].startedAt).toBeUndefined();
    expect(result!.phases[0].endedAt).toBeUndefined();
  });
});

// ── applyStateOverrides unit tests ───────────────────────────────────────────

describe("applyStateOverrides", () => {
  it("merges status and timing from state", () => {
    const phases: GsdPhaseEntry[] = [
      { number: 1, name: "A", file: "1-a.md", status: "pending" },
      { number: 2, name: "B", file: "2-b.md", status: "pending" },
    ];
    const stateInfo = {
      phaseTiming: new Map([
        [1, { startedAt: "2026-01-01T00:00:00Z", endedAt: "2026-01-02T00:00:00Z" }],
      ]),
      phaseStatuses: new Map<number, GsdPhaseEntry["status"]>([
        [1, "completed"],
        [2, "in-progress"],
      ]),
    };
    const result = applyStateOverrides(phases, stateInfo);
    expect(result[0].status).toBe("completed");
    expect(result[0].startedAt).toBe("2026-01-01T00:00:00Z");
    expect(result[0].endedAt).toBe("2026-01-02T00:00:00Z");
    expect(result[1].status).toBe("in-progress");
    expect(result[1].startedAt).toBeUndefined();
    expect(result[1].endedAt).toBeUndefined();
  });

  it("preserves original status when stateInfo has no override", () => {
    const phases: GsdPhaseEntry[] = [
      { number: 1, name: "A", file: "1-a.md", status: "in-progress" },
    ];
    const stateInfo = {
      phaseTiming: new Map<number, { startedAt?: string; endedAt?: string }>(),
      phaseStatuses: new Map<number, GsdPhaseEntry["status"]>(),
    };
    const result = applyStateOverrides(phases, stateInfo);
    expect(result[0].status).toBe("in-progress");
  });
});
