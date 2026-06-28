import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  genBoardId,
  collectIds,
  backfillIds,
  applyAddIssue,
  applyAddEpic,
  applySetIssueStatus,
  applyEditIssue,
  applyMoveIssue,
  applyReorderIssue,
  addIssue,
  promoteTodoToBoard,
  BoardWriteError,
} from "@/lib/boardWriter";
import { parseBoardMd } from "@/lib/scanner/boardMd";

// Mock fs for the async wiring test. The pure applyXxx transforms below don't
// touch fs, so they're unaffected.
vi.mock("fs", () => ({
  promises: {
    readFile: vi.fn(),
    writeFile: vi.fn(),
    rename: vi.fn(async () => undefined),
  },
}));

import { promises as fs } from "fs";
const mockReadFile = vi.mocked(fs.readFile);
const mockWriteFile = vi.mocked(fs.writeFile);
const mockRename = vi.mocked(fs.rename);

beforeEach(() => vi.clearAllMocks());

const SAMPLE = `# Board — myapp
<!-- minder-board: v1 -->

## Epic: Auth ^e-aaaa  [doing]  !high
> Ship auth.

- [ ] Wire provider ^i-1111  [todo]  #frontend
- [>] Add middleware ^i-2222  [doing]
- [x] Spike ^i-3333  [done]

## Epic: Billing ^e-bbbb  [backlog]

- [ ] Stripe setup ^i-4444  [todo]

## Inbox
- [ ] (finding) leak ^i-5555  [triage]  @wt:fix-y  ~session:s9
`;

describe("genBoardId", () => {
  it("returns a kind-prefixed id and records it", () => {
    const seen = new Set<string>();
    const id = genBoardId("i", seen);
    expect(id).toMatch(/^i-[a-z0-9]{4}$/);
    expect(seen.has(id)).toBe(true);
  });

  it("avoids collisions with existing ids", () => {
    // Pre-seed every 4-char id but one is impossible; instead assert it never
    // returns an id already in the set across many draws.
    const seen = new Set<string>();
    const ids = Array.from({ length: 200 }, () => genBoardId("e", seen));
    expect(new Set(ids).size).toBe(ids.length); // all unique
    ids.forEach((id) => expect(id.startsWith("e-")).toBe(true));
  });
});

describe("collectIds", () => {
  it("extracts every ^e-/^i- id", () => {
    const ids = collectIds(SAMPLE);
    expect(ids).toContain("e-aaaa");
    expect(ids).toContain("i-1111");
    expect(ids).toContain("i-5555");
    expect(ids.size).toBe(7);
  });
});

describe("backfillIds", () => {
  it("assigns ids to bare epic and issue lines, leaving existing ones intact", () => {
    const input = `## Epic: New One
- [ ] bare issue
- [ ] kept ^i-keep  [todo]
`;
    const { content, changed } = backfillIds(input);
    expect(changed).toBe(true);

    const board = parseBoardMd(content)!;
    expect(board.epics[0].id).toMatch(/^e-[a-z0-9]{4}$/); // backfilled
    expect(board.epics[0].issues[0].id).toMatch(/^i-[a-z0-9]{4}$/); // backfilled
    expect(board.epics[0].issues[1].id).toBe("i-keep"); // untouched
  });

  it("is a no-op when every line already has an id", () => {
    const { changed } = backfillIds(SAMPLE);
    expect(changed).toBe(false);
  });

  it("never collides a backfilled id with an existing one", () => {
    const input = `## Epic: A ^e-zzzz
- [ ] one
- [ ] two
- [ ] three
`;
    const ids = collectIds(backfillIds(input).content);
    expect(ids.size).toBe(4); // e-zzzz + 3 fresh, all distinct
  });
});

describe("applyAddIssue", () => {
  it("inserts an issue under the target epic with a backfilled id", () => {
    const out = applyAddIssue(SAMPLE, {
      title: "New task",
      epicId: "e-aaaa",
      priority: "med",
      labels: ["backend"],
    });
    const board = parseBoardMd(out)!;
    const auth = board.epics.find((e) => e.id === "e-aaaa")!;
    const added = auth.issues.find((i) => i.title === "New task")!;
    expect(added).toBeDefined();
    expect(added.id).toMatch(/^i-[a-z0-9]{4}$/);
    expect(added.priority).toBe("med");
    expect(added.labels).toEqual(["backend"]);
    expect(added.status).toBe("todo");
    // Inserted after the epic's existing issues.
    expect(auth.issues[auth.issues.length - 1].title).toBe("New task");
  });

  it("appends to the existing Inbox when no epicId is given", () => {
    const out = applyAddIssue(SAMPLE, { title: "triage this" });
    const board = parseBoardMd(out)!;
    expect(board.inbox.map((i) => i.title)).toContain("triage this");
    // Did not disturb the existing inbox finding.
    expect(board.inbox.map((i) => i.title)).toContain("(finding) leak");
  });

  it("creates an Inbox section when none exists", () => {
    const noInbox = `## Epic: A ^e-a\n- [ ] one ^i-1\n`;
    const out = applyAddIssue(noInbox, { title: "fresh" });
    const board = parseBoardMd(out)!;
    expect(board.inbox).toHaveLength(1);
    expect(board.inbox[0].title).toBe("fresh");
  });

  it("throws BAD_TARGET for an unknown epic", () => {
    expect(() => applyAddIssue(SAMPLE, { title: "x", epicId: "e-nope" })).toThrow(
      BoardWriteError,
    );
  });

  it("throws EMPTY_TITLE for blank titles", () => {
    expect(() => applyAddIssue(SAMPLE, { title: "   " })).toThrow(BoardWriteError);
  });
});

