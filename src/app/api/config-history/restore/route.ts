import { NextRequest, NextResponse } from "next/server";
import { restore, list } from "@/lib/configHistory";
import { invalidateCache } from "@/lib/cache";
import { invalidateClaudeConfigRouteCache } from "@/app/api/claude-config/route";
import { invalidateUserConfigCache } from "@/lib/userConfigCache";
import { invalidateCatalogCache } from "@/lib/indexer/catalog";
import { invalidateCommandsRouteCache } from "@/app/api/commands/route";

export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const backupId = (body as { backupId?: unknown })?.backupId;
  if (typeof backupId !== "string" || backupId.length === 0) {
    return NextResponse.json({ error: "backupId (string) is required" }, { status: 400 });
  }

  // Validate the BackupId exists before restore() so we surface 404 vs 500.
  // restore() also checks, but it throws — and we want a typed HTTP status.
  // The list() read is wrapped so manifest I/O errors (permissions, FS
  // corruption) surface as a structured 500 instead of an opaque crash.
  let entry: Awaited<ReturnType<typeof list>>[number] | undefined;
  try {
    const entries = await list();
    entry = entries.find((e) => e.id === backupId);
  } catch (e: unknown) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
  if (!entry) {
    return NextResponse.json({ error: `No backup with id ${backupId}` }, { status: 404 });
  }

  try {
    await restore(backupId);
  } catch (e: unknown) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }

  // Restored file may be a config the dashboard reads — invalidate the
  // same caches the apply layer invalidates on a successful apply.
  // Restore can target agent / skill / command files too, so the
  // catalog + /api/commands route caches need clearing or those views
  // stay stale until TTL expiry.
  invalidateCache();
  invalidateClaudeConfigRouteCache();
  invalidateUserConfigCache();
  invalidateCatalogCache();
  invalidateCommandsRouteCache();

  return NextResponse.json({ ok: true, restored: { id: entry.id, targetPath: entry.targetPath } });
}
