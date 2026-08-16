import type { StatsCache, StatsCacheDay } from "@/lib/scanner/claudeStats";

/**
 * Synthetic `~/.claude/stats-cache.json` for demo mode.
 *
 * The real file is Claude Code's own aggregate counter, and `/api/stats`
 * cross-checks our independently-parsed totals against it. Under demo mode the
 * loader returns null (see `getStatsCache`), so without a fixture the panel
 * simply disappears — correct, but demo mode exists to look alive.
 *
 * **Derived from the observed totals rather than from the session seeds.** The
 * two cross-check rows are fed by two *independent* demo sources — sessions
 * from the project scan, messages from the session fixtures — so a fixture with
 * hand-tuned constants would drift out of agreement the moment either source
 * changed, and render the red "-91%" panel that `capture-screenshots-hybrid.mjs`
 * already refuses to promote. Deriving from what was observed makes the drift
 * small by construction, whatever the fixtures later become.
 *
 * The small deliberate gap is the honest shape of the real thing: Claude's
 * counter runs slightly ahead of ours because it counts sessions we skip.
 */
export function demoStatsCache(
  observed: { sessions: number; messages: number | null },
  nowMs: number
): StatsCache {
  const sessions = ahead(observed.sessions, 0.03);
  const messages = observed.messages === null ? undefined : ahead(observed.messages, 0.02);

  return {
    version: 1,
    lastComputedDate: new Date(nowMs).toISOString().slice(0, 10),
    totalSessions: sessions,
    totalMessages: messages,
    dailyActivity: dailyActivity(sessions, messages ?? sessions * 24, nowMs),
  };
}

/**
 * `n` nudged up by `pct`, rounded.
 *
 * Deliberately has NO minimum-of-1 floor. An earlier version forced at least +1
 * so the panel would never show a perfectly round zero, which is fine at scale
 * and badly wrong below it: 1 observed session became a fixture of 2, i.e. a
 * −50% drift — the exact red panel this fixture exists to avoid. The drift is
 * consumed as a *ratio*, so an absolute floor cannot be safe across magnitudes.
 * Small demo datasets now show 0% drift, which is an honest reading: with a
 * handful of sessions, exact agreement is what you would expect to see.
 */
function ahead(n: number, pct: number): number {
  if (n <= 0) return 0;
  return n + Math.round(n * pct);
}

/** 14 days of deterministic activity, weighted toward the recent end so the
 *  shape reads as a working week rather than a flat line. */
function dailyActivity(sessions: number, messages: number, nowMs: number): StatsCacheDay[] {
  const DAYS = 14;
  // Fixed weights — no randomness, so repeated captures are byte-identical.
  const weights = [3, 5, 8, 6, 9, 4, 2, 7, 10, 8, 11, 9, 12, 6];
  const total = weights.reduce((a, b) => a + b, 0);
  const out: StatsCacheDay[] = [];

  for (let i = 0; i < DAYS; i++) {
    const share = weights[i] / total;
    const date = new Date(nowMs - (DAYS - 1 - i) * 86_400_000).toISOString().slice(0, 10);
    out.push({
      date,
      messageCount: Math.round(messages * share),
      sessionCount: Math.max(1, Math.round(sessions * share)),
      toolCallCount: Math.round(messages * share * 1.8),
    });
  }
  return out;
}
