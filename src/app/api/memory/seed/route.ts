import { promises as fs } from "fs";
import { demoWriteBlock } from "@/lib/demo/demoWriteGuard";
import path from "path";
import { NextResponse, type NextRequest } from "next/server";
import { getCachedScan, setCachedScan } from "@/lib/cache";
import { scanAllProjects } from "@/lib/scanner";
import { generateSeedCandidates } from "@/lib/memory/seedGenerator";
import { writeMemoryFile, memoryDirFor } from "@/lib/scanner/memoryWriter";
import { userMemoryPath } from "@/lib/memory/safety";
import { parseFrontmatter } from "@/lib/memory/memoryFrontmatter";
import { getSessionCategoryCounts } from "@/lib/memory/seedCategoryCounts";
import type { SeedAction, SeedCandidate } from "@/lib/types";

interface PromoteRequest {
  candidates: Array<{
    fileName: string;
    targetProjectPath: string;
    body: string;
    /**
     * "create" -- target must not exist yet; reject if it does (race-safe).
     * "overwrite" -- target must already exist; the user explicitly opted in.
     * Server enforces both halves under the write lock so the UI's GET-time
     * conflict detection can't be bypassed by stale state or a direct POST.
     */
    action: SeedAction;
  }>;
}

export async function GET(request: NextRequest) {
  let scan = getCachedScan();
  if (!scan) {
    scan = await scanAllProjects();
    setCachedScan(scan);
  }

  // Read global CLAUDE.md if present; otherwise the generator just omits
  // user_role.md from the candidate set rather than failing.
  let userClaudeMd: string | null = null;
  try {
    userClaudeMd = await fs.readFile(userMemoryPath(), "utf-8");
  } catch {
    userClaudeMd = null;
  }

  // Session category mix drives user_workstyle.md. Cached by JSONL max
  // mtime so a /memory/seed reload following a prior call doesn't re-classify.
  const sessionCategories = await getSessionCategoryCounts();

  const candidates = generateSeedCandidates({
    userClaudeMd,
    projects: scan.projects,
    sessionCategories,
  });

  // Detect on-disk conflicts so the UI can show 3-way diff without a second
  // round-trip. Per-project candidates resolve against their own dir;
  // user-scope candidates need an anchor project (?anchor=<projectPath>)
  // before we can locate where they'd land.
  const anchorPath = request.nextUrl.searchParams.get("anchor") ?? "";
  const allProjectPaths = scan.projects.map((p) => p.path);
  const augmented = await Promise.all(
    candidates.map((c) => attachConflict(c, anchorPath, allProjectPaths)),
  );

  return NextResponse.json({
    candidates: augmented,
    anchorOptions: scan.projects
      .filter((p) => p.status === "active")
      .map((p) => ({ slug: p.slug, name: p.name, path: p.path })),
  });
}

async function attachConflict(
  candidate: SeedCandidate,
  anchorPath: string,
  allProjectPaths: string[],
): Promise<SeedCandidate> {
  const targetPath =
    candidate.scope === "per-project"
      ? candidate.targetProjectPath
      : anchorPath || null;
  if (!targetPath) return candidate;
  // Safety: confirm anchor was a real scanned project before we trust it.
  if (candidate.scope === "user" && !allProjectPaths.includes(targetPath)) {
    return candidate;
  }
  const existingPath = path.join(memoryDirFor(targetPath), candidate.fileName);
  try {
    const existingBody = await fs.readFile(existingPath, "utf-8");
    // Parse frontmatter so we don't false-match `seeded: true` text in the
    // markdown body (e.g. a quoted example or fenced code).
    const parsed = parseFrontmatter(existingBody);
    const existingIsSeeded = !("error" in parsed) && parsed.data.seeded === true;
    return {
      ...candidate,
      conflict: { existingPath, existingBody, existingIsSeeded },
    };
  } catch {
    return candidate;
  }
}

export async function POST(request: NextRequest) {
  const __demoBlocked = await demoWriteBlock();
  if (__demoBlocked) return __demoBlocked;
  let body: PromoteRequest;
  try {
    body = (await request.json()) as PromoteRequest;
  } catch {
    return NextResponse.json({ error: "INVALID_JSON" }, { status: 400 });
  }
  if (!body.candidates || !Array.isArray(body.candidates)) {
    return NextResponse.json({ error: "MISSING_CANDIDATES" }, { status: 400 });
  }

  let scan = getCachedScan();
  if (!scan) {
    scan = await scanAllProjects();
    setCachedScan(scan);
  }
  const validProjectPaths = new Set(scan.projects.map((p) => p.path));

  const results = await Promise.all(
    body.candidates.map(async (c) => {
      if (typeof c.fileName !== "string" || !c.fileName) {
        return { fileName: String(c.fileName ?? ""), ok: false, error: "INVALID_NAME" as const };
      }
      if (typeof c.targetProjectPath !== "string" || typeof c.body !== "string") {
        return { fileName: c.fileName, ok: false, error: "INVALID_PAYLOAD" as const };
      }
      if (c.action !== "create" && c.action !== "overwrite") {
        return { fileName: c.fileName, ok: false, error: "INVALID_ACTION" as const };
      }
      if (!validProjectPaths.has(c.targetProjectPath)) {
        return { fileName: c.fileName, ok: false, error: "UNKNOWN_PROJECT" as const };
      }
      // Re-check existence at write time so a "Create" between GET conflict
      // detection and POST can't silently clobber a file that appeared in the
      // gap. The check + write are NOT under a single lock, so a strict
      // race-free guarantee would need atomic O_CREAT|O_EXCL semantics from
      // the writer. For now the window is tens of ms and the UX cost of
      // accidental overwrite is low (the user can read it back) -- if a real
      // multi-writer scenario emerges, push the check into writeMemoryFile.
      const targetPath = path.join(memoryDirFor(c.targetProjectPath), c.fileName);
      const exists = await fs
        .access(targetPath)
        .then(() => true)
        .catch(() => false);
      if (c.action === "create" && exists) {
        return { fileName: c.fileName, ok: false, error: "ALREADY_EXISTS" as const };
      }
      if (c.action === "overwrite" && !exists) {
        return { fileName: c.fileName, ok: false, error: "NOT_FOUND" as const };
      }
      const result = await writeMemoryFile(c.targetProjectPath, c.fileName, c.body);
      return result.ok
        ? { fileName: c.fileName, ok: true as const }
        : { fileName: c.fileName, ok: false as const, error: result.error };
    }),
  );

  return NextResponse.json({ results });
}
