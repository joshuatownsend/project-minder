import type { ProjectData, ProjectStatus } from "@/lib/types/project";
import type { SessionStatus } from "@/lib/types/session";
import type {
  BoardEpic,
  BoardIssue,
  BoardPriority,
  BoardStatus,
} from "@/lib/types/board";
import type { OpsSectionKey } from "@/lib/types/ops";
import { compareCodepoint } from "./derive";

/**
 * P2 — the aggregation layer for Project Groups.
 *
 * `aggregateGroup(members)` folds several checkouts of one repository (the
 * members of a `ProjectGroup`) into a single serializable view, following the
 * four merge rules in `docs/superpowers/plans/2026-07-20-project-groups-multi-location.md`:
 *
 *   - **Repo-borne** content (`TODO.md`, `INSIGHTS.md`, `BOARD.md`,
 *     `MANUAL_STEPS.md`, `OPERATIONS.md`, `CLAUDE.md` summary, framework) is
 *     **deduplicated**, and every difference between checkouts is **surfaced
 *     as a `Divergence`, never resolved**. Each merged item carries the slugs
 *     it is `presentIn` (and, for checkboxes, `completedIn`) so a UI can show
 *     the split rather than a merged lie.
 *   - **Activity** (session counts, last-session dates) **sums / maxes**.
 *     Derived rates are never carried across; see `ratio` for the
 *     numerator-over-denominator recomputation the plan requires.
 *   - **Location-bound** state (branch, dirty files, dev port, worktrees,
 *     status) is **never merged** — it is listed per member in `locations`.
 *   - **Environment-borne** catalogs (user/plugin skills, agents, MCP) are not
 *     on `ProjectData` at all, so they are out of this function's reach; the
 *     Environments comparison belongs to P3 over the catalog API.
 *
 * Headline rule for a divergent item: the value shown is the **primary**
 * location's — the member with the most recent `lastActivity`, ties broken by
 * codepoint path order — because that is the checkout most likely to be
 * current. The rule is deterministic in the data, so output is independent of
 * input order.
 *
 * Usage/cost is not on `ProjectData` either. `usageKeys` is the deduplicated
 * set of `(usageSlug, usageHomeKey)` pairs a caller must fetch to sum a
 * group's cost without double-counting (two local drives share a `usageSlug`).
 *
 * This module is deliberately Node-free (no `crypto`, no `fs`) like the rest of
 * `src/lib/groups/`, so it can run client-side over the `/api/projects`
 * payload. Dedupe keys are normalized text, not hashes.
 */

/** The read-set, documented as a type — same convention as `GroupableProject`. */
export type AggregatableProject = Pick<
  ProjectData,
  | "slug"
  | "path"
  | "name"
  | "status"
  | "usageSlug"
  | "usageHomeKey"
  | "git"
  | "claude"
  | "todos"
  | "manualSteps"
  | "insights"
  | "board"
  | "operations"
  | "worktrees"
  | "devPort"
  | "framework"
  | "frameworkVersion"
  | "lastActivity"
  | "scannedAt"
>;

export interface AggregateGroupOptions {
  /**
   * Dev roots the scanner skipped this pass (`ScanResult.skippedRoots[].path`).
   * A member under a skipped root is a carried-forward copy from an earlier
   * scan, so it is flagged `stale` and the whole aggregate `partial` — a sum
   * that silently includes a stopped WSL distro's last-known numbers must
   * not look authoritative (plan risk 7).
   */
  skippedRootPaths?: readonly string[];
}

export type RepoFile =
  | "TODO.md"
  | "INSIGHTS.md"
  | "BOARD.md"
  | "MANUAL_STEPS.md"
  | "OPERATIONS.md"
  | "CLAUDE.md"
  | "package.json";

export interface Divergence {
  file: RepoFile;
  /**
   * `missing`: some members have no parsed content for the file. The scanner
   * returns `undefined` both for an absent file and for one that parses to
   * nothing (a `TODO.md` with no checkboxes, an `INSIGHTS.md` with no
   * markers), and `ProjectData` carries no separate presence flag, so this
   * layer cannot tell the two apart — the wording says "no content", not
   * "absent". `differs`: the copies disagree.
   */
  kind: "missing" | "differs";
  /** Member slugs involved — the ones lacking the file, or the ones that disagree. */
  locations: string[];
  detail: string;
}

/** Location-bound state — one per member, never merged. */
export interface GroupLocation {
  slug: string;
  path: string;
  name: string;
  status: ProjectStatus;
  /** Carried forward from an earlier scan because its root was skipped. */
  stale: boolean;
  branch?: string;
  isDirty: boolean;
  uncommittedCount: number;
  /** The dirty check itself failed; do not render as clean. */
  gitUnknown: boolean;
  lastCommitDate?: string;
  devPort?: number;
  worktrees: { branch: string; worktreePath: string }[];
  sessionCount: number;
  lastSessionDate?: string;
  lastActivity?: string;
  scannedAt: string;
}

export interface GroupActivity {
  /** Sum across members. */
  sessionCount: number;
  /** Max across members. */
  lastSessionDate?: string;
  /** Max across members. */
  lastActivity?: string;
  /** Carried from the member that owns `lastSessionDate`. */
  mostRecent?: {
    slug: string;
    sessionId?: string;
    status?: SessionStatus;
    promptPreview?: string;
  };
  perLocation: { slug: string; sessionCount: number; lastSessionDate?: string }[];
}

