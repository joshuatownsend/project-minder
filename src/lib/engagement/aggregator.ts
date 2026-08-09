import { isHumanPrompt, isHumanInterrupt } from "./classifier";
import { buildAttendedBlocks, blockHours } from "./blocks";
import { allocateConcurrent, localDayKey, type ConcurrencyPolicy } from "./allocate";
import { DEFAULT_ENGAGEMENT_CONFIG } from "./config";
import { apportionRounded, round2 } from "./apportion";
import { clipFrom } from "./intervals";
import type {
  AttendedBlock, EngagementConfig, EngagementDay, EngagementEvent,
  EngagementReport, ProjectEngagement,
} from "./types";

/** One transcript turn as the engagement query returns it. */
export interface EngagementTurnRow {
  projectDirName: string;
  projectSlug: string | null;
  /** `sessions.home_key` — the Claude-home discriminator, when stamped. */
  homeKey?: string | null;
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
  const eventsByProject = new Map<string, EngagementEvent[]>();
  const presenceFlags = new Map<string, boolean[]>();

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

    let list = eventsByProject.get(key);
    let flags = presenceFlags.get(key);
    if (!list || !flags) {
      list = []; flags = [];
      eventsByProject.set(key, list);
      presenceFlags.set(key, flags);
    }
    list.push({ ts, kind: human ? "human" : "agent" });
    flags.push(human && isHumanInterrupt(row.textPreview));
  }

  const blocksByProject = new Map<string, AttendedBlock[]>();
  const rawHoursByProject = new Map<string, number>();
  const promptsByProject = new Map<string, number>();

  for (const [key, events] of eventsByProject) {
    // `buildAttendedBlocks` sorts internally, so the presence flags must be
    // carried on the events themselves rather than by index into the caller's
    // array — otherwise a re-sort would silently mismatch the two lists.
    const flags = presenceFlags.get(key) ?? [];
    const indexed = events.map((e, i) => ({ e, presence: flags[i] ?? false }));
    indexed.sort((a, b) => a.e.ts - b.e.ts);
    const sortedEvents = indexed.map((x) => x.e);
    const built = buildAttendedBlocks(sortedEvents, config, (i) => indexed[i].presence);

    // Clip the over-fetched lead-in back out. Blocks left with no credited
    // interval are dropped whole — they sit entirely before the period, and
    // keeping them would inflate the prompt count with prompts from outside
    // the window the user asked about.
    const clip = options.clipFromMs;
    const blocks =
      clip == null
        ? built
        : built
            .map((b) => ({ ...b, intervals: clipFrom(b.intervals, clip) }))
            .filter((b) => b.intervals.length > 0);

    if (!blocks.length) continue;
    blocksByProject.set(key, blocks);
    rawHoursByProject.set(key, blockHours(blocks));
    promptsByProject.set(key, blocks.reduce((s, b) => s + b.promptCount, 0));
  }

  const allocation = allocateConcurrent(blocksByProject, timeZone, options.policy);

  const activeDaysByProject = new Map<string, Set<string>>();
  for (const [day, projects] of allocation.byDay) {
    for (const [key, hours] of projects) {
      if (hours <= 0) continue;
      let set = activeDaysByProject.get(key);
      if (!set) { set = new Set(); activeDaysByProject.set(key, set); }
      set.add(day);
    }
  }

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
  const byDay: EngagementDay[] = [...allocation.byDay.entries()]
    .map(([date, projects]) => {
      const entries = [...projects.entries()].filter(([, hours]) => hours > 0);
      const dayTotal = round2(entries.reduce((s, [, h]) => s + h, 0));
      const shares = apportionRounded(entries.map(([, h]) => h), dayTotal);
      return {
        date,
        totalHours: dayTotal,
        byProject: entries
          .map(([key], i) => {
            const id = identities.get(key);
            return {
              projectDirName: id?.dirName ?? key,
              ...(id?.homeKey ? { homeKey: id.homeKey } : {}),
              hours: shares[i],
            };
          })
          .filter((p) => p.hours > 0)
          .sort((a, b) => b.hours - a.hours),
      };
    })
    .filter((d) => d.totalHours > 0)
    .sort((a, b) => a.date.localeCompare(b.date));

  const totalHours = round2(byDay.reduce((s, d) => s + d.totalHours, 0));

  const projectKeys = [...blocksByProject.keys()];
  const allocatedShares = apportionRounded(
    projectKeys.map((k) => allocation.byProject.get(k) ?? 0),
    totalHours,
  );
  const byProject: ProjectEngagement[] = projectKeys
    .map((key, i) => {
      const id = identities.get(key);
      return {
        projectDirName: id?.dirName ?? key,
        projectSlug: id?.slug ?? null,
        ...(id?.homeKey ? { homeKey: id.homeKey } : {}),
        rawHours: round2(rawHoursByProject.get(key) ?? 0),
        allocatedHours: allocatedShares[i],
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
