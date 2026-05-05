import { promises as fs, readdirSync, readFileSync } from "fs";
import path from "path";
import type { SubagentCategory } from "@/lib/types";

export type { SubagentCategory };

export interface SubagentMeta {
  description?: string;
  agentType?: string;
  turnCount?: number;
  category?: SubagentCategory;
  metaSourced: boolean;
}

// Verb-prefix → category mapping (longest match first where prefixes overlap)
const VERB_PREFIXES: [string[], SubagentCategory][] = [
  [["fix", "repair", "resolve"], "fix"],
  [["find", "locate", "search"], "find"],
  [["check", "verify", "validate", "audit"], "check"],
  [["query", "get", "fetch", "read", "list"], "query"],
  [["research", "investigate", "explore", "analyze", "analyse"], "research"],
  [["create", "build", "add", "implement", "generate", "write"], "create"],
];

export function categorize(description: string | undefined): SubagentCategory {
  if (!description) return "other";
  const lower = description.trim().toLowerCase();
  for (const [prefixes, category] of VERB_PREFIXES) {
    for (const prefix of prefixes) {
      if (lower.startsWith(prefix)) return category;
    }
  }
  return "other";
}

/**
 * Reads all agent-*.meta.json files for a session and returns a Map keyed
 * by the description string (the exact text from the parent JSONL's
 * input.description). Meta files without a description field are skipped
 * since there is no reliable way to match them to parent Agent tool calls.
 */
function parseMetaFile(raw: string): SubagentMeta | null {
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  const description =
    typeof data.description === "string" ? data.description : undefined;
  if (!description) return null;
  return {
    description,
    agentType: typeof data.agentType === "string" ? data.agentType : undefined,
    turnCount: typeof data.turnCount === "number" ? data.turnCount : undefined,
    category: categorize(description),
    metaSourced: true,
  };
}

function subagentsDir(sessionJsonlPath: string): string {
  const sessionId = path.basename(sessionJsonlPath, ".jsonl");
  return path.join(path.dirname(sessionJsonlPath), sessionId, "subagents");
}

export async function readSubagentMeta(
  sessionJsonlPath: string
): Promise<Map<string, SubagentMeta>> {
  const dir = subagentsDir(sessionJsonlPath);
  const result = new Map<string, SubagentMeta>();

  let files: string[];
  try {
    files = await fs.readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      // eslint-disable-next-line no-console
      console.error("[subagentMeta] readdir failed:", err);
    }
    return result;
  }

  await Promise.all(
    files
      .filter((f) => f.startsWith("agent-") && f.endsWith(".meta.json"))
      .map(async (filename) => {
        let raw: string;
        try {
          raw = await fs.readFile(path.join(dir, filename), "utf-8");
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error("[subagentMeta] readFile failed:", filename, err);
          return;
        }
        const meta = parseMetaFile(raw);
        if (meta?.description) result.set(meta.description, meta);
      })
  );

  return result;
}

/**
 * Synchronous variant for use in sync contexts (better-sqlite3 DB path).
 * Same matching contract: keyed by full description string.
 */
export function readSubagentMetaSync(
  sessionJsonlPath: string
): Map<string, SubagentMeta> {
  const dir = subagentsDir(sessionJsonlPath);
  const result = new Map<string, SubagentMeta>();

  let files: string[];
  try {
    files = readdirSync(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      // eslint-disable-next-line no-console
      console.error("[subagentMeta] readdirSync failed:", err);
    }
    return result;
  }

  for (const filename of files) {
    if (!filename.startsWith("agent-") || !filename.endsWith(".meta.json")) continue;
    let raw: string;
    try {
      raw = readFileSync(path.join(dir, filename), "utf-8");
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[subagentMeta] readFileSync failed:", filename, err);
      continue;
    }
    const meta = parseMetaFile(raw);
    if (meta?.description) result.set(meta.description, meta);
  }

  return result;
}
