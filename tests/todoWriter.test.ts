import { describe, it, expect, vi, beforeEach } from "vitest";
import { setTodoCheckedInFile } from "@/lib/todoWriter";

// Mock fs so the writer never touches the real filesystem. writeFileAtomic
// writes a temp file then renames; both are observed here.
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

const ENOENT = Object.assign(new Error("ENOENT"), { code: "ENOENT" });

/** TODO.md returns `todo`; config/other reads are absent (config defaults). */
function fsWithTodo(todo: string) {
  return async (p: unknown) => {
    if (String(p).endsWith("TODO.md")) return todo;
    throw ENOENT;
  };
}

beforeEach(() => vi.clearAllMocks());

describe("setTodoCheckedInFile", () => {
  it("checks an unchecked line (writes [x])", async () => {
    mockReadFile.mockImplementation(fsWithTodo("# TODO\n\n- [ ] task\n"));
    mockWriteFile.mockResolvedValue(undefined);

    await setTodoCheckedInFile("C:\\dev\\x", 3, true);

    expect(mockWriteFile).toHaveBeenCalledOnce();
    const written = mockWriteFile.mock.calls[0][1] as string;
    expect(written).toContain("- [x] task");
  });

  it("is a no-op when the line is already checked (idempotent)", async () => {
    // The promote path's reason for set-not-toggle: a second concurrent promote
    // sees [x] and must leave it [x], never flip it back open.
    mockReadFile.mockImplementation(fsWithTodo("# TODO\n\n- [x] task\n"));

    await setTodoCheckedInFile("C:\\dev\\x", 3, true);

    expect(mockWriteFile).not.toHaveBeenCalled();
    expect(mockRename).not.toHaveBeenCalled();
  });

  it("unchecks a checked line when checked=false", async () => {
    mockReadFile.mockImplementation(fsWithTodo("# TODO\n\n- [x] task\n"));
    mockWriteFile.mockResolvedValue(undefined);

    await setTodoCheckedInFile("C:\\dev\\x", 3, false);

    const written = mockWriteFile.mock.calls[0][1] as string;
    expect(written).toContain("- [ ] task");
  });

  it("ignores a line that is not a checkbox", async () => {
    mockReadFile.mockImplementation(fsWithTodo("# TODO\n\nplain prose\n"));

    await setTodoCheckedInFile("C:\\dev\\x", 3, true);

    expect(mockWriteFile).not.toHaveBeenCalled();
  });
});
