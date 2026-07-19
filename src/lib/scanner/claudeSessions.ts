import { promises as fs } from "fs";
import path from "path";
import { normalizePathKey, isWindows } from "../platform";
import { encodePath, type ConversationEntry } from "./claudeConversations";
import { inferSessionStatus } from "./sessionStatus";
import { readConfig } from "../config";
import { getReadableClaudeHomes, scopeMappingsToHome } from "../claudeHome";
import { mapForeignPath, mapLocalPath } from "../pathMapping";
import type { PathMapping } from "../types";
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

/** Per-Claude-home snapshot: parsed history + projects-dir listing. */
interface HomeView {
  home: string;
  historyMap: Map<string, HistoryEntry[]>;
  projectDirs: string[];
}

interface ViewsCache {
  views: HomeView[];
  mappings: PathMapping[];
}

// Cache parsed history/views to avoid re-reading the files 61 times per scan.
// Module-level (not globalThis) on purpose: tests reset it via vi.resetModules().
// Keyed by the config that shaped the views (homes + mappings) so a Settings
// "Save & Rescan" that changes claudeHomes/pathMappings rebuilds immediately
// instead of serving the prior homes for up to a minute.
let cachedViews: ViewsCache | null = null;
let cacheTime = 0;
let cacheConfigKey = "";
const HISTORY_CACHE_TTL = 60_000; // 1 minute

async function buildHomeView(home: string, mappings: PathMapping[]): Promise<HomeView> {
  // Scope the rewrites to this home's distro: with two distros sharing a
  // foreign prefix (both `/home/josh`), an unscoped first-match would map
  // this home's history onto the OTHER distro's UNC projects.
  const scopedMappings = scopeMappingsToHome(home, mappings);
  const map = new Map<string, HistoryEntry[]>();
  try {
    const content = await fs.readFile(path.join(home, "history.jsonl"), "utf-8");
    for (const line of content.split("\n").filter(Boolean)) {
      try {
        const entry = JSON.parse(line) as HistoryEntry;
        if (!entry.project) continue;
        // Two normalizations before the lookup key:
        //  - mapForeignPath: a WSL home records Linux paths (/home/josh/dev/x);
        //    mapping them onto this machine's view (\\wsl.localhost\...) lets
        //    them match the scanner's projectPath. Unmapped paths pass through.
        //  - normalizePathKey: lowercased on Windows — drive-letter/segment
        //    casing in history.jsonl can differ from the scanner's casing (B1).
        const key = normalizePathKey(mapForeignPath(entry.project, scopedMappings));
        const list = map.get(key) || [];
        list.push(entry);
        map.set(key, list);
      } catch {
        // Skip invalid lines
      }
    }
  } catch {
    // No history file in this home
  }

  let projectDirs: string[] = [];
  try {
    projectDirs = await fs.readdir(path.join(home, "projects"));
  } catch {
    // No projects dir in this home
  }

  return { home, historyMap: map, projectDirs };
}

async function getHomeViews(): Promise<ViewsCache> {
  const config = await readConfig();
  const mappings = config.pathMappings ?? [];
  const configKey = JSON.stringify([config.claudeHomes ?? [], mappings]);
  if (
    cachedViews &&
    cacheConfigKey === configKey &&
    Date.now() - cacheTime < HISTORY_CACHE_TTL
  ) {
    return cachedViews;
  }
  // getReadableClaudeHomes applies the never-wake rule: a home inside a
  // stopped WSL distro is left out for this cycle rather than auto-started.
  const homes = await getReadableClaudeHomes(config);
  const views = await Promise.all(homes.map((h) => buildHomeView(h, mappings)));
  cachedViews = { views, mappings };
  cacheTime = Date.now();
  cacheConfigKey = configKey;
  return cachedViews;
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

  const { views, mappings } = await getHomeViews();

  // Encoded-dir candidates are computed PER VIEW: the local path as recorded
  // by a same-machine Claude, plus the foreign form — but only via mappings
  // scoped to that view's home. With two distros sharing a foreign prefix,
  // a global candidate list would count one distro's `-home-...` session
  // dirs toward the other distro's project.
  const candidatesFor = (home: string): string[] => {
    const scoped = scopeMappingsToHome(home, mappings);
    const foreignPath = mapLocalPath(projectPath, scoped);
    return [...new Set([encodePath(projectPath), encodePath(foreignPath)])];
  };

  // Case-fold comparisons only on Windows — the on-disk dir name is encoded
  // from whatever cwd casing was active during that Claude Code session (B1).
  // On POSIX, encoded dir names differing only by case are different projects
  // (PR #251 review).
  const fold = (s: string): string => (isWindows ? s.toLowerCase() : s);

  const allEntries: { entry: HistoryEntry; home: string }[] = [];
  let worktreeSessionCount = 0;

  for (const view of views) {
    for (const entry of view.historyMap.get(normalizedPath) || []) {
      allEntries.push({ entry, home: view.home });
    }

    // Count worktree sessions: sibling dirs named <parent-encoded>--<type>-worktrees-*
    // in this home's projects dir. A dir is counted once even if it matches
    // more than one encoded candidate.
    const matched = new Set<string>();
    for (const candidate of candidatesFor(view.home)) {
      const candidateFolded = fold(candidate);
      for (const d of view.projectDirs) {
        if (matched.has(d)) continue;
        const suffix = d.slice(candidate.length);
        if (fold(d).startsWith(candidateFolded + "--") && /^--(?:[a-z]+-)?worktrees-/.test(suffix)) {
          matched.add(d);
        }
      }
    }
    for (const d of matched) {
      try {
        const entries = await fs.readdir(path.join(view.home, "projects", d));
        worktreeSessionCount += entries.filter((e) => e.endsWith(".jsonl")).length;
      } catch { /* dir removed between cache and now */ }
    }
  }

  result.sessionCount = allEntries.length + worktreeSessionCount;

  if (allEntries.length > 0) {
    allEntries.sort((a, b) => {
      const ta = a.entry.timestamp ? new Date(a.entry.timestamp).getTime() : 0;
      const tb = b.entry.timestamp ? new Date(b.entry.timestamp).getTime() : 0;
      return tb - ta;
    });

    const latest = allEntries[0];
    result.lastSessionDate = latest.entry.timestamp;
    result.lastPromptPreview = latest.entry.display
      ? latest.entry.display.slice(0, 120)
      : undefined;

    // Infer live status from the most-recent session JSONL. The session dir is
    // encoded from the path AS RECORDED in the home that owns the entry (a WSL
    // home encodes the Linux path), so encode entry.project — not projectPath.
    if (latest.entry.sessionId) {
      result.mostRecentSessionId = latest.entry.sessionId;
      const encoded = encodePath(latest.entry.project ?? projectPath);
      const jsonlPath = path.join(
        latest.home, "projects", encoded, `${latest.entry.sessionId}.jsonl`
      );
      result.mostRecentSessionStatus = await inferStatusFromJSONL(jsonlPath);
    }
  }

  return result;
}
