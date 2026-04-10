import { promises as fs } from "fs";
import path from "path";
import crypto from "crypto";
import { InsightEntry, InsightsInfo } from "../types";

// ─── Dedup ID ────────────────────────────────────────────────────────────────

/**
 * Generate a stable dedup ID by hashing content with SHA-256.
 * Returns the first 12 hex characters.
 */
export function insightId(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex").slice(0, 12);
}

// ─── JSONL Extractor ─────────────────────────────────────────────────────────

// Matches opening markers:
//   `★ Insight` or `✻ Insight` with trailing dashes
//   💡 marker
//   **Insight**
//   ## Insight
const OPEN_RE =
  /(?:`[★✻]\s*Insight`[-\s]*$|💡|^\*\*Insight\*\*|^##\s+Insight)/i;

// Matches closing marker: backtick + 10 or more dashes/underscores
const CLOSE_RE = /^`[-_]{10,}/;

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

// ─── Scanner ──────────────────────────────────────────────────────────────────

/**
 * Read INSIGHTS.md from the project root and return InsightsInfo.
 * Fills in project slug (derived from path.basename(projectPath)) and
 * projectPath for all entries.
 * Returns undefined if the file doesn't exist or has no entries.
 */
export async function scanInsightsMd(
  projectPath: string
): Promise<InsightsInfo | undefined> {
  try {
    const content = await fs.readFile(
      path.join(projectPath, "INSIGHTS.md"),
      "utf-8"
    );

    const { info } = parseInsightsMd(content);
    if (info.entries.length === 0) return undefined;

    const projectSlug = path.basename(projectPath);
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
