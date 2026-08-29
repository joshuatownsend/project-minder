import { describe, it, expect, vi, afterEach } from "vitest";
import type { UsageTurn } from "@/lib/usage/types";

/**
 * #515 — the streaming sweep must not change a single reported number.
 *
 * `generateUsageReport` used to flatten the whole corpus into one array and
 * hand it to `aggregateUsage`. It now folds one session at a time and releases
 * it, so the peak follows the cache budget instead of the corpus. The refactor
 * is only worth having if the report is byte-for-byte what it was, so that is
 * what is asserted: the same fixture through both shapes, compared whole.
 *
 * Comparing the WHOLE report, not a handful of headline fields. The fields most
 * at risk from a batching change are not the totals — those are sums, and sums
 * do not care how they are grouped. They are the ones whose order comes from
 * map INSERTION: `byModel`, `byProject`, `byCategory` and `topTools` all sort
 * by a single descending key, so equal-cost or equal-count entries are ordered
 * by whichever was seen first. A deep equality over the whole object is the
 * only assertion that covers those.
 */

const HOME = "/home/me/.claude";

function turn(over: Partial<UsageTurn> = {}): UsageTurn {
  return {
    sessionId: "s1",
    projectSlug: "app",
    projectDirName: "-home-me-dev-app",
    timestamp: "2026-03-01T10:00:00.000Z",
    role: "assistant",
    model: "claude-opus-5",
    inputTokens: 10,
    outputTokens: 20,
    cacheReadTokens: 0,
    cacheCreateTokens: 0,
    toolCalls: [],
    homeKey: HOME,
    ...over,
  } as UsageTurn;
}

/**
 * Several sessions, deliberately shaped so batching COULD change the answer if
 * it were done wrong: two models with identical cost (an insertion-order tie in
 * `byModel`), two projects, a sidechain turn, a user turn, and turns whose
 * timestamps interleave ACROSS sessions — the ordering the flat array had and
 * the per-session batches do not.
 */
