import { NextRequest, NextResponse } from "next/server";
import { readConfig, writeConfig } from "@/lib/config";
import { invalidateCache } from "@/lib/cache";
import { ProjectStatus } from "@/lib/types";

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

  // Bulk update hidden list
  if (body.hidden && Array.isArray(body.hidden)) {
    config.hidden = body.hidden;
    await writeConfig(config);
    invalidateCache();
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: "Invalid request" }, { status: 400 });
}
