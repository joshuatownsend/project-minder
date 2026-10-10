import { sameHomeKey } from "@/lib/homeKey";
import type { SessionSummary } from "@/lib/types";

/**
 * Whether a session belongs to the project with this encoded conversation dir
 * (`ProjectData.usageDirName`) and, for a home-pinned project, Claude home. Exact
 * on the dir: same-named projects on different drives or roots share a usage
 * slug but not a dir (#639). Pair with `/api/sessions?project=<dir>&home=<key>`,
 * whose substring match only narrows the payload.
 */
export function isProjectSession(
  s: Pick<SessionSummary, "projectName" | "homeKey">,
  usageDirName: string,
  usageHomeKey?: string
): boolean {
  return s.projectName === usageDirName && (!usageHomeKey || sameHomeKey(s.homeKey, usageHomeKey));
}
