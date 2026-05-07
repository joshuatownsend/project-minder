import type { UsageTurn } from "./types";

export interface TimelineBar {
  agentName: string;
  /** toolUseId that spawned this sidechain, or "__main__" */
  nodeId: string;
  turnCount: number;
  startPct: number;
  endPct: number;
}

export interface TimelineReport {
  bars: TimelineBar[];
  usedFallback: boolean;
}

export function buildConcurrencyTimeline(turns: UsageTurn[]): TimelineReport {
  // Pass 1: tool_use_id → agentName from main-thread Agent calls
  const agentByToolUseId = new Map<string, string>();
  for (const turn of turns) {
    if (turn.isSidechain) continue;
    for (const tc of turn.toolCalls) {
      if (tc.name === "Agent" && tc.id) {
        const name =
          (tc.arguments?.subagent_type as string | undefined) ??
          (tc.arguments?.agent as string | undefined);
        if (name) agentByToolUseId.set(tc.id, name);
      }
    }
  }

  // Pass 2: group sidechain turns by parentToolUseId
  interface Group {
    agentName: string;
    turnCount: number;
    firstTs?: number;
    lastTs?: number;
    firstIdx: number;
    lastIdx: number;
  }

  const groups = new Map<string, Group>();
  const turnIndex = new Map(turns.map((t, i) => [t, i]));
  const mainTurns = turns.filter((t) => !t.isSidechain);

  for (let i = 0; i < turns.length; i++) {
    const t = turns[i];
    if (!t.isSidechain || !t.parentToolUseId) continue;
    const id = t.parentToolUseId;
    const ts = t.timestamp ? Date.parse(t.timestamp) : NaN;
    const existing = groups.get(id);
    if (!existing) {
      groups.set(id, {
        agentName: agentByToolUseId.get(id) ?? "subagent",
        turnCount: 1,
        firstTs: isNaN(ts) ? undefined : ts,
        lastTs: isNaN(ts) ? undefined : ts,
        firstIdx: i,
        lastIdx: i,
      });
    } else {
      existing.turnCount++;
      if (!isNaN(ts)) {
        if (existing.firstTs === undefined || ts < existing.firstTs) existing.firstTs = ts;
        if (existing.lastTs === undefined || ts > existing.lastTs) existing.lastTs = ts;
      }
      if (i > existing.lastIdx) existing.lastIdx = i;
      if (i < existing.firstIdx) existing.firstIdx = i;
    }
  }

  if (groups.size === 0) return { bars: [], usedFallback: false };

  // Main agent bar
  const mainTs = mainTurns
    .map((t) => (t.timestamp ? Date.parse(t.timestamp) : NaN))
    .filter((n) => !isNaN(n));
  const mainMinTs = mainTs.length ? Math.min(...mainTs) : NaN;
  const mainMaxTs = mainTs.length ? Math.max(...mainTs) : NaN;

  // Check if we have usable wall-clock timestamps
  const allHaveTs = [...groups.values()].every(
    (g) => g.firstTs !== undefined && g.lastTs !== undefined
  );
  const useTimestamps = allHaveTs && !isNaN(mainMinTs) && mainMaxTs > mainMinTs;
  const usedFallback = !useTimestamps;

  let globalMin: number;
  let globalMax: number;

  if (useTimestamps) {
    const allMin = [...groups.values()].map((g) => g.firstTs!);
    const allMax = [...groups.values()].map((g) => g.lastTs!);
    globalMin = Math.min(mainMinTs, ...allMin);
    globalMax = Math.max(mainMaxTs, ...allMax);
  } else {
    globalMin = 0;
    globalMax = turns.length - 1;
  }

  const span = globalMax - globalMin || 1;

  const pct = (v: number) => Math.max(0, Math.min(100, ((v - globalMin) / span) * 100));

  const bars: TimelineBar[] = [];

  // Main bar
  if (useTimestamps && !isNaN(mainMinTs)) {
    bars.push({
      agentName: "main",
      nodeId: "__main__",
      turnCount: mainTurns.length,
      startPct: pct(mainMinTs),
      endPct: pct(mainMaxTs),
    });
  } else {
    const mainIdxs = mainTurns.map((t) => turnIndex.get(t) ?? -1).filter((i) => i >= 0);
    const minIdx = mainIdxs.length ? Math.min(...mainIdxs) : 0;
    const maxIdx = mainIdxs.length ? Math.max(...mainIdxs) : turns.length - 1;
    bars.push({
      agentName: "main",
      nodeId: "__main__",
      turnCount: mainTurns.length,
      startPct: pct(minIdx),
      endPct: pct(maxIdx),
    });
  }

  // Sidechain bars
  for (const [id, g] of groups) {
    const startV = useTimestamps ? g.firstTs! : g.firstIdx;
    const endV = useTimestamps ? g.lastTs! : g.lastIdx;
    bars.push({
      agentName: g.agentName,
      nodeId: id,
      turnCount: g.turnCount,
      startPct: pct(startV),
      endPct: pct(endV),
    });
  }

  return { bars, usedFallback };
}
