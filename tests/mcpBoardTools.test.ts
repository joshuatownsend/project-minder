import { describe, it, expect, vi, beforeEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Task } from "@/lib/tasks/types";
import type { BoardInfo, ScanResult } from "@/lib/types";

// Mock the task store so `board_promote_to_task` never opens real SQLite
// (mirrors tests/boardDelegation.test.ts).
vi.mock("@/lib/tasks/store", () => ({
  createTask: vi.fn().mockResolvedValue({ id: 42 }),
}));

// Mock fs so the board reads/writes never touch the real filesystem. The board
// writer / parser / canonicalProjectDir only use these four methods (proven by
// boardWriter.test.ts + boardDelegation.test.ts); anything else stays absent so
// a stray real-disk read would surface as a test failure rather than silently
// hit the developer's machine.
vi.mock("fs", () => ({
  promises: {
    readFile: vi.fn(),
    writeFile: vi.fn(),
    rename: vi.fn(async () => undefined),
    unlink: vi.fn(async () => undefined),
  },
}));

import { promises as fs } from "fs";
import path from "path";
import { createTask } from "@/lib/tasks/store";
import { setCachedScan } from "@/lib/cache";
import { buildMcpServerForTests } from "@/lib/mcp/server";

const mockReadFile = vi.mocked(fs.readFile);
const mockWriteFile = vi.mocked(fs.writeFile);
const mockRename = vi.mocked(fs.rename);
const mockCreateTask = vi.mocked(createTask);

const PROJECT_PATH = "C:\\dev\\myapp";
const ENOENT = Object.assign(new Error("ENOENT"), { code: "ENOENT" });

const BOARD = `# Board — myapp
<!-- minder-board: v1 -->

## Epic: Auth ^e-aaaa  [doing]  !high

- [ ] Wire provider ^i-1111  [todo]  #frontend
- [x] Spike ^i-3333  [done]

## Inbox
- [ ] (finding) leak ^i-5555  [triage]  @wt:fix-y  ~session:s9
`;

/** FS where BOARD.md returns `content` and everything else (.minder.json,
 *  TODO.md, …) is absent so config falls back to defaults. */
function fsWithBoard(content: string) {
  return async (p: unknown) => {
    if (String(p).endsWith("BOARD.md")) return content;
    throw ENOENT;
  };
}

/** Re-seed the scan cache so `findProjectPathBySlug("myapp")` resolves to the
 *  fixture path. Each board tool calls `invalidateCache()` after its write, so
 *  we seed immediately before every tool call. */
function seedScan() {
  setCachedScan({
    projects: [{ slug: "myapp", name: "myapp", path: PROJECT_PATH }],
    portConflicts: [],
    hiddenCount: 0,
    scannedAt: new Date().toISOString(),
    catalogLintFindings: [],
  } as unknown as ScanResult);
}

async function client(): Promise<Client> {
  const server = await buildMcpServerForTests();
  const [c, s] = InMemoryTransport.createLinkedPair();
  await server.connect(s);
  const cl = new Client({ name: "test", version: "0" });
  await cl.connect(c);
  return cl;
}

type ToolResult = {
  isError?: boolean;
  content: Array<{ type: string; text?: string }>;
};

/** Seed the cache, then call a board tool through the MCP JSON-RPC pipe. */
async function callBoard(
  cl: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  seedScan();
  return (await cl.callTool({ name, arguments: args })) as ToolResult;
}

function parseBoard(result: ToolResult): BoardInfo {
  const block = result.content.find((c) => c.type === "text");
  expect(block?.text).toBeDefined();
  return JSON.parse(block!.text!) as BoardInfo;
}

/** Concatenated content of every atomic write (the new BOARD.md bytes). */
const writtenContent = () =>
  mockWriteFile.mock.calls.map((c) => String(c[1])).join("\n");

beforeEach(() => {
  vi.clearAllMocks();
  mockCreateTask.mockResolvedValue({ id: 42 } as Task);
  mockReadFile.mockImplementation(fsWithBoard(BOARD));
  mockWriteFile.mockResolvedValue(undefined);
  mockRename.mockResolvedValue(undefined);
});

describe("board_create_issue", () => {
  it("adds an issue to the Inbox by default", async () => {
    const cl = await client();
    const result = await callBoard(cl, "board_create_issue", {
      slug: "myapp",
      title: "Ship dark mode",
    });
    expect(result.isError).toBeFalsy();

    // The write landed the new issue in BOARD.md…
    expect(writtenContent()).toContain("Ship dark mode");
    // …and the returned re-parsed board carries it in the Inbox.
    const board = parseBoard(result);
    expect(board.inbox.map((i) => i.title)).toContain("Ship dark mode");
  });

  it("routes an issue under a target epic when epicId is given", async () => {
    const cl = await client();
    const result = await callBoard(cl, "board_create_issue", {
      slug: "myapp",
      title: "Add SSO",
      epicId: "e-aaaa",
      priority: "high",
    });
    expect(result.isError).toBeFalsy();
    const board = parseBoard(result);
    const auth = board.epics.find((e) => e.id === "e-aaaa")!;
    const added = auth.issues.find((i) => i.title === "Add SSO")!;
    expect(added).toBeDefined();
    expect(added.priority).toBe("high");
  });
});

