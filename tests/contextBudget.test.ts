import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("fs", () => ({
  promises: {
    readFile: vi.fn(),
    readdir: vi.fn(),
    stat: vi.fn(),
  },
}));

vi.mock("os", () => ({
  default: { homedir: () => "C:\\Users\\test" },
  homedir: () => "C:\\Users\\test",
}));

// Stub MCP / catalog so the budget tests stay focused on summing.
vi.mock("@/lib/scanner/mcpServers", () => ({
  scanMcpServers: vi.fn(),
}));

vi.mock("@/lib/indexer/catalog", () => ({
  loadCatalog: vi.fn(),
}));

vi.mock("@/lib/usage/costCalculator", () => ({
  loadPricing: vi.fn(),
  getModelPricing: vi.fn(() => ({
    inputCostPerToken: 0.000003,
    outputCostPerToken: 0.000015,
    cacheWriteCostPerToken: 0.00000375,
    cacheReadCostPerToken: 0.0000003,
  })),
}));

import { promises as fs } from "fs";
import { computeContextBudget, SYSTEM_BASE_TOKENS, MCP_SERVER_TOKENS_EACH, SKILL_TOKENS_EACH, BYTES_PER_TOKEN } from "@/lib/scanner/contextBudget";
import { scanMcpServers } from "@/lib/scanner/mcpServers";
import { loadCatalog } from "@/lib/indexer/catalog";

const mockReadFile = vi.mocked(fs.readFile);
const mockReaddir = vi.mocked(fs.readdir) as unknown as ReturnType<typeof vi.fn>;
const mockScanMcp = vi.mocked(scanMcpServers);
const mockLoadCatalog = vi.mocked(loadCatalog);

// Helper: minimal SkillEntry-shaped fixture for catalog-mocking tests.
type SkillFixture = { source: string; projectSlug?: string; pluginName?: string };
function asSkill(f: SkillFixture): unknown { return f; }

beforeEach(() => {
  vi.clearAllMocks();
  mockReadFile.mockRejectedValue(new Error("ENOENT") as never);
  mockReaddir.mockResolvedValue([]);
  mockScanMcp.mockResolvedValue({ servers: [] });
  mockLoadCatalog.mockResolvedValue({ agents: [], skills: [] });
});

describe("computeContextBudget", () => {
  it("returns the system base alone when nothing else is in scope", async () => {
    const result = await computeContextBudget("C:\\dev\\bare", "bare");
    expect(result.systemBaseTokens).toBe(SYSTEM_BASE_TOKENS);
    expect(result.mcpServerCount).toBe(0);
    expect(result.skillCount).toBe(0);
    expect(result.memoryTokens).toBe(0);
    expect(result.totalTokens).toBe(SYSTEM_BASE_TOKENS);
  });

  it("adds 400 tokens per MCP server", async () => {
    mockScanMcp.mockResolvedValue({
      servers: [
        { name: "fs", transport: "stdio", source: "user", sourcePath: "x" },
        { name: "git", transport: "stdio", source: "project", sourcePath: "y" },
        { name: "search", transport: "http", source: "user", sourcePath: "z" },
      ],
    });
    const result = await computeContextBudget("C:\\dev\\mcp", "mcp");
    expect(result.mcpServerCount).toBe(3);
    expect(result.mcpServerTokens).toBe(3 * MCP_SERVER_TOKENS_EACH);
    expect(result.totalTokens).toBe(SYSTEM_BASE_TOKENS + 3 * MCP_SERVER_TOKENS_EACH);
  });

  it("counts user + plugin + this-project skills", async () => {
    // 2 user-scope, 1 plugin, 1 this-project, 1 different-project (excluded)
    const skills = [
      asSkill({ source: "user", projectSlug: undefined }),
      asSkill({ source: "user", projectSlug: undefined }),
      asSkill({ source: "plugin", pluginName: "p1" }),
      asSkill({ source: "project", projectSlug: "myproj" }),
      asSkill({ source: "project", projectSlug: "other" }),
    ] as Parameters<typeof mockLoadCatalog.mockResolvedValue>[0]["skills"];
    mockLoadCatalog.mockResolvedValue({ agents: [], skills });
    const result = await computeContextBudget("C:\\dev\\myproj", "myproj");
    expect(result.skillCount).toBe(4);
    expect(result.skillTokens).toBe(4 * SKILL_TOKENS_EACH);
    expect(result.detail.skillsBySource.user).toBe(2);
    expect(result.detail.skillsBySource.plugin).toBe(1);
    expect(result.detail.skillsBySource.project).toBe(1);
  });

  it("estimates memory tokens as char_count / 4", async () => {
    const claudeMd = "# Project\n" + "a".repeat(400);
    mockReadFile.mockImplementation(async (p: unknown) => {
      const f = String(p);
      if (f.endsWith("CLAUDE.md") && f.includes("dev")) return claudeMd;
      throw new Error("ENOENT");
    });
    const result = await computeContextBudget("C:\\dev\\mem", "mem");
    expect(result.memoryBytes).toBeGreaterThan(0);
    expect(result.memoryTokens).toBe(Math.round(result.memoryBytes / BYTES_PER_TOKEN));
  });

  it("computes a USD estimate when pricing is available", async () => {
    const result = await computeContextBudget("C:\\dev\\usd", "usd");
    expect(result.estimatedUsd).not.toBeNull();
    // 10,400 tokens at $0.000003 input → ~$0.0312
    expect(result.estimatedUsd!).toBeCloseTo(0.0312, 4);
    expect(result.pricingModel).toBe("claude-sonnet-4-5");
  });

  it("sums system + mcp + skills + memory correctly end-to-end", async () => {
    mockScanMcp.mockResolvedValue({
      servers: [{ name: "x", transport: "stdio", source: "user", sourcePath: "" }],
    });
    const skills = [asSkill({ source: "user" }), asSkill({ source: "plugin" })] as
      Parameters<typeof mockLoadCatalog.mockResolvedValue>[0]["skills"];
    mockLoadCatalog.mockResolvedValue({ agents: [], skills });
    const claudeMd = "x".repeat(800);
    mockReadFile.mockImplementation(async (p: unknown) => {
      const f = String(p);
      if (f.endsWith("CLAUDE.md") && f.includes("dev")) return claudeMd;
      throw new Error("ENOENT");
    });
    const result = await computeContextBudget("C:\\dev\\mix", "mix");
    const expected =
      SYSTEM_BASE_TOKENS +
      1 * MCP_SERVER_TOKENS_EACH +
      2 * SKILL_TOKENS_EACH +
      Math.round(claudeMd.length / BYTES_PER_TOKEN);
    expect(result.totalTokens).toBe(expected);
  });
});
