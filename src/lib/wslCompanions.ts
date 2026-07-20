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

// ---------------------------------------------------------------------------
// This module is imported by a `"use client"` component (the Settings scan-roots
// section), so it must stay free of Node built-ins. It deliberately does NOT
// import `./wsl` or `./platform`: both pull `child_process`/`fs` at module
// scope, and Turbopack fails the whole build with "Module not found: Can't
// resolve 'child_process'" rather than tree-shaking them away. Neither
// `pnpm typecheck` nor the Vitest suite catches that — only `pnpm build` does.
//
// The two helpers below are therefore local copies of the pure parts of those
// modules. `tests/wslCompanions.test.ts` cross-checks them against the
// originals over a shared table of inputs, so the duplication cannot drift
// silently.
// ---------------------------------------------------------------------------

/** Local copy of `wsl.ts`'s WSL_UNC_RE — see the note above. */
const WSL_UNC_RE = /^[\\/]{2}(?:wsl\.localhost|wsl\$)[\\/]([^\\/]+)(?:[\\/]|$)/i;

/** Local copy of `wsl.ts`'s `parseWslUncPath` — see the note above. */
function parseWslUncPath(p: string): { distro: string } | null {
  const m = WSL_UNC_RE.exec(p.trim());
  if (!m) return null;
  const distro = m[1].trim();
  return distro ? { distro } : null;
}

/**
 * Local, always-case-folding equivalent of `platform.ts`'s `normalizePathKey`.
 *
 * Unconditional folding is correct here where the platform version's is
 * conditional: every path this compares is a Windows UNC path reaching a WSL
 * distro, which is case-insensitive regardless of the OS running the code. It
 * also keeps the derivation deterministic in tests on either platform.
 */
function pathKey(p: string): string {
  return p
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/\/wsl\$(?=\/)/i, "//wsl.localhost")
    .replace(/\/+$/, "")
    .toLowerCase();
}

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

/**
 * The mapping implied by a WSL **Claude home** (`…\<user-home>\.claude`), as
 * opposed to a scan root.
 *
 * Kept separate from `deriveWslCompanions` because the two infer the prefix
 * differently, and neither generalizes to the other: a scan root can sit at any
 * depth so its home has to be guessed from the `/home/<user>` convention, while
 * a Claude home names its own directory exactly — whatever contains `.claude`
 * IS the home. That precision is why this isn't just a call into the other one:
 * delegating would map `\\…\Ubuntu\opt\myuser\.claude` to `/opt` instead of
 * `/opt/myuser`, a prefix broad enough to swallow unrelated paths.
 *
 * They do share the UNC parse below, which is the part worth having once (#326).
 *
 * Returns null for non-WSL paths and for anything not ending in `.claude`.
 */
export function deriveWslMappingFromHome(claudeHome: string): PathMapping | null {
  const parts = splitWslRoot(claudeHome);
  if (!parts) return null;

  const { host, distro, segments } = parts;
  if (segments.length < 2) return null; // needs `.claude` plus a home to sit in
  if (segments[segments.length - 1].toLowerCase() !== ".claude") return null;

  const home = segments.slice(0, -1);
  return {
    from: `/${home.join("/")}`,
    to: `\\\\${host}\\${distro}\\${home.join("\\")}`,
  };
}

/** Case- and alias-insensitive identity for a filesystem path. */
function homeKey(p: string): string {
  return pathKey(p);
}

/** A root whose Linux prefix is already mapped somewhere else. */
export interface WslMappingConflict {
  root: string;
  /** The Linux prefix both roots claim, e.g. "/home/josh". */
  from: string;
  /** Where that prefix already points — a different distro's UNC tree. */
  existingTo: string;
}

/** Normalized identity for a mapping's `from` prefix. */
function fromKey(from: string): string {
  return from.trim().replace(/\/+$/, "");
}

