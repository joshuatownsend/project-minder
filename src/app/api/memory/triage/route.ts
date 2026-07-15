import path from "path";
import { demoWriteBlock } from "@/lib/demo/demoWriteGuard";
import { NextResponse, type NextRequest } from "next/server";
import { getCachedScan, setCachedScan } from "@/lib/cache";
import { scanAllProjects } from "@/lib/scanner";
import { listMemoryFiles, invalidateMemoryInventoryCache } from "@/lib/memory";
import { canonicalMemoryKey, getMemoryUsage } from "@/lib/memory/usageTracker";
import { scoreTriage, type TriageReport } from "@/lib/memory/triageScorer";
import {
  archiveMemoryFile,
  softDeleteMemoryFile,
  restoreFromArchive,
  restoreFromTrash,
  listArchivedMemoryFiles,
  sweepAndListTrash,
  memoryDirFor,
  TRASH_MAX_AGE_MS,
  type ManagedMemoryFile,
  type MemoryMoveResult,
} from "@/lib/scanner/memoryWriter";
import { getSuppressMap, setSuppress, clearSuppress } from "@/lib/memory/triageStore";

interface ManagedRow extends ManagedMemoryFile {
  projectSlug: string;
  projectName: string;
}

interface TrashedRow extends ManagedRow {
  /** ISO timestamp at which the next sweep will permanently unlink this file. */
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

  // sweepAndListTrash collapses the 30-day expire-pass and the per-row
  // listing pass into one readdir per project — instead of three (one for
  // sweepTrash + listTrashed + listArchived) we do two per project, fanned
  // out in parallel.
  const archived: ManagedRow[] = [];
  const trashed: TrashedRow[] = [];
  await Promise.all(
    scan.projects.map(async (p) => {
      const [a, t] = await Promise.all([
        listArchivedMemoryFiles(p.path),
        sweepAndListTrash(p.path),
      ]);
      for (const f of a) {
        archived.push({ ...f, projectSlug: p.slug, projectName: p.name });
      }
      for (const f of t.survivors) {
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

const ACTIONS = ["archive", "delete", "keep", "unsuppress", "restore-archive", "restore-trash"] as const;
type TriageAction = (typeof ACTIONS)[number];
const VALID_ACTIONS = new Set<TriageAction>(ACTIONS);

interface ActionRequest {
  action: TriageAction;
  /** Project slug — used to look up the project root for path scoping. */
  projectSlug: string;
  /** Basename inside the project's memory dir (e.g. "user_role.md"). */
  fileName: string;
  /** Keep-for-N-days; only honored when action="keep". Default 30, clamped [1, 365]. */
  days?: number;
}

const MOVERS: Record<
  "archive" | "delete" | "restore-archive" | "restore-trash",
  (projectPath: string, fileName: string) => Promise<MemoryMoveResult>
> = {
  archive: archiveMemoryFile,
  delete: softDeleteMemoryFile,
  "restore-archive": restoreFromArchive,
  "restore-trash": restoreFromTrash,
};

export async function POST(request: NextRequest): Promise<NextResponse> {
  const __demoBlocked = await demoWriteBlock();
  if (__demoBlocked) return __demoBlocked;
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

  if (body.action === "keep") {
    // Clamp days so a hand-crafted call can't set a multi-year hold; reject
    // non-finite values outright (e.g. body.days: "abc" -> NaN) so they don't
    // flow through Math.floor into setSuppress and write "Invalid Date" into
    // .minder.json.
    const rawDays = body.days ?? 30;
    if (typeof rawDays !== "number" || !Number.isFinite(rawDays)) {
      return NextResponse.json({ error: "INVALID_DAYS" }, { status: 400 });
    }
    const days = Math.min(365, Math.max(1, Math.floor(rawDays)));
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
  if (body.action === "unsuppress") {
    const absPath = path.join(memoryDirFor(project.path), body.fileName);
    await clearSuppress(absPath);
    return NextResponse.json({ ok: true });
  }

  // The two non-mover branches above return early, leaving only the four
  // keys MOVERS knows about. TS doesn't narrow across the early returns
  // here, so re-type-assert at the dispatch site.
  const moveAction = body.action as keyof typeof MOVERS;
  const r = await MOVERS[moveAction](project.path, body.fileName);
  invalidateMemoryInventoryCache();
  // Restores should also lift any stale suppression so the file re-appears
  // in /memory listings rather than staying hidden by an old "Keep" hold.
  if (body.action === "restore-archive" || body.action === "restore-trash") {
    const absPath = path.join(memoryDirFor(project.path), body.fileName);
    await clearSuppress(absPath).catch(() => {});
  }
  return r.ok
    ? NextResponse.json({ ok: true, destPath: r.destPath })
    : NextResponse.json({ error: r.error }, { status: 400 });
}
