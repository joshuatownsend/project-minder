import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  parseBoardMd,
  scanBoardMd,
  scanBoardArchive,
} from "@/lib/scanner/boardMd";

// Mock fs so the scan helpers don't hit the real filesystem.
vi.mock("fs", () => ({
  promises: {
    readFile: vi.fn(),
  },
}));

import { promises as fs } from "fs";
const mockReadFile = vi.mocked(fs.readFile);

beforeEach(() => vi.clearAllMocks());

describe("parseBoardMd — structure", () => {
  it("parses an epic with nested issues, extracting IDs/status/priority/labels", () => {
    const md = `# Board — myapp
<!-- minder-board: v1 -->

## Epic: Authentication ^e-a1b2  [doing]  !high  @security
> Ship Clerk auth end to end.
> Second description line.

- [ ] Wire ClerkProvider ^i-c3d4  [todo]  !med  #frontend
- [>] Add middleware ^i-e5f6  [doing]  #backend
- [x] Spike Clerk ^i-g7h8  [done]
`;
    const board = parseBoardMd(md)!;
    expect(board).toBeDefined();
    expect(board.epics).toHaveLength(1);
    expect(board.inbox).toHaveLength(0);

    const epic = board.epics[0];
    expect(epic.id).toBe("e-a1b2");
    expect(epic.title).toBe("Authentication");
    expect(epic.status).toBe("doing");
    expect(epic.priority).toBe("high");
    expect(epic.labels).toEqual(["security"]);
    expect(epic.description).toBe(
      "Ship Clerk auth end to end.\nSecond description line.",
    );
    expect(epic.order).toBe(0);
    expect(epic.issues).toHaveLength(3);

    const [i0, i1, i2] = epic.issues;
    expect(i0).toMatchObject({
      id: "i-c3d4",
      title: "Wire ClerkProvider",
      status: "todo",
      priority: "med",
      labels: ["frontend"],
      epicId: "e-a1b2",
      order: 0,
    });
    expect(i1).toMatchObject({ id: "i-e5f6", status: "doing", order: 1 });
    expect(i2).toMatchObject({ id: "i-g7h8", status: "done", order: 2 });
  });

  it("counts epics + epic issues + inbox issues in total", () => {
    const md = `## Epic: One ^e-1
- [ ] a ^i-1
- [ ] b ^i-2

## Inbox
- [ ] c ^i-3
`;
    const board = parseBoardMd(md)!;
    // 1 epic + 2 epic issues + 1 inbox issue
    expect(board.total).toBe(4);
  });

  it("returns a board for an epic header with no issues", () => {
    const board = parseBoardMd("## Epic: Empty ^e-x  [backlog]\n")!;
    expect(board.epics).toHaveLength(1);
    expect(board.epics[0].issues).toHaveLength(0);
    expect(board.total).toBe(1);
  });
});

describe("parseBoardMd — status derivation", () => {
  it("derives status from the glyph when no [status] token is present", () => {
    const board = parseBoardMd(
      "## Epic: E ^e-1\n- [ ] todo item\n- [>] doing item\n- [x] done item\n",
    )!;
    const [a, b, c] = board.epics[0].issues;
    expect(a.status).toBe("todo");
    expect(b.status).toBe("doing");
    expect(c.status).toBe("done");
  });

  it("lets an explicit [status] token win over the glyph", () => {
    // [x] glyph but [review] token → review (token wins).
    const board = parseBoardMd("## Epic: E ^e-1\n- [x] item ^i-1  [review]\n")!;
    expect(board.epics[0].issues[0].status).toBe("review");
  });

  it("handles an uppercase [X] glyph as done", () => {
    const board = parseBoardMd("## Epic: E ^e-1\n- [X] item\n")!;
    expect(board.epics[0].issues[0].status).toBe("done");
  });
});

describe("parseBoardMd — Inbox", () => {
  it("places Inbox items in inbox with epicId undefined", () => {
    const md = `## Inbox
- [ ] triage me ^i-1  [triage]
`;
    const board = parseBoardMd(md)!;
    expect(board.epics).toHaveLength(0);
    expect(board.inbox).toHaveLength(1);
    expect(board.inbox[0]).toMatchObject({
      id: "i-1",
      title: "triage me",
      status: "triage",
      epicId: undefined,
      order: 0,
    });
  });

  it("keeps the (finding) prefix on agent-pushed inbox lines", () => {
    const md = `## Inbox
- [ ] (finding) Hardcoded secret ^i-1  [triage]  @wt:fix-y  ~session:s9
`;
    const issue = parseBoardMd(md)!.inbox[0];
    expect(issue.title).toBe("(finding) Hardcoded secret");
    expect(issue.worktree).toBe("fix-y");
    expect(issue.sessionId).toBe("s9");
  });

  it("routes issues appearing before any header into the Inbox", () => {
    const board = parseBoardMd("- [ ] orphan item ^i-1\n")!;
    expect(board.inbox).toHaveLength(1);
    expect(board.inbox[0].title).toBe("orphan item");
  });
});

