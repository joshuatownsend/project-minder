import path from "path";
import os from "os";
import { expandImports } from "./expandImports";
import { walkMdTree } from "./mdTreeWalk";
import { readUserClaudeMdContent } from "./userClaudeMd";
import { scanMcpServers } from "./mcpServers";
import { loadCatalog } from "../indexer/catalog";
import type { McpServer } from "../types";

/**
 * Component-model estimate of "how many tokens does Claude Code consume
 * before reading any of your code" — for one project (TODO #135).
 *
 * Numbers match the codeburn `context-budget.ts` baselines:
 *   - System base (Claude Code's fixed CLI overhead): 10,400 tokens
 *   - MCP servers in scope: 400 tokens each
 *   - Skills in scope: 80 tokens each (one SKILL.md descriptor)
 *   - Memory files (CLAUDE.md + rules): UTF-8 byte_count / 4
 *
 * Memory cost is measured in UTF-8 bytes — that's what Claude Code's
 * tokenizer ultimately ingests, and it's a closer approximation to
 * tokens than JavaScript string `.length` (UTF-16 units) for non-ASCII.
 *
 * Skills in scope = user-scope + plugin + this-project's project-local skills.
 *
 * Token cost for input is read from ../usage/costCalculator at runtime
 * (lazy import) so the API route stays decoupled from the heavy pricing
 * cache load when only the panel is open.
 */

export const SYSTEM_BASE_TOKENS = 10_400;
export const MCP_SERVER_TOKENS_EACH = 400;
export const SKILL_TOKENS_EACH = 80;
export const BYTES_PER_TOKEN = 4;

/** Backwards-compatible alias kept temporarily for callers that imported
 *  `CHARS_PER_TOKEN` before the rename. Prefer `BYTES_PER_TOKEN`. */
export const CHARS_PER_TOKEN = BYTES_PER_TOKEN;

export interface ContextBudgetBreakdown {
  systemBaseTokens: number;
  mcpServerCount: number;
  mcpServerTokens: number;
  skillCount: number;
  skillTokens: number;
  /** Total UTF-8 bytes across all memory files counted. */
  memoryBytes: number;
  memoryTokens: number;
  totalTokens: number;
  estimatedUsd: number | null;
  pricingModel?: string;
  detail: {
    mcpServers: Array<Pick<McpServer, "name" | "source" | "transport">>;
    /** UTF-8 bytes per memory file. */
    memoryFiles: Array<{ path: string; bytes: number }>;
    skillsBySource: { user: number; plugin: number; project: number };
  };
}

interface MemoryFileResult {
  path: string;
  bytes: number;
}

async function memoryCharCount(projectPath: string): Promise<MemoryFileResult[]> {
  const projectClaudeMd = path.join(projectPath, "CLAUDE.md");
  const projectRules = path.join(projectPath, ".claude", "rules");
  const userRules = path.join(os.homedir(), ".claude", "rules");

  // Project CLAUDE.md (with imports expanded) + user-scope CLAUDE.md (cached
  // per-mtime via readUserClaudeMdContent) + both rules trees in parallel.
  const [projectExp, userContent, ruleFilesArrays] = await Promise.all([
    expandImports(projectClaudeMd).catch(() => ({ content: "", imports: [], circular: [], maxDepthHit: false })),
    readUserClaudeMdContent(),
    Promise.all([walkMdTree(projectRules), walkMdTree(userRules)]),
  ]);

  const out: MemoryFileResult[] = [];

  if (projectExp.content.length > 0) {
    out.push({
      path: projectClaudeMd,
      bytes: Buffer.byteLength(projectExp.content, "utf-8"),
    });
  }

  if (userContent.length > 0) {
    out.push({
      path: path.join(os.homedir(), ".claude", "CLAUDE.md"),
      bytes: Buffer.byteLength(userContent, "utf-8"),
    });
  }

  for (const file of ruleFilesArrays.flat()) {
    if (file.bytes > 0) out.push({ path: file.file, bytes: file.bytes });
  }

  return out;
}

async function getInputTokenPriceUsd(): Promise<{ usdPerToken: number; model: string } | null> {
  try {
    const { loadPricing, getModelPricing } = await import("../usage/costCalculator");
    await loadPricing();
    const model = "claude-sonnet-4-5";
    const pricing = getModelPricing(model);
    return { usdPerToken: pricing.inputCostPerToken, model };
  } catch {
    return null;
  }
}

export async function computeContextBudget(
  projectPath: string,
  projectSlug: string
): Promise<ContextBudgetBreakdown> {
  const [mcp, catalog, memoryFiles, pricing] = await Promise.all([
    scanMcpServers(projectPath),
    loadCatalog({ includeProjects: true }),
    memoryCharCount(projectPath),
    getInputTokenPriceUsd(),
  ]);

  const mcpServers = mcp?.servers ?? [];
  const mcpServerCount = mcpServers.length;
  const mcpServerTokens = mcpServerCount * MCP_SERVER_TOKENS_EACH;

  const skillsBySource = { user: 0, plugin: 0, project: 0 };
  for (const s of catalog.skills) {
    if (s.source === "user") skillsBySource.user += 1;
    else if (s.source === "plugin") skillsBySource.plugin += 1;
    else if (s.source === "project" && s.projectSlug === projectSlug) {
      skillsBySource.project += 1;
    }
  }
  const skillCount = skillsBySource.user + skillsBySource.plugin + skillsBySource.project;
  const skillTokens = skillCount * SKILL_TOKENS_EACH;

  const memoryBytes = memoryFiles.reduce((acc, f) => acc + f.bytes, 0);
  const memoryTokens = Math.round(memoryBytes / BYTES_PER_TOKEN);

  const totalTokens =
    SYSTEM_BASE_TOKENS + mcpServerTokens + skillTokens + memoryTokens;

  const estimatedUsd = pricing ? totalTokens * pricing.usdPerToken : null;

  return {
    systemBaseTokens: SYSTEM_BASE_TOKENS,
    mcpServerCount,
    mcpServerTokens,
    skillCount,
    skillTokens,
    memoryBytes,
    memoryTokens,
    totalTokens,
    estimatedUsd,
    pricingModel: pricing?.model,
    detail: {
      mcpServers: mcpServers.map((s) => ({
        name: s.name,
        source: s.source,
        transport: s.transport,
      })),
      memoryFiles: memoryFiles.map((f) => ({ path: f.path, bytes: f.bytes })),
      skillsBySource,
    },
  };
}
