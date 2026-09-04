import { decodeDirName, sessionFileHomeKey } from "@/lib/platform";
import { isWorktreeFilePath, isWorktreeEncodedDir } from "@/lib/scanner/worktreeCheck";
import { projectSlugFromDirName, canonicalizeDirName } from "./projectIdentity";
import type { SessionSummary } from "@/lib/types";

/**
 * The one `SessionSummary` projection, shared by both backends (#496).
 *
 * There are two producers of a session summary — `loadSessionsListFromDb`,
 * which maps indexed SQL rows, and `buildAdapterScannedSession`, which maps a
 * `ParsedSession` on the file-parse path. They describe the same columns
 * (`ParsedSession` is what ingest writes and what those rows are read back
 * from), so before this the mapping existed twice, in snake_case and camelCase,
 * with the field-for-field correspondence carried only by care.
 *
 * That is the failure class #483 was: five hand-copied session-id predicates
 * that agreed perfectly and were wrong together, so no test caught the
 * disagreement because there wasn't one. #489 shipped the second copy pinned by
 * a dual-backend parity test, which makes the duplication *detectable* — this
 * makes it absent.
 *
 * **The input is the narrow intersection, not `ParsedSession`.** The SQL list
 * loader deliberately never materializes turns — five header queries stitched
 * in JS is the entire reason it is fast — so asking it to build a
 * `ParsedSession` first would defeat the path it exists to serve. What both
 * sides genuinely have is the header-level scalars below.
 *
 * **Three fields are deliberately absent, and are parameters at the call site
 * rather than computed here:**
 *
 *  - `costEstimate` — the DB serves the stored `cost_usd`; file-parse reprices
 *    live from per-model token buckets on every read, so a pricing rule edited
 *    in Settings reaches already-scanned sessions (#494). Neither choice should
 *    leak into the other.
 *  - `status` / `isActive` — the DB time-gates a stored `sessions.status`
 *    snapshot; file-parse derives from unresolved tool-use pairs. Different
 *    inputs, not a difference to unify away.
 *
 * Everything each backend can produce and the other cannot — `treeDelegation`,
 * `slug`, `continuedFromSessionId`, PRs, tickets and the rest on the DB side;
 * nothing on the file side today — stays at the call site too. The rule is that
 * this function computes what BOTH have, and never fakes a field as `undefined`
 * to make the shapes match.
 */
export interface SessionSummaryProjectionInput {
  sessionId: string;
  source: string;
  /** Raw filesystem path of the transcript, for the worktree check. */
  filePath: string;
  /**
   * The **raw** encoded dir name, worktree marker intact. Canonicalization
   * happens here; handing this an already-canonical name silently disables the
   * `isWorktree` half of the derivation.
   */
  projectDirName: string;
  /** Stored slug when there is one; null falls back to deriving it. */
  projectSlug: string | null;
  startTs: string | null;
  endTs: string | null;
  initialPrompt: string | null;
  lastPrompt: string | null;
  turnCount: number;
  userTurnCount: number;
  assistantTurnCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
  errorCount: number;
  verifiedTaskCount: number;
  oneShotTaskCount: number;
  cacheHitRatio: number | null;
  gitBranch: string | null;
  workModeExplorationPct: number | null;
  workModeBuildingPct: number | null;
  workModeTestingPct: number | null;
  workModeOtherPct: number | null;
  toolUsage: Record<string, number>;
  skillsUsed: Record<string, number>;
  modelsUsed: string[];
  searchableText: string | undefined;
}

/** Exactly the fields {@link projectSessionSummary} owns. */
export type ProjectedSessionFields = Pick<
  SessionSummary,
  | "sessionId"
  | "source"
  | "projectPath"
  | "projectSlug"
  | "projectName"
  | "startTime"
  | "endTime"
  | "durationMs"
  | "initialPrompt"
  | "lastPrompt"
  | "messageCount"
  | "userMessageCount"
  | "assistantMessageCount"
  | "inputTokens"
  | "outputTokens"
  | "cacheReadTokens"
  | "cacheCreateTokens"
  | "errorCount"
  | "oneShotRate"
  | "cacheHitRatio"
  | "gitBranch"
  | "workMode"
  | "toolUsage"
  | "skillsUsed"
  | "modelsUsed"
  | "subagentCount"
  | "searchableText"
  | "isWorktree"
  | "homeKey"
