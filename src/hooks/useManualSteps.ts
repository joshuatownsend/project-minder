"use client";

import { useState, useEffect, useCallback } from "react";
import { ManualStepsInfo } from "@/lib/types";

interface ProjectManualSteps {
  slug: string;
  name: string;
  path: string;
  manualSteps: ManualStepsInfo;
}

export function useAllManualSteps() {
  const [data, setData] = useState<ProjectManualSteps[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/manual-steps");
      if (res.ok) setData(await res.json());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { data, loading, refresh };
}

export function useProjectManualSteps(slug: string) {
  const [data, setData] = useState<ManualStepsInfo | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`/api/manual-steps/${slug}`);
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

export function useToggleStep(slug: string) {
  const toggle = useCallback(
    async (
      lineNumber: number,
      onSuccess: (updated: ManualStepsInfo) => void
    ) => {
      const res = await fetch(`/api/manual-steps/${slug}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lineNumber }),
      });
      if (res.ok) {
        const updated: ManualStepsInfo = await res.json();
        onSuccess(updated);
      }
    },
    [slug]
  );

  return { toggle };
}
