import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("fs", () => ({
  promises: {
    readdir: vi.fn(),
    readFile: vi.fn(),
  },
  readdirSync: vi.fn(),
  readFileSync: vi.fn(),
}));

vi.mock("os", () => ({
  default: { homedir: () => "/home/user" },
  homedir: () => "/home/user",
}));

import path from "path";
import { promises as mockFs, readdirSync as mockReaddirSyncImport, readFileSync as mockReadFileSyncImport } from "fs";
import { readSubagentMeta, readSubagentMetaSync, categorize } from "@/lib/scanner/subagentMeta";

const readdir = vi.mocked(mockFs.readdir);
const readFile = vi.mocked(mockFs.readFile);
const readdirSync = vi.mocked(mockReaddirSyncImport);
const readFileSync = vi.mocked(mockReadFileSyncImport);

const BASE = path.join("home", "user", ".claude", "projects", "C--dev-foo");
const SESSION_JSONL = path.join(BASE, "abc123.jsonl");
const SUBAGENTS_DIR = path.join(BASE, "abc123", "subagents");

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── categorize ───────────────────────────────────────────────────────────────

describe("categorize", () => {
  it.each([
    ["Fix broken tests", "fix"],
    ["Repair the auth flow", "fix"],
    ["Resolve merge conflicts", "fix"],
    ["Find all usages of X", "find"],
    ["Locate the config file", "find"],
    ["Search for dead code", "find"],
    ["Check for memory leaks", "check"],
    ["Verify the migration", "check"],
    ["Validate form inputs", "check"],
    ["Audit permissions", "check"],
    ["Get the list of routes", "query"],
    ["Fetch user records", "query"],
    ["Read the config", "query"],
    ["List all agents", "query"],
    ["Query the database", "query"],
    ["Research OAuth options", "research"],
    ["Investigate the crash", "research"],
    ["Explore the codebase", "research"],
    ["Analyze performance", "research"],
    ["Create a new component", "create"],
    ["Build the login page", "create"],
    ["Add a new route", "create"],
    ["Implement pagination", "create"],
    ["Generate the schema", "create"],
    ["Write unit tests", "create"],
    ["Deep-dive analysis", "other"],
    [undefined, "other"],
    ["", "other"],
  ] as const)('categorize("%s") → "%s"', (input, expected) => {
    expect(categorize(input as string | undefined)).toBe(expected);
  });
});

// ─── readSubagentMeta ─────────────────────────────────────────────────────────

describe("readSubagentMeta", () => {
  it("returns empty map when subagents dir does not exist", async () => {
    readdir.mockRejectedValue(
      Object.assign(new Error("ENOENT"), { code: "ENOENT" })
    );
    const result = await readSubagentMeta(SESSION_JSONL);
    expect(result.size).toBe(0);
  });

  it("returns empty map when subagents dir is empty", async () => {
    readdir.mockResolvedValue([] as never);
    const result = await readSubagentMeta(SESSION_JSONL);
    expect(result.size).toBe(0);
  });

  it("skips files that are not agent-*.meta.json", async () => {
    readdir.mockResolvedValue([
      "README.txt",
      "data.json",
      "agent-123.log",
    ] as never);
    const result = await readSubagentMeta(SESSION_JSONL);
    expect(result.size).toBe(0);
    expect(readFile).not.toHaveBeenCalled();
  });

  it("skips malformed JSON without throwing", async () => {
    readdir.mockResolvedValue(["agent-abc.meta.json"] as never);
    readFile.mockResolvedValue("{ invalid json !!" as never);
    const result = await readSubagentMeta(SESSION_JSONL);
    expect(result.size).toBe(0);
  });

  it("skips meta file with no description field", async () => {
    readdir.mockResolvedValue(["agent-abc.meta.json"] as never);
    readFile.mockResolvedValue(
      JSON.stringify({ agentType: "general-purpose" }) as never
    );
    const result = await readSubagentMeta(SESSION_JSONL);
    expect(result.size).toBe(0);
  });

  it("parses a well-formed meta file and keys by description", async () => {
    readdir.mockResolvedValue(["agent-a4160e1e125348341.meta.json"] as never);
    readFile.mockResolvedValue(
      JSON.stringify({
        agentType: "Explore",
        description: "Explore existing cross-project page patterns",
      }) as never
    );
    const result = await readSubagentMeta(SESSION_JSONL);
    expect(result.size).toBe(1);
    const meta = result.get("Explore existing cross-project page patterns");
    expect(meta).toBeDefined();
    expect(meta!.agentType).toBe("Explore");
    expect(meta!.category).toBe("research");
    expect(meta!.metaSourced).toBe(true);
    expect(meta!.description).toBe(
      "Explore existing cross-project page patterns"
    );
  });

  it("parses multiple meta files including one without description", async () => {
    readdir.mockResolvedValue([
      "agent-111.meta.json",
      "agent-222.meta.json",
      "agent-333.meta.json",
    ] as never);
    readFile
      .mockResolvedValueOnce(
        JSON.stringify({
          agentType: "Explore",
          description: "Find broken imports",
        }) as never
      )
      .mockResolvedValueOnce(
        JSON.stringify({ agentType: "general-purpose" }) as never // no description
      )
      .mockResolvedValueOnce(
        JSON.stringify({
          agentType: "Plan",
          description: "Build the new auth flow",
          turnCount: 14,
        }) as never
      );
    const result = await readSubagentMeta(SESSION_JSONL);
    expect(result.size).toBe(2);
    expect(result.get("Find broken imports")?.category).toBe("find");
    expect(result.get("Build the new auth flow")?.category).toBe("create");
    expect(result.get("Build the new auth flow")?.turnCount).toBe(14);
  });

  it("skips individual files that fail to read without aborting others", async () => {
    readdir.mockResolvedValue([
      "agent-111.meta.json",
      "agent-222.meta.json",
    ] as never);
    readFile
      .mockRejectedValueOnce(new Error("EACCES permission denied"))
      .mockResolvedValueOnce(
        JSON.stringify({
          agentType: "Explore",
          description: "Analyze the log",
        }) as never
      );
    const result = await readSubagentMeta(SESSION_JSONL);
    expect(result.size).toBe(1);
    expect(result.has("Analyze the log")).toBe(true);
  });

  it("derives subagents dir correctly from session jsonl path", async () => {
    readdir.mockResolvedValue([] as never);
    await readSubagentMeta(SESSION_JSONL);
    expect(readdir).toHaveBeenCalledWith(SUBAGENTS_DIR);
  });
});

