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
 * True when the `serverActions` flag routes the two live mutations
 * (toggle a manual step, change a project's status) through Server Actions
 * instead of the POST/PUT API routes (Performance P3 — PR 4). Defaults ON;
 * toggling the flag OFF in Settings falls back to the API-route path, which
 * remains intact. Centralizes the flag read that all three mutation call sites
 * share.
 */
export function useServerActionsEnabled(): boolean {
  const config = useConfig();
  return getFlag(config?.featureFlags, "serverActions");
}

/**
 * True when the `liveEvents` flag is on — the client opens the
 * `/api/events` SSE stream and invalidates queries on push instead of polling
 * (Performance P3 — PR 5a). Defaults ON; toggling OFF falls back to timer-based
 * polling.
 */
export function useLiveEventsEnabled(): boolean {
  const config = useConfig();
  return getFlag(config?.featureFlags, "liveEvents");
}

/**
 * True when the `burnHud` flag is on — the top bar shows the persistent quota
 * burn indicator (`QuotaHud`). Defaults ON; the HUD additionally self-hides
 * whenever Claude quota data isn't configured, so this only governs the
 * explicit user opt-out.
 */
export function useBurnHudEnabled(): boolean {
  const config = useConfig();
  return getFlag(config?.featureFlags, "burnHud");
}

/**
 * True when the `workflowLauncher` flag is on — the one-click launcher chips
 * appear (per-project strip on the project page + a global row under the top
 * bar). Defaults ON; toggling OFF in Settings hides both placements. Gates the
 * client render only; the underlying POST /api/tasks path is always available.
 */
export function useWorkflowLauncherEnabled(): boolean {
  const config = useConfig();
  // This gates a *mutating* surface (the chips POST to /api/tasks), so unknown
  // config counts as disabled: stay off during the initial `null` state and if
  // /api/config fails, otherwise a user who turned the launcher off would still
  // see a flash of active chips before the config resolves. Once config loads,
  // the flag's own default-on applies.
  if (config === null) return false;
  return getFlag(config.featureFlags, "workflowLauncher");
}
