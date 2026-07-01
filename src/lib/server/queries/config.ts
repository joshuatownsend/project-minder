import "server-only";
import type { QueryClient } from "@tanstack/react-query";
import { getCachedScan, setCachedScan } from "@/lib/cache";
import { scanAllProjects } from "@/lib/scanner";
import { getUserConfig } from "@/lib/userConfigCache";
import { makeHookKey } from "@/lib/template/unitKey";
import type { ProjectData } from "@/lib/types";
import type { ConfigPayload, HookRow, McpRow, CicdRow } from "@/hooks/useConfig";
import { queryKeys } from "@/lib/queryKeys";
import { jsonClone } from "@/lib/server/prefetch";

/**
 * Shared `/api/claude-config` response computation, used by both the route and
 * the RSC prefetch (Performance P3 — PR 3). Aggregates the requested catalog
 * `type` (hooks/mcp/cicd/plugins/settingskeys, or `all`) across the scanned
 * projects plus the user scope, then applies the optional project/keyword
 * filters — so the prefetched cache entry is byte-identical to the body a client
 * fetch would receive.
 *
 * Callers pass an already-normalized `type` (the route validates against
 * `CONFIG_TYPES`; the page validates against its catalog set). The
 * settings/playground "don't fetch" decision lives in those callers — this
 * loader always computes the payload for the `type` it is given. The route's
 * 2-min response cache stays in the route; this is the pure compute layer.
 */
export async function loadClaudeConfigResponse(
  type: string,
  project: string | null,
  query: string | null,
): Promise<ConfigPayload> {
  const projectSlug = project ?? undefined;
  const q = query?.toLowerCase() ?? undefined;

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

  const payload: ConfigPayload = {
    hooks: [],
    plugins: [],
    mcp: [],
    cicd: [],
    settingsKeys: [],
  };

  if (type === "hooks" || type === "all") {
    payload.hooks = collectHooks(projects);
    if (includeUserScope) {
      for (const e of userConfig.hooks.entries) {
        for (const inv of e.commands) {
          payload.hooks.push({
            ...e,
            commands: [inv],
            unitKey: makeHookKey(e.event, e.matcher, inv.command),
          });
        }
      }
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

  if ((type === "settingskeys" || type === "all") && includeUserScope) {
    payload.settingsKeys = userConfig.settingsKeys;
  }

  if (q) {
    applyQuery(payload, q);
  }

  return payload;
}

/**
 * Prefetch one catalog tab's config payload into the server query client. Keyed
 * with the unfiltered (`query: null`) key the client's first mount produces, so
 * a `?type=hooks` deep-link hydrates instead of fetching on mount.
 */
export async function prefetchConfig(
  qc: QueryClient,
  type: string,
  project?: string,
): Promise<void> {
  await qc.prefetchQuery({
    queryKey: queryKeys.config(type, project),
    queryFn: async () => jsonClone(await loadClaudeConfigResponse(type, project ?? null, null)),
  });
}

/** Expands each multi-invocation HookEntry into one row per invocation so
 *  Template Mode's `↗ copy to project` button has a unique addressable unit
 *  for every command. Without this, only the first invocation of a tuple
 *  would be copyable. */
function collectHooks(projects: ProjectData[]): HookRow[] {
  const rows: HookRow[] = [];
  for (const p of projects) {
    if (!p.hooks) continue;
    for (const e of p.hooks.entries) {
      for (const inv of e.commands) {
        rows.push({
          ...e,
          commands: [inv],
          projectSlug: p.slug,
          projectName: p.name,
          projectPath: p.path,
          unitKey: makeHookKey(e.event, e.matcher, inv.command),
        });
      }
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

function applyQuery(payload: ConfigPayload, q: string): void {
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

  payload.settingsKeys = payload.settingsKeys.filter((sk) =>
    sk.keyPath.toLowerCase().includes(q)
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
