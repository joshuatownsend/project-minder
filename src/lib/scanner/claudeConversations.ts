import { promises as fs } from "fs";
import path from "path";
import os from "os";
import { decodeDirName } from "../platform";
import {
  ClaudeUsageStats,
  SessionRecap,
  SessionSummary,
  SessionDetail,
  TimelineEvent,
  FileOperation,
  SubagentInfo,
} from "../types";
import { detectOneShot } from "../usage/oneShotDetector";
import { computeSessionQuality } from "../usage/sessionQuality";
import type { UsageTurn, ToolCall as UsageToolCall } from "../usage/types";
import { loadPricing, getModelPricing } from "../usage/costCalculator";
import {
  readDiskCache,
  writeDiskCache,
  isCacheHit,
  type CachedFileStats,
} from "../claudeStatsCache";
import { inferSessionStatus } from "./sessionStatus";

export interface ConversationEntry {
  type?: string;
  subtype?: string;
  timestamp?: string;
  sessionId?: string;
  gitBranch?: string;
  isSidechain?: boolean;
  isApiErrorMessage?: boolean;
  isMeta?: boolean;
  slug?: string; // present on away_summary entries
  message?: {
    model?: string;
    stop_reason?: string;
    role?: string;
    content?: any[];
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
  };
  // For tool_result user messages and away_summary system entries
  content?: any;
}

export function encodePath(projectPath: string): string {
  return projectPath.replace(/[:\\/]/g, "-");
}

export { decodeDirName };

export function toSlug(dirName: string): string {
  // Extract last segment as project name, slugify
  const parts = dirName.split("-");
  // Skip drive letter prefix like "C-"
  const meaningful = parts.slice(parts.findIndex((p) => p.length > 1));
  return meaningful.join("-").toLowerCase().replace(/[^a-z0-9-]/g, "-");
}

function extractTextContent(content: any[]): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((b: any) => b.type === "text" && b.text)
    .map((b: any) => b.text)
    .join("\n")
    .slice(0, 200);
}

/**
 * Like extractTextContent but filters out hook/system injection blocks
 * (content starting with '<', e.g. <user-prompt-submit-hook>, <command-name>, etc.)
 */
function extractHumanText(content: any): string {
  if (typeof content === "string") {
    const trimmed = content.trim();
    return trimmed.startsWith("<") ? "" : trimmed.slice(0, 200);
  }
  if (!Array.isArray(content)) return "";
  return content
    .filter((b: any) => b.type === "text" && b.text && !b.text.trim().startsWith("<"))
    .map((b: any) => b.text as string)
    .join("\n")
    .slice(0, 200);
}

// ─── Session ID index (globalThis singleton) ─────────────────────────

const globalForIndex = globalThis as unknown as {
  __sessionIndex?: Map<string, { filePath: string; projectDirName: string }>;
};
const sessionIndex =
  globalForIndex.__sessionIndex ||
  (globalForIndex.__sessionIndex = new Map());

// ─── Lightweight scan for session summaries ───────────────────────────

const MAX_SESSION_FILE_SIZE = 50 * 1024 * 1024; // 50 MB

