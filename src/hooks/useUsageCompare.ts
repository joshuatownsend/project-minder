"use client";

import { useState, useEffect } from "react";
import type { UsageComparison } from "@/lib/usage/types";

/**
 * Fetch the period-over-period comparison for the given period/project.
 * `enabled` gates the request so the Compare panel only fetches when the
 * user toggles it on (and never for "all", which has no prior window).
 */
export function useUsageCompare(period: string, project?: string, enabled = true) {
  const [data, setData] = useState<UsageComparison | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!enabled) {
      setData(null);
      return;
    }
    setLoading(true);
    const controller = new AbortController();
    const params = new URLSearchParams({ period });
    if (project) params.set("project", project);

    fetch(`/api/usage/compare?${params}`, { signal: controller.signal })
      .then((res) => res.json())
      .then((comparison: UsageComparison) => {
        setData(comparison);
        setLoading(false);
      })
      .catch((err) => {
        if (err.name !== "AbortError") setLoading(false);
      });

    return () => controller.abort();
  }, [period, project, enabled]);

  return { data, loading };
}
