/**
 * Environments comparison — what each Claude home has installed, and how the
 * homes differ. Environment-borne state (user/plugin agents and skills,
 * installed plugins, MCP servers) lives per machine, not per checkout, so a
 * project group whose members sit under different Claude homes can behave
 * differently in each: this is the diff that explains why.
 *
 * This file is the client-safe half: the payload types the route emits and
 * the pure presence-matrix logic over them. The filesystem walk that produces
 * a payload is `./inventory.ts` (server-only) — nothing here may import it,
 * `@/lib/platform`, or `@/lib/claudeHome`, or the group page drags
 * `child_process` into the client bundle (the boundary only `pnpm build`
 * catches).
 */

export interface EnvAgent {
  /** Path-derived id relative to `<home>/agents`, without `.md`. */
  slug: string;
  /** Frontmatter `name`, when the file declares one. */
  name?: string;
}

export interface EnvSkill {
  /** Directory name for a bundled skill, file stem for a standalone one. */
  slug: string;
  name?: string;
  /** Lives under `skills-disabled/` rather than `skills/`. */
  disabled: boolean;
}

export interface EnvPlugin {
  /** `name@marketplace`, the registry key. */
  id: string;
  name: string;
  marketplace: string;
  version?: string;
}

export interface EnvironmentHome {
  /**
   * `normalizePathKey(<configured home>)` — the SAME key the scanner stamps
   * on `ProjectData.usageHomeKey` for a project under that home, so a group
   * location joins to its home by string equality. Opaque to the client.
   */
  key: string;
  /** The configured home path, as written. */
  path: string;
  /** This machine's own `~/.claude`. Members with no `usageHomeKey` belong here. */
  primary: boolean;
  agents: EnvAgent[];
  skills: EnvSkill[];
  plugins: EnvPlugin[];
  /** Server NAMES only — configs carry env blocks with secrets. */
  mcpServers: string[];
}

export interface UnavailableEnvironmentHome {
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
  homes: Map<string, string | undefined>;
}

function collect<T>(
  homes: readonly EnvironmentHome[],
  pick: (h: EnvironmentHome) => readonly T[],
  id: (t: T) => string,
  label: (t: T) => string,
  detail: (t: T) => string | undefined
): EnvDiffRow[] {
  const byId = new Map<string, Presence>();
  for (const h of homes) {
    for (const item of pick(h)) {
      const key = id(item);
      let p = byId.get(key);
      if (p === undefined) {
        p = { label: label(item), homes: new Map() };
        byId.set(key, p);
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
      return { id: rowId, label: p.label, presentIn, detailIn, uniform };
    })
    .sort((a, b) => Number(a.uniform) - Number(b.uniform) || a.id.localeCompare(b.id));
}

/**
 * Presence matrix per kind over the given homes. Divergent rows sort first
 * within a kind — the page is for finding differences, not listing installs.
 * With a single home every row is uniform by definition.
 */
export function diffEnvironments(homes: readonly EnvironmentHome[]): EnvironmentsDiff {
  const kinds: EnvDiffKind[] = [
    {
      kind: "agent",
      rows: collect(homes, (h) => h.agents, (a) => a.slug, (a) => a.name ?? a.slug, () => undefined),
      divergent: 0,
    },
    {
      kind: "skill",
      rows: collect(
        homes,
        (h) => h.skills,
        (s) => s.slug,
        (s) => s.name ?? s.slug,
        (s) => (s.disabled ? "disabled" : undefined)
      ),
      divergent: 0,
    },
    {
      kind: "plugin",
      rows: collect(homes, (h) => h.plugins, (p) => p.id, (p) => p.id, (p) => p.version),
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
export function homeForLocation(
  usageHomeKey: string | undefined,
  homes: readonly EnvironmentHome[]
): EnvironmentHome | undefined {
  if (usageHomeKey === undefined) return homes.find((h) => h.primary);
  return homes.find((h) => h.key === usageHomeKey);
}
