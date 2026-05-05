import { describe, it, expect } from "vitest";
import { extractFileEdits, extractWriteEdits } from "@/lib/usage/fileActivity";
import type { UsageTurn } from "@/lib/usage/types";

function makeTurn(overrides: Partial<UsageTurn>): UsageTurn {
  return {
    timestamp: "2024-01-01T00:00:00.000Z",
    sessionId: "sess-1",
    projectSlug: "my-project",
    projectDirName: "C--dev-my-project",
    model: "claude-opus-4-5",
    role: "assistant",
    inputTokens: 100,
    outputTokens: 50,
    cacheCreateTokens: 0,
    cacheReadTokens: 0,
    toolCalls: [],
    ...overrides,
  };
}

describe("extractFileEdits", () => {
  it("extracts all file ops from assistant turns", () => {
    const turns: UsageTurn[] = [
      makeTurn({
        toolCalls: [
          { name: "Read", arguments: { file_path: "src/a.ts" } },
          { name: "Edit", arguments: { file_path: "src/b.ts" } },
        ],
      }),
    ];
    const edits = extractFileEdits(turns);
    expect(edits).toHaveLength(2);
    expect(edits[0]).toMatchObject({ filePath: "src/a.ts", op: "read" });
    expect(edits[1]).toMatchObject({ filePath: "src/b.ts", op: "edit" });
  });

  it("skips user turns", () => {
    const turns: UsageTurn[] = [
      makeTurn({
        role: "user",
        toolCalls: [{ name: "Edit", arguments: { file_path: "src/a.ts" } }],
      }),
    ];
    expect(extractFileEdits(turns)).toHaveLength(0);
  });

  it("skips tool calls with no file_path argument", () => {
    const turns: UsageTurn[] = [
      makeTurn({
        toolCalls: [
          { name: "Edit", arguments: { path: "src/a.ts" } }, // wrong key — must be ignored
          { name: "Edit" }, // no arguments at all
        ],
      }),
    ];
    expect(extractFileEdits(turns)).toHaveLength(0);
  });

  it("skips unknown tool names", () => {
    const turns: UsageTurn[] = [
      makeTurn({
        toolCalls: [{ name: "Bash", arguments: { file_path: "src/a.ts" } }],
      }),
    ];
    expect(extractFileEdits(turns)).toHaveLength(0);
  });

  it("handles MultiEdit and NotebookEdit as edit ops", () => {
    const turns: UsageTurn[] = [
      makeTurn({
        toolCalls: [
          { name: "MultiEdit", arguments: { file_path: "src/a.ts" } },
          { name: "NotebookEdit", arguments: { file_path: "nb.ipynb" } },
        ],
      }),
    ];
    const edits = extractFileEdits(turns);
    expect(edits).toHaveLength(2);
    expect(edits[0].op).toBe("edit");
    expect(edits[1].op).toBe("edit");
  });

  it("populates sessionId and turnIndex correctly", () => {
    const turns: UsageTurn[] = [
      makeTurn({ sessionId: "s1", toolCalls: [] }),
      makeTurn({
        sessionId: "s1",
        toolCalls: [{ name: "Write", arguments: { file_path: "src/x.ts" } }],
      }),
    ];
    const edits = extractFileEdits(turns);
    expect(edits[0].sessionId).toBe("s1");
    expect(edits[0].turnIndex).toBe(1);
  });
});

describe("extractWriteEdits", () => {
  it("excludes read ops", () => {
    const turns: UsageTurn[] = [
      makeTurn({
        toolCalls: [
          { name: "Read", arguments: { file_path: "src/a.ts" } },
          { name: "Write", arguments: { file_path: "src/b.ts" } },
        ],
      }),
    ];
    const edits = extractWriteEdits(turns);
    expect(edits).toHaveLength(1);
    expect(edits[0].op).toBe("write");
  });
});
