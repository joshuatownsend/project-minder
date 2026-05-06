import { promises as fs } from "fs";
import path from "path";
import os from "os";
import { parseFrontmatter } from "../indexer/parseFrontmatter";
import type { PlanEntry } from "../types";

const PLANS_DIR = path.join(os.homedir(), ".claude", "plans");
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** Scan ~/.claude/plans/*.md and return a PlanEntry per file. Fails open. */
export async function scanClaudePlans(): Promise<PlanEntry[]> {
  let files: string[];
  try {
    const entries = await fs.readdir(PLANS_DIR, { withFileTypes: true });
    files = entries
      .filter((e) => e.isFile() && e.name.endsWith(".md"))
      .map((e) => path.join(PLANS_DIR, e.name));
  } catch {
    return [];
  }

  const results = await Promise.all(files.map(readOnePlan));
  return results.filter((p): p is PlanEntry => p !== null);
}

async function readOnePlan(filePath: string): Promise<PlanEntry | null> {
  try {
    const [raw, stat] = await Promise.all([
      fs.readFile(filePath, "utf-8"),
      fs.stat(filePath),
    ]);

    const { fm, body } = parseFrontmatter(raw);

    const slug = path.basename(filePath, ".md");

    const title = pickTitle(fm, body, slug);

    const tags = pickTags(fm);

    const relatedSessionIds = [...body.matchAll(UUID_RE)].map((m) => m[0].toLowerCase());
    const uniqueSessionIds = [...new Set(relatedSessionIds)];

    return {
      slug,
      path: filePath,
      title,
      tags,
      relatedSessionIds: uniqueSessionIds,
      mtime: stat.mtime.toISOString(),
      sizeBytes: stat.size,
    };
  } catch {
    return null;
  }
}

function pickTitle(
  fm: Record<string, unknown>,
  body: string,
  fallback: string
): string {
  if (typeof fm.title === "string" && fm.title.trim()) {
    return fm.title.trim();
  }
  const headingMatch = body.match(/^#\s+(.+)$/m);
  if (headingMatch) {
    return headingMatch[1].trim();
  }
  return fallback;
}

function pickTags(fm: Record<string, unknown>): string[] {
  const raw = fm.tags;
  if (!raw) return [];
  if (Array.isArray(raw)) {
    return raw.filter((t): t is string => typeof t === "string");
  }
  if (typeof raw === "string") {
    return raw
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
  }
  return [];
}
