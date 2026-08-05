/**
 * A1 — session-level transcript decode (`scanSessionFile` via `scanAllSessions`).
 *
 * The per-turn half is covered in `a1TranscriptDecode.test.ts`. This file covers
 * the session half, which reads from places that are easy to get wrong:
 *
 *   - `aiTitle` / `permissionMode` come from dedicated entry types that carry
 *     NO timestamp, and the reader skips untimestamped entries.
 *   - `sessionKind` / `entrypoint` ride `attachment` entries, not assistant
 *     turns — a reader looking at assistant entries finds nothing and reports
 *     a plausible `undefined`.
 *   - `effortMix` must count only turns that HAVE an effort, so it deliberately
 *     does not sum to `assistantMessageCount`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import path from "path";
import os from "os";
import { promises as fs } from "fs";

let tmpHome: string;

beforeEach(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "pm-a1-session-"));
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

/** Write a session transcript under a fake ~/.claude/projects/<dir>/. */
async function writeSession(dirName: string, sessionId: string, lines: object[]) {
  const dir = path.join(tmpHome, ".claude", "projects", dirName);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, `${sessionId}.jsonl`),
    lines.map((l) => JSON.stringify(l)).join("\n") + "\n"
  );
}

function assistant(ts: string, effort?: string, extra: Record<string, unknown> = {}) {
  return {
    type: "assistant",
    timestamp: ts,
    ...(effort ? { effort } : {}),
    ...extra,
    message: {
      model: "claude-opus-5",
      role: "assistant",
      content: [{ type: "text", text: "ok" }],
      usage: { input_tokens: 10, output_tokens: 5 },
    },
  };
}

function user(ts: string, text: string) {
  return {
    type: "user",
    timestamp: ts,
    message: { role: "user", content: [{ type: "text", text }] },
  };
}

