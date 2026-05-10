"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

/**
 * Project scope is a global filter that scopes most pages to a single project
 * (or `"all"` for cross-project views). It lives in the URL as `?scope=…` so
 * deep-links and reloads stay scoped, with a localStorage fallback so navigation
 * between pages preserves scope without us having to thread it through every
 * Link.
 */

type Scope = string; // "all" | "<project-slug>"

const STORAGE_KEY = "project-minder.scope";

interface ScopeContextValue {
  scope: Scope;
  setScope: (next: Scope) => void;
}

const ScopeContext = createContext<ScopeContextValue | null>(null);

function readStored(): Scope {
  if (typeof window === "undefined") return "all";
  try {
    return window.localStorage.getItem(STORAGE_KEY) || "all";
  } catch {
    return "all";
  }
}

export function ScopeProvider({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();

  const urlScope = searchParams?.get("scope") ?? null;
  const [scope, setScopeState] = useState<Scope>(() => urlScope || readStored());

  // If the URL changes scope (deep link, browser back), trust it. This also
  // covers the URL DROPPING ?scope= entirely — e.g., browser back to an
  // unscoped view, or opening a deep link without a scope param. Earlier
  // versions only reacted when urlScope was a non-empty different value, so
  // navigating away from a scoped URL left the in-memory scope active and
  // pages kept rendering filtered data (PR #102 codex P1).
  useEffect(() => {
    const next = urlScope || "all";
    if (next === scope) return;
    setScopeState(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // ignore quota/private-browsing failures
    }
  }, [urlScope]); // eslint-disable-line react-hooks/exhaustive-deps

  const setScope = useCallback((next: Scope) => {
    setScopeState(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // ignore
    }
    // Update URL without forcing a navigation
    const params = new URLSearchParams(searchParams?.toString() ?? "");
    if (next === "all") params.delete("scope");
    else params.set("scope", next);
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }, [pathname, router, searchParams]);

  const value = useMemo<ScopeContextValue>(() => ({ scope, setScope }), [scope, setScope]);

  return <ScopeContext.Provider value={value}>{children}</ScopeContext.Provider>;
}

export function useScope(): ScopeContextValue {
  const ctx = useContext(ScopeContext);
  if (!ctx) {
    throw new Error("useScope must be used inside <ScopeProvider>");
  }
  return ctx;
}