async function scanSessionFile(
  filePath: string,
  projectDirName: string,
  mtime: Date
): Promise<SessionSummary | null> {
  try {
    const stat = await fs.stat(filePath);
    if (stat.size > MAX_SESSION_FILE_SIZE) return null;
    const content = await fs.readFile(filePath, "utf-8");
    const lines = content.split("\n").filter(Boolean);
    if (lines.length === 0) return null;

    const sessionId = path.basename(filePath, ".jsonl");
    let startTime: string | undefined;
    let endTime: string | undefined;
    let initialPrompt: string | undefined;
    let lastPrompt: string | undefined;
    let gitBranch: string | undefined;
    let sessionSlug: string | undefined;
    const recaps: SessionRecap[] = [];
    let messageCount = 0;
    let userMessageCount = 0;
    let assistantMessageCount = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let cacheCreateTokens = 0;
    const tools: Record<string, number> = {};
    const skills: Record<string, number> = {};
    const models = new Set<string>();
    let subagentCount = 0;
    let errorCount = 0;
    // Per-model token accumulation for accurate cost (via LiteLLM pricing)
    const perModelTokens = new Map<string, { i: number; o: number; cc: number; cr: number }>();
    const allEntries: ConversationEntry[] = [];
    const searchParts: string[] = [];
    let searchLen = 0;
    // Collect one-shot detection data during the same pass
    const lightTurns: UsageTurn[] = [];

    for (const line of lines) {
      try {
        const entry: ConversationEntry = JSON.parse(line);
        allEntries.push(entry);

        if (entry.timestamp) {
          if (!startTime) startTime = entry.timestamp;
          endTime = entry.timestamp;
        }
        if (entry.gitBranch && !gitBranch) gitBranch = entry.gitBranch;

        if (entry.type === "system" && entry.subtype === "away_summary" && typeof entry.content === "string" && entry.timestamp) {
          recaps.push({ content: entry.content, timestamp: entry.timestamp, slug: entry.slug });
        }

        if (entry.type === "user" && !entry.isMeta) {
          userMessageCount++;
          messageCount++;
          const humanContent = entry.message?.content ?? entry.content;
          const humanText = extractHumanText(humanContent);
          if (humanText) {
            if (!initialPrompt) initialPrompt = humanText;
            lastPrompt = humanText;
            if (searchLen < 4000) { searchParts.push(humanText); searchLen += humanText.length; }
          }
        }

        if (entry.type === "assistant" && entry.message) {
          assistantMessageCount++;
          messageCount++;
          // Capture Claude Code's stable session slug here, restricted
          // to assistant entries — out-of-band records (system, recap)
          // can carry slug fields too, and latching from one of those
          // would permanently poison `sessions.slug` for this session.
          if (!sessionSlug && typeof entry.slug === "string" && entry.slug.length > 0) {
            sessionSlug = entry.slug;
          }
          const msg = entry.message;
          const model = msg.model;
          if (model && model !== "<synthetic>") models.add(model);

          const usage = msg.usage;
          if (usage) {
            const inp = usage.input_tokens || 0;
            const out = usage.output_tokens || 0;
            const cc  = usage.cache_creation_input_tokens || 0;
            const cr  = usage.cache_read_input_tokens || 0;
            inputTokens += inp;
            outputTokens += out;
            cacheCreateTokens += cc;
            cacheReadTokens += cr;
            accumulateTokens(perModelTokens, model, inp, out, cc, cr);
          }

          if (entry.isApiErrorMessage) errorCount++;

          if (Array.isArray(msg.content)) {
            for (const block of msg.content) {
              if (block.type === "tool_use" && block.name) {
                tools[block.name] = (tools[block.name] || 0) + 1;
                if (block.name === "Agent") subagentCount++;
                if (block.name === "Skill" && block.input?.skill) {
                  const skillName = block.input.skill;
                  skills[skillName] = (skills[skillName] || 0) + 1;
                }
              } else if (block.type === "text" && block.text && !entry.isSidechain) {
                if (searchLen < 4000) {
                  const t = String(block.text).slice(0, 500);
                  searchParts.push(t);
                  searchLen += t.length;
                }
              }
            }
          }
        }

        // Build lightweight turn for one-shot detection (same pass, no re-parse)
        if (entry.timestamp && !entry.isSidechain && !entry.isMeta) {
          const turnToolCalls: UsageToolCall[] = [];
          let toolResultText = "";

          if (entry.type === "assistant" && entry.message?.content) {
            for (const block of entry.message.content) {
              if (block.type === "tool_use" && block.name) {
                turnToolCalls.push({ name: block.name, arguments: block.input });
              }
            }
          }
          if (entry.type === "user") {
            const content = entry.message?.content || entry.content || [];
            if (Array.isArray(content)) {
              for (const block of content) {
                if (block.type === "tool_result") {
                  if (typeof block.content === "string") toolResultText += block.content;
                  else if (Array.isArray(block.content)) {
                    for (const c of block.content) {
                      if (c.type === "text" && c.text) toolResultText += c.text;
                    }
                  }
                }
              }
            }
          }

          // Token fields populated for assistant turns (used by
          // sessionQuality detectors to compute fill/cache stats). User
          // turns leave them at 0; the detectors already gate on
          // role==="assistant" before reading. Keeping the gate
          // role-based avoids re-walking JSONL for the quality pass.
          const turnUsage = entry.type === "assistant" ? entry.message?.usage : undefined;
          const turnIsError =
            entry.type === "assistant" && entry.isApiErrorMessage === true;
          lightTurns.push({
            timestamp: entry.timestamp,
            sessionId,
            projectSlug: toSlug(projectDirName),
            projectDirName,
            model: entry.message?.model || "",
            role: entry.type === "assistant" ? "assistant" : "user",
            inputTokens: turnUsage?.input_tokens ?? 0,
            outputTokens: turnUsage?.output_tokens ?? 0,
            cacheCreateTokens: turnUsage?.cache_creation_input_tokens ?? 0,
            cacheReadTokens: turnUsage?.cache_read_input_tokens ?? 0,
            toolCalls: turnToolCalls,
            toolResultText: toolResultText.slice(0, 2000),
            isError: turnIsError,
          });
        }
      } catch {
        // Skip invalid lines
      }
    }

    if (messageCount === 0) return null;

    let oneShotRate: number | undefined;
    try {
      const oneShotStats = detectOneShot(lightTurns);
      if (oneShotStats.totalVerifiedTasks > 0) {
        oneShotRate = oneShotStats.rate;
      }
    } catch { /* non-critical */ }

    // Quality detectors (#100/#102/#104) run on the same lightTurns the
    // one-shot detector already used. Falls back to undefined fields on
    // failure so the file-parse SessionsBrowser badges simply don't
    // render rather than poisoning the summary.
    let qualityCacheHitRatio: number | undefined;
    let qualityMaxContextFill: number | undefined;
    let qualityHasCompactionLoop: boolean | undefined;
    let qualityHasToolFailureStreak: boolean | undefined;
    try {
      const quality = computeSessionQuality(lightTurns);
      if (quality.cache.hitRatio !== null) qualityCacheHitRatio = quality.cache.hitRatio;
      if (quality.maxContextFill > 0) qualityMaxContextFill = quality.maxContextFill;
      qualityHasCompactionLoop = quality.compactionLoops.length > 0;
      qualityHasToolFailureStreak = quality.toolFailureStreaks.length > 0;
    } catch { /* non-critical */ }

    // Per-model cost calculation using LiteLLM pricing (unified with /usage)
    await loadPricing();
    let costEstimate = 0;
    for (const [model, toks] of perModelTokens) {
      const p = getModelPricing(model === "unknown" ? "" : model);
      costEstimate += toks.i * p.inputCostPerToken
                   + toks.o * p.outputCostPerToken
                   + toks.cc * p.cacheWriteCostPerToken
                   + toks.cr * p.cacheReadCostPerToken;
    }

    const status = inferSessionStatus(
      allEntries.length > 500 ? allEntries.slice(-500) : allEntries,
      mtime,
    );
    const isActive = Date.now() - mtime.getTime() < 2 * 60_000;
    const durationMs =
      startTime && endTime
        ? new Date(endTime).getTime() - new Date(startTime).getTime()
        : undefined;

    const projectPath = decodeDirName(projectDirName);
    const projectSlug = toSlug(projectDirName);

    return {
      sessionId,
      projectPath,
      projectSlug,
      projectName: projectDirName,
      startTime,
      endTime,
      durationMs,
      initialPrompt,
      lastPrompt: lastPrompt !== initialPrompt ? lastPrompt : undefined,
      recaps: recaps.length > 0 ? recaps : undefined,
      messageCount,
      userMessageCount,
      assistantMessageCount,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheCreateTokens,
      costEstimate,
      toolUsage: tools,
      modelsUsed: Array.from(models),
      gitBranch,
      subagentCount,
      errorCount,
      isActive,
      status,
      skillsUsed: skills,
      oneShotRate,
      searchableText: searchParts.join(" ").slice(0, 4000),
      slug: sessionSlug,
      // continuedFromSessionId is intentionally omitted on the file-parse
      // path: linking sessions by slug requires visibility into the rest
      // of the corpus, which we'd have to second-pass to compute. The DB
      // path's batched UPDATE is the canonical source. File-parse mode
      // (`MINDER_USE_DB=0`) just shows the slug without a "continued
      // from" badge — degraded but never wrong.
      cacheHitRatio: qualityCacheHitRatio,
      maxContextFill: qualityMaxContextFill,
      hasCompactionLoop: qualityHasCompactionLoop,
      hasToolFailureStreak: qualityHasToolFailureStreak,
    };
  } catch {
    return null;
  }
}

