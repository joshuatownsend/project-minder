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
