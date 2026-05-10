import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import { getCachedScan, setCachedScan } from "@/lib/cache";
import { scanAllProjects } from "@/lib/scanner";
import { writeFileAtomic, withFileLock } from "@/lib/atomicWrite";
import { recordPreWrite } from "@/lib/configHistory";
import {
  classifyMemoryPath,
  decodeMemoryId,
} from "@/lib/memory/safety";
import { invalidateMemoryInventoryCache } from "@/lib/memory";
import { invalidateMemoryCache } from "@/lib/scanner/memory";

const MAX_BYTES = 2 * 1024 * 1024;

function errorResponse(code: string, status: number, message?: string) {
  return NextResponse.json({ error: { code, message } }, { status });
}

async function getProjects() {
  let scan = getCachedScan();
  if (!scan) {
    scan = await scanAllProjects();
    setCachedScan(scan);
  }
  return scan.projects;
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const absPath = decodeMemoryId(id);
  if (!absPath) return errorResponse("INVALID_ID", 400, "Could not decode id.");

  const projects = await getProjects();
  const allowed = await classifyMemoryPath(absPath, projects);
  if (!allowed) {
    return errorResponse(
      "PATH_NOT_ALLOWED",
      400,
      "Path is not a known memory file.",
    );
  }

  try {
    const [stat, content] = await Promise.all([
      fs.stat(absPath),
      fs.readFile(absPath, "utf-8"),
    ]);
    return NextResponse.json({
      id,
      absPath,
      scope: allowed.scope,
      projectSlug: allowed.projectSlug,
      content,
      mtimeMs: stat.mtimeMs,
      sizeBytes: stat.size,
    });
  } catch {
    return errorResponse("FILE_NOT_FOUND", 404, "Memory file is missing.");
  }
}

interface PutBody {
  content?: unknown;
  mtimeMs?: unknown;
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const absPath = decodeMemoryId(id);
  if (!absPath) return errorResponse("INVALID_ID", 400, "Could not decode id.");

  const projects = await getProjects();
  const allowed = await classifyMemoryPath(absPath, projects);
  if (!allowed) {
    return errorResponse(
      "PATH_NOT_ALLOWED",
      400,
      "Path is not a known memory file.",
    );
  }

  let body: PutBody;
  try {
    body = (await request.json()) as PutBody;
  } catch {
    return errorResponse("INVALID_JSON", 400, "Body is not valid JSON.");
  }

  if (typeof body.content !== "string" || typeof body.mtimeMs !== "number") {
    return errorResponse(
      "INVALID_BODY",
      400,
      "Body must include `content: string` and `mtimeMs: number`.",
    );
  }
  const content: string = body.content;
  const requestMtime: number = body.mtimeMs;

  if (Buffer.byteLength(content, "utf-8") > MAX_BYTES) {
    return errorResponse(
      "TOO_LARGE",
      413,
      `Content exceeds ${MAX_BYTES} bytes.`,
    );
  }

  // Conflict check + write under one lock so a sibling writer can't slip a
  // change in between the stat and the rename.
  return withFileLock(absPath, async () => {
    let currentMtime: number | null = null;
    try {
      const stat = await fs.stat(absPath);
      currentMtime = stat.mtimeMs;
    } catch {
      // File may have been deleted out from under us; allow the write to
      // create it as long as the caller acknowledges (mtimeMs === 0 means
      // "no prior file"). Refuse otherwise so we don't silently resurrect.
      if (requestMtime !== 0) {
        return errorResponse(
          "MTIME_CONFLICT",
          409,
          "File no longer exists; refresh and retry.",
        );
      }
    }

    if (currentMtime !== null && Math.abs(currentMtime - requestMtime) > 1) {
      // Sub-millisecond drift on some filesystems — allow ±1 ms slack.
      return errorResponse(
        "MTIME_CONFLICT",
        409,
        "File changed externally. Reload to see latest content.",
      );
    }

    const backupId = await recordPreWrite(absPath, {
      label: "memoryEditor",
      projectSlug: allowed.projectSlug,
    });

    await writeFileAtomic(absPath, content);

    // Invalidate caches so the dashboard sees the new content immediately.
    invalidateMemoryInventoryCache();
    if (allowed.scope === "auto" && allowed.projectPath) {
      invalidateMemoryCache(allowed.projectPath);
    }

    const newStat = await fs.stat(absPath);
    return NextResponse.json({
      ok: true,
      mtimeMs: newStat.mtimeMs,
      sizeBytes: newStat.size,
      backupId,
    });
  });
}