/**
 * Scan all sessions across all projects. Returns lightweight summaries.
 */
export async function scanAllSessions(): Promise<SessionSummary[]> {
  const projectsDir = path.join(os.homedir(), ".claude", "projects");
  const sessions: SessionSummary[] = [];

  let dirs: string[];
  try {
    dirs = await fs.readdir(projectsDir);
  } catch {
    return sessions;
  }

  for (const dir of dirs) {
    const dirPath = path.join(projectsDir, dir);
    try {
      const stat = await fs.stat(dirPath);
      if (!stat.isDirectory()) continue;

      const entries = await fs.readdir(dirPath);
      const jsonlFiles = entries.filter((e) => e.endsWith(".jsonl"));

      // Process in batches of 5
      for (let i = 0; i < jsonlFiles.length; i += 5) {
        const batch = jsonlFiles.slice(i, i + 5);
        const results = await Promise.all(
          batch.map(async (f) => {
            const filePath = path.join(dirPath, f);
            const fstat = await fs.stat(filePath);
            return scanSessionFile(filePath, dir, fstat.mtime);
          })
        );
        for (let j = 0; j < results.length; j++) {
          const r = results[j];
          if (r) {
            sessions.push(r);
            // Populate session index for fast detail lookups
            const fileName = batch[j];
            sessionIndex.set(
              r.sessionId,
              { filePath: path.join(dirPath, fileName), projectDirName: dir }
            );
          }
        }
      }
    } catch {
      // Skip inaccessible directories
    }
  }

  // Sort by most recent activity (endTime) so active sessions appear first
  sessions.sort((a, b) => {
    const ta = a.endTime ? new Date(a.endTime).getTime() : 0;
    const tb = b.endTime ? new Date(b.endTime).getTime() : 0;
    return tb - ta;
  });

  return sessions;
}

