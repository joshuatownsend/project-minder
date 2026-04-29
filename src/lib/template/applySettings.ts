import { promises as fs } from "fs";
import path from "path";
import { ApplyResult, ConflictPolicy } from "../types";
import { tryParseJsonc } from "../scanner/util/jsonc";
import {
  atomicWriteFile,
  ensureDir,
  withFileLock,
} from "./atomicFs";
import {
  getJsonPath,
  isConcatDedupePath,
  JsonPathError,
  setJsonPath,
} from "./jsonPath";

interface ApplySettingsArgs {
  /** Dotted path inside `.claude/settings.json` — e.g. "permissions.allow",
   *  "env.MY_VAR", "statusLine". */
  settingsPath: string;
  /** Absolute path to the source settings file. For project source:
   *  `<projectPath>/.claude/settings.json`. For user source:
   *  `~/.claude/settings.json`. */
  sourceSettingsFile: string;
  targetProjectPath: string;
  conflict: ConflictPolicy;
  /** When copied from user-scope, the resulting project-scope settings entry
   *  is broader than the source intent. Surfaced as a warning. */
  sourceScope?: "user" | "project";
  dryRun?: boolean;
}

/**
 * Copies the value at a dotted path in the source project's
 * `.claude/settings.json` into the same path in the target's settings.json,
 * honoring the conflict policy with a deep-merge for object values and
 * concat-and-dedupe for whitelisted array paths (`permissions.allow`/`ask`/`deny`).
 *
 * The "what" of the write depends on the source value:
 *   - Object: deep-merge into target's existing value (or write fresh).
 *   - Array: replace by default; concat-and-dedupe for whitelisted paths.
 *   - Scalar / null: replace.
 *
 * Conflict policies:
 *   - `skip`      — if target already has *any* value at this path, no-op.
 *   - `overwrite` — replace target's value with source's, no merge.
 *   - `merge`     — deep-merge per the rules above. Default.
 *   - `rename`    — rejected; settings keys aren't renameable.
 */
export async function applySettings(args: ApplySettingsArgs): Promise<ApplyResult> {
  const {
    settingsPath: keyPath,
    sourceSettingsFile,
    targetProjectPath,
    conflict,
    sourceScope,
    dryRun,
  } = args;

  if (conflict === "rename") {
    return errorResult(
      "RENAME_NOT_SUPPORTED_FOR_SETTINGS",
      "Settings keys cannot be renamed; use skip, overwrite, or merge."
    );
  }
  if (keyPath.length === 0) {
    return errorResult(
      "EMPTY_SETTINGS_PATH",
      "Settings unit key must be a non-empty dotted path (e.g. 'permissions.allow')."
    );
  }

  const sourceSettings = sourceSettingsFile;
  const targetSettings = path.join(targetProjectPath, ".claude", "settings.json");
  const promotionWarnings: string[] =
    sourceScope === "user"
      ? [`user-scope source promoted to project-shared (settings.json) at "${keyPath}" — will apply to anyone using this repo`]
      : [];

  // Read the source value. If absent, there's nothing to copy.
  const sourceValue = await readKey(sourceSettings, keyPath);
  if ("error" in sourceValue) {
    return sourceValue.error;
  }
  if (!sourceValue.found) {
    return errorResult(
      "UNIT_NOT_FOUND",
      `Path "${keyPath}" not found in source ${sourceSettings}.`
    );
  }

  return withFileLock(targetSettings, async () => {
    // Read target settings (or {} if missing).
    let targetDoc: Record<string, unknown> = {};
    let targetHadKey = false;
    // Read target settings. We don't pre-check existence with fs.access:
    // (a) it's a TOCTOU pattern, (b) it doubles the syscalls. Just try to read
    // and treat ENOENT as "no doc yet."
    try {
      const raw = await fs.readFile(targetSettings, "utf-8");
      if (raw.trim().length > 0) {
        const parsed = tryParseJsonc<unknown>(raw);
        if (parsed === null) {
          return errorResult(
            "MALFORMED_TARGET",
            `Target ${targetSettings} is not valid JSON. Refusing to overwrite.`
          );
        }
        // settings.json must have an object at the root. If parse succeeded
        // but yielded an array, scalar, or null, treating it as `{}` would
        // silently overwrite the user's content with our merged doc. Refuse.
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          return errorResult(
            "MALFORMED_TARGET",
            `Target ${targetSettings} must contain a JSON object at the root. Refusing to overwrite.`
          );
        }
        targetDoc = parsed as Record<string, unknown>;
      }
      // Empty-but-existing file: leave targetDoc as {}. Same observable
      // behavior as ENOENT — no key found, apply proceeds as "[add]".
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        return errorResult(
          "TARGET_READ_FAILED",
          `Could not read ${targetSettings}: ${(e as Error).message}`
        );
      }
      // ENOENT → leave targetDoc as {}.
    }
    let targetPeek: ReturnType<typeof getJsonPath>;
    try {
      targetPeek = getJsonPath(targetDoc, keyPath);
    } catch (e) {
      if (e instanceof JsonPathError) {
        return errorResult(e.code, e.message);
      }
      throw e;
    }
    targetHadKey = targetPeek.found;
    const targetCurr = targetPeek.found ? targetPeek.value : undefined;

    // Skip if target has the key and policy is skip.
    if (targetHadKey && conflict === "skip") {
      return { ok: true, status: "skipped", changedFiles: [], warnings: promotionWarnings.length > 0 ? promotionWarnings : undefined };
    }

    // Compute the new value at the key path.
    let newValue: unknown;
    let action: string;
    if (!targetHadKey) {
      newValue = sourceValue.value;
      action = "[add]";
    } else if (conflict === "overwrite") {
      newValue = sourceValue.value;
      action = "[overwrite]";
    } else {
      // merge — mergeValues returns the source verbatim when there's nothing
      // to merge (scalar replace, type mismatch). Detect a true no-op when
      // the recursive merge result is deep-equal to what was already there.
      newValue = mergeValues(targetCurr, sourceValue.value, keyPath);
      if (deepEqual(targetCurr, newValue)) {
        return { ok: true, status: "skipped", changedFiles: [], warnings: promotionWarnings.length > 0 ? promotionWarnings : undefined };
      }
      action = "[merge]";
    }

    // Write back through setJsonPath.
    let nextDoc: Record<string, unknown>;
    try {
      const setResult = setJsonPath(targetDoc, keyPath, newValue);
      nextDoc =
        setResult && typeof setResult === "object" && !Array.isArray(setResult)
          ? (setResult as Record<string, unknown>)
          : {};
    } catch (e) {
      if (e instanceof JsonPathError) {
        return errorResult(e.code, e.message);
      }
      throw e;
    }

    const serialized = JSON.stringify(nextDoc, null, 2) + "\n";

    if (dryRun) {
      const preview =
        `${action} ${keyPath}\n` +
        `  source: ${truncate(JSON.stringify(sourceValue.value), 240)}\n` +
        (targetHadKey
          ? `  target: ${truncate(JSON.stringify(targetCurr), 240)}\n`
          : "  target: (absent)\n") +
        `  new:    ${truncate(JSON.stringify(newValue), 240)}\n`;
      return {
        ok: true,
        status: "would-apply",
        changedFiles: [targetSettings],
        diffPreview: preview,
        warnings: promotionWarnings.length > 0 ? promotionWarnings : undefined,
      };
    }

    await ensureDir(path.dirname(targetSettings));
    await atomicWriteFile(targetSettings, serialized);

    const status = targetHadKey && conflict === "merge" ? "merged" : "applied";
    return { ok: true, status, changedFiles: [targetSettings], warnings: promotionWarnings.length > 0 ? promotionWarnings : undefined };
  });
}

