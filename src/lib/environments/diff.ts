/**
 * Environments comparison — what each Claude home has installed, and how the
 * homes differ. Environment-borne state (user/plugin agents and skills,
 * installed plugins, MCP servers) lives per machine, not per checkout, so a
 * project group whose members sit under different Claude homes can behave
 * differently in each: this is the diff that explains why.
 *
 * This file is the client-safe half: the payload types the route emits, the
 * per-home input the tab assembles from that payload plus the catalog, and
 * the pure presence-matrix logic over it. The filesystem reads that produce a
 * payload are `./inventory.ts` (server-only) — nothing here may import it,
 * `@/lib/platform`, or `@/lib/claudeHome`, or the group page drags
 * `child_process` into the client bundle (the boundary only `pnpm build`
 * catches).
 *
 * Since #553 the agents and skills of a home come from the catalog
 * (`/api/agents?home=` and `/api/skills?home=`), which carries descriptions
 * and the plugin-provided entries; `/api/environments` is reduced to what the
 * catalog does not cover — plugins from the registry, MCP server names, and
 * the homes that could not be read.
 */

export interface EnvAgent {
  /** Path-derived id relative to the agents root, without `.md`. */
  slug: string;
  /** Frontmatter `name`, when the file declares one. */
  name?: string;
  description?: string;
  /** User-scope (`<home>/agents`) or provided by an installed plugin. */
  source: "user" | "plugin";
  pluginName?: string;
  /**
   * The providing plugin's registry key (`name@marketplace`), from the
   * entry's provenance. The identity, where `pluginName` is the label: the
   * same plugin name from two marketplaces is two plugins.
   */
  pluginId?: string;
}

export interface EnvSkill {
  /** Directory name for a bundled skill, file stem for a standalone one. */
  slug: string;
  name?: string;
  description?: string;
  source: "user" | "plugin";
  pluginName?: string;
  /** Registry key of the providing plugin — see `EnvAgent.pluginId`. */
  pluginId?: string;
  /** Lives under `skills-disabled/` rather than `skills/`. */
  disabled: boolean;
}

export interface EnvPlugin {
  /** `name@marketplace`, the registry key. */
  id: string;
  name: string;
  marketplace: string;
  version?: string;
  /**
   * The registry `installPath` could not be mapped to a path this machine
   * can open (a foreign home with no covering `pathMappings` entry), so the
   * plugin's agents and skills are absent from that home's catalog columns
   * — not because they are uninstalled.
   */
  unresolved?: boolean;
}

/** One home as `GET /api/environments` reports it. */
export interface EnvironmentHome {
  /**
   * `normalizePathKey(<configured home>)` — the SAME key the scanner stamps
   * on `ProjectData.usageHomeKey` for a project under that home, so a group
   * location joins to its home by string equality, and the same key
   * `/api/agents?home=` and `/api/skills?home=` accept. Opaque to the client.
   */
  key: string;
  /** The configured home path, as written. */
  path: string;
  /** This machine's own `~/.claude`. Members with no `usageHomeKey` belong here. */
  primary: boolean;
  plugins: EnvPlugin[];
  /** Server NAMES only — configs carry env blocks with secrets. */
  mcpServers: string[];
}

/** A home plus its catalog halves: the input `diffEnvironments` compares. */
export interface EnvironmentInventory extends EnvironmentHome {
  agents: EnvAgent[];
  skills: EnvSkill[];
}

export interface UnavailableEnvironmentHome {
  /** Same key scheme as `EnvironmentHome.key`, so a client can match it to a
   *  member's `usageHomeKey` and show only the homes THIS group lives under. */
  key: string;
  path: string;
  distro?: string;
  /** `checkWslRoot`'s verdict — `wsl-stopped`, `wsl-distro-not-found`, … */
  reason: string;
}

export interface EnvironmentsPayload {
  homes: EnvironmentHome[];
  /** Configured homes that were not read this cycle (never-wake rule), with why. */
  unavailable: UnavailableEnvironmentHome[];
}

export type EnvKind = "agent" | "skill" | "plugin" | "mcp";

export interface EnvDiffRow {
  id: string;
  label: string;
  /** First description seen for this row across the compared homes, when any home declares one. */
  description?: string;
  /** Set for plugin-provided agents and skills; the plugin that ships the entry. */
  pluginName?: string;
  /** Home keys that have this entry. */
  presentIn: string[];
  /** Per-home annotation where the copies differ (a disabled skill, a plugin version). */
  detailIn: Record<string, string>;
  /** Present in every compared home with no differing detail. */
  uniform: boolean;
}

export interface EnvDiffKind {
  kind: EnvKind;
  rows: EnvDiffRow[];
  /** Rows that are not uniform. */
  divergent: number;
}

export interface EnvironmentsDiff {
  /** Home keys compared, in input order. */
  homeKeys: string[];
  kinds: EnvDiffKind[];
  divergent: number;
}

