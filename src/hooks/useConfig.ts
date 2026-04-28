"use client";

import { useCallback, useEffect, useState } from "react";
import type {
  CiCdInfo,
  ConfigType,
  HookEntry,
  McpServer,
  PluginEntry,
} from "@/lib/types";

export type { ConfigType };

export interface HookRow extends HookEntry {
  projectSlug?: string;
  projectName?: string;
}

export interface McpRow extends McpServer {
  projectSlug?: string;
  projectName?: string;
}

export interface CicdRow {
  projectSlug: string;
  projectName: string;
  cicd: CiCdInfo;
}

export interface ConfigPayload {
  hooks: HookRow[];
  plugins: PluginEntry[];
  mcp: McpRow[];
  cicd: CicdRow[];
}

const empty: ConfigPayload = { hooks: [], plugins: [], mcp: [], cicd: [] };

export function useConfig(
  type: ConfigType | undefined = "all",
  project?: string,
  query?: string
) {
  const [data, setData] = useState<ConfigPayload>(empty);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    if (!type) {
      setLoading(false);
      return;
    }
    const params = new URLSearchParams();
    params.set("type", type);
    if (project) params.set("project", project);
    if (query) params.set("q", query);
    try {
      const res = await fetch(`/api/claude-config?${params.toString()}`);
      if (res.ok) setData(await res.json());
    } finally {
      setLoading(false);
    }
  }, [type, project, query]);

  useEffect(() => {
    setLoading(true);
    refresh();
  }, [refresh]);

  return { data, loading, refresh };
}
