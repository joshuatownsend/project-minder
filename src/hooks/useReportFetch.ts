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
    setLoading(true);
    setData(null);
    setError(null);
    fetch(url)
      .then((r) =>
        r.ok ? r.json() : r.json().then((e: { error: string }) => Promise.reject(e.error))
      )
      .then((d: T) => {
        setData(d);
        setLoading(false);
      })
      .catch((e: unknown) => {
        setError(String(e));
        setLoading(false);
      });
  }, [url]);

  return { data, loading, error };
}
