import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { getCachedScan, setCachedScan } from "@/lib/cache";
import { scanAllProjects } from "@/lib/scanner";
import { scanMemory } from "@/lib/scanner/memory";
import { memoryDirFor, writeMemoryFile } from "@/lib/scanner/memoryWriter";

async function resolveProject(slug: string) {
  let result = getCachedScan();
  if (!result) {
    result = await scanAllProjects();
    setCachedScan(result);
  }
  return result.projects.find((p) => p.slug === slug);
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  const { slug } = await params;
  const file = request.nextUrl.searchParams.get("file");

  const project = await resolveProject(slug);
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  if (file) {
    const memoryDir = memoryDirFor(project.path);
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

/**
 * Replace the contents of one memory file. Body shape:
 *   { file: "user_role.md", content: "# updated body…" }
 *
 * The writer enforces extension + traversal safety. Memory dir is created
 * lazily so the user can save the very first memory file from the UI.
 *
 * On success the dashboard's MemoryTab refetches; we don't need to invalidate
 * any cross-route cache because `scanMemory` already has a 30s in-module TTL
 * that will pick up the new content on the next read.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  const { slug } = await params;

  const project = await resolveProject(slug);
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  let body: { file?: unknown; content?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (typeof body.file !== "string" || typeof body.content !== "string") {
    return NextResponse.json(
      { error: "Body must include `file: string` and `content: string`." },
      { status: 400 }
    );
  }

  const result = await writeMemoryFile(project.path, body.file, body.content);
  if (!result.ok) {
    const code = result.error?.code ?? "WRITE_FAILED";
    const status =
      code === "TRAVERSAL" || code === "NOT_MARKDOWN" || code === "INVALID_NAME"
        ? 400
        : 500;
    return NextResponse.json({ error: result.error }, { status });
  }
  return NextResponse.json({ ok: true, bytesWritten: result.bytesWritten });
}
