import { promises as fs } from "fs";
import { createHash } from "crypto";
import path from "path";
import type {
  MemoryFileEntry,
  MemoryIndexSummary,
  MemoryStaleness,
  ProjectData,
} from "../types";
import { expandImports } from "../scanner/expandImports";
import { memoryDirFor } from "../scanner/memoryWriter";
import { encodeMemoryId, userMemoryPath } from "./safety";
import { summarizeMemoryIndex } from "./memoryIndex";

const STALE_AGE_MS = 30 * 24 * 60 * 60_000;
const PREVIEW_CHARS = 200;
const CACHE_TTL = 60_000;
const IMPORT_CACHE_MAX = 500;

export interface MemoryListResult {
  entries: MemoryFileEntry[];
  /** One summary per scanned project that has a memory dir. */
  indexSummaries: MemoryIndexSummary[];
}

interface InventoryCache {
  key: string;
  result: MemoryListResult;
  cachedAt: number;
}

interface ImportCacheEntry {
  mtimeMs: number;
  brokenImports: string[];
}

const g = globalThis as unknown as {
  __memoryInventoryCache?: InventoryCache | null;
  __memoryImportCache?: Map<string, ImportCacheEntry>;
};
g.__memoryImportCache ??= new Map();

export function invalidateMemoryInventoryCache(): void {
  g.__memoryInventoryCache = null;
}

interface DiscoveryInput {
  projects: ProjectData[];
}

// Hash the project set so cache hits require both freshness AND a matching
// project list. Without this, a list call after a rescan could return entries
// for projects that are no longer present (which would then 400 on PUT
// because /api/memory/by-id/[id] revalidates against the fresh list).
function projectsKey(projects: ProjectData[]): string {
  const h = createHash("sha256");
  for (const p of projects) h.update(`${p.slug}\0${p.path}\n`);
  return h.digest("hex").slice(0, 16);
}

export async function listMemoryFiles(input: DiscoveryInput): Promise<MemoryListResult> {
  const key = projectsKey(input.projects);
  const cached = g.__memoryInventoryCache;
  if (cached && cached.key === key && Date.now() - cached.cachedAt < CACHE_TTL) {
    return cached.result;
  }

  const entries: MemoryFileEntry[] = [];
  const indexSummaries: MemoryIndexSummary[] = [];

  const userEntry = await tryUser();
  if (userEntry) entries.push(userEntry);

  await Promise.all(
    input.projects.map(async (p) => {
      const proj = await tryProject(p);
      if (proj) entries.push(proj);
      const auto = await tryAuto(p);
      if (auto) {
        entries.push(...auto.entries);
        if (auto.summary) indexSummaries.push(auto.summary);
      }
    }),
  );

  entries.sort((a, b) => {
    const scoreA = scopeOrder(a.scope);
    const scoreB = scopeOrder(b.scope);
    if (scoreA !== scoreB) return scoreA - scoreB;
    return a.displayName.localeCompare(b.displayName);
  });

  indexSummaries.sort((a, b) => a.projectName.localeCompare(b.projectName));

  const result: MemoryListResult = { entries, indexSummaries };
  g.__memoryInventoryCache = { key, result, cachedAt: Date.now() };
  return result;
}

function scopeOrder(scope: MemoryFileEntry["scope"]): number {
  return scope === "user" ? 0 : scope === "project" ? 1 : 2;
}

async function tryUser(): Promise<MemoryFileEntry | null> {
  return readEntry(userMemoryPath(), { scope: "user", displayName: "User CLAUDE.md" });
}

async function tryProject(p: ProjectData): Promise<MemoryFileEntry | null> {
  return readEntry(path.resolve(path.join(p.path, "CLAUDE.md")), {
    scope: "project",
    projectSlug: p.slug,
    projectName: p.name,
    displayName: "CLAUDE.md",
  });
}

interface AutoResult {
  entries: MemoryFileEntry[];
  /** Null when this project's memory dir has no MEMORY.md (still index-able). */
  summary: MemoryIndexSummary | null;
}

