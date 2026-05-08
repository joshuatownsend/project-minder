import type { CategoryType } from "./types";

export type WorkMode = "exploration" | "building" | "testing" | "other";

export interface WorkModeBreakdown {
  exploration: number;
  building: number;
  testing: number;
  other: number;
}

const MODE_MAP: Record<CategoryType, WorkMode> = {
  Exploration: "exploration",
  Brainstorming: "exploration",
  Planning: "exploration",
  Coding: "building",
  "Feature Dev": "building",
  Refactoring: "building",
  Testing: "testing",
  "Git Ops": "other",
  "Build/Deploy": "other",
  Debugging: "other",
  Delegation: "other",
  Conversation: "other",
  General: "other",
};

export function categoryToWorkMode(cat: CategoryType): WorkMode {
  return MODE_MAP[cat] ?? "other";
}

export function aggregateWorkMode(
  turns: Array<{ category?: string | null }>
): WorkModeBreakdown {
  let exploration = 0;
  let building = 0;
  let testing = 0;
  let other = 0;
  let total = 0;

  for (const t of turns) {
    if (!t.category) continue;
    total++;
    const mode = categoryToWorkMode(t.category as CategoryType);
    if (mode === "exploration") exploration++;
    else if (mode === "building") building++;
    else if (mode === "testing") testing++;
    else other++;
  }

  if (total === 0) {
    return { exploration: 0, building: 0, testing: 0, other: 0 };
  }

  return {
    exploration: Math.round((exploration / total) * 100),
    building: Math.round((building / total) * 100),
    testing: Math.round((testing / total) * 100),
    other: Math.round((other / total) * 100),
  };
}
