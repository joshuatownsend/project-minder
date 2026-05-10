"use client";

/**
 * AppShell — client wrapper that owns sidebar/topbar state.
 *
 * Splits the chrome from layout.tsx so the server component can stay async
 * (reading config) while the chrome owns interactive state (sidebar
 * collapsed, scope picker open). The server passes static labels and the
 * children tree; everything below the topbar renders inside the scrollable
 * `.shell-main` container.
 */

import { useEffect, useState, type ReactNode } from "react";
import { AppSidebar } from "./AppSidebar";
import { AppTopbar } from "./AppTopbar";
import { ProjectScopeMenu } from "./ProjectScopeMenu";
import { useScope } from "./ScopeProvider";
import type { ProjectData } from "@/lib/types";

interface AppShellProps {
  children: ReactNode;
  devRootLabel?: string;
}

const SIDEBAR_KEY = "project-minder.sidebar.collapsed";

export function AppShell({ children, devRootLabel }: AppShellProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [scopeOpen, setScopeOpen] = useState(false);
  const [projects, setProjects] = useState<ProjectData[]>([]);
  const { setScope } = useScope();

  // Restore collapsed preference; default = expanded.
  useEffect(() => {
    try {
      setCollapsed(window.localStorage.getItem(SIDEBAR_KEY) === "1");
    } catch {
      // ignore
    }
  }, []);

  // Lazy-fetch projects the first time the scope picker opens. Cached for
  // session lifetime; reload by reopening the picker after a rescan.
  useEffect(() => {
    if (!scopeOpen || projects.length > 0) return;
    let cancelled = false;
    fetch("/api/projects")
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        setProjects(Array.isArray(d?.projects) ? d.projects : []);
      })
      .catch(() => {
        // Silently ignore — scope picker still works with the "All projects" entry.
      });
    return () => { cancelled = true; };
  }, [scopeOpen, projects.length]);

  // Global keyboard shortcut: Ctrl+B (or Cmd+B) toggles the sidebar.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const meta = e.metaKey || e.ctrlKey;
      if (!meta || e.key.toLowerCase() !== "b") return;
      // Don't interfere with form input bold-toggles
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      e.preventDefault();
      setCollapsed((prev) => {
        const next = !prev;
        try { window.localStorage.setItem(SIDEBAR_KEY, next ? "1" : "0"); } catch { /* ignore */ }
        return next;
      });
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  // Listen for the legacy "set-scope" custom event so other components can
  // request a scope change without importing ScopeProvider directly. This
  // is mostly a hook for the scope-pulldown that may exist on project pages.
  useEffect(() => {
    function onScope(e: Event) {
      const ce = e as CustomEvent<{ scope: string }>;
      if (typeof ce.detail?.scope === "string") setScope(ce.detail.scope);
    }
    document.addEventListener("project-minder:set-scope", onScope as EventListener);
    return () => document.removeEventListener("project-minder:set-scope", onScope as EventListener);
  }, [setScope]);

  return (
    <div className="app-shell" data-sidebar={collapsed ? "collapsed" : "expanded"}>
      <AppSidebar collapsed={collapsed} onOpenScopePicker={() => setScopeOpen(true)} />
      <div className="shell-main">
        <AppTopbar
          onOpenScopePicker={() => setScopeOpen(true)}
          devRootLabel={devRootLabel}
        />
        {children}
      </div>
      <ProjectScopeMenu open={scopeOpen} onClose={() => setScopeOpen(false)} projects={projects} />
    </div>
  );
}
