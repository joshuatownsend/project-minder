"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { ChevronDown, Settings as SettingsIcon, Search } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { usePulse } from "./PulseProvider";
import { useCommandPalette } from "./CommandPaletteProvider";

type BadgeKey = "steps" | "approval";

interface NavItem {
  href: string;
  /** Pathname slice of href (precomputed so isActive doesn't allocate per render). */
  path: string;
  label: string;
  badge?: BadgeKey;
  /** When set, this child matches only if pathname AND ?type= param agree
   *  (used for /config deep-links to specific config sub-tabs). */
  matchType?: string;
}

interface Group {
  label: string;
  children: NavItem[];
}

function item(href: string, label: string, extras: { badge?: BadgeKey; matchType?: string } = {}): NavItem {
  return { href, path: href.split("?")[0], label, ...extras };
}

const ROOT_ITEMS: NavItem[] = [item("/", "Projects"), item("/new-project", "+ New")];

const GROUPS: Group[] = [
  {
    label: "Catalog",
    children: [
      item("/agents",    "Agents"),
      item("/skills",    "Skills"),
      item("/commands",  "Commands"),
      item("/plugins",   "Plugins"),
      item("/templates", "Templates"),
      item("/library",   "Library"),
    ],
  },
  {
    label: "Sessions",
    children: [
      item("/sessions",        "Sessions"),
      item("/plans",           "Plans"),
      item("/stats",           "Stats"),
      item("/usage",           "Usage"),
      item("/sql",             "SQL"),
      item("/insights-report", "Insights Report"),
    ],
  },
  {
    label: "Mission Control",
    children: [
      item("/kanban",   "Kanban"),
      item("/tasks",    "Tasks"),
      item("/swarms",   "Swarms"),
      item("/schedule", "Schedule"),
    ],
  },
  {
    label: "Config",
    children: [
      item("/hooks", "Hooks"),
      item("/config?type=mcp",   "MCP",   { matchType: "mcp" }),
      item("/settings",          "Settings"),
      item("/setup",             "Setup"),
      item("/status",            "Status",   { badge: "approval" }),
      item("/insights",          "Insights"),
      item("/manual-steps",      "Steps",    { badge: "steps" }),
    ],
  },
];

function isItemActive(navItem: NavItem, pathname: string, currentType: string | null): boolean {
  if (navItem.matchType !== undefined) {
    return pathname === navItem.path && currentType === navItem.matchType;
  }
  return pathname === navItem.path || pathname.startsWith(navItem.path + "/");
}

export function AppNav() {
  const pathname = usePathname() ?? "/";
  const searchParams = useSearchParams();
  const currentType = searchParams?.get("type") ?? null;
  const { snapshot } = usePulse();
  const { open: openPalette } = useCommandPalette();
  const badgeCounts: Record<BadgeKey, number> = {
    steps: snapshot.pendingSteps,
    approval: snapshot.approvalCount,
  };

  return (
    <nav style={{ display: "flex", alignItems: "center", gap: "2px", flexWrap: "wrap" }}>
      {ROOT_ITEMS.map((rootItem) => {
        const isActive = isItemActive(rootItem, pathname, currentType);
        const badgeCount = rootItem.badge ? badgeCounts[rootItem.badge] : 0;
        return (
          <Link
            key={rootItem.href}
            href={rootItem.href}
            style={navLinkStyle(isActive)}
          >
            {rootItem.label}
            {badgeCount > 0 && <Badge count={badgeCount} />}
          </Link>
        );
      })}

      {GROUPS.map((group) => {
        const activeChild = group.children.find((c) => isItemActive(c, pathname, currentType));
        const groupActive = !!activeChild;
        const groupBadgeTotal = group.children.reduce((sum, c) => {
          return sum + (c.badge ? badgeCounts[c.badge] : 0);
        }, 0);

        return (
          <DropdownMenu key={group.label}>
            <DropdownMenuTrigger asChild>
              <button style={triggerStyle(groupActive)}>
                {group.label}
                {groupBadgeTotal > 0 && (
                  <span
                    aria-hidden="true"
                    title={`${groupBadgeTotal} pending in ${group.label}`}
                    style={{
                      width: "5px",
                      height: "5px",
                      borderRadius: "50%",
                      background: "var(--accent)",
                      marginLeft: "2px",
                    }}
                  />
                )}
                <ChevronDown style={{ width: "10px", height: "10px", opacity: 0.7 }} />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              {group.children.map((child) => {
                const isActive = isItemActive(child, pathname, currentType);
                const badgeCount = child.badge ? badgeCounts[child.badge] : 0;
                return (
                  <DropdownMenuItem key={child.href} asChild>
                    <Link
                      href={child.href}
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        gap: "12px",
                        width: "100%",
                        padding: "4px 6px",
                        textDecoration: "none",
                        color: isActive ? "var(--info)" : "var(--text-secondary)",
                        fontSize: "0.8rem",
                        fontFamily: "var(--font-body)",
                      }}
                    >
                      <span>{child.label}</span>
                      {badgeCount > 0 && <Badge count={badgeCount} />}
                    </Link>
                  </DropdownMenuItem>
                );
              })}
            </DropdownMenuContent>
          </DropdownMenu>
        );
      })}

      <span aria-hidden="true" style={{ flex: 1, minWidth: "8px" }} />

      <button
        onClick={openPalette}
        title="Command palette (Ctrl+K)"
        aria-label="Open command palette"
        style={{
          display: "flex",
          alignItems: "center",
          gap: "4px",
          padding: "4px 8px",
          borderRadius: "var(--radius)",
          border: "1px solid var(--border-subtle)",
          background: "transparent",
          color: "var(--text-muted)",
          cursor: "pointer",
          fontSize: "0.65rem",
          fontFamily: "var(--font-mono)",
          letterSpacing: "0.02em",
        }}
      >
        <Search style={{ width: "11px", height: "11px" }} />
        <span>⌘K</span>
      </button>

      <Link
        href="/settings"
        aria-label="Settings"
        title="Settings"
        style={{
          ...navLinkStyle(pathname === "/settings"),
          padding: "4px 8px",
        }}
      >
        <SettingsIcon style={{ width: "13px", height: "13px" }} />
      </Link>
    </nav>
  );
}

function navLinkStyle(isActive: boolean): React.CSSProperties {
  return {
    display: "flex",
    alignItems: "center",
    gap: "5px",
    padding: "4px 10px",
    borderRadius: "var(--radius)",
    fontSize: "0.7rem",
    fontWeight: 500,
    letterSpacing: "0.04em",
    textTransform: "uppercase",
    fontFamily: "var(--font-body)",
    textDecoration: "none",
    color: isActive ? "var(--info)" : "var(--text-secondary)",
    background: isActive ? "var(--info-bg)" : "transparent",
    transition: "color 0.12s, background 0.12s",
  };
}

function triggerStyle(isActive: boolean): React.CSSProperties {
  return {
    ...navLinkStyle(isActive),
    border: "none",
    cursor: "pointer",
  };
}

function Badge({ count }: { count: number }) {
  return (
    <span
      style={{
        fontFamily: "var(--font-mono)",
        fontSize: "0.65rem",
        fontWeight: 600,
        letterSpacing: 0,
        textTransform: "none",
        background: "var(--accent-bg)",
        color: "var(--accent)",
        border: "1px solid var(--accent-border)",
        borderRadius: "3px",
        padding: "0 4px",
        lineHeight: "1.4",
      }}
    >
      {count}
    </span>
  );
}
