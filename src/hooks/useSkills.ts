"use client";

import { useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { skillsQuery, type SkillRow } from "@/lib/queryOptions";

export type { SkillRow };

export function useSkills(source?: string, project?: string, query?: string) {
  const result = useQuery(skillsQuery(source, project, query));

  const { refetch } = result;
  const refresh = useCallback(async () => {
    await refetch();
  }, [refetch]);

  return { data: result.data ?? [], loading: result.isPending, refresh };
}
