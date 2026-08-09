import { isHumanPrompt, isHumanInterrupt } from "./classifier";
import { buildAttendedBlocks } from "./blocks";
import { mergeIntervals, intervalHours, clipRange } from "./intervals";
import { allocateConcurrent, localDayKey, type ConcurrencyPolicy } from "./allocate";
import { DEFAULT_ENGAGEMENT_CONFIG } from "./config";
import { apportionRounded, round2 } from "./apportion";
import type {
  EngagementConfig, EngagementDay, EngagementEvent, Interval,
  EngagementReport, ProjectEngagement,
} from "./types";

/** One transcript turn as the engagement query returns it. */
export interface EngagementTurnRow {
  projectDirName: string;
  projectSlug: string | null;
  /** `sessions.home_key` — the Claude-home discriminator, when stamped. */
  homeKey?: string | null;
  /**
   * Owning session. Blocks are built **within** a session, never across —
   * see `buildEngagementReport`.
   */
  sessionId: string;
  /** ISO-8601 timestamp. */
  ts: string;
  role: "user" | "assistant";
  textPreview: string | null;
  /** Non-null ⇒ this `user` turn is a tool result, never a person. */
  toolResultPreview: string | null;
}

/** Separator for the composite project key. */
const KEY_SEP = String.fromCharCode(0);

/**
 * Composite identity for a reported project row: encoded directory plus the
 * Claude home it was observed in. Separated by NUL, which cannot occur in
 * either component and so cannot be forged by a path — the same key shape the
 * usage report uses for this identical collision. Rows with no home stamp keep
 * the bare directory name, so single-home installs key exactly as before.
 */
export function projectKeyOf(dirName: string, homeKey?: string): string {
  return homeKey ? dirName + KEY_SEP + homeKey : dirName;
}

export interface BuildEngagementOptions {
  period: string;
  timeZone: string;
  config?: EngagementConfig;
  policy?: ConcurrencyPolicy;
  /** Count of `sdk-*` sessions the query filtered out, for disclosure. */
  excludedAutomatedSessions?: number;
  /**
   * Epoch ms of the period's lower bound. When set, `rows` is expected to
   * include some turns from *before* it, and credited intervals are clipped
   * back to it after the blocks are built.
   *
   * Both halves are needed. An attended gap that starts just before the
   * boundary and finishes inside the period is only recognizable as attended
   * if its opening prompt is present — cut that prompt and the trailing agent
   * events plus the reply degrade into a bare prompt, silently losing the
   * work. But the reconstructed interval then reaches outside the period, so
   * it is clipped rather than billed. Short windows feel this most: on a
   * `today` report the boundary is one gap out of very few.
   */
  clipFromMs?: number | null;
  /**
   * Upper bound for credited time, normally the instant the report is
   * evaluated. Tail credit hangs off the last prompt, so without this a prompt
   * three minutes before midnight mints credited time in the future — and, on
   * a `today` report, a row for tomorrow.
   */
  clipToMs?: number | null;
}

/**
 * Assemble the full engagement report from raw turns.
 *
 * Callers are responsible for having already excluded automated
 * (`entrypoint LIKE 'sdk-%'`) sessions and sidechain turns — see
 * `classifier.ts` for why that filter carries more weight than any text rule.
 */
