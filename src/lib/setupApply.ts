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

// Sentinel strings that identify each block in an existing CLAUDE.md
const TODO_SENTINEL = "## TODO";
const MANUAL_STEPS_SENTINEL = "## Manual Step Logging";

// Command strings used to detect already-present hook entries
const HOOK_COMMANDS = [
  `validate-todo-format.mjs`,
  `validate-manual-steps.mjs`,
] as const;

export async function applySetup(
  projectPath: string,
  action: ApplyAction
): Promise<ApplyResult> {
  const result: ApplyResult = {};

  if (action === "claude-md" || action === "both") {
    result.claudeMd = await applyClaudeMd(projectPath);
  }

  if (action === "hooks" || action === "both") {
    result.hooks = await applyHooks(projectPath);
  }

  return result;
}

/** Copies a file to <filePath>.minder-bak if the source exists. */
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

  const todoPresent = existing.includes(TODO_SENTINEL);
  const manualStepsPresent = existing.includes(MANUAL_STEPS_SENTINEL);

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
    await fs.writeFile(claudeMdPath, content, "utf-8");
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

async function writeScriptIdempotent(
  filePath: string,
  content: string
): Promise<ApplyStatus> {
  try {
    const existing = await fs.readFile(filePath, "utf-8");
    if (existing.trim() === content.trim()) return "already-present";
  } catch {
    // File doesn't exist — write it
  }
  await fs.writeFile(filePath, content, "utf-8");
  return "applied";
}

interface HookCommand {
  type: string;
  command: string;
}

interface PreToolUseEntry {
  matcher: string;
  hooks: HookCommand[];
}

interface SettingsJson {
  hooks?: {
    PreToolUse?: PreToolUseEntry[];
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

async function mergeSettingsJson(settingsPath: string): Promise<ApplyStatus> {
  // Parse the desired hook entry from the snippet constant
  const snippetParsed = JSON.parse(HOOKS_SETTINGS_SNIPPET) as SettingsJson;
  const desiredEntry = snippetParsed.hooks?.PreToolUse?.[0];
  if (!desiredEntry) return "already-present"; // shouldn't happen

  // Read existing settings (or start fresh)
  let settings: SettingsJson = {};
  try {
    const raw = await fs.readFile(settingsPath, "utf-8");
    settings = JSON.parse(raw) as SettingsJson;
  } catch {
    // File doesn't exist or isn't valid JSON — start fresh
  }

  // Check if our hook commands are already present anywhere in PreToolUse
  const existingEntries: PreToolUseEntry[] = settings.hooks?.PreToolUse ?? [];
  const existingCommands = new Set(
    existingEntries.flatMap((e) => e.hooks.map((h) => h.command))
  );
  const allPresent = HOOK_COMMANDS.every((sig) =>
    [...existingCommands].some((cmd) => cmd.includes(sig))
  );

  if (allPresent) return "already-present";

  // Back up before modifying
  await backupFile(settingsPath);

  // Append our entry
  if (!settings.hooks) settings.hooks = {};
  if (!Array.isArray(settings.hooks.PreToolUse)) settings.hooks.PreToolUse = [];
  settings.hooks.PreToolUse.push(desiredEntry);

  await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2), "utf-8");
  return "applied";
}
