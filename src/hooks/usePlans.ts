"use client";

import { useEffect, useState, useCallback } from "react";
import type { PlanEntry } from "@/lib/types";

export function usePlans(opts: { q?: string; tag?: string } = {}) {
  const [data, setData] = useState<PlanEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetch_ = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (opts.q) params.set("q", opts.q);
      if (opts.tag) params.set("tag", opts.tag);
      const qs = params.toString();
      const res = await fetch(`/api/plans${qs ? `?${qs}` : ""}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData(await res.json());
    } catch (err) {
      setError(err instanceof Error ? err.message : "fetch error");
    } finally {
      setLoading(false);
    }
  }, [opts.q, opts.tag]);

  useEffect(() => {
    fetch_();
  }, [fetch_]);

  return { data, loading, error };
}

export async function fetchPlanBody(slug: string): Promise<string | null> {
  try {
    const res = await fetch(`/api/plans/${encodeURIComponent(slug)}`);
    if (!res.ok) return null;
    const data = await res.json() as { body?: string };
    return data.body ?? null;
  } catch {
    return null;
  }
}
