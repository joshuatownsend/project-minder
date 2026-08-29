import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import path from "path";
import os from "os";
import { promises as fs } from "fs";
import { projectDirNameFromPath } from "@/lib/usage/sessionPath";

/**
 * #486 — the per-session routes resolve through the index when one is
 * available, instead of walking every Claude home.
 *
 * The walk is not merely slow. Its nested pass runs a `readdir` per project
 * directory and an `access` per session directory — measured at 80 project
 * dirs, 3,279 session subdirs, ~1.4 s for a single miss — and several
 * endpoints call the resolver independently, so a few requests for one bad
 * `agent-*` id multiply it.
 */

let tmpHome: string;

beforeEach(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "pm-hint-"));
  vi.spyOn(os, "homedir").mockReturnValue(tmpHome);
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

describe("projectDirNameFromPath", () => {
  it("reads the project dir out of a FLAT transcript path", () => {
    expect(
      projectDirNameFromPath("/home/me/.claude/projects/-home-me-dev-app/s1.jsonl")
    ).toBe("-home-me-dev-app");
  });

  it("reads it out of a NESTED subagent path too", () => {
    // The whole reason this is path-derived: both layouts have to give the
    // PROJECT directory, matching how ingest attributes these files. A caller
    // that took `path.dirname` would get `subagents` here.
    expect(
      projectDirNameFromPath(
        "/home/me/.claude/projects/-home-me-dev-app/parent-id/subagents/agent-x.jsonl"
      )
    ).toBe("-home-me-dev-app");
  });

  it("returns null for a path that is not under a projects directory", () => {
    expect(projectDirNameFromPath("/tmp/loose.jsonl")).toBeNull();
    expect(projectDirNameFromPath("/home/me/.claude/projects/s1.jsonl")).toBeNull();
  });
});