export interface AggregatedTodoItem {
  text: string;
  /** Headline value — the primary location's state. */
  completed: boolean;
  presentIn: string[];
  completedIn: string[];
}

export interface AggregatedTodos {
  items: AggregatedTodoItem[];
  total: number;
  completed: number;
  pending: number;
}

export interface AggregatedInsightEntry {
  id: string;
  /** Headline values — the primary location's copy. */
  content: string;
  sessionId: string;
  date: string;
  presentIn: string[];
  /** Locations whose copy under this id differs in content, session, or date
   *  (the parser trusts a persisted marker id rather than recomputing it). */
  editedIn: string[];
}

export interface AggregatedInsights {
  entries: AggregatedInsightEntry[];
  total: number;
}

export interface AggregatedManualStep {
  text: string;
  completed: boolean;
  /** Headline details — the primary location's. */
  details: string[];
  presentIn: string[];
  completedIn: string[];
  /** Indented detail lines per location (commands, URLs) — never dropped. */
  detailsIn: Record<string, string[]>;
}

export interface AggregatedManualStepEntry {
  date: string;
  featureSlug: string;
  title: string;
  /** Headline note — the primary location's. */
  note?: string;
  steps: AggregatedManualStep[];
  presentIn: string[];
  /** Entry-level note per location that has one (an archive explanation, say). */
  noteIn: Record<string, string>;
}

export interface AggregatedManualSteps {
  entries: AggregatedManualStepEntry[];
  totalSteps: number;
  pendingSteps: number;
  completedSteps: number;
}

export interface AggregatedBoardIssue {
  id: string;
  title: string;
  /** Headline value — the primary location's status. */
  status: BoardStatus;
  priority?: BoardPriority;
  labels: string[];
  worktree?: string;
  sessionId?: string;
  detail?: string;
  /** Recomputed after dedupe; source `line`/`order` are location-bound. */
  order: number;
  presentIn: string[];
  statusIn: Record<string, BoardStatus>;
  /** Locations whose copy differs from the headline in a non-status field
   *  (title, priority, labels, detail, worktree, session, or container) —
   *  the edits a stable id is designed to survive, and therefore must not hide. */
  editedIn: string[];
  /** Where each location keeps this issue: `"inbox"`, or its epic's merge key. */
  containerIn: Record<string, string>;
}

export interface AggregatedBoardEpic {
  id: string;
  title: string;
  status: BoardStatus;
  priority?: BoardPriority;
  labels: string[];
  description?: string;
  order: number;
  issues: AggregatedBoardIssue[];
  presentIn: string[];
  statusIn: Record<string, BoardStatus>;
  /** Locations whose copy differs in title, priority, labels, or description. */
  editedIn: string[];
}

export interface AggregatedBoard {
  epics: AggregatedBoardEpic[];
  inbox: AggregatedBoardIssue[];
  /** epics + all epic issues + inbox issues, over the deduplicated set. */
  total: number;
}

export interface AggregatedOpsItem {
  text: string;
  done: boolean;
  /** Headline details — the primary location's. */
  details: string[];
  presentIn: string[];
  doneIn: string[];
  /** Indented detail lines per location (operational instructions) — never dropped. */
  detailsIn: Record<string, string[]>;
}

export interface AggregatedOpsSection {
  key: OpsSectionKey;
  heading: string;
  /** Headline prose — the primary location's. */
  body: string;
  items: AggregatedOpsItem[];
  presentIn: string[];
  /** Section prose per location, so another checkout's instructions are never discarded. */
  bodyIn: Record<string, string>;
}

export interface AggregatedOperations {
  sections: AggregatedOpsSection[];
  totalItems: number;
  pendingItems: number;
}

/** A scalar repo-borne fact with its per-location values. */
export interface RepoFact<T> {
  /** Headline value — the primary location's, or the first defined one. */
  value?: T;
  valueIn: { slug: string; value: T }[];
  diverged: boolean;
}

export interface UsageKey {
  usageSlug: string;
  usageHomeKey?: string;
}

export interface GroupAggregate {
  memberCount: number;
  /** Slug of the location whose values win headline positions. */
  primary: string;
  /** True when any member is a stale carry-forward. */
  partial: boolean;
  locations: GroupLocation[];
  activity: GroupActivity;
  todos?: AggregatedTodos;
  insights?: AggregatedInsights;
  board?: AggregatedBoard;
  manualSteps?: AggregatedManualSteps;
  operations?: AggregatedOperations;
  facts: {
    framework: RepoFact<string>;
    frameworkVersion: RepoFact<string>;
    claudeMdSummary: RepoFact<string>;
  };
  divergences: Divergence[];
  /** Deduplicated fetch keys for summing usage/cost across members. */
  usageKeys: UsageKey[];
}

// ── Public helpers ───────────────────────────────────────────────────────────

/**
 * The only correct way to carry a rate across locations: sum both sides, then
 * divide. Averaging two one-shot rates weights a 3-session location like a
 * 100-session one. Returns `undefined` for an empty denominator so a UI shows
 * "n/a" rather than 0%.
 */
