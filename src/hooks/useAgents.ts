"use client";

import { useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { agentsQuery, type AgentRow } from "@/lib/queryOptions";

export type { AgentRow };

export function useAgents(source?: string, project?: string, query?: string) {
  const result = useQuery(agentsQuery(source, project, query));

  const { refetch } = result;
  const refresh = useCallback(async () => {
    await refetch();
  }, [refetch]);

  return { data: result.data ?? [], loading: result.isPending, refresh };
}