describe("parseBoardMd — provenance and labels", () => {
  it("captures @wt:/~session: provenance and excludes @wt: from labels", () => {
    const md =
      "## Epic: E ^e-1\n- [ ] task ^i-1  #alpha  #beta  @wt:feature-x  ~session:abc123\n";
    const issue = parseBoardMd(md)!.epics[0].issues[0];
    expect(issue.labels).toEqual(["alpha", "beta"]);
    expect(issue.worktree).toBe("feature-x");
    expect(issue.sessionId).toBe("abc123");
    // @wt: is provenance, not a label.
    expect(issue.labels).not.toContain("wt:feature-x");
  });

  it("collects epic @tags into labels but never @wt:", () => {
    const board = parseBoardMd(
      "## Epic: E ^e-1  @security  @wt:should-not-appear\n",
    )!;
    expect(board.epics[0].labels).toEqual(["security"]);
  });
});

describe("parseBoardMd — tolerance of hand edits", () => {
  it("parses a bare `- [ ] thing` with empty id and todo status", () => {
    const board = parseBoardMd("## Epic: E ^e-1\n- [ ] just a title\n")!;
    expect(board.epics[0].issues[0]).toMatchObject({
      id: "",
      title: "just a title",
      status: "todo",
    });
  });

  it("parses an epic with no ID as id ''", () => {
    const board = parseBoardMd("## Epic: No ID Yet\n- [ ] x\n")!;
    expect(board.epics[0].id).toBe("");
    expect(board.epics[0].title).toBe("No ID Yet");
  });

  it("keeps epicId '' (not undefined) for issues under a not-yet-backfilled epic", () => {
    // Regression (PR #224 review): an un-ided epic's id is "", and its issues
    // must NOT have that coerced to undefined — undefined is the Inbox/orphan
    // sentinel, so `epicId !== undefined` must still mean "belongs to an epic".
    const board = parseBoardMd("## Epic: No ID Yet\n- [ ] x\n")!;
    const issue = board.epics[0].issues[0];
    expect(issue.epicId).toBe("");
    expect(issue.epicId).not.toBeUndefined();
  });

  it("attaches indented detail lines to the preceding issue", () => {
    const md = `## Epic: E ^e-1
- [ ] do it ^i-1
  details line one
  details line two
- [ ] next ^i-2
`;
    const [first, second] = parseBoardMd(md)!.epics[0].issues;
    expect(first.detail).toBe("details line one\ndetails line two");
    expect(second.detail).toBeUndefined();
  });

  it("treats a single leading tab as sufficient indentation for a detail line (B8)", () => {
    const md = "## Epic: E ^e-1\n- [ ] do it ^i-1\n\tsingle-tab detail\n";
    const board = parseBoardMd(md)!;
    expect(board.epics[0].issues[0].detail).toBe("single-tab detail");
  });

  it("does not bleed detail across a blank line", () => {
    const md = `## Epic: E ^e-1
- [ ] item ^i-1

  orphaned indented prose
`;
    expect(parseBoardMd(md)!.epics[0].issues[0].detail).toBeUndefined();
  });

  it("returns undefined for an empty or prose-only file", () => {
    expect(parseBoardMd("")).toBeUndefined();
    expect(parseBoardMd("   \n\n  \n")).toBeUndefined();
    expect(
      parseBoardMd("# Board — x\n<!-- minder-board: v1 -->\n\njust prose\n"),
    ).toBeUndefined();
  });

  it("handles CRLF line endings", () => {
    const board = parseBoardMd("## Epic: E ^e-1\r\n- [ ] item ^i-1\r\n")!;
    expect(board.epics[0].issues[0].title).toBe("item");
  });
});

describe("scanBoardMd", () => {
  it("reads BOARD.md and parses it", async () => {
    mockReadFile.mockResolvedValue("## Epic: E ^e-1\n- [ ] item ^i-1\n");
    const board = await scanBoardMd("C:\\dev\\fake");
    expect(mockReadFile).toHaveBeenCalledWith(
      expect.stringMatching(/BOARD\.md$/),
      "utf-8",
    );
    expect(board?.total).toBe(2);
  });

  it("returns undefined when BOARD.md is absent", async () => {
    mockReadFile.mockRejectedValue(new Error("ENOENT"));
    expect(await scanBoardMd("C:\\dev\\fake")).toBeUndefined();
  });
});

describe("scanBoardArchive", () => {
  it("reads BOARD.archive.md, not BOARD.md", async () => {
    mockReadFile.mockResolvedValue("## Epic: Shipped ^e-1\n- [x] done ^i-1\n");
    await scanBoardArchive("C:\\dev\\fake");
    expect(mockReadFile).toHaveBeenCalledWith(
      expect.stringMatching(/BOARD\.archive\.md$/),
      "utf-8",
    );
  });

  it("returns undefined when the archive is absent", async () => {
    mockReadFile.mockRejectedValue(new Error("ENOENT"));
    expect(await scanBoardArchive("C:\\dev\\fake")).toBeUndefined();
  });
});
