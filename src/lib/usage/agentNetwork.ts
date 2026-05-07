import type { UsageTurn } from "./types";
import { buildGraph } from "./orchestrationGraph";

export interface NetworkNode {
  id: string;
  name: string;
  messageCount: number;
}

export interface NetworkEdge {
  from: string;
  to: string;
  weight: number;
}

export interface NetworkReport {
  nodes: NetworkNode[];
  edges: NetworkEdge[];
}

export function buildAgentNetwork(turns: UsageTurn[]): NetworkReport {
  const graph = buildGraph(turns);

  if (graph.nodes.length === 0) return { nodes: [], edges: [] };

  // Build nodeId → agentName from the graph (covers all depths, including nested subagents)
  const nodeIdToAgentName = new Map<string, string>();
  for (const node of graph.nodes) {
    if (node.id.startsWith("__overflow__")) continue;
    nodeIdToAgentName.set(node.id, node.agentName ?? node.toolName ?? node.id);
  }

  // Count sidechain turns per agentName using the graph-derived map
  const messageCounts = new Map<string, number>();
  for (const turn of turns) {
    if (!turn.isSidechain || !turn.parentToolUseId) continue;
    const agentName = nodeIdToAgentName.get(turn.parentToolUseId) ?? "subagent";
    messageCounts.set(agentName, (messageCounts.get(agentName) ?? 0) + 1);
  }

  // Build projected node set
  const nodeNames = new Set<string>();
  for (const node of graph.nodes) {
    if (node.id.startsWith("__overflow__")) continue;
    const name = node.agentName ?? node.toolName ?? node.id;
    nodeNames.add(name);
  }

  const MAIN = "main";
  nodeNames.add(MAIN);

  const nodes: NetworkNode[] = [...nodeNames].map((name) => ({
    id: name,
    name,
    messageCount: messageCounts.get(name) ?? 0,
  }));

  // Build projected edge set: for each OrchEdge, map nodeIds → agentNames
  // (reuse nodeIdToAgentName built above)

  const edgeMap = new Map<string, number>();

  // Root nodes → edge from "main"
  const rootIds = new Set(
    graph.nodes
      .filter((n) => !graph.edges.some((e) => e.to === n.id))
      .map((n) => n.id)
  );
  for (const rootId of rootIds) {
    if (rootId.startsWith("__overflow__")) continue;
    const childName = nodeIdToAgentName.get(rootId);
    if (!childName) continue;
    const key = `${MAIN}\0${childName}`;
    edgeMap.set(key, (edgeMap.get(key) ?? 0) + 1);
  }

  // Existing graph edges → map to agent names, drop self-loops
  for (const edge of graph.edges) {
    if (edge.from.startsWith("__overflow__") || edge.to.startsWith("__overflow__")) continue;
    const fromName = nodeIdToAgentName.get(edge.from);
    const toName = nodeIdToAgentName.get(edge.to);
    if (!fromName || !toName || fromName === toName) continue;
    const key = `${fromName}\0${toName}`;
    edgeMap.set(key, (edgeMap.get(key) ?? 0) + 1);
  }

  const edges: NetworkEdge[] = [];
  for (const [key, weight] of edgeMap) {
    const sep = key.indexOf("\0");
    edges.push({ from: key.slice(0, sep), to: key.slice(sep + 1), weight });
  }

  return { nodes, edges };
}
