/**
 * Logic for auto-applying Project Minder setup to a managed project.
 * Handles CLAUDE.md instruction appending and hooks scaffolding,
 * both idempotently — safe to run multiple times.
 */

import { promises as fs } from "fs";
import path from "path";
import {
  CLAUDE_MD_TODO_BLOCK,
  CLAUDE_MD_MANUAL_STEPS_BLOCK,
  HOOKS_SETTINGS_SNIPPET,
  HOOKS_VALIDATE_TODO,
  HOOKS_VALIDATE_MANUAL_STEPS,
} from "./setup-content";
import { writeFileAtomic } from "./atomicWrite";

export type ApplyAction = "claude-md" | "hooks" | "both";
export type ApplyStatus = "applied" | "already-present";

export interface ClaudeMdResult {
  todo: ApplyStatus;
  manualSteps: ApplyStatus;
}

export interface HooksResult {
  settingsJson: ApplyStatus;
  validateTodo: ApplyStatus;
  validateManualSteps: ApplyStatus;
}

export interface ApplyResult {
  claudeMd?: ClaudeMdResult;
  hooks?: HooksResult;
}

const TODO_SENTINEL = /^## TODO\s*$/m;
const MANUAL_STEPS_SENTINEL = /^## Manual Step Logging\s*$/m;

const HOOK_COMMANDS = [
  "validate-todo-format.mjs",
  "validate-manual-steps.mjs",
] as const;

// Parse once at module load — HOOKS_SETTINGS_SNIPPET never changes
interface HookCommand {
  type: string;
  command: string;
}
interface PreToolUseEntry {
  matcher: string;
  hooks: HookCommand[];
}
interface SettingsShape {
  hooks?: {
    PreToolUse?: PreToolUseEntry[];
    [key: string]: unknown;
  };
  [key: string]: unknown;
}
const DESIRED_HOOK_ENTRY = (JSON.parse(HOOKS_SETTINGS_SNIPPET) as SettingsShape).hooks
  ?.PreToolUse?.[0];

export async function applySetup(
  projectPath: string,
  action: ApplyAction
): Promise<ApplyResult> {
  const result: ApplyResult = {};
  if (action === "claude-md" || action === "both") result.claudeMd = await applyClaudeMd(projectPath);
  if (action === "hooks" || action === "both") result.hooks = await applyHooks(projectPath);
  return result;
}

async function backupFile(filePath: string): Promise<void> {
  try {
    await fs.copyFile(filePath, `${filePath}.minder-bak`);
  } catch {
    // Source doesn't exist — nothing to back up
  }
}

// ─── CLAUDE.md ────────────────────────────────────────────────────────────────

async function applyClaudeMd(projectPath: string): Promise<ClaudeMdResult> {
  const claudeMdPath = path.join(projectPath, "CLAUDE.md");

  let existing = "";
  let fileExists = false;
  try {
    existing = await fs.readFile(claudeMdPath, "utf-8");
    fileExists = true;
  } catch {
    // File doesn't exist — will be created
  }

  const todoPresent = TODO_SENTINEL.test(existing);
  const manualStepsPresent = MANUAL_STEPS_SENTINEL.test(existing);

  const blocksToAdd: string[] = [];
  if (!todoPresent) blocksToAdd.push(CLAUDE_MD_TODO_BLOCK);
  if (!manualStepsPresent) blocksToAdd.push(CLAUDE_MD_MANUAL_STEPS_BLOCK);

  if (blocksToAdd.length > 0) {
    let content: string;
    if (!fileExists) {
      content = "# CLAUDE.md\n\n" + blocksToAdd.join("\n\n");
    } else {
      await backupFile(claudeMdPath);
      content = existing.trimEnd() + "\n\n" + blocksToAdd.join("\n\n");
    }
    await writeFileAtomic(claudeMdPath, content);
  }

  return {
    todo: todoPresent ? "already-present" : "applied",
    manualSteps: manualStepsPresent ? "already-present" : "applied",
  };
}

// ─── Hooks ────────────────────────────────────────────────────────────────────

async function applyHooks(projectPath: string): Promise<HooksResult> {
  const hooksDirPath = path.join(projectPath, ".claude", "hooks");
  const settingsPath = path.join(projectPath, ".claude", "settings.local.json");
  const validateTodoPath = path.join(hooksDirPath, "validate-todo-format.mjs");
  const validateManualStepsPath = path.join(hooksDirPath, "validate-manual-steps.mjs");

  await fs.mkdir(hooksDirPath, { recursive: true });

  const [settingsJson, validateTodo, validateManualSteps] = await Promise.all([
    mergeSettingsJson(settingsPath),
    writeScriptIdempotent(validateTodoPath, HOOKS_VALIDATE_TODO),
    writeScriptIdempotent(validateManualStepsPath, HOOKS_VALIDATE_MANUAL_STEPS),
  ]);

  return { settingsJson, validateTodo, validateManualSteps };
}

async function writeScriptIdempotent(filePath: string, content: string): Promise<ApplyStatus> {
  try {
    const existing = await fs.readFile(filePath, "utf-8");
    if (existing.trim() === content.trim()) return "already-present";
    await backupFile(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    // File doesn't exist — write it fresh
  }
  await writeFileAtomic(filePath, content);
  return "applied";
}

async function mergeSettingsJson(settingsPath: string): Promise<ApplyStatus> {
  if (!DESIRED_HOOK_ENTRY) return "already-present";

  let settings: SettingsShape = {};
  try {
    const raw = await fs.readFile(settingsPath, "utf-8");
    try {
      settings = JSON.parse(raw) as SettingsShape;
    } catch {
      throw new Error(`${settingsPath} contains invalid JSON — fix it manually or delete it before retrying.`);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    // File doesn't exist — start fresh
  }

  const existingEntries = Array.isArray(settings.hooks?.PreToolUse)
    ? (settings.hooks.PreToolUse as unknown[]).filter(
        (e): e is PreToolUseEntry =>
          e != null && typeof e === "object" && Array.isArray((e as PreToolUseEntry).hooks)
      )
    : [];
  const existingCommands = existingEntries.flatMap((e) =>
    e.hooks
      .filter((h): h is HookCommand => h != null && typeof h === "object" && typeof h.command === "string")
      .map((h) => h.command)
  );

  const missingCommands = HOOK_COMMANDS.filter(
    (sig) => !existingCommands.some((cmd) => cmd.includes(sig))
  );
  if (missingCommands.length === 0) return "already-present";

  await backupFile(settingsPath);

  // Only push hooks that aren't already present — avoids duplicate validators
  const missingHooks = DESIRED_HOOK_ENTRY.hooks.filter((h) =>
    missingCommands.some((sig) => h.command.includes(sig))
  );

  if (!settings.hooks) settings.hooks = {};
  if (!Array.isArray(settings.hooks.PreToolUse)) settings.hooks.PreToolUse = [];
  settings.hooks.PreToolUse.push({ ...DESIRED_HOOK_ENTRY, hooks: missingHooks });

  await writeFileAtomic(settingsPath, JSON.stringify(settings, null, 2));
  return "applied";
}