export function ratio(numerator: number, denominator: number): number | undefined {
  return denominator > 0 ? numerator / denominator : undefined;
}

/**
 * Deduplicated `(usageSlug, usageHomeKey)` pairs. `C:\dev\foo` and `D:\dev\foo`
 * share a `usageSlug` with no home key, so summing per-member usage responses
 * would double-count; the composite key mirrors `CostReportDashboard`.
 */
export function groupUsageKeys(members: readonly AggregatableProject[]): UsageKey[] {
  const seen = new Set<string>();
  const out: UsageKey[] = [];
  for (const m of sortMembers(members)) {
    const k = `${m.usageSlug}\u0000${m.usageHomeKey ?? ""}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(m.usageHomeKey ? { usageSlug: m.usageSlug, usageHomeKey: m.usageHomeKey } : { usageSlug: m.usageSlug });
  }
  return out;
}

// ── aggregateGroup ───────────────────────────────────────────────────────────

export function aggregateGroup(
  input: readonly AggregatableProject[],
  options: AggregateGroupOptions = {}
): GroupAggregate {
  if (input.length === 0) {
    throw new Error("aggregateGroup: a group needs at least one member");
  }
  const byPath = sortMembers(input);
  const primary = pickPrimary(byPath);
  // Primary first, then the rest in path order — so the first occurrence of
  // any repo-borne item is the primary's copy and headline values fall out of
  // iteration order without special-casing.
  const ordered = [primary, ...byPath.filter((m) => m !== primary)];
  const skipped = (options.skippedRootPaths ?? []).map(skippedRootKey);
  const divergences: Divergence[] = [];

  const locations = byPath.map((m) => toLocation(m, skipped));

  const aggregate: GroupAggregate = {
    memberCount: byPath.length,
    primary: primary.slug,
    partial: locations.some((l) => l.stale),
    locations,
    activity: aggregateActivity(byPath),
    todos: aggregateTodos(ordered, divergences),
    insights: aggregateInsights(ordered, divergences),
    board: aggregateBoard(ordered, divergences),
    manualSteps: aggregateManualSteps(ordered, divergences),
    operations: aggregateOperations(ordered, divergences),
    facts: {
      framework: fact(ordered, "package.json", "framework", (m) => m.framework, divergences),
      frameworkVersion: fact(ordered, "package.json", "frameworkVersion", (m) => m.frameworkVersion, divergences),
      claudeMdSummary: fact(ordered, "CLAUDE.md", "summary", (m) => m.claude?.claudeMdSummary, divergences),
    },
    divergences,
    usageKeys: groupUsageKeys(byPath),
  };
  return aggregate;
}

// ── Members, primary, locations ──────────────────────────────────────────────

function sortMembers(members: readonly AggregatableProject[]): AggregatableProject[] {
  // Raw-path codepoint order, exactly as `deriveProjectGroups` sorts
  // `ProjectGroup.members`, so `locations[i]` and `members[i]` always line up.
  return [...members].sort((a, b) => compareCodepoint(a.path, b.path));
}

function instant(iso: string): number | undefined {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? undefined : t;
}

/**
 * True when `a` is strictly newer than `b`. Timestamps are compared as
 * parsed instants — `lastActivity` can come from git's offset-bearing commit
 * date, and `2026-09-02T10:00:00-07:00` is later than `2026-09-02T16:30:00Z`
 * though it sorts lexically smaller. Undefined never wins; a valid instant
 * always beats an unparsable string; lexical order is the tie-break only when
 * neither side parses, so a malformed date can never outrank a real one.
 */
function isNewer(a: string | undefined, b: string | undefined): boolean {
  if (!a) return false;
  if (!b) return true;
  const ta = instant(a);
  const tb = instant(b);
  if (ta !== undefined && tb !== undefined) return ta > tb;
  if (ta !== undefined) return true;
  if (tb !== undefined) return false;
  return a > b;
}

/** Most recent `lastActivity` wins; ties (including all-undefined) go to path order. */
function pickPrimary(byPath: readonly AggregatableProject[]): AggregatableProject {
  let best = byPath[0];
  for (const m of byPath.slice(1)) {
    if (isNewer(m.lastActivity, best.lastActivity)) best = m;
  }
  return best;
}

/**
 * Comparison key for the skipped-root containment test. Separators fold and a
 * trailing separator drops, as in `normalizePathKey`, but case folds only for
 * Windows-shaped paths (drive letter or UNC, which includes every
 * `\\\\wsl.localhost` root): on POSIX, `/home/me/Foo` and `/home/me/foo` are
 * different directories, and folding would mark the wrong project stale.
 * Decided from the path's own shape rather than `process.platform` so the
 * module stays client-safe (mirrors the rule in `src/lib/platform.ts`).
 */
function skippedRootKey(value: string): string {
  const n = value.replace(/[\\/]+/g, "/").replace(/\/+$/, "");
  return /^([a-z]:|\/\/)/i.test(n) ? n.toLowerCase() : n;
}

function isUnderSkippedRoot(path: string, skipped: readonly string[]): boolean {
  const p = skippedRootKey(path);
  return skipped.some((root) => p === root || p.startsWith(root + "/"));
}

function toLocation(m: AggregatableProject, skipped: readonly string[]): GroupLocation {
  return {
    slug: m.slug,
    path: m.path,
    name: m.name,
    status: m.status,
    stale: isUnderSkippedRoot(m.path, skipped),
    branch: m.git?.branch,
    isDirty: m.git?.isDirty ?? false,
    uncommittedCount: m.git?.uncommittedCount ?? 0,
    gitUnknown: m.git?.unknown === true,
    lastCommitDate: m.git?.lastCommitDate,
    devPort: m.devPort,
    worktrees: (m.worktrees ?? []).map((w) => ({ branch: w.branch, worktreePath: w.worktreePath })),
    sessionCount: m.claude?.sessionCount ?? 0,
    lastSessionDate: m.claude?.lastSessionDate,
    lastActivity: m.lastActivity,
    scannedAt: m.scannedAt,
  };
}

// ── Activity: sum + max ──────────────────────────────────────────────────────

function aggregateActivity(byPath: readonly AggregatableProject[]): GroupActivity {
  let sessionCount = 0;
  let lastSessionDate: string | undefined;
  let lastActivity: string | undefined;
  let winner: AggregatableProject | undefined;
  for (const m of byPath) {
    sessionCount += m.claude?.sessionCount ?? 0;
    const lsd = m.claude?.lastSessionDate;
    if (isNewer(lsd, lastSessionDate)) {
      lastSessionDate = lsd;
      winner = m;
    }
    if (isNewer(m.lastActivity, lastActivity)) {
      lastActivity = m.lastActivity;
    }
  }
  return {
    sessionCount,
    lastSessionDate,
    lastActivity,
    mostRecent: winner
      ? {
          slug: winner.slug,
          sessionId: winner.claude?.mostRecentSessionId,
          status: winner.claude?.mostRecentSessionStatus,
          promptPreview: winner.claude?.lastPromptPreview,
        }
      : undefined,
    perLocation: byPath.map((m) => ({
      slug: m.slug,
      sessionCount: m.claude?.sessionCount ?? 0,
      lastSessionDate: m.claude?.lastSessionDate,
    })),
  };
}

// ── Generic keyed merge ──────────────────────────────────────────────────────

function normText(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

/**
 * Merge one collection per member into a deduplicated list.
 *
 * Keys are made unique *within* a member by occurrence index, so two
 * legitimately identical items in one checkout stay two items, while the same
 * item across checkouts folds into one. Iteration order is primary-first, so
 * `build` always sees the primary's copy when the primary has one.
 */
function mergeKeyed<T, R>(
  ordered: readonly AggregatableProject[],
  pick: (m: AggregatableProject) => readonly T[] | undefined,
  keyOf: (item: T) => string,
  build: (item: T, slug: string) => R,
  fold: (acc: R, item: T, slug: string) => void
): R[] {
  const out = new Map<string, R>();
  for (const m of ordered) {
    const items = pick(m);
    if (!items) continue;
    const seen = new Map<string, number>();
    for (const item of items) {
      const base = keyOf(item);
      const n = seen.get(base) ?? 0;
      seen.set(base, n + 1);
      const key = `${base}#${n}`;
      const existing = out.get(key);
      if (existing !== undefined) fold(existing, item, m.slug);
      else out.set(key, build(item, m.slug));
    }
  }
  return [...out.values()];
}