/**
 * Reads a dotted key from a settings.json file. Returns either the resolved
 * value (or `{ found: false }` when absent) or a structured error.
 */
async function readKey(
  filePath: string,
  keyPath: string
): Promise<
  { found: true; value: unknown } | { found: false } | { error: ApplyResult }
> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf-8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      return { found: false };
    }
    return {
      error: errorResult(
        "SOURCE_READ_FAILED",
        `Could not read ${filePath}: ${(e as Error).message}`
      ),
    };
  }
  // Treat an empty-but-existing source file the same as ENOENT — no doc, no
  // keys to copy. `tryParseJsonc("")` returns null which would otherwise be
  // reported as MALFORMED_SOURCE; that's a surprising failure mode for a
  // valid no-content file.
  if (raw.trim().length === 0) {
    return { found: false };
  }
  const parsed = tryParseJsonc<unknown>(raw);
  if (parsed === null) {
    return {
      error: errorResult("MALFORMED_SOURCE", `Source ${filePath} is not valid JSON.`),
    };
  }
  try {
    return getJsonPath(parsed, keyPath);
  } catch (e) {
    if (e instanceof JsonPathError) {
      return { error: errorResult(e.code, e.message) };
    }
    throw e;
  }
}

/**
 * Deep-merge `source` into `target`. Used by `merge` policy.
 *   - both objects: recursively merge keys; source wins on overlap.
 *   - both arrays at a concat-dedupe path: concat-and-dedupe by JSON-equality
 *     of elements.
 *   - both arrays elsewhere: source replaces target.
 *   - type mismatch / scalar / null: source replaces target.
 *
 * @internal Exported for vitest; production callers should go through
 * `applySettings`. Importers outside the apply layer + tests are a smell.
 */
export function mergeValues(target: unknown, source: unknown, keyPath: string): unknown {
  if (target === undefined) return source;
  if (source === undefined) return target;
  if (isPlainObject(target) && isPlainObject(source)) {
    const out: Record<string, unknown> = { ...target };
    for (const [k, v] of Object.entries(source)) {
      // Recurse with a child path so nested concat-dedupe still works
      // (e.g. `permissions.allow` when merging the whole `permissions` object).
      const childPath = keyPath === "" ? k : `${keyPath}.${k}`;
      out[k] = k in out ? mergeValues(out[k], v, childPath) : v;
    }
    return out;
  }
  if (Array.isArray(target) && Array.isArray(source)) {
    if (isConcatDedupePath(keyPath)) {
      const seen = new Set<string>();
      const out: unknown[] = [];
      for (const item of [...target, ...source]) {
        const key = JSON.stringify(item);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(item);
      }
      return out;
    }
    return source;
  }
  // Type mismatch or scalars — source wins.
  return source;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  if (typeof a === "object" && typeof b === "object") {
    const ak = Object.keys(a as object);
    const bk = Object.keys(b as object);
    if (ak.length !== bk.length) return false;
    for (const k of ak) {
      if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
      if (!deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) {
        return false;
      }
    }
    return true;
  }
  return false;
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max) + "…";
}

function errorResult(code: string, message: string): ApplyResult {
  return { ok: false, status: "error", changedFiles: [], error: { code, message } };
}
