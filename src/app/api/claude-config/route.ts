import { NextRequest, NextResponse } from "next/server";
import { getCachedScan, setCachedScan } from "@/lib/cache";
import { scanAllProjects } from "@/lib/scanner";
import { getUserConfig } from "@/lib/userConfigCache";
import {
  CONFIG_TYPES,
  CiCdInfo,
  ConfigType,
  HookEntry,
  McpServer,
  PluginEntry,
  ProjectData,
} from "@/lib/types";

const CACHE_TTL_MS = 2 * 60 * 1000;

interface HookRow extends HookEntry {
  projectSlug?: string;
  projectName?: string;
}

interface McpRow extends McpServer {
  projectSlug?: string;
  projectName?: string;
}

interface CicdRow {
  projectSlug: string;
  projectName: string;
  cicd: CiCdInfo;
}

interface AggregatedPayload {
  hooks: HookRow[];
  plugins: PluginEntry[];
  mcp: McpRow[];
  cicd: CicdRow[];
}

const globalForCC = globalThis as unknown as {
  __claudeConfigCache?: Map<string, { data: AggregatedPayload; cachedAt: number }>;
};

function getRouteCache(key: string): AggregatedPayload | null {
  const cache = globalForCC.__claudeConfigCache;
  if (!cache) return null;
  const slot = cache.get(key);
  if (!slot) return null;
  if (Date.now() - slot.cachedAt < CACHE_TTL_MS) return slot.data;
  cache.delete(key);
  return null;
}

function setRouteCache(key: string, data: AggregatedPayload) {
  let cache = globalForCC.__claudeConfigCache;
  if (!cache) {
    cache = new Map();
    globalForCC.__claudeConfigCache = cache;
  }
  const cutoff = Date.now() - CACHE_TTL_MS;
  for (const [k, slot] of cache) {
    if (slot.cachedAt < cutoff) cache.delete(k);
  }
  cache.set(key, { data, cachedAt: Date.now() });
}

export function invalidateClaudeConfigRouteCache() {
  globalForCC.__claudeConfigCache = new Map();
}

export async function GET(request: NextRequest) {
  const typeParam = (request.nextUrl.searchParams.get("type") ?? "all").toLowerCase();
  const type: ConfigType = (CONFIG_TYPES as readonly string[]).includes(typeParam)
    ? (typeParam as ConfigType)
    : "all";
  const projectSlug = request.nextUrl.searchParams.get("project") ?? undefined;
  const query = request.nextUrl.searchParams.get("q")?.toLowerCase() ?? undefined;

  const cacheable = !query;
  const cacheKey = `${type}|${projectSlug ?? ""}`;
  if (cacheable) {
    const cached = getRouteCache(cacheKey);
    if (cached) return NextResponse.json(cached);
  }

  const [scan, userConfig] = await Promise.all([
    (async () => {
      let result = getCachedScan();
      if (!result) {
        result = await scanAllProjects();
        setCachedScan(result);
      }
      return result;
    })(),
    getUserConfig(),
  ]);

  const allProjects = scan.projects;
  const projects = projectSlug
    ? allProjects.filter((p) => p.slug === projectSlug)
    : allProjects;
  const includeUserScope = !projectSlug;

  const payload: AggregatedPayload = {
    hooks: [],
    plugins: [],
    mcp: [],
    cicd: [],
  };

  if (type === "hooks" || type === "all") {
    payload.hooks = collectHooks(projects);
    if (includeUserScope) {
      payload.hooks.push(...userConfig.hooks.entries.map((e) => ({ ...e })));
    }
  }

  if (type === "plugins" || type === "all") {
    payload.plugins = userConfig.plugins.plugins;
  }

  if (type === "mcp" || type === "all") {
    payload.mcp = collectMcp(projects);
    if (includeUserScope) {
      payload.mcp.push(...userConfig.mcpServers.servers.map((s) => ({ ...s })));
    }
  }

  if (type === "cicd" || type === "all") {
    payload.cicd = collectCicd(projects);
  }

  if (query) {
    applyQuery(payload, query);
    return NextResponse.json(payload);
  }

  setRouteCache(cacheKey, payload);
  return NextResponse.json(payload);
}

function collectHooks(projects: ProjectData[]): HookRow[] {
  const rows: HookRow[] = [];
  for (const p of projects) {
    if (!p.hooks) continue;
    for (const e of p.hooks.entries) {
      rows.push({ ...e, projectSlug: p.slug, projectName: p.name });
    }
  }
  return rows;
}

function collectMcp(projects: ProjectData[]): McpRow[] {
  const rows: McpRow[] = [];
  for (const p of projects) {
    if (!p.mcpServers) continue;
    for (const s of p.mcpServers.servers) {
      rows.push({ ...s, projectSlug: p.slug, projectName: p.name });
    }
  }
  return rows;
}

function collectCicd(projects: ProjectData[]): CicdRow[] {
  const rows: CicdRow[] = [];
  for (const p of projects) {
    if (!p.cicd) continue;
    rows.push({ projectSlug: p.slug, projectName: p.name, cicd: p.cicd });
  }
  return rows;
}

function applyQuery(payload: AggregatedPayload, q: string): void {
  payload.hooks = payload.hooks.filter((h) =>
    [h.event, h.matcher, h.projectName, h.projectSlug, h.commands.map((c) => c.command).join(" ")]
      .filter(Boolean)
      .join(" ")
      .toLowerCase()
      .includes(q)
  );

  payload.plugins = payload.plugins.filter((p) =>
    [p.name, p.marketplace, p.version].filter(Boolean).join(" ").toLowerCase().includes(q)
  );

  payload.mcp = payload.mcp.filter((m) =>
    [m.name, m.command, m.url, m.transport, m.projectName, m.projectSlug]
      .filter(Boolean)
      .join(" ")
      .toLowerCase()
      .includes(q)
  );

  payload.cicd = payload.cicd.filter((c) => {
    const text = [
      c.projectName,
      c.projectSlug,
      ...c.cicd.workflows.map((w) => w.name ?? w.file),
      ...c.cicd.workflows.flatMap((w) => w.jobs.flatMap((j) => j.actionUses)),
      ...c.cicd.hosting.map((h) => h.platform),
      ...c.cicd.dependabot.map((d) => d.ecosystem),
    ]
      .join(" ")
      .toLowerCase();
    return text.includes(q);
  });
}