// ─── Detailed session scan (timeline, files, subagents) ─────────────

const FILE_TOOL_OPERATIONS: Record<string, string> = {
  Read: "read",
  Write: "write",
  Edit: "edit",
  Glob: "glob",
  Grep: "grep",
};

/**
 * Full parse of a single session JSONL file for the detail view.
 */
export async function scanSessionDetail(
  sessionId: string
): Promise<SessionDetail | null> {
  // Validate sessionId to prevent path traversal — UUIDs and hex IDs only
  if (!/^[a-f0-9-]+$/i.test(sessionId)) {
    return null;
  }

  const projectsDir = path.join(os.homedir(), ".claude", "projects");

  // Check session index first (populated by scanAllSessions)
  let filePath: string | null = null;
  let projectDirName = "";
  const indexed = sessionIndex.get(sessionId);
  if (indexed) {
    filePath = indexed.filePath;
    projectDirName = indexed.projectDirName;
  } else {
    // Fallback: scan directories to find the session file
    try {
      const dirs = await fs.readdir(projectsDir);
      for (const dir of dirs) {
        const candidate = path.join(projectsDir, dir, `${sessionId}.jsonl`);
        try {
          await fs.access(candidate);
          filePath = candidate;
          projectDirName = dir;
          break;
        } catch {
          // Not in this directory
        }
      }
    } catch {
      return null;
    }
  }

  if (!filePath) return null;

  const fstat = await fs.stat(filePath);
  if (fstat.size > MAX_SESSION_FILE_SIZE) return null;
  const summary = await scanSessionFile(filePath, projectDirName, fstat.mtime);
  if (!summary) return null;

  // Now do the detailed parse for timeline, file ops, subagents
  const timeline: TimelineEvent[] = [];
  const fileOperations: FileOperation[] = [];
  const subagentMap = new Map<string, SubagentInfo>();

  try {
    const content = await fs.readFile(filePath, "utf-8");
    const lines = content.split("\n").filter(Boolean);

    for (const line of lines) {
      try {
        const entry: ConversationEntry = JSON.parse(line);

        if (entry.type === "user" && !entry.isMeta && !entry.isSidechain) {
          const text = entry.message?.content
            ? extractTextContent(entry.message.content)
            : Array.isArray(entry.content)
              ? extractTextContent(entry.content)
              : "";
          if (text) {
            timeline.push({
              type: "user",
              timestamp: entry.timestamp,
              content: text,
            });
          }
        }

        // Process sidechain assistant entries for subagent stats
        if (entry.type === "assistant" && entry.message && entry.isSidechain) {
          const msg = entry.message;
          const parentId = (entry as any).parentToolUseID;
          if (parentId && subagentMap.has(parentId)) {
            const agent = subagentMap.get(parentId)!;
            agent.messageCount++;
            if (Array.isArray(msg.content)) {
              for (const block of msg.content) {
                if (block.type === "tool_use" && block.name) {
                  agent.toolUsage[block.name] = (agent.toolUsage[block.name] || 0) + 1;
                }
              }
            }
          }
          continue;
        }

        if (entry.type === "assistant" && entry.message && !entry.isSidechain) {
          const msg = entry.message;

          if (entry.isApiErrorMessage) {
            const errorText = extractTextContent(msg.content || []);
            timeline.push({
              type: "error",
              timestamp: entry.timestamp,
              content: errorText || "API error",
            });
            continue;
          }

          if (Array.isArray(msg.content)) {
            for (const block of msg.content) {
              if (block.type === "thinking" && block.thinking) {
                timeline.push({
                  type: "thinking",
                  timestamp: entry.timestamp,
                  content: String(block.thinking).slice(0, 300),
                });
              } else if (block.type === "text" && block.text) {
                timeline.push({
                  type: "assistant",
                  timestamp: entry.timestamp,
                  content: String(block.text).slice(0, 300),
                  tokenCount:
                    (msg.usage?.output_tokens || 0) > 0
                      ? msg.usage!.output_tokens
                      : undefined,
                });
              } else if (block.type === "tool_use") {
                const toolName = block.name || "unknown";
                const input = block.input || {};

                // Timeline event
                let summary = toolName;
                if (input.file_path) summary = `${toolName}: ${input.file_path}`;
                else if (input.command) summary = `${toolName}: ${String(input.command).slice(0, 100)}`;
                else if (input.pattern) summary = `${toolName}: ${input.pattern}`;
                else if (input.prompt) summary = `${toolName}: ${String(input.prompt).slice(0, 100)}`;
                else if (input.description) summary = `${toolName}: ${String(input.description).slice(0, 100)}`;

                timeline.push({
                  type: "tool_use",
                  timestamp: entry.timestamp,
                  content: summary,
                  toolName,
                });

                // File operations
                const op = FILE_TOOL_OPERATIONS[toolName];
                if (op && input.file_path) {
                  fileOperations.push({
                    path: input.file_path,
                    operation: op,
                    timestamp: entry.timestamp,
                    toolName,
                  });
                }
                if (toolName === "Bash" && input.command) {
                  // Bash commands that write files
                  fileOperations.push({
                    path: String(input.command).slice(0, 100),
                    operation: "bash",
                    timestamp: entry.timestamp,
                    toolName: "Bash",
                  });
                }

                // Subagent tracking
                if (toolName === "Agent" && input.prompt) {
                  const agentId = block.id || "unknown";
                  subagentMap.set(agentId, {
                    agentId,
                    type: input.subagent_type || "general-purpose",
                    description: String(input.description || input.prompt).slice(0, 200),
                    messageCount: 0,
                    toolUsage: {},
                  });
                }
              }
            }
          }
        }
      } catch {
        // Skip invalid lines
      }
    }
  } catch {
    return null;
  }

  return {
    ...summary,
    timeline,
    fileOperations,
    subagents: Array.from(subagentMap.values()),
  };
}