/** Members that have this file at all, and a `missing` divergence for those that don't. */
function withFile<T>(
  ordered: readonly AggregatableProject[],
  file: RepoFile,
  pick: (m: AggregatableProject) => T | undefined,
  divergences: Divergence[]
): AggregatableProject[] {
  const have = ordered.filter((m) => pick(m) !== undefined);
  if (have.length > 0 && have.length < ordered.length) {
    divergences.push({
      file,
      kind: "missing",
      locations: ordered.filter((m) => pick(m) === undefined).map((m) => m.slug),
      detail: `${file} has no content in ${ordered.length - have.length} of ${ordered.length} locations (absent or empty)`,
    });
  }
  return have;
}

function pushDiffers(
  divergences: Divergence[],
  file: RepoFile,
  locations: Set<string>,
  detail: string
): void {
  if (locations.size === 0) return;
  divergences.push({ file, kind: "differs", locations: [...locations].sort(compareCodepoint), detail });
}

/** Presence/completion bookkeeping shared by every checkbox-shaped merge. */
interface Ticked {
  presentIn: string[];
  completedIn: string[];
}

function tickDivergence(
  items: readonly Ticked[],
  have: readonly AggregatableProject[],
  file: RepoFile,
  noun: string,
  divergences: Divergence[]
): void {
  const partial = new Set<string>();
  const ticks = new Set<string>();
  let partialCount = 0;
  let tickCount = 0;
  for (const it of items) {
    if (it.presentIn.length < have.length) {
      partialCount++;
      for (const m of have) if (!it.presentIn.includes(m.slug)) partial.add(m.slug);
    }
    if (it.completedIn.length > 0 && it.completedIn.length < it.presentIn.length) {
      tickCount++;
      for (const s of it.presentIn) ticks.add(s);
    }
  }
  if (partialCount > 0) {
    pushDiffers(divergences, file, partial, `${partialCount} ${noun}${partialCount === 1 ? "" : "s"} not present in every location`);
  }
  if (tickCount > 0) {
    pushDiffers(divergences, file, ticks, `${tickCount} ${noun}${tickCount === 1 ? "" : "s"} ticked differently between locations`);
  }
}

