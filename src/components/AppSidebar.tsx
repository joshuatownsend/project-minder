"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useState, useEffect, useMemo, useRef, type ReactNode } from "react";
import {
  Home, LayoutGrid, Activity,
  CheckSquare, Columns3, FileText, ListChecks, Calendar, Lightbulb,
  Layers, Brain, Clock, Sprout, Trash2, MonitorPlay,
  Bot, Sparkles, Terminal, Plug, BookOpen, Network, Library,
  BarChart3, Wallet, HeartPulse, Webhook, Boxes, Database,
  Sliders, Settings as SettingsIcon,
  ChevronRight, ChevronDown,
} from "lucide-react";
import { usePulse } from "./PulseProvider";
import { useScope } from "./ScopeProvider";

type BadgeKind = "warn" | "danger" | "live" | "default";
type BadgeKey = "steps" | "approval" | "live";

interface NavItem {
  id: string;
  label: string;
  href: string;
  /** When set, this item only matches when the search-param matches too. */
  matchType?: string;
  icon: ReactNode;
  /** Keys are resolved against PulseSnapshot at render time. */
  badge?: BadgeKey;
  /** Static placeholder (shown for "Coming soon" stub routes). */
  comingSoon?: boolean;
}

interface NavGroup {
  id: string;
  label: string;
  hint: string;
  children: NavItem[];
}

const ICON_SIZE = 16;
const ico = (Comp: typeof Home) => <Comp width={ICON_SIZE} height={ICON_SIZE} />;

const PINNED: NavItem[] = [
  { id: "home",     label: "Home",     href: "/",         icon: ico(Home) },
  { id: "projects", label: "Projects", href: "/projects", icon: ico(LayoutGrid) },
  { id: "status",   label: "Status",   href: "/status",   icon: ico(Activity), badge: "approval" },
];

const GROUPS: NavGroup[] = [
  {
    id: "build",
    label: "Build",
    hint: "Day-to-day work on your projects",
    children: [
      { id: "tasks",        label: "Tasks",        href: "/tasks",        icon: ico(CheckSquare) },
      { id: "kanban",       label: "Kanban",       href: "/kanban",       icon: ico(Columns3) },
      { id: "plans",        label: "Plans",        href: "/plans",        icon: ico(FileText) },
      { id: "manual-steps", label: "Manual steps", href: "/manual-steps", icon: ico(ListChecks), badge: "steps" },
      { id: "schedule",     label: "Schedule",     href: "/schedule",     icon: ico(Calendar),    comingSoon: true },
      { id: "insights",     label: "Insights",     href: "/insights",     icon: ico(Lightbulb) },
    ],
  },
  {
    id: "sessions",
    label: "Sessions",
    hint: "What Claude Code is doing right now",
    children: [
      { id: "agent-view", label: "Agent view", href: "/agent-view", icon: ico(MonitorPlay), badge: "live" },
      { id: "sessions", label: "Sessions", href: "/sessions", icon: ico(Layers) },
      { id: "background", label: "Background", href: "/background", icon: ico(Activity) },
      { id: "memory",   label: "Memory",   href: "/memory",   icon: ico(Brain) },
      { id: "memory-seed", label: "Memory seed", href: "/memory/seed", icon: ico(Sprout) },
      { id: "memory-triage", label: "Memory triage", href: "/memory/triage", icon: ico(Trash2) },
      { id: "timeline", label: "Timeline", href: "/timeline", icon: ico(Clock),   comingSoon: true },
    ],
  },
  {
    id: "library",
    label: "Library",
    hint: "Reusable building blocks — copy across projects",
    children: [
      { id: "agents",    label: "Agents",    href: "/agents",    icon: ico(Bot) },
      { id: "skills",    label: "Skills",    href: "/skills",    icon: ico(Sparkles) },
      { id: "commands",  label: "Commands",  href: "/commands",  icon: ico(Terminal) },
      { id: "plugins",   label: "Plugins",   href: "/plugins",   icon: ico(Plug) },
      { id: "templates", label: "Templates", href: "/templates", icon: ico(BookOpen) },
      { id: "swarms",    label: "Swarms",    href: "/swarms",    icon: ico(Network) },
      { id: "library",   label: "Library",   href: "/library",   icon: ico(Library) },
    ],
  },
  {
    id: "review",
    label: "Review",
    hint: "Oversight, costs, and integrations",
    children: [
      { id: "analytics",       label: "Analytics",       href: "/analytics",       icon: ico(BarChart3),   comingSoon: true },
      { id: "stats",           label: "Stats",           href: "/stats",           icon: ico(BarChart3) },
      { id: "usage",           label: "Usage & cost",    href: "/usage",           icon: ico(Wallet) },
      { id: "health",          label: "Health",          href: "/health",          icon: ico(HeartPulse),  comingSoon: true },
      { id: "hooks",           label: "Hooks",           href: "/hooks",           icon: ico(Webhook) },
      { id: "mcps",            label: "MCP",             href: "/config?type=mcp", matchType: "mcp", icon: ico(Boxes) },
      { id: "sql",             label: "SQL",             href: "/sql",             icon: ico(Database) },
      { id: "insights-report", label: "Insights report", href: "/insights-report", icon: ico(Lightbulb) },
    ],
  },
];

