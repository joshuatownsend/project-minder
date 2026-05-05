import { promises as fs } from "fs";
import path from "path";
import os from "os";
import { getModelPricing, applyPricing } from "./costCalculator";

export interface AgentCostEntry {
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
}

const globalForAgentCost = globalThis as unknown as {
  __agentCostCache?: { map: Map<string, AgentCostEntry>; expiresAt: number };
};

interface RawEntry {
  type?: string;
  isSidechain?: boolean;
  isMeta?: boolean;
  parentToolUseID?: string;
  message?: {
    model?: string;
    content?: Array<{
      type?: string;
      name?: string;
      id?: string;
      input?: Record<string, unknown>;
    }>;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
  };
}

/**
 * Walk all JSONL files in ~/.claude/projects/ and compute per-agent
 * cost from sidechain turns in a single pass.
 *
 * Strategy per file:
 *   Pass 1: collect Task tool_use blocks from main-conversation turns
 *           to build tool_use_id → subagent_type.
 *   Pass 2: accumulate cost from sidechain assistant turns by matching
 *           parentToolUseID → agent name.
 *
 * Called on-demand from /api/agents. Returns a Map from agent_name → costs.
 */
export async function computeAgentCostFromFiles(): Promise<Map<string, AgentCostEntry>> {
  const now = Date.now();
  const cached = globalForAgentCost.__agentCostCache;
  if (cached && now < cached.expiresAt) return cached.map;

  const projectsRoot = path.join(os.homedir(), ".claude", "projects");

  let projectDirs: string[];
  try {
    projectDirs = await fs.readdir(projectsRoot);
  } catch {
    return new Map();
  }

  const result = new Map<string, AgentCostEntry>();

  await Promise.all(
    projectDirs.map(async (dirName) => {
      const dirPath = path.join(projectsRoot, dirName);
      let files: string[];
      try {
        files = await fs.readdir(dirPath);
      } catch {
        return;
      }

      await Promise.all(
        files
          .filter((f) => f.endsWith(".jsonl"))
          .map(async (f) => {
            let raw: string;
            try {
              raw = await fs.readFile(path.join(dirPath, f), "utf-8");
            } catch {
              return;
            }

            const lines = raw.split("\n");
            const entries: RawEntry[] = [];
            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed) continue;
              try {
                entries.push(JSON.parse(trimmed) as RawEntry);
              } catch {
                // skip malformed lines
              }
            }

            // Build tool_use_id → agent_name from main-conversation Task calls
            const taskMap = new Map<string, string>();
            for (const entry of entries) {
              if (entry.isSidechain || entry.isMeta) continue;
              if (entry.type !== "assistant" || !entry.message) continue;
              for (const block of entry.message.content ?? []) {
                if (
                  block.type === "tool_use" &&
                  block.name === "Agent" &&
                  block.id &&
                  typeof block.input?.subagent_type === "string"
                ) {
                  taskMap.set(block.id, block.input.subagent_type as string);
                }
              }
            }

            // Accumulate cost from sidechain assistant turns
            for (const entry of entries) {
              if (!entry.isSidechain || entry.type !== "assistant" || !entry.message) continue;
              const model = entry.message.model;
              if (!model || model === "<synthetic>") continue;

              const usage = entry.message.usage ?? {};
              const inputTokens = usage.input_tokens ?? 0;
              const outputTokens = usage.output_tokens ?? 0;
              const cacheCreateTokens = usage.cache_creation_input_tokens ?? 0;
              const cacheReadTokens = usage.cache_read_input_tokens ?? 0;

              const agentName =
                (entry.parentToolUseID && taskMap.get(entry.parentToolUseID)) || "unknown";

              const pricing = getModelPricing(model);
              const cost = applyPricing(pricing, {
                inputTokens,
                outputTokens,
                cacheCreateTokens,
                cacheReadTokens,
              });

              const existing = result.get(agentName) ?? {
                costUsd: 0,
                inputTokens: 0,
                outputTokens: 0,
              };
              existing.costUsd += cost;
              existing.inputTokens += inputTokens;
              existing.outputTokens += outputTokens;
              result.set(agentName, existing);
            }
          })
      );
    })
  );

  globalForAgentCost.__agentCostCache = { map: result, expiresAt: now + 120_000 };
  return result;
}
