import { TodoItem, ManualStepEntry, InsightEntry } from "./types";

export function diffTodos(parentItems: TodoItem[], worktreeItems: TodoItem[]): string[] {
  const parentTexts = new Set(parentItems.map((i) => i.text));
  return worktreeItems.filter((i) => !parentTexts.has(i.text)).map((i) => i.text);
}

export function diffManualSteps(parentEntries: ManualStepEntry[], worktreeEntries: ManualStepEntry[]): ManualStepEntry[] {
  const key = (e: ManualStepEntry) => `${e.date}|${e.featureSlug}|${e.title}`;
  const parentKeys = new Set(parentEntries.map(key));
  return worktreeEntries.filter((e) => !parentKeys.has(key(e)));
}

export function diffInsights(parentIds: Set<string>, worktreeEntries: InsightEntry[]): InsightEntry[] {
  return worktreeEntries.filter((e) => !parentIds.has(e.id));
}