/**
 * Items whose indented detail lines differ between the locations that have
 * them — a changed command or URL under an otherwise identical checkbox is
 * exactly the kind of edit that must not vanish behind the primary's copy.
 */
function detailsDivergence(
  items: readonly { presentIn: string[]; detailsIn: Record<string, string[]> }[],
  file: RepoFile,
  noun: string,
  divergences: Divergence[]
): void {
  const where = new Set<string>();
  let count = 0;
  for (const it of items) {
    const distinct = new Set(it.presentIn.map((slug) => (it.detailsIn[slug] ?? []).map(normText).join("\n")));
    if (distinct.size > 1) {
      count++;
      for (const slug of it.presentIn) where.add(slug);
    }
  }
  if (count > 0) {
    pushDiffers(divergences, file, where, `${count} ${noun}${count === 1 ? "" : "s"} with different details between locations`);
  }
}

// ── TODO.md ──────────────────────────────────────────────────────────────────

function aggregateTodos(
  ordered: readonly AggregatableProject[],
  divergences: Divergence[]
): AggregatedTodos | undefined {
  const have = withFile(ordered, "TODO.md", (m) => m.todos, divergences);
  if (have.length === 0) return undefined;
  const items = mergeKeyed(
    have,
    (m) => m.todos?.items,
    (t) => normText(t.text),
    (t, slug): AggregatedTodoItem => ({
      text: normText(t.text),
      completed: t.completed,
      presentIn: [slug],
      completedIn: t.completed ? [slug] : [],
    }),
    (acc, t, slug) => {
      acc.presentIn.push(slug);
      if (t.completed) acc.completedIn.push(slug);
    }
  );
  tickDivergence(items, have, "TODO.md", "item", divergences);
  const completed = items.filter((i) => i.completed).length;
  return { items, total: items.length, completed, pending: items.length - completed };
}

// ── INSIGHTS.md ──────────────────────────────────────────────────────────────

function aggregateInsights(
  ordered: readonly AggregatableProject[],
  divergences: Divergence[]
): AggregatedInsights | undefined {
  const have = withFile(ordered, "INSIGHTS.md", (m) => m.insights, divergences);
  if (have.length === 0) return undefined;
  const entries = mergeKeyed(
    have,
    (m) => m.insights?.entries,
    (e) => e.id,
    (e, slug): AggregatedInsightEntry => ({
      id: e.id,
      content: e.content,
      sessionId: e.sessionId,
      date: e.date,
      presentIn: [slug],
      editedIn: [],
    }),
    (acc, e, slug) => {
      acc.presentIn.push(slug);
      if (insightFingerprint(e) !== insightFingerprint(acc)) acc.editedIn.push(slug);
    }
  );
  const partial = new Set<string>();
  const edited = new Set<string>();
  let count = 0;
  let editCount = 0;
  for (const e of entries) {
    if (e.presentIn.length < have.length) {
      count++;
      for (const m of have) if (!e.presentIn.includes(m.slug)) partial.add(m.slug);
    }
    if (e.editedIn.length > 0) {
      editCount++;
      for (const slug of e.presentIn) edited.add(slug);
    }
  }
  if (count > 0) {
    pushDiffers(divergences, "INSIGHTS.md", partial, `${count} insight${count === 1 ? "" : "s"} not present in every location`);
  }
  if (editCount > 0) {
    pushDiffers(divergences, "INSIGHTS.md", edited, `${editCount} insight${editCount === 1 ? "" : "s"} edited differently between locations`);
  }
  return { entries, total: entries.length };
}

function insightFingerprint(e: { content: string; sessionId: string; date: string }): string {
  return JSON.stringify([normText(e.content), e.sessionId, e.date]);
}

// ── BOARD.md ─────────────────────────────────────────────────────────────────

/** Surrogate id when the writer has backfilled one; container-scoped title otherwise. */
function boardKey(item: { id: string; title: string }): string {
  return item.id ? `id:${item.id}` : `t:${normText(item.title)}`;
}

/**
 * Everything on an issue that a stable id is meant to carry across edits.
 * Status is tracked separately (`statusIn`); `line`/`order` are location-bound.
 */
function issueFingerprint(i: {
  title: string;
  priority?: BoardPriority;
  labels: string[];
  detail?: string;
  worktree?: string;
  sessionId?: string;
}): string {
  return JSON.stringify([
    normText(i.title),
    i.priority ?? null,
    [...i.labels].sort(compareCodepoint),
    i.detail === undefined ? null : normText(i.detail),
    i.worktree ?? null,
    i.sessionId ?? null,
  ]);
}

function epicFingerprint(e: {
  title: string;
  priority?: BoardPriority;
  labels: string[];
  description?: string;
}): string {
  return JSON.stringify([
    normText(e.title),
    e.priority ?? null,
    [...e.labels].sort(compareCodepoint),
    e.description === undefined ? null : normText(e.description),
  ]);
}

