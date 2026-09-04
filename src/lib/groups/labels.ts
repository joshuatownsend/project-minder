/**
 * Short, distinguishing labels for a group's locations.
 *
 * Every per-location chip on the group page ("only in …", "done in …") needs
 * a name for a checkout, and the full path is too long for a chip while the
 * slug is a scanner artefact (`bamcli-2`) that says nothing about WHERE the
 * checkout is. The label is the shortest prefix of the path that tells the
 * group's members apart: the drive or WSL distro when that is enough, the
 * parent directory when two members share a drive, the whole path as a last
 * resort.
 *
 * Pure and client-safe like the rest of `src/lib/groups/` — no `path`, no
 * `os`: separators are handled by hand so the same code labels a Windows
 * path on a Linux dev box.
 */

const WSL_UNC = /^[\\/]{2}(wsl\.localhost|wsl\$)[\\/]([^\\/]+)/i;
const UNC = /^[\\/]{2}([^\\/]+)[\\/]+([^\\/]+)/;
const DRIVE = /^([A-Za-z]):/;

/** Split a path into its display segments, dropping empty ones. */
function segments(p: string): string[] {
  return p.split(/[\\/]+/).filter(Boolean);
}

/**
 * Coarse label: the drive letter, WSL distro, UNC host + share, or root. Two
 * members on different drives, distros, or shares are told apart by this
 * alone. The share is part of the UNC root because `candidates()` treats the
 * first two UNC segments as covered — a host-only label would leave
 * `\\nas\a\repo` and `\\nas\b\repo` indistinguishable (Codex on #554).
 */
export function locationRootLabel(path: string): string {
  const wsl = WSL_UNC.exec(path);
  if (wsl) return `WSL ${wsl[2]}`;
  const unc = UNC.exec(path);
  if (unc) return `\\\\${unc[1]}\\${unc[2]}`;
  const drive = DRIVE.exec(path);
  if (drive) return `${drive[1].toUpperCase()}:`;
  return "/";
}

/**
 * Candidate labels from coarsest to finest: root, then root + each successive
 * directory. The last candidate is the whole path, which is unique by
 * construction (members are keyed on path).
 */
function candidates(path: string): string[] {
  const root = locationRootLabel(path);
  const segs = segments(path);
  // Segments the root label already covers: the drive (`C:`), or the UNC host
  // plus share/distro (`wsl.localhost`, `Ubuntu`). A POSIX path covers none.
  const wsl = WSL_UNC.test(path);
  const covered = wsl || UNC.test(path) ? 2 : DRIVE.test(path) ? 1 : 0;
  const rest = segs.slice(covered);
  // How the first directory attaches to the root, and the separator after it.
  const sep = wsl || !path.includes("\\") ? "/" : "\\";
  const join = wsl ? ":" + sep : root === "/" ? "" : sep;
  const out = [root];
  for (let i = 1; i <= rest.length; i++) {
    out.push(`${root}${join}${rest.slice(0, i).join(sep)}`);
  }
  return out;
}

/**
 * One label per path, each the coarsest candidate that no OTHER member shares.
 *
 * Refines per pair, not globally: with `C:\dev\foo`, `D:\dev\foo`, and
 * `C:\work\foo` the D: member stays `D:` while the two C: members refine to
 * `C:\dev` and `C:\work`. Input order is preserved; keys are the raw paths as
 * given, so callers look up with the same string they passed in.
 */
export function locationLabels(paths: readonly string[]): Map<string, string> {
  const cands = paths.map(candidates);
  const out = new Map<string, string>();
  paths.forEach((p, i) => {
    const mine = cands[i];
    let chosen = mine[mine.length - 1];
    for (let depth = 0; depth < mine.length; depth++) {
      const label = mine[depth];
      const clash = cands.some((other, j) => j !== i && other[depth] === label);
      if (!clash) {
        chosen = label;
        break;
      }
    }
    out.set(p, chosen);
  });
  return out;
}
