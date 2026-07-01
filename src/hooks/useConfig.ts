"use client";

import { useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { configQuery } from "@/lib/queryOptions";
import type {
  CiCdInfo,
  ConfigType,
  HookEntry,
  McpServer,
  PluginEntry,
  SettingsKeyEntry,
} from "@/lib/types";

export type { ConfigType };

export interface HookRow extends HookEntry {
  projectSlug?: string;
  projectName?: string;
  /** Absolute project root for project/local-scope rows; absent for user/plugin. */
  projectPath?: string;
  /** Stable key (event|matcher|sha256(command)) for the first command. */
  unitKey: string;
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

export type SettingsKeyRow = SettingsKeyEntry;

export interface ConfigPayload {
  hooks: HookRow[];
  plugins: PluginEntry[];
  mcp: McpRow[];
  cicd: CicdRow[];
  settingsKeys: SettingsKeyRow[];
}

const empty: ConfigPayload = { hooks: [], plugins: [], mcp: [], cicd: [], settingsKeys: [] };

export function useConfig(
  type: ConfigType | undefined = "all",
  project?: string,
  query?: string
) {
  // The catalog payload is fetched via the shared `configQuery` factory so a
  // `?type=hooks` deep-link reads the RSC-prefetched cache entry instead of
  // firing a first-mount round-trip. `enabled: !!type` guards the genuinely
  // typeless case; in practice ConfigBrowser's settings/playground tabs pass
  // `undefined`, which the `= "all"` default resolves to a `type=all` fetch
  // (that fetch is what populates the nav tab-count badges).
  const q = useQuery({ ...configQuery(type ?? "all", project, query), enabled: !!type });
  // Depend on the stable `refetch` identity, not the whole query result (which
  // changes each render), so `refresh` stays referentially stable — matches
  // useAgents/useSkills and keeps ConfigBrowser's effect-deps from churning.
  const { refetch } = q;
  const refresh = useCallback(async () => {
    await refetch();
  }, [refetch]);

  return { data: q.data ?? empty, loading: type ? q.isPending : false, refresh };
}
