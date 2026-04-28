/**
 * Pure inventory helpers — no `fs`, `child_process`, or other server-only
 * imports. Lives in its own module so client components (`TemplatesBrowser`,
 * `ApplyTemplateModal`, etc.) can import the count + key-mapping helpers
 * without dragging the rest of `manifest.ts`'s server-side dependency graph
 * (atomicFs → fs, config → platform → child_process) into the browser bundle.
 *
 * `manifest.ts` re-exports these for back-compat with server-side callers.
 */

import type {
  TemplateUnitInventory,
  UnitKind,
} from "../types";

/** Map a UnitKind to the plural property name used inside `units`. The
 *  `Record<UnitKind, …>` constraint gives us compile-time exhaustiveness for
 *  free — adding a new UnitKind without an entry here surfaces as a TS error. */
const INVENTORY_KEY_BY_UNIT: Record<UnitKind, keyof TemplateUnitInventory> = {
  agent: "agents",
  skill: "skills",
  command: "commands",
  hook: "hooks",
  mcp: "mcp",
  plugin: "plugins",
  workflow: "workflows",
  settingsKey: "settings",
};

export function inventoryKeyFor(kind: UnitKind): keyof TemplateUnitInventory {
  return INVENTORY_KEY_BY_UNIT[kind];
}

export function emptyInventory(): TemplateUnitInventory {
  return {
    agents: [],
    skills: [],
    commands: [],
    hooks: [],
    mcp: [],
    plugins: [],
    workflows: [],
    settings: [],
  };
}

/** Total number of units across all kinds. Useful for UI summaries.
 *
 *  Tolerates legacy manifests written before a unit kind existed — those
 *  manifests have no entry for the new kind, so reading `.length` would
 *  throw `Cannot read properties of undefined`. We coalesce missing arrays
 *  to 0 here so applying or browsing pre-V4 templates doesn't crash. */
export function inventoryCount(inv: TemplateUnitInventory): number {
  return (
    (inv.agents?.length ?? 0) +
    (inv.skills?.length ?? 0) +
    (inv.commands?.length ?? 0) +
    (inv.hooks?.length ?? 0) +
    (inv.mcp?.length ?? 0) +
    (inv.plugins?.length ?? 0) +
    (inv.workflows?.length ?? 0) +
    (inv.settings?.length ?? 0)
  );
}

/** Returns a new inventory with every kind defaulted to `[]` if missing.
 *  Use whenever a legacy manifest might be in flight. */
export function normalizeInventory(inv: Partial<TemplateUnitInventory>): TemplateUnitInventory {
  return {
    agents: inv.agents ?? [],
    skills: inv.skills ?? [],
    commands: inv.commands ?? [],
    hooks: inv.hooks ?? [],
    mcp: inv.mcp ?? [],
    plugins: inv.plugins ?? [],
    workflows: inv.workflows ?? [],
    settings: inv.settings ?? [],
  };
}
