import { describe, it, expect } from "vitest";
import { scoreTriage, MODERATE_THRESHOLDS } from "@/lib/memory/triageScorer";
import type { MemoryFileEntry, MemoryScope } from "@/lib/types";

const NOW = Date.parse("2026-05-12T00:00:00Z");
const DAY = 24 * 60 * 60_000;

function entry(opts: Partial<MemoryFileEntry> & { displayName: string; absPath: string }): MemoryFileEntry {
  return {
    id: opts.id ?? Buffer.from(opts.absPath).toString("base64url"),
    scope: (opts.scope ?? "auto") as MemoryScope,
    projectSlug: opts.projectSlug ?? "alpha",
    projectName: opts.projectName ?? "Alpha",
    absPath: opts.absPath,
    displayName: opts.displayName,
    mtimeMs: opts.mtimeMs ?? NOW - 10 * DAY,
    sizeBytes: opts.sizeBytes ?? 1024,
    preview: opts.preview ?? "preview body",
    stale: opts.stale ?? { ageOver30d: false, brokenImports: [], brokenRefs: [] },
    indexed: opts.indexed,
    usage: opts.usage,
  };
}

describe("scoreTriage", () => {
  it("returns empty report when there are no entries", () => {
    const r = scoreTriage({ entries: [], suppressUntil: {}, now: NOW });
    expect(r.candidates).toEqual([]);
    expect(r.suppressed).toEqual([]);
    expect(r.total).toBe(0);
    expect(r.bytesRecoverable).toBe(0);
  });

  it("ignores non-auto scopes (user/project CLAUDE.md are not move/delete targets)", () => {
    const r = scoreTriage({
      entries: [
        entry({ displayName: "User CLAUDE.md", absPath: "/u/CLAUDE.md", scope: "user", mtimeMs: NOW - 365 * DAY }),
        entry({ displayName: "CLAUDE.md", absPath: "/p/CLAUDE.md", scope: "project", mtimeMs: NOW - 365 * DAY }),
      ],
      suppressUntil: {},
      now: NOW,
    });
    expect(r.total).toBe(0);
    expect(r.candidates).toEqual([]);
  });

  it("ignores MEMORY.md (the index file itself is not a triage target)", () => {
    const r = scoreTriage({
      entries: [
        entry({ displayName: "MEMORY.md", absPath: "/m/MEMORY.md", mtimeMs: NOW - 365 * DAY }),
      ],
      suppressUntil: {},
      now: NOW,
    });
    expect(r.total).toBe(0);
  });

  it("keeps a fresh, recently-read entry", () => {
    const r = scoreTriage({
      entries: [
        entry({
          displayName: "user_role.md",
          absPath: "/m/user_role.md",
          mtimeMs: NOW - 5 * DAY,
          usage: { readCount: 4, lastReadAt: new Date(NOW - 2 * DAY).toISOString() },
        }),
      ],
      suppressUntil: {},
      now: NOW,
    });
    expect(r.total).toBe(1);
    expect(r.candidates).toEqual([]);
  });

  it("recommends archive when never read AND age exceeds threshold", () => {
    const r = scoreTriage({
      entries: [
        entry({
          displayName: "stale.md",
          absPath: "/m/stale.md",
          mtimeMs: NOW - 70 * DAY,
        }),
      ],
      suppressUntil: {},
      now: NOW,
    });
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0].recommendation).toBe("archive");
    expect(r.candidates[0].reasons).toContain("Never read");
    expect(r.candidates[0].reasons).toEqual(expect.arrayContaining([expect.stringMatching(/^Age \d+d$/)]));
  });

  it("recommends archive when last read older than the stale-read threshold", () => {
    const r = scoreTriage({
      entries: [
        entry({
          displayName: "rusty.md",
          absPath: "/m/rusty.md",
          mtimeMs: NOW - 10 * DAY,
          usage: { readCount: 3, lastReadAt: new Date(NOW - 100 * DAY).toISOString() },
        }),
      ],
      suppressUntil: {},
      now: NOW,
    });
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0].recommendation).toBe("archive");
    expect(r.candidates[0].reasons[0]).toMatch(/Last read \d+d ago/);
  });

  it("escalates to delete when an archive candidate also has broken refs", () => {
    const r = scoreTriage({
      entries: [
        entry({
          displayName: "broken.md",
          absPath: "/m/broken.md",
          mtimeMs: NOW - 70 * DAY,
          stale: { ageOver30d: true, brokenImports: [], brokenRefs: ["src/gone.ts"] },
        }),
      ],
      suppressUntil: {},
      now: NOW,
    });
    expect(r.candidates[0].recommendation).toBe("delete");
    expect(r.candidates[0].reasons).toContain("1 broken ref");
  });

  it("escalates to delete when an archive candidate also has broken @imports", () => {
    const r = scoreTriage({
      entries: [
        entry({
          displayName: "imp.md",
          absPath: "/m/imp.md",
          mtimeMs: NOW - 70 * DAY,
          stale: { ageOver30d: true, brokenImports: ["@./gone.md"], brokenRefs: [] },
        }),
      ],
      suppressUntil: {},
      now: NOW,
    });
    expect(r.candidates[0].recommendation).toBe("delete");
    expect(r.candidates[0].reasons).toContain("1 broken @import");
  });

  it("escalates to delete when an archive candidate is orphaned from MEMORY.md", () => {
    const r = scoreTriage({
      entries: [
        entry({
          displayName: "orphan.md",
          absPath: "/m/orphan.md",
          mtimeMs: NOW - 70 * DAY,
          indexed: false,
        }),
      ],
      suppressUntil: {},
      now: NOW,
    });
    expect(r.candidates[0].recommendation).toBe("delete");
    expect(r.candidates[0].reasons).toContain("Not in MEMORY.md");
  });

  it("does not escalate when broken refs exist but archive-eligibility is missing", () => {
    // Recent file, read often, but has a broken ref — should stay kept.
    const r = scoreTriage({
      entries: [
        entry({
          displayName: "fresh-but-broken.md",
          absPath: "/m/fresh-but-broken.md",
          mtimeMs: NOW - 5 * DAY,
          usage: { readCount: 10, lastReadAt: new Date(NOW - 1 * DAY).toISOString() },
          stale: { ageOver30d: false, brokenImports: [], brokenRefs: ["src/gone.ts"] },
        }),
      ],
      suppressUntil: {},
      now: NOW,
    });
    expect(r.candidates).toEqual([]);
  });

  it("hides entries whose suppressUntil is in the future", () => {
    const path = "/m/suppressed.md";
    const r = scoreTriage({
      entries: [
        entry({
          displayName: "suppressed.md",
          absPath: path,
          mtimeMs: NOW - 200 * DAY,
        }),
      ],
      suppressUntil: { [path]: new Date(NOW + 7 * DAY).toISOString() },
      now: NOW,
    });
    expect(r.candidates).toEqual([]);
    expect(r.suppressed).toHaveLength(1);
    expect(r.suppressed[0].suppressedUntil).toBeDefined();
  });

  it("re-includes entries whose suppressUntil has expired", () => {
    const path = "/m/lapsed.md";
    const r = scoreTriage({
      entries: [
        entry({
          displayName: "lapsed.md",
          absPath: path,
          mtimeMs: NOW - 200 * DAY,
        }),
      ],
      suppressUntil: { [path]: new Date(NOW - 1 * DAY).toISOString() },
      now: NOW,
    });
    expect(r.candidates).toHaveLength(1);
    expect(r.suppressed).toEqual([]);
  });

  it("sorts candidates: deletes first, then archives, descending by score", () => {
    const old = entry({
      displayName: "archive1.md",
      absPath: "/m/archive1.md",
      mtimeMs: NOW - 70 * DAY,
    });
    const orphaned = entry({
      displayName: "delete1.md",
      absPath: "/m/delete1.md",
      mtimeMs: NOW - 70 * DAY,
      indexed: false,
    });
    const r = scoreTriage({
      entries: [old, orphaned],
      suppressUntil: {},
      now: NOW,
    });
    expect(r.candidates[0].recommendation).toBe("delete");
    expect(r.candidates[1].recommendation).toBe("archive");
  });

  it("accumulates bytesRecoverable across candidates", () => {
    const r = scoreTriage({
      entries: [
        entry({
          displayName: "a.md",
          absPath: "/m/a.md",
          mtimeMs: NOW - 70 * DAY,
          sizeBytes: 1000,
        }),
        entry({
          displayName: "b.md",
          absPath: "/m/b.md",
          mtimeMs: NOW - 70 * DAY,
          sizeBytes: 2500,
        }),
      ],
      suppressUntil: {},
      now: NOW,
    });
    expect(r.bytesRecoverable).toBe(3500);
  });

  it("honors caller-supplied thresholds (strict variant)", () => {
    const e = entry({
      displayName: "midage.md",
      absPath: "/m/midage.md",
      mtimeMs: NOW - 65 * DAY,
    });
    const moderate = scoreTriage({ entries: [e], suppressUntil: {}, now: NOW });
    const strict = scoreTriage({
      entries: [e],
      suppressUntil: {},
      now: NOW,
      thresholds: { archiveAgeDays: 120, archiveStaleReadDays: 180 },
    });
    expect(moderate.candidates).toHaveLength(1);
    expect(strict.candidates).toEqual([]);
  });

  it("MODERATE_THRESHOLDS is the exported default", () => {
    expect(MODERATE_THRESHOLDS).toEqual({ archiveAgeDays: 60, archiveStaleReadDays: 90 });
  });
});
