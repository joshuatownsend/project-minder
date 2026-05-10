import { NextRequest, NextResponse } from "next/server";
import path from "path";
import { readConfig } from "@/lib/config";
import { bootstrapNewProject } from "@/lib/template/bootstrap";
import { applyUnit } from "@/lib/template/apply";
import { invalidateCache } from "@/lib/cache";
import { toSlug } from "@/lib/scanner";
import { LIBRARY } from "@/lib/template/library";
import type { ApplyResult } from "@/lib/types";

export interface NewProjectRequest {
  /** Display name (not used as directory — relPath controls that). */
  name: string;
  /** Path relative to the first configured devRoot. */
  relPath: string;
  /** Run `git init` after creating the directory. Defaults to true. */
  gitInit?: boolean;
  /** Library item IDs to apply after creation. Applied with conflict: "skip". */
  libraryIds?: string[];
  /** When true: validate + preview but do not create or apply. */
  dryRun?: boolean;
}

export interface NewProjectResponse {
  ok: boolean;
  projectPath?: string;
  projectSlug?: string;
  gitInitialized?: boolean;
  /** Whether this was a dry-run (no disk writes). */
  wouldCreate?: boolean;
  /** Per-item apply results when libraryIds were provided. */
  appliedItems?: Array<{ id: string; result: ApplyResult }>;
  error?: { code: string; message: string };
}

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonError("INVALID_JSON", "Request body is not valid JSON.", 400);
  }

  const b = body as Record<string, unknown>;
  if (typeof b.name !== "string" || b.name.trim().length === 0) {
    return jsonError("INVALID_NAME", "name must be a non-empty string.", 400);
  }
  if (typeof b.relPath !== "string" || b.relPath.trim().length === 0) {
    return jsonError("INVALID_REL_PATH", "relPath must be a non-empty string.", 400);
  }

  const name = b.name.trim();
  const relPath = b.relPath.trim();
  const gitInit = b.gitInit !== false;
  const dryRun = b.dryRun === true;
  const libraryIds = Array.isArray(b.libraryIds)
    ? (b.libraryIds as unknown[]).filter((id): id is string => typeof id === "string")
    : [];

  const config = await readConfig();
  const bootstrap = await bootstrapNewProject(config, { name, relPath, gitInit, dryRun });

  if (!bootstrap.ok) {
    return NextResponse.json({ ok: false, error: bootstrap.error } satisfies NewProjectResponse);
  }

  if (dryRun) {
    return NextResponse.json({
      ok: true,
      projectPath: bootstrap.createdPath,
      wouldCreate: true,
    } satisfies NewProjectResponse);
  }

  const projectSlug = toSlug(path.basename(bootstrap.createdPath));

  // Apply library items sequentially (simpler than parallel; each item is fast).
  const appliedItems: Array<{ id: string; result: ApplyResult }> = [];
  for (const libraryId of libraryIds) {
    const item = LIBRARY.find((i) => i.id === libraryId);
    if (!item) continue;
    const unitKey = item.kind === "skill" ? `${item.slug}:standalone` : item.slug;
    const result = await applyUnit({
      unit: { kind: item.kind, key: unitKey },
      source: { kind: "library", libraryId },
      target: { kind: "path", path: bootstrap.createdPath },
      conflict: "skip",
    });
    appliedItems.push({ id: libraryId, result });
  }

  // Trigger scan so the dashboard picks up the new project immediately.
  invalidateCache();

  return NextResponse.json({
    ok: true,
    projectPath: bootstrap.createdPath,
    projectSlug,
    gitInitialized: bootstrap.gitInitialized,
    appliedItems: appliedItems.length > 0 ? appliedItems : undefined,
  } satisfies NewProjectResponse);
}

function jsonError(code: string, message: string, status: number) {
  return NextResponse.json({ ok: false, error: { code, message } } satisfies NewProjectResponse, { status });
}
