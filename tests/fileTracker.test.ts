import { describe, it, expect } from "vitest";
import { buildHotFiles } from "@/lib/usage/fileTracker";
import type { UsageTurn } from "@/lib/usage/types";

function makeTurn(
  sessionId: string,
  toolCalls: { name: string; file_path: string }[],
  ts = "2024-01-01T00:00:00.000Z"
): UsageTurn {
  return {
    timestamp: ts,
    sessionId,
    projectSlug: "proj",
    projectDirName: "C--dev-proj",
    model: "claude-opus-4-5",
    role: "assistant",
    inputTokens: 0,
    outputTokens: 0,
    cacheCreateTokens: 0,
    cacheReadTokens: 0,
    toolCalls: toolCalls.map((tc) => ({ name: tc.name, arguments: { file_path: tc.file_path } })),
  };
}

describe("buildHotFiles", () => {
  it("ranks files by edit count descending", () => {
    const turns = [
      makeTurn("s1", [
        { name: "Edit", file_path: "a.ts" },
        { name: "Edit", file_path: "a.ts" },
        { name: "Edit", file_path: "b.ts" },
      ]),
    ];
    const { hotFiles } = buildHotFiles(turns);
    expect(hotFiles[0].filePath).toBe("a.ts");
    expect(hotFiles[0].editCount).toBe(2);
    expect(hotFiles[1].filePath).toBe("b.ts");
  });

  it("counts sessions separately from total edits", () => {
    const turns = [
      makeTurn("s1", [{ name: "Edit", file_path: "a.ts" }]),
      makeTurn("s2", [{ name: "Edit", file_path: "a.ts" }]),
    ];
    const { hotFiles } = buildHotFiles(turns);
    expect(hotFiles[0].editCount).toBe(2);
    expect(hotFiles[0].sessionCount).toBe(2);
  });

  it("breaks down ops by type", () => {
    const turns = [
      makeTurn("s1", [
        { name: "Write", file_path: "a.ts" },
        { name: "Edit", file_path: "a.ts" },
        { name: "Edit", file_path: "a.ts" },
      ]),
    ];
    const { hotFiles } = buildHotFiles(turns);
    expect(hotFiles[0].ops).toEqual({ write: 1, edit: 2 });
  });

  it("excludes Read ops from hot files", () => {
    const turns = [
      makeTurn("s1", [
        { name: "Read", file_path: "a.ts" },
        { name: "Edit", file_path: "b.ts" },
      ]),
    ];
    const { hotFiles, totalEdits } = buildHotFiles(turns);
    expect(hotFiles).toHaveLength(1);
    expect(hotFiles[0].filePath).toBe("b.ts");
    expect(totalEdits).toBe(1);
  });

  it("respects the limit parameter", () => {
    const toolCalls = Array.from({ length: 10 }, (_, i) => ({
      name: "Edit",
      file_path: `file${i}.ts`,
    }));
    const turns = [makeTurn("s1", toolCalls)];
    const { hotFiles, totalFiles } = buildHotFiles(turns, 5);
    expect(hotFiles).toHaveLength(5);
    expect(totalFiles).toBe(10);
  });

  it("tracks lastEditTs as the latest timestamp", () => {
    const turns = [
      makeTurn("s1", [{ name: "Edit", file_path: "a.ts" }], "2024-01-01T00:00:00.000Z"),
      makeTurn("s2", [{ name: "Edit", file_path: "a.ts" }], "2024-02-01T00:00:00.000Z"),
    ];
    const { hotFiles } = buildHotFiles(turns);
    expect(hotFiles[0].lastEditTs).toBe("2024-02-01T00:00:00.000Z");
  });

  it("returns zero totals for empty turns", () => {
    const { hotFiles, totalFiles, totalEdits } = buildHotFiles([]);
    expect(hotFiles).toHaveLength(0);
    expect(totalFiles).toBe(0);
    expect(totalEdits).toBe(0);
  });
});
