import { promises as fs } from "fs";
import path from "path";
import os from "os";
import crypto from "crypto";
import { InsightEntry, InsightsInfo } from "../types";
import { encodePath, toSlug } from "./claudeConversations";
import { writeFileAtomic, withFileLock } from "../atomicWrite";

// ─── Dedup ID ────────────────────────────────────────────────────────────────

/**
 * Generate a stable dedup ID by hashing content with SHA-256.
 * Returns the first 12 hex characters.
 */
export function insightId(content: string): string {
  return crypto.createHash("sha256").update(content.trim()).digest("hex").slice(0, 12);
}

// ─── JSONL Extractor ─────────────────────────────────────────────────────────

// Matches opening markers:
//   `★ Insight` or `✻ Insight` with trailing dashes
//   💡 marker
//   **Insight**
//   ## Insight
const OPEN_RE =
  /(?:`[★✻]\s*Insight[─━\-_\s]*`|💡|^\*\*Insight\*\*|^##\s+Insight)/i;

// Matches closing marker: backtick + 10 or more dashes/underscores (ASCII or unicode box-drawing)
const CLOSE_RE = /^`[─━\-_]{10,}/;

interface JsonlEntry {
  type?: string;
  timestamp?: string;
  message?: {
    content?: Array<{ type: string; text?: string }>;
  };
}

/**
 * Extract insight blocks from JSONL conversation content.
 * Only processes `type === "assistant"` entries.
 */
export function parseInsightsFromJsonl(
  jsonlContent: string,
  sessionId: string,
  projectSlug: string,
  projectPath: string
): InsightEntry[] {
  const results: InsightEntry[] = [];

  for (const rawLine of jsonlContent.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    let entry: JsonlEntry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    if (entry.type !== "assistant") continue;
    if (!entry.message?.content) continue;

    const timestamp = entry.timestamp ?? new Date().toISOString();

    // Collect all text blocks from this assistant message
    for (const block of entry.message.content) {
      if (block.type !== "text" || !block.text) continue;

      const insights = extractInsightBlocks(
        block.text,
        sessionId,
        timestamp,
        projectSlug,
        projectPath
      );
      results.push(...insights);
    }
  }

  return results;
}

/**
 * Extract one or more insight blocks from a single text string.
 */
function extractInsightBlocks(
  text: string,
  sessionId: string,
  date: string,
  project: string,
  projectPath: string
): InsightEntry[] {
  const lines = text.split(/\r?\n/);
  const results: InsightEntry[] = [];

  let capturing = false;
  let buffer: string[] = [];

  const flush = () => {
    const content = buffer.join("\n").trim();
    if (content) {
      results.push({
        id: insightId(content),
        content,
        sessionId,
        date,
        project,
        projectPath,
      });
    }
    buffer = [];
    capturing = false;
  };

  for (const line of lines) {
    if (!capturing) {
      if (OPEN_RE.test(line)) {
        capturing = true;
        buffer = [];
      }
    } else {
      // Check closing marker first
      if (CLOSE_RE.test(line)) {
        flush();
        continue;
      }

      // A blank line after content has been captured also ends the block
      if (line.trim() === "" && buffer.length > 0) {
        flush();
        continue;
      }

      // Skip the blank line before any content begins
      if (line.trim() === "" && buffer.length === 0) {
        continue;
      }

      buffer.push(line);
    }
  }

  // Handle unclosed block at end of text
  if (capturing && buffer.length > 0) {
    flush();
  }

  return results;
}

// ─── INSIGHTS.md Writer ───────────────────────────────────────────────────────

/**
 * Append new insights to INSIGHTS.md in a project directory.
 * Deduplicates by content hash so re-running on the same sessions is safe.
 * Returns { count, content } — content is the final file string so the caller
 * can skip a redundant readFile if it needs to parse the result immediately.
 */
export async function appendInsights(
  projectPath: string,
  entries: InsightEntry[]
): Promise<{ count: number; content: string | null }> {
  if (entries.length === 0) return { count: 0, content: null };

  const insightsMdPath = path.join(projectPath, "INSIGHTS.md");

  // Lock the entire read→dedupe→write sequence. `writeFileAtomic` alone
  // protects byte-level integrity, but two concurrent appendInsights calls
  // (e.g. a background scan + a worktree-sync request) would each read the
  // same starting state and the second writer would clobber the first's
  // additions. Locking the whole RMW serializes them so both batches land.
  return withFileLock(insightsMdPath, async () => {
    let existingContent = "";
    try {
      existingContent = await fs.readFile(insightsMdPath, "utf-8");
    } catch {
      // File doesn't exist yet
    }

    const { knownIds } = parseInsightsMd(existingContent);

    const seen = new Set(knownIds);
    const newEntries = entries.filter((e) => {
      if (seen.has(e.id)) return false;
      seen.add(e.id);
      return true;
    });

    if (newEntries.length === 0) return { count: 0, content: null };

    newEntries.sort((a, b) => {
      const dateA = new Date(a.date).getTime() || 0;
      const dateB = new Date(b.date).getTime() || 0;
      return dateB - dateA;
    });

    const formattedEntries = newEntries.map((e) => {
      const d = e.date ? new Date(e.date) : null;
      const dateStr = d && isFinite(d.getTime()) ? d.toISOString() : "unknown";
      return (
        `<!-- insight:${e.id} | session:${e.sessionId} | ${dateStr} -->\n` +
        `## ★ Insight\n` +
        `${e.content}\n` +
        `\n` +
        `---\n`
      );
    });

    const existingBody = existingContent
      .replace(/^#\s+Insights\s*(?:\r?\n)+/, "")
      .trimStart();

    const finalContent =
      `# Insights\n\n` + formattedEntries.join("\n") + (existingBody ? `\n${existingBody}` : "");

    await writeFileAtomic(insightsMdPath, finalContent);
    return { count: newEntries.length, content: finalContent };
  });
}

