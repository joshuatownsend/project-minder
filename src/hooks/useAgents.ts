"use client";

import { useState, useEffect, useCallback } from "react";
import type { Provenance } from "@/lib/indexer/types";

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
}

export function useAgents(source?: string, project?: string, query?: string) {
  const [data, setData] = useState<AgentRow[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    const params = new URLSearchParams();
    if (source) params.set("source", source);
    if (project) params.set("project", project);
    if (query) params.set("q", query);
    const qs = params.toString();
    try {
      const res = await fetch(`/api/agents${qs ? `?${qs}` : ""}`);
      if (res.ok) setData(await res.json());
    } finally {
      setLoading(false);
    }
  }, [source, project, query]);

  useEffect(() => {
    setLoading(true);
    refresh();
  }, [refresh]);

  return { data, loading, refresh };
}
