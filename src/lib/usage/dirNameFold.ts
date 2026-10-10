/**
 * Comparing encoded conversation dir names (`~/.claude/projects/<dir>`). A drive-letter encoding
 * (`C--dev-x`) comes from a case-insensitive Windows path, and the index holds case variants of one
 * project (`c--dev-x`, `C--dev-x`), so those compare case-folded; any other encoding compares exactly.
 * Dependency-free so client components can use it too.
 */

/** The case-folded form of a drive-letter dir name, or null for any other encoding. */
export function driveDirFold(dirName: string): string | null {
  return /^[A-Za-z]--/.test(dirName) ? dirName.toLowerCase() : null;
}

export function foldDirName(dirName: string): string {
  return driveDirFold(dirName) ?? dirName;
}

export function sameDirName(a: string, b: string): boolean {
  return foldDirName(a) === foldDirName(b);
}
