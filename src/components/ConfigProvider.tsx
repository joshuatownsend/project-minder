"use client";

import {
  createContext,
  useContext,
  useState,
  useEffect,
  type ReactNode,
} from "react";
import type { MinderConfig } from "@/lib/types";
import { effectiveShortcuts, type ShortcutActionId } from "@/lib/keyboardShortcuts";
import { getFlag } from "@/lib/featureFlags";

const ConfigContext = createContext<MinderConfig | null>(null);

export function ConfigProvider({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState<MinderConfig | null>(null);

  useEffect(() => {
    fetch("/api/config")
      .then((r) => r.json())
      .then((d: MinderConfig) => setConfig(d))
      .catch(() => {});
  }, []);

  return <ConfigContext.Provider value={config}>{children}</ConfigContext.Provider>;
}

export function useConfig(): MinderConfig | null {
  return useContext(ConfigContext);
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
