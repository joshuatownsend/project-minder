"use client";

import { useState, useEffect, useCallback, useRef } from "react";
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

/**
 * Serialized toggle hook: queues requests so only one is in-flight at a time.
 * Returns `toggling` state so the UI can show a subtle indicator if needed.
 */
export function useToggleStep(slug: string) {
  const queueRef = useRef<Promise<void>>(Promise.resolve());
  const [toggling, setToggling] = useState(false);

  const toggle = useCallback(
    (
      lineNumber: number,
      onSuccess: (updated: ManualStepsInfo) => void
    ) => {
      // Chain this toggle behind any pending toggle for the same slug
      setToggling(true);
      queueRef.current = queueRef.current.then(async () => {
        try {
          const res = await fetch(`/api/manual-steps/${slug}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ lineNumber }),
          });
          if (res.ok) {
            const updated: ManualStepsInfo = await res.json();
            onSuccess(updated);
          }
        } catch {
          // Network error — server-side mutex protects the file,
          // so worst case the toggle didn't happen. UI will resync on next fetch.
        } finally {
          // Check if the queue is drained (this was the last item)
          // We do this by chaining a microtask to see if nothing else was added
          queueMicrotask(() => {
            // If nothing else chained after us, toggling is done
            queueRef.current.then(() => setToggling(false));
          });
        }
      });
    },
    [slug]
  );

  return { toggle, toggling };
}
