import { promises as fs } from "fs";
import path from "path";
import os from "os";
import { parseSessionTurns } from "./parser";
import { buildGraph } from "./orchestrationGraph";
import { encodeProjectPath } from "./projectMatch";

export interface DepthBucket {
  depth: number;
  errors: number;
  total: number;
  rate: number;
}

export interface AgentErrorStats {
  name: string;
  errors: number;
  total: number;
  rate: number;
}

export interface ToolErrorStats {
  tool: string;
  errors: number;
  total: number;
}

export interface ErrorReport {
  summary: {
    totalNodes: number;
    totalErrors: number;
    errorRate: number;
    sessionCount: number;
  };
  byDepth: DepthBucket[];
  topAgents: AgentErrorStats[];
  byTool: ToolErrorStats[];
}

export async function buildErrorPropagation(
  projectPath: string
): Promise<ErrorReport> {
  const projectDirName = encodeProjectPath(projectPath);
  const projectsDir = path.join(os.homedir(), ".claude", "projects");
  const projectDir = path.join(projectsDir, projectDirName);

  let files: string[] = [];
  try {
    const entries = await fs.readdir(projectDir);
    files = entries
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => path.join(projectDir, f));
  } catch {
    return emptyReport();
  }

  if (files.length === 0) return emptyReport();

  const depthErrors = new Map<number, { errors: number; total: number }>();
  const agentErrors = new Map<string, { errors: number; total: number }>();
  const toolErrors = new Map<string, { errors: number; total: number }>();
  let sessionCount = 0;

  for (const filePath of files) {
    try {
      const turns = await parseSessionTurns(filePath, projectDirName, {
        includeSidechains: true,
      });
      if (turns.length === 0) continue;
      sessionCount++;

      const graph = buildGraph(turns);

      for (const node of graph.nodes) {
        if (node.id.startsWith("__overflow__")) continue;
        const depth = node.depth;

        const bucket = depthErrors.get(depth) ?? { errors: 0, total: 0 };
        bucket.total++;
        if (node.status === "error") bucket.errors++;
        depthErrors.set(depth, bucket);

        const agentName = node.agentName ?? "unknown";
        const aBucket = agentErrors.get(agentName) ?? { errors: 0, total: 0 };
        aBucket.total++;
        if (node.status === "error") aBucket.errors++;
        agentErrors.set(agentName, aBucket);
      }

      // Tool error breakdown from sidechain turns
      for (const turn of turns) {
        if (!turn.isSidechain) continue;
        for (const tc of turn.toolCalls) {
          const tBucket = toolErrors.get(tc.name) ?? { errors: 0, total: 0 };
          tBucket.total++;
          toolErrors.set(tc.name, tBucket);
        }
        // Count tool_result errors — isError flag on the turn level
        if (turn.isError) {
          for (const tc of turn.toolCalls) {
            const tBucket = toolErrors.get(tc.name)!;
            if (tBucket) tBucket.errors++;
          }
        }
      }
    } catch {
      // Skip unreadable sessions
    }
  }

  const byDepth: DepthBucket[] = [...depthErrors.entries()]
    .map(([depth, { errors, total }]) => ({
      depth,
      errors,
      total,
      rate: total > 0 ? errors / total : 0,
    }))
    .sort((a, b) => a.depth - b.depth);

  const topAgents: AgentErrorStats[] = [...agentErrors.entries()]
    .filter(([, { total }]) => total >= 3)
    .map(([name, { errors, total }]) => ({
      name,
      errors,
      total,
      rate: total > 0 ? errors / total : 0,
    }))
    .sort((a, b) => b.errors - a.errors)
    .slice(0, 10);

  const byTool: ToolErrorStats[] = [...toolErrors.entries()]
    .filter(([, { total }]) => total >= 2)
    .map(([tool, { errors, total }]) => ({ tool, errors, total }))
    .sort((a, b) => b.errors - a.errors)
    .slice(0, 15);

  const totalNodes = byDepth.reduce((s, d) => s + d.total, 0);
  const totalErrors = byDepth.reduce((s, d) => s + d.errors, 0);

  return {
    summary: {
      totalNodes,
      totalErrors,
      errorRate: totalNodes > 0 ? totalErrors / totalNodes : 0,
      sessionCount,
    },
    byDepth,
    topAgents,
    byTool,
  };
}

function emptyReport(): ErrorReport {
  return {
    summary: { totalNodes: 0, totalErrors: 0, errorRate: 0, sessionCount: 0 },
    byDepth: [],
    topAgents: [],
    byTool: [],
  };
}
