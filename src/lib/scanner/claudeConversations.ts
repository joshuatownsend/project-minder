import { promises as fs } from "fs";
import path from "path";
import os from "os";
import {
  ClaudeUsageStats,
  SessionSummary,
  SessionDetail,
  TimelineEvent,
  FileOperation,
  SubagentInfo,
} from "../types";
import {
  readDiskCache,
  writeDiskCache,
  isCacheHit,
  type CachedFileStats,
} from "../claudeStatsCache";

/* eslint-disable @typescript-eslint/no-explicit-any */
interface ConversationEntry {
  type?: string;
  timestamp?: string;
  sessionId?: string;
  gitBranch?: string;
  isSidechain?: boolean;
  isApiErrorMessage?: boolean;
  isMeta?: boolean;
  message?: {
    model?: string;
    role?: string;
    content?: any[];
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
  };
  // For tool_result user messages
  content?: any[];
}

// Approximate cost per token (USD)
const INPUT_COST_PER_TOKEN = 0.000015;
const OUTPUT_COST_PER_TOKEN = 0.000075;
const CACHE_WRITE_COST_PER_TOKEN = 0.00001875;
const CACHE_READ_COST_PER_TOKEN = 0.0000015;

function computeCost(
  inputTokens: number,
  outputTokens: number,
  cacheCreate: number,
  cacheRead: number
): number {
  return (
    inputTokens * INPUT_COST_PER_TOKEN +
    outputTokens * OUTPUT_COST_PER_TOKEN +
    cacheCreate * CACHE_WRITE_COST_PER_TOKEN +
    cacheRead * CACHE_READ_COST_PER_TOKEN
  );
}

function encodePath(projectPath: string): string {
  return projectPath.replace(/[:\\/]/g, "-");
}

function decodeDirName(dirName: string): string {
  // C--dev-project-minder → C:\dev\project-minder (approximate)
  return dirName.replace(/^([A-Z])-/, "$1:").replace(/-/g, "\\");
}

function toSlug(dirName: string): string {
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

// ─── Session ID index (globalThis singleton) ─────────────────────────

const globalForIndex = globalThis as unknown as {
  __sessionIndex?: Map<string, { filePath: string; projectDirName: string }>;
};
const sessionIndex =
  globalForIndex.__sessionIndex ||
  (globalForIndex.__sessionIndex = new Map());

// ─── Lightweight scan for session summaries ───────────────────────────

async function scanSessionFile(
  filePath: string,
  projectDirName: string,
  mtime: Date
): Promise<SessionSummary | null> {
  try {
    const content = await fs.readFile(filePath, "utf-8");
    const lines = content.split("\n").filter(Boolean);
    if (lines.length === 0) return null;

    const sessionId = path.basename(filePath, ".jsonl");
    let startTime: string | undefined;
    let endTime: string | undefined;
    let initialPrompt: string | undefined;
    let gitBranch: string | undefined;
    let messageCount = 0;
    let userMessageCount = 0;
    let assistantMessageCount = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let cacheCreateTokens = 0;
    const tools: Record<string, number> = {};
    const models = new Set<string>();
    let subagentCount = 0;
    let errorCount = 0;

    for (const line of lines) {
      try {
        const entry: ConversationEntry = JSON.parse(line);

        if (entry.timestamp) {
          if (!startTime) startTime = entry.timestamp;
          endTime = entry.timestamp;
        }
        if (entry.gitBranch && !gitBranch) gitBranch = entry.gitBranch;

        if (entry.type === "user" && !entry.isMeta) {
          userMessageCount++;
          messageCount++;
          // Capture first real user message as initial prompt
          if (!initialPrompt && entry.message?.content) {
            const text = extractTextContent(entry.message.content);
            if (text) initialPrompt = text;
          } else if (!initialPrompt && Array.isArray(entry.content)) {
            // Some user messages have content at top level
            const text = extractTextContent(entry.content);
            if (text) initialPrompt = text;
          }
        }

        if (entry.type === "assistant" && entry.message) {
          assistantMessageCount++;
          messageCount++;
          const msg = entry.message;
          const model = msg.model;
          if (model && model !== "<synthetic>") models.add(model);

          const usage = msg.usage;
          if (usage) {
            inputTokens += usage.input_tokens || 0;
            outputTokens += usage.output_tokens || 0;
            cacheCreateTokens += usage.cache_creation_input_tokens || 0;
            cacheReadTokens += usage.cache_read_input_tokens || 0;
          }

          if (entry.isApiErrorMessage) errorCount++;

          if (Array.isArray(msg.content)) {
            for (const block of msg.content) {
              if (block.type === "tool_use" && block.name) {
                tools[block.name] = (tools[block.name] || 0) + 1;
                if (block.name === "Agent") subagentCount++;
              }
            }
          }
        }
      } catch {
        // Skip invalid lines
      }
    }

    if (messageCount === 0) return null;

    const isActive = Date.now() - mtime.getTime() < 2 * 60_000;
    const durationMs =
      startTime && endTime
        ? new Date(endTime).getTime() - new Date(startTime).getTime()
        : undefined;

    const projectPath = decodeDirName(projectDirName);
    const projectSlug = toSlug(projectDirName);
    // Use last path segment as display name
    const projectName = projectDirName.split("-").slice(-1)[0] || projectDirName;

    return {
      sessionId,
      projectPath,
      projectSlug,
      projectName: projectDirName,
      startTime,
      endTime,
      durationMs,
      initialPrompt,
      messageCount,
      userMessageCount,
      assistantMessageCount,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheCreateTokens,
      costEstimate: computeCost(inputTokens, outputTokens, cacheCreateTokens, cacheReadTokens),
      toolUsage: tools,
      modelsUsed: Array.from(models),
      gitBranch,
      subagentCount,
      errorCount,
      isActive,
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

async function scanConversationFile(filePath: string): Promise<{
  inputTokens: number;
  outputTokens: number;
  cacheCreateTokens: number;
  cacheReadTokens: number;
  turns: number;
  tools: Record<string, number>;
  errors: number;
  models: Set<string>;
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
            result.inputTokens += usage.input_tokens || 0;
            result.outputTokens += usage.output_tokens || 0;
            result.cacheCreateTokens += usage.cache_creation_input_tokens || 0;
            result.cacheReadTokens += usage.cache_read_input_tokens || 0;
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
    }
  }

  stats.totalTokens = stats.inputTokens + stats.outputTokens;
  stats.modelsUsed = Array.from(allModels);
  stats.costEstimate = computeCost(stats.inputTokens, stats.outputTokens, stats.cacheCreateTokens, stats.cacheReadTokens);
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

        if (isCacheHit(cached, fstat.mtimeMs, fstat.size)) {
          // Cache hit — use stored results
          fileStats = cached!;
        } else {
          // Cache miss — parse the file
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
          cacheChanged = true;
        }

        updatedCache.set(filePath, fileStats);

        // Aggregate
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
      }
    } catch { /* skip */ }
  }

  // Persist updated cache to disk (only if something changed)
  if (cacheChanged) {
    await writeDiskCache(updatedCache);
  }

  aggregate.totalTokens = aggregate.inputTokens + aggregate.outputTokens;
  aggregate.modelsUsed = Array.from(allModels);
  aggregate.costEstimate = computeCost(aggregate.inputTokens, aggregate.outputTokens, aggregate.cacheCreateTokens, aggregate.cacheReadTokens);
  return aggregate;
}
