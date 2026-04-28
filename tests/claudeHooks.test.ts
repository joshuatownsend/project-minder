import { describe, it, expect, vi, beforeEach } from "vitest";
import { extractHookEntries, scanClaudeHooks } from "@/lib/scanner/claudeHooks";

vi.mock("fs", () => ({
  promises: {
    readFile: vi.fn(),
  },
}));

import { promises as fs } from "fs";
const mockReadFile = vi.mocked(fs.readFile);

beforeEach(() => vi.clearAllMocks());

describe("extractHookEntries", () => {
  it("returns empty when input is not an object", () => {
    expect(extractHookEntries(null,      "project", "/x")).toEqual([]);
    expect(extractHookEntries(undefined, "project", "/x")).toEqual([]);
    expect(extractHookEntries("string",  "project", "/x")).toEqual([]);
    expect(extractHookEntries(42,        "project", "/x")).toEqual([]);
  });

  it("parses event groups with matchers and command lists", () => {
    const hooks = {
      PostToolUse: [
        {
          matcher: "Edit|Write",
          hooks: [
            { type: "command", command: "npm run lint" },
            { type: "command", command: "npm test", timeout: 60 },
          ],
        },
      ],
      SessionStart: [
        { hooks: [{ type: "command", command: "echo hi" }] },
      ],
    };

    const result = extractHookEntries(hooks, "project", "/proj/.claude/settings.json");

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      event: "PostToolUse",
      matcher: "Edit|Write",
      source: "project",
      sourcePath: "/proj/.claude/settings.json",
    });
    expect(result[0].commands).toHaveLength(2);
    expect(result[0].commands[1].timeout).toBe(60);
    expect(result[1].event).toBe("SessionStart");
    expect(result[1].matcher).toBeUndefined();
  });

  it("skips entries with no commands", () => {
    const hooks = {
      PreToolUse: [{ matcher: "Bash", hooks: [] }],
    };
    expect(extractHookEntries(hooks, "local", "/x")).toEqual([]);
  });

  it("skips malformed command shapes", () => {
    const hooks = {
      PostToolUse: [
        {
          matcher: "Bash",
          hooks: [
            { type: "command" },                 // missing command string
            { command: "" },                     // empty command
            "not an object",                     // wrong shape
            { type: "command", command: "good" },
          ],
        },
      ],
    };
    const result = extractHookEntries(hooks, "project", "/x");
    expect(result).toHaveLength(1);
    expect(result[0].commands).toHaveLength(1);
    expect(result[0].commands[0].command).toBe("good");
  });

  it("preserves matcher globs as opaque strings", () => {
    const hooks = { PreToolUse: [{ matcher: "Bash(*)", hooks: [{ type: "command", command: "x" }] }] };
    const result = extractHookEntries(hooks, "project", "/x");
    expect(result[0].matcher).toBe("Bash(*)");
  });
});

describe("scanClaudeHooks", () => {
  it("returns undefined when both files are missing", async () => {
    mockReadFile.mockRejectedValue(new Error("ENOENT"));
    const result = await scanClaudeHooks("C:\\dev\\fake");
    expect(result).toBeUndefined();
  });

  it("merges hooks from settings.json and settings.local.json with correct sources", async () => {
    mockReadFile.mockImplementation(async (p) => {
      const pathStr = typeof p === "string" ? p : p.toString();
      if (pathStr.endsWith("settings.json")) {
        return JSON.stringify({
          hooks: { PostToolUse: [{ matcher: "Edit", hooks: [{ type: "command", command: "lint" }] }] },
        });
      }
      if (pathStr.endsWith("settings.local.json")) {
        return JSON.stringify({
          hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "audit" }] }] },
        });
      }
      throw new Error("ENOENT");
    });

    const result = await scanClaudeHooks("C:\\dev\\proj");
    expect(result).toBeDefined();
    expect(result!.entries).toHaveLength(2);
    const sources = result!.entries.map((e) => e.source);
    expect(sources).toContain("project");
    expect(sources).toContain("local");
  });

  it("tolerates JSONC line comments in settings files", async () => {
    mockReadFile.mockImplementation(async (p) => {
      const pathStr = typeof p === "string" ? p : p.toString();
      if (pathStr.endsWith("settings.local.json")) {
        return `{
          // this is a comment
          "hooks": {
            "PostToolUse": [
              { "matcher": "Edit", "hooks": [{ "type": "command", "command": "x" }] }
            ]
          }
        }`;
      }
      throw new Error("ENOENT");
    });

    const result = await scanClaudeHooks("C:\\dev\\proj");
    expect(result?.entries).toHaveLength(1);
  });

  it("returns undefined when files exist but contain no hooks key", async () => {
    mockReadFile.mockImplementation(async (p) => {
      const pathStr = typeof p === "string" ? p : p.toString();
      if (pathStr.endsWith(".json")) return JSON.stringify({ permissions: {} });
      throw new Error("ENOENT");
    });
    const result = await scanClaudeHooks("C:\\dev\\proj");
    expect(result).toBeUndefined();
  });
});