// ─── INSIGHTS.md Parser ───────────────────────────────────────────────────────

// Matches: <!-- insight:abc123 | session:xxxxx | 2026-04-08 12:30:00 -->
const COMMENT_RE =
  /^<!--\s*insight:([a-f0-9]+)\s*\|\s*session:(\S+)\s*\|\s*([^>]+?)\s*-->$/;

/**
 * Parse an existing INSIGHTS.md file.
 * Returns the parsed InsightsInfo and a set of known dedup IDs.
 */
export function parseInsightsMd(content: string): {
  info: InsightsInfo;
  knownIds: Set<string>;
} {
  const lines = content.split(/\r?\n/);
  const entries: InsightEntry[] = [];
  const knownIds = new Set<string>();

  let i = 0;
  while (i < lines.length) {
    const commentMatch = lines[i].trim().match(COMMENT_RE);
    if (commentMatch) {
      const id = commentMatch[1];
      const sessionId = commentMatch[2];
      const date = commentMatch[3].trim();

      knownIds.add(id);

      // Skip the `## ★ Insight` (or similar) header line
      i++;
      if (i < lines.length && lines[i].trim().startsWith("##")) {
        i++;
      }

      // Collect content lines until `---` separator or another comment block
      const contentLines: string[] = [];
      while (i < lines.length) {
        const trimmed = lines[i].trim();
        if (trimmed === "---" || COMMENT_RE.test(trimmed)) {
          break;
        }
        contentLines.push(lines[i]);
        i++;
      }

      // Skip the `---` separator if present
      if (i < lines.length && lines[i].trim() === "---") {
        i++;
      }

      const entryContent = contentLines.join("\n").trim();
      if (entryContent) {
        entries.push({
          id,
          content: entryContent,
          sessionId,
          date,
          project: "",
          projectPath: "",
        });
      }
    } else {
      i++;
    }
  }

  return {
    info: { entries, total: entries.length },
    knownIds,
  };
}

// ─── JSONL Sync ───────────────────────────────────────────────────────────────

/**
 * Scan JSONL session files for this project and extract any new insights into
 * INSIGHTS.md. Uses INSIGHTS.md mtime as a watermark so only files modified
 * since the last sync are re-read. Dedup by content hash makes this idempotent.
 * Returns the final written content if INSIGHTS.md was updated, null otherwise.
 */
async function syncInsightsFromSessions(projectPath: string): Promise<string | null> {
  const claudeProjectsDir = path.join(os.homedir(), ".claude", "projects");

  // Watermark: skip JSONL files not modified since last INSIGHTS.md write
  const insightsMdPath = path.join(projectPath, "INSIGHTS.md");
  let watermarkMs = 0;
  try {
    const stat = await fs.stat(insightsMdPath);
    watermarkMs = stat.mtimeMs;
  } catch {
    // No INSIGHTS.md yet — scan all JSONL files
  }

  const encoded = encodePath(projectPath).toLowerCase();
  const projectSlug = toSlug(path.basename(projectPath));

  let claudeDirs: string[];
  try {
    claudeDirs = await fs.readdir(claudeProjectsDir);
  } catch {
    return null; // Claude history not accessible
  }

  const matchingDirs = claudeDirs.filter((dir) => {
    const lowerDir = dir.toLowerCase();
    return lowerDir === encoded || lowerDir.startsWith(encoded + "--claude-worktrees-");
  });

  const allInsights: InsightEntry[] = [];

  for (const dir of matchingDirs) {
    const dirPath = path.join(claudeProjectsDir, dir);
    let files: string[];
    try {
      files = (await fs.readdir(dirPath)).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue;
    }

    const fileInsights = await Promise.all(
      files.map(async (file) => {
        const filePath = path.join(dirPath, file);
        try {
          const fstat = await fs.stat(filePath);
          if (fstat.mtimeMs <= watermarkMs) return [];
          if (fstat.size > 50 * 1024 * 1024) return [];
          const content = await fs.readFile(filePath, "utf-8");
          const sessionId = path.basename(file, ".jsonl");
          return parseInsightsFromJsonl(content, sessionId, projectSlug, projectPath);
        } catch {
          return [];
        }
      })
    );

    allInsights.push(...fileInsights.flat());
  }

  if (allInsights.length === 0) return null;
  const { content } = await appendInsights(projectPath, allInsights);
  return content;
}

// ─── Scanner ──────────────────────────────────────────────────────────────────

/**
 * Sync new insights from session history, then read INSIGHTS.md and return
 * InsightsInfo. Returns undefined if no entries exist.
 */
export async function scanInsightsMd(
  projectPath: string
): Promise<InsightsInfo | undefined> {
  let syncedContent: string | null = null;
  try {
    syncedContent = await syncInsightsFromSessions(projectPath);
  } catch {
    // Non-fatal — fall through to read whatever is already in INSIGHTS.md
  }

  try {
    // Re-use the content returned by sync to avoid an extra readFile
    const content = syncedContent ?? await fs.readFile(
      path.join(projectPath, "INSIGHTS.md"),
      "utf-8"
    );

    const { info } = parseInsightsMd(content);
    if (info.entries.length === 0) return undefined;

    const projectSlug = toSlug(path.basename(projectPath));
    const entries = info.entries.map((e) => ({
      ...e,
      project: projectSlug,
      projectPath,
    }));

    return { entries, total: entries.length };
  } catch {
    return undefined;
  }
}
