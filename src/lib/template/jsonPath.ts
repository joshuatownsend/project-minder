/**
 * Tiny dotted-path JSON walkers. Used by `applySettings` to read + write
 * specific keys inside `.claude/settings.json` without overwriting the rest.
 *
 * Path syntax:
 *   - `permissions.allow`   → walks `doc.permissions.allow`
 *   - `env.MY_VAR`          → walks `doc.env.MY_VAR`
 *   - `statusLine`          → top-level `doc.statusLine`
 *   - empty string          → the document itself
 *
 * Bracket / array-index notation is intentionally NOT supported — settings
 * keys are object paths, and supporting array indexing would let templates
 * splice into existing arrays in surprising ways. Whole-array replacement
 * goes through the conflict policy at the parent key.
 */

export type JsonPath = string;

export function parsePath(path: JsonPath): string[] {
  if (path === "") return [];
  return path.split(".");
}

/** Returns `{ found: true, value }` or `{ found: false }`. Distinguishes
 *  "key absent" from "key present with value undefined" — important for the
 *  apply layer's "source has nothing to copy" path. */
export function getJsonPath(
  doc: unknown,
  path: JsonPath
): { found: true; value: unknown } | { found: false } {
  const segments = parsePath(path);
  let curr: unknown = doc;
  for (const seg of segments) {
    if (curr === null || typeof curr !== "object" || Array.isArray(curr)) {
      return { found: false };
    }
    if (!Object.prototype.hasOwnProperty.call(curr, seg)) {
      return { found: false };
    }
    curr = (curr as Record<string, unknown>)[seg];
  }
  return { found: true, value: curr };
}

/** Functional set: returns a new doc with the value written at `path`,
 *  creating intermediate objects as needed. The original `doc` is not mutated.
 *
 *  If an intermediate node already exists and is non-object, throws — the
 *  caller has a bug (asked to write `permissions.allow` when `permissions` is
 *  a string, say). The apply layer turns this into a structured error. */
export function setJsonPath(doc: unknown, path: JsonPath, value: unknown): unknown {
  const segments = parsePath(path);
  if (segments.length === 0) return value;

  // Always start from a plain object root. If doc was something else (null,
  // array, scalar) we replace with a fresh object — settings docs are objects
  // by contract.
  const rootIsObject = doc !== null && typeof doc === "object" && !Array.isArray(doc);
  const next: Record<string, unknown> = rootIsObject ? { ...(doc as Record<string, unknown>) } : {};

  let cursor: Record<string, unknown> = next;
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i];
    const child = cursor[seg];
    if (child === undefined || child === null) {
      cursor[seg] = {};
    } else if (typeof child !== "object" || Array.isArray(child)) {
      throw new JsonPathError(
        "PATH_NON_OBJECT_INTERMEDIATE",
        `Intermediate "${segments.slice(0, i + 1).join(".")}" exists but is not a plain object.`
      );
    } else {
      cursor[seg] = { ...(child as Record<string, unknown>) };
    }
    cursor = cursor[seg] as Record<string, unknown>;
  }
  cursor[segments[segments.length - 1]] = value;
  return next;
}

export class JsonPathError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "JsonPathError";
  }
}

/** Paths whose array values should *concat-and-dedupe* (rather than replace)
 *  on `merge`. Anchored at `permissions.*` because those entries are pattern
 *  strings that should be additive across project + template. Other arrays
 *  (e.g. `cleanupPeriodDays` lists, custom keys) replace by default —
 *  authors who want concat semantics for their own arrays can use `overwrite`
 *  + manually combine. */
const CONCAT_DEDUPE_PATHS: ReadonlySet<string> = new Set([
  "permissions.allow",
  "permissions.ask",
  "permissions.deny",
]);

export function isConcatDedupePath(path: JsonPath): boolean {
  return CONCAT_DEDUPE_PATHS.has(path);
}

/** Top-level keys reserved for dedicated unit kinds. The settingsKey UI
 *  excludes these so users don't accidentally shadow the specialized apply
 *  paths. (The apply layer doesn't reject these — a user who really wants to
 *  template the whole `hooks` blob via settingsKey can do it via API; the UI
 *  just steers them away from the footgun.) */
export const RESERVED_SETTINGS_KEYS: ReadonlySet<string> = new Set([
  "hooks",
  "mcpServers",
  "enabledPlugins",
]);
