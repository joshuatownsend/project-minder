import type { PathMapping } from "./types";

/**
 * Cross-environment path translation (config.pathMappings).
 *
 * A session recorded inside a WSL distro references Linux paths
 * (`/home/josh/dev/foo`) while the scanner sees the same directory as
 * `\\wsl.localhost\<distro>\home\josh\dev\foo`. Every join between session
 * data and scanned projects (history matching, usageSlug, session-dir
 * encoding) goes through these two functions so the rewrite lives in exactly
 * one place. Paths that match no mapping pass through unchanged, so callers
 * can apply them unconditionally.
 */

/** Trim trailing separators (either style) off a mapping endpoint. */
function trimSep(s: string): string {
  return s.replace(/[\\/]+$/, "");
}

/** True when `p` equals `prefix` or continues past it at a separator boundary. */
function hasPrefix(p: string, prefix: string, caseFold: boolean): boolean {
  const a = caseFold ? p.toLowerCase() : p;
  const b = caseFold ? prefix.toLowerCase() : prefix;
  if (!a.startsWith(b)) return false;
  const nextChar = a.charAt(b.length);
  return nextChar === "" || nextChar === "/" || nextChar === "\\";
}

/** Convert a path remainder to the separator style its new prefix uses. */
function restyleRest(rest: string, prefix: string): string {
  const backslash = prefix.includes("\\");
  return backslash ? rest.replace(/\//g, "\\") : rest.replace(/\\/g, "/");
}

/**
 * Map a path recorded by a foreign environment onto this machine's view:
 * `/home/josh/dev/foo` → `\\wsl.localhost\Ubuntu-26.04\home\josh\dev\foo`.
 * First matching mapping wins; unmatched paths are returned unchanged.
 * `from` matching is case-sensitive (Linux origin paths are case-sensitive).
 */
export function mapForeignPath(p: string, mappings: PathMapping[] | undefined): string {
  for (const m of mappings ?? []) {
    const from = trimSep(m.from);
    if (!from || !hasPrefix(p, from, false)) continue;
    const to = trimSep(m.to);
    return to + restyleRest(p.slice(from.length), to);
  }
  return p;
}

/**
 * Reverse direction: map this machine's path back to the foreign form:
 * `\\wsl.localhost\Ubuntu-26.04\home\josh\dev\foo` → `/home/josh/dev/foo`.
 * `to` matching is case-insensitive with `/`↔`\` treated as equal (Windows
 * UNC paths are case-insensitive and users mix slash styles).
 */
export function mapLocalPath(p: string, mappings: PathMapping[] | undefined): string {
  const canon = (s: string) => s.replace(/\//g, "\\");
  for (const m of mappings ?? []) {
    const to = trimSep(m.to);
    if (!to || !hasPrefix(canon(p), canon(to), true)) continue;
    const from = trimSep(m.from);
    return from + restyleRest(p.slice(to.length), from);
  }
  return p;
}
