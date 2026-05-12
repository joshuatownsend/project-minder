import path from "path";
import { NextResponse, type NextRequest } from "next/server";
import { getCachedScan, setCachedScan } from "@/lib/cache";
import { scanAllProjects } from "@/lib/scanner";
import { listMemoryFiles, invalidateMemoryInventoryCache } from "@/lib/memory";
import { canonicalMemoryKey, getMemoryUsage } from "@/lib/memory/usageTracker";
import { scoreTriage, type TriageReport } from "@/lib/memory/triageScorer";
import {
  archiveMemoryFile,
  softDeleteMemoryFile,
  restoreFromSubdir,
  listArchivedMemoryFiles,
  listTrashedMemoryFiles,
  sweepTrash,
  memoryDirFor,
  ARCHIVE_SUBDIR,
  TRASH_SUBDIR,
  TRASH_MAX_AGE_MS,
  type ManagedMemoryFile,
} from "@/lib/scanner/memoryWriter";
import { getSuppressMap, setSuppress, clearSuppress } from "@/lib/memory/triageStore";

interface ManagedRow extends ManagedMemoryFile {
  projectSlug: string;
  projectName: string;
}

interface TrashedRow extends ManagedRow {
  /** ISO timestamp at which sweepTrash will permanently unlink this file. */
  autoDeleteAt: string;
}

interface TriageGetResponse {
  report: TriageReport;
  archived: ManagedRow[];
  trashed: TrashedRow[];
}

export async function GET(): Promise<NextResponse<TriageGetResponse | { error: string }>> {
  let scan = getCachedScan();
  if (!scan) {
    scan = await scanAllProjects();
    setCachedScan(scan);
  }

  const [{ entries }, usage, suppressUntil] = await Promise.all([
    listMemoryFiles({ projects: scan.projects }),
    getMemoryUsage(scan.projects),
    getSuppressMap(),
  ]);

  for (const e of entries) {
    e.usage = usage.get(canonicalMemoryKey(e.absPath));
  }

  const report = scoreTriage({ entries, suppressUntil });

  // Best-effort 30-day sweep on every list call. Errors here are silently
  // swallowed inside sweepTrash; we don't want a single project's failure to
  // break the page.
  await Promise.all(scan.projects.map((p) => sweepTrash(p.path)));

  const archived: ManagedRow[] = [];
  const trashed: TrashedRow[] = [];
  await Promise.all(
    scan.projects.map(async (p) => {
      const [a, t] = await Promise.all([
        listArchivedMemoryFiles(p.path),
        listTrashedMemoryFiles(p.path),
      ]);
      for (const f of a) {
        archived.push({ ...f, projectSlug: p.slug, projectName: p.name });
      }
      for (const f of t) {
        trashed.push({
          ...f,
          projectSlug: p.slug,
          projectName: p.name,
          autoDeleteAt: new Date(f.mtimeMs + TRASH_MAX_AGE_MS).toISOString(),
        });
      }
    }),
  );
  archived.sort((a, b) => b.mtimeMs - a.mtimeMs);
  trashed.sort((a, b) => b.mtimeMs - a.mtimeMs);

  return NextResponse.json({ report, archived, trashed });
}

interface ActionRequest {
  action: "archive" | "delete" | "keep" | "restore-archive" | "restore-trash";
  /** Project slug — used to look up the project root for path scoping. */
  projectSlug: string;
  /** Basename inside the project's memory dir (e.g. "user_role.md"). */
  fileName: string;
  /** Keep-for-N-days; only honored when action="keep". Default 30, clamped [1, 365]. */
  days?: number;
}

const VALID_ACTIONS = new Set([
  "archive",
  "delete",
  "keep",
  "restore-archive",
  "restore-trash",
]);

export async function POST(request: NextRequest): Promise<NextResponse> {
  let body: ActionRequest;
  try {
    body = (await request.json()) as ActionRequest;
  } catch {
    return NextResponse.json({ error: "INVALID_JSON" }, { status: 400 });
  }
  if (!VALID_ACTIONS.has(body.action)) {
    return NextResponse.json({ error: "INVALID_ACTION" }, { status: 400 });
  }
  if (typeof body.projectSlug !== "string" || typeof body.fileName !== "string") {
    return NextResponse.json({ error: "INVALID_PAYLOAD" }, { status: 400 });
  }

  let scan = getCachedScan();
  if (!scan) {
    scan = await scanAllProjects();
    setCachedScan(scan);
  }
  const project = scan.projects.find((p) => p.slug === body.projectSlug);
  if (!project) {
    return NextResponse.json({ error: "UNKNOWN_PROJECT" }, { status: 400 });
  }

  switch (body.action) {
    case "archive": {
      const r = await archiveMemoryFile(project.path, body.fileName);
      invalidateMemoryInventoryCache();
      return r.ok
        ? NextResponse.json({ ok: true, destPath: r.destPath })
        : NextResponse.json({ error: r.error }, { status: 400 });
    }
    case "delete": {
      const r = await softDeleteMemoryFile(project.path, body.fileName);
      invalidateMemoryInventoryCache();
      return r.ok
        ? NextResponse.json({ ok: true, destPath: r.destPath })
        : NextResponse.json({ error: r.error }, { status: 400 });
    }
    case "keep": {
      // Clamp days to a sane range; the UI sends 7/30/90 by default but a
      // hand-crafted call shouldn't be able to silently set a 100-year hold.
      const days = Math.min(365, Math.max(1, Math.floor(body.days ?? 30)));
      const absPath = path.join(memoryDirFor(project.path), body.fileName);
      try {
        const until = await setSuppress(absPath, days);
        return NextResponse.json({ ok: true, until });
      } catch (err) {
        return NextResponse.json(
          { error: { code: "SUPPRESS_FAILED", message: err instanceof Error ? err.message : String(err) } },
          { status: 500 },
        );
      }
    }
    case "restore-archive": {
      const r = await restoreFromSubdir(project.path, body.fileName, ARCHIVE_SUBDIR);
      invalidateMemoryInventoryCache();
      // Restoring should also lift any stale suppression so the file
      // re-appears in the main /memory listing rather than getting hidden.
      const absPath = path.join(memoryDirFor(project.path), body.fileName);
      await clearSuppress(absPath).catch(() => {});
      return r.ok
        ? NextResponse.json({ ok: true, destPath: r.destPath })
        : NextResponse.json({ error: r.error }, { status: 400 });
    }
    case "restore-trash": {
      const r = await restoreFromSubdir(project.path, body.fileName, TRASH_SUBDIR);
      invalidateMemoryInventoryCache();
      const absPath = path.join(memoryDirFor(project.path), body.fileName);
      await clearSuppress(absPath).catch(() => {});
      return r.ok
        ? NextResponse.json({ ok: true, destPath: r.destPath })
        : NextResponse.json({ error: r.error }, { status: 400 });
    }
  }
}
