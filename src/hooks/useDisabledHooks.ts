"use client";

import { useCallback, useEffect, useState } from "react";
import type { DisabledHookEntry } from "@/lib/hookToggle";

interface State {
  data: DisabledHookEntry[];
  loading: boolean;
  error: string | null;
}

export function useDisabledHooks(): State & { refresh: () => Promise<void> } {
  const [state, setState] = useState<State>({ data: [], loading: true, error: null });

  const refresh = useCallback(async () => {
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const res = await fetch("/api/hooks/toggle");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const payload = (await res.json()) as { entries: DisabledHookEntry[] };
      setState({ data: payload.entries ?? [], loading: false, error: null });
    } catch (err) {
      setState({ data: [], loading: false, error: err instanceof Error ? err.message : "fetch error" });
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { ...state, refresh };
}