// ─── readSubagentMetaSync ─────────────────────────────────────────────────────

describe("readSubagentMetaSync", () => {
  it("returns empty map when subagents dir does not exist (ENOENT)", () => {
    readdirSync.mockImplementation(() => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });
    expect(readSubagentMetaSync(SESSION_JSONL).size).toBe(0);
  });

  it("returns empty map when subagents dir is empty", () => {
    readdirSync.mockReturnValue([] as never);
    expect(readSubagentMetaSync(SESSION_JSONL).size).toBe(0);
  });

  it("skips files that are not agent-*.meta.json", () => {
    readdirSync.mockReturnValue(["README.txt", "data.json"] as never);
    const result = readSubagentMetaSync(SESSION_JSONL);
    expect(result.size).toBe(0);
    expect(readFileSync).not.toHaveBeenCalled();
  });

  it("skips malformed JSON without throwing", () => {
    readdirSync.mockReturnValue(["agent-abc.meta.json"] as never);
    readFileSync.mockReturnValue("{ bad json !!" as never);
    expect(readSubagentMetaSync(SESSION_JSONL).size).toBe(0);
  });

  it("skips meta file with no description field", () => {
    readdirSync.mockReturnValue(["agent-abc.meta.json"] as never);
    readFileSync.mockReturnValue(JSON.stringify({ agentType: "Explore" }) as never);
    expect(readSubagentMetaSync(SESSION_JSONL).size).toBe(0);
  });

  it("parses a well-formed meta file and keys by description", () => {
    readdirSync.mockReturnValue(["agent-a4160e1e.meta.json"] as never);
    readFileSync.mockReturnValue(
      JSON.stringify({ agentType: "Plan", description: "Build the login page" }) as never
    );
    const result = readSubagentMetaSync(SESSION_JSONL);
    expect(result.size).toBe(1);
    const meta = result.get("Build the login page");
    expect(meta).toBeDefined();
    expect(meta!.agentType).toBe("Plan");
    expect(meta!.category).toBe("create");
    expect(meta!.metaSourced).toBe(true);
  });

  it("continues after a file read failure, returning other valid entries", () => {
    readdirSync.mockReturnValue([
      "agent-111.meta.json",
      "agent-222.meta.json",
    ] as never);
    readFileSync
      .mockImplementationOnce(() => { throw new Error("EACCES"); })
      .mockReturnValueOnce(
        JSON.stringify({ description: "Analyze the log", agentType: "Explore" }) as never
      );
    const result = readSubagentMetaSync(SESSION_JSONL);
    expect(result.size).toBe(1);
    expect(result.has("Analyze the log")).toBe(true);
  });

  it("derives subagents dir correctly from session jsonl path", () => {
    readdirSync.mockReturnValue([] as never);
    readSubagentMetaSync(SESSION_JSONL);
    expect(readdirSync).toHaveBeenCalledWith(SUBAGENTS_DIR);
  });
});
