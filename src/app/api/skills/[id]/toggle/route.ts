import { NextRequest, NextResponse } from "next/server";
import { loadCatalog, invalidateCatalogCache } from "@/lib/indexer/catalog";
import { invalidateSkillsRouteCache } from "@/app/api/skills/route";
import { toggleUserSkill, skillSubjectPath, ToggleError } from "@/lib/skillToggle";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  let enabled: boolean;
  try {
    const body = await request.json();
    if (typeof body.enabled !== "boolean") {
      return NextResponse.json({ error: "enabled (boolean) is required" }, { status: 400 });
    }
    enabled = body.enabled;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const catalog = await loadCatalog({ includeProjects: true });
  const entry = catalog.skills.find((s) => s.id === id);

  if (!entry) {
    return NextResponse.json({ error: "Skill not found" }, { status: 404 });
  }

  if (entry.source !== "user") {
    return NextResponse.json(
      { error: "Only user-scope skills can be toggled" },
      { status: 403 },
    );
  }

  const subject = skillSubjectPath(entry.filePath, entry.layout);

  try {
    const { newPath } = await toggleUserSkill(subject, enabled);

    // Invalidate both caches so the next request reflects the move
    invalidateCatalogCache();
    invalidateSkillsRouteCache();

    return NextResponse.json({ ok: true, disabled: !enabled, newPath });
  } catch (e) {
    if (e instanceof ToggleError) {
      const status = e.code === "DEST_EXISTS" ? 409 : e.code === "NOT_FOUND" ? 404 : 400;
      return NextResponse.json({ error: e.message, code: e.code }, { status });
    }
    throw e;
  }
}