// ─── Aggregate stats (existing, used by stats page) ─────────────────

type PerModelTokens = Map<string, { i: number; o: number; cc: number; cr: number }>;

function accumulateTokens(
  map: PerModelTokens,
  model: string | undefined,
  inp: number, out: number, cc: number, cr: number,
): void {
  const key = model && model !== "<synthetic>" ? model : "unknown";
  const ex = map.get(key) ?? { i: 0, o: 0, cc: 0, cr: 0 };
  ex.i += inp; ex.o += out; ex.cc += cc; ex.cr += cr;
  map.set(key, ex);
}

async function scanConversationFile(filePath: string): Promise<{
  inputTokens: number;
  outputTokens: number;
  cacheCreateTokens: number;
  cacheReadTokens: number;
  turns: number;
  tools: Record<string, number>;
  errors: number;
  models: Set<string>;
  perModelTokens: PerModelTokens;
}> {
  const result = {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreateTokens: 0,
    cacheReadTokens: 0,
    turns: 0,
    tools: {} as Record<string, number>,
    errors: 0,
    models: new Set<string>(),
    perModelTokens: new Map() as PerModelTokens,
  };

  try {
    const content = await fs.readFile(filePath, "utf-8");
    const lines = content.split("\n").filter(Boolean);

    for (const line of lines) {
      try {
        const entry: ConversationEntry = JSON.parse(line);
        if (entry.type === "user") result.turns++;
        if (entry.type === "assistant" && entry.message) {
          result.turns++;
          const msg = entry.message;
          const model = msg.model;
          if (model && model !== "<synthetic>") result.models.add(model);
          const usage = msg.usage;
          if (usage) {
            const inp = usage.input_tokens || 0;
            const out = usage.output_tokens || 0;
            const cc  = usage.cache_creation_input_tokens || 0;
            const cr  = usage.cache_read_input_tokens || 0;
            result.inputTokens += inp;
            result.outputTokens += out;
            result.cacheCreateTokens += cc;
            result.cacheReadTokens += cr;
            accumulateTokens(result.perModelTokens, model, inp, out, cc, cr);
          }
          if (entry.isApiErrorMessage) result.errors++;
          if (Array.isArray(msg.content)) {
            for (const block of msg.content) {
              if (block.type === "tool_use" && block.name) {
                result.tools[block.name] = (result.tools[block.name] || 0) + 1;
              }
            }
          }
        }
      } catch {
        // skip
      }
    }
  } catch {
    // file error
  }

  return result;
}

