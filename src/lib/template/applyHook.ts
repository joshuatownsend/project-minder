import { promises as fs } from "fs";
import path from "path";
import {
  ApplyResult,
  ConflictPolicy,
  HookEntry,
} from "../types";
import { tryParseJsonc } from "../scanner/util/jsonc";
import {
  atomicWriteFile,
  ensureDir,
  fileExists,
  withFileLock,
} from "./atomicFs";
import { makeHookKey } from "./unitKey";

interface ApplyHookArgs {
  /** Single-command HookEntry (callers pre-explode multi-command entries). */
  entry: HookEntry;
  /** Where hook script files live in the source.
   *  Project: `<projectPath>/.claude/hooks`. User: `~/.claude/hooks`. */
  sourceHooksDir: string;
  /** Literal path to refuse in invocations (would silently break in target).
   *  Project: `<projectPath>`. User: `~/.claude`. The existing project-case rule
   *  rejects any reference into the source project, not just into `.claude/`,
   *  which is why this is a separate param from `sourceHooksDir`. */
  sourceRootForRejection: string;
  targetProjectPath: string;
  conflict: ConflictPolicy;
  dryRun?: boolean;
}

/**
 * Merge a single hook into the target's `.claude/settings.json`.
 *
 *  - Always writes to `settings.json` (project-shared), never `settings.local.json`.
 *    `local` and `user` sources auto-promote; the warning surfaces this to the UI.
 *  - Identity = `event + matcher + sha256(invocation)` so re-applying is idempotent.
 *  - Referenced hook scripts (`.claude/hooks/<name>` or `$CLAUDE_PROJECT_DIR/...`)
 *    are copied from `sourceHooksDir`. Literal absolute paths into the source
 *    root (`sourceRootForRejection`) are rejected.
 */
