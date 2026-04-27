import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import { loadCatalog } from "@/lib/indexer/catalog";
import { parseAllSessions } from "@/lib/usage/parser";
import { groupAgentCalls } from "@/lib/usage/agentParser";
import { buildAgentAliasMap } from "@/lib/indexer/canonicalize";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const catalog = await loadCatalog({ includeProjects: true });
  const entry = catalog.agents.find((a) => a.id === id);

  if (!entry) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const [bodyText, sessionMap] = await Promise.all([
    fs.readFile(entry.filePath, "utf-8").catch(() => ""),
    parseAllSessions(),
  ]);

  const allTurns = Array.from(sessionMap.values()).flat();
  const statsArr = groupAgentCalls(allTurns);
  const aliasMap = buildAgentAliasMap(catalog.agents);
  const usage = statsArr.find(
    (s) => aliasMap.get(s.name.toLowerCase()) === entry
  );

  return NextResponse.json({ entry, bodyFull: bodyText, usage });
}