export function buildEngagementReport(
  rows: EngagementTurnRow[],
  options: BuildEngagementOptions,
): EngagementReport {
  const config = options.config ?? DEFAULT_ENGAGEMENT_CONFIG;
  const { timeZone, period } = options;

  /** Identity of one reported project row. Composite because two Claude homes
   *  can hold identical path layouts and therefore share both the encoded
   *  directory name and the slug — keying on the directory alone silently
   *  merges them and bills one home's hours to the other (#311). */
  const identities = new Map<string, { dirName: string; slug: string | null; homeKey?: string }>();
  /**
   * Events keyed by **session**, not project.
   *
   * Attendance is a claim about one conversation. Merging every session for a
   * project into one stream lets an unrelated session's assistant output stand
   * in as the thing a prompt was "replying" to: session A goes quiet, session
   * B's opening prompt lands a minute later, and the merged walk credits the
   * whole gap as supervised even though neither session shows a person
   * waiting. Concurrent sessions on one project are the normal case here (a
   * main checkout plus a worktree), so this was not hypothetical. Blocks are
   * built per session and their intervals unioned per project afterwards —
   * union, not sum, so two genuinely concurrent sessions cannot bill the same
   * minute twice.
   */
  const eventsBySession = new Map<string, EngagementEvent[]>();
  const presenceFlags = new Map<string, boolean[]>();
  const projectOfSession = new Map<string, string>();

  for (const row of rows) {
    const ts = Date.parse(row.ts);
    // A row with an unparseable timestamp cannot be placed on the timeline at
    // all; dropping it is the only safe move — a NaN would poison every
    // comparison in the block walk.
    if (!Number.isFinite(ts)) continue;

    const human =
      row.role === "user" && row.toolResultPreview === null && isHumanPrompt(row.textPreview);

    const home = row.homeKey || undefined;
    const key = projectKeyOf(row.projectDirName, home);

    const existing = identities.get(key);
    if (!existing) {
      identities.set(key, { dirName: row.projectDirName, slug: row.projectSlug, homeKey: home });
    } else if (row.projectSlug && !existing.slug) {
      existing.slug = row.projectSlug;
    }

    const sessionKey = key + KEY_SEP + row.sessionId;
    projectOfSession.set(sessionKey, key);

    let list = eventsBySession.get(sessionKey);
    let flags = presenceFlags.get(sessionKey);
    if (!list || !flags) {
      list = []; flags = [];
      eventsBySession.set(sessionKey, list);
      presenceFlags.set(sessionKey, flags);
    }
    list.push({ ts, kind: human ? "human" : "agent" });
    flags.push(human && isHumanInterrupt(row.textPreview));
  }

  // Credited intervals and prompt counts accumulate per project, but are
  // *produced* per session.
  const intervalsByProject = new Map<string, Interval[]>();
  const promptsByProject = new Map<string, number>();

  const clipLo = options.clipFromMs ?? Number.NEGATIVE_INFINITY;
  const clipHi = options.clipToMs ?? Number.POSITIVE_INFINITY;

  for (const [sessionKey, events] of eventsBySession) {
    const projectKey = projectOfSession.get(sessionKey);
    if (!projectKey) continue;

    // `buildAttendedBlocks` sorts internally, so the presence flags must be
    // carried on the events themselves rather than by index into the caller's
    // array — otherwise a re-sort would silently mismatch the two lists.
    const flags = presenceFlags.get(sessionKey) ?? [];
    const indexed = events.map((e, i) => ({ e, presence: flags[i] ?? false }));
    indexed.sort((a, b) => a.e.ts - b.e.ts);
    const sortedEvents = indexed.map((x) => x.e);
    const built = buildAttendedBlocks(sortedEvents, config, (i) => indexed[i].presence);

    for (const block of built) {
      // Clip to the requested window on both ends: the lower bound removes the
      // deliberate over-fetch, the upper stops tail credit from running past
      // the report's own evaluation instant into the future.
      const kept = clipRange(block.intervals, clipLo, clipHi);
      if (!kept.length) continue;

      const list = intervalsByProject.get(projectKey);
      if (list) list.push(...kept);
      else intervalsByProject.set(projectKey, [...kept]);

      // Recount rather than reuse `promptCount`: a block straddling the lower
      // boundary keeps prompts from before the window unless they are
      // filtered here, which would overstate the audit trail.
      const inWindow = block.promptTimes.filter((t) => t >= clipLo && t <= clipHi).length;
      promptsByProject.set(projectKey, (promptsByProject.get(projectKey) ?? 0) + inWindow);
    }
  }

  // Union per project — two concurrent sessions on one project must not bill
  // the same minute twice, which a plain sum would do.
  const mergedByProject = new Map<string, Interval[]>();
  const rawHoursByProject = new Map<string, number>();
  for (const [key, intervals] of intervalsByProject) {
    const merged = mergeIntervals(intervals);
    if (!merged.length) continue;
    mergedByProject.set(key, merged);
    rawHoursByProject.set(key, intervalHours(merged));
  }

  const allocation = allocateConcurrent(mergedByProject, timeZone, options.policy);

  // ── Rounding, apportioned so the displayed numbers reconcile ───────────
  //
  // Three invariants hold exactly, because the report and the CSV both assert
  // them and a timecard that does not add up invites exactly the question this
  // feature exists to answer:
  //
  //   1. within a day, the per-project rows sum to that day's total
  //   2. the daily totals sum to the period total
  //   3. the per-project totals sum to the period total
  //
  // (2) is why `totalHours` is the sum of the *rounded* daily totals rather
  // than `round2(unionHours)` — the two differ by at most a few hundredths,
  // and being the sum of what is on screen is worth more than being the round
  // of a number nobody sees.
  //
  // (3) then comes for free, because project totals are summed from the very
  // same rounded daily shares. Apportioning days and projects as two separate
  // one-dimensional problems against a shared total does NOT converge:
  // `apportionRounded` can hand out at most one extra hundredth per share, so
  // a project earning ~0.0556 h on each of 30 days accumulates 1.80 h in the
  // daily table while its period-level share rounds to 1.67, and the project
  // table stops adding up to the headline. Summing the reconciled matrix by
  // column is the only arrangement where every margin agrees.
  const dayShares = [...allocation.byDay.entries()]
    .map(([date, projects]) => {
      const entries = [...projects.entries()].filter(([, hours]) => hours > 0);
      const dayTotal = round2(entries.reduce((s, [, h]) => s + h, 0));
      const shares = apportionRounded(entries.map(([, h]) => h), dayTotal);
      return {
        date,
        dayTotal,
        rows: entries
          .map(([key], i) => ({ key, hours: shares[i] }))
          .filter((r) => r.hours > 0),
      };
    })
    .filter((d) => d.dayTotal > 0)
    .sort((a, b) => a.date.localeCompare(b.date));

  const byDay: EngagementDay[] = dayShares.map((d) => ({
    date: d.date,
    totalHours: d.dayTotal,
    byProject: d.rows
      .map(({ key, hours }) => {
        const id = identities.get(key);
        return {
          projectDirName: id?.dirName ?? key,
          ...(id?.homeKey ? { homeKey: id.homeKey } : {}),
          hours,
        };
      })
      .sort((a, b) => b.hours - a.hours),
  }));

  const totalHours = round2(byDay.reduce((s, d) => s + d.totalHours, 0));

  // Column sums of the reconciled matrix, plus each project's distinct days.
  const allocatedByProject = new Map<string, number>();
  const activeDaysByProject = new Map<string, Set<string>>();
  for (const day of dayShares) {
    for (const { key, hours } of day.rows) {
      allocatedByProject.set(key, (allocatedByProject.get(key) ?? 0) + hours);
      let set = activeDaysByProject.get(key);
      if (!set) { set = new Set(); activeDaysByProject.set(key, set); }
      set.add(day.date);
    }
  }

  const byProject: ProjectEngagement[] = [...allocatedByProject.keys()]
    .map((key) => {
      const id = identities.get(key);
      return {
        projectDirName: id?.dirName ?? key,
        projectSlug: id?.slug ?? null,
        ...(id?.homeKey ? { homeKey: id.homeKey } : {}),
        rawHours: round2(rawHoursByProject.get(key) ?? 0),
        allocatedHours: round2(allocatedByProject.get(key) ?? 0),
        promptCount: promptsByProject.get(key) ?? 0,
        activeDays: activeDaysByProject.get(key)?.size ?? 0,
      };
    })
    .sort((a, b) => b.allocatedHours - a.allocatedHours);

  const rawHours = [...rawHoursByProject.values()].reduce((s, h) => s + h, 0);

  return {
    period,
    timeZone,
    config,
    totalHours,
    rawHours: round2(rawHours),
    overlapHours: round2(Math.max(0, rawHours - totalHours)),
    byProject,
    byDay,
    excludedAutomatedSessions: options.excludedAutomatedSessions ?? 0,
  };
}

export { localDayKey };
