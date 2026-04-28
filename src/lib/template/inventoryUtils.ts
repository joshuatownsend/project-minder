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

/** Total number of units across all kinds. Useful for UI summaries. */
export function inventoryCount(inv: TemplateUnitInventory): number {
  return (
    inv.agents.length +
    inv.skills.length +
    inv.commands.length +
    inv.hooks.length +
    inv.mcp.length +
    inv.plugins.length +
    inv.workflows.length +
    inv.settings.length
  );
}
