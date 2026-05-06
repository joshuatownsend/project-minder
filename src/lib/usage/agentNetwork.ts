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

  // Project OrchNode instances by agentName — collapse multiple invocations
  const nodeCountByName = new Map<string, number>();
  for (const node of graph.nodes) {
    const name = node.agentName ?? node.toolName ?? node.id;
    nodeCountByName.set(name, (nodeCountByName.get(name) ?? 0) + 1);
  }

  // Count sidechain turns per agentName
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

  const messageCounts = new Map<string, number>();
  for (const turn of turns) {
    if (!turn.isSidechain || !turn.parentToolUseId) continue;
    const agentName = agentByToolUseId.get(turn.parentToolUseId) ?? "subagent";
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
  const nodeIdToName = new Map<string, string>();
  for (const node of graph.nodes) {
    nodeIdToName.set(node.id, node.agentName ?? node.toolName ?? node.id);
  }

  const edgeMap = new Map<string, number>();

  // Root nodes → edge from "main"
  const rootIds = new Set(
    graph.nodes
      .filter((n) => !graph.edges.some((e) => e.to === n.id))
      .map((n) => n.id)
  );
  for (const rootId of rootIds) {
    if (rootId.startsWith("__overflow__")) continue;
    const childName = nodeIdToName.get(rootId);
    if (!childName) continue;
    const key = `${MAIN}\0${childName}`;
    edgeMap.set(key, (edgeMap.get(key) ?? 0) + 1);
  }

  // Existing graph edges → map to agent names, drop self-loops
  for (const edge of graph.edges) {
    if (edge.from.startsWith("__overflow__") || edge.to.startsWith("__overflow__")) continue;
    const fromName = nodeIdToName.get(edge.from);
    const toName = nodeIdToName.get(edge.to);
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