interface Presence {
  label: string;
  description?: string;
  pluginName?: string;
  homes: Map<string, string | undefined>;
}

/**
 * A user-scope `reviewer` and a plugin's `reviewer` are different entries, so
 * the row identity carries the provider: a home that has one and a home that
 * has the other must not read as agreeing.
 */
function providedId(item: { slug: string; source: "user" | "plugin"; pluginName?: string; pluginId?: string }): string {
  if (item.source !== "plugin") return `user:${item.slug}`;
  // The registry key (`name@marketplace`) when provenance supplies it: the
  // same plugin name from two marketplaces is two plugins, and their
  // same-named agents must not read as one row (Codex on #555). The bare
  // name is the fallback for an entry without marketplace provenance; the
  // placeholder keeps an unexpected gap from producing an empty `plugin::x`
  // segment that could collide across plugins (Copilot on #555).
  return `plugin:${item.pluginId ?? item.pluginName ?? UNKNOWN_PLUGIN}:${item.slug}`;
}

const UNKNOWN_PLUGIN = "unknown-plugin";

function collect<T>(
  homes: readonly EnvironmentInventory[],
  pick: (h: EnvironmentInventory) => readonly T[],
  id: (t: T) => string,
  label: (t: T) => string,
  detail: (t: T) => string | undefined,
  extra: (t: T) => { description?: string; pluginName?: string } = () => ({})
): EnvDiffRow[] {
  const byId = new Map<string, Presence>();
  for (const h of homes) {
    for (const item of pick(h)) {
      const key = id(item);
      let p = byId.get(key);
      if (p === undefined) {
        p = { label: label(item), ...extra(item), homes: new Map() };
        byId.set(key, p);
      } else if (p.description === undefined) {
        p.description = extra(item).description;
      }
      p.homes.set(h.key, detail(item));
    }
  }
  return [...byId.entries()]
    .map(([rowId, p]) => {
      const presentIn = [...p.homes.keys()];
      const detailIn: Record<string, string> = {};
      for (const [k, d] of p.homes) if (d !== undefined) detailIn[k] = d;
      const details = new Set(presentIn.map((k) => detailIn[k] ?? ""));
      const uniform = presentIn.length === homes.length && details.size <= 1;
      return {
        id: rowId,
        label: p.label,
        ...(p.description !== undefined ? { description: p.description } : {}),
        ...(p.pluginName !== undefined ? { pluginName: p.pluginName } : {}),
        presentIn,
        detailIn,
        uniform,
      };
    })
    .sort((a, b) => Number(a.uniform) - Number(b.uniform) || a.id.localeCompare(b.id));
}

/**
 * Presence matrix per kind over the given homes. Divergent rows sort first
 * within a kind — the page is for finding differences, not listing installs.
 * With a single home every row is uniform by definition.
 */
export function diffEnvironments(homes: readonly EnvironmentInventory[]): EnvironmentsDiff {
  const provided = (t: { description?: string; pluginName?: string; source: "user" | "plugin" }) => ({
    description: t.description,
    // Omitted when unknown rather than coerced to "" — an empty string would
    // render as a blank plugin tag.
    ...(t.source === "plugin" && t.pluginName ? { pluginName: t.pluginName } : {}),
  });
  const kinds: EnvDiffKind[] = [
    {
      kind: "agent",
      rows: collect(homes, (h) => h.agents, providedId, (a) => a.name ?? a.slug, () => undefined, provided),
      divergent: 0,
    },
    {
      kind: "skill",
      rows: collect(
        homes,
        (h) => h.skills,
        providedId,
        (s) => s.name ?? s.slug,
        (s) => (s.disabled ? "disabled" : undefined),
        provided
      ),
      divergent: 0,
    },
    {
      kind: "plugin",
      rows: collect(
        homes,
        (h) => h.plugins,
        (p) => p.id,
        (p) => p.id,
        (p) => (p.unresolved ? `${p.version ?? "?"} · unreadable` : p.version)
      ),
      divergent: 0,
    },
    {
      kind: "mcp",
      rows: collect(homes, (h) => h.mcpServers, (m) => m, (m) => m, () => undefined),
      divergent: 0,
    },
  ];
  for (const k of kinds) k.divergent = k.rows.filter((r) => !r.uniform).length;
  return {
    homeKeys: homes.map((h) => h.key),
    kinds,
    divergent: kinds.reduce((n, k) => n + k.divergent, 0),
  };
}

/**
 * The home a group location lives under: its `usageHomeKey` when the scanner
 * pinned one (a mapped WSL checkout), else the primary home. `undefined` when
 * the pinned home is not in the payload — it was unavailable this cycle, or
 * was removed from config since the scan.
 */
export function homeForLocation<H extends { key: string; primary: boolean }>(
  usageHomeKey: string | undefined,
  homes: readonly H[]
): H | undefined {
  if (usageHomeKey === undefined) return homes.find((h) => h.primary);
  return homes.find((h) => h.key === usageHomeKey);
}
