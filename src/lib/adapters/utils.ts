/** Text capture limit applied to userMessageText and assistantText in every adapter. */
export const TEXT_CAP = 500;

/** Shared base fields emitted on every UsageTurn by all adapters. */
export function makeBaseTurn(
  source: string,
  timestamp: string,
  sessionId: string,
  projectSlug: string,
  projectDirName: string
): {
  source: string;
  timestamp: string;
  sessionId: string;
  projectSlug: string;
  projectDirName: string;
  cacheCreateTokens: 0;
} {
  return { source, timestamp, sessionId, projectSlug, projectDirName, cacheCreateTokens: 0 };
}
