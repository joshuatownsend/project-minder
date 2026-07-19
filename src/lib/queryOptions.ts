/**
 * Centralized TanStack Query *options* factories.
 *
 * Each factory pairs a {@link queryKeys} entry with the exact `queryFn` that
 * fetches it, wrapped in TanStack's `queryOptions()` helper so the same
 * definition can be consumed three ways without drifting:
 *   - `useQuery(sessionsQuery())` inside a data hook (see `src/hooks/*`);
 *   - `queryClient.prefetchQuery(sessionsQuery())` on hover (PR 2, see
 *     `useHoverPrefetch`);
 *   - `queryClient.invalidateQueries` / SSE-driven refresh (PR 5).
 *
 * Before this module the fetch logic lived inline in each hook, so a prefetch
 * path would have had to re-declare the URL and the `res.ok` handling — two
 * copies that silently rot apart. Keeping one factory per query means the
 * warm-on-hover request and the real on-mount request are byte-for-byte the
 * same call, hitting the same cache entry.
 *
 * Runtime-behavior options that only matter to a live mounted query
 * (`refetchInterval`, `enabled`) are intentionally *not* baked in here; the
 * consuming hook layers them on, so prefetch stays a pure one-shot fetch.
 */
import { queryOptions } from "@tanstack/react-query";
import { queryKeys } from "@/lib/queryKeys";
import type {
  SessionSummary,
  SessionDetail,
  StatsData,
  InsightEntry,
  InsightsInfo,
  CommandEntry,
  TemplateManifest,
  ManualStepsInfo,
} from "@/lib/types";
import type { UsageReport } from "@/lib/usage/types";
import type { Provenance } from "@/lib/indexer/types";
// Type-only import (erased at runtime, so no client/server boundary or import
// cycle): the config catalog payload shape is defined alongside the useConfig hook.
import type { ConfigPayload } from "@/hooks/useConfig";

/** One row of the `/api/agents` catalog (entry metadata joined with usage). */
export interface AgentRow {
  entry?: {
    id: string;
    slug: string;
    name: string;
    description?: string;
    source: "user" | "plugin" | "project";
    pluginName?: string;
    projectSlug?: string;
    category?: string;
    filePath: string;
    bodyExcerpt: string;
    frontmatter: Record<string, unknown>;
    mtime: string;
    ctime: string;
    model?: string;
    tools?: string[];
    color?: string;
    emoji?: string;
    provenance: Provenance;
    isSymlink?: boolean;
    realPath?: string;
    parseWarnings?: string[];
    fileBytes?: number;
    projectedContextCost?: { tokenEstimate: number; contextWindowPercent: number };
  };
  usage?: {
    name: string;
    invocations: number;
    firstUsed?: string;
    lastUsed?: string;
    projects: Record<string, number>;
    sessions: string[];
    costUsd?: number;
    inputTokens?: number;
    outputTokens?: number;
  };
  catalogMissing?: boolean;
}

/** One row of the `/api/skills` catalog (entry metadata joined with usage). */
export interface SkillRow {
  entry?: {
    id: string;
    slug: string;
    name: string;
    description?: string;
    source: "user" | "plugin" | "project";
    pluginName?: string;
    projectSlug?: string;
    category?: string;
    filePath: string;
    bodyExcerpt: string;
    frontmatter: Record<string, unknown>;
    mtime: string;
    ctime: string;
    layout: "bundled" | "standalone";
    version?: string;
    userInvocable?: boolean;
    argumentHint?: string;
    provenance: Provenance;
    isSymlink?: boolean;
    realPath?: string;
    parseWarnings?: string[];
    disabled?: boolean;
    fileBytes?: number;
    projectedContextCost?: { tokenEstimate: number; contextWindowPercent: number };
  };
  usage?: {
    name: string;
    invocations: number;
    firstUsed?: string;
    lastUsed?: string;
    projects: Record<string, number>;
    sessions: string[];
  };
  catalogMissing?: boolean;
  slashCount?: number;
  autoCount?: number;
}

