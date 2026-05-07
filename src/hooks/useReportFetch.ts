"use client";

import { useEffect, useState } from "react";

interface ReportFetchState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
}

export function useReportFetch<T>(url: string): ReportFetchState<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setData(null);
    setError(null);

    fetch(url, { signal: controller.signal })
      .then(async (r) => {
        if (r.ok) return r.json() as Promise<T>;
        let msg: string;
        try {
          const body = await r.json() as { error?: unknown };
          msg = typeof body?.error === "string" ? body.error : `HTTP ${r.status}`;
        } catch {
          msg = `HTTP ${r.status}`;
        }
        throw new Error(msg);
      })
      .then((d: T) => {
        setData(d);
        setLoading(false);
      })
      .catch((e: unknown) => {
        if (controller.signal.aborted) return;
        setError(e instanceof Error ? e.message : String(e));
        setLoading(false);
      });

    return () => controller.abort();
  }, [url]);

  return { data, loading, error };
}
