import { NextRequest, NextResponse } from "next/server";
import { readConfig, writeConfig } from "@/lib/config";
import { invalidateCache } from "@/lib/cache";
import { ProjectStatus, MinderConfig } from "@/lib/types";

// Derived from the MinderConfig union types — update both together if options change
const VALID_DEFAULT_SORTS: MinderConfig["defaultSort"][] = ["activity", "name", "claude"];
const VALID_STATUS_FILTERS: MinderConfig["defaultStatusFilter"][] = ["all", "active", "paused", "archived"];
const VALID_VIEW_MODES: MinderConfig["viewMode"][] = ["full", "compact", "list"];

export async function PATCH(request: NextRequest) {
  const body = await request.json();
  const config = await readConfig();
  let changed = false;

  if (Array.isArray(body.devRoots)) {
    if (body.devRoots.some((r: unknown) => typeof r !== "string")) {
      return NextResponse.json({ error: "devRoots elements must be strings" }, { status: 400 });
    }
    const roots = (body.devRoots as string[]).map((r) => r.trim()).filter(Boolean);
    if (roots.length === 0) {
      return NextResponse.json({ error: "devRoots must not be empty" }, { status: 400 });
    }
    config.devRoots = roots;
    config.devRoot = roots[0]; // keep legacy field in sync
    changed = true;
  }

  if (typeof body.scanBatchSize === "number") {
    const size = Math.round(body.scanBatchSize);
    if (size < 1 || size > 50) {
      return NextResponse.json({ error: "scanBatchSize must be 1–50" }, { status: 400 });
    }
    config.scanBatchSize = size;
    changed = true;
  }

  if (body.defaultSort !== undefined) {
    if (!VALID_DEFAULT_SORTS.includes(body.defaultSort)) {
      return NextResponse.json({ error: "Invalid defaultSort" }, { status: 400 });
    }
    config.defaultSort = body.defaultSort;
    changed = true;
  }

  if (body.defaultStatusFilter !== undefined) {
    if (!VALID_STATUS_FILTERS.includes(body.defaultStatusFilter)) {
      return NextResponse.json({ error: "Invalid defaultStatusFilter" }, { status: 400 });
    }
    config.defaultStatusFilter = body.defaultStatusFilter;
    changed = true;
  }

  if (body.viewMode !== undefined) {
    if (!VALID_VIEW_MODES.includes(body.viewMode)) {
      return NextResponse.json({ error: "Invalid viewMode" }, { status: 400 });
    }
    config.viewMode = body.viewMode;
    changed = true;
  }

  if (body.pinnedSlugs !== undefined) {
    if (!Array.isArray(body.pinnedSlugs) || body.pinnedSlugs.some((s: unknown) => typeof s !== "string")) {
      return NextResponse.json({ error: "pinnedSlugs must be an array of strings" }, { status: 400 });
    }
    config.pinnedSlugs = body.pinnedSlugs as string[];
    changed = true;
  }

  if (!changed) {
    return NextResponse.json({ error: "No valid fields to update" }, { status: 400 });
  }

  await writeConfig(config);
  invalidateCache();
  return NextResponse.json({ ok: true, config });
}

export async function GET() {
  const config = await readConfig();
  return NextResponse.json(config);
}

export async function PUT(request: NextRequest) {
  const body = await request.json();
  const config = await readConfig();

  // Update status
  if (body.slug && body.status) {
    config.statuses[body.slug] = body.status as ProjectStatus;
    await writeConfig(config);
    invalidateCache();
    return NextResponse.json({ ok: true });
  }

  // Hide a project (by directory name)
  if (body.action === "hide" && body.dirName) {
    if (!config.hidden.includes(body.dirName)) {
      config.hidden.push(body.dirName);
    }
    await writeConfig(config);
    invalidateCache();
    return NextResponse.json({ ok: true });
  }

  // Unhide a project
  if (body.action === "unhide" && body.dirName) {
    config.hidden = config.hidden.filter((h) => h !== body.dirName);
    await writeConfig(config);
    invalidateCache();
    return NextResponse.json({ ok: true });
  }

  // Set port override for a project
  if (body.slug && body.port !== undefined) {
    const port = parseInt(body.port, 10);
    if (port > 0 && port <= 65535) {
      config.portOverrides[body.slug] = port;
    } else if (body.port === null || body.port === 0) {
      delete config.portOverrides[body.slug];
    } else {
      return NextResponse.json({ error: "Invalid port" }, { status: 400 });
    }
    await writeConfig(config);
    invalidateCache();
    return NextResponse.json({ ok: true });
  }

  // Bulk update hidden list
  if (body.hidden && Array.isArray(body.hidden)) {
    config.hidden = body.hidden;
    await writeConfig(config);
    invalidateCache();
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: "Invalid request" }, { status: 400 });
}
