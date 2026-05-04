import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "fs";
import path from "path";
import os from "os";
import {
  canonicalizeDirName,
  parseSessionTurns,
  loadSessionTurnsBySessionId,
  SessionTurnsLoadError,
} from "@/lib/usage/parser";

describe("canonicalizeDirName", () => {
  it("leaves a normal project path unchanged", () => {
    expect(canonicalizeDirName("C--dev-project-minder")).toBe("C--dev-project-minder");
  });

  it("strips .worktrees suffix", () => {
    expect(canonicalizeDirName("C--dev-project-minder--worktrees-c9watch")).toBe(
      "C--dev-project-minder"
    );
  });

  it("strips .claude-worktrees suffix (patchmaven convention)", () => {
    expect(
      canonicalizeDirName("C--dev-patchmaven--claude-worktrees-additional-blocks")
    ).toBe("C--dev-patchmaven");
  });

  it("strips .claude-worktrees with hyphenated branch name", () => {
    expect(
      canonicalizeDirName("C--dev-patchmaven--claude-worktrees-feature-timeline-replay")
    ).toBe("C--dev-patchmaven");
  });

  it("does not strip a project named worktrees-something", () => {
    // 'C--dev-worktrees-manager' has no second '--', so no stripping
    expect(canonicalizeDirName("C--dev-worktrees-manager")).toBe("C--dev-worktrees-manager");
  });

  it("strips worktree suffix when an earlier dot-prefixed dir is in the path", () => {
    // Path: C:\dev\project\.cache\.worktrees\branch — two dot-prefixed components
    expect(
      canonicalizeDirName("C--dev-project--cache--worktrees-branch")
    ).toBe("C--dev-project--cache");
  });

  it("strips at the first worktree marker (leaves intermediate dot dirs intact)", () => {
    expect(
      canonicalizeDirName("C--dev-project--cache--claude-worktrees-feature")
    ).toBe("C--dev-project--cache");
  });

  it("stops at first worktree marker even if branch name contains '--worktrees-'", () => {
    // Branch name 'feat--worktrees-fix' is a valid git ref; must not be treated as a second marker
    expect(
      canonicalizeDirName("C--dev-proj--claude-worktrees-feat--worktrees-fix")
    ).toBe("C--dev-proj");
  });

  it("handles Unix-style paths with .worktrees", () => {
    expect(canonicalizeDirName("-home-user-project--worktrees-branch")).toBe(
      "-home-user-project"
    );
  });

  it("handles Unix-style paths with .claude-worktrees", () => {
    expect(canonicalizeDirName("-home-user-project--claude-worktrees-feat")).toBe(
      "-home-user-project"
    );
  });

  it("returns unchanged for unrecognized format", () => {
    expect(canonicalizeDirName("some-random-thing")).toBe("some-random-thing");
  });
});

// ── parseSessionTurns strict mode (Wave 3.1 PR #63 review fix) ───────────────

describe("parseSessionTurns strict mode", () => {
  it("returns [] on read failure when strict is unset (legacy sweep behavior)", async () => {
    const missing = path.join(os.tmpdir(), `nonexistent-${Date.now()}.jsonl`);
    const turns = await parseSessionTurns(missing, "fake-dir");
    expect(turns).toEqual([]);
  });

  it("propagates the readFile error when strict=true", async () => {
    const missing = path.join(os.tmpdir(), `nonexistent-${Date.now()}.jsonl`);
    await expect(
      parseSessionTurns(missing, "fake-dir", { strict: true })
    ).rejects.toThrow();
  });

  it("strict mode still soft-skips per-line JSON parse errors", async () => {
    // A file with one valid assistant line + one malformed line should
    // still parse the valid line. Strict mode propagates only file-level
    // failures, not per-line corruption.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "minder-test-"));
    const file = path.join(dir, "test-session.jsonl");
    const valid = JSON.stringify({
      type: "assistant",
      timestamp: "2026-05-04T12:00:00Z",
      message: { model: "claude-sonnet-4-6", usage: { input_tokens: 100 } },
    });
    const malformed = "{not valid json";
    try {
      await fs.writeFile(file, `${valid}\n${malformed}\n`);
      const turns = await parseSessionTurns(file, "fake-dir", { strict: true });
      expect(turns.length).toBe(1);
      expect(turns[0].role).toBe("assistant");
      expect(turns[0].inputTokens).toBe(100);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

// ── loadSessionTurnsBySessionId 404/500 distinction (Wave 3.1 PR #63 review fix) ─

describe("loadSessionTurnsBySessionId", () => {
  it("returns null for non-UUID-shaped session ids", async () => {
    expect(await loadSessionTurnsBySessionId("not-a-uuid-shape")).toBeNull();
  });

  it("returns null when projects dir is missing (ENOENT path → 404 at route)", async () => {
    // Standard runtime: real ~/.claude/projects exists. If a test machine
    // has no such dir, the function returns null. Either outcome (null
    // for unknown id, null for missing dir) is the legitimate 404 path.
    const result = await loadSessionTurnsBySessionId(
      "ffffffff-ffff-ffff-ffff-ffffffffffff"
    );
    // Real machines have ~/.claude/projects; either null (id not found)
    // or null (dir missing) is acceptable. The contract being pinned is
    // "no throw on a well-formed id that doesn't resolve."
    expect(result).toBeNull();
  });

  it("SessionTurnsLoadError class round-trips its fields", () => {
    const cause = new Error("permission denied");
    const err = new SessionTurnsLoadError(
      "Failed to parse",
      "abc-123",
      "/path/to/file.jsonl",
      cause
    );
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("SessionTurnsLoadError");
    expect(err.message).toBe("Failed to parse");
    expect(err.sessionId).toBe("abc-123");
    expect(err.filePath).toBe("/path/to/file.jsonl");
    expect(err.cause).toBe(cause);
  });
});
