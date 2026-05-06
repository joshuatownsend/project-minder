"use client";

import { useEffect, useState, useCallback } from "react";
import type { HookRow } from "@/hooks/useConfig";

export function useHooks(query?: string) {
  const [data, setData] = useState<HookRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetch_ = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ type: "hooks" });
      if (query) params.set("q", query);
      const res = await fetch(`/api/claude-config?${params}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const payload = await res.json() as { hooks: HookRow[] };
      setData(payload.hooks ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "fetch error");
    } finally {
      setLoading(false);
    }
  }, [query]);

  useEffect(() => {
    fetch_();
  }, [fetch_]);

  return { data, loading, error };
}