describe("resolveSessionJsonl with an index hint (#486)", () => {
  async function writeTranscript(rel: string): Promise<string> {
    const full = path.join(tmpHome, ".claude", "projects", rel);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, "{}\n");
    return full;
  }

  it("uses the indexed path and does not walk", async () => {
    const target = await writeTranscript(path.join("-home-me-dev-app", "s1.jsonl"));
    // Decoys: if the resolver walked, it would still find the right file, so a
    // "did it find it" assertion proves nothing. The lookup call count is what
    // distinguishes the two paths.
    await writeTranscript(path.join("-home-me-dev-other", "s2.jsonl"));

    const { resolveSessionJsonl } = await import("@/lib/usage/sessionPath");
    const indexedPath = vi.fn(async () => target);

    const resolved = await resolveSessionJsonl("s1", { indexedPath });
    expect(indexedPath).toHaveBeenCalledWith("s1");
    expect(resolved).toEqual({
      filePath: target,
      projectDirName: "-home-me-dev-app",
    });
  });

  it("returns a NESTED path with the project dir, not the parent-session dir", async () => {
    // The layout the walk had to be taught about (#483/#484). Through the index
    // it arrives already correct, which is the half of #486 that stops
    // consumers re-deriving it.
    const target = await writeTranscript(
      path.join("-home-me-dev-app", "parent-id", "subagents", "agent-abc.jsonl")
    );
    const { resolveSessionJsonl } = await import("@/lib/usage/sessionPath");

    const resolved = await resolveSessionJsonl("agent-abc", {
      indexedPath: async () => target,
    });
    expect(resolved).toEqual({
      filePath: target,
      projectDirName: "-home-me-dev-app",
    });
  });

  it("never touches a hinted path outside the readable homes", async () => {
    // THE never-wake invariant (#307/#308). `getReadableClaudeHomes` excludes a
    // home inside a stopped WSL distro WITHOUT touching it, because touching a
    // `\\\\wsl$` UNC path auto-starts the VM.
    //
    // The index retains rows for sessions in such a home, so an unconditional
    // `fs.access` on a hinted path reached straight past that exclusion — and
    // would have started the distro from peek, handoff, attribution, export or
    // live metrics, none of which a user would connect to WSL starting
    // (Codex P1, PR #526).
    //
    // Asserted on the ACCESS, not the result: the walk returns null here
    // either way, so a return-value assertion would pass with the bug present.
    const target = await writeTranscript(path.join("-home-me-dev-app", "s1.jsonl"));
    const outsider = path.join(tmpHome, "not-a-home", "projects", "-x", "s9.jsonl");
    await fs.mkdir(path.dirname(outsider), { recursive: true });
    await fs.writeFile(outsider, "{}\n");

    const { resolveSessionJsonl } = await import("@/lib/usage/sessionPath");
    const accessed: string[] = [];
    const realAccess = fs.access.bind(fs);
    vi.spyOn(fs, "access").mockImplementation(async (p, ...rest) => {
      accessed.push(String(p));
      return realAccess(p as string, ...(rest as []));
    });

    const resolved = await resolveSessionJsonl("s9", {
      indexedPath: async () => outsider,
    });

    // The hinted path is outside every readable home, so it is never probed.
    expect(accessed).not.toContain(outsider);
    // And the walk answered on its own terms — `s9` is not in the real home.
    expect(resolved).toBeNull();
    expect(target).toContain("-home-me-dev-app");
  });

  it("falls back to the walk when the index has no row", async () => {
    const target = await writeTranscript(path.join("-home-me-dev-app", "s1.jsonl"));
    const { resolveSessionJsonl } = await import("@/lib/usage/sessionPath");

    const resolved = await resolveSessionJsonl("s1", { indexedPath: async () => null });
    expect(resolved?.filePath).toBe(target);
  });

  it("falls back when the indexed path no longer exists", async () => {
    // The index can lag a deletion or a move. Trusting it would turn "the file
    // moved" into an unreadable-file error further down, where the walk can
    // still answer.
    const target = await writeTranscript(path.join("-home-me-dev-app", "s1.jsonl"));
    const { resolveSessionJsonl } = await import("@/lib/usage/sessionPath");

    const resolved = await resolveSessionJsonl("s1", {
      indexedPath: async () => path.join(tmpHome, ".claude", "projects", "-gone", "s1.jsonl"),
    });
    expect(resolved?.filePath).toBe(target);
  });

  it("falls back when the lookup itself throws", async () => {
    // A failing index must not break a lookup the filesystem can still answer.
    const target = await writeTranscript(path.join("-home-me-dev-app", "s1.jsonl"));
    const { resolveSessionJsonl } = await import("@/lib/usage/sessionPath");

    const resolved = await resolveSessionJsonl("s1", {
      indexedPath: async () => {
        throw new Error("index unavailable");
      },
    });
    expect(resolved?.filePath).toBe(target);
  });

  it("still rejects a malformed id before consulting the index", async () => {
    const { resolveSessionJsonl } = await import("@/lib/usage/sessionPath");
    const indexedPath = vi.fn(async () => "/anything");
    expect(await resolveSessionJsonl("../escape", { indexedPath })).toBeNull();
    expect(indexedPath).not.toHaveBeenCalled();
  });
});

describe("indexedSessionPath honours the backend selection (#486)", () => {
  it("returns null under MINDER_USE_DB=0 without opening the index", async () => {
    // `MINDER_USE_DB=0` is an explicit "do not use the index", and `getDb()`
    // will OPEN OR CREATE the SQLite file regardless — so calling it here both
    // ignored the selection and could answer from a database left over by an
    // earlier DB-enabled run. A stale `file_path` from one of those points at a
    // transcript under a Claude home since removed from config, which the walk
    // would correctly no longer find (Codex P2, PR #526).
    //
    // Asserted through the CONNECTION, not the return value: a null could also
    // mean "no row", which is what it would have returned anyway.
    vi.resetModules();
    const getDb = vi.fn(async () => null);
    vi.doMock("@/lib/db/connection", () => ({ getDb }));

    const previous = process.env.MINDER_USE_DB;
    process.env.MINDER_USE_DB = "0";
    try {
      const { indexedSessionPath } = await import("@/lib/data/indexedSessionPath");
      expect(await indexedSessionPath("s1")).toBeNull();
      expect(getDb).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) delete process.env.MINDER_USE_DB;
      else process.env.MINDER_USE_DB = previous;
    }
  });
});
