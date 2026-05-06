import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock fs and costCalculator so tests run without touching disk or network
vi.mock("fs", () => ({
  promises: {
    readdir: vi.fn(),
    readFile: vi.fn(),
  },
}));

vi.mock("@/lib/usage/costCalculator", () => ({
  getModelPricing: vi.fn(() => ({
    inputCostPerToken: 0.000003,
    outputCostPerToken: 0.000015,
    cacheWriteCostPerToken: 0.00000375,
    cacheReadCostPerToken: 0.0000003,
  })),
  applyPricing: vi.fn(
    (
      pricing: { inputCostPerToken: number; outputCostPerToken: number; cacheWriteCostPerToken: number; cacheReadCostPerToken: number },
      tokens: { inputTokens: number; outputTokens: number; cacheCreateTokens: number; cacheReadTokens: number }
    ) =>
      tokens.inputTokens * pricing.inputCostPerToken +
      tokens.outputTokens * pricing.outputCostPerToken +
      tokens.cacheCreateTokens * pricing.cacheWriteCostPerToken +
      tokens.cacheReadTokens * pricing.cacheReadCostPerToken
  ),
}));

import { promises as fs } from "fs";
import { computeAgentCostFromFiles } from "@/lib/usage/agentCost";

const mockReaddir = vi.mocked(fs.readdir);
const mockReadFile = vi.mocked(fs.readFile);

beforeEach(() => {
  vi.clearAllMocks();
  // Reset the globalThis TTL cache so each test starts from a clean slate
  (globalThis as Record<string, unknown>).__agentCostCache = undefined;
});

function buildJsonl(entries: object[]): string {
  return entries.map((e) => JSON.stringify(e)).join("\n");
}

describe("computeAgentCostFromFiles", () => {
  it("returns empty map when projects dir does not exist", async () => {
    mockReaddir.mockRejectedValue(new Error("ENOENT"));
    const result = await computeAgentCostFromFiles();
    expect(result.size).toBe(0);
  });

  it("attributes sidechain cost to the correct agent via parentToolUseID", async () => {
    const taskToolUseId = "tu-abc123";
    const agentName = "code-architect";

    const mainEntry = {
      type: "assistant",
      isSidechain: false,
      message: {
        model: "claude-opus-4-7",
        content: [
          {
            type: "tool_use",
            name: "Agent",
            id: taskToolUseId,
            input: { subagent_type: agentName },
          },
        ],
        usage: { input_tokens: 100, output_tokens: 50 },
      },
    };

    const sidechainEntry = {
      type: "assistant",
      isSidechain: true,
      parentToolUseID: taskToolUseId,
      message: {
        model: "claude-opus-4-7",
        content: [],
        usage: { input_tokens: 200, output_tokens: 300 },
      },
    };

    const jsonl = buildJsonl([mainEntry, sidechainEntry]);

    mockReaddir.mockImplementation(async (p: unknown) => {
      const dir = p as string;
      if (dir.endsWith("projects")) return ["my-project"] as any;
      return ["session1.jsonl"] as any;
    });
    mockReadFile.mockResolvedValue(jsonl as any);

    const result = await computeAgentCostFromFiles();
    expect(result.has(agentName)).toBe(true);
    const entry = result.get(agentName)!;
    expect(entry.inputTokens).toBe(200);
    expect(entry.outputTokens).toBe(300);
    expect(entry.costUsd).toBeGreaterThan(0);
  });

  it("buckets orphaned sidechain turns as 'unknown'", async () => {
    const sidechainEntry = {
      type: "assistant",
      isSidechain: true,
      parentToolUseID: "nonexistent-id",
      message: {
        model: "claude-sonnet-4-6",
        content: [],
        usage: { input_tokens: 50, output_tokens: 80 },
      },
    };

    mockReaddir.mockImplementation(async (p: unknown) => {
      const dir = p as string;
      if (dir.endsWith("projects")) return ["my-project"] as any;
      return ["session1.jsonl"] as any;
    });
    mockReadFile.mockResolvedValue(buildJsonl([sidechainEntry]) as any);

    const result = await computeAgentCostFromFiles();
    expect(result.has("unknown")).toBe(true);
    expect(result.get("unknown")!.inputTokens).toBe(50);
  });

  it("accumulates cost across multiple sessions for the same agent", async () => {
    const taskId1 = "tu-111";
    const taskId2 = "tu-222";
    const agentName = "test-agent";

    const session1 = buildJsonl([
      {
        type: "assistant",
        isSidechain: false,
        message: {
          model: "claude-opus-4-7",
          content: [{ type: "tool_use", name: "Agent", id: taskId1, input: { subagent_type: agentName } }],
          usage: { input_tokens: 10, output_tokens: 10 },
        },
      },
      {
        type: "assistant",
        isSidechain: true,
        parentToolUseID: taskId1,
        message: { model: "claude-opus-4-7", content: [], usage: { input_tokens: 100, output_tokens: 50 } },
      },
    ]);

    const session2 = buildJsonl([
      {
        type: "assistant",
        isSidechain: false,
        message: {
          model: "claude-opus-4-7",
          content: [{ type: "tool_use", name: "Agent", id: taskId2, input: { subagent_type: agentName } }],
          usage: { input_tokens: 10, output_tokens: 10 },
        },
      },
      {
        type: "assistant",
        isSidechain: true,
        parentToolUseID: taskId2,
        message: { model: "claude-opus-4-7", content: [], usage: { input_tokens: 150, output_tokens: 200 } },
      },
    ]);

    mockReaddir.mockImplementation(async (p: unknown) => {
      const dir = p as string;
      if (dir.endsWith("projects")) return ["project1"] as any;
      return ["session1.jsonl", "session2.jsonl"] as any;
    });

    let call = 0;
    mockReadFile.mockImplementation(async () => {
      return (call++ === 0 ? session1 : session2) as any;
    });

    const result = await computeAgentCostFromFiles();
    const entry = result.get(agentName)!;
    expect(entry.inputTokens).toBe(250);
    expect(entry.outputTokens).toBe(250);
  });
});
