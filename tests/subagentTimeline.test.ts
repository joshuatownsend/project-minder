import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import path from "path";
import os from "os";
import { promises as fs } from "fs";

/**
 * #487 — a delegated agent's transcript opens onto its own conversation.
 *
 * `isSidechain` means "this turn is a sidechain OF ITS PARENT". In an ordinary
 * session that is exactly right and those turns are skipped. In a file at
 * `<project>/<parent>/subagents/<id>.jsonl` EVERY entry carries the flag —
 * sampled on a real transcript, 50 of 50 — because the whole file is the
 * sidechain. Skipping them all produced a session that opened successfully and
 * rendered nothing, which reads as "this agent did no work".
 *
 * ## The fixture sets `isSidechain`, and that is the point
 *
 * PR #484's end-to-end test asserted only that the detail was non-null, and its
 * fixture OMITTED `isSidechain` — which is exactly what real transcripts always
 * carry. So it passed against the defect. The issue asks for the timeline to be
 * asserted non-empty and to contain known text, and for any fixture to set the
 * flag. Both are done here.
 */

let tmpHome: string;

beforeEach(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "pm-subagent-"));
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

function userTurn(ts: string, text: string, sidechain: boolean) {
  return {
    type: "user",
    timestamp: ts,
    isSidechain: sidechain,
    message: { role: "user", content: [{ type: "text", text }] },
  };
}

function assistantTurn(ts: string, text: string, sidechain: boolean) {
  return {
    type: "assistant",
    timestamp: ts,
    isSidechain: sidechain,
    message: {
      role: "assistant",
      model: "claude-opus-5",
      content: [{ type: "text", text }],
      usage: { input_tokens: 10, output_tokens: 5 },
    },
  };
}

async function write(rel: string, entries: object[]) {
  const full = path.join(tmpHome, ".claude", "projects", rel);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
  return full;
}

describe("delegated agent transcripts (#487)", () => {
  it("renders a NON-EMPTY timeline containing the agent's own text", async () => {
    // Every entry `isSidechain: true`, as a real one is — and a UUID-shaped
    // PARENT directory, which is what `parseSubagentParentSessionId` requires
    // (`/^(agent-)?[a-f0-9-]+$/`). My first fixture used "parent-1", the
    // predicate correctly refused it, and the timeline came back empty — the
    // test failing on an unrealistic fixture rather than on the code.
    await write(
      path.join(
        "-home-me-dev-app",
        "0a1b2c3d-4e5f-6a7b-8c9d-0e1f2a3b4c5d",
        "subagents",
        "agent-abc.jsonl"
      ),
      [
        userTurn("2026-03-01T10:00:00.000Z", "find the flaky test", true),
        assistantTurn("2026-03-01T10:00:05.000Z", "checked the retry markers", true),
      ]
    );

    const { scanSessionDetail } = await import("@/lib/scanner/claudeConversations");
    const detail = await scanSessionDetail("agent-abc");

    // Non-null was all #484 asserted, and it passed against the defect.
    expect(detail).not.toBeNull();
    expect(detail!.timeline.length).toBeGreaterThan(0);

    // KNOWN TEXT, not just a count: a timeline of the right length built from
    // the wrong entries would satisfy a length check.
    const text = JSON.stringify(detail!.timeline);
    expect(text).toContain("find the flaky test");
    expect(text).toContain("checked the retry markers");
  });

  it("still skips sidechain turns in an ORDINARY session", async () => {
    // The other half. `isSidechain` keeps its meaning where the file is not
    // itself a delegated transcript — a fix that simply ignored the flag
    // everywhere would pass the test above and break every normal session.
    await write(path.join("-home-me-dev-app", "plain-1.jsonl"), [
      userTurn("2026-03-01T10:00:00.000Z", "the developer asked this", false),
      assistantTurn("2026-03-01T10:00:05.000Z", "the developer was told this", false),
      userTurn("2026-03-01T10:00:10.000Z", "DELEGATED PROMPT", true),
      assistantTurn("2026-03-01T10:00:15.000Z", "DELEGATED REPLY", true),
    ]);

    const { scanSessionDetail } = await import("@/lib/scanner/claudeConversations");
    const detail = await scanSessionDetail("plain-1");

    expect(detail).not.toBeNull();
    const text = JSON.stringify(detail!.timeline);
    expect(text).toContain("the developer asked this");
    expect(text).not.toContain("DELEGATED PROMPT");
    expect(text).not.toContain("DELEGATED REPLY");
  });
});

describe("meta entries in a delegated transcript (#487)", () => {
  it("drops them, as the DB path already does", async () => {
    // The DB path drops every meta entry; this branch never had that check,
    // which was unobservable while `!entry.isSidechain` already excluded a
    // delegated transcript's entries wholesale. Widening the gate to admit them
    // exposed it, and the two backends then rendered DIFFERENT timelines for
    // the same file — the divergence class this PR exists to close.
    // (Codex P2, PR #528.)
    await write(
      path.join(
        "-home-me-dev-app",
        "1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d",
        "subagents",
        "agent-meta.jsonl"
      ),
      [
        userTurn("2026-03-01T10:00:00.000Z", "find the flaky test", true),
        {
          ...assistantTurn("2026-03-01T10:00:03.000Z", "INTERNAL META NOTE", true),
          isMeta: true,
        },
        assistantTurn("2026-03-01T10:00:05.000Z", "checked the retry markers", true),
      ]
    );

    const { scanSessionDetail } = await import("@/lib/scanner/claudeConversations");
    const detail = await scanSessionDetail("agent-meta");

    expect(detail).not.toBeNull();
    const text = JSON.stringify(detail!.timeline);
    // The real turns are there...
    expect(text).toContain("find the flaky test");
    expect(text).toContain("checked the retry markers");
    // ...and the meta entry is not.
    expect(text).not.toContain("INTERNAL META NOTE");
  });

  it("leaves an ordinary session's meta assistant entries alone", async () => {
    // Scoped to the delegated case deliberately: an ordinary session's meta
    // assistant entries render today, and changing that is not this fix's
    // business. Without this, a broader `!entry.isMeta` would look equally
    // correct and would quietly change every normal session.
    await write(path.join("-home-me-dev-app", "plain-meta.jsonl"), [
      userTurn("2026-03-01T10:00:00.000Z", "the developer asked this", false),
      {
        ...assistantTurn("2026-03-01T10:00:05.000Z", "ORDINARY META NOTE", false),
        isMeta: true,
      },
    ]);

    const { scanSessionDetail } = await import("@/lib/scanner/claudeConversations");
    const detail = await scanSessionDetail("plain-meta");

    expect(detail).not.toBeNull();
    expect(JSON.stringify(detail!.timeline)).toContain("ORDINARY META NOTE");
  });
});