function computeCostFromPerModel(perModelTokens: PerModelTokens): number {
  let cost = 0;
  for (const [model, toks] of perModelTokens) {
    const p = getModelPricing(model === "unknown" ? "" : model);
    cost += toks.i * p.inputCostPerToken
          + toks.o * p.outputCostPerToken
          + toks.cc * p.cacheWriteCostPerToken
          + toks.cr * p.cacheReadCostPerToken;
  }
  return cost;
}

export async function scanClaudeConversations(
  projectPath: string
): Promise<ClaudeUsageStats | undefined> {
  const encoded = encodePath(projectPath);
  const projectDir = path.join(os.homedir(), ".claude", "projects", encoded);

  let jsonlFiles: string[];
  try {
    const entries = await fs.readdir(projectDir);
    jsonlFiles = entries.filter((e) => e.endsWith(".jsonl"));
  } catch {
    return undefined;
  }

  if (jsonlFiles.length === 0) return undefined;

  const stats: ClaudeUsageStats = {
    totalTokens: 0, inputTokens: 0, outputTokens: 0,
    cacheCreateTokens: 0, cacheReadTokens: 0,
    totalTurns: 0, toolUsage: {}, errorCount: 0,
    modelsUsed: [], costEstimate: 0, conversationCount: jsonlFiles.length,
  };

  const allModels = new Set<string>();
  const perModel: PerModelTokens = new Map();
  for (let i = 0; i < jsonlFiles.length; i += 5) {
    const batch = jsonlFiles.slice(i, i + 5);
    const results = await Promise.all(
      batch.map((f) => scanConversationFile(path.join(projectDir, f)))
    );
    for (const r of results) {
      stats.inputTokens += r.inputTokens;
      stats.outputTokens += r.outputTokens;
      stats.cacheCreateTokens += r.cacheCreateTokens;
      stats.cacheReadTokens += r.cacheReadTokens;
      stats.totalTurns += r.turns;
      stats.errorCount += r.errors;
      for (const model of r.models) allModels.add(model);
      for (const [tool, count] of Object.entries(r.tools)) {
        stats.toolUsage[tool] = (stats.toolUsage[tool] || 0) + count;
      }
      for (const [model, toks] of r.perModelTokens) {
        accumulateTokens(perModel, model, toks.i, toks.o, toks.cc, toks.cr);
      }
    }
  }

  await loadPricing();
  stats.totalTokens = stats.inputTokens + stats.outputTokens;
  stats.modelsUsed = Array.from(allModels);
  stats.costEstimate = computeCostFromPerModel(perModel);
  return stats;
}

export async function scanAllClaudeConversations(): Promise<ClaudeUsageStats> {
  const projectsDir = path.join(os.homedir(), ".claude", "projects");
  return scanConversationDirs(projectsDir);
}

/**
 * Scan Claude conversations scoped to specific project paths only.
 * Prevents inflating stats with unrelated repos outside devRoot.
 */