function buildIssue(i: BoardIssue, slug: string): AggregatedBoardIssue {
  return {
    id: i.id,
    title: i.title,
    status: i.status,
    priority: i.priority,
    labels: [...i.labels],
    worktree: i.worktree,
    sessionId: i.sessionId,
    detail: i.detail,
    order: 0,
    presentIn: [slug],
    statusIn: { [slug]: i.status },
    editedIn: [],
    containerIn: {},
  };
}

function foldIssue(acc: AggregatedBoardIssue, i: BoardIssue, slug: string): void {
  acc.presentIn.push(slug);
  acc.statusIn[slug] = i.status;
  if (issueFingerprint(i) !== issueFingerprint(acc)) acc.editedIn.push(slug);
}

function renumber<T extends { order: number }>(items: T[]): T[] {
  items.forEach((it, idx) => {
    it.order = idx;
  });
  return items;
}

function aggregateBoard(
  ordered: readonly AggregatableProject[],
  divergences: Divergence[]
): AggregatedBoard | undefined {
  const have = withFile(ordered, "BOARD.md", (m) => m.board, divergences);
  if (have.length === 0) return undefined;

  // Epics carry their members' issue lists so issues can be merged inside the
  // merged epic (container-scoped), not by the location-bound `epicId`.
  const epics = mergeKeyed(
    have,
    (m) => m.board?.epics,
    boardKey,
    (e, slug): AggregatedBoardEpic => ({
      id: e.id,
      title: e.title,
      status: e.status,
      priority: e.priority,
      labels: [...e.labels],
      description: e.description,
      order: 0,
      issues: [],
      presentIn: [slug],
      statusIn: { [slug]: e.status },
      editedIn: [],
    }),
    (acc, e, slug) => {
      acc.presentIn.push(slug);
      acc.statusIn[slug] = e.status;
      if (epicFingerprint(e) !== epicFingerprint(acc)) acc.editedIn.push(slug);
    }
  );
  const finalEpics = renumber(epics);

  // Issues: a stable id dedupes ACROSS containers — an issue moved from an
  // epic to the Inbox in one checkout is still one issue, and the move is an
  // edit. Only the title fallback stays container-scoped. Each member's
  // issues are flattened with the merge key of the container they sit in.
  type Placed = { issue: BoardIssue; container: string };
  const placedBy = new Map<string, Placed[]>();
  for (const m of have) {
    const list: Placed[] = [];
    for (const e of m.board?.epics ?? []) {
      for (const i of e.issues) list.push({ issue: i, container: boardKey(e) });
    }
    for (const i of m.board?.inbox ?? []) list.push({ issue: i, container: "inbox" });
    placedBy.set(m.slug, list);
  }
  const allIssues = mergeKeyed(
    have,
    (m) => placedBy.get(m.slug),
    (p) => (p.issue.id ? `id:${p.issue.id}` : `${p.container}|t:${normText(p.issue.title)}`),
    (p, slug): AggregatedBoardIssue => {
      const built = buildIssue(p.issue, slug);
      built.containerIn[slug] = p.container;
      return built;
    },
    (acc, p, slug) => {
      foldIssue(acc, p.issue, slug);
      acc.containerIn[slug] = p.container;
      const home = acc.containerIn[acc.presentIn[0]];
      if (p.container !== home && !acc.editedIn.includes(slug)) acc.editedIn.push(slug);
    }
  );
  // Place each merged issue where the headline (primary-first) location keeps it.
  const epicByKey = new Map(finalEpics.map((e) => [boardKey(e), e] as const));
  const inbox: AggregatedBoardIssue[] = [];
  for (const it of allIssues) {
    const home = it.containerIn[it.presentIn[0]];
    const epic = home === "inbox" ? undefined : epicByKey.get(home);
    (epic ? epic.issues : inbox).push(it);
  }
  for (const e of finalEpics) renumber(e.issues);
  renumber(inbox);

  // Divergence: presence gaps, and status disagreements.
  const partial = new Set<string>();
  const statusDiff = new Set<string>();
  const editDiff = new Set<string>();
  let partialCount = 0;
  let statusCount = 0;
  let editCount = 0;
  const check = (it: { presentIn: string[]; statusIn: Record<string, BoardStatus>; editedIn: string[] }) => {
    if (it.presentIn.length < have.length) {
      partialCount++;
      for (const m of have) if (!it.presentIn.includes(m.slug)) partial.add(m.slug);
    }
    const statuses = new Set(Object.values(it.statusIn));
    if (statuses.size > 1) {
      statusCount++;
      for (const s of it.presentIn) statusDiff.add(s);
    }
    if (it.editedIn.length > 0) {
      editCount++;
      for (const s of it.presentIn) editDiff.add(s);
    }
  };
  finalEpics.forEach(check);
  allIssues.forEach(check);
  if (partialCount > 0) {
    pushDiffers(divergences, "BOARD.md", partial, `${partialCount} board item${partialCount === 1 ? "" : "s"} not present in every location`);
  }
  if (statusCount > 0) {
    pushDiffers(divergences, "BOARD.md", statusDiff, `${statusCount} board item${statusCount === 1 ? "" : "s"} with a different status between locations`);
  }
  if (editCount > 0) {
    pushDiffers(divergences, "BOARD.md", editDiff, `${editCount} board item${editCount === 1 ? "" : "s"} edited differently between locations (title, priority, labels, detail, or container)`);
  }

  return {
    epics: finalEpics,
    inbox,
    total: finalEpics.length + allIssues.length,
  };
}

