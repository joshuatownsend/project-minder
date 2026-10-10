/**
 * Comparing encoded conversation dir names (`~/.claude/projects/<dir>`). A drive-letter encoding
 * (`C--dev-x`) comes from a case-insensitive Windows path, and the index holds case variants of one
 * project (`c--dev-x`, `C--dev-x`), so those compare case-folded; any other encoding compares exactly.
 * The fold is ASCII-only because the SQL side (`lower()`, see DIR_FILTER in usageFromDb.ts) folds
 * ASCII only, and both backends must select the same sessions; a non-ASCII case variant stays apart.
 * Dependency-free so client components can use it too.
 */

/** The ASCII-case-folded form of a drive-letter dir name, or null for any other encoding. */
export function driveDirFold(dirName: string): string | null {
  return /^[A-Za-z]--/.test(dirName) ? dirName.replace(/[A-Z]+/g, (c) => c.toLowerCase()) : null;
}

export function foldDirName(dirName: string): string {
  return driveDirFold(dirName) ?? dirName;
}

export function sameDirName(a: string, b: string): boolean {
  return foldDirName(a) === foldDirName(b);
}