/** Shape returned by `/api/insights` (cross-project list). */
export interface AllInsightsResult {
  insights: InsightEntry[];
  total: number;
}

/** All Claude Code session summaries. */
export function sessionsQuery() {
  return queryOptions({
    queryKey: queryKeys.sessions.all(),
    queryFn: async ({ signal }): Promise<SessionSummary[]> => {
      const res = await fetch("/api/sessions", { signal });
      if (!res.ok) throw new Error(`Failed to load sessions: ${res.status}`);
      return res.json();
    },
  });
}

/**
 * Full detail for one session. A 404 resolves to `null` (genuinely not found —
 * a stable result that's safe to cache); any *other* non-OK status throws, so a
 * transient failure is recorded as a query error instead of being cached as
 * fresh `null`. This matters because the query is hover-prefetched: caching
 * `null` for the 30s stale window would make a subsequent click render
 * "Session not found" without refetching — even after the API recovered
 * (PR #239 Codex review). An errored query is stale, so the click refetches.
 */
export function sessionDetailQuery(sessionId: string) {
  return queryOptions({
    queryKey: queryKeys.sessions.detail(sessionId),
    queryFn: async ({ signal }): Promise<SessionDetail | null> => {
      const res = await fetch(`/api/sessions/${sessionId}`, { signal });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`Failed to load session: ${res.status}`);
      return res.json();
    },
  });
}

/** Aggregated portfolio + usage stats. */
export function statsQuery() {
  return queryOptions({
    queryKey: queryKeys.stats(),
    queryFn: async ({ signal }): Promise<StatsData> => {
      const res = await fetch("/api/stats", { signal });
      if (!res.ok) throw new Error(`Failed to load stats: ${res.status}`);
      return res.json();
    },
  });
}

/**
 * Token usage report for a period, optionally scoped to one project.
 * `home` (ProjectData.usageHomeKey) disambiguates two Claude homes whose
 * identical path layouts share a usage slug (#311).
 */
export function usageQuery(period: string, project?: string, home?: string) {
  return queryOptions({
    queryKey: queryKeys.usage(period, project, home),
    queryFn: async ({ signal }): Promise<UsageReport> => {
      const params = new URLSearchParams({ period });
      if (project) params.set("project", project);
      if (home) params.set("home", home);
      const res = await fetch(`/api/usage?${params}`, { signal });
      if (!res.ok) throw new Error(`Failed to load usage: ${res.status}`);
      return res.json();
    },
  });
}

/** Agent catalog filtered by source/project/search. */
export function agentsQuery(source?: string, project?: string, query?: string) {
  return queryOptions({
    queryKey: queryKeys.agents(source, project, query),
    queryFn: async ({ signal }): Promise<AgentRow[]> => {
      const params = new URLSearchParams();
      if (source) params.set("source", source);
      if (project) params.set("project", project);
      if (query) params.set("q", query);
      const qs = params.toString();
      const res = await fetch(`/api/agents${qs ? `?${qs}` : ""}`, { signal });
      if (!res.ok) throw new Error(`Failed to load agents: ${res.status}`);
      return res.json();
    },
  });
}

/** Skill catalog filtered by source/project/search. */
export function skillsQuery(source?: string, project?: string, query?: string) {
  return queryOptions({
    queryKey: queryKeys.skills(source, project, query),
    queryFn: async ({ signal }): Promise<SkillRow[]> => {
      const params = new URLSearchParams();
      if (source) params.set("source", source);
      if (project) params.set("project", project);
      if (query) params.set("q", query);
      const qs = params.toString();
      const res = await fetch(`/api/skills${qs ? `?${qs}` : ""}`, { signal });
      if (!res.ok) throw new Error(`Failed to load skills: ${res.status}`);
      return res.json();
    },
  });
}

