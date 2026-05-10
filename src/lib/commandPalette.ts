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

// Static nav items — kept in sync with AppNav GROUPS
const NAV_COMMANDS: CommandItem[] = [
  { id: "nav-/",           label: "Projects",       sublabel: "Dashboard", href: "/" },
  { id: "nav-/new-project",label: "+ New Project",  sublabel: "Dashboard", href: "/new-project" },
  { id: "nav-/agents",     label: "Agents",         sublabel: "Catalog",   href: "/agents" },
  { id: "nav-/skills",     label: "Skills",         sublabel: "Catalog",   href: "/skills" },
  { id: "nav-/commands",   label: "Commands",       sublabel: "Catalog",   href: "/commands" },
  { id: "nav-/plugins",    label: "Plugins",        sublabel: "Catalog",   href: "/plugins" },
  { id: "nav-/templates",  label: "Templates",      sublabel: "Catalog",   href: "/templates" },
  { id: "nav-/library",    label: "Library",        sublabel: "Catalog",   href: "/library" },
  { id: "nav-/sessions",   label: "Sessions",       sublabel: "Sessions",  href: "/sessions" },
  { id: "nav-/plans",      label: "Plans",          sublabel: "Sessions",  href: "/plans" },
  { id: "nav-/stats",      label: "Stats",          sublabel: "Sessions",  href: "/stats" },
  { id: "nav-/usage",      label: "Usage",          sublabel: "Sessions",  href: "/usage" },
  { id: "nav-/sql",        label: "SQL",            sublabel: "Sessions",  href: "/sql" },
  { id: "nav-/insights-report", label: "Insights Report", sublabel: "Sessions", href: "/insights-report" },
  { id: "nav-/kanban",     label: "Kanban",         sublabel: "Mission Control", href: "/kanban" },
  { id: "nav-/tasks",      label: "Tasks",          sublabel: "Mission Control", href: "/tasks" },
  { id: "nav-/swarms",     label: "Swarms",         sublabel: "Mission Control", href: "/swarms" },
  { id: "nav-/schedule",   label: "Schedule",       sublabel: "Mission Control", href: "/schedule" },
  { id: "nav-/hooks",      label: "Hooks",          sublabel: "Config",    href: "/hooks" },
  { id: "nav-/settings",   label: "Settings",       sublabel: "Config",    href: "/settings" },
  { id: "nav-/setup",      label: "Setup",          sublabel: "Config",    href: "/setup" },
  { id: "nav-/status",     label: "Status",         sublabel: "Config",    href: "/status", badgeKey: "approvals" },
  { id: "nav-/insights",   label: "Insights",       sublabel: "Config",    href: "/insights" },
  { id: "nav-/manual-steps",label: "Manual Steps",  sublabel: "Config",    href: "/manual-steps", badgeKey: "steps" },
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
