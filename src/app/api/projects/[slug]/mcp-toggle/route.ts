import { NextRequest, NextResponse } from "next/server";
import { getCachedScan, setCachedScan } from "@/lib/cache";
import { invalidateCache } from "@/lib/cache";
import { invalidateClaudeConfigRouteCache } from "@/app/api/claude-config/route";
import { toggleProjectMcpServer } from "@/lib/mcpToggle";
import { scanAllProjects } from "@/lib/scanner";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  const { slug } = await params;

  let serverName: string;
  let enabled: boolean;
  try {
    const body = await request.json();
    if (typeof body.serverName !== "string" || !body.serverName) {
      return NextResponse.json({ error: "serverName (string) is required" }, { status: 400 });
    }
    if (typeof body.enabled !== "boolean") {
      return NextResponse.json({ error: "enabled (boolean) is required" }, { status: 400 });
    }
    serverName = body.serverName;
    enabled = body.enabled;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  let scan = getCachedScan();
  if (!scan) {
    scan = await scanAllProjects();
    setCachedScan(scan);
  }
  const project = scan.projects.find((p) => p.slug === slug);
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  // Only allow toggling project-scope servers (defined in .mcp.json).
  // Reject if server is missing from the project's MCP list, or is not project-scope —
  // otherwise arbitrary names could be written into disabledMcpjsonServers.
  const server = project.mcpServers?.servers.find((s) => s.name === serverName);
  if (!server || server.source !== "project") {
    return NextResponse.json(
      {
        error: server
          ? `Only project-scope MCP servers can be toggled (this server is ${server.source}-scope)`
          : "Server not found in project MCP configuration",
      },
      { status: 400 },
    );
  }

  const { disabledList } = await toggleProjectMcpServer(project.path, serverName, enabled);

  // Invalidate caches so the next read reflects the settings change
  invalidateCache();
  invalidateClaudeConfigRouteCache();

  return NextResponse.json({ ok: true, disabled: !enabled, disabledMcpjsonServers: disabledList });
}