const FOOTER: NavItem[] = [
  { id: "setup",    label: "Setup",    href: "/setup",    icon: ico(Sliders) },
  { id: "settings", label: "Settings", href: "/settings", icon: ico(SettingsIcon) },
];

function isActive(item: NavItem, pathname: string, currentType: string | null): boolean {
  const path = item.href.split("?")[0];
  if (item.matchType !== undefined) {
    return pathname === path && currentType === item.matchType;
  }
  if (path === "/") return pathname === "/";
  return pathname === path || pathname.startsWith(path + "/");
}

interface SidebarProps {
  collapsed: boolean;
  /** Optional callback to open the project scope picker modal. */
  onOpenScopePicker?: () => void;
}

export function AppSidebar({ collapsed, onOpenScopePicker }: SidebarProps) {
  const pathname = usePathname() ?? "/";
  const searchParams = useSearchParams();
  const currentType = searchParams?.get("type") ?? null;
  const { snapshot } = usePulse();
  const { scope } = useScope();

  // Render badges only AFTER hydration. Server-rendered HTML can't know the
  // current pulse counts (they'll always be zero on first paint anyway, but
  // when this tree is wrapped in a Suspense boundary that flushes after the
  // outer shell, React reports a mismatch between the SSR snapshot frame and
  // the first client frame). Defer the badge UI to a post-mount paint and
  // both sides agree on "no badges yet". Was HIGH-4 in the 2026-05-10 review.
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);

  const badgeCount = (key: BadgeKey | undefined): number => {
    if (!hydrated || !key) return 0;
    if (key === "steps") return snapshot.pendingSteps;
    if (key === "approval") return snapshot.approvalCount;
    if (key === "live") return snapshot.liveSlugs.length;
    return 0;
  };

  const badgeKindFor = (key: BadgeKey | undefined): BadgeKind => {
    if (key === "live") return "live";
    if (key === "approval") return "warn";
    if (key === "steps") return "warn";
    return "default";
  };

  // Auto-expand the group whose child is active. User-toggled state is layered
  // on top via `userOverrides`. We keep both so that navigating into a group
  // opens it, but a user who collapsed it manually doesn't see it pop back
  // open every time they click a child.
  const initialOpen = useMemo<Record<string, boolean>>(() => {
    const out: Record<string, boolean> = {};
    for (const g of GROUPS) {
      out[g.id] = g.children.some((c) => isActive(c, pathname, currentType));
    }
    return out;
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- initial only
  const [openMap, setOpenMap] = useState<Record<string, boolean>>(initialOpen);
  // Track which groups the user has explicitly toggled so auto-expand only
  // runs when they haven't expressed a preference yet.
  const userToggledRef = useRef<Set<string>>(new Set());

  // When navigating into a child of a non-open group that the user hasn't
  // explicitly collapsed, auto-expand it.
  useEffect(() => {
    const activeGroup = GROUPS.find((g) =>
      g.children.some((c) => isActive(c, pathname, currentType)),
    );
    if (!activeGroup) return;
    if (userToggledRef.current.has(activeGroup.id)) return;
    setOpenMap((prev) => (prev[activeGroup.id] ? prev : { ...prev, [activeGroup.id]: true }));
  }, [pathname, currentType]);

  const toggleGroup = (id: string) => {
    userToggledRef.current.add(id);
    setOpenMap((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const scopeLabel = scope === "all" ? "All projects" : scope;

  return (
    <aside className="sidebar" data-collapsed={collapsed}>
      {/* Project switcher */}
      <button
        type="button"
        className="proj-switcher"
        onClick={onOpenScopePicker}
        title={collapsed ? `Project: ${scopeLabel}` : undefined}
        // aria-label is always set (not just when collapsed) so screen readers
        // get a dependable name. When expanded, the visible `.scope-label` +
        // `.scope-name` text would normally provide the accessible name, but
        // the brand glyph being `aria-hidden` means a strict AT walk could
        // miss the scope context on the collapsed control — `title` alone
        // is not consistently announced. Closes Copilot PR #117 a11y finding.
        aria-label={`Project: ${scopeLabel}. Click to switch project.`}
        style={collapsed ? { padding: 6 } : undefined}
      >
        <div className="row">
          {/* Fixed brand mark — was previously the first letter of the
              selected scope ("∞" for all-projects). Pinning to "PM" treats
              the glyph as a constant brand affordance; the active scope
              still reads from `.scope-name` next to it. */}
          <div className="glyph" aria-hidden="true">PM</div>
          {!collapsed && (
            <>
              <div className="meta">
                <div className="scope-label">Project</div>
                <div className="scope-name">{scopeLabel}</div>
              </div>
              <span className="chev"><ChevronDown width={14} height={14} /></span>
            </>
          )}
        </div>
      </button>

      {/* Pinned items */}
      {PINNED.map((it) => (
        <NavRow
          key={it.id}
          item={it}
          active={isActive(it, pathname, currentType)}
          collapsed={collapsed}
          badge={{ count: badgeCount(it.badge), kind: badgeKindFor(it.badge) }}
        />
      ))}

      {/* Groups */}
      {GROUPS.map((g) => {
        const isOpen = collapsed ? true : !!openMap[g.id];
        const groupActive = g.children.some((c) => isActive(c, pathname, currentType));
        const childBadges = g.children.map((c) => ({
          count: badgeCount(c.badge),
          kind: badgeKindFor(c.badge),
        }));
        const bubbleCount = childBadges.reduce((s, b) => s + b.count, 0);
        const bubbleKind: BadgeKind =
          childBadges.find((b) => b.count > 0 && b.kind === "danger")?.kind ??
          childBadges.find((b) => b.count > 0 && b.kind === "warn")?.kind ??
          childBadges.find((b) => b.count > 0 && b.kind === "live")?.kind ??
          "default";

        if (collapsed) {
          return (
            <div key={g.id}>
              <div style={{ height: 1, background: "var(--line-soft)", margin: "8px 6px" }} />
              {g.children.map((c) => (
                <NavRow
                  key={c.id}
                  item={c}
                  active={isActive(c, pathname, currentType)}
                  collapsed
                  badge={{ count: badgeCount(c.badge), kind: badgeKindFor(c.badge) }}
                />
              ))}
            </div>
          );
        }
        return (
          <div key={g.id} className="nav-group">
            <button
              type="button"
              className={"nav-group-head" + (groupActive ? " has-active" : "")}
              onClick={() => toggleGroup(g.id)}
              title={g.hint}
              aria-expanded={isOpen}
            >
              <span className="chev-mini" style={{ transform: isOpen ? "rotate(90deg)" : "rotate(0)" }}>
                <ChevronRight width={12} height={12} />
              </span>
              <span className="lbl">{g.label}</span>
              {bubbleCount > 0 && !isOpen && (
                <span className={"badge " + bubbleKind}>{bubbleCount}</span>
              )}
            </button>
            {isOpen &&
              g.children.map((c) => (
                <NavRow
                  key={c.id}
                  item={c}
                  active={isActive(c, pathname, currentType)}
                  collapsed={false}
                  indent
                  badge={{ count: badgeCount(c.badge), kind: badgeKindFor(c.badge) }}
                />
              ))}
          </div>
        );
      })}

      <div style={{ flex: 1 }} />

      {/* Footer */}
      <div style={{ borderTop: "1px solid var(--line-soft)", paddingTop: 8, marginTop: 8 }}>
        {FOOTER.map((it) => (
          <NavRow
            key={it.id}
            item={it}
            active={isActive(it, pathname, currentType)}
            collapsed={collapsed}
            badge={{ count: 0, kind: "default" }}
          />
        ))}
      </div>
    </aside>
  );
}

function NavRow({
  item,
  active,
  collapsed,
  indent,
  badge,
}: {
  item: NavItem;
  active: boolean;
  collapsed: boolean;
  indent?: boolean;
  badge: { count: number; kind: BadgeKind };
}) {
  return (
    <Link
      href={item.href}
      className={"nav-item" + (active ? " active" : "")}
      title={collapsed ? item.label : item.comingSoon ? `${item.label} — coming soon` : undefined}
      style={indent && !collapsed ? { paddingLeft: 24 } : undefined}
    >
      <span className="ico">{item.icon}</span>
      {!collapsed && (
        <span className="label">
          {item.label}
          {item.comingSoon && (
            <span style={{ marginLeft: 6, fontSize: 9, color: "var(--text-4)", textTransform: "uppercase", letterSpacing: 0.5 }}>
              soon
            </span>
          )}
        </span>
      )}
      {!collapsed && badge.count > 0 && (
        <span className={"badge " + badge.kind}>
          {badge.kind === "live" && <span className="live" />}
          {badge.count}
        </span>
      )}
    </Link>
  );
}
