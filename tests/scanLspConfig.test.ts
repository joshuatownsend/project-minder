import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("fs", () => ({
  promises: {
    readFile: vi.fn(),
  },
}));

import { promises as fs } from "fs";
import { scanLspConfig } from "@/lib/scanner/lspConfig";

const mockReadFile = vi.mocked(fs.readFile);

beforeEach(() => vi.clearAllMocks());

describe("scanLspConfig", () => {
  it("returns undefined when .claude/lsp.json does not exist", async () => {
    mockReadFile.mockRejectedValueOnce(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
    expect(await scanLspConfig("/proj")).toBeUndefined();
  });

  it("returns undefined when lsp.json contains invalid JSON", async () => {
    mockReadFile.mockResolvedValueOnce("not json {{{" as never);
    expect(await scanLspConfig("/proj")).toBeUndefined();
  });

  it("returns undefined when lsp.json parses to a non-object (array)", async () => {
    mockReadFile.mockResolvedValueOnce('["a","b"]' as never);
    expect(await scanLspConfig("/proj")).toBeUndefined();
  });

  it("returns LspConfigInfo with sourcePath and parsed config", async () => {
    const content = JSON.stringify({ typescript: { command: "typescript-language-server", args: ["--stdio"] } });
    mockReadFile.mockResolvedValueOnce(content as never);

    const result = await scanLspConfig("/proj");
    expect(result).not.toBeUndefined();
    expect(result!.sourcePath).toContain("lsp.json");
    expect(result!.config).toHaveProperty("typescript");
  });

  it("tolerates JSON with comments (JSONC format)", async () => {
    const content = `{
  // TypeScript LSP
  "typescript": { "command": "typescript-language-server" }
}`;
    mockReadFile.mockResolvedValueOnce(content as never);

    const result = await scanLspConfig("/proj");
    expect(result).not.toBeUndefined();
    expect(result!.config).toHaveProperty("typescript");
  });

  it("sets sourcePath to the absolute path of lsp.json", async () => {
    mockReadFile.mockResolvedValueOnce('{"go": {}}' as never);

    const result = await scanLspConfig("/my/project");
    expect(result!.sourcePath).toContain(".claude");
    expect(result!.sourcePath).toContain("lsp.json");
  });
});
