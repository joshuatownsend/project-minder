import { isHumanPrompt, isHumanInterrupt } from "./classifier";
import { buildAttendedBlocks, blockHours } from "./blocks";
import { allocateConcurrent, localDayKey, type ConcurrencyPolicy } from "./allocate";
import { DEFAULT_ENGAGEMENT_CONFIG } from "./config";
import type {
  AttendedBlock, EngagementConfig, EngagementDay, EngagementEvent,
  EngagementReport, ProjectEngagement,
} from "./types";

/** One transcript turn as the engagement query returns it. */
export interface EngagementTurnRow {
  projectDirName: string;
  projectSlug: string | null;
  /** ISO-8601 timestamp. */
  ts: string;
  role: "user" | "assistant";
  textPreview: string | null;
  /** Non-null ⇒ this `user` turn is a tool result, never a person. */
  toolResultPreview: string | null;
}

export interface BuildEngagementOptions {
  period: string;
  timeZone: string;
  config?: EngagementConfig;
  policy?: ConcurrencyPolicy;
  /** Count of `sdk-*` sessions the query filtered out, for disclosure. */
  excludedAutomatedSessions?: number;
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

  const slugs = new Map<string, string | null>();
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

    if (!slugs.has(row.projectDirName)) slugs.set(row.projectDirName, row.projectSlug);
    else if (row.projectSlug && !slugs.get(row.projectDirName)) slugs.set(row.projectDirName, row.projectSlug);

    let list = eventsByProject.get(row.projectDirName);
    let flags = presenceFlags.get(row.projectDirName);
    if (!list || !flags) {
      list = []; flags = [];
      eventsByProject.set(row.projectDirName, list);
      presenceFlags.set(row.projectDirName, flags);
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
    const blocks = buildAttendedBlocks(sortedEvents, config, (i) => indexed[i].presence);
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

  const byProject: ProjectEngagement[] = [...blocksByProject.keys()]
    .map((key) => ({
      projectDirName: key,
      projectSlug: slugs.get(key) ?? null,
      rawHours: round2(rawHoursByProject.get(key) ?? 0),
      allocatedHours: round2(allocation.byProject.get(key) ?? 0),
      promptCount: promptsByProject.get(key) ?? 0,
      activeDays: activeDaysByProject.get(key)?.size ?? 0,
    }))
    .sort((a, b) => b.allocatedHours - a.allocatedHours);

  const byDay: EngagementDay[] = [...allocation.byDay.entries()]
    .map(([date, projects]) => ({
      date,
      totalHours: round2([...projects.values()].reduce((s, h) => s + h, 0)),
      byProject: [...projects.entries()]
        .map(([projectDirName, hours]) => ({ projectDirName, hours: round2(hours) }))
        .filter((p) => p.hours > 0)
        .sort((a, b) => b.hours - a.hours),
    }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const rawHours = [...rawHoursByProject.values()].reduce((s, h) => s + h, 0);

  return {
    period,
    timeZone,
    config,
    totalHours: round2(allocation.unionHours),
    rawHours: round2(rawHours),
    overlapHours: round2(Math.max(0, rawHours - allocation.unionHours)),
    byProject,
    byDay,
    excludedAutomatedSessions: options.excludedAutomatedSessions ?? 0,
  };
}

/**
 * Two decimals — timecards are filed in fractional hours (0.25 / 0.5), and
 * carrying full float precision into a CSV invites a client noticing that
 * 3.7299999999 hours does not look like a considered number.
 */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export { localDayKey };