/** Cross-project insights list, optionally filtered by project/search. */
export function insightsListQuery(projectFilter?: string, query?: string) {
  return queryOptions({
    queryKey: queryKeys.insights.all(projectFilter, query),
    queryFn: async ({ signal }): Promise<AllInsightsResult> => {
      const params = new URLSearchParams();
      if (projectFilter) params.set("project", projectFilter);
      if (query) params.set("q", query);
      const qs = params.toString();
      const res = await fetch(`/api/insights${qs ? `?${qs}` : ""}`, { signal });
      if (!res.ok) throw new Error(`Failed to load insights: ${res.status}`);
      return res.json();
    },
  });
}

/**
 * Insights for one project. Same null-vs-throw contract as
 * {@link sessionDetailQuery}: a 404 is a stable "not found" (cache `null`), any
 * other non-OK throws so a transient failure isn't cached as fresh `null`.
 * (Not hover-prefetched today, but it's the identical detail-query hazard and a
 * future prefetch site would re-introduce the bug, so it's hardened in lockstep.)
 */
export function insightDetailQuery(slug: string) {
  return queryOptions({
    queryKey: queryKeys.insights.detail(slug),
    queryFn: async ({ signal }): Promise<InsightsInfo | null> => {
      const res = await fetch(`/api/insights/${slug}`, { signal });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`Failed to load insights: ${res.status}`);
      return res.json();
    },
  });
}

/** One row of the `/api/commands` catalog (a slash-command entry). */
export interface CommandRow {
  entry: CommandEntry;
}

/** Shape returned by `/api/templates` (GET): manifests + per-template errors. */
export interface TemplatesListResult {
  manifests: TemplateManifest[];
  errors: Array<{ slug: string; reason: string }>;
}

/** One project's manual-steps summary from `/api/manual-steps`. */
export interface ProjectManualSteps {
  slug: string;
  name: string;
  path: string;
  manualSteps: ManualStepsInfo;
}

/** Slash-command catalog filtered by source/project/search. */
export function commandsQuery(source?: string, project?: string, query?: string) {
  return queryOptions({
    queryKey: queryKeys.commands(source, project, query),
    queryFn: async ({ signal }): Promise<CommandRow[]> => {
      const params = new URLSearchParams();
      if (source) params.set("source", source);
      if (project) params.set("project", project);
      if (query) params.set("q", query);
      const qs = params.toString();
      const res = await fetch(`/api/commands${qs ? `?${qs}` : ""}`, { signal });
      if (!res.ok) throw new Error(`Failed to load commands: ${res.status}`);
      return res.json();
    },
  });
}

/** Live template manifests + per-template parse errors. */
export function templatesQuery() {
  return queryOptions({
    queryKey: queryKeys.templates(),
    queryFn: async ({ signal }): Promise<TemplatesListResult> => {
      const res = await fetch("/api/templates", { signal });
      if (!res.ok) throw new Error(`Failed to load templates: ${res.status}`);
      return res.json();
    },
  });
}

/** Cross-project manual-steps summaries (all projects with a MANUAL_STEPS.md). */
export function manualStepsQuery() {
  return queryOptions({
    queryKey: queryKeys.manualSteps(),
    queryFn: async ({ signal }): Promise<ProjectManualSteps[]> => {
      const res = await fetch("/api/manual-steps", { signal });
      if (!res.ok) throw new Error(`Failed to load manual steps: ${res.status}`);
      return res.json();
    },
  });
}

/** Config catalog for one tab (`type`), filtered by project/search. */
export function configQuery(type: string, project?: string, query?: string) {
  return queryOptions({
    queryKey: queryKeys.config(type, project, query),
    queryFn: async ({ signal }): Promise<ConfigPayload> => {
      const params = new URLSearchParams();
      params.set("type", type);
      if (project) params.set("project", project);
      if (query) params.set("q", query);
      const res = await fetch(`/api/claude-config?${params.toString()}`, { signal });
      if (!res.ok) throw new Error(`Failed to load config: ${res.status}`);
      return res.json();
    },
  });
}