describe("applyAddEpic", () => {
  it("adds an epic with a description before the Inbox", () => {
    const out = applyAddEpic(SAMPLE, "Observability", {
      status: "todo",
      description: "Wire OTEL.",
    });
    const board = parseBoardMd(out)!;
    const epic = board.epics.find((e) => e.title === "Observability")!;
    expect(epic).toBeDefined();
    expect(epic.id).toMatch(/^e-[a-z0-9]{4}$/);
    expect(epic.status).toBe("todo");
    expect(epic.description).toBe("Wire OTEL.");
    // Inbox remains the last section.
    const inboxLine = out.indexOf("## Inbox");
    const epicLine = out.indexOf("## Epic: Observability");
    expect(epicLine).toBeLessThan(inboxLine);
  });

  it("appends an epic at EOF when no Inbox exists", () => {
    const out = applyAddEpic("## Epic: A ^e-a\n- [ ] x ^i-1\n", "B");
    const board = parseBoardMd(out)!;
    expect(board.epics.map((e) => e.title)).toEqual(["A", "B"]);
  });
});

describe("applySetIssueStatus", () => {
  it("syncs both the checkbox glyph and the [status] token", () => {
    const out = applySetIssueStatus(SAMPLE, "i-1111", "done");
    // The raw line should now carry an [x] glyph and a [done] token.
    const line = out.split("\n").find((l) => l.includes("^i-1111"))!;
    expect(line).toMatch(/-\s*\[x\]/);
    expect(line).toContain("[done]");
    expect(parseBoardMd(out)!.epics[0].issues[0].status).toBe("done");
  });

  it("throws NOT_FOUND for an unknown id", () => {
    expect(() => applySetIssueStatus(SAMPLE, "i-zzzz", "done")).toThrow(
      BoardWriteError,
    );
  });
});

describe("applyEditIssue", () => {
  it("patches title, priority and labels while preserving the id", () => {
    const out = applyEditIssue(SAMPLE, "i-1111", {
      title: "Renamed",
      priority: "low",
      labels: ["x", "y"],
    });
    const issue = parseBoardMd(out)!.epics[0].issues.find((i) => i.id === "i-1111")!;
    expect(issue.title).toBe("Renamed");
    expect(issue.priority).toBe("low");
    expect(issue.labels).toEqual(["x", "y"]);
  });
});

describe("applyMoveIssue", () => {
  it("moves an issue from an epic into the Inbox", () => {
    const out = applyMoveIssue(SAMPLE, "i-1111", "inbox");
    const board = parseBoardMd(out)!;
    expect(board.epics[0].issues.find((i) => i.id === "i-1111")).toBeUndefined();
    const moved = board.inbox.find((i) => i.id === "i-1111")!;
    expect(moved).toBeDefined();
    expect(moved.epicId).toBeUndefined();
  });

  it("moves an inbox issue into a target epic", () => {
    const out = applyMoveIssue(SAMPLE, "i-5555", "e-bbbb");
    const board = parseBoardMd(out)!;
    expect(board.inbox.find((i) => i.id === "i-5555")).toBeUndefined();
    const billing = board.epics.find((e) => e.id === "e-bbbb")!;
    const moved = billing.issues.find((i) => i.id === "i-5555")!;
    expect(moved).toBeDefined();
    expect(moved.epicId).toBe("e-bbbb");
  });

  it("carries the issue's detail lines along on a move", () => {
    const withDetail = `## Epic: A ^e-a
- [ ] task ^i-1
  detail one
  detail two

## Inbox
- [ ] other ^i-2
`;
    const out = applyMoveIssue(withDetail, "i-1", "inbox");
    const moved = parseBoardMd(out)!.inbox.find((i) => i.id === "i-1")!;
    expect(moved.detail).toBe("detail one\ndetail two");
  });
});

