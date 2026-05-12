import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { loadOrchestrationGraph } from "@/lib/usage/orchestrationGraph";
import type { OrchNode } from "@/lib/usage/orchestrationGraph";
import { isValidSessionId } from "@/lib/usage/parser";
import { loadCatalog } from "@/lib/indexer/catalog";
import { buildAgentAliasMap } from "@/lib/indexer/canonicalize";
import type { CatalogMap } from "@/lib/indexer/canonicalize";

// Module-level alias map cache — rebuilt at most every 5 min to avoid
// re-walking the agent catalog on every tree request.
let aliasMapCache: { map: CatalogMap; builtAt: number } | null = null;
const ALIAS_MAP_TTL_MS = 5 * 60 * 1000;

async function getAliasMap(): Promise<CatalogMap> {
  if (aliasMapCache && Date.now() - aliasMapCache.builtAt < ALIAS_MAP_TTL_MS) {
    return aliasMapCache.map;
  }
  const catalog = await loadCatalog({ includeProjects: true });
  const map = buildAgentAliasMap(catalog.agents);
  aliasMapCache = { map, builtAt: Date.now() };
  return map;
}

function decorateNode(node: OrchNode, aliasMap: CatalogMap): OrchNode {
  if (!node.agentName) return node;
  const entry = aliasMap.get(node.agentName.toLowerCase());
  if (!entry) return node;
  return {
    ...node,
    catalogEmoji: (entry.frontmatter.emoji as string | undefined) ?? undefined,
    catalogColor: (entry.frontmatter.color as string | undefined) ?? undefined,
    catalogDescription: entry.description ?? undefined,
  };
}

export async function GET(request: NextRequest) {
  const sessionId = request.nextUrl.searchParams.get("sessionId");
  if (!sessionId) {
    return NextResponse.json({ error: "sessionId required" }, { status: 400 });
  }
  if (!isValidSessionId(sessionId)) {
    return NextResponse.json({ error: "invalid sessionId" }, { status: 400 });
  }

  try {
    const graph = await loadOrchestrationGraph(sessionId);
    if (!graph) return NextResponse.json({ graph: null });

    const aliasMap = await getAliasMap().catch(() => new Map() as CatalogMap);
    const decoratedNodes = graph.nodes.map((n) => decorateNode(n, aliasMap));
    return NextResponse.json({ graph: { ...graph, nodes: decoratedNodes } });
  } catch {
    return NextResponse.json({ error: "failed to load graph" }, { status: 500 });
  }
}