/**
 * Merge the companions implied by `roots` into existing config values.
 *
 * Existing entries always win: a `from` prefix the user has already mapped is
 * left exactly as they set it, since a hand-tuned mapping (a bind mount, a
 * renamed home) is more authoritative than anything derivable from a path. This
 * function only ever *adds*.
 *
 * Two distros with the same Linux username (Ubuntu and Debian both under
 * `/home/josh`) derive the same `from` pointing at different UNC trees. That is
 * reported as a **conflict** rather than resolved, because it genuinely cannot
 * be: a Linux path carries no distro, and `mapForeignPath` returns on the first
 * matching prefix — so a second entry for the same `from` would be dead config
 * that makes the setup look fixed while the second distro still reads as zero.
 */
export function mergeWslCompanions(
  roots: string[],
  existing: { claudeHomes?: string[]; pathMappings?: PathMapping[] } = {}
): {
  claudeHomes: string[];
  pathMappings: PathMapping[];
  added: number;
  conflicts: WslMappingConflict[];
} {
  const claudeHomes = [...(existing.claudeHomes ?? [])];
  const pathMappings = [...(existing.pathMappings ?? [])];
  const seenHomes = new Set(claudeHomes.map(homeKey));
  const mappedTo = new Map(pathMappings.map((m) => [fromKey(m.from), m.to]));
  const conflicts: WslMappingConflict[] = [];
  let added = 0;

  for (const root of roots) {
    const companions = deriveWslCompanions(root);
    if (!companions) continue;

    const { from, to } = companions.pathMapping;
    const existingTo = mappedTo.get(fromKey(from));
    if (existingTo === undefined) {
      mappedTo.set(fromKey(from), to);
      pathMappings.push(companions.pathMapping);
      added++;
    } else if (homeKey(existingTo) !== homeKey(to)) {
      conflicts.push({ root, from, existingTo });
      // Deliberately no claudeHome either: adding one without a usable mapping
      // would read the distro's sessions and then fail to match any project.
      continue;
    }

    if (companions.claudeHome && !seenHomes.has(homeKey(companions.claudeHome))) {
      seenHomes.add(homeKey(companions.claudeHome));
      claudeHomes.push(companions.claudeHome);
      added++;
    }
  }

  return { claudeHomes, pathMappings, added, conflicts };
}

/**
 * Classify every configured root by whether its Claude data can actually join.
 *
 * `repairable` roots are missing companions that `mergeWslCompanions` will add.
 * `conflicted` roots cannot be fixed automatically and need the user to decide
 * — surfacing them separately matters because a repair button that silently
 * does nothing is worse than no button.
 *
 * Matching is on the mapping's `to`, not just its `from`: a root whose prefix is
 * mapped to a *different* distro is not configured, however satisfied a
 * `from`-only check would look.
 */
export function analyzeWslRoots(config: {
  devRoots?: string[];
  devRoot?: string;
  claudeHomes?: string[];
  pathMappings?: PathMapping[];
}): { repairable: string[]; conflicted: WslMappingConflict[] } {
  const roots =
    config.devRoots && config.devRoots.length > 0
      ? config.devRoots
      : config.devRoot
        ? [config.devRoot]
        : [];

  const seenHomes = new Set((config.claudeHomes ?? []).map(homeKey));
  const mappedTo = new Map((config.pathMappings ?? []).map((m) => [fromKey(m.from), m.to]));

  const repairable: string[] = [];
  const conflicted: WslMappingConflict[] = [];

  for (const root of roots) {
    const companions = deriveWslCompanions(root);
    if (!companions) continue;

    const { from, to } = companions.pathMapping;
    const existingTo = mappedTo.get(fromKey(from));

    if (existingTo === undefined) {
      repairable.push(root);
      continue;
    }
    if (homeKey(existingTo) !== homeKey(to)) {
      conflicted.push({ root, from, existingTo });
      continue;
    }
    if (companions.claudeHome && !seenHomes.has(homeKey(companions.claudeHome))) {
      repairable.push(root);
    }
  }

  return { repairable, conflicted };
}
