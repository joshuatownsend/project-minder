import { promises as fs, realpathSync } from "fs";
import path from "path";
import { MinderConfig } from "../types";
import { getDevRoots } from "../config";

export class PathSafetyError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "PathSafetyError";
  }
}

/**
 * Confirms that `target` resolves to a location inside one of the configured
 * dev roots. Used as the security boundary for every Template Mode write.
 *
 * Returns the canonical absolute path on success; throws `PathSafetyError`
 * with one of:
 *   - PATH_OUTSIDE_DEV_ROOTS — resolves outside every configured root
 *   - PATH_INSIDE_MINDER     — resolves inside `<root>/.minder/...`
 */
export function ensureInsideDevRoots(target: string, config: MinderConfig): string {
  const resolved = path.resolve(target);
  const roots = getDevRoots(config).map((r) => path.resolve(r));

  const owningRoot = roots.find((root) => isInside(resolved, root));
  if (!owningRoot) {
    throw new PathSafetyError(
      "PATH_OUTSIDE_DEV_ROOTS",
      `Target path "${resolved}" is not inside any configured devRoot.`
    );
  }

  // Refuse to write into Minder's own state directory at the root.
  const minderDir = path.join(owningRoot, ".minder");
  if (resolved === minderDir || isInside(resolved, minderDir)) {
    throw new PathSafetyError(
      "PATH_INSIDE_MINDER",
      `Target path "${resolved}" is inside Minder's reserved .minder directory.`
    );
  }

  // The check above is lexical. A symlink or junction in any parent would let the write land elsewhere,
  // so the same two tests are repeated on the canonical locations (#633).
  const canonical = canonicalPath(resolved);
  const canonicalRoot = canonicalPath(owningRoot);
  if (!isInside(canonical, canonicalRoot)) {
    throw new PathSafetyError(
      "PATH_OUTSIDE_DEV_ROOTS",
      `Target path "${resolved}" resolves outside its devRoot through a symlink or junction.`
    );
  }
  const canonicalMinder = canonicalPath(path.join(owningRoot, ".minder"));
  if (canonical === canonicalMinder || isInside(canonical, canonicalMinder)) {
    throw new PathSafetyError(
      "PATH_INSIDE_MINDER",
      `Target path "${resolved}" resolves inside Minder's reserved .minder directory.`
    );
  }

  return resolved;
}

/**
 * True when `child` is `parent` itself or a descendant of it. Uses
 * `path.relative` so trailing-separator and case-sensitivity quirks on
 * Windows don't produce false positives.
 *
 * Subtlety: a raw `rel.startsWith("..")` rejects valid descendants whose
 * first segment happens to begin with `..` (e.g. `<root>/..minderly`
 * yields rel = `"..minderly"`). The escape signal is specifically `..` as
 * its own segment — i.e. the entire rel OR the first segment terminated
 * by a path separator. Match that exactly.
 */
export function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  if (rel === "") return true;
  if (rel === ".." || rel.startsWith(".." + path.sep)) return false;
  if (path.isAbsolute(rel)) return false;
  return true;
}

/**
 * Canonical form of `p` that tolerates a path that does not exist yet: the deepest existing ancestor is
 * resolved through every symlink/junction and the not-yet-created remainder is appended. A lexical
 * `path.resolve` check cannot see a link in a parent directory, so a write that passes it can still land
 * anywhere (#633).
 */
export function canonicalPath(p: string): string {
  const resolved = path.resolve(p);
  const rest: string[] = [];
  let cur = resolved;
  for (;;) {
    try {
      return path.join(realpathSync.native(cur), ...rest.reverse());
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ELOOP") {
        throw new PathSafetyError("PATH_LINK_LOOP", `"${resolved}" passes through a symlink or junction loop.`);
      }
      if (code !== "ENOENT" && code !== "ENOTDIR") throw e;
      const parent = path.dirname(cur);
      if (parent === cur) return resolved;
      rest.push(path.basename(cur));
      cur = parent;
    }
  }
}

/** Throws unless `file` resolves, through every link, to a location inside `root` (#640). */
export function assertContained(file: string, root: string): void {
  if (!isInside(canonicalPath(file), canonicalPath(root))) {
    throw new PathSafetyError(
      "SOURCE_ESCAPES_ROOT",
      `"${file}" resolves outside "${root}" through a symlink or junction; refusing to copy it.`,
    );
  }
}

/** Throws if `dest` is itself a symlink/junction: a copy onto it would write through to wherever it points (#633). */
export async function assertNotLink(dest: string): Promise<void> {
  try {
    if ((await fs.lstat(dest)).isSymbolicLink()) {
      throw new PathSafetyError("DESTINATION_IS_LINK", `Destination "${dest}" is a symlink or junction; refusing to write through it.`);
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
    throw e;
  }
}

/** Project-relative locations that Template Mode reads or writes configuration through. */
const PROJECT_CONFIG_PATHS = [
  ".claude",
  ".github",
  ".mcp.json",
  path.join(".claude", "settings.json"),
  path.join(".claude", "settings.local.json"),
  path.join(".claude", "hooks"),
  path.join(".github", "workflows"),
];

/**
 * Throws if any configuration location of `projectPath` is a link that resolves outside the project. Every
 * unit kind (settings, plugins, MCP, workflows, hooks, files) goes through one of these, so checking them
 * once per apply/snapshot bounds all of them (individual files are re-checked where they are read) (#633, #640).
 */
export function assertProjectConfigContained(projectPath: string): void {
  for (const rel of PROJECT_CONFIG_PATHS) assertContained(path.join(projectPath, rel), projectPath);
}
