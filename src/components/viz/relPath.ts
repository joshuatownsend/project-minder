/**
 * Normalize a Windows or POSIX absolute path to a readable relative-style
 * label. Returns the `src/...` subtree when present, otherwise falls back
 * to the last path segment.
 */
export function relPath(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/");
  const srcIdx = normalized.indexOf("/src/");
  if (srcIdx !== -1) return normalized.slice(srcIdx + 1);
  const lastSlash = normalized.lastIndexOf("/");
  return lastSlash !== -1 ? normalized.slice(lastSlash + 1) : normalized;
}