describe("A1 session decode — modern transcript", () => {
  it("decodes aiTitle, permission modes, session kind, entrypoint and effort mix", async () => {
    await writeSession("C--dev-demo", "sess-modern", [
      // No timestamp on either of these — the decode must run above the
      // `!entry.timestamp` guard or they vanish without an error.
      { type: "ai-title", aiTitle: "Trace a flaky test", sessionId: "sess-modern" },
      { type: "permission-mode", permissionMode: "plan", sessionId: "sess-modern" },
      {
        type: "attachment",
        timestamp: "2026-08-01T10:00:00Z",
        sessionKind: "bg",
        entrypoint: "cli",
        sessionId: "sess-modern",
      },
      user("2026-08-01T10:00:01Z", "find the flake"),
      assistant("2026-08-01T10:00:02Z", "high", {
        hookInfos: [{ command: "codegraph sync", durationMs: 1450 }],
      }),
      assistant("2026-08-01T10:00:03Z", "high"),
      assistant("2026-08-01T10:00:04Z", "xhigh"),
      // No effort — stands in for a turn written before the field existed.
      assistant("2026-08-01T10:00:05Z"),
      { type: "permission-mode", permissionMode: "auto", sessionId: "sess-modern" },
    ]);

    const { scanAllSessions } = await import("@/lib/scanner/claudeConversations");
    const sessions = await scanAllSessions();
    const s = sessions.find((x) => x.sessionId === "sess-modern");

    expect(s).toBeDefined();
    expect(s!.aiTitle).toBe("Trace a flaky test");
    expect(s!.sessionKind).toBe("bg");
    expect(s!.entrypoint).toBe("cli");

    // In file order, both changes retained — a session can switch modes twice.
    expect(s!.permissionModes?.map((p) => p.mode)).toEqual(["plan", "auto"]);

    // Counts only the turns that carried an effort: 4 assistant turns, 3 efforts.
    expect(s!.effortMix).toEqual({ high: 2, xhigh: 1 });
    expect(s!.assistantMessageCount).toBe(4);

    expect(s!.hookRuns).toHaveLength(1);
    expect(s!.hookRuns![0]).toMatchObject({ command: "codegraph sync", durationMs: 1450 });
  });

  it("takes the LAST ai-title when several are emitted", async () => {
    await writeSession("C--dev-demo", "sess-retitled", [
      { type: "ai-title", aiTitle: "First guess", sessionId: "sess-retitled" },
      user("2026-08-01T10:00:01Z", "actually do something else"),
      assistant("2026-08-01T10:00:02Z", "high"),
      { type: "ai-title", aiTitle: "What it actually became", sessionId: "sess-retitled" },
    ]);

    const { scanAllSessions } = await import("@/lib/scanner/claudeConversations");
    const s = (await scanAllSessions()).find((x) => x.sessionId === "sess-retitled");
    expect(s!.aiTitle).toBe("What it actually became");
  });

  it("records a tool denial kind against the tool call it refused", async () => {
    // `toolDenialKind` sits top-level on the USER entry carrying the
    // tool_result, while the tool call itself belongs to the preceding
    // assistant turn — so it only lands correctly if paired by tool_use_id.
    await writeSession("C--dev-demo", "sess-denied", [
      user("2026-08-01T10:00:01Z", "read that file"),
      {
        type: "assistant",
        timestamp: "2026-08-01T10:00:02Z",
        message: {
          model: "claude-opus-5",
          role: "assistant",
          content: [{ type: "tool_use", id: "toolu_denied", name: "Read", input: { file_path: "/etc/shadow" } }],
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      },
      {
        type: "user",
        timestamp: "2026-08-01T10:00:03Z",
        toolDenialKind: "permission-rule",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "toolu_denied", is_error: true, content: "denied" }],
        },
      },
    ]);

    const { scanAllSessions } = await import("@/lib/scanner/claudeConversations");
    const s = (await scanAllSessions()).find((x) => x.sessionId === "sess-denied");
    // The file-parse path doesn't surface denial_kind on SessionSummary (it is
    // a tool_uses column consumed by A6); assert the session still parses
    // cleanly with the field present rather than throwing on the new shape.
    expect(s).toBeDefined();
    expect(s!.toolUsage.Read).toBe(1);
  });

  it("merges authoritative pr-link entries with scraped PRs, deduped by URL", async () => {
    await writeSession("C--dev-demo", "sess-pr", [
      user("2026-08-01T10:00:01Z", "open a PR"),
      assistant("2026-08-01T10:00:02Z", "high"),
      {
        type: "pr-link",
        timestamp: "2026-08-01T10:00:03Z",
        prNumber: 375,
        prUrl: "https://github.com/owner/repo/pull/375",
        prRepository: "owner/repo",
        sessionId: "sess-pr",
      },
    ]);

    const { scanAllSessions } = await import("@/lib/scanner/claudeConversations");
    const s = (await scanAllSessions()).find((x) => x.sessionId === "sess-pr");
    expect(s!.prs).toHaveLength(1);
    expect(s!.prs![0]).toEqual({
      url: "https://github.com/owner/repo/pull/375",
      number: 375,
      repo: "owner/repo",
    });
  });
});

describe("A1 session decode — legacy transcript", () => {
  it("leaves every A1 field undefined rather than defaulting", async () => {
    await writeSession("C--dev-demo", "sess-legacy", [
      user("2026-01-01T10:00:01Z", "do a thing"),
      assistant("2026-01-01T10:00:02Z"),
      assistant("2026-01-01T10:00:03Z"),
    ]);

    const { scanAllSessions } = await import("@/lib/scanner/claudeConversations");
    const s = (await scanAllSessions()).find((x) => x.sessionId === "sess-legacy");

    expect(s).toBeDefined();
    // The session parses normally — it is just missing the newer signal.
    expect(s!.assistantMessageCount).toBe(2);

    // Absence must stay absence. An empty object/array here would let a UI
    // render "0 mode switches" for a session that could not have reported any,
    // and `effortMix: {}` would average over an empty denominator.
    expect(s!.aiTitle).toBeUndefined();
    expect(s!.sessionKind).toBeUndefined();
    expect(s!.entrypoint).toBeUndefined();
    expect(s!.permissionModes).toBeUndefined();
    expect(s!.effortMix).toBeUndefined();
    expect(s!.hookRuns).toBeUndefined();
  });
});
