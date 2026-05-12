import { findSessionFile, parseSessionTurns } from "./parser";
import type { UsageTurn } from "./types";

export interface OrchNode {
  id: string;
  toolName: string;
  agentName?: string;
  depth: number;
  status?: "ok" | "error";
  /** Catalog decoration — populated by the /api/agent-view/tree route when a
   *  matching agent definition is found. Not present for unknown agents. */
  catalogEmoji?: string;
  catalogColor?: string;
  catalogDescription?: string;
}

export interface OrchEdge {
  from: string;
  to: string;
}

export interface OrchestrationGraph {
  nodes: OrchNode[];
  edges: OrchEdge[];
  rootCount: number;
}

const MAX_DEPTH = 6;

export function buildGraph(turns: UsageTurn[]): OrchestrationGraph {
  // Pass 1: tool_use_id → agentName (from non-sidechain Agent tool calls)
  const agentByToolUseId = new Map<string, string>();
  for (const turn of turns) {
    if (turn.isSidechain) continue;
    for (const tc of turn.toolCalls) {
      if (tc.name === "Agent" && tc.id) {
        const agentName =
          (tc.arguments?.subagent_type as string | undefined) ??
          (tc.arguments?.agent as string | undefined);
        if (agentName) agentByToolUseId.set(tc.id, agentName);
      }
    }
  }

  // Pass 2: collect sidechain turns, group by parentToolUseId
  const sidechainTurns = turns.filter((t) => t.isSidechain && t.parentToolUseId);

  if (sidechainTurns.length === 0 && agentByToolUseId.size === 0) {
    return { nodes: [], edges: [], rootCount: 0 };
  }

  // Each unique parentToolUseId is a spawned agent node.
  // parentToolUseId points to the Agent tool_use in the parent context.
  // We need to find the parent of each node to build edges.
  // A sidechain turn's parentToolUseId is the tool_use_id of the Task() call that spawned it.
  // If that parentToolUseId itself is a sidechain turn's parentToolUseId, it's a nested agent.

  // Build a map: nodeId → { agentName, hasError, parentId }
  interface NodeAccum {
    agentName?: string;
    hasError: boolean;
    // The tool_use_id in the *parent* context that spawned THIS node's agent.
    // For root nodes: no parent (spawned from main conversation).
    parentNodeId?: string;
  }

  const nodeAccum = new Map<string, NodeAccum>();

  // First, process all sidechain turns to find nested spawns (Agent calls within sidechains)
  const childByToolUseId = new Map<string, string>(); // tool_use_id → agentName (within sidechains)
  for (const turn of sidechainTurns) {
    for (const tc of turn.toolCalls) {
      if (tc.name === "Agent" && tc.id) {
        const agentName =
          (tc.arguments?.subagent_type as string | undefined) ??
          (tc.arguments?.agent as string | undefined);
        if (agentName) childByToolUseId.set(tc.id, agentName);
      }
    }
  }

  // Build node accumulators from sidechain turns
  for (const turn of sidechainTurns) {
    const nodeId = turn.parentToolUseId!;
    if (!nodeAccum.has(nodeId)) {
      nodeAccum.set(nodeId, {
        agentName: agentByToolUseId.get(nodeId) ?? childByToolUseId.get(nodeId),
        hasError: false,
      });
    }
    if (turn.isError) {
      nodeAccum.get(nodeId)!.hasError = true;
    }
  }

  // Assign parentNodeId for nested agents: if a tool_use_id appears as a childByToolUseId
  // it was spawned from a sidechain turn whose own parentToolUseId is the parent node.
  // Map: childToolUseId → parentNodeId (the parentToolUseId of the sidechain turn that called Agent)
  const childToParentNode = new Map<string, string>();
  for (const turn of sidechainTurns) {
    for (const tc of turn.toolCalls) {
      if (tc.name === "Agent" && tc.id) {
        childToParentNode.set(tc.id, turn.parentToolUseId!);
      }
    }
  }

  for (const [nodeId, accum] of nodeAccum) {
    const parentNode = childToParentNode.get(nodeId);
    if (parentNode) accum.parentNodeId = parentNode;
  }

  // Pre-build children lookup to avoid O(n²) BFS scan
  const childrenByParentId = new Map<string, string[]>();
  for (const [id, accum] of nodeAccum) {
    if (accum.parentNodeId) {
      const arr = childrenByParentId.get(accum.parentNodeId);
      if (arr) arr.push(id);
      else childrenByParentId.set(accum.parentNodeId, [id]);
    }
  }

  // BFS to assign depths, capped at MAX_DEPTH
  const depthMap = new Map<string, number>();
  const roots = [...nodeAccum.keys()].filter((id) => !nodeAccum.get(id)!.parentNodeId);
  const queue: { id: string; depth: number }[] = roots.map((id) => ({ id, depth: 0 }));
  while (queue.length > 0) {
    const { id, depth } = queue.shift()!;
    depthMap.set(id, depth);
    for (const childId of childrenByParentId.get(id) ?? []) {
      if (!depthMap.has(childId)) queue.push({ id: childId, depth: depth + 1 });
    }
  }

  // Build nodes, applying depth cap
  const nodes: OrchNode[] = [];
  const skippedByParent = new Map<string, number>(); // parentId → count of capped children

  for (const [id, accum] of nodeAccum) {
    const depth = depthMap.get(id) ?? 0;
    if (depth > MAX_DEPTH) {
      const parentId = accum.parentNodeId ?? "__root__";
      skippedByParent.set(parentId, (skippedByParent.get(parentId) ?? 0) + 1);
      continue;
    }
    nodes.push({
      id,
      toolName: "Agent",
      agentName: accum.agentName,
      depth,
      status: accum.hasError ? "error" : "ok",
    });
  }

  // Add "+N more" placeholder nodes for depth-capped children
  for (const [parentId, count] of skippedByParent) {
    const parentDepth = depthMap.get(parentId) ?? MAX_DEPTH;
    nodes.push({
      id: `__overflow__${parentId}`,
      toolName: `+${count} more`,
      depth: parentDepth + 1,
    });
  }

  // Build edges
  const edges: OrchEdge[] = [];
  const nodeIds = new Set(nodes.map((n) => n.id));
  for (const [id, accum] of nodeAccum) {
    if (!nodeIds.has(id)) continue;
    if (accum.parentNodeId && nodeIds.has(accum.parentNodeId)) {
      edges.push({ from: accum.parentNodeId, to: id });
    }
  }
  // Edges to overflow placeholders
  for (const [parentId] of skippedByParent) {
    const overflowId = `__overflow__${parentId}`;
    if (nodeIds.has(overflowId) && nodeIds.has(parentId)) {
      edges.push({ from: parentId, to: overflowId });
    }
  }

  return { nodes, edges, rootCount: roots.length };
}

export async function loadOrchestrationGraph(
  sessionId: string
): Promise<OrchestrationGraph | null> {
  const found = await findSessionFile(sessionId);
  if (!found) return null;
  const turns = await parseSessionTurns(found.filePath, found.projectDirName, { includeSidechains: true });
  return buildGraph(turns);
}
