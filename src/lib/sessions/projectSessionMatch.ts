import { sameHomeKey } from "@/lib/homeKey";
import { sameDirName } from "@/lib/usage/dirNameFold";
import type { SessionSummary } from "@/lib/types";

/**
 * Whether a session belongs to the project with this encoded conversation dir
 * (`ProjectData.usageDirName`) and, for a home-pinned project, Claude home. Exact
 * on the dir (drive-letter case folded): same-named projects on different drives
 * or roots share a usage slug but not a dir (#639). Pair with an `/api/sessions`
 * request that only narrows the payload.
 */
export function isProjectSession(
  s: Pick<SessionSummary, "projectName" | "homeKey">,
  usageDirName: string,
  usageHomeKey?: string
): boolean {
  return sameDirName(s.projectName, usageDirName) && (!usageHomeKey || sameHomeKey(s.homeKey, usageHomeKey));
}
