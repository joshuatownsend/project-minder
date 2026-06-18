"use client";

import { useEffect, useState } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { Bell, Filter, Search, Menu } from "lucide-react";
import { useCommandPalette } from "./CommandPaletteProvider";
import { usePulse } from "./PulseProvider";
import { useScope } from "./ScopeProvider";
import { PortConflictIndicator } from "./PortConflictIndicator";
import { HelpButton } from "./HelpButton";

const TITLE_MAP: Record<string, string> = {
  "/":              "Home",
  "/projects":      "Projects",
  "/status":        "Status",
  "/tasks":         "Tasks",
  "/kanban":        "Kanban",
  "/plans":         "Plans",
  "/manual-steps":  "Manual steps",
  "/schedule":      "Schedule",
  "/insights":      "Insights",
  "/sessions":      "Sessions",
  "/memory":        "Memory",
  "/timeline":      "Timeline",
  "/agents":        "Agents",
  "/skills":        "Skills",
  "/instructions":  "Instructions",
  "/commands":      "Commands",
  "/plugins":       "Plugins",
  "/templates":     "Templates",
  "/swarms":        "Swarms",
  "/library":       "Library",
  "/analytics":     "Analytics",
  "/stats":         "Stats",
  "/usage":         "Usage & cost",
  "/health":        "Health",
  "/hooks":         "Hooks",
  "/sql":           "SQL",
  "/insights-report": "Insights report",
  "/setup":         "Setup",
  "/settings":      "Settings",
  "/new-project":   "New project",
};

// Singular labels used for the parent crumb on dynamic-detail routes. Eg.
// /project/<slug> reads "Project / <slug>" not "Projects / <slug>".
const DETAIL_PARENT: Record<string, string> = {
  "/project": "Project",
  "/sessions": "Sessions",
  "/templates": "Template",
};

function deriveCrumbs(pathname: string, type: string | null): { title: string; sub?: string } {
  // Direct match
  if (TITLE_MAP[pathname]) return { title: TITLE_MAP[pathname] };
  // Config sub-tabs: /config?type=mcp → "MCP"
  if (pathname === "/config") {
    if (type === "mcp") return { title: "MCP" };
    return { title: "Config" };
  }
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length === 0) return { title: "Home" };
  const root = "/" + segments[0];
  // Dynamic detail page: "/project/<slug>" → title "Project", sub "<slug>".
  // Earlier versions title-cased the slug into "Project-minder" which mangled
  // hyphenated names (was MEDIUM-1 in the 2026-05-10 review).
  if (segments.length > 1 && DETAIL_PARENT[root]) {
    return { title: DETAIL_PARENT[root], sub: segments.slice(1).join("/") };
  }
  if (TITLE_MAP[root]) return { title: TITLE_MAP[root] };
  // Unknown route — fall back to the raw last segment (no title-casing) so
  // the breadcrumb doesn't lie about the URL the user is on.
  return { title: segments[segments.length - 1] };
}

interface TopbarProps {
  onOpenSidebar?: () => void;
  onOpenScopePicker?: () => void;
  /** When true, show a hamburger button on the left (mobile-only chrome). */
  showSidebarToggle?: boolean;
  /** Optional dev-root label shown as a mono chip. */
  devRootLabel?: string;
}

export function AppTopbar({ onOpenSidebar, onOpenScopePicker, showSidebarToggle, devRootLabel }: TopbarProps) {
  const router = useRouter();
  const pathname = usePathname() ?? "/";
  const searchParams = useSearchParams();
  const type = searchParams?.get("type") ?? null;
  const { open: openPalette } = useCommandPalette();
  const { snapshot } = usePulse();
  const { scope } = useScope();

  // Defer pulse-derived UI (bell badge + tooltip) until after the first client
  // paint. The pulse snapshot starts at zeros on both server and client, but
  // PulseProvider's poll() can resolve before hydration completes in dev mode
  // and trigger a re-render with real counts (e.g. 242 pending steps) — React
  // then reports a hydration mismatch against the SSR HTML. Matches the
  // pattern already used in AppSidebar for the sidebar badges.
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);

  const { title, sub: pathSub } = deriveCrumbs(pathname, type);
  const totalAlerts = hydrated ? snapshot.approvalCount + snapshot.pendingSteps : 0;

  return (
    <header className="shell-topbar">
      {showSidebarToggle && (
        <button
          type="button"
          className="icon-btn"
          aria-label="Toggle sidebar"
          onClick={onOpenSidebar}
          style={{ marginRight: 4 }}
        >
          <Menu width={16} height={16} />
        </button>
      )}

      <div className="topbar-crumbs">
        <span className="here">{title}</span>
        {pathSub && (
          <>
            <span className="sep">/</span>
            <span style={{ color: "var(--text-2)" }}>{pathSub}</span>
          </>
        )}
        {scope !== "all" && (
          <>
            <span className="sep">/</span>
            <span style={{ color: "var(--text-2)" }}>{scope}</span>
          </>
        )}
      </div>

      <button
        type="button"
        className="topbar-search"
        onClick={openPalette}
        aria-label="Open command palette"
      >
        <Search width={14} height={14} />
        <span className="placeholder">Search projects, sessions, skills…</span>
        <span className="kbd">⌘K</span>
      </button>

      <PortConflictIndicator />

      {devRootLabel && (
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            color: "var(--text-3)",
            letterSpacing: "0.02em",
            whiteSpace: "nowrap",
            maxWidth: 220,
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
          title={devRootLabel}
        >
          {devRootLabel}
        </span>
      )}

      <button
        type="button"
        className="icon-btn"
        aria-label="Notifications"
        title={totalAlerts > 0 ? `${totalAlerts} pending — open Status` : "No new notifications — open Status"}
        onClick={() => router.push("/status")}
      >
        <Bell width={16} height={16} />
        {totalAlerts > 0 && (
          <span className="badge-dot">{totalAlerts > 9 ? "9+" : totalAlerts}</span>
        )}
      </button>

      <button
        type="button"
        className="icon-btn"
        onClick={onOpenScopePicker}
        aria-label="Switch project"
        title="Switch project"
      >
        <Filter width={16} height={16} />
      </button>

      <HelpButton />
    </header>
  );
}