export async function scanClaudeConversationsForProjects(
  projectPaths: string[]
): Promise<ClaudeUsageStats> {
  const projectsDir = path.join(os.homedir(), ".claude", "projects");
  const allowedDirs = new Set(projectPaths.map((p) => encodePath(p)));
  return scanConversationDirs(projectsDir, allowedDirs);
}

async function scanConversationDirs(
  projectsDir: string,
  allowedDirs?: Set<string>
): Promise<ClaudeUsageStats> {
  const aggregate: ClaudeUsageStats = {
    totalTokens: 0, inputTokens: 0, outputTokens: 0,
    cacheCreateTokens: 0, cacheReadTokens: 0,
    totalTurns: 0, toolUsage: {}, errorCount: 0,
    modelsUsed: [], costEstimate: 0, conversationCount: 0,
  };

  let dirs: string[];
  try { dirs = await fs.readdir(projectsDir); } catch { return aggregate; }

  // Load persistent disk cache for incremental parsing
  const diskCache = await readDiskCache();
  const updatedCache = new Map<string, CachedFileStats>();
  let cacheChanged = false;

  const allModels = new Set<string>();
  // Accumulate per-model tokens for accurate cost calculation.
  // Cache hits lack per-model breakdown → bucketed as "unknown" (sonnet fallback).
  const aggregatePerModel: PerModelTokens = new Map();

  for (const dir of dirs) {
    if (allowedDirs && !allowedDirs.has(dir)) continue;

    const dirPath = path.join(projectsDir, dir);
    try {
      const dirStat = await fs.stat(dirPath);
      if (!dirStat.isDirectory()) continue;
      const entries = await fs.readdir(dirPath);
      const jsonlFiles = entries.filter((e) => e.endsWith(".jsonl"));
      for (const file of jsonlFiles) {
        const filePath = path.join(dirPath, file);
        const fstat = await fs.stat(filePath);
        const cached = diskCache.get(filePath);

        let fileStats: CachedFileStats;
        let fileCostPerModel: PerModelTokens | null = null;

        if (isCacheHit(cached, fstat.mtimeMs, fstat.size)) {
          fileStats = cached!;
          // No per-model breakdown in cache → treat as unknown (sonnet fallback pricing)
          fileCostPerModel = null;
        } else {
          const result = await scanConversationFile(filePath);
          fileStats = {
            filePath,
            mtime: fstat.mtimeMs,
            size: fstat.size,
            inputTokens: result.inputTokens,
            outputTokens: result.outputTokens,
            cacheCreateTokens: result.cacheCreateTokens,
            cacheReadTokens: result.cacheReadTokens,
            turns: result.turns,
            tools: result.tools,
            errors: result.errors,
            models: Array.from(result.models),
          };
          fileCostPerModel = result.perModelTokens;
          cacheChanged = true;
        }

        updatedCache.set(filePath, fileStats);

        // Aggregate token counts for display
        aggregate.inputTokens += fileStats.inputTokens;
        aggregate.outputTokens += fileStats.outputTokens;
        aggregate.cacheCreateTokens += fileStats.cacheCreateTokens;
        aggregate.cacheReadTokens += fileStats.cacheReadTokens;
        aggregate.totalTurns += fileStats.turns;
        aggregate.errorCount += fileStats.errors;
        aggregate.conversationCount++;
        for (const model of fileStats.models) allModels.add(model);
        for (const [tool, count] of Object.entries(fileStats.tools)) {
          aggregate.toolUsage[tool] = (aggregate.toolUsage[tool] || 0) + count;
        }

        if (fileCostPerModel && fileCostPerModel.size > 0) {
          for (const [model, toks] of fileCostPerModel) {
            accumulateTokens(aggregatePerModel, model, toks.i, toks.o, toks.cc, toks.cr);
          }
        } else {
          // Cache hit — no per-model breakdown; attribute to "unknown" (sonnet fallback pricing).
          accumulateTokens(aggregatePerModel, "unknown",
            fileStats.inputTokens, fileStats.outputTokens,
            fileStats.cacheCreateTokens, fileStats.cacheReadTokens,
          );
        }
      }
    } catch { /* skip */ }
  }

  if (cacheChanged) {
    await writeDiskCache(updatedCache);
  }

  await loadPricing();
  aggregate.totalTokens = aggregate.inputTokens + aggregate.outputTokens;
  aggregate.modelsUsed = Array.from(allModels);
  aggregate.costEstimate = computeCostFromPerModel(aggregatePerModel);
  return aggregate;
}
