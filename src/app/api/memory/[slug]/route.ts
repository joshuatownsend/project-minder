import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { getCachedScan, setCachedScan } from "@/lib/cache";
import { scanAllProjects } from "@/lib/scanner";
import { scanMemory, invalidateMemoryCache } from "@/lib/scanner/memory";
import { memoryDirFor, writeMemoryFile } from "@/lib/scanner/memoryWriter";

/** Single shape for every error response in this route — matches the
 *  writer's `{code, message?}` envelope so MemoryTab's `error.code`
 *  display works for every failure path. */
function errorResponse(code: string, status: number, message?: string) {
  return NextResponse.json(
    { error: message !== undefined ? { code, message } : { code } },
    { status }
  );
}

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
    return errorResponse("PROJECT_NOT_FOUND", 404, `No project "${slug}".`);
  }

  if (file) {
    const memoryDir = memoryDirFor(project.path);
    // path.basename guards against directory traversal
    const filePath = path.join(memoryDir, path.basename(file));
    try {
      const content = await fs.readFile(filePath, "utf-8");
      return NextResponse.json({ content });
    } catch {
      return errorResponse("FILE_NOT_FOUND", 404, `No memory file "${file}".`);
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
 * After a successful write we drop the project's `scanMemory` entry so
 * the dashboard's immediate refetch sees the new mtime/size — the 30s
 * in-module TTL would otherwise mask the change.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  const { slug } = await params;

  const project = await resolveProject(slug);
  if (!project) {
    return errorResponse("PROJECT_NOT_FOUND", 404, `No project "${slug}".`);
  }

  let body: { file?: unknown; content?: unknown };
  try {
    body = await request.json();
  } catch {
    return errorResponse("INVALID_JSON", 400, "Request body is not valid JSON.");
  }

  if (typeof body.file !== "string" || typeof body.content !== "string") {
    return errorResponse(
      "INVALID_BODY",
      400,
      "Body must include `file: string` and `content: string`."
    );
  }

  const result = await writeMemoryFile(project.path, body.file, body.content);
  if (!result.ok) {
    const code = result.error?.code ?? "WRITE_FAILED";
    const status =
      code === "TRAVERSAL" || code === "NOT_MARKDOWN" || code === "INVALID_NAME"
        ? 400
        : 500;
    const message =
      result.error && "message" in result.error ? result.error.message : undefined;
    return errorResponse(code, status, message);
  }
  invalidateMemoryCache(project.path);
  return NextResponse.json({ ok: true, bytesWritten: result.bytesWritten });
}
