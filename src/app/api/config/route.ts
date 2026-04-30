import { NextRequest, NextResponse } from "next/server";
import { readConfig, mutateConfig } from "@/lib/config";
import { invalidateCache } from "@/lib/cache";
import { invalidateClaudeConfigRouteCache } from "@/app/api/claude-config/route";
import { ProjectStatus, MinderConfig } from "@/lib/types";

// Derived from the MinderConfig union types — update both together if options change
const VALID_DEFAULT_SORTS: MinderConfig["defaultSort"][] = ["activity", "name", "claude"];
const VALID_STATUS_FILTERS: MinderConfig["defaultStatusFilter"][] = ["all", "active", "paused", "archived"];
const VALID_VIEW_MODES: MinderConfig["viewMode"][] = ["full", "compact", "list"];

function invalidateAll() {
  invalidateCache();
  invalidateClaudeConfigRouteCache();
}

// Validate first, mutate second. We can't validate inside `mutateConfig` because
// it always writes — a half-mutated config caused by mid-validation failure
// would be persisted. So we build a list of patch closures up front; only if
// every validation passes do we hand them to `mutateConfig` to apply atomically.
type Patch = (config: MinderConfig) => void;

export async function PATCH(request: NextRequest) {
  const body = await request.json();
  const patches: Patch[] = [];

  if (Array.isArray(body.devRoots)) {
    if (body.devRoots.some((r: unknown) => typeof r !== "string")) {
      return NextResponse.json({ error: "devRoots elements must be strings" }, { status: 400 });
    }
    const roots = (body.devRoots as string[]).map((r) => r.trim()).filter(Boolean);
    if (roots.length === 0) {
      return NextResponse.json({ error: "devRoots must not be empty" }, { status: 400 });
    }
    patches.push((c) => {
      c.devRoots = roots;
      c.devRoot = roots[0];
    });
  }

  if (typeof body.scanBatchSize === "number") {
    const size = Math.round(body.scanBatchSize);
    if (size < 1 || size > 50) {
      return NextResponse.json({ error: "scanBatchSize must be 1–50" }, { status: 400 });
    }
    patches.push((c) => { c.scanBatchSize = size; });
  }

  if (body.defaultSort !== undefined) {
    if (!VALID_DEFAULT_SORTS.includes(body.defaultSort)) {
      return NextResponse.json({ error: "Invalid defaultSort" }, { status: 400 });
    }
    patches.push((c) => { c.defaultSort = body.defaultSort; });
  }

  if (body.defaultStatusFilter !== undefined) {
    if (!VALID_STATUS_FILTERS.includes(body.defaultStatusFilter)) {
      return NextResponse.json({ error: "Invalid defaultStatusFilter" }, { status: 400 });
    }
    patches.push((c) => { c.defaultStatusFilter = body.defaultStatusFilter; });
  }

  if (body.viewMode !== undefined) {
    if (!VALID_VIEW_MODES.includes(body.viewMode)) {
      return NextResponse.json({ error: "Invalid viewMode" }, { status: 400 });
    }
    patches.push((c) => { c.viewMode = body.viewMode; });
  }

  if (body.pinnedSlugs !== undefined) {
    if (!Array.isArray(body.pinnedSlugs) || body.pinnedSlugs.some((s: unknown) => typeof s !== "string")) {
      return NextResponse.json({ error: "pinnedSlugs must be an array of strings" }, { status: 400 });
    }
    patches.push((c) => { c.pinnedSlugs = body.pinnedSlugs as string[]; });
  }

  if (patches.length === 0) {
    return NextResponse.json({ error: "No valid fields to update" }, { status: 400 });
  }

  const config = await mutateConfig((c) => {
    for (const patch of patches) patch(c);
  });
  invalidateAll();
  return NextResponse.json({ ok: true, config });
}

export async function GET() {
  const config = await readConfig();
  return NextResponse.json(config);
}

export async function PUT(request: NextRequest) {
  const body = await request.json();

  // Update status
  if (body.slug && body.status) {
    await mutateConfig((config) => {
      config.statuses[body.slug] = body.status as ProjectStatus;
    });
    invalidateAll();
    return NextResponse.json({ ok: true });
  }

  // Hide a project (by directory name)
  if (body.action === "hide" && body.dirName) {
    await mutateConfig((config) => {
      if (!config.hidden.includes(body.dirName)) {
        config.hidden.push(body.dirName);
      }
    });
    invalidateAll();
    return NextResponse.json({ ok: true });
  }

  // Unhide a project
  if (body.action === "unhide" && body.dirName) {
    await mutateConfig((config) => {
      config.hidden = config.hidden.filter((h) => h !== body.dirName);
    });
    invalidateAll();
    return NextResponse.json({ ok: true });
  }

  // Set port override for a project
  if (body.slug && body.port !== undefined) {
    const port = parseInt(body.port, 10);
    if (port > 0 && port <= 65535) {
      await mutateConfig((config) => {
        config.portOverrides[body.slug] = port;
      });
    } else if (body.port === null || body.port === 0) {
      await mutateConfig((config) => {
        delete config.portOverrides[body.slug];
      });
    } else {
      return NextResponse.json({ error: "Invalid port" }, { status: 400 });
    }
    invalidateAll();
    return NextResponse.json({ ok: true });
  }

  // Bulk update hidden list
  if (body.hidden && Array.isArray(body.hidden)) {
    await mutateConfig((config) => {
      config.hidden = body.hidden;
    });
    invalidateAll();
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: "Invalid request" }, { status: 400 });
}
