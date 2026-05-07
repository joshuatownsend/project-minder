import { promises as fs } from "fs";
import path from "path";
import os from "os";
import { withFileLock, writeFileAtomic } from "@/lib/atomicWrite";
import { recordPreWrite } from "@/lib/configHistory";
import { buildCurlCommand, isManagedCommand } from "./curlCommand";
import { tryParseJsonc } from "@/lib/scanner/util/jsonc";
import type { HookEventName } from "@/lib/types";

const USER_SETTINGS_PATH = path.join(os.homedir(), ".claude", "settings.json");

/** Events we register by default when the user installs Project Minder hooks. */
export const DEFAULT_HOOK_EVENTS: HookEventName[] = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "Notification",
  "Stop",
];

interface HookEntry {
  hooks: Array<{ type: string; command: string; timeout?: number }>;
}

async function readUserSettings(targetPath: string): Promise<Record<string, unknown>> {
  try {
    const raw = await fs.readFile(targetPath, "utf-8");
    const parsed = tryParseJsonc<Record<string, unknown>>(raw);
    if (parsed === null) throw new Error(`${targetPath} is malformed JSON — fix the file before retrying`);
    return parsed;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
}

/**
 * Inspect ~/.claude/settings.json to see which Project Minder-managed hook
 * events are currently registered.
 */
export async function getLiveActivityHookStatus(): Promise<{
  installed: boolean;
  eventsRegistered: HookEventName[];
}> {
  const doc = await readUserSettings(USER_SETTINGS_PATH);
  const hooksObj = (doc.hooks ?? {}) as Record<string, HookEntry[]>;
  const registered: HookEventName[] = [];
  for (const event of DEFAULT_HOOK_EVENTS) {
    const groups = hooksObj[event] ?? [];
    const hasManagedEntry = groups.some((g) => g.hooks?.some((h) => isManagedCommand(h.command ?? "")));
    if (hasManagedEntry) registered.push(event);
  }
  return { installed: registered.length > 0, eventsRegistered: registered };
}

/**
 * Write Project Minder lifecycle hook entries into ~/.claude/settings.json.
 * Idempotent: skips events that already have a managed entry. Atomic write
 * with COW snapshot via configHistory.
 */
export async function installLiveActivityHooks(
  hookUrl: string,
  events: HookEventName[] = DEFAULT_HOOK_EVENTS,
): Promise<void> {
  const command = buildCurlCommand(hookUrl);
  await withFileLock(USER_SETTINGS_PATH, async () => {
    const doc = await readUserSettings(USER_SETTINGS_PATH);
    if (!doc.hooks || typeof doc.hooks !== "object") doc.hooks = {};
    const hooksObj = doc.hooks as Record<string, HookEntry[]>;
    let changed = false;
    for (const event of events) {
      hooksObj[event] ??= [];
      const alreadyManaged = (hooksObj[event] as HookEntry[]).some((g) =>
        g.hooks?.some((h) => isManagedCommand(h.command ?? "")),
      );
      if (alreadyManaged) continue;
      (hooksObj[event] as HookEntry[]).push({ hooks: [{ type: "command", command, timeout: 10 }] });
      changed = true;
    }
    if (!changed) return;
    await recordPreWrite(USER_SETTINGS_PATH, { label: "applyLiveActivity" });
    // Ensure parent directory exists (first-run case where ~/.claude/ exists but settings.json doesn't)
    await fs.mkdir(path.dirname(USER_SETTINGS_PATH), { recursive: true });
    await writeFileAtomic(USER_SETTINGS_PATH, JSON.stringify(doc, null, 2) + "\n");
  });
}

/**
 * Remove all Project Minder-managed hook entries from ~/.claude/settings.json.
 * Leaves any other hook entries untouched. Atomic write with COW snapshot.
 */
export async function removeLiveActivityHooks(): Promise<void> {
  await withFileLock(USER_SETTINGS_PATH, async () => {
    const doc = await readUserSettings(USER_SETTINGS_PATH);
    if (!doc.hooks || typeof doc.hooks !== "object") return;
    const hooksObj = doc.hooks as Record<string, HookEntry[]>;
    let changed = false;
    for (const event of Object.keys(hooksObj)) {
      const groups = hooksObj[event] as HookEntry[];
      const filtered: HookEntry[] = [];
      for (const group of groups) {
        const remaining = (group.hooks ?? []).filter((h) => !isManagedCommand(h.command ?? ""));
        if (remaining.length > 0) {
          filtered.push({ ...group, hooks: remaining });
        }
        if (remaining.length !== (group.hooks ?? []).length) changed = true;
      }
      if (filtered.length === 0) {
        delete hooksObj[event];
      } else {
        hooksObj[event] = filtered;
      }
    }
    if (!changed) return;
    await recordPreWrite(USER_SETTINGS_PATH, { label: "removeLiveActivity" });
    await writeFileAtomic(USER_SETTINGS_PATH, JSON.stringify(doc, null, 2) + "\n");
  });
}
