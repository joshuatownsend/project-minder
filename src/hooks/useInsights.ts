"use client";

import { useState, useEffect, useCallback } from "react";
import { InsightEntry, InsightsInfo } from "@/lib/types";

interface AllInsightsResult {
  insights: InsightEntry[];
  total: number;
}

export function useAllInsights(projectFilter?: string, query?: string) {
  const [data, setData] = useState<AllInsightsResult>({ insights: [], total: 0 });
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    const params = new URLSearchParams();
    if (projectFilter) params.set("project", projectFilter);
    if (query) params.set("q", query);
    const qs = params.toString();
    try {
      const res = await fetch(`/api/insights${qs ? `?${qs}` : ""}`);
      if (res.ok) setData(await res.json());
    } finally {
      setLoading(false);
    }
  }, [projectFilter, query]);

  useEffect(() => {
    setLoading(true);
    refresh();
  }, [refresh]);

  return { data, loading, refresh };
}

export function useProjectInsights(slug: string) {
  const [data, setData] = useState<InsightsInfo | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`/api/insights/${slug}`);
      if (res.ok) setData(await res.json());
    } finally {
      setLoading(false);
    }
  }, [slug]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { data, loading, refresh };
}
