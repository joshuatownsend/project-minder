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
export async function readSubagentMeta(
  sessionJsonlPath: string
): Promise<Map<string, SubagentMeta>> {
  const sessionId = path.basename(sessionJsonlPath, ".jsonl");
  const subagentsDir = path.join(
    path.dirname(sessionJsonlPath),
    sessionId,
    "subagents"
  );

  const result = new Map<string, SubagentMeta>();

  let files: string[];
  try {
    files = await fs.readdir(subagentsDir);
  } catch {
    return result;
  }

  const metaFiles = files.filter(
    (f) => f.startsWith("agent-") && f.endsWith(".meta.json")
  );

  await Promise.all(
    metaFiles.map(async (filename) => {
      const filePath = path.join(subagentsDir, filename);
      let raw: string;
      try {
        raw = await fs.readFile(filePath, "utf-8");
      } catch {
        return;
      }
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        return;
      }
      const description =
        typeof data.description === "string" ? data.description : undefined;
      const agentType =
        typeof data.agentType === "string" ? data.agentType : undefined;
      const turnCount =
        typeof data.turnCount === "number" ? data.turnCount : undefined;

      if (!description) return; // can't key without description

      const meta: SubagentMeta = {
        description,
        agentType,
        turnCount,
        category: categorize(description),
        metaSourced: true,
      };
      result.set(description, meta);
    })
  );

  return result;
}

/**
 * Synchronous variant of `readSubagentMeta` for use in sync contexts
 * (e.g. the better-sqlite3 DB path in `sessionDetailFromDb.ts`).
 * Same matching contract: keyed by full description string.
 */
export function readSubagentMetaSync(
  sessionJsonlPath: string
): Map<string, SubagentMeta> {
  const sessionId = path.basename(sessionJsonlPath, ".jsonl");
  const subagentsDir = path.join(
    path.dirname(sessionJsonlPath),
    sessionId,
    "subagents"
  );

  const result = new Map<string, SubagentMeta>();

  let files: string[];
  try {
    files = readdirSync(subagentsDir);
  } catch {
    return result;
  }

  for (const filename of files) {
    if (!filename.startsWith("agent-") || !filename.endsWith(".meta.json")) {
      continue;
    }
    let raw: string;
    try {
      raw = readFileSync(path.join(subagentsDir, filename), "utf-8");
    } catch {
      continue;
    }
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      continue;
    }
    const description =
      typeof data.description === "string" ? data.description : undefined;
    if (!description) continue;

    result.set(description, {
      description,
      agentType: typeof data.agentType === "string" ? data.agentType : undefined,
      turnCount: typeof data.turnCount === "number" ? data.turnCount : undefined,
      category: categorize(description),
      metaSourced: true,
    });
  }

  return result;
}