describe("board_log_finding", () => {
  it("writes a (finding) Inbox row at triage with @wt:/~session: provenance", async () => {
    const cl = await client();
    const result = await callBoard(cl, "board_log_finding", {
      slug: "myapp",
      finding: "race in cache eviction",
      sessionId: "sess-abc",
      worktree: "fix-cache",
    });
    expect(result.isError).toBeFalsy();

    // The serialized line carries the (finding) prefix, triage status, and both
    // provenance tokens (Phase 1 parser round-trips these).
    const written = writtenContent();
    expect(written).toContain("(finding) race in cache eviction");
    expect(written).toContain("[triage]");
    expect(written).toContain("@wt:fix-cache");
    expect(written).toContain("~session:sess-abc");

    const board = parseBoard(result);
    const logged = board.inbox.find(
      (i) => i.title === "(finding) race in cache eviction",
    )!;
    expect(logged).toBeDefined();
    expect(logged.status).toBe("triage");
    expect(logged.worktree).toBe("fix-cache");
    expect(logged.sessionId).toBe("sess-abc");
  });
});

describe("board_postpone", () => {
  it("snoozes an issue to backlog by default", async () => {
    const cl = await client();
    const result = await callBoard(cl, "board_postpone", {
      slug: "myapp",
      id: "i-1111",
    });
    expect(result.isError).toBeFalsy();
    expect(writtenContent()).toContain("[backlog]");

    const board = parseBoard(result);
    const issue = board.epics[0].issues.find((i) => i.id === "i-1111")!;
    expect(issue.status).toBe("backlog");
  });

  it("honors an explicit status override", async () => {
    const cl = await client();
    const result = await callBoard(cl, "board_postpone", {
      slug: "myapp",
      id: "i-1111",
      status: "review",
    });
    expect(result.isError).toBeFalsy();
    const board = parseBoard(result);
    expect(board.epics[0].issues.find((i) => i.id === "i-1111")!.status).toBe(
      "review",
    );
  });
});

describe("board_promote_to_task", () => {
  it("bridges an issue into a dispatcher task and returns the taskId", async () => {
    const cl = await client();
    const result = await callBoard(cl, "board_promote_to_task", {
      slug: "myapp",
      id: "i-1111",
      assignedSkill: "feature-dev",
      priority: 2,
      riskLevel: "medium",
      sessionId: "sess-xyz",
    });
    expect(result.isError).toBeFalsy();

    const payload = JSON.parse(
      result.content.find((c) => c.type === "text")!.text!,
    ) as { taskId: number };
    expect(payload.taskId).toBe(42);

    // The promote lib was wired through with board provenance in task metadata.
    expect(mockCreateTask).toHaveBeenCalledOnce();
    const call = mockCreateTask.mock.calls[0][0];
    expect(call.quadrant).toBe("delegated-todo");
    expect(call.assigned_skill).toBe("feature-dev");
    expect(call.metadata).toMatchObject({
      sourceType: "board-issue",
      boardIssueId: "i-1111",
      // platform-agnostic: source records path.basename(projectPath), which
      // differs Windows vs POSIX CI for a "C:\..." literal — derive it the same way.
      projectSlug: path.basename("C:\\dev\\myapp"),
      sessionId: "sess-xyz",
    });
  });
});

describe("error surfacing", () => {
  it("returns isError for an unknown slug", async () => {
    const cl = await client();
    const result = await callBoard(cl, "board_create_issue", {
      slug: "definitely-not-a-real-project-zzz",
      title: "orphan",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/No project with slug/);
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it("returns isError (NOT_FOUND) when postponing a missing issue", async () => {
    const cl = await client();
    const result = await callBoard(cl, "board_postpone", {
      slug: "myapp",
      id: "i-9999",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/NOT_FOUND/);
  });

  it("returns isError for an out-of-enum status (rejected at the schema boundary)", async () => {
    const cl = await client();
    // BoardStatusSchema is a Zod enum, so a bad value fails input validation in
    // the SDK before the handler runs — the writer's BAD_VALUE guard is never
    // reached. The SDK surfaces the InvalidParams error as an isError result.
    const result = await callBoard(cl, "board_create_issue", {
      slug: "myapp",
      title: "x",
      status: "blocked",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Invalid arguments|validation|enum/i);
    expect(mockWriteFile).not.toHaveBeenCalled();
  });
});
