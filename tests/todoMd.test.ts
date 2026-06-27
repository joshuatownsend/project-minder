import { describe, it, expect, vi, beforeEach } from "vitest";
import { scanTodoMd, scanTodoArchive, parseTodoMd } from "@/lib/scanner/todoMd";

// Mock fs so we don't hit the real filesystem
vi.mock("fs", () => ({
  promises: {
    readFile: vi.fn(),
  },
}));

import { promises as fs } from "fs";
const mockReadFile = vi.mocked(fs.readFile);

beforeEach(() => vi.clearAllMocks());

describe("scanTodoMd", () => {
  it("returns undefined when file does not exist", async () => {
    mockReadFile.mockRejectedValue(new Error("ENOENT"));
    const result = await scanTodoMd("C:\\dev\\fake-project");
    expect(result).toBeUndefined();
  });

  it("returns undefined for empty file", async () => {
    mockReadFile.mockResolvedValue("# TODO\n\nNothing here yet.\n");
    const result = await scanTodoMd("C:\\dev\\fake-project");
    expect(result).toBeUndefined();
  });

  it("parses pending and completed items", async () => {
    mockReadFile.mockResolvedValue(
      "# TODO\n\n- [ ] Fix bug\n- [x] Write tests\n- [ ] Deploy\n"
    );
    const result = await scanTodoMd("C:\\dev\\fake-project");
    expect(result).toEqual({
      total: 3,
      completed: 1,
      pending: 2,
      items: [
        { text: "Fix bug", completed: false, lineNumber: 3 },
        { text: "Write tests", completed: true, lineNumber: 4 },
        { text: "Deploy", completed: false, lineNumber: 5 },
      ],
    });
  });

  it("handles uppercase [X] as completed", async () => {
    mockReadFile.mockResolvedValue("- [X] Done item\n");
    const result = await scanTodoMd("C:\\dev\\fake-project");
    expect(result).toEqual({
      total: 1,
      completed: 1,
      pending: 0,
      items: [{ text: "Done item", completed: true, lineNumber: 1 }],
    });
  });

  it("ignores non-checkbox lines", async () => {
    mockReadFile.mockResolvedValue(
      "# TODO\n\nSome description\n\n- [ ] Real item\n- Not a checkbox\n"
    );
    const result = await scanTodoMd("C:\\dev\\fake-project");
    expect(result).toEqual({
      total: 1,
      completed: 0,
      pending: 1,
      items: [{ text: "Real item", completed: false, lineNumber: 5 }],
    });
  });
});

describe("parseTodoMd", () => {
  it("parses checkbox content directly (no fs)", () => {
    expect(parseTodoMd("- [ ] a\n- [x] b\n")).toEqual({
      total: 2,
      completed: 1,
      pending: 1,
      items: [
        { text: "a", completed: false, lineNumber: 1 },
        { text: "b", completed: true, lineNumber: 2 },
      ],
    });
  });

  it("returns undefined when there are no items", () => {
    expect(parseTodoMd("# TODO\n\njust prose\n")).toBeUndefined();
  });
});

describe("scanTodoArchive", () => {
  it("reads TODO.archive.md, not TODO.md", async () => {
    mockReadFile.mockResolvedValue("- [x] Shipped feature\n");
    const result = await scanTodoArchive("C:\\dev\\fake-project");
    expect(mockReadFile).toHaveBeenCalledWith(
      expect.stringMatching(/TODO\.archive\.md$/),
      "utf-8"
    );
    expect(result).toEqual({
      total: 1,
      completed: 1,
      pending: 0,
      items: [{ text: "Shipped feature", completed: true, lineNumber: 1 }],
    });
  });

  it("returns undefined when the archive does not exist", async () => {
    mockReadFile.mockRejectedValue(new Error("ENOENT"));
    expect(await scanTodoArchive("C:\\dev\\fake-project")).toBeUndefined();
  });
});
