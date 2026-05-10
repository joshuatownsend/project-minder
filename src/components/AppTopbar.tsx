"use client";

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

function deriveTitle(pathname: string, type: string | null): string {
  // Direct match
  if (TITLE_MAP[pathname]) return TITLE_MAP[pathname];
  // Config sub-tabs: /config?type=mcp → "MCP"
  if (pathname === "/config") {
    if (type === "mcp") return "MCP";
    return "Config";
  }
  // /project/[slug] etc — fall back to last segment, prettified
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length === 0) return "Home";
  const last = segments[segments.length - 1];
  // If it's a [slug]-style trailing segment, use the first segment instead
  if (last.length > 24 || last.includes("-")) {
    const root = "/" + segments[0];
    if (TITLE_MAP[root]) return TITLE_MAP[root];
  }
  return last.charAt(0).toUpperCase() + last.slice(1);
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

  const title = deriveTitle(pathname, type);
  const totalAlerts = snapshot.approvalCount + snapshot.pendingSteps;

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
