/**
 * Compare two Claude-home keys as the same home.
 *
 * Both sides are `normalizePathKey` of a configured home, but they can reach a
 * comparison by different routes: `resolveUsageHomeKey` keys a project from
 * the configured string as written — trailing `/` or `\` included — while
 * `sessionFileHomeKey` derives a session's key from a file path under
 * `<home>/projects/…`, which never carries one. A strict `===` between the
 * two silently dropped every session of a mapped project whose `claudeHomes`
 * entry ended in a separator (Codex on #556). Import-free so the client
 * (`ProjectSessions`) can use it too.
 */
export function normalizeHomeKey(key: string): string {
  return key.replace(/[\\/]+$/, "");
}

export function sameHomeKey(a: string | undefined, b: string | undefined): boolean {
  if (a === undefined || b === undefined) return false;
  return normalizeHomeKey(a) === normalizeHomeKey(b);
}
