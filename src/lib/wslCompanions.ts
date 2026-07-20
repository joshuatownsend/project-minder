/**
 * The settings a WSL scan root needs in order to be *useful*, derived from the
 * root path itself.
 *
 * Adding a `\\wsl.localhost\<distro>\home\<user>\…` scan root makes its projects
 * appear on the dashboard, but on its own that is only half a setup. Two further
 * settings decide whether any Claude data ever joins to those projects:
 *
 *   - `claudeHomes` — sessions recorded inside the distro live in that distro's
 *     `~/.claude`, which is a different Claude home. Without it those JSONL files
 *     are never read at all.
 *   - `pathMappings` — the distro recorded them under Linux paths
 *     (`/home/josh/dev/foo`) while the scanner sees `\\wsl.localhost\…`. Without
 *     the mapping, `mapLocalPath` is the identity function and the two views of
 *     the same directory can never be matched.
 *
 * Miss either and the failure is silent: projects scan, and every session, cost,
 * insight and catalog entry attached to them quietly reads as zero. Measured on
 * one real setup, 97% of a project's session data was invisible this way.
 *
 * Deriving from the root (rather than only from what `Detect WSL` suggested)
 * means a hand-typed root gets the same treatment as a discovered one — which
 * matters, because the roots most likely to be typed by hand are the ones that
 * don't sit at the conventional `~/dev`.
 */

import type { PathMapping } from "./types";
import { parseWslUncPath } from "./wsl";
import { normalizePathKey } from "./platform";

/** Settings implied by a single WSL scan root. */
export interface WslCompanions {
  /** The distro user's Claude home, or null when the root isn't under /home. */
  claudeHome: string | null;
  /** Prefix rewrite between the distro's Linux paths and this machine's UNC view. */
  pathMapping: PathMapping;
}

/** Split a WSL UNC path into its host alias, distro, and remaining segments. */
function splitWslRoot(
  root: string
): { host: string; distro: string; segments: string[] } | null {
  const trimmed = root.trim();
  const parsed = parseWslUncPath(trimmed);
  if (!parsed) return null;
  // Preserve whichever alias the user wrote. `mapLocalPath` folds `wsl$` and
  // `wsl.localhost` together, but `mapForeignPath` does NOT — it concatenates
  // `to` verbatim — so emitting a different alias than the scan root uses would
  // produce mapped paths that no scanned project matches.
  const hostMatch = /^[\\/]{2}(wsl\.localhost|wsl\$)/i.exec(trimmed);
  const host = hostMatch ? hostMatch[1] : "wsl.localhost";
  const rest = trimmed.replace(/^[\\/]{2}(?:wsl\.localhost|wsl\$)[\\/][^\\/]+/i, "");
  return { host, distro: parsed.distro, segments: rest.split(/[\\/]+/).filter(Boolean) };
}

/**
 * The `claudeHomes` / `pathMappings` entries a scan root implies, or null when
 * the root is not a WSL path (or is the bare distro root, which yields a `/`
 * prefix that the mapping layer discards as empty).
 *
 * Mappings are cut at the *user home* rather than at the specific project
 * directory, so one entry covers every present and future repo under that home
 * — including the ones nested well below the scan root.
 */
export function deriveWslCompanions(root: string): WslCompanions | null {
  const parts = splitWslRoot(root);
  if (!parts || parts.segments.length === 0) return null;

  const { host, distro, segments } = parts;
  const base = `\\\\${host}\\${distro}`;

  if (segments[0].toLowerCase() === "home" && segments.length >= 2) {
    const user = segments[1];
    const to = `${base}\\home\\${user}`;
    return { claudeHome: `${to}\\.claude`, pathMapping: { from: `/home/${user}`, to } };
  }

  // Outside /home (e.g. \\wsl.localhost\Ubuntu\opt\src) the user's home can't be
  // inferred, so only the prefix mapping is derivable.
  const top = segments[0];
  return { claudeHome: null, pathMapping: { from: `/${top}`, to: `${base}\\${top}` } };
}

/** Case- and alias-insensitive identity for a filesystem path. */
function homeKey(p: string): string {
  return normalizePathKey(p.trim());
}

/**
 * Merge the companions implied by `roots` into existing config values.
 *
 * Existing entries always win: a `from` prefix the user has already mapped is
 * left exactly as they set it, since a hand-tuned mapping (a different distro,
 * a bind mount, a renamed home) is more authoritative than anything derivable
 * from a path. This function only ever *adds*.
 */
export function mergeWslCompanions(
  roots: string[],
  existing: { claudeHomes?: string[]; pathMappings?: PathMapping[] } = {}
): { claudeHomes: string[]; pathMappings: PathMapping[]; added: number } {
  const claudeHomes = [...(existing.claudeHomes ?? [])];
  const pathMappings = [...(existing.pathMappings ?? [])];
  const seenHomes = new Set(claudeHomes.map(homeKey));
  const seenFrom = new Set(pathMappings.map((m) => m.from.trim().replace(/\/+$/, "")));
  let added = 0;

  for (const root of roots) {
    const companions = deriveWslCompanions(root);
    if (!companions) continue;

    const from = companions.pathMapping.from;
    if (!seenFrom.has(from)) {
      seenFrom.add(from);
      pathMappings.push(companions.pathMapping);
      added++;
    }
    if (companions.claudeHome && !seenHomes.has(homeKey(companions.claudeHome))) {
      seenHomes.add(homeKey(companions.claudeHome));
      claudeHomes.push(companions.claudeHome);
      added++;
    }
  }

  return { claudeHomes, pathMappings, added };
}

/**
 * WSL roots that are missing at least one companion setting — i.e. roots whose
 * projects scan but whose Claude data cannot join.
 *
 * Drives the Settings warning for setups configured before this was wired up,
 * who otherwise have no way to discover that their WSL costs read as zero.
 */
export function findUnmappedWslRoots(config: {
  devRoots?: string[];
  devRoot?: string;
  claudeHomes?: string[];
  pathMappings?: PathMapping[];
}): string[] {
  const roots =
    config.devRoots && config.devRoots.length > 0
      ? config.devRoots
      : config.devRoot
        ? [config.devRoot]
        : [];

  const seenHomes = new Set((config.claudeHomes ?? []).map(homeKey));
  const seenFrom = new Set(
    (config.pathMappings ?? []).map((m) => m.from.trim().replace(/\/+$/, ""))
  );

  return roots.filter((root) => {
    const companions = deriveWslCompanions(root);
    if (!companions) return false;
    if (!seenFrom.has(companions.pathMapping.from)) return true;
    return Boolean(companions.claudeHome) && !seenHomes.has(homeKey(companions.claudeHome!));
  });
}