// ── MANUAL_STEPS.md ──────────────────────────────────────────────────────────

function aggregateManualSteps(
  ordered: readonly AggregatableProject[],
  divergences: Divergence[]
): AggregatedManualSteps | undefined {
  const have = withFile(ordered, "MANUAL_STEPS.md", (m) => m.manualSteps, divergences);
  if (have.length === 0) return undefined;

  type EntryAcc = AggregatedManualStepEntry & { sources: { slug: string; steps: AggregatedManualStep[] }[] };
  const entries = mergeKeyed(
    have,
    (m) => m.manualSteps?.entries,
    (e) => `${e.date}|${e.featureSlug}|${normText(e.title)}`,
    (e, slug): EntryAcc => ({
      date: e.date,
      featureSlug: e.featureSlug,
      title: e.title,
      note: e.note,
      steps: [],
      presentIn: [slug],
      noteIn: e.note === undefined ? {} : { [slug]: e.note },
      sources: [{ slug, steps: e.steps.map((s) => toStep(s, slug)) }],
    }),
    (acc, e, slug) => {
      acc.presentIn.push(slug);
      if (e.note !== undefined) acc.noteIn[slug] = e.note;
      acc.sources.push({ slug, steps: e.steps.map((s) => toStep(s, slug)) });
    }
  );

  const allSteps: AggregatedManualStep[] = [];
  const finalEntries: AggregatedManualStepEntry[] = entries.map((acc) => {
    const { sources, ...entry } = acc;
    const merged = new Map<string, AggregatedManualStep>();
    for (const { slug, steps } of sources) {
      const seen = new Map<string, number>();
      for (const s of steps) {
        const base = normText(s.text);
        const n = seen.get(base) ?? 0;
        seen.set(base, n + 1);
        const key = `${base}#${n}`;
        const existing = merged.get(key);
        if (existing) {
          existing.presentIn.push(slug);
          if (s.completed) existing.completedIn.push(slug);
          existing.detailsIn[slug] = s.details;
        } else {
          merged.set(key, s);
        }
      }
    }
    entry.steps = [...merged.values()];
    allSteps.push(...entry.steps);
    return entry;
  });

  // Presence gaps at the entry level count too — a whole entry only in one
  // checkout is the archive-vs-active case.
  const entryPartial = new Set<string>();
  let entryCount = 0;
  for (const e of finalEntries) {
    if (e.presentIn.length < have.length) {
      entryCount++;
      for (const m of have) if (!e.presentIn.includes(m.slug)) entryPartial.add(m.slug);
    }
  }
  if (entryCount > 0) {
    pushDiffers(divergences, "MANUAL_STEPS.md", entryPartial, `${entryCount} entr${entryCount === 1 ? "y" : "ies"} not present in every location`);
  }
  // Step-level ticks and entry notes are compared only within entries every
  // location has; otherwise the absence is already reported as the entry's.
  const sharedEntries = finalEntries.filter((e) => e.presentIn.length === have.length);
  const sharedSteps = sharedEntries.flatMap((e) => e.steps);
  tickDivergence(sharedSteps, have, "MANUAL_STEPS.md", "step", divergences);
  detailsDivergence(sharedSteps, "MANUAL_STEPS.md", "step", divergences);
  // A note present in one checkout and absent in another (an archive
  // explanation, say) is exactly the difference worth seeing, so absence
  // counts as a distinct value.
  const noteDiff = new Set<string>();
  let noteCount = 0;
  for (const e of sharedEntries) {
    const distinct = new Set(e.presentIn.map((slug) => normText(e.noteIn[slug] ?? "")));
    if (distinct.size > 1) {
      noteCount++;
      for (const slug of e.presentIn) noteDiff.add(slug);
    }
  }
  if (noteCount > 0) {
    pushDiffers(divergences, "MANUAL_STEPS.md", noteDiff, `${noteCount} entr${noteCount === 1 ? "y" : "ies"} with a different note between locations`);
  }

  const completedSteps = allSteps.filter((s) => s.completed).length;
  return {
    entries: finalEntries,
    totalSteps: allSteps.length,
    completedSteps,
    pendingSteps: allSteps.length - completedSteps,
  };
}

function toStep(s: { text: string; completed: boolean; details: string[] }, slug: string): AggregatedManualStep {
  return {
    text: normText(s.text),
    completed: s.completed,
    details: [...s.details],
    presentIn: [slug],
    completedIn: s.completed ? [slug] : [],
    detailsIn: { [slug]: [...s.details] },
  };
}

// ── OPERATIONS.md ────────────────────────────────────────────────────────────

