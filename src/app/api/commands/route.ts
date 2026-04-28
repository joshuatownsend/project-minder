import { NextRequest, NextResponse } from "next/server";
import { getCachedScan, setCachedScan } from "@/lib/cache";
import { scanAllProjects } from "@/lib/scanner";
import {
  walkUserCommands,
  walkProjectCommands,
} from "@/lib/indexer/walkCommands";
import type { CommandEntry } from "@/lib/types";

const CACHE_TTL_MS = 2 * 60 * 1000;

interface CommandRow {
  entry: CommandEntry;
}

const globalForCommands = globalThis as unknown as {
  __commandsRouteCache?: Map<string, { data: CommandRow[]; cachedAt: number }>;
};

function getRouteCache(key: string): CommandRow[] | null {
  const cache = globalForCommands.__commandsRouteCache;
  if (!cache) return null;
  const slot = cache.get(key);
  if (!slot) return null;
  if (Date.now() - slot.cachedAt < CACHE_TTL_MS) return slot.data;
  return null;
}

function setRouteCache(key: string, data: CommandRow[]) {
  if (!globalForCommands.__commandsRouteCache) {
    globalForCommands.__commandsRouteCache = new Map();
  }
  globalForCommands.__commandsRouteCache.set(key, { data, cachedAt: Date.now() });
}

export function invalidateCommandsRouteCache() {
  globalForCommands.__commandsRouteCache = new Map();
}

export async function GET(request: NextRequest) {
  const source = request.nextUrl.searchParams.get("source");
  const projectSlug = request.nextUrl.searchParams.get("project");
  const query = request.nextUrl.searchParams.get("q")?.toLowerCase();

  const cacheKey = `${source ?? ""}|${projectSlug ?? ""}|${query ?? ""}`;
  const cached = getRouteCache(cacheKey);
  if (cached) return NextResponse.json(cached);

  // Discover: user-scope first, then every scanned project.
  let scan = getCachedScan();
  if (!scan) {
    scan = await scanAllProjects();
    setCachedScan(scan);
  }

  const [userCommands, ...projectCommandSets] = await Promise.all([
    walkUserCommands(),
    ...scan.projects.map((p) => walkProjectCommands(p.path, p.slug)),
  ]);

  let entries: CommandEntry[] = [...userCommands, ...projectCommandSets.flat()];

  if (source) {
    entries = entries.filter((e) => e.source === source);
  }

  if (projectSlug) {
    entries = entries.filter((e) => e.projectSlug === projectSlug);
  }

  if (query) {
    entries = entries.filter((e) => {
      const text = [e.name, e.description, e.category, e.slug, e.pluginName]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return text.includes(query);
    });
  }

  // Sort: project-local first, then user-scope, alphabetic within each.
  entries.sort((a, b) => {
    if (a.source !== b.source) {
      const order = { project: 0, user: 1, plugin: 2 } as const;
      return order[a.source] - order[b.source];
    }
    return a.slug.localeCompare(b.slug);
  });

  const rows: CommandRow[] = entries.map((entry) => ({ entry }));
  setRouteCache(cacheKey, rows);
  return NextResponse.json(rows);
}