function fixture(): Map<string, UsageTurn[]> {
  return new Map<string, UsageTurn[]>([
    [
      "s1",
      [
        turn({ sessionId: "s1", role: "user", inputTokens: 0, outputTokens: 0 }),
        turn({ sessionId: "s1", timestamp: "2026-03-01T10:00:00.000Z" }),
        turn({ sessionId: "s1", timestamp: "2026-03-01T12:00:00.000Z", model: "claude-sonnet-5" }),
      ],
    ],
    [
      "s2",
      [
        // Interleaves with s1 in wall-clock time.
        turn({ sessionId: "s2", timestamp: "2026-03-01T11:00:00.000Z", projectSlug: "other", projectDirName: "-home-me-dev-other" }),
        turn({ sessionId: "s2", timestamp: "2026-03-01T13:00:00.000Z", projectSlug: "other", projectDirName: "-home-me-dev-other", isSidechain: true }),
      ],
    ],
    [
      "s3",
      [
        turn({ sessionId: "s3", timestamp: "2026-03-02T09:00:00.000Z", toolCalls: [{ name: "Edit" }] as UsageTurn["toolCalls"] }),
        turn({ sessionId: "s3", timestamp: "2026-03-02T09:05:00.000Z", toolCalls: [{ name: "Bash" }] as UsageTurn["toolCalls"] }),
      ],
    ],
  ]);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("#515 — streaming the sweep changes no reported number", () => {
  it("produces the same report as aggregating one flat array", async () => {
    vi.resetModules();
    const sessionMap = fixture();

    vi.doMock("@/lib/usage/parser", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@/lib/usage/parser")>()),
      parseAllSessions: vi.fn(async () => sessionMap),
      streamAllSessions: vi.fn(
        async (
          visit: (id: string, turns: UsageTurn[]) => void | Promise<void>,
          options: { includeSidechains?: boolean } = {}
        ) => {
          for (const [id, turns] of sessionMap) {
            const projected = options.includeSidechains
              ? turns
              : turns.filter((t) => !t.isSidechain);
            if (projected.length > 0) await visit(id, projected);
          }
        }
      ),
    }));
    // No scan cache in a unit test, so `augmentPortfolioYield` no-ops — which is
    // what keeps this test about the aggregation rather than about git.
    vi.doMock("@/lib/cache", () => ({ getCachedScan: () => null }));

    const { generateUsageReport, aggregateUsage } = await import("@/lib/usage/aggregator");
    const { bucketByHourDay } = await import("@/lib/usage/activityBuckets");
    const { computeStreaks } = await import("@/lib/usage/streaks");
    const { computeContributionCalendar } = await import("@/lib/usage/contributionCalendar");

    const streamed = await generateUsageReport("all");

    // The pre-#515 shape, reproduced here: flatten in map order, take activity
    // from the full history's primary assistant turns, then aggregate.
    const flat: UsageTurn[] = [];
    for (const turns of sessionMap.values()) flat.push(...turns);
    const activityTurns = flat.filter((t) => t.role === "assistant" && !t.isSidechain);
    const collected = await aggregateUsage(flat, "all", {
      ...bucketByHourDay(activityTurns),
      streak: computeStreaks(activityTurns),
      contributionCalendar: computeContributionCalendar(activityTurns),
    });

    // `generatedAt` is a wall-clock stamp taken inside each call, so the two
    // differ by the milliseconds between them. It is the ONLY field excluded,
    // and it is excluded by deleting it from both rather than by comparing a
    // hand-picked subset — a subset comparison is how a refactor like this
    // quietly changes a field nobody thought to list.
    const strip = (r: Record<string, unknown>) => {
      const { generatedAt: _drop, ...rest } = r;
      return rest;
    };
    expect(strip(streamed as unknown as Record<string, unknown>)).toEqual(
      strip(collected as unknown as Record<string, unknown>)
    );
  });

  it("applies the project scope, and applies it before the period cut", async () => {
    // The equivalence test above runs UNSCOPED, so deleting the project filter
    // outright still passed it — and passed the home-filter test too, where the
    // home discriminator alone happens to select the same single turn. A filter
    // no test exercises is a filter that can be removed silently, which is how
    // this one nearly was.
    //
    // Scoped to `other`, which owns exactly one primary turn and one sidechain
    // turn, so a leak of the `app` project's three turns is unmissable.
    vi.resetModules();
    const sessionMap = fixture();
    vi.doMock("@/lib/usage/parser", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@/lib/usage/parser")>()),
      streamAllSessions: vi.fn(
        async (
          visit: (id: string, turns: UsageTurn[]) => void | Promise<void>,
          options: { includeSidechains?: boolean } = {}
        ) => {
          for (const [id, turns] of sessionMap) {
            const projected = options.includeSidechains
              ? turns
              : turns.filter((t) => !t.isSidechain);
            if (projected.length > 0) await visit(id, projected);
          }
        }
      ),
    }));
    vi.doMock("@/lib/cache", () => ({ getCachedScan: () => null }));

    const { generateUsageReport, aggregateUsage } = await import("@/lib/usage/aggregator");
    const { bucketByHourDay } = await import("@/lib/usage/activityBuckets");
    const { computeStreaks } = await import("@/lib/usage/streaks");
    const { computeContributionCalendar } = await import("@/lib/usage/contributionCalendar");

    const scoped = await generateUsageReport("all", "other");

    const flat: UsageTurn[] = [];
    for (const turns of sessionMap.values()) flat.push(...turns);
    const mine = flat.filter((t) => t.projectSlug === "other");
    // Activity comes from the SCOPED full history — the ordering the streaming
    // path has to reproduce is project-filter first, activity second, period
    // last.
    const activityTurns = mine.filter((t) => t.role === "assistant" && !t.isSidechain);
    const collected = await aggregateUsage(mine, "all", {
      ...bucketByHourDay(activityTurns),
      streak: computeStreaks(activityTurns),
      contributionCalendar: computeContributionCalendar(activityTurns),
    });

    const strip = (r: Record<string, unknown>) => {
      const { generatedAt: _drop, ...rest } = r;
      return rest;
    };
    expect(strip(scoped as unknown as Record<string, unknown>)).toEqual(
      strip(collected as unknown as Record<string, unknown>)
    );
    // Independently of the comparison: the other project's turns are absent.
    expect(scoped.byProject.map((p) => p.projectSlug)).toEqual(["other"]);
  });

  it("streams the sweep instead of materializing it", async () => {
    // The property that makes the peak bounded, asserted structurally rather
    // than by a heap measurement a unit test cannot take reliably: the report
    // reaches the corpus through `streamAllSessions` and never through the
    // map-returning `parseAllSessions`. A future change that re-collected the
    // sweep into a map before aggregating would still satisfy the equivalence
    // test above — the numbers would all be right — and fail this one.
    vi.resetModules();
    const sessionMap = fixture();
    const parseAll = vi.fn(async () => sessionMap);
    const streamAll = vi.fn(
      async (
        visit: (id: string, turns: UsageTurn[]) => void | Promise<void>,
        options: { includeSidechains?: boolean } = {}
      ) => {
        for (const [id, turns] of sessionMap) {
          const projected = options.includeSidechains
            ? turns
            : turns.filter((t) => !t.isSidechain);
          if (projected.length > 0) await visit(id, projected);
        }
      }
    );
    vi.doMock("@/lib/usage/parser", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@/lib/usage/parser")>()),
      parseAllSessions: parseAll,
      streamAllSessions: streamAll,
    }));
    // Scan cache null, so `augmentPortfolioYield` returns before its own sweep
    // — this test is about the report path.
    vi.doMock("@/lib/cache", () => ({ getCachedScan: () => null }));

    const { generateUsageReport } = await import("@/lib/usage/aggregator");
    const report = await generateUsageReport("all");

    expect(streamAll).toHaveBeenCalled();
    expect(parseAll).not.toHaveBeenCalled();
    // And it actually consumed what it streamed, so the assertions above are
    // about a working report rather than an empty one.
    expect(report.totalTurns).toBeGreaterThan(0);
  });
});
