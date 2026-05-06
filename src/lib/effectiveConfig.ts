import type { AgentEntry, SkillEntry } from "./indexer/types";
import type { McpServer, HookEntry } from "./types";
import { makeHookKey } from "./template/unitKey";

/**
 * Effective state of a config entry relative to the active Claude Code session.
 *
 *  active    — this is the entry Claude Code uses
 *  shadowed  — a higher-precedence entry with the same name exists; this one is ignored
 *  disabled  — the entry is explicitly disabled (skill moved to skills-disabled/,
 *              or MCP server listed in disabledMcpjsonServers)
 *  conflict  — same identity key appears in multiple scopes with different content
 *              (e.g., two hooks with identical event/matcher/command running twice)
 */
export type EffectiveState = "active" | "shadowed" | "disabled" | "conflict";

// Source precedence ranks (lower number = higher precedence = wins)
const AGENT_SKILL_PRECEDENCE: Record<string, number> = {
  user: 0,
  project: 1,
  plugin: 2,
};

/**
 * Compute the effective state for each agent by ID.
 * Precedence: user > project > plugin (name-based shadowing).
 */
export function computeEffectiveAgents(entries: AgentEntry[]): Map<string, EffectiveState> {
  return computeByName(entries, (e) => e.source);
}

/**
 * Compute the effective state for each skill by ID.
 * Precedence: user > project > plugin (name-based shadowing).
 * Skills also carry an explicit `disabled` flag.
 */
export function computeEffectiveSkills(entries: SkillEntry[]): Map<string, EffectiveState> {
  const states = computeByName(entries, (e) => e.source);
  // Apply explicit disabled flag on top
  for (const entry of entries) {
    if (entry.disabled) states.set(entry.id, "disabled");
  }
  return states;
}

function computeByName<T extends { id: string; name: string; source: string }>(
  entries: T[],
  getSource: (e: T) => string,
): Map<string, EffectiveState> {
  // For each unique name, find the highest-precedence source
  const best = new Map<string, number>(); // name → best precedence rank
  for (const e of entries) {
    const rank = AGENT_SKILL_PRECEDENCE[getSource(e)] ?? 99;
    const prev = best.get(e.name);
    if (prev === undefined || rank < prev) best.set(e.name, rank);
  }

  const states = new Map<string, EffectiveState>();
  for (const e of entries) {
    const rank = AGENT_SKILL_PRECEDENCE[getSource(e)] ?? 99;
    const bestRank = best.get(e.name) ?? 99;
    states.set(e.id, rank === bestRank ? "active" : "shadowed");
  }
  return states;
}

/**
 * Compute effective state for MCP servers.
 *
 * When `managed` scope is present, all non-managed servers are shadowed.
 * Otherwise, project-scope servers tagged `disabled` are "disabled";
 * remaining servers are "active". Duplicate names across scopes → "conflict".
 */
export function computeEffectiveMcp(servers: McpServer[]): Map<string, EffectiveState> {
  const states = new Map<string, EffectiveState>();
  const hasManagedScope = servers.some((s) => s.source === "managed");

  // Track names to detect conflicts
  const seen = new Map<string, McpServer>();

  for (const s of servers) {
    if (hasManagedScope && s.source !== "managed") {
      states.set(s.name, "shadowed");
      continue;
    }

    if (s.disabled) {
      states.set(s.name, "disabled");
      continue;
    }

    const prev = seen.get(s.name);
    if (prev) {
      // Same name, different entry → conflict
      states.set(s.name, "conflict");
      // Also mark the first occurrence as conflict
      const prevKey = `${prev.source}:${prev.name}`;
      if (!states.has(prevKey)) states.set(prevKey, "conflict");
    } else {
      seen.set(s.name, s);
      states.set(s.name, "active");
    }
  }

  return states;
}

/**
 * Compute effective state for hooks by their canonical key.
 *
 * Hooks are ADDITIVE in Claude Code — the same hook key in multiple scopes
 * runs multiple times, which is usually unintentional. We flag duplicate
 * keys as "conflict".
 */
export function computeEffectiveHooks(hooks: HookEntry[]): Map<string, EffectiveState> {
  const states = new Map<string, EffectiveState>();
  const seen = new Set<string>();

  for (const h of hooks) {
    for (const cmd of h.commands) {
      const key = makeHookKey(h.event, h.matcher, cmd.command);
      if (seen.has(key)) {
        states.set(key, "conflict");
      } else {
        seen.add(key);
        if (!states.has(key)) states.set(key, "active");
      }
    }
  }

  return states;
}
