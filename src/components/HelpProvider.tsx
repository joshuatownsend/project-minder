"use client";

import {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  type ReactNode,
} from "react";
import { usePathname } from "next/navigation";
import { type HelpSlug, helpMapping } from "@/lib/help-mapping";

interface HelpContextValue {
  /** Currently open slug, or null if closed */
  activeSlug: HelpSlug | null;
  /** Open the help panel to a specific doc */
  openHelp: (slug: HelpSlug) => void;
  /** Open help for the current route (falls back to getting-started) */
  openHelpForRoute: (pathname: string) => void;
  /** Close the panel */
  closeHelp: () => void;
}

const HelpContext = createContext<HelpContextValue | null>(null);

export function HelpProvider({ children }: { children: ReactNode }) {
  const [activeSlug, setActiveSlug] = useState<HelpSlug | null>(null);
  const pathname = usePathname();

  const openHelp = useCallback((slug: HelpSlug) => {
    setActiveSlug(slug);
  }, []);

  const openHelpForRoute = useCallback((pathname: string) => {
    // Try exact match first, then check if it's a project detail page
    let slug = helpMapping[pathname];
    if (!slug && pathname.startsWith("/project/")) {
      slug = helpMapping["/project/[slug]"];
    }
    setActiveSlug((slug ?? "getting-started") as HelpSlug);
  }, []);

  const closeHelp = useCallback(() => {
    setActiveSlug(null);
  }, []);

  // Global "?" keyboard shortcut to toggle help
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "?" && !e.ctrlKey && !e.metaKey) {
        const active = document.activeElement;
        const tag = active?.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
        e.preventDefault();
        if (activeSlug) {
          closeHelp();
        } else {
          openHelpForRoute(pathname);
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [activeSlug, pathname, openHelpForRoute, closeHelp]);

  return (
    <HelpContext.Provider
      value={{ activeSlug, openHelp, openHelpForRoute, closeHelp }}
    >
      {children}
    </HelpContext.Provider>
  );
}

export function useHelp() {
  const ctx = useContext(HelpContext);
  if (!ctx) throw new Error("useHelp must be used within HelpProvider");
  return ctx;
}
