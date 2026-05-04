import { promises as fs } from "fs";
import path from "path";
import os from "os";
import { expandImports } from "./expandImports";

/**
 * Module-scoped cache for the user-scope `~/.claude/CLAUDE.md`. The user
 * file is global to every project's audit + every context-budget call, so
 * we re-expand it at most once per `(path, mtime)` pair. The cache lives
 * forever — there's only ever one entry, keyed by absolute path.
 */
const cache = new Map<string, { mtimeMs: number; content: string }>();

export async function readUserClaudeMdContent(): Promise<string> {
  const filePath = path.join(os.homedir(), ".claude", "CLAUDE.md");
  try {
    const st = await fs.stat(filePath);
    const cached = cache.get(filePath);
    if (cached && cached.mtimeMs === st.mtimeMs) return cached.content;
    const expanded = await expandImports(filePath);
    cache.set(filePath, { mtimeMs: st.mtimeMs, content: expanded.content });
    return expanded.content;
  } catch {
    return "";
  }
}
