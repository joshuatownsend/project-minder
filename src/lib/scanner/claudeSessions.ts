import { promises as fs } from "fs";
import path from "path";
import os from "os";
import { normalizePathKey, isWindows } from "../platform";
import { encodePath, type ConversationEntry } from "./claudeConversations";
import { inferSessionStatus } from "./sessionStatus";
import type { SessionStatus } from "../types";

interface ClaudeSessionResult {
  lastSessionDate?: string;
  lastPromptPreview?: string;
  sessionCount: number;
  mostRecentSessionStatus?: SessionStatus;
  mostRecentSessionId?: string;
}

interface HistoryEntry {
  display?: string;
  timestamp?: string;
  project?: string;
  sessionId?: string;
}

// Cache parsed history to avoid reading the file 61 times
let cachedHistory: Map<string, HistoryEntry[]> | null = null;
// Cache worktree dir listing to avoid 61× readdir on every scan batch
let cachedWorktreeDirs: string[] | null = null;
let cacheTime = 0;
const HISTORY_CACHE_TTL = 60_000; // 1 minute

async function getHistoryByProject(): Promise<Map<string, HistoryEntry[]>> {
  if (cachedHistory && Date.now() - cacheTime < HISTORY_CACHE_TTL) {
    return cachedHistory;
  }

  const historyPath = path.join(os.homedir(), ".claude", "history.jsonl");
  const map = new Map<string, HistoryEntry[]>();

  try {
    const content = await fs.readFile(historyPath, "utf-8");
    const lines = content.split("\n").filter(Boolean);

    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as HistoryEntry;
        if (entry.project) {
          // Lowercased key: Windows drive-letter/segment casing recorded in
          // history.jsonl can differ from the scanner's casing (B1) — a
          // plain normalizePath() would miss the lookup and silently blank
          // sessionCount/lastPrompt/lastSessionDate for the project.
          const key = normalizePathKey(entry.project);
          const list = map.get(key) || [];
          list.push(entry);
          map.set(key, list);
        }
      } catch {
        // Skip invalid lines
      }
    }
  } catch {
    // No history file
  }

  cachedHistory = map;
  const projectsDir = path.join(os.homedir(), ".claude", "projects");
  try {
    cachedWorktreeDirs = await fs.readdir(projectsDir);
  } catch {
    cachedWorktreeDirs = [];
  }
  cacheTime = Date.now();
  return map;
}

// Read the tail of a JSONL file and infer session status from it.
async function inferStatusFromJSONL(
  filePath: string,
): Promise<SessionStatus | undefined> {
  try {
    const fstat = await fs.stat(filePath);
    const raw = await fs.readFile(filePath, "utf-8");
    const lines = raw.split("\n").filter(Boolean);
    // Tail-only parse: last 200 lines cover the relevant assistant turn and trailing entries.
    const tailLines = lines.slice(-200);
    const entries: ConversationEntry[] = [];
    for (const line of tailLines) {
      try { entries.push(JSON.parse(line)); } catch { /* skip */ }
    }
    return inferSessionStatus(entries, fstat.mtime);
  } catch {
    return undefined;
  }
}

export async function scanClaudeSessions(
  projectPath: string
): Promise<ClaudeSessionResult> {
  const result: ClaudeSessionResult = { sessionCount: 0 };
  const normalizedPath = normalizePathKey(projectPath);

  const historyMap = await getHistoryByProject();
  const projectEntries = historyMap.get(normalizedPath) || [];

  // Count worktree sessions: sibling dirs named <parent-encoded>--<type>-worktrees-*
  // in ~/.claude/projects/. The dir listing is cached alongside historyMap (same TTL)
  // to avoid 61× readdir per scan batch.
  const parentEncoded = encodePath(projectPath);
  const projectsDir = path.join(os.homedir(), ".claude", "projects");
  const allDirs = cachedWorktreeDirs ?? [];
  // Case-fold the startsWith comparison only on Windows — the on-disk dir name
  // is encoded from whatever cwd casing was active during that Claude Code
  // session, which can differ from the freshly-encoded parentEncoded (B1). On
  // POSIX, encoded dir names differing only by case are different projects, so
  // fold nothing there (PR #251 review).
  const fold = (s: string): string => (isWindows ? s.toLowerCase() : s);
  const parentEncodedFolded = fold(parentEncoded);
  let worktreeSessionCount = 0;
  for (const d of allDirs) {
    const suffix = d.slice(parentEncoded.length);
    if (fold(d).startsWith(parentEncodedFolded + "--") && /^--(?:[a-z]+-)?worktrees-/.test(suffix)) {
      try {
        const entries = await fs.readdir(path.join(projectsDir, d));
        worktreeSessionCount += entries.filter((e) => e.endsWith(".jsonl")).length;
      } catch { /* dir removed between cache and now */ }
    }
  }

  result.sessionCount = projectEntries.length + worktreeSessionCount;

  if (projectEntries.length > 0) {
    projectEntries.sort((a, b) => {
      const ta = a.timestamp ? new Date(a.timestamp).getTime() : 0;
      const tb = b.timestamp ? new Date(b.timestamp).getTime() : 0;
      return tb - ta;
    });

    const latest = projectEntries[0];
    result.lastSessionDate = latest.timestamp;
    result.lastPromptPreview = latest.display
      ? latest.display.slice(0, 120)
      : undefined;

    // Infer live status from the most-recent session JSONL.
    if (latest.sessionId) {
      result.mostRecentSessionId = latest.sessionId;
      const encoded = encodePath(projectPath);
      const jsonlPath = path.join(
        os.homedir(), ".claude", "projects", encoded, `${latest.sessionId}.jsonl`
      );
      result.mostRecentSessionStatus = await inferStatusFromJSONL(jsonlPath);
    }
  }

  return result;
}
