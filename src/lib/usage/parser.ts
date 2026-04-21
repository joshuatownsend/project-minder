import { promises as fs } from "fs";
import path from "path";
import os from "os";
import {
  toSlug,
  type ConversationEntry,
} from "@/lib/scanner/claudeConversations";
import type { UsageTurn } from "./types";

const MAX_SESSION_FILE_SIZE = 50 * 1024 * 1024; // 50MB
const CACHE_TTL_MS = 2 * 60 * 1000; // 2 minutes

const globalForParser = globalThis as unknown as {
  __usageParserCache?: { data: Map<string, UsageTurn[]>; cachedAt: number };
};

// ── Content extraction helpers ────────────────────────────────────────────────

function extractText(content: any[]): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((b: any) => b.type === "text" && b.text)
    .map((b: any) => b.text)
    .join("\n")
    .slice(0, 500);
}

function extractToolResults(content: any[]): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((b: any) => b.type === "tool_result")
    .map((b: any) => {
      if (typeof b.content === "string") return b.content;
      if (Array.isArray(b.content)) {
        return b.content
          .filter((c: any) => c.type === "text" && c.text)
          .map((c: any) => c.text)
          .join("\n");
      }
      return "";
    })
    .join("\n")
    .slice(0, 2000);
}

// ── Dir name canonicalization ─────────────────────────────────────────────────

// In the encoded dir name, ':', '\', and '.' all become '-'.
// Windows paths start with '{Drive}--' (drive colon + first backslash).
// Any '--' after that initial prefix represents '\.' — a dot-prefixed component.
// Worktree dirs are always dot-prefixed (.worktrees, .claude-worktrees, etc.),
// so strip the worktree suffix to group their sessions with the parent project.
// We scan ALL '--' occurrences (not just the first) to handle paths where an
// earlier dot-prefixed dir appears before the worktree container.
export function canonicalizeDirName(dirName: string): string {
  const searchFrom = /^[A-Za-z]--/.test(dirName) ? 2 : 0;
  let lastWorktreeIdx = -1;
  let pos = searchFrom;
  while (pos < dirName.length) {
    const idx = dirName.indexOf("--", pos);
    if (idx === -1) break;
    if (/^(?:[a-z]+-)?worktrees-/.test(dirName.slice(idx + 2))) {
      lastWorktreeIdx = idx;
    }
    pos = idx + 2;
  }
  return lastWorktreeIdx === -1 ? dirName : dirName.slice(0, lastWorktreeIdx);
}

// ── Single-file parser ────────────────────────────────────────────────────────

export async function parseSessionTurns(
  filePath: string,
  projectDirName: string
): Promise<UsageTurn[]> {
  const sessionId = path.basename(filePath, ".jsonl");
  const canonicalDir = canonicalizeDirName(projectDirName);
  const projectSlug = toSlug(canonicalDir);

  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch {
    return [];
  }

  const turns: UsageTurn[] = [];

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let entry: ConversationEntry;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue;
    }

    // Skip internal entries
    if (entry.isSidechain) continue;
    if (entry.isMeta) continue;
    if (!entry.timestamp) continue;

    const { type, timestamp } = entry;

    if (type === "assistant") {
      const model = entry.message?.model;
      if (!model || model === "<synthetic>") continue;

      const usage = entry.message?.usage ?? {};
      const inputTokens = usage.input_tokens ?? 0;
      const outputTokens = usage.output_tokens ?? 0;
      const cacheCreateTokens = usage.cache_creation_input_tokens ?? 0;
      const cacheReadTokens = usage.cache_read_input_tokens ?? 0;

      const toolCalls = (entry.message?.content ?? [])
        .filter((b: any) => b.type === "tool_use")
        .map((b: any) => ({ name: b.name, arguments: b.input }));

      const isError = entry.isApiErrorMessage === true;

      turns.push({
        timestamp,
        sessionId,
        projectSlug,
        projectDirName: canonicalDir,
        model,
        role: "assistant",
        inputTokens,
        outputTokens,
        cacheCreateTokens,
        cacheReadTokens,
        toolCalls,
        isError,
      });
    } else if (type === "user") {
      const messageContent = entry.message?.content ?? [];
      const topLevelContent = entry.content ?? [];

      // Prefer message.content, fall back to top-level content
      const textSource =
        messageContent.length > 0 ? messageContent : topLevelContent;
      const userMessageText = extractText(textSource) || undefined;
      const toolResultText = extractToolResults(textSource) || undefined;

      turns.push({
        timestamp,
        sessionId,
        projectSlug,
        projectDirName: canonicalDir,
        model: "",
        role: "user",
        inputTokens: 0,
        outputTokens: 0,
        cacheCreateTokens: 0,
        cacheReadTokens: 0,
        toolCalls: [],
        userMessageText,
        toolResultText,
      });
    }
  }

  return turns;
}

// ── All-sessions parser with caching ─────────────────────────────────────────

export async function parseAllSessions(): Promise<Map<string, UsageTurn[]>> {
  // Check cache
  const cached = globalForParser.__usageParserCache;
  if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
    return cached.data;
  }

  const projectsDir = path.join(os.homedir(), ".claude", "projects");

  let subdirs: string[];
  try {
    const entries = await fs.readdir(projectsDir, { withFileTypes: true });
    subdirs = entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    // ~/.claude/projects doesn't exist yet
    const empty = new Map<string, UsageTurn[]>();
    globalForParser.__usageParserCache = { data: empty, cachedAt: Date.now() };
    return empty;
  }

  const result = new Map<string, UsageTurn[]>();

  // Process subdirectories in batches of 5
  for (let i = 0; i < subdirs.length; i += 5) {
    const batch = subdirs.slice(i, i + 5);
    await Promise.all(
      batch.map(async (dirName) => {
        const dirPath = path.join(projectsDir, dirName);
        let files: string[];
        try {
          const entries = await fs.readdir(dirPath);
          files = entries.filter((f) => f.endsWith(".jsonl"));
        } catch {
          return;
        }

        for (const file of files) {
          const filePath = path.join(dirPath, file);

          // Check file size
          try {
            const stat = await fs.stat(filePath);
            if (stat.size > MAX_SESSION_FILE_SIZE) continue;
          } catch {
            continue;
          }

          const sessionId = path.basename(file, ".jsonl");
          const turns = await parseSessionTurns(filePath, dirName);
          if (turns.length > 0) {
            result.set(sessionId, turns);
          }
        }
      })
    );
  }

  globalForParser.__usageParserCache = { data: result, cachedAt: Date.now() };
  return result;
}