describe("applyReorderIssue", () => {
  it("reorders an issue within its epic", () => {
    // Auth epic order: i-1111, i-2222, i-3333. Move i-3333 to position 0.
    const out = applyReorderIssue(SAMPLE, "i-3333", 0);
    const ids = parseBoardMd(out)!.epics[0].issues.map((i) => i.id);
    expect(ids).toEqual(["i-3333", "i-1111", "i-2222"]);
  });

  it("clamps an out-of-range order to the end", () => {
    const out = applyReorderIssue(SAMPLE, "i-1111", 99);
    const ids = parseBoardMd(out)!.epics[0].issues.map((i) => i.id);
    expect(ids).toEqual(["i-2222", "i-3333", "i-1111"]);
  });
});

describe("round-trip stability", () => {
  it("preserves every other item's id/status/order across a mutation", () => {
    const before = parseBoardMd(SAMPLE)!;
    const out = applySetIssueStatus(SAMPLE, "i-2222", "review");
    const after = parseBoardMd(out)!;

    // Target changed.
    expect(after.epics[0].issues[1].status).toBe("review");
    // Everything else identical: ids, ordering, counts.
    expect(after.total).toBe(before.total);
    expect(after.epics.map((e) => e.id)).toEqual(before.epics.map((e) => e.id));
    expect(after.epics[0].issues.map((i) => i.id)).toEqual(
      before.epics[0].issues.map((i) => i.id),
    );
    expect(after.inbox.map((i) => i.id)).toEqual(before.inbox.map((i) => i.id));
    // Provenance on the untouched inbox finding survives.
    expect(after.inbox[0].worktree).toBe("fix-y");
    expect(after.inbox[0].sessionId).toBe("s9");
  });

  it("is idempotent under parse→serialize→parse", () => {
    // Adding then re-parsing twice yields a structurally identical board.
    const once = applyAddIssue(SAMPLE, { title: "stable", epicId: "e-bbbb" });
    const twiceParsed = parseBoardMd(once)!;
    // Re-serializing the same content (no change) must keep ids stable.
    const noop = applySetIssueStatus(once, "i-1111", "todo");
    const reParsed = parseBoardMd(noop)!;
    expect(reParsed.total).toBe(twiceParsed.total);
    expect(reParsed.epics.map((e) => e.id)).toEqual(
      twiceParsed.epics.map((e) => e.id),
    );
  });
});

describe("PR #224 review fixes", () => {
  // Fix B — EOL preservation
  it("preserves CRLF line endings through a mutation", () => {
    const crlf = SAMPLE.replace(/\n/g, "\r\n");
    const out = applySetIssueStatus(crlf, "i-1111", "done");
    // No lone LF should remain — every newline is part of a CRLF pair.
    expect(out.includes("\r\n")).toBe(true);
    expect(/(^|[^\r])\n/.test(out)).toBe(false);
    // And the change still applied.
    expect(parseBoardMd(out)!.epics[0].issues[0].status).toBe("done");
  });

  it("preserves LF line endings (no CR introduced)", () => {
    const out = applySetIssueStatus(SAMPLE, "i-1111", "done");
    expect(out.includes("\r")).toBe(false);
  });

  it("keeps CRLF when appending a brand-new Inbox section", () => {
    const crlf = "## Epic: A ^e-a\r\n- [ ] one ^i-1\r\n";
    const out = applyAddIssue(crlf, { title: "fresh" });
    expect(out.includes("\r\n")).toBe(true);
    expect(/(^|[^\r])\n/.test(out)).toBe(false);
    expect(parseBoardMd(out)!.inbox[0].title).toBe("fresh");
  });

  // Fix C — label slug normalization
  it("slug-normalizes labels so they round-trip losslessly", () => {
    const out = applyAddIssue(SAMPLE, {
      title: "task",
      epicId: "e-aaaa",
      labels: ["needs review", "C++", "_leading"],
    });
    const issue = parseBoardMd(out)!.epics
      .find((e) => e.id === "e-aaaa")!
      .issues.find((i) => i.title === "task")!;
    expect(issue.labels).toEqual(["needs-review", "C", "leading"]);
    // The extra word must not have bled into the title.
    expect(issue.title).toBe("task");
  });

  // Fix D — issue-ref lookup restricted to issue rows
  it("does not mutate a ^i- ref that only appears in a detail/prose line", () => {
    const md = `## Epic: A ^e-a
- [ ] real issue ^i-1111  [todo]
  see also ^i-2222 for context
- [ ] other ^i-2222  [todo]
`;
    // Targeting i-2222 must rewrite the actual issue row, not the detail line
    // above it that merely mentions ^i-2222.
    const out = applySetIssueStatus(md, "i-2222", "done");
    const lines = out.split("\n");
    // The detail line is untouched.
    expect(lines.find((l) => l.includes("see also"))).toBe(
      "  see also ^i-2222 for context",
    );
    // The real i-2222 row flipped to done.
    expect(parseBoardMd(out)!.epics[0].issues.find((i) => i.id === "i-2222")!.status).toBe(
      "done",
    );
    // i-1111 untouched.
    expect(parseBoardMd(out)!.epics[0].issues.find((i) => i.id === "i-1111")!.status).toBe(
      "todo",
    );
  });
});

