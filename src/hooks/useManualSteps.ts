"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { ManualStepsInfo } from "@/lib/types";
import { manualStepsQuery } from "@/lib/queryOptions";
import { useServerActionsEnabled } from "@/components/ConfigProvider";
import { toggleManualStepAction } from "@/lib/server/actions";

export function useAllManualSteps() {
  const query = useQuery(manualStepsQuery());
  // Depend on the stable `refetch` identity (not the whole query result, which
  // changes every render) so `refresh` stays referentially stable — matches the
  // pattern in useAgents/useSkills and avoids churning consumer effect-deps.
  const { refetch } = query;
  const refresh = useCallback(async () => {
    await refetch();
  }, [refetch]);
  return { data: query.data ?? [], loading: query.isPending, refresh };
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
  // Opt-in `serverActions` flag routes the write through a Server Action
  // instead of the POST route; both hit the same core mutation, so the
  // `onSuccess(updated)` shape is identical. Defaults off → fetch path.
  const useAction = useServerActionsEnabled();

  const toggle = useCallback(
    (
      lineNumber: number,
      onSuccess: (updated: ManualStepsInfo) => void
    ) => {
      // Chain this toggle behind any pending toggle for the same slug
      setToggling(true);
      queueRef.current = queueRef.current.then(async () => {
        try {
          let updated: ManualStepsInfo | null = null;
          if (useAction) {
            updated = await toggleManualStepAction(slug, lineNumber);
          } else {
            const res = await fetch(`/api/manual-steps/${slug}`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ lineNumber }),
            });
            if (res.ok) updated = (await res.json()) as ManualStepsInfo;
          }
          if (updated) onSuccess(updated);
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
    [slug, useAction]
  );

  return { toggle, toggling };
}
