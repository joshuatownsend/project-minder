import type { UsageTurn } from "./types";

export interface DelegationEdge {
  from: string;
  to: string;
  count: number;
  tokens: number;
}

export interface DelegationReport {
  edges: DelegationEdge[];
  parentModels: string[];
  childModels: string[];
}

export function buildModelDelegation(turns: UsageTurn[]): DelegationReport {
  // Pass 1: tool_use_id → model of the assistant turn that called Agent (all depths)
  const modelByToolUseId = new Map<string, string>();
  for (const turn of turns) {
    if (turn.role !== "assistant") continue;
    for (const tc of turn.toolCalls) {
      if (tc.name === "Agent" && tc.id) {
        modelByToolUseId.set(tc.id, turn.model ?? "unknown");
      }
    }
  }

  // Pass 2: for each sidechain turn, find parent model via parentToolUseId
  // Accumulate (parentModel, childModel) → { count, tokens }
  const edgeMap = new Map<string, { count: number; tokens: number }>();

  for (const turn of turns) {
    if (!turn.isSidechain || !turn.parentToolUseId) continue;
    const parentModel = modelByToolUseId.get(turn.parentToolUseId);
    if (!parentModel) continue;
    const childModel = turn.model ?? "unknown";
    const key = `${parentModel}\0${childModel}`;
    const existing = edgeMap.get(key);
    const tokens = (turn.inputTokens ?? 0) + (turn.outputTokens ?? 0);
    if (existing) {
      existing.count++;
      existing.tokens += tokens;
    } else {
      edgeMap.set(key, { count: 1, tokens });
    }
  }

  const edges: DelegationEdge[] = [];
  const parentSet = new Set<string>();
  const childSet = new Set<string>();

  for (const [key, { count, tokens }] of edgeMap) {
    const sep = key.indexOf("\0");
    const from = key.slice(0, sep);
    const to = key.slice(sep + 1);
    edges.push({ from, to, count, tokens });
    parentSet.add(from);
    childSet.add(to);
  }

  edges.sort((a, b) => b.count - a.count);

  return {
    edges,
    parentModels: [...parentSet],
    childModels: [...childSet],
  };
}