>;

export function projectSessionSummary(
  input: SessionSummaryProjectionInput
): ProjectedSessionFields {
  const canonicalDirName = canonicalizeDirName(input.projectDirName);

  const durationMs =
    input.startTs && input.endTs
      ? new Date(input.endTs).getTime() - new Date(input.startTs).getTime()
      : undefined;

  return {
    sessionId: input.sessionId,
    source: input.source,
    // Same rule ingest applies when it writes `sessions.home_key`: Claude
    // transcripts only (an adapter file has no Claude home to name), keyed by
    // the path prefix above `/projects/`, which is `normalizePathKey(home)`
    // — the join key the scanner puts on `ProjectData.usageHomeKey`.
    homeKey:
      input.source === "claude" ? (sessionFileHomeKey(input.filePath) ?? undefined) : undefined,
    projectPath: decodeDirName(canonicalDirName),
    // A stored slug is authoritative; deriving it is the degenerate branch for
    // a row whose `project_slug` is NULL, which the schema permits and a
    // healthy index never produces. The derivation canonicalizes, which the
    // DB loader's old inline fallback did not — harmless for a Claude row,
    // whose dir name was already canonicalized at ingest, but it would have
    // handed back an uncanonicalized slug for an adapter worktree row and
    // undone #497 on exactly the rows that fix was for.
    projectSlug: input.projectSlug ?? projectSlugFromDirName(input.projectDirName),
    // Raw, deliberately, on both backends: `isWorktree` is derived from it, and
    // the DB mapper passes `project_dir_name` through unchanged for Claude
    // sessions too. (#497.)
    projectName: input.projectDirName,
    startTime: input.startTs ?? undefined,
    endTime: input.endTs ?? undefined,
    durationMs,
    initialPrompt: input.initialPrompt ?? undefined,
    // Suppressed when identical, so a single-prompt session does not render the
    // same text twice.
    lastPrompt:
      input.lastPrompt && input.lastPrompt !== input.initialPrompt
        ? input.lastPrompt
        : undefined,
    messageCount: input.turnCount,
    userMessageCount: input.userTurnCount,
    assistantMessageCount: input.assistantTurnCount,
    inputTokens: input.inputTokens,
    outputTokens: input.outputTokens,
    cacheReadTokens: input.cacheReadTokens,
    cacheCreateTokens: input.cacheCreateTokens,
    errorCount: input.errorCount,
    // `undefined` rather than 0 when nothing was verified: "no verified tasks"
    // and "verified tasks, none one-shot" are different facts, and 0 would
    // render the second for both.
    oneShotRate:
      input.verifiedTaskCount > 0
        ? input.oneShotTaskCount / input.verifiedTaskCount
        : undefined,
    cacheHitRatio: input.cacheHitRatio ?? undefined,
    gitBranch: input.gitBranch ?? undefined,
    toolUsage: input.toolUsage,
    skillsUsed: input.skillsUsed,
    modelsUsed: input.modelsUsed,
    // The indexed `toolUsage['Agent']` tally, which is the same number from the
    // same source as file-parse's per-block count.
    subagentCount: input.toolUsage["Agent"] ?? 0,
    searchableText: input.searchableText,
    // **All-or-nothing.** A partial split renders as a bar that does not sum to
    // 100, which is worse than no bar.
    workMode:
      input.workModeExplorationPct !== null &&
      input.workModeBuildingPct !== null &&
      input.workModeTestingPct !== null &&
      input.workModeOtherPct !== null
        ? {
            exploration: input.workModeExplorationPct,
            building: input.workModeBuildingPct,
            testing: input.workModeTestingPct,
            other: input.workModeOtherPct,
          }
        : undefined,
    // **Two sources, because the two harness families store the fact in
    // different columns.** A Claude transcript lives INSIDE the worktree, so
    // its path carries the marker while its dir name was canonicalized at
    // ingest and no longer does. An adapter transcript lives under the
    // harness's own home (`~/.codex/sessions/...`), which carries no marker at
    // all — its worktree fact survives only in the encoded cwd. Reading the
    // path alone reported `false` for every adapter worktree session while the
    // file backend reported `true`, so switching backends changed the answer
    // for the same session. (Codex P2, PR #495.)
    isWorktree:
      isWorktreeFilePath(input.filePath) || isWorktreeEncodedDir(input.projectDirName),
  };
}
