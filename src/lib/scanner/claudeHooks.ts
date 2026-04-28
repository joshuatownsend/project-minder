import { promises as fs } from "fs";
import path from "path";
import { HookCommand, HookEntry, HookSource, HooksInfo } from "../types";
import { tryParseJsonc } from "./util/jsonc";

/**
 * Reads `.claude/settings.json` and `.claude/settings.local.json` and
 * extracts hook entries (PreToolUse, PostToolUse, SessionStart, etc.).
 * Each entry retains its source file path so a future template-builder
 * can copy units across projects.
 */
export async function scanClaudeHooks(
  projectPath: string
): Promise<HooksInfo | undefined> {
  const sources: { file: string; source: HookSource }[] = [
    { file: ".claude/settings.json",       source: "project" },
    { file: ".claude/settings.local.json", source: "local"   },
  ];

  const entries: HookEntry[] = [];

  for (const { file, source } of sources) {
    const absolute = path.join(projectPath, file);
    try {
      const raw = await fs.readFile(absolute, "utf-8");
      const doc = tryParseJsonc<Record<string, unknown>>(raw);
      if (!doc || typeof doc !== "object") continue;

      const hooks = (doc as { hooks?: unknown }).hooks;
      entries.push(...extractHookEntries(hooks, source, absolute));
    } catch {
      // File doesn't exist or couldn't be read — skip silently.
    }
  }

  if (entries.length === 0) return undefined;
  return { entries };
}

export function extractHookEntries(
  hooks: unknown,
  source: HookSource,
  sourcePath: string
): HookEntry[] {
  const out: HookEntry[] = [];
  if (!hooks || typeof hooks !== "object") return out;

  for (const [event, group] of Object.entries(hooks as Record<string, unknown>)) {
    if (!Array.isArray(group)) continue;

    for (const entry of group) {
      if (!entry || typeof entry !== "object") continue;
      const e = entry as { matcher?: unknown; hooks?: unknown };

      const matcher = typeof e.matcher === "string" ? e.matcher : undefined;
      const commands = normalizeCommands(e.hooks);
      if (commands.length === 0) continue;

      out.push({ event, matcher, commands, source, sourcePath });
    }
  }

  return out;
}

function normalizeCommands(value: unknown): HookCommand[] {
  if (!Array.isArray(value)) return [];
  const out: HookCommand[] = [];

  for (const cmd of value) {
    if (!cmd || typeof cmd !== "object") continue;
    const c = cmd as { type?: unknown; command?: unknown; timeout?: unknown };
    if (typeof c.command !== "string" || c.command.length === 0) continue;
    out.push({
      type: "command",
      command: c.command,
      timeout: typeof c.timeout === "number" ? c.timeout : undefined,
    });
  }

  return out;
}
