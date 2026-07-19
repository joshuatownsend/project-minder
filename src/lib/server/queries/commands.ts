import "server-only";
import type { QueryClient } from "@tanstack/react-query";
import { getCachedScan, setCachedScan } from "@/lib/cache";
import { scanAllProjects } from "@/lib/scanner";
import {
  walkUserCommands,
  walkPluginCommands,
  walkProjectCommands,
} from "@/lib/indexer/walkCommands";
import { loadProvenanceContext } from "@/lib/indexer/provenance";
import { checkWslRoot, parseWslUncPath } from "@/lib/wsl";
import type { CommandEntry } from "@/lib/types";
import { queryKeys } from "@/lib/queryKeys";
import { jsonClone } from "@/lib/server/prefetch";

/**
 * Shared `/api/commands` response computation, used by BOTH the route (client
 * fetch) and the RSC prefetch. `loadCommandsResponse` is the entire GET body —
 * route-level cache check, the user/plugin/project command walk, the
 * source/project/q filters, the sort, and the cache write — parameterized by the
 * three filters. The route wraps it in an HTTP response; the prefetch calls it
 * with no filters and JSON-clones the result, so the hydrated cache entry is
 * byte-identical to a client `fetch('/api/commands')`.
 */

const CACHE_TTL_MS = 2 * 60 * 1000;

export interface CommandRow {
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

/** The full `/api/commands` GET body, filter-parameterized. */
export async function loadCommandsResponse(
  source: string | null,
  projectSlug: string | null,
  query: string | null,
): Promise<CommandRow[]> {
  const q = query?.toLowerCase() ?? null;
  const cacheKey = `${source ?? ""}|${projectSlug ?? ""}|${q ?? ""}`;
  const cached = getRouteCache(cacheKey);
  if (cached) return cached;

  // Discover: user-scope first, then every scanned project.
  let scan = getCachedScan();
  if (!scan) {
    scan = await scanAllProjects();
    setCachedScan(scan);
  }

  const ctx = await loadProvenanceContext();

  const [userCommands, pluginCommandSets, ...projectCommandSets] = await Promise.all([
    walkUserCommands(ctx),
    walkPluginCommands(ctx.installedPlugins, ctx),
    ...scan.projects.map(async (p) => {
      // Never-wake preflight (mirrors the catalog agents/skills walk):
      // carried-forward projects under a stopped WSL distro contribute no
      // commands this cycle rather than a walk that would wake the VM.
      if (parseWslUncPath(p.path)) {
        const check = await checkWslRoot(p.path);
        if (check && !check.ok) return [] as CommandEntry[];
      }
      return walkProjectCommands(p.path, p.slug, ctx);
    }),
  ]);

  let entries: CommandEntry[] = [...userCommands, ...pluginCommandSets, ...projectCommandSets.flat()];

  if (source) {
    entries = entries.filter((e) => e.source === source);
  }

  if (projectSlug) {
    entries = entries.filter((e) => e.projectSlug === projectSlug);
  }

  if (q) {
    entries = entries.filter((e) => {
      const text = [e.name, e.description, e.category, e.slug, e.pluginName]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return text.includes(q);
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
  return rows;
}

/** Prefetch the default (unfiltered) commands catalog (`["commands",null,null,null]`). */
export async function prefetchCommands(qc: QueryClient): Promise<void> {
  await qc.prefetchQuery({
    queryKey: queryKeys.commands(),
    queryFn: async () => jsonClone(await loadCommandsResponse(null, null, null)),
  });
}
