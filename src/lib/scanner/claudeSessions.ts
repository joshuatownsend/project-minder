import { promises as fs } from "fs";
import path from "path";
import os from "os";
import { normalizePath } from "../platform";

interface ClaudeSessionResult {
  lastSessionDate?: string;
  lastPromptPreview?: string;
  sessionCount: number;
}

interface HistoryEntry {
  display?: string;
  timestamp?: string;
  project?: string;
  sessionId?: string;
}

// Cache parsed history to avoid reading the file 61 times
let cachedHistory: Map<string, HistoryEntry[]> | null = null;
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
          const key = normalizePath(entry.project);
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
  cacheTime = Date.now();
  return map;
}

export async function scanClaudeSessions(
  projectPath: string
): Promise<ClaudeSessionResult> {
  const result: ClaudeSessionResult = { sessionCount: 0 };
  const normalizedPath = normalizePath(projectPath);

  const historyMap = await getHistoryByProject();
  const projectEntries = historyMap.get(normalizedPath) || [];

  result.sessionCount = projectEntries.length;

  if (projectEntries.length > 0) {
    // Sort by timestamp descending
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
  }

  return result;
}