function aggregateOperations(
  ordered: readonly AggregatableProject[],
  divergences: Divergence[]
): AggregatedOperations | undefined {
  const have = withFile(ordered, "OPERATIONS.md", (m) => m.operations, divergences);
  if (have.length === 0) return undefined;

  type SectionAcc = AggregatedOpsSection & { sources: { slug: string; items: AggregatedOpsItem[] }[] };
  const sections = mergeKeyed(
    have,
    (m) => m.operations?.sections,
    (s) => `${s.key}|${normText(s.heading)}`,
    (s, slug): SectionAcc => ({
      key: s.key,
      heading: s.heading,
      body: s.body,
      items: [],
      presentIn: [slug],
      bodyIn: { [slug]: s.body },
      sources: [{ slug, items: s.items.map((i) => toOpsItem(i, slug)) }],
    }),
    (acc, s, slug) => {
      acc.presentIn.push(slug);
      acc.bodyIn[slug] = s.body;
      acc.sources.push({ slug, items: s.items.map((i) => toOpsItem(i, slug)) });
    }
  );

  const allItems: AggregatedOpsItem[] = [];
  const finalSections: AggregatedOpsSection[] = sections.map((acc) => {
    const { sources, ...section } = acc;
    const merged = new Map<string, AggregatedOpsItem>();
    for (const { slug, items } of sources) {
      const seen = new Map<string, number>();
      for (const it of items) {
        const base = normText(it.text);
        const n = seen.get(base) ?? 0;
        seen.set(base, n + 1);
        const key = `${base}#${n}`;
        const existing = merged.get(key);
        if (existing) {
          existing.presentIn.push(slug);
          if (it.done) existing.doneIn.push(slug);
          existing.detailsIn[slug] = it.details;
        } else {
          merged.set(key, it);
        }
      }
    }
    section.items = [...merged.values()];
    allItems.push(...section.items);
    return section;
  });

  const sharedSections = finalSections.filter((s) => s.presentIn.length === have.length);
  tickDivergence(
    sharedSections.flatMap((s) => s.items).map((i) => ({ presentIn: i.presentIn, completedIn: i.doneIn })),
    have,
    "OPERATIONS.md",
    "runbook item",
    divergences
  );
  detailsDivergence(sharedSections.flatMap((s) => s.items), "OPERATIONS.md", "runbook item", divergences);
  // Section prose is operational instruction; a checkout whose wording
  // differs must not be silently dropped behind the primary's copy.
  const bodyDiff = new Set<string>();
  let bodyCount = 0;
  for (const sec of sharedSections) {
    const distinct = new Set(sec.presentIn.map((slug) => normText(sec.bodyIn[slug] ?? "")));
    if (distinct.size > 1) {
      bodyCount++;
      for (const slug of sec.presentIn) bodyDiff.add(slug);
    }
  }
  if (bodyCount > 0) {
    pushDiffers(divergences, "OPERATIONS.md", bodyDiff, `${bodyCount} section${bodyCount === 1 ? "" : "s"} with different prose between locations`);
  }
  const sectionPartial = new Set<string>();
  let sectionCount = 0;
  for (const s of finalSections) {
    if (s.presentIn.length < have.length) {
      sectionCount++;
      for (const m of have) if (!s.presentIn.includes(m.slug)) sectionPartial.add(m.slug);
    }
  }
  if (sectionCount > 0) {
    pushDiffers(divergences, "OPERATIONS.md", sectionPartial, `${sectionCount} section${sectionCount === 1 ? "" : "s"} not present in every location`);
  }

  const done = allItems.filter((i) => i.done).length;
  return { sections: finalSections, totalItems: allItems.length, pendingItems: allItems.length - done };
}

function toOpsItem(i: { text: string; done: boolean; details: string[] }, slug: string): AggregatedOpsItem {
  return {
    text: normText(i.text),
    done: i.done,
    details: [...i.details],
    presentIn: [slug],
    doneIn: i.done ? [slug] : [],
    detailsIn: { [slug]: [...i.details] },
  };
}

// ── Scalar repo-borne facts ──────────────────────────────────────────────────

function fact<T extends string | number>(
  ordered: readonly AggregatableProject[],
  file: RepoFile,
  label: string,
  pick: (m: AggregatableProject) => T | undefined,
  divergences: Divergence[]
): RepoFact<T> {
  const valueIn: { slug: string; value: T }[] = [];
  for (const m of ordered) {
    const v = pick(m);
    if (v !== undefined) valueIn.push({ slug: m.slug, value: v });
  }
  const distinct = new Set(valueIn.map((v) => v.value));
  const differs = distinct.size > 1;
  if (differs) {
    pushDiffers(
      divergences,
      file,
      new Set(valueIn.map((v) => v.slug)),
      `${label} differs between locations: ${[...distinct].map(String).sort(compareCodepoint).join(" vs ")}`
    );
  }
  // A fact defined in some locations and absent in others is a difference
  // too — "surface every difference" — and must not read as agreement.
  const lacking = ordered.filter((m) => pick(m) === undefined).map((m) => m.slug);
  const missing = valueIn.length > 0 && lacking.length > 0;
  if (missing) {
    divergences.push({
      file,
      kind: "missing",
      locations: [...lacking].sort(compareCodepoint),
      detail: `${label} is missing in ${lacking.length} of ${ordered.length} locations`,
    });
  }
  // valueIn is in primary-first order, so [0] is the headline.
  return { value: valueIn[0]?.value, valueIn, diverged: differs || missing };
}
