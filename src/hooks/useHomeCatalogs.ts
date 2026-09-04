"use client";

import { useQueries } from "@tanstack/react-query";
import { queryKeys } from "@/lib/queryKeys";
import type { AgentEntry, SkillEntry } from "@/lib/indexer/types";
import type { EnvAgent, EnvSkill } from "@/lib/environments/diff";

/**
 * The catalog halves of a set of Claude homes, one `/api/agents?home=` and
 * one `/api/skills?home=` query per home key (#553). Feeds the Environments
 * tab, which joins them onto `/api/environments` to build the per-home
 * inventory it diffs.
 *
 * Project-scope entries are dropped: they are repo-borne (`.claude/` in a
 * checkout), identical in every location, and covered by the repo-borne
 * tabs' own divergence flags. What is compared here is what each MACHINE
 * loads — user-scope and plugin-provided entries.
 *
 * A home the server refuses (404 unknown, 503 unavailable) or fails on is
 * reported as an error for that key rather than as an empty inventory, so
 * the tab can exclude the column and say why instead of showing every entry
 * as "differs".
 */
export interface HomeCatalog {
  agents: EnvAgent[];
  skills: EnvSkill[];
}

export interface HomeCatalogState {
  loading: boolean;
  /** HTTP status or message when the home's catalog could not be read. */
  error?: string;
  catalog?: HomeCatalog;
}

interface CatalogRow<E> {
  entry?: E;
  catalogMissing?: boolean;
}

async function fetchRows<E>(kind: "agents" | "skills", home: string, signal: AbortSignal): Promise<E[]> {
  const res = await fetch(`/api/${kind}?home=${encodeURIComponent(home)}`, { signal });
  if (!res.ok) {
    let detail = `${res.status}`;
    try {
      const body = (await res.json()) as { error?: string; reason?: string };
      if (body.reason) detail = body.reason;
      else if (body.error) detail = body.error;
    } catch {
      // non-JSON error body — the status is the message
    }
    throw new Error(detail);
  }
  const body = (await res.json()) as unknown;
  // Bare array, never `{ data }` — the catalog routes unwrap their response.
  if (!Array.isArray(body)) return [];
  const rows = body as CatalogRow<E>[];
  return rows.map((r) => r.entry).filter((e): e is E => e !== undefined);
}

/** `name@marketplace` from marketplace provenance; undefined for anything else. */
function pluginIdOf(e: AgentEntry | SkillEntry): string | undefined {
  const p = e.provenance;
  return p.kind === "marketplace-plugin" ? `${p.pluginName}@${p.marketplace}` : undefined;
}

function toEnvAgent(e: AgentEntry): EnvAgent {
  return {
    // The relative path, not the file stem: nested `review/worker.md` and
    // `build/worker.md` are two agents and must be two rows (Codex on #555).
    slug: e.relPath ?? e.slug,
    name: e.name !== e.slug ? e.name : undefined,
    description: e.description,
    source: e.source === "plugin" ? "plugin" : "user",
    pluginName: e.pluginName,
    pluginId: pluginIdOf(e),
  };
}

function toEnvSkill(e: SkillEntry): EnvSkill {
  return {
    slug: e.slug,
    name: e.name !== e.slug ? e.name : undefined,
    description: e.description,
    source: e.source === "plugin" ? "plugin" : "user",
    pluginName: e.pluginName,
    pluginId: pluginIdOf(e),
    disabled: e.disabled === true,
  };
}

export function useHomeCatalogs(homeKeys: readonly string[]): Map<string, HomeCatalogState> {
  const results = useQueries({
    queries: homeKeys.flatMap((home) => [
      {
        queryKey: queryKeys.agents(undefined, undefined, undefined, home),
        queryFn: ({ signal }: { signal: AbortSignal }) => fetchRows<AgentEntry>("agents", home, signal),
        retry: false,
      },
      {
        queryKey: queryKeys.skills(undefined, undefined, undefined, home),
        queryFn: ({ signal }: { signal: AbortSignal }) => fetchRows<SkillEntry>("skills", home, signal),
        retry: false,
      },
    ]),
  });

  const out = new Map<string, HomeCatalogState>();
  homeKeys.forEach((home, i) => {
    const agents = results[i * 2];
    const skills = results[i * 2 + 1];
    if (agents.isError || skills.isError) {
      const err = (agents.error ?? skills.error) as Error | null;
      out.set(home, { loading: false, error: err?.message ?? "catalog unavailable" });
      return;
    }
    if (agents.isPending || skills.isPending) {
      out.set(home, { loading: true });
      return;
    }
    // `useQueries` types every result as the union of both query shapes; the
    // even slots are agents and the odd ones skills by construction above.
    const agentRows = agents.data as AgentEntry[];
    const skillRows = skills.data as SkillEntry[];
    out.set(home, {
      loading: false,
      catalog: {
        agents: agentRows.filter((e) => e.source !== "project").map(toEnvAgent),
        skills: skillRows.filter((e) => e.source !== "project").map(toEnvSkill),
      },
    });
  });
  return out;
}
