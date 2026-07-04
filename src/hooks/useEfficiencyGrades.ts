"use client";

import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/lib/queryKeys";
import type { EfficiencyGrade } from "@/lib/efficiencyGradeCache";
import type { GradeTrend } from "@/lib/data/gradeSnapshots";

interface GradesResponse {
  grades: Record<string, EfficiencyGrade>;
  trends?: Record<string, GradeTrend>;
  pending: number;
  total: number;
}

const POLL_INTERVAL = 5000;

const EMPTY_GRADES: Record<string, EfficiencyGrade> = {};
const EMPTY_TRENDS: Record<string, GradeTrend> = {};

/**
 * Background efficiency grades, polled while the server-side batch is still
 * grading. Migrated from a hand-rolled setInterval loop to TanStack Query (C2):
 *   - `refetchInterval` re-polls every 5s and stops once the batch has settled
 *     (`pending === 0 && total > 0`) — the same terminal condition the old loop
 *     used to clear its interval.
 *   - `refetchIntervalInBackground: false` pauses polling on a hidden tab, so a
 *     backgrounded dashboard no longer hammers the endpoint (a review win).
 * The public return shape (`{ grades, trends, pending }`) is unchanged.
 */
export function useEfficiencyGrades() {
  const query = useQuery({
    queryKey: queryKeys.efficiencyGrades(),
    queryFn: async ({ signal }): Promise<GradesResponse> => {
      const res = await fetch("/api/efficiency-grades", { signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    // Enhancement-only chips: a failed poll should stay quiet, not surface an
    // error, matching the old loop's silent catch.
    refetchInterval: (q) => {
      const data = q.state.data;
      if (data && data.pending === 0 && data.total > 0) return false;
      return POLL_INTERVAL;
    },
    refetchIntervalInBackground: false,
  });

  const data = query.data;
  return {
    grades: data?.grades ?? EMPTY_GRADES,
    trends: data?.trends ?? EMPTY_TRENDS,
    pending: data?.pending ?? 0,
  };
}
