"use client";

import { useState, useEffect } from "react";
import { UsageReport } from "@/lib/usage/types";

export function useUsage(period: string, project?: string) {
  const [data, setData] = useState<UsageReport | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    const controller = new AbortController();
    const params = new URLSearchParams({ period });
    if (project) params.set("project", project);

    fetch(`/api/usage?${params}`, { signal: controller.signal })
      .then((res) => res.json())
      .then((report) => {
        setData(report);
        setLoading(false);
      })
      .catch((err) => {
        if (err.name !== "AbortError") setLoading(false);
      });

    return () => controller.abort();
  }, [period, project]);

  return { data, loading };
}
