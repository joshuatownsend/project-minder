import type { UsageTurn } from "./types";
import type { ToolTransition, ToolSelfLoop } from "./types";

export function computeToolTransitions(
  turns: UsageTurn[]
): { transitions: ToolTransition[]; selfLoops: ToolSelfLoop[] } {
  const transMap = new Map<string, number>();
  const loopMap = new Map<string, number>();

  // Sort by (sessionId, timestamp) to process per-session in order
  const sorted = [...turns].sort((a, b) => {
    if (a.sessionId !== b.sessionId) return a.sessionId.localeCompare(b.sessionId);
    return a.timestamp.localeCompare(b.timestamp);
  });

  let prevSessionId = "";
  let prevLastTool = "";

  for (const turn of sorted) {
    const tools = turn.toolCalls.map((tc) => tc.name);
    if (tools.length === 0) {
      if (turn.sessionId !== prevSessionId) {
        prevSessionId = turn.sessionId;
        prevLastTool = "";
      }
      continue;
    }

    // Session boundary: reset inter-turn state
    if (turn.sessionId !== prevSessionId) {
      prevSessionId = turn.sessionId;
      prevLastTool = "";
    }

    // Inter-turn: last tool of previous turn → first tool of this turn
    if (prevLastTool && prevLastTool !== tools[0]) {
      const key = `${prevLastTool}\0${tools[0]}`;
      transMap.set(key, (transMap.get(key) ?? 0) + 1);
    } else if (prevLastTool && prevLastTool === tools[0]) {
      loopMap.set(prevLastTool, (loopMap.get(prevLastTool) ?? 0) + 1);
    }

    // Intra-turn: consecutive tool pairs within the same turn
    for (let i = 0; i < tools.length - 1; i++) {
      const from = tools[i];
      const to = tools[i + 1];
      if (from === to) {
        loopMap.set(from, (loopMap.get(from) ?? 0) + 1);
      } else {
        const key = `${from}\0${to}`;
        transMap.set(key, (transMap.get(key) ?? 0) + 1);
      }
    }

    prevLastTool = tools[tools.length - 1];
  }

  const transitions: ToolTransition[] = [...transMap.entries()]
    .map(([key, count]) => {
      const [from, to] = key.split("\0");
      return { from, to, count };
    })
    .sort((a, b) => b.count - a.count)
    .slice(0, 200);

  const selfLoops: ToolSelfLoop[] = [...loopMap.entries()]
    .map(([tool, count]) => ({ tool, count }))
    .sort((a, b) => b.count - a.count);

  return { transitions, selfLoops };
}
