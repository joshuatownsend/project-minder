import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import os from "os";
import { getCachedScan, setCachedScan } from "@/lib/cache";
import { scanAllProjects } from "@/lib/scanner";
import { scanMemory } from "@/lib/scanner/memory";
import { encodePath } from "@/lib/scanner/claudeConversations";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  const { slug } = await params;
  const file = request.nextUrl.searchParams.get("file");

  let result = getCachedScan();
  if (!result) {
    result = await scanAllProjects();
    setCachedScan(result);
  }

  const project = result.projects.find((p) => p.slug === slug);
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  if (file) {
    const memoryDir = path.join(
      os.homedir(), ".claude", "projects", encodePath(project.path), "memory"
    );
    // path.basename guards against directory traversal
    const filePath = path.join(memoryDir, path.basename(file));
    try {
      const content = await fs.readFile(filePath, "utf-8");
      return NextResponse.json({ content });
    } catch {
      return NextResponse.json({ error: "File not found" }, { status: 404 });
    }
  }

  const data = await scanMemory(project.path);
  return NextResponse.json(data);
}
