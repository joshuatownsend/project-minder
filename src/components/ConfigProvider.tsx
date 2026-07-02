"use client";

import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  type ReactNode,
} from "react";
import type { MinderConfig } from "@/lib/types";
import { effectiveShortcuts, type ShortcutActionId } from "@/lib/keyboardShortcuts";
import { getFlag } from "@/lib/featureFlags";

const ConfigContext = createContext<MinderConfig | null>(null);
const ConfigRefreshContext = createContext<() => void>(() => {});

export function ConfigProvider({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState<MinderConfig | null>(null);

  // Exposed via `useConfigRefresh` so a mutation elsewhere in the SPA (e.g. the
  // Settings page toggling a feature flag) can re-pull this snapshot. Without
  // it, the provider fetched once on mount and every flag read through it
  // (`useServerActionsEnabled`, `useEffectiveShortcuts`, …) stayed stale until a
  // hard reload.
  const refresh = useCallback(() => {
    fetch("/api/config")
      .then((r) => r.json())
      .then((d: MinderConfig) => setConfig(d))
      .catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return (
    <ConfigContext.Provider value={config}>
      <ConfigRefreshContext.Provider value={refresh}>
        {children}
      </ConfigRefreshContext.Provider>
    </ConfigContext.Provider>
  );
}

export function useConfig(): MinderConfig | null {
  return useContext(ConfigContext);
}

/** Re-pull the global config snapshot. Call after mutating config elsewhere in
 *  the SPA so provider-backed reads (flags, shortcuts) don't go stale. */
export function useConfigRefresh(): () => void {
  return useContext(ConfigRefreshContext);
}

export function useEffectiveShortcuts(): Record<ShortcutActionId, string> {
  const config = useConfig();
  return effectiveShortcuts(config?.keyboardShortcuts);
}

/**
 * True when the opt-in `serverActions` flag routes the two live mutations
 * (toggle a manual step, change a project's status) through Server Actions
 * instead of the POST/PUT API routes (Performance P3 — PR 4). Defaults off, so
 * the API-route path is the fallback. Centralizes the flag read that all three
 * mutation call sites share.
 */
export function useServerActionsEnabled(): boolean {
  const config = useConfig();
  return getFlag(config?.featureFlags, "serverActions", false);
}

/**
 * True when the opt-in `liveEvents` flag is on — the client should open the
 * `/api/events` SSE stream and invalidate queries on push instead of polling
 * (Performance P3 — PR 5a). Defaults off.
 */
export function useLiveEventsEnabled(): boolean {
  const config = useConfig();
  return getFlag(config?.featureFlags, "liveEvents", false);
}
