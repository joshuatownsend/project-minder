import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "fs";
import path from "path";
import os from "os";
import {
  canonicalizeDirName,
  parseSessionTurns,
  SessionTurnsLoadError,
} from "@/lib/usage/parser";
import { installIsolatedState } from "./_helpers/isolatedState";

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

// ── parseSessionTurns: non-array assistant content guard (plan 003) ─────────────

describe("parseSessionTurns non-array assistant content", () => {
  it("does not throw when assistant message.content is a plain string", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "minder-test-"));
    const file = path.join(dir, "test-session.jsonl");
    const assistantLine = JSON.stringify({
      type: "assistant",
      timestamp: "2026-06-13T10:00:00Z",
      message: {
        model: "claude-sonnet-4-6",
        usage: { input_tokens: 50, output_tokens: 20 },
        content: "plain string body",
      },
    });
    try {
      await fs.writeFile(file, `${assistantLine}\n`);
      const turns = await parseSessionTurns(file, "fake-dir");
      expect(turns.length).toBe(1);
      expect(turns[0].role).toBe("assistant");
      expect(turns[0].toolCalls).toEqual([]);
      expect(turns[0].assistantText).toBeUndefined();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

// ── loadSessionTurnsBySessionId 404/500 distinction (Wave 3.1 PR #63 review fix) ─

// #485 — these reach `resolveSessionJsonl`, which walks
// `getReadableClaudeHomes()`. Unisolated, that is the DEVELOPER'S real
// `~/.claude/projects`, which made the block two things it should not be:
//
//  - **Vacuous on a clean checkout.** With no `~/.claude/projects` the null
//    came back for a reason unrelated to the contract, so the test could not
//    distinguish a working id gate from a broken one. The old comment said so
//    outright — "either outcome is acceptable" — which is an assertion that
//    cannot fail.
//  - **Timing-dependent on that developer's history.** 80 project directories
//    and 3,279 `access` calls on this machine; under the suite's 8-way
//    parallelism it blew the 30s timeout on #484 — passing in isolation and
//    failing in the full suite, which is the signature of a machine-and-load
//    dependency rather than a flake.
//
// With a seeded temp home the tree is known, so a null MEANS "not in this
// tree". The positive case below is what makes that a real answer rather than
// the same null every input would produce.
describe("loadSessionTurnsBySessionId", () => {
  const state = installIsolatedState({ seedClaudeProjects: true });

  /** Write one transcript into the isolated home. Returns its session id. */
  async function seedTranscript(dirName: string, sessionId: string) {
    const dir = path.join(state.tmpHome(), ".claude", "projects", dirName);
    await fs.mkdir(dir, { recursive: true });
    const line = JSON.stringify({
      type: "assistant",
      timestamp: "2026-01-01T00:00:00Z",
      sessionId,
      message: {
        id: "msg_1",
        model: "claude-opus-5",
        content: [{ type: "text", text: "hello" }],
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    });
    await fs.writeFile(path.join(dir, sessionId + ".jsonl"), line + "\n", "utf-8");
    return sessionId;
  }

  /** Reload so the module graph resolves paths against the isolated home. */
  async function load() {
    await state.reload();
    return (await import("@/lib/usage/parser")).loadSessionTurnsBySessionId;
  }

  it("returns null for non-UUID-shaped session ids", async () => {
    const loadSessionTurnsBySessionId = await load();
    expect(await loadSessionTurnsBySessionId("not-a-uuid-shape")).toBeNull();
  });

  it("returns null for a well-formed id that is not in the tree", async () => {
    // Paired with the positive case below on purpose: alone, a null here is
    // what an empty tree returns for every input, so it would ratify a
    // resolver that never worked at all.
    const loadSessionTurnsBySessionId = await load();
    await seedTranscript("C--dev-app", "11111111-1111-1111-1111-111111111111");
    expect(
      await loadSessionTurnsBySessionId("ffffffff-ffff-ffff-ffff-ffffffffffff")
    ).toBeNull();
  });

  it("finds a transcript that IS in the tree", async () => {
    const loadSessionTurnsBySessionId = await load();
    const id = await seedTranscript(
      "C--dev-app",
      "22222222-2222-2222-2222-222222222222"
    );
    const turns = await loadSessionTurnsBySessionId(id);
    expect(turns).not.toBeNull();
    expect(turns).toHaveLength(1);
    expect(turns![0].sessionId).toBe(id);
    expect(turns![0].model).toBe("claude-opus-5");
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
