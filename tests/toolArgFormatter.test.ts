import { describe, it, expect } from "vitest";
import { formatToolArgs } from "@/lib/usage/toolArgFormatter";

describe("formatToolArgs", () => {
  it("formats Bash command", () => {
    const result = formatToolArgs("Bash", { command: "npm run test" });
    expect(result.kind).toBe("command");
    expect(result.content).toBe("npm run test");
    expect(result.preview).toBe("npm run test");
  });

  it("truncates long Bash command in preview", () => {
    const longCmd = "a".repeat(100);
    const result = formatToolArgs("Bash", { command: longCmd });
    expect(result.preview.length).toBe(80);
    expect(result.preview.endsWith("…")).toBe(true);
    expect(result.content).toBe(longCmd);
  });

  it("formats PowerShell as command", () => {
    const result = formatToolArgs("PowerShell", { command: "Get-Process" });
    expect(result.kind).toBe("command");
  });

  it("formats Read as file-path", () => {
    const result = formatToolArgs("Read", { file_path: "/src/lib/foo.ts" });
    expect(result.kind).toBe("file-path");
    expect(result.content).toBe("/src/lib/foo.ts");
  });

  it("formats Write as file-path", () => {
    const result = formatToolArgs("Write", { file_path: "/tmp/out.txt" });
    expect(result.kind).toBe("file-path");
  });

  it("formats Edit as edit-diff with +/- lines", () => {
    const result = formatToolArgs("Edit", {
      file_path: "src/foo.ts",
      old_string: "const x = 1;",
      new_string: "const x = 2;",
    });
    expect(result.kind).toBe("edit-diff");
    expect(result.content).toContain("- const x = 1;");
    expect(result.content).toContain("+ const x = 2;");
    expect(result.content).toContain("--- src/foo.ts");
  });

  it("formats MultiEdit as edit-diff", () => {
    const result = formatToolArgs("MultiEdit", {
      file_path: "x.ts",
      old_string: "a",
      new_string: "b",
    });
    expect(result.kind).toBe("edit-diff");
  });

  it("returns json kind for unknown tools", () => {
    const result = formatToolArgs("WebFetch", { url: "https://example.com" });
    expect(result.kind).toBe("json");
    expect(result.content).toContain("example.com");
  });

  it("handles null args gracefully", () => {
    const result = formatToolArgs("Bash", null);
    expect(result.kind).toBe("json");
    expect(result.preview).toBe("(no args)");
  });
});
