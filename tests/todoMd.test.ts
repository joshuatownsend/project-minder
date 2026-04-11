import { describe, it, expect, vi, beforeEach } from "vitest";
import { scanTodoMd } from "@/lib/scanner/todoMd";

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
        { text: "Fix bug", completed: false },
        { text: "Write tests", completed: true },
        { text: "Deploy", completed: false },
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
      items: [{ text: "Done item", completed: true }],
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
      items: [{ text: "Real item", completed: false }],
    });
  });
});
