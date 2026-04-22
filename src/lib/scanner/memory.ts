import { promises as fs } from "fs";
import path from "path";
import os from "os";
import yaml from "js-yaml";
import { encodePath } from "./claudeConversations";
import type { MemoryData, MemoryFile, MemoryType } from "../types";

const moduleCache = new Map<string, { data: MemoryData; cachedAt: number }>();
const CACHE_TTL = 30_000;

function parseFrontmatter(content: string): { type?: MemoryType; description?: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  try {
    const fm = yaml.load(match[1]) as Record<string, unknown>;
    return {
      type: typeof fm?.type === "string" ? (fm.type as MemoryType) : undefined,
      description: typeof fm?.description === "string" ? fm.description : undefined,
    };
  } catch {
    return {};
  }
}

export async function scanMemory(projectPath: string): Promise<MemoryData> {
  const cached = moduleCache.get(projectPath);
  if (cached && Date.now() - cached.cachedAt < CACHE_TTL) return cached.data;

  const memoryDir = path.join(
    os.homedir(), ".claude", "projects", encodePath(projectPath), "memory"
  );

  let entries: string[];
  try {
    entries = await fs.readdir(memoryDir);
  } catch {
    const empty: MemoryData = { files: [] };
    moduleCache.set(projectPath, { data: empty, cachedAt: Date.now() });
    return empty;
  }

  let indexMd: string | undefined;
  const fileResults = await Promise.all(
    entries
      .filter((e) => e.endsWith(".md"))
      .map(async (entry): Promise<MemoryFile | null> => {
        const filePath = path.join(memoryDir, entry);
        try {
          const [fstat, content] = await Promise.all([
            fs.stat(filePath),
            fs.readFile(filePath, "utf-8"),
          ]);
          if (entry === "MEMORY.md") {
            indexMd = content;
            return null;
          }
          const { type, description } = parseFrontmatter(content);
          return { name: entry, type, description, mtime: fstat.mtime.toISOString(), size: fstat.size };
        } catch {
          return null;
        }
      })
  );

  const files = fileResults
    .filter((f): f is MemoryFile => f !== null)
    .sort((a, b) => new Date(b.mtime).getTime() - new Date(a.mtime).getTime());

  const data: MemoryData = { indexMd, files };
  moduleCache.set(projectPath, { data, cachedAt: Date.now() });
  return data;
}