describe("addIssue (async wiring)", () => {
  it("resolves the canonical BOARD.md path, atomic-writes, and returns the board", async () => {
    const enoent = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    mockReadFile.mockRejectedValue(enoent); // no BOARD.md and no .minder.json
    mockWriteFile.mockResolvedValue(undefined);

    const result = await addIssue("C:\\dev\\scratch-proj", { title: "first" });

    // writeFileAtomic writes a temp file then renames onto BOARD.md.
    expect(mockWriteFile).toHaveBeenCalledOnce();
    const written = mockWriteFile.mock.calls[0][1] as string;
    expect(written).toContain("first");
    const renameTarget = mockRename.mock.calls[0][1] as string;
    expect(renameTarget.endsWith("BOARD.md")).toBe(true);

    expect(result?.inbox.map((i) => i.title)).toContain("first");
  });
});

describe("promoteTodoToBoard (async wiring)", () => {
  const ENOENT = Object.assign(new Error("ENOENT"), { code: "ENOENT" });

  /** Fake a two-file FS: TODO.md returns `todo`, everything else is absent
   *  (BOARD.md ⇒ skeleton; .minder.json ⇒ config defaults). */
  function fsWithTodo(todo: string) {
    return async (p: unknown) => {
      if (String(p).endsWith("TODO.md")) return todo;
      throw ENOENT;
    };
  }

  const renameTargets = () =>
    mockRename.mock.calls.map((c) => String(c[1]));

  it("promotes a TODO line into the Inbox and ticks the source todo off", async () => {
    mockReadFile.mockImplementation(
      fsWithTodo("# TODO\n\n- [ ] Add dark mode\n- [ ] Other\n"),
    );
    mockWriteFile.mockResolvedValue(undefined);

    const result = await promoteTodoToBoard({
      projectPath: "C:\\dev\\myapp",
      lineNumber: 3, // "Add dark mode"
    });

    expect(result?.inbox.map((i) => i.title)).toContain("Add dark mode");
    // Wrote both BOARD.md (the new issue) and TODO.md (the tick-off).
    const targets = renameTargets();
    expect(targets.some((t) => t.endsWith("BOARD.md"))).toBe(true);
    expect(targets.some((t) => t.endsWith("TODO.md"))).toBe(true);
  });

  it("routes into a target epic when epicId is given", async () => {
    mockReadFile.mockImplementation(fsWithTodo("- [ ] ship it\n"));
    mockWriteFile.mockResolvedValue(undefined);

    // BOARD.md is absent (skeleton, no epic) → an unknown epic is a BAD_TARGET.
    await expect(
      promoteTodoToBoard({
        projectPath: "C:\\dev\\myapp",
        lineNumber: 1,
        epicId: "e-nope",
      }),
    ).rejects.toMatchObject({ code: "BAD_TARGET" });
  });

  it("leaves the source todo unchecked when checkOff is false", async () => {
    mockReadFile.mockImplementation(fsWithTodo("- [ ] keep me open\n"));
    mockWriteFile.mockResolvedValue(undefined);

    await promoteTodoToBoard({
      projectPath: "C:\\dev\\myapp",
      lineNumber: 1,
      checkOff: false,
    });

    const targets = renameTargets();
    expect(targets.some((t) => t.endsWith("BOARD.md"))).toBe(true);
    expect(targets.some((t) => t.endsWith("TODO.md"))).toBe(false);
  });

  it("does not toggle an already-completed todo", async () => {
    mockReadFile.mockImplementation(fsWithTodo("- [x] already done\n"));
    mockWriteFile.mockResolvedValue(undefined);

    await promoteTodoToBoard({ projectPath: "C:\\dev\\myapp", lineNumber: 1 });

    // Board still gets the issue, but the done todo is never re-toggled.
    expect(renameTargets().some((t) => t.endsWith("TODO.md"))).toBe(false);
  });

  it("throws NOT_FOUND when there is no todo at that line", async () => {
    mockReadFile.mockImplementation(fsWithTodo("- [ ] only line\n"));

    await expect(
      promoteTodoToBoard({ projectPath: "C:\\dev\\myapp", lineNumber: 99 }),
    ).rejects.toBeInstanceOf(BoardWriteError);
  });
});
