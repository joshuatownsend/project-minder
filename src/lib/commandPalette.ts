export interface CommandItem {
  id: string;
  label: string;
  sublabel?: string;
  href?: string;
  action?: string; // named action handled by CommandPaletteProvider
  category?: string;
  keywords?: string[];
  badgeKey?: "inbox" | "decisions" | "approvals" | "steps";
}

// Static nav items — kept in sync with AppSidebar GROUPS (src/components/AppSidebar.tsx).
// Sublabels match the sidebar group headings so palette results read the same as the nav.
const NAV_COMMANDS: CommandItem[] = [
  { id: "nav-/",            label: "Home",          sublabel: "Pinned", href: "/" },
  { id: "nav-/projects",    label: "Projects",      sublabel: "Pinned", href: "/projects" },
  { id: "nav-/status",      label: "Status",        sublabel: "Pinned", href: "/status", badgeKey: "approvals" },
  { id: "nav-/new-project", label: "+ New Project", sublabel: "Pinned", href: "/new-project" },

  { id: "nav-/tasks",        label: "Tasks",        sublabel: "Build", href: "/tasks" },
  { id: "nav-/kanban",       label: "Kanban",       sublabel: "Build", href: "/kanban" },
  { id: "nav-/plans",        label: "Plans",        sublabel: "Build", href: "/plans" },
  { id: "nav-/manual-steps", label: "Manual Steps", sublabel: "Build", href: "/manual-steps", badgeKey: "steps" },
  { id: "nav-/schedule",     label: "Schedule",     sublabel: "Build", href: "/schedule" },
  { id: "nav-/insights",     label: "Insights",     sublabel: "Build", href: "/insights" },

  { id: "nav-/sessions", label: "Sessions", sublabel: "Sessions", href: "/sessions" },
  { id: "nav-/memory",   label: "Memory",   sublabel: "Sessions", href: "/memory" },
  { id: "nav-/timeline", label: "Timeline", sublabel: "Sessions", href: "/timeline" },

  { id: "nav-/agents",    label: "Agents",    sublabel: "Library", href: "/agents" },
  { id: "nav-/skills",    label: "Skills",    sublabel: "Library", href: "/skills" },
  { id: "nav-/commands",  label: "Commands",  sublabel: "Library", href: "/commands" },
  { id: "nav-/plugins",   label: "Plugins",   sublabel: "Library", href: "/plugins" },
  { id: "nav-/templates", label: "Templates", sublabel: "Library", href: "/templates" },
  { id: "nav-/swarms",    label: "Swarms",    sublabel: "Library", href: "/swarms" },
  { id: "nav-/library",   label: "Library",   sublabel: "Library", href: "/library" },

  { id: "nav-/analytics",       label: "Analytics",       sublabel: "Review", href: "/analytics" },
  { id: "nav-/stats",           label: "Stats",           sublabel: "Review", href: "/stats" },
  { id: "nav-/usage",           label: "Usage & cost",    sublabel: "Review", href: "/usage" },
  { id: "nav-/health",          label: "Health",          sublabel: "Review", href: "/health" },
  { id: "nav-/hooks",           label: "Hooks",           sublabel: "Review", href: "/hooks" },
  { id: "nav-/config-mcp",      label: "MCP",             sublabel: "Review", href: "/config?type=mcp" },
  { id: "nav-/sql",             label: "SQL",             sublabel: "Review", href: "/sql" },
  { id: "nav-/insights-report", label: "Insights Report", sublabel: "Review", href: "/insights-report" },

  { id: "nav-/setup",    label: "Setup",    sublabel: "Footer", href: "/setup" },
  { id: "nav-/settings", label: "Settings", sublabel: "Footer", href: "/settings" },
];

const QUICK_ACTIONS: CommandItem[] = [
  { id: "action-emergency-stop", label: "Emergency Stop", sublabel: "Halt all spawned tasks", action: "emergency-stop" },
];

export async function buildCommandIndex(): Promise<CommandItem[]> {
  const items: CommandItem[] = [...NAV_COMMANDS, ...QUICK_ACTIONS];

  const [projectsResult, sessionsResult, agentsResult] = await Promise.allSettled([
    fetch("/api/projects").then((r) => r.json()),
    fetch("/api/sessions?limit=50").then((r) => r.json()),
    fetch("/api/agents?limit=50").then((r) => r.json()),
  ]);

  if (projectsResult.status === "fulfilled" && Array.isArray(projectsResult.value)) {
    for (const p of projectsResult.value as { slug: string; name: string; path: string }[]) {
      items.push({
        id: `project-${p.slug}`,
        label: p.name,
        sublabel: p.path,
        href: `/project/${p.slug}`,
        category: "Projects",
        keywords: [p.slug],
      });
    }
  }

  if (sessionsResult.status === "fulfilled" && Array.isArray(sessionsResult.value)) {
    for (const s of sessionsResult.value as { sessionId: string; title?: string; slug?: string }[]) {
      const label = s.title || s.slug || s.sessionId;
      items.push({
        id: `session-${s.sessionId}`,
        label,
        sublabel: "Session",
        href: `/sessions/${s.sessionId}`,
        category: "Sessions",
      });
    }
  }

  if (agentsResult.status === "fulfilled" && Array.isArray(agentsResult.value)) {
    for (const a of agentsResult.value as { id: string; name: string; source?: string }[]) {
      items.push({
        id: `agent-${a.id}`,
        label: a.name,
        sublabel: a.source ? `Agent · ${a.source}` : "Agent",
        href: `/agents/${a.id}`,
        category: "Agents",
        keywords: [a.id],
      });
    }
  }

  return items;
}

/** Score a command item against a query. Returns 0 if no match (filter out). */
export function scoreItem(item: CommandItem, query: string): number {
  if (!query) return 1;
  const q = query.toLowerCase();
  const label = item.label.toLowerCase();
  const sublabel = (item.sublabel ?? "").toLowerCase();
  const keywords = (item.keywords ?? []).join(" ").toLowerCase();

  if (label.startsWith(q)) return 4;
  if (label.includes(q)) return 3;
  if (sublabel.includes(q) || keywords.includes(q)) return 2;
  // Subsequence check (all query chars appear in order in the label)
  let pos = 0;
  for (const ch of q) {
    const idx = label.indexOf(ch, pos);
    if (idx === -1) return 0;
    pos = idx + 1;
  }
  return 1;
}

export function filterCommands(items: CommandItem[], query: string): CommandItem[] {
  if (!query) return items;
  return items
    .map((item) => ({ item, score: scoreItem(item, query) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .map(({ item }) => item);
}

const RECENT_KEY = "minder.palette.recent";
const MAX_RECENT = 10;

export function getRecentIds(): string[] {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]") as string[];
  } catch {
    return [];
  }
}

export function recordRecent(id: string): void {
  try {
    const prev = getRecentIds().filter((r) => r !== id);
    localStorage.setItem(RECENT_KEY, JSON.stringify([id, ...prev].slice(0, MAX_RECENT)));
  } catch {
    // localStorage unavailable — ignore
  }
}
