"use client";

import { useState, useEffect, useRef } from "react";
import type { EfficiencyGrade } from "@/lib/efficiencyGradeCache";
import type { GradeTrend } from "@/lib/data/gradeSnapshots";

interface GradesResponse {
  grades: Record<string, EfficiencyGrade>;
  trends?: Record<string, GradeTrend>;
  pending: number;
  total: number;
}

const POLL_INTERVAL = 5000;

export function useEfficiencyGrades() {
  const [grades, setGrades] = useState<Record<string, EfficiencyGrade>>({});
  const [trends, setTrends] = useState<Record<string, GradeTrend>>({});
  const [pending, setPending] = useState(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    let stopped = false;

    async function poll() {
      try {
        const res = await fetch("/api/efficiency-grades");
        if (stopped) return;
        if (!res.ok) return;
        const data: GradesResponse = await res.json();
        setGrades(data.grades);
        setTrends(data.trends ?? {});
        setPending(data.pending);

        if (data.pending === 0 && data.total > 0 && intervalRef.current) {
          clearInterval(intervalRef.current);
          intervalRef.current = null;
        }
      } catch {
        // Fail silently — grade chips are enhancement-only.
      }
    }

    poll();
    intervalRef.current = setInterval(poll, POLL_INTERVAL);

    return () => {
      stopped = true;
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, []);

  return { grades, trends, pending };
}
