"use client";

import { useState, useEffect, useCallback } from "react";

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

export function useSkills(source?: string, project?: string, query?: string) {
  const [data, setData] = useState<SkillRow[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    const params = new URLSearchParams();
    if (source) params.set("source", source);
    if (project) params.set("project", project);
    if (query) params.set("q", query);
    const qs = params.toString();
    try {
      const res = await fetch(`/api/skills${qs ? `?${qs}` : ""}`);
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
