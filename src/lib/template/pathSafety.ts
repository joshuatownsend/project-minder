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