export async function applyHook(args: ApplyHookArgs): Promise<ApplyResult> {
  const { entry, sourceHooksDir, sourceRootForRejection, targetProjectPath, conflict, dryRun } = args;

  if (entry.commands.length !== 1) {
    return errorResult(
      "MULTI_COMMAND_ENTRY",
      "applyHook expects a single-invocation HookEntry. Pre-explode multi-invocation entries first."
    );
  }
  const invocation = entry.commands[0];

  const targetSettingsPath = path.join(targetProjectPath, ".claude", "settings.json");
  const warnings: string[] = [];
  if (entry.source === "local") {
    warnings.push("local-scope source promoted to project-shared (settings.json)");
  }
  if (entry.source === "user") {
    warnings.push("user-scope source promoted to project-shared (settings.json) — will apply to anyone using this repo");
  }

  // Reject literal absolute paths into the source root (would silently break in target).
  const projPathCheck = checkSourceRootPath(invocation.command, sourceRootForRejection);
  if (projPathCheck) {
    return errorResult("PROJECT_PATH_IN_SOURCE", projPathCheck);
  }

  // Resolve referenced hook scripts from the source's hooks dir.
  const scriptRefs = extractHookScriptRefs(invocation.command);
  const scriptCopies: { from: string; to: string }[] = [];
  for (const ref of scriptRefs) {
    const from = path.join(sourceHooksDir, ref);
    if (!(await fileExists(from))) continue;
    const to = path.join(targetProjectPath, ".claude", "hooks", ref);
    scriptCopies.push({ from, to });
  }

  return withFileLock(targetSettingsPath, async () => {
    let doc: Record<string, unknown> = {};
    if (await fileExists(targetSettingsPath)) {
      try {
        const raw = await fs.readFile(targetSettingsPath, "utf-8");
        if (raw.trim().length > 0) {
          const parsed = tryParseJsonc<Record<string, unknown>>(raw);
          if (parsed === null) {
            return errorResult(
              "MALFORMED_TARGET",
              `Target ${targetSettingsPath} is not valid JSON. Refusing to overwrite.`
            );
          }
          doc = parsed ?? {};
        }
      } catch (e) {
        return errorResult(
          "TARGET_READ_FAILED",
          `Could not read ${targetSettingsPath}: ${(e as Error).message}`
        );
      }
    }

    const hooksObj = (doc.hooks as Record<string, unknown> | undefined) ?? {};
    const eventArr = ensureArray(hooksObj[entry.event]);
    const targetKey = makeHookKey(entry.event, entry.matcher, invocation.command);

    let matcherGroup = eventArr.find(
      (g) =>
        typeof g === "object" &&
        g !== null &&
        (g as { matcher?: unknown }).matcher === entry.matcher
    ) as Record<string, unknown> | undefined;

    let existed = false;
    if (matcherGroup) {
      const existingHooks = ensureArray(matcherGroup.hooks);
      existed = existingHooks.some(
        (h) =>
          typeof h === "object" &&
          h !== null &&
          (h as { command?: unknown }).command === invocation.command
      );
    }

    if (existed && conflict === "skip") {
      return { ok: true, status: "skipped" as const, changedFiles: [], warnings };
    }
    if (existed && conflict === "rename") {
      return errorResult(
        "RENAME_NOT_SUPPORTED_FOR_HOOK",
        "Hook units cannot be renamed; use skip, overwrite, or merge."
      );
    }

    const newInvocation: Record<string, unknown> = {
      type: invocation.type,
      command: invocation.command,
    };
    if (typeof invocation.timeout === "number") newInvocation.timeout = invocation.timeout;

    const newEventArr = [...eventArr];
    if (matcherGroup) {
      const idx = newEventArr.indexOf(matcherGroup);
      const existingHooks = ensureArray(matcherGroup.hooks);
      let newHooks: unknown[];
      if (existed && conflict === "overwrite") {
        newHooks = existingHooks.map((h) =>
          typeof h === "object" &&
          h !== null &&
          (h as { command?: unknown }).command === invocation.command
            ? newInvocation
            : h
        );
      } else if (existed && conflict === "merge") {
        newHooks = existingHooks;
      } else {
        newHooks = [...existingHooks, newInvocation];
      }
      newEventArr[idx] = { ...matcherGroup, hooks: newHooks };
    } else {
      const newGroup: Record<string, unknown> = entry.matcher
        ? { matcher: entry.matcher, hooks: [newInvocation] }
        : { hooks: [newInvocation] };
      newEventArr.push(newGroup);
    }

    const newDoc = {
      ...doc,
      hooks: { ...hooksObj, [entry.event]: newEventArr },
    };

    const serialized = JSON.stringify(newDoc, null, 2) + "\n";
    const changedFiles = [targetSettingsPath, ...scriptCopies.map((c) => c.to)];

    if (dryRun) {
      const action = existed
        ? conflict === "overwrite"
          ? "[overwrite hook]"
          : "[no change — already present]"
        : "[append hook]";
      const preview =
        `${action} key=${targetKey}\n` +
        `event: ${entry.event}\n` +
        `matcher: ${entry.matcher ?? "(none)"}\n` +
        `invocation: ${invocation.command}\n` +
        (scriptCopies.length > 0
          ? `referenced scripts: ${scriptCopies.map((s) => path.basename(s.to)).join(", ")}\n`
          : "");
      return {
        ok: true,
        status: "would-apply" as const,
        changedFiles,
        diffPreview: preview,
        warnings,
      };
    }

    await ensureDir(path.dirname(targetSettingsPath));
    await atomicWriteFile(targetSettingsPath, serialized);

    for (const c of scriptCopies) {
      await ensureDir(path.dirname(c.to));
      // fs.copyFile preserves the source's mode bits. readFile + atomicWriteFile
      // would silently strip the executable bit on `.sh` scripts, breaking any
      // command like `bash ./.claude/hooks/foo.sh` at the target.
      await fs.copyFile(c.from, c.to);
    }

    const status = existed && conflict === "merge" ? "merged" : "applied";
    return { ok: true, status, changedFiles, warnings };
  });
}

/** Returns an error message if the invocation literally references the source
 * filesystem path — those references will silently break in the target.
 * `sourceRoot` is the project path for project-source hooks, or `~/.claude`
 * for user-source hooks. Otherwise returns null.
 */
export function checkSourceRootPath(invocation: string, sourceRoot: string): string | null {
  const norm = (s: string) => s.replace(/\\/g, "/").toLowerCase();
  const cmdN = norm(invocation);
  const srcN = norm(path.resolve(sourceRoot));
  if (cmdN.includes(srcN)) {
    return (
      `Invocation contains an absolute path into the source ("${sourceRoot}"). ` +
      `Rewrite to use a relative path or $CLAUDE_PROJECT_DIR before applying.`
    );
  }
  return null;
}

/** Pulls referenced hook script *names* (relative to `.claude/hooks/`) out of an invocation string.
 * Recognizes `.claude/hooks/<file>` and `$CLAUDE_PROJECT_DIR/.claude/hooks/<file>`.
 */
export function extractHookScriptRefs(invocation: string): string[] {
  const refs = new Set<string>();
  const patterns = [
    /\.claude[\\/]hooks[\\/]([\w.\-]+)/g,
    /\$\{?CLAUDE_PROJECT_DIR\}?[\\/]\.claude[\\/]hooks[\\/]([\w.\-]+)/g,
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(invocation)) !== null) {
      refs.add(m[1]);
    }
  }
  return [...refs];
}

function ensureArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function errorResult(code: string, message: string): ApplyResult {
  return { ok: false, status: "error", changedFiles: [], error: { code, message } };
}
