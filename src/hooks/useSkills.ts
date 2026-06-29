"use client";

import { useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Provenance } from "@/lib/indexer/types";
import { queryKeys } from "@/lib/queryKeys";

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

export function useSkills(source?: string, project?: string, query?: string) {
  const result = useQuery({
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

  const { refetch } = result;
  const refresh = useCallback(async () => {
    await refetch();
  }, [refetch]);

  return { data: result.data ?? [], loading: result.isPending, refresh };
}