async function tryAuto(p: ProjectData): Promise<AutoResult | null> {
  const memDir = memoryDirFor(p.path);
  let names: string[];
  try {
    names = await fs.readdir(memDir);
  } catch {
    return null;
  }
  const mdNames = names.filter(
    (n) => n.toLowerCase().endsWith(".md") && !n.startsWith("."),
  );

  // Read MEMORY.md (case-insensitive) once and parse, so we can stamp each
  // body entry's `indexed` flag in a single pass instead of re-reading later.
  const indexName = mdNames.find((n) => n.toLowerCase() === "memory.md") ?? null;
  let indexContent: string | null = null;
  if (indexName) {
    try {
      indexContent = await fs.readFile(path.join(memDir, indexName), "utf-8");
    } catch {
      indexContent = null;
    }
  }
  const bodyFilenames = mdNames.filter((n) => n.toLowerCase() !== "memory.md");
  const summary = summarizeMemoryIndex({
    projectSlug: p.slug,
    projectName: p.name,
    indexContent,
    bodyFilenames,
  });
  // Index awareness only makes sense when MEMORY.md exists. Without it we
  // still return every body file but leave `indexed` undefined so the UI can
  // show a neutral state instead of misleading "orphan" badges everywhere.
  const linkedSet = summary.present
    ? new Set(summary.linkedNames)
    : null;

  const out = await Promise.all(
    mdNames.map(async (name) => {
      const entry = await readEntry(path.resolve(path.join(memDir, name)), {
        scope: "auto",
        projectSlug: p.slug,
        projectName: p.name,
        displayName: name,
      });
      if (!entry) return null;
      if (name.toLowerCase() === "memory.md") return entry;
      if (linkedSet) entry.indexed = linkedSet.has(name.toLowerCase());
      return entry;
    }),
  );

  const entries = out.filter((e): e is MemoryFileEntry => e !== null);
  return { entries, summary: summary.present ? summary : null };
}

interface PartialEntry {
  scope: MemoryFileEntry["scope"];
  projectSlug?: string;
  projectName?: string;
  displayName: string;
}

async function readEntry(
  absPath: string,
  meta: PartialEntry,
): Promise<MemoryFileEntry | null> {
  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(absPath);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;

  // Read full file: expandImports needs the whole entry so late `@import`
  // directives aren't missed. The mtime-keyed import cache below ensures
  // repeat list calls don't re-read or re-recurse when nothing changed.
  let raw: string;
  try {
    raw = await fs.readFile(absPath, "utf-8");
  } catch {
    return null;
  }

  const stale = await computeStaleness(absPath, raw, stat.mtimeMs);

  return {
    id: encodeMemoryId(absPath),
    scope: meta.scope,
    projectSlug: meta.projectSlug,
    projectName: meta.projectName,
    absPath,
    displayName: meta.displayName,
    mtimeMs: stat.mtimeMs,
    sizeBytes: stat.size,
    preview: makePreview(raw),
    stale,
  };
}

async function computeStaleness(
  absPath: string,
  raw: string,
  mtimeMs: number,
): Promise<MemoryStaleness> {
  const ageOver30d = Date.now() - mtimeMs > STALE_AGE_MS;

  const importCache = g.__memoryImportCache!;
  const cached = importCache.get(absPath);
  if (cached && cached.mtimeMs === mtimeMs) {
    // LRU touch: re-insert to move to most-recently-used end of Map iteration order.
    importCache.delete(absPath);
    importCache.set(absPath, cached);
    return { ageOver30d, brokenImports: cached.brokenImports };
  }

  let brokenImports: string[] = [];
  try {
    const expanded = await expandImports(absPath, raw);
    brokenImports = expanded.imports
      .filter((i) => i.error !== undefined)
      .map((i) => i.spec);
  } catch {
    // best-effort; leave brokenImports empty
  }

  if (importCache.size >= IMPORT_CACHE_MAX) {
    // Evict oldest entry (Map preserves insertion order).
    const oldest = importCache.keys().next().value;
    if (oldest !== undefined) importCache.delete(oldest);
  }
  importCache.set(absPath, { mtimeMs, brokenImports });
  return { ageOver30d, brokenImports };
}

function makePreview(raw: string): string {
  const stripped = raw.replace(/^---\n[\s\S]*?\n---\n?/, "").trimStart();
  return stripped.slice(0, PREVIEW_CHARS).replace(/\s+/g, " ").trim();
}
