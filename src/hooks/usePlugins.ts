"use client";

import { useEffect, useState, useCallback } from "react";
import type { PluginRollupRow } from "@/lib/data/pluginRollup";
export type { PluginRollupRow };

export function usePlugins(q?: string) {
  const [data, setData] = useState<PluginRollupRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetch_ = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (q) params.set("q", q);
      const qs = params.toString();
      const res = await fetch(`/api/plugins${qs ? `?${qs}` : ""}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData(await res.json());
    } catch (err) {
      setError(err instanceof Error ? err.message : "fetch error");
    } finally {
      setLoading(false);
    }
  }, [q]);

  useEffect(() => {
    fetch_();
  }, [fetch_]);

  return { data, loading, error };
}
